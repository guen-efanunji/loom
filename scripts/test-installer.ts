import { createHash } from "node:crypto";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { platformKey, REPOSITORY } from "../packages/distribution/src/index";

// Tests the one-line installers without touching the real system or network.
// Unix installers run end to end against fixture release files served by a fake
// curl, covering the manifest path, the version.txt fallback and the install log
// the installer prints. The Windows installer is syntax-checked with PowerShell
// when available and structurally asserted everywhere.
const root = resolve(join(import.meta.dir, ".."));
const platform = platformKey();
function assert(value: unknown, message: string): asserts value {
	if (!value) throw new Error(message);
}
async function run(
	command: string[],
	env: Record<string, string>,
	cwd: string,
) {
	const child = Bun.spawn(command, {
		cwd,
		env: { ...process.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { stdout, stderr, exitCode };
}

if (platform.startsWith("windows")) {
	const script = await readFile(join(root, "install.ps1"), "utf8");
	for (const required of [
		"SecurityProtocol",
		"Invoke-RestMethod",
		"Invoke-WebRequest",
		"Get-FileHash",
		"Loom is installed. Run loom update to update safely.",
		"Checksum or size mismatch. Nothing was installed.",
		"SetEnvironmentVariable('Path'",
		"Resolving the latest release",
		"Verifying the download",
		"LOOM_CHANNEL",
		"LOOM_HOME",
		"LOOM_RELEASE_BASE",
	])
		assert(script.includes(required), `install.ps1 is missing: ${required}`);
	for (const phase of [
		"Checking your system",
		"Checking the tools this installer needs",
		"Checking what Loom needs after the binary is installed",
		"Downloading the Loom binary",
		"Installing Loom",
		"Adding Loom to your user PATH",
	])
		assert(script.includes(phase), `install.ps1 is missing a phase: ${phase}`);
	const parser = Bun.which("pwsh") ?? Bun.which("powershell");
	if (parser) {
		const check = await run(
			[
				parser,
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				`[void][System.Management.Automation.Language.Parser]::ParseFile(${JSON.stringify(join(root, "install.ps1"))}, [ref]$null, [ref]$errors); if ($errors.Count) { $errors | ForEach-Object { Write-Output $_.Message }; exit 1 }`,
			],
			{},
			root,
		);
		assert(
			check.exitCode === 0,
			`install.ps1 has syntax errors:\n${check.stdout}`,
		);
	} else {
		console.log("SKIP powershell parse check: no pwsh or powershell on PATH");
	}
	console.log("PASS windows-x64: installer syntax, phases and safety guards");
	process.exit(0);
}

const [os, arch] = platform.split("-");
const name = `loom-${os}-${arch}`;
const version = "9.9.9";
const binaryFixture = `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "loom ${version}"; exit 0; fi\necho "loom ${version}"\n`;
const sha256 = createHash("sha256").update(binaryFixture).digest("hex");
const sandbox = await mkdtemp(join(tmpdir(), "loom-installer-"));
try {
	assert(
		(await run(["sh", "-n", join(root, "install.sh")], {}, root)).exitCode ===
			0,
		"install.sh has syntax errors",
	);
	const fixtures = join(sandbox, "fixtures");
	await mkdir(fixtures, { recursive: true });
	const base = `https://github.com/${REPOSITORY}/releases/download`;
	const manifest = {
		version,
		protocolVersion: 1,
		releasedAt: "2026-01-01T00:00:00.000Z",
		artifacts: {
			[platform]: {
				url: `${base}/v${version}/${name}`,
				sha256,
				size: binaryFixture.length,
			},
		},
	};
	await writeFile(
		join(fixtures, "manifest.json"),
		`${JSON.stringify(manifest, null, 2)}\n`,
	);
	await writeFile(join(fixtures, "version.txt"), `${version}\n`);
	await writeFile(join(fixtures, name), binaryFixture);
	await writeFile(join(fixtures, "SHA256SUMS"), `${sha256}  ${name}\n`);
	const fakeBin = join(sandbox, "bin");
	await mkdir(fakeBin, { recursive: true });
	await writeFile(
		join(fakeBin, "curl"),
		[
			"#!/bin/sh",
			'out=""; url=""; prev=""',
			'for arg in "$@"; do',
			'  if [ "$prev" = "-o" ]; then out="$arg"; prev=""; continue; fi',
			'  case "$arg" in -o) prev="-o";; http*://*|https*) url="$arg";; esac',
			"done",
			'case "$url" in',
			'*manifest.json) if [ -n "$FAIL_MANIFEST" ]; then exit 22; fi; cat "$FIXTURES/manifest.json" > "$out" ;;',
			'*version.txt) cat "$FIXTURES/version.txt" > "$out" ;;',
			'*SHA256SUMS) cat "$FIXTURES/SHA256SUMS" > "$out" ;;',
			`*${name}) cat "$FIXTURES/${name}" > "$out" ;;`,
			'*) echo "unexpected url $url" >&2; exit 22 ;;',
			"esac",
		].join("\n"),
	);
	await chmod(join(fakeBin, "curl"), 0o755);
	const env = {
		PATH: `${fakeBin}:/usr/bin:/bin`,
		SHELL: "/bin/bash",
		LOOM_CHANNEL: "stable",
		FIXTURES: fixtures,
	};
	const invoke = (home: string, extra: Record<string, string> = {}) =>
		run(
			["sh", join(root, "install.sh")],
			{ ...env, HOME: home, LOOM_HOME: join(home, ".loom"), ...extra },
			root,
		);
	const first = await invoke(join(sandbox, "home"), {
		LOOM_HOME: join(sandbox, "home", ".loom"),
	});
	assert(
		first.exitCode === 0,
		`Installer failed:\n${first.stdout}\n${first.stderr}`,
	);
	for (const phase of [
		"[1/8] Checking your system",
		"[2/8] Checking the tools this installer needs",
		"[3/8] Checking what Loom needs after the binary is installed",
		"[4/8] Resolving the latest release on the stable channel",
		"[5/8] Downloading the Loom binary",
		"[6/8] Verifying the download",
		"[7/8] Installing Loom",
		"[8/8] Adding Loom to your user PATH",
	])
		assert(first.stdout.includes(phase), `Installer log is missing: ${phase}`);
	for (const line of [
		`Platform ${platform}`,
		"install target",
		"release channel stable",
		`Loom ${version} for ${platform}`,
		"expected sha256",
		"SHA-256 verified",
		`Executable answers: loom ${version}`,
		"Wrote PATH entry",
		"installed successfully",
		"loom doctor",
	])
		assert(first.stdout.includes(line), `Installer log is missing: ${line}`);
	const installed = join(sandbox, "home", ".loom", "bin", "loom");
	assert(
		(await run([installed, "--version"], {}, root)).stdout.includes(
			`loom ${version}`,
		),
		"Installed binary does not run",
	);
	const profile = await readFile(join(sandbox, "home", ".profile"), "utf8");
	assert(
		profile.includes("# Loom") && profile.includes(".loom/bin"),
		"Shell profile was not updated",
	);

	// Re-running the installer refuses to overwrite a healthy installation.
	const rerun = await invoke(join(sandbox, "home"), {
		LOOM_HOME: join(sandbox, "home", ".loom"),
	});
	assert(
		rerun.exitCode !== 0 &&
			`${rerun.stdout}${rerun.stderr}`.includes("already installed"),
		"Reinstall guard did not trigger",
	);
	const reinstall = await invoke(join(sandbox, "home"), {
		LOOM_HOME: join(sandbox, "home", ".loom"),
		LOOM_REINSTALL: "1",
	});
	assert(
		reinstall.exitCode === 0 && reinstall.stdout.includes("Updated "),
		`Explicit same-version reinstall failed:\n${reinstall.stdout}\n${reinstall.stderr}`,
	);

	const brokenPrior = "#!/bin/sh\\nexit 42\\n";
	await writeFile(installed, brokenPrior);
	const repaired = await invoke(join(sandbox, "home"), {
		LOOM_HOME: join(sandbox, "home", ".loom"),
	});
	assert(
		repaired.exitCode === 0 &&
			repaired.stdout.includes("preparing verified version") &&
			repaired.stdout.includes("Repaired ") &&
			repaired.stdout.includes("Loom repaired to"),
		`Broken-install repair failed:\\n${repaired.stdout}\\n${repaired.stderr}`,
	);
	assert(
		(await run([installed, "--version"], {}, root)).stdout.includes(
			`loom ${version}`,
		),
		"Repair did not activate the verified candidate",
	);

	// A newer published release upgrades the same installation in place, which is
	// the recovery path when `loom update` cannot finish on a slow connection.
	const newer = "9.9.10";
	const newerBinary = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "loom ${newer}"; exit 0; fi
`;
	const newerSha = createHash("sha256").update(newerBinary).digest("hex");
	await writeFile(join(fixtures, name), newerBinary);
	await writeFile(
		join(fixtures, "manifest.json"),
		`${JSON.stringify(
			{
				...manifest,
				version: newer,
				artifacts: {
					[platform]: {
						url: `${base}/v${newer}/${name}`,
						sha256: newerSha,
						size: newerBinary.length,
					},
				},
			},
			null,
			2,
		)}\n`,
	);
	const upgraded = await invoke(join(sandbox, "home"));
	assert(
		upgraded.exitCode === 0,
		`Upgrade failed:\n${upgraded.stdout}\n${upgraded.stderr}`,
	);
	for (const line of [
		`Found Loom ${version} in place; updating it to ${newer}`,
		"Kept the previous build",
		`Updated ${join(sandbox, "home", ".loom", "bin", "loom")} from ${version} to ${newer}`,
		`Loom updated from ${version} to ${newer}`,
	])
		assert(upgraded.stdout.includes(line), `Upgrade log is missing: ${line}`);
	assert(
		await Bun.file(
			join(sandbox, "home", ".loom", "bin", "loom.previous"),
		).exists(),
		"Upgrade kept no previous build for rollback",
	);
	assert(
		(await run([installed, "--version"], {}, root)).stdout.includes(
			`loom ${newer}`,
		),
		"Upgraded binary does not run",
	);
	await writeFile(join(fixtures, name), binaryFixture);
	await writeFile(
		join(fixtures, "manifest.json"),
		`${JSON.stringify(manifest, null, 2)}\n`,
	);

	// A tampered artifact is rejected and nothing is left behind.
	await writeFile(join(fixtures, name), `${binaryFixture}tampered`);
	const tamperedHome = join(sandbox, "tampered-home");
	const tampered = await invoke(tamperedHome);
	assert(
		tampered.exitCode !== 0 &&
			`${tampered.stdout}${tampered.stderr}`.includes("Checksum mismatch"),
		"Tampered download was accepted",
	);
	assert(
		!(await Bun.file(join(tamperedHome, ".loom", "bin", "loom")).exists()),
		"Tampered install left a binary behind",
	);

	// Without a manifest the installer falls back to version.txt + SHA256SUMS.
	await writeFile(join(fixtures, name), binaryFixture);
	const fallback = await invoke(join(sandbox, "fallback-home"), {
		FAIL_MANIFEST: "1",
	});
	assert(
		fallback.exitCode === 0,
		`Fallback installer failed:\n${fallback.stdout}\n${fallback.stderr}`,
	);
	assert(
		fallback.stdout.includes("Reading the published release version"),
		"Fallback did not report which release source it used",
	);
	await rm(join(fixtures, "manifest.json"), { force: true });
	const missing = await invoke(join(sandbox, "missing-home"));
	assert(
		missing.exitCode === 0,
		`Installer without a manifest failed:\n${missing.stdout}\n${missing.stderr}`,
	);
	const badChannel = await invoke(join(sandbox, "channel-home"), {
		LOOM_CHANNEL: "bogus",
	});
	assert(badChannel.exitCode !== 0, "Invalid channel was accepted");
	const badHome = await invoke(join(sandbox, "rel-home"), {
		LOOM_HOME: "relative/path",
	});
	assert(
		badHome.exitCode !== 0 &&
			`${badHome.stdout}${badHome.stderr}`.includes("absolute path"),
		"Relative LOOM_HOME was accepted",
	);
	const brokenFixture =
		"#!/bin/sh\nprintf 'loader error: incompatible architecture\\n' >&2\nexit 86\n";
	await writeFile(join(fixtures, name), brokenFixture);
	await writeFile(
		join(fixtures, "SHA256SUMS"),
		`${createHash("sha256").update(brokenFixture).digest("hex")}  ${name}\n`,
	);
	const brokenHome = join(sandbox, "broken-home");
	const broken = await invoke(brokenHome, {
		LOOM_HOME: join(brokenHome, ".loom"),
	});
	const brokenLog = `${broken.stdout}${broken.stderr}`;
	assert(broken.exitCode !== 0, "A non-starting executable was installed");
	assert(
		brokenLog.includes("incompatible architecture") &&
			brokenLog.includes("startup exit code: 86") &&
			brokenLog.includes("actual sha256") &&
			brokenLog.includes("startup output: loader error"),
		"Startup failure did not retain useful diagnostics",
	);
	assert(
		!(await Bun.file(join(brokenHome, ".loom", "bin", "loom")).exists()),
		"Startup failure left a broken executable installed",
	);
	const existingHome = join(sandbox, "existing-home");
	const existingPath = join(existingHome, ".loom", "bin", "loom");
	await mkdir(join(existingHome, ".loom", "bin"), { recursive: true });
	await writeFile(existingPath, `#!/bin/sh\necho 'loom ${version}'\n`);
	await chmod(existingPath, 0o700);
	const silentFixture = "#!/bin/sh\nexit 86\n";
	await writeFile(join(fixtures, name), silentFixture);
	const silentManifest = {
		...manifest,
		artifacts: {
			[platform]: {
				url: `${base}/v${version}/${name}`,
				sha256: createHash("sha256").update(silentFixture).digest("hex"),
				size: silentFixture.length,
			},
		},
	};
	await writeFile(
		join(fixtures, "manifest.json"),
		`${JSON.stringify(silentManifest, null, 2)}\n`,
	);
	const silent = await invoke(existingHome, { LOOM_REINSTALL: "1" });
	const silentLog = `${silent.stdout}${silent.stderr}`;
	assert(
		silent.exitCode !== 0 &&
			silentLog.includes("startup exit code: 86") &&
			silentLog.includes("startup output: empty") &&
			silentLog.includes("existing installation was not replaced"),
		`Silent startup failure was not explained or replaced the prior binary:\n${silentLog}`,
	);
	assert(
		(await run([existingPath, "--version"], {}, root)).stdout.includes(version),
		"Startup failure replaced the prior executable",
	);
	const wrongVersion = `#!/bin/sh
echo 'loom 1.2.3'
`;
	await writeFile(join(fixtures, name), wrongVersion);
	await writeFile(
		join(fixtures, "manifest.json"),
		`${JSON.stringify(
			{
				...manifest,
				artifacts: {
					[platform]: {
						url: `${base}/v${version}/${name}`,
						sha256: createHash("sha256").update(wrongVersion).digest("hex"),
						size: wrongVersion.length,
					},
				},
			},
			null,
			2,
		)}\n`,
	);
	const unexpectedVersion = await invoke(existingHome, { LOOM_REINSTALL: "1" });
	assert(
		unexpectedVersion.exitCode !== 0 &&
			`${unexpectedVersion.stdout}${unexpectedVersion.stderr}`.includes(
				"instead of expected",
			),
		"A candidate reporting an unexpected version was activated",
	);
	assert(
		(await run([existingPath, "--version"], {}, root)).stdout.includes(version),
		"Unexpected-version candidate replaced the prior executable",
	);
	console.log(
		`PASS ${platform}: installer phases, diagnostics, manifest and fallback paths, PATH setup, repair/reinstall, checksum and startup failure rejection`,
	);
} finally {
	await rm(sandbox, { recursive: true, force: true });
}
