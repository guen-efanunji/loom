<script lang="ts">
import {
	ArrowRight,
	ArrowUpRight,
	Check,
	Command,
	GitBranch,
	Layers,
	MessageSquare,
	Pause,
	Play,
	ShieldCheck,
} from "@lucide/svelte";
import { repository, sitePath } from "$lib/config";
import InstallCommand from "$lib/InstallCommand.svelte";
import { Button } from "$ui/button";
import * as Tabs from "$ui/tabs";

let animate = $state(true);
let view = $state("workspace");
const screenshots = {
	workspace: {
		src: "workspace.png",
		label: "Your work, in one place",
		alt: "Loom workspace with project navigation and a task Kanban board",
		text: "Move from an idea to a working branch without losing track of the conversation.",
	},
	plan: {
		src: "plan.png",
		label: "A plan you can actually review",
		alt: "Loom plan editor showing tasks, dependencies, and project commands",
		text: "Edit the task breakdown, dependencies, and validation commands before any agent starts.",
	},
	review: {
		src: "review.png",
		label: "Inspect every change",
		alt: "Loom task page with run history and independent diff review",
		text: "Read each task's diff and run history. You decide what moves forward to integration.",
	},
};
const shot = $derived(screenshots[view as keyof typeof screenshots]);
const features = [
	{
		icon: GitBranch,
		title: "Room for every task.",
		text: "Each task works in its own Git worktree. Independent agents can make progress at the same time.",
		tag: "Isolated workspaces",
	},
	{
		icon: Layers,
		title: "The right order, built in.",
		text: "Plans make dependencies explicit. Dependent tasks wait for the work they need and receive its context.",
		tag: "Dependency-aware planning",
	},
	{
		icon: ShieldCheck,
		title: "Your branch. Your call.",
		text: "Loom brings task branches together, runs your checks, and presents a diff for approval before merging.",
		tag: "Integration & review",
	},
	{
		icon: MessageSquare,
		title: "Keep the conversation close.",
		text: "Read OpenCode responses, mention project files, and inspect edits alongside the task they belong to.",
		tag: "Connected to OpenCode",
	},
];
</script>
<svelte:head><title>Loom — A workspace for parallel coding agents</title><meta name="description" content="Plan work, run OpenCode agents in isolated Git worktrees, and review the result in one local workspace. Install Loom on macOS, Windows, and Linux."/><meta property="og:title" content="Loom — A clear desk for parallel agents"/><meta property="og:description" content="Plan together. Work in parallel. Review before it lands."/><meta property="og:type" content="website"/></svelte:head>
<main id="main">
  <section class="hero section-width">
    <div class="hero-copy"><p class="eyebrow"><span class="live-dot"></span> YOUR MACHINE. YOUR WORKSPACE.</p><h1>A clear desk for<br/><span>parallel agents.</span></h1><p class="hero-description">Give your ideas a plan. Let OpenCode agents work side by side. Bring it all together with a review you can trust.</p><div class="hero-actions"><Button href="#install" size="lg" class="primary-cta">Make room for your next idea <ArrowRight size={17}/></Button><a class="text-link" href={sitePath("/docs/")}>Take a look at the docs <ArrowUpRight size={15}/></a></div><p class="platform-note"><Command size={13}/> macOS <span>·</span> Windows <span>·</span> Linux <span class="note-divider">/</span> No JavaScript runtime required</p></div>
    <div class="hero-object" class:motion-paused={!animate}>
      <div class="object-glow"></div><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div>
      <div class="glass-stack" aria-hidden="true"><div class="stack-card card-back"><span class="mini-label">03 / INTEGRATE</span><div class="mini-row"><ShieldCheck size={20}/><span>Ready for your review</span><span class="small-check">✓</span></div><div class="check-pills"><span>✓ Build</span><span>✓ Tests</span></div></div><div class="stack-card card-middle"><span class="mini-label">02 / WORK IN PARALLEL</span><div class="mini-row"><GitBranch size={19}/><span>One workspace per task</span></div><div class="branch-lines"><i></i><i></i><i></i></div></div><div class="stack-card card-front"><div class="mini-row"><span class="plan-symbol"><Layers size={22}/></span><span class="mini-label">01 / MAKE A PLAN</span><span class="tiny-dot"></span></div><h3>A good idea.<br/>A shared direction.</h3><div class="mini-progress"><span></span></div><p>Independent tasks. Connected work.</p></div></div>
      <div class="object-caption"><span>From a plan to a reviewed change.</span><Button variant="ghost" size="icon-sm" onclick={() => animate = !animate} aria-label={animate ? "Pause decorative animation" : "Play decorative animation"}>{#if animate}<Pause size={13}/>{:else}<Play size={13}/>{/if}</Button></div>
    </div>
  </section>
  <div class="principles section-width"><p>Less window switching.<br/><strong>More of the work that matters.</strong></p><span><GitBranch size={17}/> Git worktrees</span><span><MessageSquare size={17}/> OpenCode sessions</span><span><ShieldCheck size={17}/> Human approval</span></div>
  <section id="inside" class="inside section-width"><div class="section-heading"><div><p class="eyebrow">A PLACE FOR THE WHOLE PROCESS</p><h2>Follow the work.<br/><span>Keep the context.</span></h2></div><p>Your plan, conversations, and changes belong together. Loom gives them a shared home.</p></div>
    <Tabs.Root bind:value={view}><Tabs.List class="screenshot-tabs" aria-label="Explore Loom screenshots"><Tabs.Trigger value="workspace">01 · Workspace</Tabs.Trigger><Tabs.Trigger value="plan">02 · Plan</Tabs.Trigger><Tabs.Trigger value="review">03 · Review</Tabs.Trigger></Tabs.List><div class="screenshot-stage"><div class="browser-frame"><div class="browser-bar"><div class="window-dots"><i></i><i></i><i></i></div><span>loom / {view}</span><span class="local-indicator"><span class="live-dot"></span> Local workspace</span></div><img src={sitePath(`/screenshots/${shot.src}`)} alt={shot.alt} width="1440" height="900" loading="lazy"/></div></div></Tabs.Root>
    <div class="screenshot-caption"><strong>{shot.label}</strong><p>{shot.text}</p><span>Captured in Loom</span></div>
  </section>
  <section id="features" class="features section-width"><div class="section-heading"><div><p class="eyebrow">BUILT FOR WORK THAT HAS MOVING PARTS</p><h2>Give the agents space.<br/><span>Keep yourself in control.</span></h2></div><a class="text-link" href={sitePath("/docs/parallel-tasks/")}>How parallel work works <ArrowUpRight size={16}/></a></div><div class="feature-grid">{#each features as feature}<article class="feature-card glass"><div class="feature-icon"><feature.icon size={22} strokeWidth={1.5}/></div><p class="feature-tag">{feature.tag}</p><h3>{feature.title}</h3><p>{feature.text}</p></article>{/each}</div></section>
  <section class="workflow section-width"><div><p class="eyebrow">ONE IDEA. THREE DELIBERATE STEPS.</p><h2>A little structure.<br/><span>A lot less juggling.</span></h2><p class="section-intro">Start with a repository and a goal. Stay as involved as the work requires.</p><Button href={sitePath("/docs/getting-started/")} variant="outline">Your first project <ArrowRight size={15}/></Button></div><ol class="workflow-steps"><li><span>01</span><div><h3>Make the plan yours.</h3><p>Create a plan. Review the proposed tasks, adjust dependencies, and approve the commands that will validate the result.</p></div></li><li><span>02</span><div><h3>Let independent work move.</h3><p>Agents work in isolated branches. Follow the Kanban board, read the chat, and respond when an agent needs permission.</p></div></li><li><span>03</span><div><h3>Bring it home, thoughtfully.</h3><p>Inspect the task changes and check results. Merge each task when you are happy with what you see.</p></div></li></ol></section>
  <section class="local-note section-width glass"><span class="local-icon"><ShieldCheck size={33} strokeWidth={1.3}/></span><div><p class="eyebrow">LOCAL BY DEFAULT</p><h3>Your repositories stay on your machine.</h3><p>Loom stores its workspace data locally. OpenCode sends the context needed for a task to your configured model provider. You choose that provider.</p></div><a class="text-link" href={sitePath("/docs/privacy/")}>Read the privacy details <ArrowUpRight size={15}/></a></section>
  <section id="install" class="install-section section-width"><div><p class="eyebrow">A SMALL START FOR YOUR NEXT BIG THING</p><h2>One command.<br/><span>Your own workspace.</span></h2><p>Install Loom, then open it with <code>loom</code>. Git and a configured OpenCode installation are the only prerequisites.</p><a class="text-link" href={sitePath("/docs/installation/")}>Full installation guide <ArrowUpRight size={16}/></a></div><div class="install-panel glass"><InstallCommand/><div class="install-foot"><span><Check size={13}/> Runtime included</span><span><Check size={13}/> Verified downloads</span></div><p class="release-note">Installers use published <a href={`${repository}/releases`}>GitHub Releases</a>. Availability and platform requirements are listed in the docs.</p></div></section>
  <section class="faq section-width"><div><p class="eyebrow">BEFORE YOU GET STARTED</p><h2>A few useful details.</h2></div><div>{#each [
    ["Do I need Node.js or Bun?", "No. The distributed Loom executable includes its runtime and web application. You will need Git and OpenCode available on your PATH, plus a model provider configured in OpenCode."],
    ["Can I use my existing repository?", "Yes. Add the path to a local Git repository with at least one commit. Loom creates separate worktrees for tasks. Keep your main checkout clean before approving a merge."],
    ["Does Loom choose my model?", "OpenCode manages your providers and model access. Loom connects your sessions to the workspace and lets you follow their work. Provider usage and charges follow your own provider configuration."],
    ["What happens when changes conflict?", "Integration happens in a separate workspace. A resolver can propose a fix, and checks run again. The combined diff still needs your approval before it reaches your project branch."],
  ] as [question, answer]}<details><summary>{question}<span>+</span></summary><p>{answer}</p></details>{/each}</div></section>
</main>
