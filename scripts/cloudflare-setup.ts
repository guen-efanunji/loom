/**
 * Wires the public Loom domain to the Cloudflare Pages deployment.
 *
 *   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... bun scripts/cloudflare-setup.ts
 *
 * The script is idempotent: every step reads the current state first and only
 * changes what is missing, so it is safe to run from CI on each deploy and from
 * a laptop while setting the domain up for the first time.
 *
 * Flags:
 *   --dry-run      report what would change, write nothing
 *   --verify-only  only poll the public URLs
 *   --prepare      check the token, zone and Pages project; do not attach a domain
 *   --fix-dns      delete parked/apex records that block the Pages domain
 *   --create-zone  add the domain to the Cloudflare account when no zone exists
 */

type ApiResult<T> = {
	success: boolean;
	errors: { code: number; message: string }[];
	result: T | null;
};
type Zone = {
	id: string;
	name: string;
	status: string;
	account: { id: string };
	name_servers: string[];
};
type DnsRecord = {
	id: string;
	type: string;
	name: string;
	content: string;
	proxied: boolean;
};
type PagesProject = {
	name: string;
	subdomain: string;
	production_branch: string;
};

const api = "https://api.cloudflare.com/client/v4";
const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const verifyOnly = args.has("--verify-only");
const prepareOnly = args.has("--prepare");
const fixDns = args.has("--fix-dns") || process.env.LOOM_CF_FIX_DNS === "1";
const createZone =
	args.has("--create-zone") || process.env.LOOM_CF_CREATE_ZONE === "1";

const domain = process.env.LOOM_DOMAIN || "loomworkspace.bond";
// Extra hostnames served beside the apex, e.g. "www". Empty string disables them.
const aliases = (process.env.LOOM_CF_ALIASES ?? "www")
	.split(",")
	.map((value) => value.trim())
	.filter(Boolean);
const project = process.env.LOOM_PAGES_PROJECT || "loomworkspace";
const branch = process.env.LOOM_PAGES_BRANCH || "main";
const token = process.env.CLOUDFLARE_API_TOKEN || "";
const account = process.env.CLOUDFLARE_ACCOUNT_ID || "";

const interactive =
	process.stdout.isTTY === true && !process.env.NO_COLOR && !process.env.CI;
const paint = (code: string, text: string) =>
	interactive ? `\x1b[${code}m${text}\x1b[0m` : text;
let count = 0;
const total = verifyOnly ? 1 : prepareOnly ? 3 : 5;
const phase = (title: string) =>
	console.log(
		`\n${paint("1;35", `[${++count}/${total}]`)} ${paint("1", title)}`,
	);
const info = (line: string) => console.log(`${paint("36", "info")}  ${line}`);
info(
	`Project ${project} · domain ${domain} · branch ${branch}${dryRun ? " · dry run" : ""}`,
);
const pass = (line: string) => console.log(`${paint("32", " ok")}  ${line}`);
const warn = (line: string) => console.log(`${paint("33", "warn")}  ${line}`);
const detail = (line: string) => console.log(`      ${line}`);

class SetupError extends Error {}
function fail(message: string, ...hints: string[]): never {
	console.error(`${paint("31", "fail")}  ${message}`);
	for (const hint of hints) console.error(`      ${hint}`);
	throw new SetupError(message);
}

type CallOptions = { notFoundAsNull?: boolean; tolerateFailure?: boolean };

async function call<T>(
	path: string,
	init?: RequestInit,
	options: CallOptions = {},
): Promise<T | null> {
	const response = await fetch(`${api}${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			...(init?.headers ?? {}),
		},
		signal: AbortSignal.timeout(30_000),
	});
	const status = response.status;
	let body: ApiResult<T>;
	try {
		body = (await response.json()) as ApiResult<T>;
	} catch {
		if (status === 404 && options.notFoundAsNull) return null;
		if (options.tolerateFailure) return null;
		fail(`Cloudflare API answered HTTP ${status} without JSON for ${path}`);
	}
	if (!body.success) {
		if (status === 404 && options.notFoundAsNull) return null;
		if (options.tolerateFailure) return null;
		const first = body.errors[0];
		fail(
			`Cloudflare rejected ${init?.method ?? "GET"} ${path} (HTTP ${status})${first ? `, code ${first.code}` : ""}`,
			...(body.errors.length
				? body.errors.map((error) => `${error.code}: ${error.message}`)
				: ["The API returned no error detail for this request."]),
			"Token scopes needed: Account · Cloudflare Pages: Edit, Zone · DNS: Edit, Zone · Zone: Read, Zone · Cache Purge: Edit.",
		);
	}
	return body.result;
}

function requireCredentials() {
	if (!token || !account)
		fail(
			"CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required.",
			"Create a token at https://dash.cloudflare.com/profile/api-tokens using the Templates > Cloudflare Pages: Edit template plus Zone DNS: Edit.",
			"Find your account ID in the Cloudflare dashboard right-hand sidebar.",
			`Then run: CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... bun scripts/cloudflare-setup.ts${dryRun ? " --dry-run" : ""}`,
		);
}

/**
 * Points one hostname at the Pages project. Cloudflare does not create the
 * record for a root domain, so the flattened CNAME is written here, after any
 * parked answer that would shadow it is removed.
 */
async function ensurePagesRecord(
	zoneId: string,
	host: string,
	target: string,
): Promise<void> {
	const records =
		(await call<DnsRecord[]>(
			`/zones/${zoneId}/dns_records?name=${encodeURIComponent(host)}&match=all&per_page=100`,
		)) ?? [];
	if (records.some((r) => r.type === "CNAME" && r.content === target)) {
		pass(`CNAME ${host} -> ${target} is already in place`);
		return;
	}
	for (const record of records) {
		if (dryRun) {
			warn(`Would delete ${record.type} ${host} -> ${record.content}`);
			continue;
		}
		await call(`/zones/${zoneId}/dns_records/${record.id}`, {
			method: "DELETE",
		});
		detail(`removed stale ${record.type} ${host} -> ${record.content}`);
	}
	if (dryRun) {
		warn(`Would create CNAME ${host} -> ${target} (proxied)`);
		return;
	}
	await call(`/zones/${zoneId}/dns_records`, {
		method: "POST",
		body: JSON.stringify({
			type: "CNAME",
			name: host === domain ? "@" : host.slice(0, -1 - domain.length),
			content: target,
			proxied: true,
			ttl: 1,
			comment: "Loom on Cloudflare Pages",
		}),
	});
	pass(`Created CNAME ${host} -> ${target} (proxied)`);
}

async function attachDomain(name: string): Promise<void> {
	const domains =
		(await call<{ name?: string; status?: string }[]>(
			`/accounts/${account}/pages/projects/${project}/domains`,
		)) ?? [];
	const attached = domains.find(
		(item) => (item.name ?? "").toLowerCase() === name.toLowerCase(),
	);
	if (attached) {
		pass(
			`${name} is already attached (status ${attached.status ?? "unknown"})`,
		);
		return;
	}
	if (dryRun) {
		warn(`Would attach custom domain ${name} to ${project}`);
		return;
	}
	await call(`/accounts/${account}/pages/projects/${project}/domains`, {
		method: "POST",
		body: JSON.stringify({ name }),
	});
	pass(`Requested the custom domain ${name}`);
}

async function verifyPublicUrls() {
	const checks = [
		{
			path: "/",
			kind: "text/html",
			expect: /Loom/i,
			reject: /parked with|powered by|domain is for sale/i,
		},
		{
			path: "/install.sh",
			kind: "text/plain",
			expect: /Loom installer/i,
			reject: /<html/i,
		},
		{
			path: "/install.ps1",
			kind: "text/plain",
			expect: /Loom installer/i,
			reject: /<html/i,
		},
	];
	let pending = 0;
	for (const check of checks) {
		let last = "";
		let ready = false;
		for (let attempt = 1; attempt <= 6; attempt += 1) {
			try {
				const response = await fetch(`https://${domain}${check.path}`, {
					redirect: "follow",
					headers: { "Cache-Control": "no-cache" },
					signal: AbortSignal.timeout(15_000),
				});
				const body = await response.text();
				const type = response.headers.get("content-type") ?? "";
				last = `HTTP ${response.status}, ${type.split(";")[0]}`;
				if (
					response.ok &&
					type.includes(check.kind) &&
					check.expect.test(body) &&
					!check.reject.test(body)
				) {
					ready = true;
					pass(`https://${domain}${check.path} serves ${check.kind} (${last})`);
					break;
				}
			} catch (error) {
				last = error instanceof Error ? error.message : "request failed";
			}
			if (!ready && attempt < 6) await Bun.sleep(5_000);
		}
		if (!ready) {
			pending += 1;
			warn(
				`https://${domain}${check.path} is not ready (${last}); a parking page or stale cache is still answering`,
			);
		}
	}
	if (pending) {
		process.exitCode = 1;
		detail(
			"DNS propagation and the Pages certificate can take a few minutes. Re-run: bun scripts/cloudflare-setup.ts --verify-only",
		);
	}
}

async function main() {
	phase(`Verifying Cloudflare access for ${domain}`);
	if (verifyOnly) {
		await verifyPublicUrls();
		return;
	}
	requireCredentials();
	// Reading the account name needs Account Settings: Read, which a Pages-only
	// token does not have; the Pages project list proves the same access.
	const accountInfo = await call<{ id: string; name: string }>(
		`/accounts/${account}`,
		undefined,
		{ tolerateFailure: true },
	);
	if (accountInfo) {
		pass(`Account ${accountInfo.name} is reachable with this token`);
	} else {
		const projects =
			(await call<{ name: string }[]>(
				`/accounts/${account}/pages/projects`,
				undefined,
				{ tolerateFailure: true },
			)) ?? null;
		if (projects === null)
			fail(
				`This token cannot reach account ${account}.`,
				"Needed: Account · Cloudflare Pages: Edit, plus Zone · Zone: Read and Zone · DNS: Edit for the domain's zone.",
			);
		pass(
			`Account ${account} reachable through ${projects.length} Pages project(s)`,
		);
	}

	const zones =
		(await call<Zone[]>(`/zones?name=${encodeURIComponent(domain)}`)) ?? [];
	let zone = zones[0] ?? null;
	if (!zone) {
		if (prepareOnly) {
			warn(
				`${domain} is not a zone in this account yet; the Pages project is prepared anyway.`,
			);
			detail(
				`Add the site in Cloudflare (Websites > Add a site > ${domain}), then run: bun run domain:setup`,
			);
			detail(
				"A token with Zone · Zone: Create can do it for you: bun run domain:setup -- --create-zone",
			);
		} else if (!createZone) {
			fail(
				`${domain} is not a zone in this Cloudflare account.`,
				`Add the site in Cloudflare (Websites > Add a site > ${domain}) and point the registrar at the Cloudflare nameservers.`,
				"Re-run with --create-zone (token needs Zone · Zone: Create) to let this script add the zone and print the nameservers to set.",
			);
		} else if (dryRun) {
			warn(`Would create a zone for ${domain} in account ${account}`);
		} else {
			zone = await call<Zone>("/zones", {
				method: "POST",
				body: JSON.stringify({
					name: domain,
					account: { id: account },
					type: "full",
				}),
			});
			pass(`Created the zone for ${domain}`);
		}
	} else {
		pass(
			`Zone found (${zone.status}, nameservers ${zone.name_servers.join(", ")})`,
		);
	}
	if (zone) {
		detail(`nameservers  ${zone.name_servers.join("  ")}`);
		if (zone.status !== "active")
			detail(
				`Zone status is ${zone.status}: set those nameservers at your registrar and Cloudflare activates it automatically.`,
			);
	}
	if (!zone && !prepareOnly && !dryRun)
		fail(`Cloudflare did not return a zone for ${domain}`);

	phase(`Reading the zone records that answer ${domain}`);
	const records =
		zone === null
			? []
			: ((await call<DnsRecord[]>(
					`/zones/${zone.id}/dns_records?name=${encodeURIComponent(domain)}&match=all&per_page=100`,
				)) ?? []);
	const pages = records.filter((record) =>
		record.content.includes("pages.dev"),
	);
	const blockers = records.filter(
		(record) =>
			!record.content.includes("pages.dev") &&
			["A", "AAAA", "CNAME"].includes(record.type),
	);
	if (pages.length)
		pass(
			pages
				.map((record) => `${record.type} ${record.name} -> ${record.content}`)
				.join("\n      "),
		);
	for (const record of blockers)
		warn(
			`Blocking ${record.type} ${record.name} -> ${record.content} (not a Pages target)`,
		);
	if (blockers.length && fixDns) {
		for (const record of blockers) {
			if (dryRun) {
				warn(
					`Would delete DNS record ${record.id} (${record.type} ${record.name})`,
				);
				continue;
			}
			await call(`/zones/${zone?.id ?? ""}/dns_records/${record.id}`, {
				method: "DELETE",
			});
			pass(
				`Deleted ${record.type} ${record.name} so Cloudflare Pages can own the record`,
			);
		}
	} else if (blockers.length) {
		warn("Pass --fix-dns to remove those records automatically.");
	}

	phase(`Ensuring the Pages project ${project} exists`);
	let projectInfo = await call<PagesProject>(
		`/accounts/${account}/pages/projects/${project}`,
		undefined,
		{ notFoundAsNull: true },
	);
	if (projectInfo)
		pass(
			`Project ${projectInfo.name} (production branch ${projectInfo.production_branch})`,
		);
	else if (dryRun)
		warn(
			`Would create Pages project ${project} with production branch ${branch}`,
		);
	else {
		projectInfo = await call<PagesProject>(
			`/accounts/${account}/pages/projects`,
			{
				method: "POST",
				body: JSON.stringify({ name: project, production_branch: branch }),
			},
		);
		pass(`Created Pages project ${project}`);
	}
	const target = projectInfo?.subdomain || `${project}.pages.dev`;

	if (prepareOnly) {
		warn(
			`Stopped before the domain step (--prepare). Deploy first, then attach ${domain}.`,
		);
		return;
	}
	if (zone && zone.status !== "active") {
		fail(
			`The zone for ${domain} is still ${zone.status}, so Pages cannot own the record yet.`,
			`Set these nameservers at your registrar: ${zone.name_servers.join("  ")}`,
			"Then re-run: bun run domain:setup",
		);
	}

	const hosts = [domain, ...aliases.map((alias) => `${alias}.${domain}`)];
	phase(`Pointing ${hosts.join(" and ")} at ${target}`);
	if (!zone) {
		warn("No zone to write records for; the domain steps are skipped.");
		return;
	}
	for (const host of hosts) {
		await ensurePagesRecord(zone.id, host, target);
		await attachDomain(host);
	}

	if (zone && !dryRun) {
		const purged = await call<unknown>(
			`/zones/${zone.id}/purge_cache`,
			{
				method: "POST",
				body: JSON.stringify({
					files: hosts.flatMap((host) => [
						`https://${host}/`,
						`https://${host}/install.sh`,
						`https://${host}/install.ps1`,
					]),
				}),
			},
			{ tolerateFailure: true },
		);
		if (purged !== null)
			pass("Purged cached answers for the site and both installers");
		else
			warn(
				"Could not purge the zone cache (needs Zone · Cache Purge: Edit); a parked page may still be served for a few minutes.",
			);
	}

	phase("Checking the published installers on the domain");
	await verifyPublicUrls();
	console.log(
		`\n${paint("1;32", `Loom is reachable at https://${domain}`)}\n      install: curl -fsSL https://${domain}/install.sh | sh`,
	);
}

await main().catch((error: unknown) => {
	if (error instanceof SetupError) process.exit(1);
	throw error;
});

export {};
