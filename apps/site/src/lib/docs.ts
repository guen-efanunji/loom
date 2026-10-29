export type DocSection = {
	id: string;
	title: string;
	paragraphs: string[];
	code?: string;
	note?: string;
	links?: { label: string; href: string }[];
};
export type Doc = {
	slug: string;
	title: string;
	group: string;
	description: string;
	minutes: number;
	sections: DocSection[];
};
export const docs: Doc[] = [
	{
		slug: "installation",
		title: "Installation",
		group: "Start here",
		description: "Install a complete local workspace with one command.",
		minutes: 3,
		sections: [
			{
				id: "requirements",
				title: "What you need",
				paragraphs: [
					"Loom is built with Bun and uses Bun's JavaScript runtime. For the prebuilt release you do not need to install Bun separately: the executable bundles the Bun runtime with the Loom CLI and browser UI. Install Git and OpenCode, then configure a model provider in OpenCode for Loom's primary workspace and task workflow. Additional supported CLI providers can be connected for chat after installation. This is a local-first application: the executable and workspace data stay on your device; the website does not host your workspace or act as a remote Loom server.",
					"Release targets are macOS on Apple silicon and Intel, and Linux on x64 and arm64 with glibc; Alpine/musl is not published. Windows x64 is still being prepared, and its installer says so until a binary is published. The release CI executes every target binary before publication and checks the packaged daemon on native Linux and Intel macOS runners.",
				],
				links: [
					{ label: "Install Git", href: "https://git-scm.com/downloads" },
					{ label: "Set up OpenCode", href: "https://opencode.ai/docs/" },
				],
			},
			{
				id: "install",
				title: "Install Loom",
				paragraphs: [
					"Run the command above in Terminal on macOS/Linux, or PowerShell on Windows. The installer prints eight numbered phases, shows binary download progress, verifies SHA-256 (and size on Windows), checks that the executable starts, installs to your user folder, and updates your user PATH. It does not require administrator access.",
					"The installer needs a published GitHub release. If it reports that no release is available, check GitHub Releases. This installs the Loom CLI and local browser workspace, not a native desktop app; run loom after installing to start Loom on your device. The installer does not build from source and never clones the repository onto your machine.",
				],
				links: [
					{
						label: "Browse releases and checksums",
						href: "https://github.com/guen-efanunji/loom/releases",
					},
					{
						label: "Review the shell installer",
						href: "https://github.com/guen-efanunji/loom/blob/main/install.sh",
					},
					{
						label: "Review the PowerShell installer",
						href: "https://github.com/guen-efanunji/loom/blob/main/install.ps1",
					},
				],
			},
			{
				id: "log",
				title: "What the install log shows",
				paragraphs: [
					"Every run is a step-by-step log, so you can see what was detected, downloaded, verified and changed. The numbered phases are the same on macOS, Linux and Windows.",
					"Phases 1 to 3 report your platform, the tools the installer itself needs, and the tools Loom needs afterwards (Git and OpenCode). Missing tools are reported with an install hint and never installed for you, so nothing outside ~/.loom changes without your decision.",
					"Phases 4 to 6 resolve the published release, download the single binary for your platform with a progress bar, and compare its SHA-256 against the published manifest. A mismatch stops the run and nothing is installed.",
					"Phases 7 and 8 run the new binary once to prove it starts on your machine, move it into place, and add its folder to your PATH. The final line prints the elapsed time and the next commands to run.",
				],
				code: "[1/8] Checking your system\n[2/8] Checking the tools this installer needs\n[3/8] Checking what Loom needs after the binary is installed\n[4/8] Resolving the latest release on the stable channel\n[5/8] Downloading the Loom binary\n[6/8] Verifying the download\n[7/8] Installing Loom\n[8/8] Adding Loom to your user PATH",
				note: "Set LOOM_CHANNEL=beta to install a prerelease, or LOOM_HOME to choose another data directory. Both are printed in the log so you can see what a run used.",
			},
			{
				id: "open",
				title: "Open your workspace",
				paragraphs: [
					"Restart your terminal so it picks up the PATH change, then run Loom. It opens the local UI on 127.0.0.1:4317. The daemon continues running after the terminal command returns.",
				],
				code: "loom\nloom doctor",
				note: "If your browser does not open automatically, enter http://127.0.0.1:4317 in its address bar.",
			},
			{
				id: "location",
				title: "Where it lives",
				paragraphs: [
					"Loom installs to ~/.loom/bin/loom on macOS/Linux and $HOME\\.loom\\bin\\loom.exe on Windows. Its configuration, SQLite database, logs, cache, and managed worktrees stay under the same .loom directory.",
					"For a custom location, set LOOM_HOME to an absolute path before installing and keep that environment variable set whenever you run Loom. Updating an existing installation uses loom update, rather than rerunning the installer.",
				],
			},
		],
	},
	{
		slug: "getting-started",
		title: "Getting started",
		group: "Start here",
		description: "Go from a local repository to your first reviewed change.",
		minutes: 5,
		sections: [
			{
				id: "project",
				title: "1. Add a project",
				paragraphs: [
					"Start Loom, then add the absolute path to a local Git repository from the workspace sidebar. The repository needs at least one commit. Configure your Git author name and email so task branches can be committed.",
					"Choose a small, verifiable change for your first run. A documentation correction or a focused bug fix makes it easier to follow the complete workflow.",
				],
			},
			{
				id: "conversation",
				title: "2. Start with a conversation",
				paragraphs: [
					"Select your project and send a message. OpenCode is the default runtime; you can also choose a connected Claude Code, Codex CLI, or Antigravity CLI provider in chat. Type @ to find project files or choose a custom agent. A custom agent uses the provider and model configured for that agent.",
					"Sessions keep their own conversation history. Open tabs for separate threads, and use the split view to work with two chats side by side. The selected model, custom agent, and thinking mode apply to each message, so check the composer before sending if you changed them between turns.",
					"File changes, tool activity, and the response appear in the conversation. Context usage is shown when the provider returns token metadata; some providers do not report it.",
				],
			},
			{
				id: "plan",
				title: "3. Turn a goal into a plan",
				paragraphs: [
					"Create a plan for work that benefits from several tasks. Describe the goal and expected result. Review the proposed task titles, prompts, dependencies, and project commands.",
					"Edit the plan before starting. Only approve install, lint, test, and build commands you understand. They run for the task workflow and can access the machine with your user permissions.",
				],
			},
			{
				id: "review",
				title: "4. Review the result",
				paragraphs: [
					"Follow task states in the Kanban board and inspect their conversations. When tasks finish, open the integration review. Read the combined diff and check results, including any failed checks and repair attempts.",
					"Make the main project checkout clean before approving the merge. Approval applies to the exact reviewed commit. If the integration changes, review its new head again.",
				],
			},
		],
	},
	{
		slug: "opencode",
		title: "OpenCode setup",
		group: "Start here",
		description:
			"Set up Loom's primary runtime and understand the other chat providers.",
		minutes: 3,
		sections: [
			{
				id: "runtime",
				title: "Install and configure OpenCode",
				paragraphs: [
					"OpenCode is Loom's primary runtime for workspace chat and agent task execution. Install the OpenCode executable from its official documentation, launch it once, connect a model provider, and verify a simple prompt before starting a Loom task.",
					"Loom discovers opencode (opencode.exe on Windows) on PATH. If you use a custom executable location, set OPENCODE_BIN to its absolute path. Native Windows executable installs are recommended over .cmd wrappers.",
				],
				links: [
					{
						label: "OpenCode documentation",
						href: "https://opencode.ai/docs/",
					},
				],
			},
			{
				id: "server",
				title: "How Loom connects",
				paragraphs: [
					"Loom checks the OpenCode server at 127.0.0.1:4096. It reuses a healthy server or starts opencode serve bound to loopback. A server started by Loom is stopped with Loom; an existing external server remains yours to manage.",
					"Keep this port local. If another application is using it, resolve that conflict before starting Loom. Run loom doctor to check executable discovery.",
				],
				code: "opencode --version\nloom doctor",
			},
			{
				id: "providers",
				title: "Other chat providers",
				paragraphs: [
					"For chat, Loom can also use connected Claude Code, Codex CLI, and Antigravity CLI runtimes. Install and authenticate each CLI from its own provider settings. These options do not replace OpenCode for Loom's built-in task orchestration. Provider availability depends on the installed CLI, authentication state, and model catalog.",
					"Loom does not include model credits. Usage follows the terms and pricing of the provider selected for each message. Thinking controls and usage metadata vary by provider; token usage appears only when a provider reports it.",
				],
			},
		],
	},
	{
		slug: "project-safety",
		title: "Project safety",
		group: "Working with agents",
		description: "Understand the boundaries before you give an agent a task.",
		minutes: 3,
		sections: [
			{
				id: "boundaries",
				title: "A worktree isolates changes",
				paragraphs: [
					"Each task has a separate checkout and branch. That keeps concurrent edits out of your main working directory. It does not restrict the filesystem, network, or process permissions of commands run by an agent.",
					"Use repositories you trust. Review project scripts and instructions before starting work, especially in downloaded repositories.",
				],
			},
			{
				id: "permissions",
				title: "Review commands and permissions",
				paragraphs: [
					"Review the plan's validation commands before approval. Install commands can run dependency lifecycle scripts. Read runtime permission requests and grant only what the task needs.",
					"Avoid putting secrets in task prompts or artifact summaries. If a secret is accidentally sent to a provider, rotate it through that provider's credential management.",
				],
			},
			{
				id: "merge",
				title: "Keep merges deliberate",
				paragraphs: [
					"Before merging, inspect the diff and tests and keep the target checkout clean. Integration review checks the approved commit and base so stale approval cannot silently merge a changed result.",
					"Discard a worktree through Loom after reviewing its contents. Back up work you want to keep before deletion. Uninstalling Loom intentionally keeps your branches and worktrees.",
				],
			},
		],
	},
	{
		slug: "parallel-tasks",
		title: "Parallel tasks",
		group: "Working with agents",
		description:
			"Plan dependencies, follow progress, and bring branches together.",
		minutes: 4,
		sections: [
			{
				id: "plan",
				title: "Review the task graph",
				paragraphs: [
					"A plan contains a goal and a task plan. Each task has a stable key, a prompt, and dependency keys. Independent tasks can run together within the scheduler's concurrency limits; dependent tasks wait.",
					"A plan cannot contain duplicate keys, missing dependencies, or a cycle. Keep tasks focused and describe the contract a dependent task should receive.",
				],
			},
			{
				id: "board",
				title: "Manage the board",
				paragraphs: [
					"Use the Kanban board to follow queued, running, completed, failed, and review states. Open a task to inspect its output, session, worktree, and diff.",
					"If a dependency fails, its descendants remain blocked. Fix the cause and explicitly retry. A retry has its own run history; cancellation waits for the active process to release its capacity.",
				],
			},
		],
	},
	{
		slug: "worktrees",
		title: "Git worktrees",
		group: "Working with agents",
		description: "Know where task files live and how to recover them.",
		minutes: 3,
		sections: [
			{
				id: "location",
				title: "Find task files",
				paragraphs: [
					"Managed worktrees live under ~/.loom/worktrees, organized by project and task/run. Open the task details to find the exact path and branch.",
					"These are real Git worktrees. You can inspect a retained workspace using your editor and standard Git commands.",
				],
				code: "git worktree list\ngit -C /path/to/worktree status",
			},
			{
				id: "recovery",
				title: "After an interrupted run",
				paragraphs: [
					"On restart, Loom reconciles interrupted work and preserves workspaces for inspection. Check the task's error and history before retrying. Do not delete metadata files to force a running task back into a different state.",
					"Run loom doctor if a registered workspace is missing. Restore it from your backup or resolve the affected task in the UI.",
				],
			},
			{
				id: "cleanup",
				title: "Clean up deliberately",
				paragraphs: [
					"Use the task's discard action after reviewing its changes. Only remove branches manually when you understand which commits they contain. Git worktree prune removes stale administrative entries; it does not recover uncommitted files.",
					"Removing a project from the sidebar or uninstalling Loom should not be used as a substitute for reviewing and cleaning up task work.",
				],
			},
		],
	},
	{
		slug: "updates",
		title: "Updates & rollback",
		group: "Maintain your install",
		description:
			"Move between verified releases without replacing a running binary.",
		minutes: 4,
		sections: [
			{
				id: "check",
				title: "Check for a release",
				paragraphs: [
					"Loom checks its configured channel at startup and at most once every six hours. The request has a short timeout; network failures do not prevent startup. You can also check from the update control in the UI.",
					"Stable is the default. A beta can contain changes that have not reached stable. A newer stable release replaces an older beta; Loom does not silently downgrade your installation.",
				],
				code: "loom update\nloom update --channel beta",
			},
			{
				id: "install",
				title: "Update and restart",
				paragraphs: [
					"Finish active tasks and OpenCode chats first. Select Update & Restart in the UI or run loom update. The update checks the official manifest, downloads your platform artifact, and verifies both SHA-256 and size.",
					"A helper copied from the current trusted binary stops the daemon, preserves the previous executable and local database, replaces the executable, and checks the new daemon's health. No script from the release manifest is executed.",
				],
			},
			{
				id: "rollback",
				title: "If startup fails",
				paragraphs: [
					"The helper restores the previous binary and database snapshot if the new daemon fails its startup check. Read loom logs for the result. The update control also displays the last update result.",
					"A power loss can interrupt any filesystem operation. If Loom cannot start, inspect ~/.loom/bin/loom.previous (loom.exe.previous on Windows) and ~/.loom/cache/update.lock before removing anything. Retain that directory's database backup and ask for help through a GitHub issue with redacted logs.",
				],
				code: "loom logs\nloom doctor",
				links: [
					{
						label: "Report an update problem",
						href: "https://github.com/guen-efanunji/loom/issues",
					},
				],
			},
			{
				id: "settings",
				title: "Control update checks",
				paragraphs: [
					"The UI update settings let you choose stable/beta and disable automatic checks. These values are stored as releaseChannel and updateChecks in config.json. The explicit Check now and loom update commands still contact GitHub when requested.",
					"The application version and protocolVersion are separate. A packaged UI ships with its compatible daemon. Do not mix frontend assets from another release.",
				],
			},
		],
	},
	{
		slug: "uninstall",
		title: "Uninstall",
		group: "Maintain your install",
		description: "Remove Loom while keeping your project work safe.",
		minutes: 2,
		sections: [
			{
				id: "binary",
				title: "Remove the executable",
				paragraphs: [
					"First run loom uninstall to see what will be removed. Add --yes to confirm removal of the installed binary. Loom stops its daemon and keeps app state, logs, branches, and worktrees by default.",
				],
				code: "loom uninstall\nloom uninstall --yes",
			},
			{
				id: "logs",
				title: "Choose whether to keep logs",
				paragraphs: [
					"Add --logs if you also want local daemon logs removed. This does not remove task branches or the state database.",
				],
				code: "loom uninstall --yes --logs",
			},
			{
				id: "data",
				title: "Review retained data",
				paragraphs: [
					"The remaining ~/.loom directory includes config.json, state.db, cache, and worktrees. Review task changes and discard managed worktrees through Loom before manually deleting state. Deleting a worktree directory can permanently lose uncommitted edits.",
					"After removal, you may delete the Loom PATH line from your shell profile or the Loom bin directory from Windows User Path. The installer marks its shell line with a # Loom comment.",
				],
			},
		],
	},
	{
		slug: "troubleshooting",
		title: "Troubleshooting",
		group: "Maintain your install",
		description: "Find the failing layer before changing your workspace.",
		minutes: 4,
		sections: [
			{
				id: "doctor",
				title: "Start with the doctor",
				paragraphs: [
					"Run the doctor from your terminal. It reports platform support, Git/OpenCode discovery, directory permissions, SQLite health, daemon port availability, workspace paths, and update state. A free daemon port before the first start is expected.",
				],
				code: "loom doctor\nloom logs",
			},
			{
				id: "path",
				title: "“loom: command not found”",
				paragraphs: [
					'Restart the terminal after installation. On macOS/Linux, try ~/.loom/bin/loom --version directly. On Windows, try & "$HOME\\.loom\\bin\\loom.exe" --version. If this succeeds, check the PATH entry in your shell profile or User environment variables.',
					"If the installer cannot find a release, check GitHub Releases. Corporate proxies, offline networks, or a channel that has not yet been published can prevent installation.",
				],
			},
			{
				id: "startup",
				title: "The UI will not open",
				paragraphs: [
					"Open http://127.0.0.1:4317 manually. Check loom logs for an unavailable OpenCode executable, an occupied port, or an unreadable data directory. Restart with loom restart after fixing the reported problem.",
					"Do not expose the daemon through a public tunnel. Host and Origin checks intentionally reject requests from other sites. In development, configure CORS_ORIGIN to the Vite origin; release builds serve the UI from the daemon's own origin.",
				],
			},
			{
				id: "chat",
				title: "A chat or task is stuck",
				paragraphs: [
					"Check which provider and model are selected for the message. For an OpenCode chat or task, verify that OpenCode can answer the same simple prompt directly. For Claude Code, Codex CLI, or Antigravity CLI chat, check that provider's installation, authentication, and model availability. Also resolve any pending permission request in Loom.",
					"Inspect the task's last error and output before retrying. After a daemon interruption, a retained worktree is expected. Do not delete it until you have reviewed or saved its contents.",
				],
			},
			{
				id: "support",
				title: "Share a useful bug report",
				paragraphs: [
					"Include your OS/architecture, loom --version output, the command or UI action, and relevant log lines. Remove tokens, credentials, private paths, prompt content, and source code before publishing logs.",
				],
				links: [
					{
						label: "Open a GitHub issue",
						href: "https://github.com/guen-efanunji/loom/issues",
					},
				],
			},
		],
	},
	{
		slug: "privacy",
		title: "Privacy",
		group: "Trust & boundaries",
		description: "Understand what stays local and what goes over the network.",
		minutes: 3,
		sections: [
			{
				id: "local",
				title: "Local workspace data",
				paragraphs: [
					"Loom stores project references, task and plan state, artifact metadata, configuration, and logs on your machine under ~/.loom. Git repositories and worktrees remain local. This release does not include a Loom cloud account, repository upload, telemetry, or cloud sync.",
				],
			},
			{
				id: "providers",
				title: "Agent requests",
				paragraphs: [
					"Prompts, selected files, tool output, and other task context may be sent to the provider selected for that chat or task. Loom supports OpenCode and connected Claude Code, Codex CLI, and Antigravity CLI chat runtimes. Each provider's retention and data policies apply. Loom does not include model credits.",
					"Local orchestration does not mean local model inference. Choose a local model provider if your workflow requires it, and verify the configuration of the runtime you use.",
				],
			},
			{
				id: "updates",
				title: "Release requests",
				paragraphs: [
					"Automatic update checks contact GitHub for a release manifest. Installation and updates download binaries from GitHub. These services can see ordinary request metadata such as your IP address. Disable automatic checks in update settings if desired.",
					"This documentation site uses local fonts and no analytics or tracking scripts. GitHub links and installation commands connect to GitHub only when followed or executed.",
				],
			},
			{
				id: "retention",
				title: "Data you choose to remove",
				paragraphs: [
					"Uninstall keeps state and worktrees so you do not lose unfinished work. Review retained data before deleting it manually. Treat database files, artifact summaries, logs, and agent sessions as potentially sensitive.",
				],
			},
		],
	},
	{
		slug: "security",
		title: "Security",
		group: "Trust & boundaries",
		description: "The local trust model and the limits it is designed around.",
		minutes: 4,
		sections: [
			{
				id: "daemon",
				title: "Local daemon access",
				paragraphs: [
					"The daemon binds to 127.0.0.1. API calls require a bearer token stored in a private config file. Browser bootstrap is limited to the configured local Origin. Host validation reduces DNS rebinding exposure, and WebSocket access requires the daemon token.",
					"The UI device lock is a convenience privacy screen, not an independent authentication boundary. A process with access to your user account and config file can access Loom. Protect your operating-system account and do not share your daemon token.",
				],
			},
			{
				id: "agents",
				title: "Agent execution is trusted code",
				paragraphs: [
					"Git worktrees isolate repository changes, not process capabilities. Agents and approved project commands execute with your user privileges. Malicious repository instructions, package scripts, or model output can still attempt unsafe operations.",
					"Review plans and permission requests. Use OS containers or another restricted environment when the repository or its scripts are not trusted.",
				],
			},
			{
				id: "updater",
				title: "Release integrity",
				paragraphs: [
					"The updater accepts HTTPS artifacts only from the official repository's versioned GitHub releases. It validates manifest shape, file size, and SHA-256 before using an executable. Updates are applied by a copy of the current executable, and a failed health check triggers rollback.",
					"Checksums protect against corrupt or substituted downloads relative to the trusted manifest. They do not protect against a compromised maintainer or GitHub release account. Release workflow permissions and repository protection are part of the trust boundary.",
				],
			},
			{
				id: "report",
				title: "Report a vulnerability",
				paragraphs: [
					"Use the repository's private vulnerability reporting option when available. Do not put live credentials or exploitable private-system details in a public issue. See SECURITY.md in the repository for the reporting policy.",
				],
				links: [
					{
						label: "Repository security policy",
						href: "https://github.com/guen-efanunji/loom/blob/main/SECURITY.md",
					},
				],
			},
		],
	},
	{
		slug: "chat-and-providers",
		title: "Chat, agents & providers",
		group: "Working with agents",
		description:
			"Choose a runtime, manage conversation tabs, and understand context reporting.",
		minutes: 5,
		sections: [
			{
				id: "providers",
				title: "Choose a provider and model",
				paragraphs: [
					"OpenCode is Loom's primary runtime. The Providers settings page also detects and connects supported local chat CLIs: Claude Code, Codex CLI, and Antigravity CLI. Availability and model choices depend on the CLI installed on your machine and its authentication state.",
					"Choose a provider/model in the composer for a normal chat. A custom agent has its own provider and optional model configuration; selecting it routes that message to the agent's configured runtime. Check the composer before every send because a conversation can contain turns from different providers or agents.",
				],
			},
			{
				id: "custom-agents",
				title: "Use a custom agent",
				paragraphs: [
					"Create or manage custom agents from the Agents settings. Configure the agent's role, instructions, provider, optional model, and enabled skills. In chat, type @ and search by its name to select it. The chosen agent's instructions and enabled skills guide that message, and the configured provider runs it.",
					"Agent instructions do not grant additional operating-system isolation. Loom's permission policy controls supported actions, while the CLI still runs under your user account. Review requested commands and project changes.",
				],
			},
			{
				id: "tabs",
				title: "Keep separate chats in tabs",
				paragraphs: [
					"Use the plus button above the conversation to open another chat, then select a tab to switch sessions. Each tab represents its own conversation, so you can keep separate workstreams such as backend, frontend, or bug fixing. The split-view control can show two chats side by side.",
					"A tab remembers its session, but the composer choices are message-level controls. Confirm the selected model, thinking mode, and agent before sending when switching between workstreams.",
				],
			},
			{
				id: "references",
				title: "Mention files and inspect context",
				paragraphs: [
					"Type @ in the composer to search project files and folders or select an available custom agent. Choose a file result to attach it as context; choosing a folder references that path for the provider to inspect. The provider may still need permission to read or edit files.",
					"The context panel shows token usage when the selected provider includes usage metadata in its response. If it says that usage has not been reported, Loom has not received token counts for that turn; it does not estimate missing provider usage. Cost details are likewise provider-dependent. The Token Usage page currently summarizes chat responses; Kanban, reviews, Canvas, walkthroughs, and terminal activity do not yet have token telemetry.",
				],
			},
			{
				id: "workspace-panels",
				title: "Use the workspace panels",
				paragraphs: [
					"The right-side rail opens project files, context usage, changes, task activity, and the integrated terminal. The Changes panel compares files touched in the current chat. The task activity panel shows registered agents and task states. Collapse a panel when you want more room for the conversation.",
					"The integrated terminal opens in the selected project or worktree directory and runs with your operating-system user permissions. Commands typed there are your commands; they are not automatically sandboxed by Loom. A walkthrough can turn a snapshot of uncommitted text-file changes into a guided explanation; it uses a model and reports its coverage limits.",
				],
			},
			{
				id: "provider-maintenance",
				title: "Connect and update local providers",
				paragraphs: [
					"Open Settings → Providers to check whether a supported CLI is installed and authenticated. Select Connect to start its authentication flow; if the browser cannot launch it, use the command shown on that page in a terminal. OpenCode uses `opencode auth login`.",
					"Use Check now to compare installed CLI versions with their latest releases. Automatic checks can be turned off. When Loom supports the provider's update flow, use Update in Loom; otherwise copy and run the official update command shown beside that provider.",
				],
			},
		],
	},
	{
		slug: "context-mcp-skills",
		title: "Context, MCP & skills",
		group: "Working with agents",
		description:
			"Learn what Loom stores in Context Hub and what its native inventories do.",
		minutes: 5,
		sections: [
			{
				id: "context",
				title: "Manage workspace context",
				paragraphs: [
					"Context Hub is where you manage project-scoped knowledge, rules, skills, and approved memory. Use it for stable guidance that should be available across related work, and keep each entry focused and current. Review the context attached to a task before sending sensitive information to a model provider.",
					"Loom also discovers native skills in supported Claude, Codex, and OpenCode skill locations. Discovery is a read-only inventory: it does not run skill scripts or plugin hooks. Results can be partial when a source reaches the scan limit, and names or metadata may need review before a skill can be used by Loom.",
				],
			},
			{
				id: "mcp",
				title: "Understand the MCP inventory",
				paragraphs: [
					"The MCP settings inventory scans supported native configuration sources and lists server definitions, transport type, source, endpoint or executable, and safe header/environment variable names. Secret values are not shown.",
					"A discovered definition does not mean the server is running, connected, authorized, or available to an agent. The inventory is read-only: Loom does not launch local MCP processes or contact remote servers from this page. It does not yet manage connections, show tool catalogs, or make these definitions available as Loom tools. Native configuration remains owned by its source runtime.",
				],
			},
			{
				id: "skills",
				title: "Review discovered skills",
				paragraphs: [
					"Skill discovery identifies supported native skill roots for Claude, Codex, and OpenCode. It reports the source and metadata so you can review what is present. A scan-limit notice means the list may be incomplete; an invalid-name notice means the skill does not meet Loom's naming rules.",
					"Discovery is not execution or automatic installation. Review a skill's instructions and any scripts yourself before choosing to use it in an agent workflow.",
				],
			},
		],
	},
	{
		slug: "canvas-designs",
		title: "Canvas designs",
		group: "Working with agents",
		description:
			"Draft, refine, preview, and publish a visual reference for your project.",
		minutes: 4,
		sections: [
			{
				id: "create",
				title: "Create a design node",
				paragraphs: [
					"Open Canvas from a project's workspace view. Describe a specific screen or flow in the design chat; Loom can answer questions or create a design node. General discussion does not create a canvas unless you ask it to design a screen.",
					"Canvas nodes are previews saved with the project. The canvas can show several alternatives, so give each request a clear purpose and viewport when you compare ideas.",
				],
			},
			{
				id: "refine",
				title: "Refine and preview",
				paragraphs: [
					"Select a ready node to refine it, open a larger preview, regenerate it, or delete it. Use the canvas controls to pan, zoom, and fit the node layout. Desktop and mobile previews let you review the design at different viewport sizes.",
					"When refining, state what should change and what should stay. Loom may inspect project files to understand the existing framework and visual conventions; the activity and any permission requests appear in the design chat.",
				],
			},
			{
				id: "publish",
				title: "Publish a design into the project",
				paragraphs: [
					"Choose Publish on a ready node to write its generated HTML into the project and show the resulting path. Publishing changes project files; review the file and its diff like any other agent change. A Canvas preview by itself is not yet a project file.",
					"You can attach ready Canvas designs to a chat request. The design HTML is then supplied as the visual reference so an agent can implement the chosen design in the project's own framework.",
				],
			},
		],
	},
	{
		slug: "workspace-settings",
		title: "Workspace settings & automation",
		group: "Working with agents",
		description:
			"Configure planning behavior and understand the workspace-level controls.",
		minutes: 4,
		sections: [
			{
				id: "planning",
				title: "Choose planning automation",
				paragraphs: [
					"Workspace settings offer three planning modes: Review first keeps a validated plan for you to inspect; Create tasks turns the plan into tasks without starting them; Create and start also starts eligible tasks. The setting applies to plans in that workspace.",
					"Start with Review first while you learn how the planner proposes task boundaries, dependencies, and validation commands. Automatic task creation or execution can consume provider usage and run project commands under your user account.",
				],
			},
			{
				id: "diagnostics",
				title: "Code index and diagnostics",
				paragraphs: [
					"The code index helps Loom search and understand a project. Use Re-index after a large branch or repository change if search results look stale. Rebuilding the index reads project files; clearing the index is not currently available.",
					"Language-server diagnostics can be enabled or disabled per workspace. Auto-fix diagnostics can ask an agent to repair errors left in changed files after a turn; that follow-up may use provider credits and modify files, so review the result.",
				],
			},
			{
				id: "notifications",
				title: "Notifications and workspace identity",
				paragraphs: [
					"Workspace settings include the display name and linked local project path, plus desktop notifications for approvals, agent questions, failures, and completed work. Browser or operating-system notification permission may also be required.",
					"Changing the workspace path validates the new repository location. Deleting a workspace removes its Loom registration, not the local project folder. Review task worktrees separately before deleting them.",
				],
			},
		],
	},
];
