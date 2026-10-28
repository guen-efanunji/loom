<script lang="ts">
	import { Check, Copy, Download, Terminal } from "@lucide/svelte";
	import { onMount } from "svelte";
	import { installCommands, repository, sitePath } from "$lib/config";
	import InstallLog from "$lib/InstallLog.svelte";
	import { Button } from "$ui/button";
	import * as Tabs from "$ui/tabs";

	let os = $state("unix");
	let copied = $state(false);
	let error = $state("");
	const command = $derived(
		os === "windows" ? installCommands.windows : installCommands.unix,
	);
	onMount(() => {
		if (navigator.userAgent.includes("Windows")) os = "windows";
	});
	async function copy() {
		try {
			await navigator.clipboard.writeText(command);
			copied = true;
			setTimeout(() => (copied = false), 2000);
		} catch {
			error = "Select the command to copy it manually.";
		}
	}
</script>

<div class="install-command">
	<Tabs.Root bind:value={os}>
		<div class="install-top">
			<Tabs.List aria-label="Choose your operating system"
				><Tabs.Trigger value="unix">macOS / Linux</Tabs.Trigger><Tabs.Trigger
					value="windows">Windows</Tabs.Trigger
				></Tabs.List
			><span
				><Terminal size={13} />
				{os === "windows" ? "PowerShell" : "Terminal"}</span
			>
		</div>
		<div class="command-line">
			<code>{command}</code><Button
				variant="ghost"
				size="icon"
				onclick={copy}
				aria-label={copied ? "Command copied" : "Copy install command"}
				>{#if copied}<Check size={16} />{:else}<Copy size={16} />{/if}</Button
			>
		</div>
	</Tabs.Root>
	<div class="install-next-steps">
		<p class="copy-feedback" aria-live="polite">
			{error ||
				(copied
					? "Copied. Paste it into your terminal and watch the step-by-step install log."
					: "Run this in Terminal or PowerShell. The installer prints each step and download progress.")}
		</p>
		<a class="install-release-link" href={`${repository}/releases`}>
			<Download size={13} /> Direct downloads
		</a>
	</div>
	<InstallLog />
	<details class="install-requirements">
		<summary>What gets installed?</summary>
		<ol>
			<li>Detects your OS, CPU architecture and libc.</li>
			<li>
				Checks the tools Loom still needs after install: Git and OpenCode.
			</li>
			<li>
				Downloads the published release binary over HTTPS with a progress bar.
			</li>
			<li>
				Verifies SHA-256 before installing the bundled Bun-powered executable.
			</li>
			<li>Installs Loom to your user folder and adds it to PATH.</li>
		</ol>
		<p>
			Loom uses Bun as its JavaScript runtime; the release bundles Bun, so users
			do not need to install it separately. Install Git and OpenCode, then
			configure an OpenCode model provider to use the workspace. The
			command-line installer does not install a native desktop app; Loom opens
			its local browser workspace after you run <code>loom</code>.
		</p>
		<p>
			You can also install this website from your browser menu as a shortcut.
			That installs the public product site, not the local Loom workspace or
			daemon.
		</p>
		<p>
			<a href={sitePath("/docs/installation/")}
				>See platform requirements and troubleshooting.</a
			>
		</p>
	</details>
</div>
