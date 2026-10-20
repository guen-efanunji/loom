import { lstat, readFile, realpath } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { randomUUID } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { Database } from "@loom/db";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isIP } from "node:net";
import { Hono } from "hono";

type Project = { id: string; name: string; path: string };
type Options = { db: Database; projects: { getById(id: string): Promise<Project | undefined> } };
type Dict = Record<string, unknown>;
	type McpTransportKind = "stdio" | "streamable-http";
	type McpConfig = {
	endpoint?: string;
	command?: string;
	args: string[];
	cwd?: string;
	envRefs: Record<string, string>;
	headerEnvRefs: Record<string, string>;
	};
	type McpToolSummary = { name: string; description?: string; inputSchema?: unknown };
	type McpConnectionRow = {
	id: string;
	label: string;
	transport: McpTransportKind;
	config_json: string;
	status: string;
	protocol_version: string | null;
	capabilities_json: string;
	tools_json: string;
	last_connected_at: number | null;
	last_tested_at: number | null;
	last_error: string | null;
	created_at: number;
	updated_at: number;
};

type LiveMcpConnection = { client: Client; transport: StdioClientTransport | StreamableHTTPClientTransport };
const liveConnections = new Map<string, LiveMcpConnection>();
const busyConnections = new Set<string>();

function mcpRows(db: Database) {
	return db.$client.query("SELECT * FROM managed_mcp_connections ORDER BY label COLLATE NOCASE").all() as McpConnectionRow[];
}

function mcpRow(db: Database, id: string) {
	return db.$client.query("SELECT * FROM managed_mcp_connections WHERE id = ?").get(id) as McpConnectionRow | null;
}

function readMcpConfig(row: McpConnectionRow): McpConfig {
	return JSON.parse(row.config_json) as McpConfig;
}

function publicMcpConnection(row: McpConnectionRow) {
	const config = readMcpConfig(row);
	const tools = JSON.parse(row.tools_json) as McpToolSummary[];
	return {
		id: row.id,
		label: row.label,
		transport: row.transport,
		status: row.status,
		endpointHost: config.endpoint ? new URL(config.endpoint).host : undefined,
		command: config.command ? basename(config.command) : undefined,
		argumentCount: config.args.length,
		workingDirectory: config.cwd ? basename(config.cwd) : undefined,
		environmentReferenceNames: Object.values(config.envRefs),
		headerReferences: Object.entries(config.headerEnvRefs).map(([header, envRef]) => ({ header, envRef })),
		protocolVersion: row.protocol_version,
		capabilities: JSON.parse(row.capabilities_json) as Dict,
		tools: tools.map(({ name, description }) => ({ name, description })),
		toolCount: tools.length,
		lastConnectedAt: row.last_connected_at,
		lastTestedAt: row.last_tested_at,
		lastError: row.last_error,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function isPrivateAddress(address: string) {
	if (address.includes(":")) {
		const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
		// Only accept ordinary global-unicast IPv6 addresses. This rejects loopback,
		// link-local, unique-local, multicast, IPv4-mapped, and transition ranges.
		const firstHextet = Number.parseInt(normalized.split(":", 1)[0] ?? "", 16);
		if (!Number.isInteger(firstHextet) || firstHextet < 0x2000 || firstHextet > 0x3fff) return true;
		if (normalized.startsWith("2001:db8:") || normalized.startsWith("2001:0:") || normalized.startsWith("2002:")) return true;
		return false;
	}
	const octets = address.split(".").map(Number);
	if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
	const [a = 0, b = 0] = octets;
	return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 2 || b === 168)) || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0) || (a === 192 && b === 88 && octets[2] === 99);
}

async function validateEndpoint(endpoint: string, allowPrivateNetwork: boolean) {
	const url = new URL(endpoint);
	if (!(["https:", "http:"].includes(url.protocol)) || url.username || url.password || url.search || url.hash) {
		throw new Error("Use an HTTP(S) endpoint without embedded credentials, query parameters, or fragments.");
	}
	if (url.protocol === "http:" && !allowPrivateNetwork) throw new Error("HTTP endpoints require explicit approval for private/local network access.");
	const host = url.hostname.replace(/^\[|\]$/g, "");
	const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
	if (!addresses.length) throw new Error("The endpoint host did not resolve to an IP address.");
	if (addresses.some(({ address }) => isPrivateAddress(address)) && !allowPrivateNetwork) {
		throw new Error("This endpoint resolves to a private or local address. Confirm private-network access before connecting.");
	}
	return url;
}

function toToolSummaries(value: unknown): McpToolSummary[] {
	if (!Array.isArray(value)) return [];
	return value.slice(0, 200).flatMap((item) => {
		const tool = asDict(item);
		if (!tool || typeof tool.name !== "string") return [];
		return [{
			name: tool.name.slice(0, 200),
			...(typeof tool.description === "string" ? { description: tool.description.slice(0, 4000) } : {}),
			...(tool.inputSchema && typeof tool.inputSchema === "object" ? { inputSchema: tool.inputSchema } : {}),
		}];
	});
}

function safeMcpError(error: unknown, config: McpConfig) {
	let message = error instanceof Error ? error.message : "MCP operation failed";
	const secretRefs = [...Object.values(config.envRefs), ...Object.values(config.headerEnvRefs)];
	const secretValues = secretRefs.map((name) => process.env[name]).filter((value): value is string => !!value).sort((a, b) => b.length - a.length);
	for (const value of secretValues) message = message.replaceAll(value, "[redacted]");
	if (config.endpoint) message = message.replaceAll(config.endpoint, "[MCP endpoint]");
	for (const arg of config.args) if (arg.length > 0) message = message.replaceAll(arg, "[argument]");
	return message.slice(0, 500);
}

async function withMcpTimeout<T>(operation: Promise<T>, label: string) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} timed out after 15 seconds.`)), 15_000);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function connectionPayload(body: unknown): { label: string; transport: McpTransportKind; config: McpConfig } {
	const value = asDict(body);
	if (!value || typeof value.label !== "string" || !value.label.trim()) throw new Error("Enter a connection name.");
	const transport = value.transport;
	if (transport !== "stdio" && transport !== "streamable-http") throw new Error("Choose stdio or Streamable HTTP.");
	const args = Array.isArray(value.args) ? value.args : [];
	if (args.length > 64 || args.some((arg) => typeof arg !== "string" || arg.length > 2000)) throw new Error("Arguments must be text values with at most 64 entries.");
	const envRefsInput = asDict(value.envRefs) ?? {};
	const headerEnvRefsInput = asDict(value.headerEnvRefs) ?? {};
	const envRefs: Record<string, string> = {};
	const headerEnvRefs: Record<string, string> = {};
	for (const [key, ref] of Object.entries(envRefsInput)) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof ref !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) throw new Error("Environment references must be valid environment variable names.");
		envRefs[key] = ref;
	}
	for (const [header, ref] of Object.entries(headerEnvRefsInput)) {
		if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header) || typeof ref !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) throw new Error("Header references must map a valid HTTP header to an environment variable name.");
		headerEnvRefs[header] = ref;
	}
	if (transport === "stdio") {
		if (typeof value.command !== "string" || !value.command.trim()) throw new Error("Enter an executable for the stdio server.");
		if (value.cwd !== undefined && (typeof value.cwd !== "string" || !isAbsolute(value.cwd))) throw new Error("Working directory must be an absolute path.");
		return { label: value.label.trim().slice(0, 120), transport, config: { command: value.command.trim(), args: args as string[], ...(typeof value.cwd === "string" && value.cwd ? { cwd: resolve(value.cwd) } : {}), envRefs, headerEnvRefs: {} } };
	}
	if (typeof value.endpoint !== "string") throw new Error("Enter a server URL.");
	const parsedEndpoint = new URL(value.endpoint);
	if (parsedEndpoint.username || parsedEndpoint.password || parsedEndpoint.search || parsedEndpoint.hash) {
		throw new Error("Do not save credentials, query parameters, or fragments in the server URL. Use HTTP header references for credentials.");
	}
	const endpoint = parsedEndpoint.toString();
	if (headerEnvRefsInput && Object.keys(headerEnvRefsInput).length > 16) throw new Error("Use at most 16 header references.");
	return { label: value.label.trim().slice(0, 120), transport, config: { endpoint, args: [], envRefs: {}, headerEnvRefs } };
}

async function openMcpConnection(config: McpConfig, allowPrivateNetwork: boolean) {
	const client = new Client({ name: "Loom", version: "0.1.0" });
	let transport: StdioClientTransport | StreamableHTTPClientTransport;
	if (config.endpoint) {
		const endpoint = await validateEndpoint(config.endpoint, allowPrivateNetwork);
		const fetchWithRefs = async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
			const target = new URL(input instanceof Request ? input.url : input.toString());
			await validateEndpoint(target.toString(), allowPrivateNetwork);
			const headers = new Headers(init?.headers);
			for (const [header, envRef] of Object.entries(config.headerEnvRefs)) {
				const secret = process.env[envRef];
				if (!secret) throw new Error(`Required environment variable ${envRef} is not available to Loom.`);
				headers.set(header, secret);
			}
			return fetch(input, { ...init, headers, redirect: "error", signal: init?.signal ?? AbortSignal.timeout(15_000) });
		};
		transport = new StreamableHTTPClientTransport(endpoint, {
			fetch: fetchWithRefs,
			redirectPolicy: "same-origin",
			requestInit: { redirect: "error" },
		});
	} else {
		const inherited = getDefaultEnvironment();
		const env = { ...inherited };
		for (const [name, envRef] of Object.entries(config.envRefs)) {
			const secret = process.env[envRef];
			if (secret === undefined) throw new Error(`Required environment variable ${envRef} is not available to Loom.`);
			env[name] = secret;
		}
		if (!config.command) throw new Error("The stdio executable is missing.");
		transport = new StdioClientTransport({ command: config.command, args: config.args, env, ...(config.cwd ? { cwd: config.cwd } : {}), stderr: "ignore" });
	}
	try {
		await withMcpTimeout(client.connect(transport), "MCP handshake");
		const listed = await withMcpTimeout(client.listTools(), "Tool discovery");
		return {
			client,
			transport,
			tools: toToolSummaries(listed.tools),
			server: client.getServerVersion() ?? null,
			capabilities: client.getServerCapabilities() ?? {},
			protocolVersion: "protocolVersion" in transport ? transport.protocolVersion ?? null : null,
		};
	} catch (error) {
		await client.close().catch(() => undefined);
		await transport.close().catch(() => undefined);
		throw error;
	}
}

function saveMcpResult(db: Database, id: string, result: Awaited<ReturnType<typeof openMcpConnection>>, status: "connected" | "disconnected") {
	const now = Date.now();
	db.$client.query("UPDATE managed_mcp_connections SET status = ?, protocol_version = ?, capabilities_json = ?, tools_json = ?, last_connected_at = CASE WHEN ? = 'connected' THEN ? ELSE last_connected_at END, last_tested_at = ?, last_error = NULL, updated_at = ? WHERE id = ?")
		.run(status, result.protocolVersion, JSON.stringify(result.capabilities), JSON.stringify(result.tools), status, now, now, now, id);
}

const configLimit = 1_000_000;
const serversPerSourceLimit = 100;
const serverLimit = 300;

function asDict(value: unknown): Dict | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Dict : undefined;
}

function safePathInside(root: string, candidate: string) {
	const path = relative(root, candidate);
	return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function hostOnly(endpoint: unknown) {
	if (typeof endpoint !== "string") return undefined;
	try {
		const url = new URL(endpoint);
		return url.host;
	} catch {
		return undefined;
	}
}

function commandName(value: unknown) {
	if (typeof value === "string") return basename(value);
	if (Array.isArray(value) && typeof value[0] === "string") return basename(value[0]);
	return undefined;
}

function summarizeServer(runtime: string, scope: string, source: string, name: string, value: unknown) {
	const config = asDict(value);
	if (!config) return undefined;
	const command = config.command;
	const url = config.url;
	const type = typeof config.type === "string" ? config.type.toLowerCase() : "";
	let transport = "Unknown";
	if (["stdio", "local"].includes(type) || command !== undefined) transport = "stdio";
	else if (["http", "streamable-http", "remote"].includes(type)) transport = "Streamable HTTP";
	else if (type === "sse") transport = "Legacy SSE";
	else if (["ws", "websocket"].includes(type)) transport = "WebSocket";
	else if (typeof url === "string") transport = "Invalid or unspecified HTTP transport";
	const args = Array.isArray(config.args) ? config.args : Array.isArray(command) ? command.slice(1) : [];
	const env = asDict(config.env) ?? asDict(config.environment);
	const headers = asDict(config.headers) ?? asDict(config.http_headers);
	const enabled = typeof config.enabled === "boolean"
		? config.enabled
		: typeof config.disabled === "boolean" ? !config.disabled : null;
	return {
		id: `${runtime}:${scope}:${source}:${name}`,
		name: name.slice(0, 160),
		runtime,
		scope,
		source,
		ownership: "native / externally managed",
		transport,
		connectionState: "unknown",
		enabled,
		command: commandName(command),
		argumentCount: args.length,
		endpointHost: hostOnly(url),
		environmentVariableNames: env ? Object.keys(env).slice(0, 80) : Array.isArray(config.env_vars) ? config.env_vars.filter((item): item is string => typeof item === "string").slice(0, 80) : [],
		headerNames: headers ? Object.keys(headers).slice(0, 80) : [],
	};
}

function addDefinitions(
	servers: ReturnType<typeof summarizeServer>[],
	runtime: string,
	scope: string,
	source: string,
	value: unknown,
) {
	const records = asDict(value);
	if (!records) return;
	for (const [name, definition] of Object.entries(records).slice(0, serversPerSourceLimit)) {
		const server = summarizeServer(runtime, scope, source, name, definition);
		if (server) servers.push(server);
	}
}

async function readConfig(path: string, allowedRoot: string) {
	try {
		const info = await lstat(path);
		if (!info.isFile() || info.isSymbolicLink() || info.size > configLimit) return { status: "unavailable", reason: "Config is not a regular file or exceeds the scan limit" } as const;
		const [realRoot, realFile] = await Promise.all([realpath(allowedRoot), realpath(path)]);
		if (!safePathInside(realRoot, realFile)) return { status: "unavailable", reason: "Config resolves outside its expected directory" } as const;
		return { status: "available", text: await readFile(realFile, "utf8") } as const;
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { status: "not-found" } as const;
		return { status: "unavailable", reason: "Config could not be read" } as const;
	}
}

async function inspectJsonSource(input: {
	path: string;
	allowedRoot: string;
	runtime: string;
	scope: string;
	label: string;
	servers: ReturnType<typeof summarizeServer>[];
	selectServers(parsed: Dict): unknown;
}) {
	const result = await readConfig(input.path, input.allowedRoot);
	if (result.status !== "available") return { id: `${input.runtime}:${input.scope}:${input.label}`, runtime: input.runtime, scope: input.scope, file: input.label, status: result.status, issue: result.reason };
	try {
		const parsed = asDict(JSON.parse(result.text));
		if (!parsed) throw new Error("Expected object");
		addDefinitions(input.servers, input.runtime, input.scope, input.label, input.selectServers(parsed));
		return { id: `${input.runtime}:${input.scope}:${input.label}`, runtime: input.runtime, scope: input.scope, file: input.label, status: "available" };
	} catch {
		return { id: `${input.runtime}:${input.scope}:${input.label}`, runtime: input.runtime, scope: input.scope, file: input.label, status: "invalid", issue: "Config is not valid JSON in the supported schema" };
	}
}

async function inspectTomlSource(path: string, allowedRoot: string, scope: string, label: string, servers: ReturnType<typeof summarizeServer>[]) {
	const result = await readConfig(path, allowedRoot);
	const source = { id: `codex:${scope}:${label}`, runtime: "codex", scope, file: label };
	if (result.status !== "available") return { ...source, status: result.status, issue: result.reason };
	try {
		const parsed = asDict(Bun.TOML.parse(result.text));
		addDefinitions(servers, "codex", scope, label, parsed?.mcp_servers);
		return { ...source, status: "available" };
	} catch {
		return { ...source, status: "invalid", issue: "Config is not valid TOML in the supported schema" };
	}
}

async function discover(project?: Project) {
	const home = homedir();
	const xdgConfig = process.env.XDG_CONFIG_HOME || join(home, ".config");
	const servers: ReturnType<typeof summarizeServer>[] = [];
	const sources: Array<{ id: string; runtime: string; scope: string; file: string; status: string; issue?: string }> = [];
	const globalClaudePath = join(home, ".claude.json");
	sources.push(await inspectJsonSource({
		path: globalClaudePath,
		allowedRoot: home,
		runtime: "claude",
		scope: "global",
		label: "~/.claude.json",
		servers,
		selectServers: (parsed) => parsed.mcpServers,
	}));
	if (project) {
		const globalClaude = await readConfig(globalClaudePath, home);
		if (globalClaude.status === "available") {
			try {
				const parsed = asDict(JSON.parse(globalClaude.text));
				const projectConfigs = asDict(parsed?.projects);
				const matching = asDict(projectConfigs?.[project.path]);
				addDefinitions(servers, "claude", "workspace-local", "~/.claude.json (workspace entry)", matching?.mcpServers);
			} catch {
				// The global source reports the parse failure.
			}
		}
		const projectMcpPath = join(project.path, ".mcp.json");
		sources.push(await inspectJsonSource({
			path: projectMcpPath,
			allowedRoot: project.path,
			runtime: "claude",
			scope: "workspace",
			label: "<workspace>/.mcp.json",
			servers,
			selectServers: (parsed) => parsed.mcpServers,
		}));
	}
	sources.push(await inspectTomlSource(join(home, ".codex", "config.toml"), home, "global", "~/.codex/config.toml", servers));
	if (project) sources.push(await inspectTomlSource(join(project.path, ".codex", "config.toml"), project.path, "workspace", "<workspace>/.codex/config.toml", servers));
	const opencodeGlobalPath = join(xdgConfig, "opencode", "opencode.json");
	sources.push(await inspectJsonSource({
		path: opencodeGlobalPath,
		allowedRoot: join(xdgConfig, "opencode"),
		runtime: "opencode",
		scope: "global",
		label: "OpenCode user config",
		servers,
		selectServers: (parsed) => parsed.mcp,
	}));
	if (project) {
		for (const [path, label] of [
			[join(project.path, "opencode.json"), "<workspace>/opencode.json"],
			[join(project.path, ".opencode", "opencode.json"), "<workspace>/.opencode/opencode.json"],
		] as const) {
			sources.push(await inspectJsonSource({
				path,
				allowedRoot: project.path,
				runtime: "opencode",
				scope: "workspace",
				label,
				servers,
				selectServers: (parsed) => parsed.mcp,
			}));
		}
	}
	const clipped = servers.length > serverLimit;
	return {
		projectId: project?.id ?? null,
		projectName: project?.name ?? null,
		generatedAt: new Date().toISOString(),
		connectionStatus: "not-observed",
		coverage: { maxConfigBytes: configLimit, maxServersPerSource: serversPerSourceLimit, maxServers: serverLimit, truncated: clipped },
		sources,
		servers: servers.slice(0, serverLimit),
	};
}

export function createMcpManagerRoutes(options: Options) {
	const app = new Hono();
	const sqlite = options.db.$client;
	// A persisted "connected" flag cannot prove a process survived a daemon restart.
	sqlite.query("UPDATE managed_mcp_connections SET status = 'interrupted', last_error = 'Loom restarted; reconnect to verify this server.' WHERE status IN ('connected', 'connecting')").run();
	app.get("/connections", (c) => c.json({ connections: mcpRows(options.db).map(publicMcpConnection) }));
	app.post("/connections", async (c) => {
		try {
			const payload = connectionPayload(await c.req.json());
			const id = randomUUID();
			sqlite.query("INSERT INTO managed_mcp_connections (id, label, transport, config_json) VALUES (?, ?, ?, ?)")
				.run(id, payload.label, payload.transport, JSON.stringify(payload.config));
			const row = mcpRow(options.db, id);
			return c.json({ connection: row ? publicMcpConnection(row) : null }, 201);
		} catch (error) {
			return c.json({ error: { message: error instanceof Error ? error.message : "Invalid MCP connection" } }, 400);
		}
	});
	app.put("/connections/:id", async (c) => {
		const id = c.req.param("id");
		const current = mcpRow(options.db, id);
		if (!current) return c.json({ error: { message: "MCP connection not found" } }, 404);
		if (liveConnections.has(id) || busyConnections.has(id)) return c.json({ error: { message: "Disconnect or wait for the Loom-owned session before editing its configuration." } }, 409);
		try {
			const payload = connectionPayload(await c.req.json());
			sqlite.query("UPDATE managed_mcp_connections SET label = ?, transport = ?, config_json = ?, status = 'disconnected', last_error = NULL, updated_at = ? WHERE id = ?")
				.run(payload.label, payload.transport, JSON.stringify(payload.config), Date.now(), id);
			const row = mcpRow(options.db, id);
			return c.json({ connection: row ? publicMcpConnection(row) : null });
		} catch (error) {
			return c.json({ error: { message: error instanceof Error ? error.message : "Invalid MCP connection" } }, 400);
		}
	});
	app.post("/connections/:id/test", async (c) => {
		const id = c.req.param("id");
		const row = mcpRow(options.db, id);
		if (!row) return c.json({ error: { message: "MCP connection not found" } }, 404);
		if (liveConnections.has(id) || busyConnections.has(id)) return c.json({ error: { message: "This connection already has a Loom-owned session or operation in progress." } }, 409);
		let body: Dict | undefined;
		try { body = asDict(await c.req.json()); } catch { body = undefined; }
		if (body?.approved !== true) return c.json({ error: { message: "Confirm that Loom may start this process or contact this endpoint." } }, 428);
		busyConnections.add(id);
		let opened: Awaited<ReturnType<typeof openMcpConnection>> | undefined;
		try {
			sqlite.query("UPDATE managed_mcp_connections SET status = 'connecting', last_error = NULL, updated_at = ? WHERE id = ?").run(Date.now(), id);
			const config = readMcpConfig(row);
			opened = await openMcpConnection(config, body.allowPrivateNetwork === true);
			saveMcpResult(options.db, id, opened, "disconnected");
			return c.json({ ok: true, protocolVersion: opened.protocolVersion, server: opened.server, capabilities: opened.capabilities, tools: opened.tools.map(({ name, description }) => ({ name, description })), toolCount: opened.tools.length, status: "disconnected" });
		} catch (error) {
			const message = safeMcpError(error, readMcpConfig(row));
			sqlite.query("UPDATE managed_mcp_connections SET status = 'error', last_error = ?, last_tested_at = ?, updated_at = ? WHERE id = ?").run(message, Date.now(), Date.now(), id);
			return c.json({ error: { message } }, 502);
		} finally {
			if (opened) {
				await opened.client.close().catch(() => undefined);
				await opened.transport.close().catch(() => undefined);
			}
			busyConnections.delete(id);
		}
	});
	app.post("/connections/:id/connect", async (c) => {
		const id = c.req.param("id");
		const row = mcpRow(options.db, id);
		if (!row) return c.json({ error: { message: "MCP connection not found" } }, 404);
		if (liveConnections.has(id)) return c.json({ connection: publicMcpConnection(row) });
		if (busyConnections.has(id)) return c.json({ error: { message: "A Loom-owned operation is already in progress for this connection." } }, 409);
		let body: Dict | undefined;
		try { body = asDict(await c.req.json()); } catch { body = undefined; }
		if (body?.approved !== true) return c.json({ error: { message: "Confirm that Loom may start this process or contact this endpoint." } }, 428);
		busyConnections.add(id);
		try {
			sqlite.query("UPDATE managed_mcp_connections SET status = 'connecting', last_error = NULL, updated_at = ? WHERE id = ?").run(Date.now(), id);
			const config = readMcpConfig(row);
			const opened = await openMcpConnection(config, body.allowPrivateNetwork === true);
			liveConnections.set(id, opened);
			saveMcpResult(options.db, id, opened, "connected");
			opened.transport.onclose = () => {
				if (!liveConnections.has(id)) return;
				liveConnections.delete(id);
				sqlite.query("UPDATE managed_mcp_connections SET status = 'degraded', last_error = 'The MCP session closed unexpectedly.', updated_at = ? WHERE id = ?").run(Date.now(), id);
			};
			opened.transport.onerror = () => {
				if (!liveConnections.has(id)) return;
				sqlite.query("UPDATE managed_mcp_connections SET status = 'degraded', last_error = 'The MCP transport reported an error.', updated_at = ? WHERE id = ?").run(Date.now(), id);
			};
			const next = mcpRow(options.db, id);
			return c.json({ connection: next ? publicMcpConnection(next) : null });
		} catch (error) {
			const message = safeMcpError(error, readMcpConfig(row));
			sqlite.query("UPDATE managed_mcp_connections SET status = 'error', last_error = ?, updated_at = ? WHERE id = ?").run(message, Date.now(), id);
			return c.json({ error: { message } }, 502);
		} finally {
			busyConnections.delete(id);
		}
	});
	app.post("/connections/:id/disconnect", async (c) => {
		const id = c.req.param("id");
		const row = mcpRow(options.db, id);
		if (!row) return c.json({ error: { message: "MCP connection not found" } }, 404);
		if (busyConnections.has(id)) return c.json({ error: { message: "Wait for the current Loom-owned operation to finish before disconnecting." } }, 409);
		const live = liveConnections.get(id);
		if (live) {
			liveConnections.delete(id);
			await live.client.close().catch(() => undefined);
			await live.transport.close().catch(() => undefined);
		}
		sqlite.query("UPDATE managed_mcp_connections SET status = 'disconnected', updated_at = ? WHERE id = ?").run(Date.now(), id);
		return c.json({ connection: publicMcpConnection(mcpRow(options.db, id) ?? row) });
	});
	app.delete("/connections/:id", async (c) => {
		const id = c.req.param("id");
		const row = mcpRow(options.db, id);
		if (!row) return c.json({ error: { message: "MCP connection not found" } }, 404);
		if (busyConnections.has(id)) return c.json({ error: { message: "Wait for the current Loom-owned operation to finish before removing this connection." } }, 409);
		const live = liveConnections.get(id);
		if (live) {
			liveConnections.delete(id);
			await live.client.close().catch(() => undefined);
			await live.transport.close().catch(() => undefined);
		}
		sqlite.query("DELETE FROM managed_mcp_connections WHERE id = ?").run(id);
		return c.json({ ok: true });
	});
	app.get("/inventory", async (c) => {
		const projectId = c.req.query("projectId");
		if (!projectId) return c.json(await discover());
		const project = await options.projects.getById(projectId);
		if (!project) return c.json({ error: { message: "Project not found" } }, 404);
		return c.json(await discover(project));
	});
	return app;
}
