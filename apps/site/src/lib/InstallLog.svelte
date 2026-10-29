<script lang="ts">
	import { Play, RotateCcw } from "@lucide/svelte";

	type Tone = "phase" | "ok" | "warn" | "info" | "detail";
	type Line = { tone: Tone; text: string };

	// Mirrors the phases printed by install.sh and install.ps1 so a visitor can
	// read the exact install log before running anything on their device.
	const lines: Line[] = [
		{ tone: "phase", text: "[1/8] Checking your system" },
		{ tone: "ok", text: "Platform detected: macOS/Linux · x64/arm64" },
		{ tone: "detail", text: "install target  ~/.loom/bin/loom" },
		{ tone: "detail", text: "data directory  ~/.loom" },
		{ tone: "detail", text: "release channel stable" },
		{ tone: "phase", text: "[2/8] Checking the tools this installer needs" },
		{ tone: "ok", text: "curl or wget found" },
		{ tone: "ok", text: "sha256sum or shasum found" },
		{
			tone: "phase",
			text: "[3/8] Checking what Loom needs after the binary is installed",
		},
		{
			tone: "ok",
			text: "git found — worktrees and task branches are ready",
		},
		{
			tone: "ok",
			text: "OpenCode found — task runtime available",
		},
		{
			tone: "info",
			text: "This demo is illustrative; the real checks use your device's detected state.",
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
		{ tone: "ok", text: "Stable release · platform-specific binary" },
		{ tone: "phase", text: "[5/8] Downloading the Loom binary" },
		{
			tone: "detail",
			text: "[###########.............] Download progress is shown in your terminal",
		},
		{
			tone: "detail",
			text: "[######################..] Download completes before verification",
		},
		{ tone: "ok", text: "Binary downloaded to a temporary file" },
		{ tone: "phase", text: "[6/8] Verifying the download" },
		{ tone: "detail", text: "Comparing downloaded file to the signed-off release checksum" },
		{ tone: "ok", text: "SHA-256 verified before installation" },
		{ tone: "phase", text: "[7/8] Installing Loom" },
		{ tone: "ok", text: "Downloaded executable starts successfully" },
		{
			tone: "ok",
			text: "Installed to your user folder; no administrator access used",
		},
		{ tone: "phase", text: "[8/8] Adding Loom to your user PATH" },
		{ tone: "ok", text: "Added Loom to your shell PATH" },
		{ tone: "ok", text: "Loom installed successfully" },
		{ tone: "detail", text: "Next: restart your terminal, then run loom" },
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
