<script lang="ts">
	import { Play, RotateCcw } from "@lucide/svelte";

	type Tone = "phase" | "ok" | "warn" | "info" | "detail";
	type Line = { tone: Tone; text: string };

	// Mirrors the phases printed by install.sh and install.ps1 so a visitor can
	// read the exact install log before running anything on their device.
	const lines: Line[] = [
		{ tone: "phase", text: "[1/8] Checking your system" },
		{ tone: "ok", text: "Platform linux-x64 (x86_64, kernel 6.18.26)" },
		{ tone: "detail", text: "install target  ~/.loom/bin/loom" },
		{ tone: "detail", text: "data directory  ~/.loom" },
		{ tone: "detail", text: "release channel stable" },
		{ tone: "phase", text: "[2/8] Checking the tools this installer needs" },
		{ tone: "ok", text: "curl 8.14.0" },
		{ tone: "ok", text: "sha256sum found" },
		{
			tone: "phase",
			text: "[3/8] Checking what Loom needs after the binary is installed",
		},
		{
			tone: "ok",
			text: "git 2.54.0 — worktrees and task branches are ready",
		},
		{
			tone: "warn",
			text: "opencode not found — Loom runs chat and Kanban tasks through OpenCode",
		},
		{
			tone: "info",
			text: "Bun, Node.js and npm are not needed: the release bundles the Bun runtime with the UI.",
		},
		{
			tone: "phase",
			text: "[4/8] Resolving the latest release on the stable channel",
		},
		{
			tone: "detail",
			text: "GET .../releases/download/channel-stable/manifest.json",
		},
		{ tone: "ok", text: "Loom 0.1.0 for linux-x64 (48.2 MB)" },
		{ tone: "phase", text: "[5/8] Downloading the Loom binary" },
		{
			tone: "detail",
			text: "[###########.............]  42%  20.3 MB / 48.2 MB",
		},
		{
			tone: "detail",
			text: "[######################..] 100%  48.2 MB / 48.2 MB",
		},
		{ tone: "ok", text: "Downloaded 48.2 MB in 12s (4.0 MB/s)" },
		{ tone: "phase", text: "[6/8] Verifying the download" },
		{ tone: "detail", text: "expected sha256 4f2a9c1e8b7d0a53…" },
		{ tone: "detail", text: "actual   sha256 4f2a9c1e8b7d0a53…" },
		{ tone: "ok", text: "SHA-256 verified for 48.2 MB" },
		{ tone: "phase", text: "[7/8] Installing Loom" },
		{ tone: "ok", text: "Executable answers: loom 0.1.0" },
		{
			tone: "ok",
			text: "Installed to ~/.loom/bin/loom (mode 700, no administrator access used)",
		},
		{ tone: "phase", text: "[8/8] Adding Loom to your user PATH" },
		{ tone: "ok", text: "Wrote PATH entry to ~/.profile" },
		{ tone: "ok", text: "Loom 0.1.0 installed successfully in 21s." },
		{ tone: "detail", text: "next  restart your terminal, then run: loom" },
	];

	let open = $state(false);
	let shown = $state(lines.length);
	let reduced = $state(false);
	let timer: ReturnType<typeof setInterval> | undefined;

	function play() {
		clearInterval(timer);
		if (reduced) {
			shown = lines.length;
			return;
		}
		shown = 0;
		timer = setInterval(() => {
			shown += 1;
			if (shown >= lines.length) clearInterval(timer);
		}, 55);
	}

	$effect(() => {
		if (!open) return;
		reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		play();
	});
	$effect(() => () => clearInterval(timer));
</script>

<details
	class="install-log"
	ontoggle={(event) => (open = event.currentTarget.open)}
>
	<summary><Play size={12} /> Install log preview</summary>
	<ol class="install-log-lines" aria-label="Installer output">
		{#each lines as line, index}
			<li class={line.tone} class:pending={index >= shown}>
				<span class="gutter" aria-hidden="true">
					{line.tone === "phase"
						? ""
						: line.tone === "ok"
							? " ok "
							: line.tone === "warn"
								? "warn"
								: line.tone === "info"
									? "info"
									: "     "}
				</span>
				<code>{line.text}</code>
			</li>
		{/each}
	</ol>
	<div class="install-log-foot">
		<button type="button" class="log-replay" onclick={play}>
			<RotateCcw size={12} /> Replay
		</button>
		<p class="install-log-note">
			Nothing is built or cloned on your machine: the installer downloads one
			published binary, verifies its SHA-256, then writes it into
			<code>~/.loom</code>. Missing tools are reported, never installed for you.
		</p>
	</div>
</details>
