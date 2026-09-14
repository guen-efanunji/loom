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
import { platformKey } from "../packages/distribution/src/index";

// Tests the one-line installers without touching the real system or network.
// Unix installers run end to end against fixture release files served by a fake
// curl. The Windows installer is syntax-checked with PowerShell when available
// and structurally asserted everywhere.
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
		"LOOM_CHANNEL",
		"LOOM_HOME",
	])
		assert(script.includes(required), `install.ps1 is missing: ${required}`);
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
	console.log("PASS windows-x64: installer syntax and safety guards verified");
	process.exit(0);
}

const [os, arch] = platform.split("-");
const name = `loom-${os}-${arch}`;
const sandbox = await mkdtemp(join(tmpdir(), "loom-installer-"));
try {
	assert(
		(await run(["sh", "-n", join(root, "install.sh")], {}, root)).exitCode ===
			0,
		"install.sh has syntax errors",
	);
	const fixtures = join(sandbox, "fixtures");
	await mkdir(fixtures, { recursive: true });
	const binaryFixture = `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "loom 9.9.9-test"; exit 0; fi\necho "loom 9.9.9-test"\n`;
	await writeFile(join(fixtures, "version.txt"), "9.9.9\n");
	await writeFile(join(fixtures, name), binaryFixture);
	const sha256 = createHash("sha256").update(binaryFixture).digest("hex");
	await writeFile(join(fixtures, "SHA256SUMS"), `${sha256}  ${name}\n`);
	const fakeBin = join(sandbox, "bin");
	await mkdir(fakeBin, { recursive: true });
	await writeFile(
		join(fakeBin, "curl"),
		`#!/bin/sh\nout=""; url=""\nprev=""\nfor arg in "$@"; do\n  if [ "$prev" = "-o" ]; then out="$arg"; prev=""; continue; fi\n  case "$arg" in -o) prev="-o";; -*) ;; *) url="$arg";; esac\ndone\ncase "$url" in *version.txt) cat "$FIXTURES/version.txt" > "$out";; *SHA256SUMS) cat "$FIXTURES/SHA256SUMS" > "$out";; *${name}) cat "$FIXTURES/${name}" > "$out";; *) echo "unexpected url $url" >&2; exit 22;; esac\n`,
	);
	await chmod(join(fakeBin, "curl"), 0o755);
	const home = join(sandbox, "home");
	await mkdir(home, { recursive: true });
	const env = {
		PATH: `${fakeBin}:/usr/bin:/bin`,
		HOME: home,
		SHELL: "/bin/bash",
		LOOM_CHANNEL: "stable",
		FIXTURES: fixtures,
	};
	const invoke = (extra: Record<string, string> = {}) =>
		run(["sh", join(root, "install.sh")], { ...env, ...extra }, root);
	const first = await invoke();
	assert(
		first.exitCode === 0,
		`Installer failed:\n${first.stdout}\n${first.stderr}`,
	);
	const installed = join(home, ".loom", "bin", "loom");
	assert(
		(await run([installed, "--version"], {}, root)).stdout.includes(
			"9.9.9-test",
		),
		"Installed binary does not run",
	);
	const profile = await readFile(join(home, ".profile"), "utf8");
	assert(
		profile.includes("# Loom") && profile.includes(".loom/bin"),
		"Shell profile was not updated",
	);
	const rerun = await invoke();
	assert(
		rerun.exitCode !== 0 &&
			`${rerun.stdout}${rerun.stderr}`.includes("already installed"),
		"Reinstall guard did not trigger",
	);
	await writeFile(join(fixtures, name), `${binaryFixture}tampered`);
	const tamperedHome = join(sandbox, "tampered-home");
	await mkdir(tamperedHome, { recursive: true });
	const tampered = await invoke({ HOME: tamperedHome });
	assert(
		tampered.exitCode !== 0 &&
			`${tampered.stdout}${tampered.stderr}`.includes("Checksum mismatch"),
		"Tampered download was accepted",
	);
	const badChannel = await invoke({
		LOOM_CHANNEL: "bogus",
		HOME: join(sandbox, "other-home"),
	});
	assert(badChannel.exitCode !== 0, "Invalid channel was accepted");
	console.log(
		`PASS ${platform}: installer syntax, install, PATH setup, reinstall guard, checksum rejection, channel validation`,
	);
} finally {
	await rm(sandbox, { recursive: true, force: true });
}
