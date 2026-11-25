# Changelog

## [0.6.0](https://github.com/guen-efanunji/loom/compare/v0.5.5...v0.6.0) (2026-11-25)


### Features

* **access:** add local unlock settings and preserve session links ([cb523df](https://github.com/guen-efanunji/loom/commit/cb523dffbb23276da31fb70c615d3d7a321aa075))
* add AI Elements component stubs (Reasoning, Message, ModelSelector, Tool, Terminal, Suggestion, Confirmation, Context, Sources, Plan, Task, Queue, StackTrace, Subagent, FileTree, InlineCitation, Checkpoint, ChainOfThought, Chat, TestResults) ([4168903](https://github.com/guen-efanunji/loom/commit/41689038a719ba1a6f92fadfd8524453973d5154))
* add DAG planner context and scheduler gates ([485d401](https://github.com/guen-efanunji/loom/commit/485d401ce4a49a5e3d5b0b3dd7e13a98fd7c7d60))
* add epic orchestration schema and protocol ([71930ca](https://github.com/guen-efanunji/loom/commit/71930ca6862fc1c40c723fe9dfdd156cf01cf976))
* add kanban task board and epic client API ([6700176](https://github.com/guen-efanunji/loom/commit/6700176e855fbb9a303e9ac346f07665aa8544e0))
* add local daemon api and event delivery ([99ad12d](https://github.com/guen-efanunji/loom/commit/99ad12d3042b9ae6d9a6c752365da89ac45b4c28))
* add loom web ui cli and implementation docs ([e0c7e87](https://github.com/guen-efanunji/loom/commit/e0c7e872e976b2f166aef5c6b06f88a8da71e14e))
* add opencode runtime and task orchestration ([c6bef38](https://github.com/guen-efanunji/loom/commit/c6bef386e235e2a3a8fb6f527036a36ec4be4e89))
* add parallel daemon recovery and task api ([f9f5844](https://github.com/guen-efanunji/loom/commit/f9f5844dd3baaf00e5267806b8ea8bac3f28410a))
* add parallel scheduler and bounded agent output ([039df2f](https://github.com/guen-efanunji/loom/commit/039df2f3eb662be9d2357587400c7a6015c8da55))
* add parallel task management ui ([4f3929d](https://github.com/guen-efanunji/loom/commit/4f3929d9f3c9a4b4e3d1abc0b527328c8dfcae04))
* add PromptInput AI element (shadcn-svelte) with dependencies ([10cf6d5](https://github.com/guen-efanunji/loom/commit/10cf6d568d54639c8a38b2f77c8a48f98fc590f7))
* add protocol persistence and worktree foundation ([64425dd](https://github.com/guen-efanunji/loom/commit/64425dd1d6c93e36ee0abe6f25c7fb44f53f3571))
* add Video Studio (Remotion + bang-motion) with preview, auto-detect, thumbnail, timeline markers ([2e68776](https://github.com/guen-efanunji/loom/commit/2e68776be1cf3711d0ce02dcc5f5f42144a4099e))
* **agent:** add support for surface-specific access and idempotent assignment runs ([577e09b](https://github.com/guen-efanunji/loom/commit/577e09bce20e8afe275beb076539693352baec4f))
* **agents:** add Agents panel with monitoring and task overview ([a914669](https://github.com/guen-efanunji/loom/commit/a91466942783bea0a4139de7151b26dfc08f69cc))
* **agents:** add custom agent management and chat integration ([5515e01](https://github.com/guen-efanunji/loom/commit/5515e016b1aaaf80af5aaef4812937ba99d97ee5))
* auto-grow prompt input textarea ([bb75fe2](https://github.com/guen-efanunji/loom/commit/bb75fe2ba03c186f40bf07e011c4ca67bebb317b))
* **automation:** chat plan/build modes, plan review UI, and board integration ([7c73cd4](https://github.com/guen-efanunji/loom/commit/7c73cd4fc77281b198da612e5bb785d7d1ea5d9f))
* **automation:** plan API endpoints and automation settings ([eded2bd](https://github.com/guen-efanunji/loom/commit/eded2bd487a4d1678149b6cc8a5e7ab1b8f66a8b))
* **automation:** plan lifecycle service with scheduler integration ([68d1d23](https://github.com/guen-efanunji/loom/commit/68d1d23350404ed9f81d993d9f59460d0c0a4b34))
* **automation:** plan persistence, schemas, and planner toolkit ([8e1800f](https://github.com/guen-efanunji/loom/commit/8e1800f89f927a4029ae4243ec7fba4d1dc103be))
* **chat:** add adaptive execution guidance and child session navigation ([3caee88](https://github.com/guen-efanunji/loom/commit/3caee88cc58cb2b926c06b6b73d044ec85fcfd0e))
* **chat:** add context compaction and budget management for chat sessions ([3c2d1b8](https://github.com/guen-efanunji/loom/commit/3c2d1b8740f99db0dda22022d542041db7bba13c))
* **chat:** add file mentions and model-aware message composer ([070d703](https://github.com/guen-efanunji/loom/commit/070d703e2291fb35458655794964f6e01cc9a844))
* **chat:** add isolated chat workspace support with private git worktrees ([dc14681](https://github.com/guen-efanunji/loom/commit/dc146816d81eb4175afd82a171bfc0270ca4f780))
* **chat:** add message supersede feature with UI event notifications ([5c902c8](https://github.com/guen-efanunji/loom/commit/5c902c88bb52964cb27d162a488fd7c7b0aa1889))
* **chat:** add multi-tab split chat workspace and pane components ([6f2a27a](https://github.com/guen-efanunji/loom/commit/6f2a27af026742fe5012f4c8f2d0b6962c322dc7))
* **chat:** add project-scoped OpenCode gateway and typed client ([ff461d2](https://github.com/guen-efanunji/loom/commit/ff461d227ed695719e3953fe17f72cdbb1f592c8))
* **chat:** add support for custom agent instructions and filter chat-enabled agents ([fa639f5](https://github.com/guen-efanunji/loom/commit/fa639f5ecda3686f3dc196dc06fc27ac6fb04ff3))
* **chat:** add support for file attachments in chat messages ([2213f79](https://github.com/guen-efanunji/loom/commit/2213f79e996d7718a4de05f0cede280df449076d))
* **chat:** add thinking mode and workspace file search ([b7cc64d](https://github.com/guen-efanunji/loom/commit/b7cc64d96489be5b205f939295f058946e3e9de1))
* **chat:** compact context and reference sessions ([4320c4c](https://github.com/guen-efanunji/loom/commit/4320c4c42b5fa9cfc571fb0759ee4c195ba27f07))
* **chat:** delete chat sessions ([47f3872](https://github.com/guen-efanunji/loom/commit/47f387276899b5c723cf1613078a91b731f0c8a8))
* **chat:** implement provider-aware chat with runtime management and model caching ([5b12e5b](https://github.com/guen-efanunji/loom/commit/5b12e5b8bceec21d410ea37e048dfc3f74e839c2))
* **chat:** persist and restore provider chat history across server restarts ([0ee7e78](https://github.com/guen-efanunji/loom/commit/0ee7e78d8de920d9473c24cbc6db7cffb0edb400))
* **chat:** proactive context compaction with native fallback and manual trigger ([8d33e6e](https://github.com/guen-efanunji/loom/commit/8d33e6e6f8e866d11be15f9bd5db19838d6a0b7d))
* **chat:** real-time streaming via gateway SSE + content-change events ([ddc7258](https://github.com/guen-efanunji/loom/commit/ddc7258b304cd2d0ecedc5f100e6d25d3e393842))
* **chat:** render sanitized markdown and tool activity ([c8d2023](https://github.com/guen-efanunji/loom/commit/c8d2023916792924d4eb1dfdcff78ff19db4b156))
* **chat:** sidebar lists isolated chats; first-message agent handoff; task view as chat ([985b8a2](https://github.com/guen-efanunji/loom/commit/985b8a23fa3ed36c0f216ca73e8dea73bac90892))
* **chat:** support interactive answers to agent questions ([50327d6](https://github.com/guen-efanunji/loom/commit/50327d6fdad72a428fe102b8bed784d517566b48))
* **cli:** add agy-hook for gating Loom tool runs via permission service ([28f6208](https://github.com/guen-efanunji/loom/commit/28f6208be95a305cd21085f2b06baf46b1f36403))
* **cli:** show update download progress ([aa4d7d8](https://github.com/guen-efanunji/loom/commit/aa4d7d8afad42531831646500b61299a1de384bc))
* **cli:** standalone daemon CLI with update, doctor, and uninstall ([9a5b9cc](https://github.com/guen-efanunji/loom/commit/9a5b9ccaca556b1c2a901d7f9817502df2a19ba2))
* **config:** add uiLockHash to daemon config and update config management ([5c902c8](https://github.com/guen-efanunji/loom/commit/5c902c88bb52964cb27d162a488fd7c7b0aa1889))
* **context:** add Context Hub for managing scoped knowledge and skills ([30e240c](https://github.com/guen-efanunji/loom/commit/30e240c6bc68dc06a4b8a206266377baa48a1f9d))
* **core:** add cost tracking to CLI runtime and assistant info ([9705804](https://github.com/guen-efanunji/loom/commit/970580449b5917eeb325a4be19253fe9de8fe2b1))
* **core:** add custom provider support with tool authorization and isolated worktrees ([8a3175c](https://github.com/guen-efanunji/loom/commit/8a3175c12212d0cee89cc4fe6ccb5806c531f9e6))
* **core:** normalize provider and connection IDs in provider manager ([a5f6c46](https://github.com/guen-efanunji/loom/commit/a5f6c46e23916237f6c021881f1281d022b3cee4))
* **design:** add permission decision handling in design service and UI ([f8b8cbe](https://github.com/guen-efanunji/loom/commit/f8b8cbe2eac8aa8205300a07e2fb2aff3127aa37))
* **design:** add support for embedding Canvas design nodes in chat messages ([748bca7](https://github.com/guen-efanunji/loom/commit/748bca7cf6fe01bffc0fecb6b34ab541410e5e0e))
* **design:** integrate chat-based design agent with live interaction ([6b7a552](https://github.com/guen-efanunji/loom/commit/6b7a552d5dd53b198e3f5c224dc98daefac50b7c))
* **design:** support multiple provider runtimes in DesignService ([2b91292](https://github.com/guen-efanunji/loom/commit/2b91292326ceb0e6374f6c78bbbb3829b0b9f134))
* **design:** support OpenCode design agent in models and UI ([88c9ef0](https://github.com/guen-efanunji/loom/commit/88c9ef046a03284ec0a1f514f8057fdbb79a15b7))
* disable send when selected model is missing ([78db8f4](https://github.com/guen-efanunji/loom/commit/78db8f42b7e343a955b6647335b2d6d92b628da9))
* **dist:** installer tests, update smoke test, and product site ([df5c63a](https://github.com/guen-efanunji/loom/commit/df5c63ab08c4806dce403bb5abcead1652dbafec))
* **dist:** local distribution pipeline, installers, and release workflows ([7698184](https://github.com/guen-efanunji/loom/commit/76981846e2c7ab8d570284fdc678407ac7bfb470))
* **distribution:** own the apex and www records the way Pages needs them ([10fa51c](https://github.com/guen-efanunji/loom/commit/10fa51c1996def6fb05d3550a2c6c81651016742))
* **distribution:** release macOS and Linux, defer Windows binaries ([4091865](https://github.com/guen-efanunji/loom/commit/4091865569c892ad928e06d0a216dabe1ae6ae03))
* **distribution:** serve installers from loomworkspace.bond with a step log ([628305f](https://github.com/guen-efanunji/loom/commit/628305f94da1bcb6b3457254e8be22171d7f1b11))
* **distribution:** use built-in SQLite and portable task workspaces ([928a4ba](https://github.com/guen-efanunji/loom/commit/928a4ba96a9aa2fa10ed2e89f72d478c06a2f835))
* expose epic planner and integration API ([2f5aa33](https://github.com/guen-efanunji/loom/commit/2f5aa3368faf1a2d04a613ef8fb1481c1f1b4adc))
* **git:** add AI-generated commit message and pull request support ([d005d3e](https://github.com/guen-efanunji/loom/commit/d005d3ec59d3f01bf06346ce6b3cbc282e053f13))
* **git:** add worktree support and branch switching for projects ([c42f5a6](https://github.com/guen-efanunji/loom/commit/c42f5a6623d580cf789c7b1d306d64000de6f930))
* implement orchestrator planner ([ec1aa8c](https://github.com/guen-efanunji/loom/commit/ec1aa8ce2dd0aff2a6c36d2692284eab32a56c4e))
* implement orchestrator planner ([90a94d8](https://github.com/guen-efanunji/loom/commit/90a94d816e2946c3580b1194df19e08d073b077e))
* improve automation planning for v0.5.5 ([ec9ef59](https://github.com/guen-efanunji/loom/commit/ec9ef590b7625890cfc00e50a8ccfd73ac4876c7))
* **kanban:** add automatic review and multi-task run support ([968bdae](https://github.com/guen-efanunji/loom/commit/968bdae27c4cf3e595600c1afeaa223a954e31bc))
* **kanban:** chat-driven tasks, reviews, and plan-to-board ([b64e22d](https://github.com/guen-efanunji/loom/commit/b64e22d66b4a3e5572e3968736f1278312c5df7d))
* **mcp:** add managed MCP connections with CRUD and live session support ([1f8df6b](https://github.com/guen-efanunji/loom/commit/1f8df6b4cdeaed0435d57d8ce2fa233c287c6e63))
* **mcp:** add MCP manager API and UI for server inventory ([e843f9d](https://github.com/guen-efanunji/loom/commit/e843f9df3c67c735970752c28a26f092d9b964fd))
* **observability:** log chat gateway failures and server revivals to daemon.log ([93db4b9](https://github.com/guen-efanunji/loom/commit/93db4b9a2a40e971ae7051050bc7fcda14631301))
* **plans:** delete plans, override planner model, warn on empty catalog ([8a96931](https://github.com/guen-efanunji/loom/commit/8a969314a75e5a748bb6f2a2cb81abb1b9cc40fb))
* **project:** add Git and pull request overview to projects page ([0530ebb](https://github.com/guen-efanunji/loom/commit/0530ebbfc26ba9f2c4b38661969bfea1d337e638))
* **projects:** add inline repository registration form ([acd83dc](https://github.com/guen-efanunji/loom/commit/acd83dc53c7c59b9a117af947d9b54d9557ebd95))
* **providers:** add new CLI-based provider adapters and enhance design prompt handling ([e6bd349](https://github.com/guen-efanunji/loom/commit/e6bd349af6f304bd973fdda80d90054e651b26f0))
* **providers:** add provider CLI update check and update functionality ([990c84a](https://github.com/guen-efanunji/loom/commit/990c84a0b9c575eb8bbaa7151f3e6d5d4f21d5ee))
* **providers:** add provider model caching and background refresh ([65c7dca](https://github.com/guen-efanunji/loom/commit/65c7dca26af67a9aa455798644d1ab266928d948))
* **providers:** integrate multi-CLI provider management and UI ([8cc65af](https://github.com/guen-efanunji/loom/commit/8cc65af961dfb8c22ed81f118f747ac25b74c99a))
* reflect missing model in send button tooltip ([5bce2f6](https://github.com/guen-efanunji/loom/commit/5bce2f60d622a3870625456fe46337f859b5eb44))
* render markdown in Reasoning AI element ([f302aab](https://github.com/guen-efanunji/loom/commit/f302aab8cc24532b90665509aa99bf17d018d32f))
* **runtime:** add token usage tracking in CLI adapter and chat runtime ([1a90cf5](https://github.com/guen-efanunji/loom/commit/1a90cf5a4f604cdc3982a216b85292d13f5ffde5))
* **server:** add API to list filesystem directories ([cc84512](https://github.com/guen-efanunji/loom/commit/cc84512acf78482582e4865715f28f9c098bb12e))
* **server:** add design canvas API with create, refine, retry, publish, and delete endpoints ([81536ad](https://github.com/guen-efanunji/loom/commit/81536ad3160295c1e52fc3cb09f56bd21b9c3ecd))
* **server:** enhance file diffs handling in chat session ([cc84512](https://github.com/guen-efanunji/loom/commit/cc84512acf78482582e4865715f28f9c098bb12e))
* **server:** local host and origin hardening with portable state directory ([332f43c](https://github.com/guen-efanunji/loom/commit/332f43c754808edb9cf38d6f506e11ea0f843473))
* **settings:** add mobile-friendly sticky header to settings sidebar ([997dbd5](https://github.com/guen-efanunji/loom/commit/997dbd5b4d36be95e407d1fb6675ff661a00ab18))
* **settings:** add project index rebuild feature ([e3470ab](https://github.com/guen-efanunji/loom/commit/e3470abe7b03ac92fddf926980b3b9b85a301918))
* **settings:** add sidebar component and update providers page ([86b8384](https://github.com/guen-efanunji/loom/commit/86b838487353111d92d4e235bbc76c0f0dd7d3eb))
* **settings:** add token usage page with detailed chat metadata insights ([cafede7](https://github.com/guen-efanunji/loom/commit/cafede713b6bf00353db7ac68c6e0e4151633227))
* **settings:** add workspace editing and management features ([ecee83b](https://github.com/guen-efanunji/loom/commit/ecee83b65060ad476cd9bd4ef80488a3a9e76d3c))
* **shadcn-svelte:** add skill definition, CLI reference, and customization docs ([efdeb90](https://github.com/guen-efanunji/loom/commit/efdeb90821b9e12ee6770d6ca52ae314559fa98d))
* show inline hint when selected model is missing ([bbdd67d](https://github.com/guen-efanunji/loom/commit/bbdd67d948d2421b31c3b1234c8b0d49b0c6f1c4))
* **site:** add dark mode toggle and update theming system ([d2cbdc7](https://github.com/guen-efanunji/loom/commit/d2cbdc713630ec06cfdb21f84b79bcce0bc1f3ba))
* **ssh:** open terminals in workspace tabs ([e1167ca](https://github.com/guen-efanunji/loom/commit/e1167ca1440817326a20ae86a7ec0340e049bf3a))
* support parallel run persistence and worktrees ([0d86db5](https://github.com/guen-efanunji/loom/commit/0d86db5e8143ec6f1733b3b7fbfcb59c4cd5600b))
* **task:** follow-up queue lets users steer running tasks ([2b9c181](https://github.com/guen-efanunji/loom/commit/2b9c1814316295fd900f1fbfa494cd46e0a92cfe))
* **tasks:** rename, delete, and reorder API with board positions ([c627107](https://github.com/guen-efanunji/loom/commit/c6271078255ff950264f7913a765851cb838c3e0))
* **terminal:** add terminal management service with WebSocket support ([e75053b](https://github.com/guen-efanunji/loom/commit/e75053b6492c416227f4fe8e32363d27c7ae608f))
* **terminal:** manage SSH connections and open terminals on them ([48911dc](https://github.com/guen-efanunji/loom/commit/48911dcf2ae4dcd2b49bfebf32b517206829b2ef))
* **ui-lock:** add server-side UI lock with password protection and session management ([5c902c8](https://github.com/guen-efanunji/loom/commit/5c902c88bb52964cb27d162a488fd7c7b0aa1889))
* **ui:** add shadcn primitives and chat rendering dependencies ([dd0b6d9](https://github.com/guen-efanunji/loom/commit/dd0b6d998861a6ab5fe11ab54341ab0774365ac4))
* **ui:** integrate paneforge resizable panes and add trace collapsible component ([11ab81d](https://github.com/guen-efanunji/loom/commit/11ab81d197eecdba9e62efb035b6d86beeac8105))
* use Reasoning AI element in Turn ([131b7a8](https://github.com/guen-efanunji/loom/commit/131b7a893bf7ec4cf35476cd58c5d21d2061def0))
* **walkthrough:** add project walkthrough generation and management ([f194fe1](https://github.com/guen-efanunji/loom/commit/f194fe1839b539467ec1b0e5e09699144d9929da))
* **web:** add directory navigation UI to AddProjectForm ([cc84512](https://github.com/guen-efanunji/loom/commit/cc84512acf78482582e4865715f28f9c098bb12e))
* **web:** add Shiki-highlighted code blocks ([2b5a2b8](https://github.com/guen-efanunji/loom/commit/2b5a2b8a7360c984cdf7213e21910603286311b2))
* **web:** implement project rename and delete dialogs in ProjectsPage ([cc84512](https://github.com/guen-efanunji/loom/commit/cc84512acf78482582e4865715f28f9c098bb12e))
* **web:** improve project session UI and task display ([cc84512](https://github.com/guen-efanunji/loom/commit/cc84512acf78482582e4865715f28f9c098bb12e))
* **web:** update notice, env-based server URL, and settings page ([1328095](https://github.com/guen-efanunji/loom/commit/13280958b87f0d03ee61757dcc5afff5176fecc6))
* **web:** workspace tabs, kanban board, progress view, and rich chat rendering ([a1cf6bf](https://github.com/guen-efanunji/loom/commit/a1cf6bf666d9e04a295e83878d36f867e511f377))
* **workspace:** add file and directory workspace preview and editing API ([cd621a5](https://github.com/guen-efanunji/loom/commit/cd621a52f1e7889908a9374d9bb2733e60ac18ea))
* **workspace:** integrate persistent chat sidebar and file diff review ([e3f450b](https://github.com/guen-efanunji/loom/commit/e3f450bcd15d8447fbb835f8b99d0b0539721a4c))


### Bug Fixes

* auto-detect providers/OpenCode on startup; retry OpenCode start; persist auto-check default ([7adba57](https://github.com/guen-efanunji/loom/commit/7adba577c263357cb163983569cce79f00cb6146))
* **automation:** preserve briefs, modes, and dependency execution ([98bc5a0](https://github.com/guen-efanunji/loom/commit/98bc5a078be5fee323151e65961783e8b873f674))
* **automation:** support legacy planner schemas in test and runtime ([1496a33](https://github.com/guen-efanunji/loom/commit/1496a33004126c22c5b92927b4ab6d55e029c2c2))
* **chat,providers:** terminal quota errors, per-model context, codex repo check ([74fc135](https://github.com/guen-efanunji/loom/commit/74fc135b2a186f5fd0c3a26476d9d9d7dd772b2b))
* **chat,web:** await provider discovery on send; unblock providers page after restart ([9ef9ffd](https://github.com/guen-efanunji/loom/commit/9ef9ffd5e6bc3a5f1487d28c1c23ebaa2ae6c389))
* **chat,web:** clean user bubbles and live provider list ([49ea64c](https://github.com/guen-efanunji/loom/commit/49ea64c75ee3a8ed32a6a736fa81be8b729a2e7b))
* **chat:** custom-agent bubbles, cross-provider memory, model override, tab persistence ([e1ff4cc](https://github.com/guen-efanunji/loom/commit/e1ff4cc0c58371036eb732298e15de57218af11b))
* **chat:** cut title derivation at injected-context markers ([fd7537e](https://github.com/guen-efanunji/loom/commit/fd7537ea661247882db597d35ddeb91e43dc164e))
* **chat:** degrade gracefully when the OpenCode gateway is down ([1b24e15](https://github.com/guen-efanunji/loom/commit/1b24e1580e50aabbd6b596dedb426d2c4b1b161d))
* **chat:** gate the stale-busy downgrade on legacy gateways only ([26627ff](https://github.com/guen-efanunji/loom/commit/26627ff6d9640e9c0b3f25e361a25a7c739a74c4))
* **chat:** hide carried-transcript header so optimistic bubble clears ([e0d7c0a](https://github.com/guen-efanunji/loom/commit/e0d7c0a6a8094a2adc63255e5554bf71771dd128))
* **chat:** hold the turn action bar until the run really ends ([3f3f9f2](https://github.com/guen-efanunji/loom/commit/3f3f9f2c1d1d1ccede44286b708b445d55c763b3))
* **chat:** normalize literal backslash-n when deriving titles ([f2ce5f8](https://github.com/guen-efanunji/loom/commit/f2ce5f8ce7d1726c41100e75bdc6db9089c88957))
* **chat:** persist session→project ownership so lists scope correctly ([8cc801f](https://github.com/guen-efanunji/loom/commit/8cc801f7376a1af845f11596dfe5a0f7d6e76972))
* **chat:** pin session run directory via location + relocate legacy sessions ([65ec0ce](https://github.com/guen-efanunji/loom/commit/65ec0ce70233d0cb25fd7f0f32cf9c6020edfc0a))
* **chat:** queue follow-ups in split chat ([ea6efef](https://github.com/guen-efanunji/loom/commit/ea6efefc24ce2c96197356572676e1bd1821f13f))
* **chat:** refresh run snapshots near-live while busy ([88b60d2](https://github.com/guen-efanunji/loom/commit/88b60d2b122ec65b8263a8c5a16073e060a5216b))
* **chat:** repair also triggers for diffstat/git-log fragment titles ([5f56589](https://github.com/guen-efanunji/loom/commit/5f5658950c3a47b3b4dcb818a37ed9f5c538e4cd))
* **chat:** restore per-project scoping of session lists + client dedupe ([3f0a97c](https://github.com/guen-efanunji/loom/commit/3f0a97c74350e1a33131edbbcd9245dc92c30729))
* **chat:** resume conversations after model quota errors ([f4cff9c](https://github.com/guen-efanunji/loom/commit/f4cff9c1e985b01c209e801692be6ef2abeed35d))
* **chat:** session titles no longer copy injected scaffolding prefixes ([697f582](https://github.com/guen-efanunji/loom/commit/697f58220c4a825c74120d9503fb77c487b92a8a))
* **chat:** session working directory comes from Loom records, not the gateway ([e0f58c9](https://github.com/guen-efanunji/loom/commit/e0f58c9c28f30c95658b70c6f0747feb6629f01f))
* **chat:** skip git diff/log fragments when deriving titles ([e0a3933](https://github.com/guen-efanunji/loom/commit/e0a3933f1e2c5837475c6b7051e7f8449c1ffb0e))
* **chat:** skip tool-status fragments when deriving titles ([80e96b7](https://github.com/guen-efanunji/loom/commit/80e96b752e632a591b2d6e9fa11f2cb033e183ed))
* **chat:** title derivation skips whole scaffolding lines, not just prefixes ([a04b335](https://github.com/guen-efanunji/loom/commit/a04b3350fbbe4a560d306956548219ac629bb79f))
* **chat:** title repair also fires for boilerplate/residue titles ([e2fedc2](https://github.com/guen-efanunji/loom/commit/e2fedc2e0d5d03f31b1de66f0f6a85e5b7d18568))
* **chat:** tolerate object-shaped tool errors and stale-busy spinner ([d7516af](https://github.com/guen-efanunji/loom/commit/d7516afaf7f3697f40f69b451bfacb1d0bbaffa5))
* **ci:** give the release build the daemon URL Varlock requires ([c1efa9e](https://github.com/guen-efanunji/loom/commit/c1efa9e187427e1f62097fd898b6af2af205a3dc))
* connect Loom to current OpenCode API ([765f6d8](https://github.com/guen-efanunji/loom/commit/765f6d8b67cea933c1f857f613382bb8b7e3dad5))
* **db:** reopen a migrated WAL database without a readonly handle ([47cac0f](https://github.com/guen-efanunji/loom/commit/47cac0f852d417adbfc5c6ba162bfa811a2b6c6a))
* **distribution:** bound installer downloads by stall, not by total time ([0cd3de0](https://github.com/guen-efanunji/loom/commit/0cd3de06ef6c4c9e5818d8a340e63eac4da80e5d))
* **distribution:** bundle prompts so the release binary can start ([6f626c3](https://github.com/guen-efanunji/loom/commit/6f626c3810b3435bedf7d015fb67f537ee66fa8d))
* **distribution:** let slow links finish an update ([9d0600a](https://github.com/guen-efanunji/loom/commit/9d0600aaff3686a5e637aaede9cd6fa066e3b29a))
* **distribution:** let the domain setup prove access through Pages ([3885155](https://github.com/guen-efanunji/loom/commit/3885155deedac7df8cb1518be5bb99561e48c456))
* **distribution:** point the release repository at guen-efanunji/loom ([ed884be](https://github.com/guen-efanunji/loom/commit/ed884be7361a76b4f54b9e72a51c710018bd9970))
* harden chat lifecycle and workspace isolation ([0ca7dde](https://github.com/guen-efanunji/loom/commit/0ca7dde8db7acc4ac9dcef023ddc533cdab4021d))
* **installer:** harden macOS startup validation ([def0710](https://github.com/guen-efanunji/loom/commit/def07105f16b1df155350b0598f64b95765ae3ee))
* map image capability from OpenCode model catalog ([d1bffd9](https://github.com/guen-efanunji/loom/commit/d1bffd932795a53eebe4e989417834e5e2632f2d))
* **opencode:** adapt to OpenCode 2.2.5 prompt/status/message APIs ([8ef907c](https://github.com/guen-efanunji/loom/commit/8ef907c739ff5410780f814765d01d28cb52936d))
* **opencode:** authenticate requests to secured server ([48e4a16](https://github.com/guen-efanunji/loom/commit/48e4a16c670eae00ffc152cf68a601f01de3d53f))
* **opencode:** avoid legacy fallback on scoped status errors ([7e81ae7](https://github.com/guen-efanunji/loom/commit/7e81ae751b72c31bb4fb29e7d41c71254fe58005))
* **opencode:** fail unavailable control requests quickly ([dfb7b3f](https://github.com/guen-efanunji/loom/commit/dfb7b3f5f40c50ff1c05f508aa7f355ba1231f94))
* **opencode:** handle upstream providers and abort 404s ([4534cbe](https://github.com/guen-efanunji/loom/commit/4534cbe4d05ce05ccdef133a69d31e44acbcd7c9))
* **opencode:** preserve modern gateway on model selection errors ([9066a21](https://github.com/guen-efanunji/loom/commit/9066a21c8756a0fb1a37cc9f42a559e259f8b4c3))
* **opencode:** route chat through modern prompt API ([09e02f7](https://github.com/guen-efanunji/loom/commit/09e02f79aba1919ef6899bc2b938e9fa8624d3b5))
* **opencode:** self-heal unreachable gateway and stop aborting slow requests ([13070a3](https://github.com/guen-efanunji/loom/commit/13070a38d5234e3219627cc3844fe6262636fd2d))
* **opencode:** send auth headers after service discovery ([00ad0ff](https://github.com/guen-efanunji/loom/commit/00ad0ff867e902c3647fa9add66063b88152f8c3))
* **opencode:** send prompt files with top-level uri for 2.2 ([057b249](https://github.com/guen-efanunji/loom/commit/057b249cd03821159d29363b995fa131d49174f2))
* **opencode:** unwrap 2.2+ data envelopes and guard list endpoints ([cf1079f](https://github.com/guen-efanunji/loom/commit/cf1079f3c11519eb3c81af1e9180808f151a1103))
* **opencode:** use documented session status and message endpoints ([3856bbf](https://github.com/guen-efanunji/loom/commit/3856bbf78c51afdd11250a73f50b2ce93170dd7b))
* **providers:** deliver chat image attachments to CLI backends via disk references ([ac8035a](https://github.com/guen-efanunji/loom/commit/ac8035a5b7713b7acf247c267153685044476cec))
* **providers:** improve model listing and connection handling ([c265b11](https://github.com/guen-efanunji/loom/commit/c265b11330362c4b9f599e508dc62f8b4803716c))
* **providers:** improve model listing and filtering logic ([76c783e](https://github.com/guen-efanunji/loom/commit/76c783e8edbdf883031f71bee3d2430f12db2f6c))
* **providers:** persist update checks and detect CLI releases ([8ada082](https://github.com/guen-efanunji/loom/commit/8ada082ba4654e64868a8afb6b93c72cc4714d52))
* **release:** anchor the channel pointer to a commit, not a tag ([6781be8](https://github.com/guen-efanunji/loom/commit/6781be8d00ea543795146212c378f71b0b9867ca))
* **release:** validate native macOS arm64 binary ([5204600](https://github.com/guen-efanunji/loom/commit/5204600fb0050db654211b8498df87c5531db1e1))
* **server:** allow local Vite origins by default ([ff1ac97](https://github.com/guen-efanunji/loom/commit/ff1ac97be3b49ffb2eb72c0b2b4910d97ff7b96d))
* **server:** bind API before OpenCode startup ([8d94661](https://github.com/guen-efanunji/loom/commit/8d946615a0ca0638e72c417cb1502ac772c72b9c))
* **server:** keep daemon available when OpenCode is unavailable ([02bebff](https://github.com/guen-efanunji/loom/commit/02bebff92928a4edcb8a150c30b696912e56b712))
* **server:** map terminal task follow-up rejection to 409 ([44f3a69](https://github.com/guen-efanunji/loom/commit/44f3a6938b141bb77eb506b7f3719aab976258dd))
* **server:** report the settled review when auto-merge won the race ([fa8e00e](https://github.com/guen-efanunji/loom/commit/fa8e00e4828a18dc621cf1415e51a45884f0adf2))
* **server:** start the daemon explicitly during development ([1842be6](https://github.com/guen-efanunji/loom/commit/1842be6939cf7dc62f5573f37d2e92f88f5b7ff9))
* stabilize automatic Kanban release test ([7545d7e](https://github.com/guen-efanunji/loom/commit/7545d7e68121e9e3f88c57a15f5c8a40a2f114c8))
* stop Video Studio auto-detect toast loop ([1c68f46](https://github.com/guen-efanunji/loom/commit/1c68f46e3989d48b60a0d7df51ea8b4fcae1b285))
* **tasks:** enqueue runs asynchronously and expose persisted output ([48618c0](https://github.com/guen-efanunji/loom/commit/48618c0167bc39def992ce8f578367e20547d9e7))
* **terminal:** ensure proper xterm attachment after render ([711a865](https://github.com/guen-efanunji/loom/commit/711a8657027defc502f8a14b74e0e8c5ec7f4019))
* Video Studio seed error, in-app previews, shadcn selects, model loading, thumbnail robustness; add e2e test + screenshot ([56589e5](https://github.com/guen-efanunji/loom/commit/56589e5be42c94b92de6168e9abd36ce89996b06))
* warn when selected model is missing from catalog before send ([6405f12](https://github.com/guen-efanunji/loom/commit/6405f124eafd3c8354ba8f7fe0eec54393737716))
* **web/e2e:** harden task run data guards and update stale e2e specs ([720d94a](https://github.com/guen-efanunji/loom/commit/720d94acfd52d1c9493cc3571c65be40848e95a1))
* **web:** resolve daemon connections through public server settings ([954bd69](https://github.com/guen-efanunji/loom/commit/954bd69796402254ee10280ec36a1a6fc4da2db7))
* **web:** restore plans and save edits before approval ([fbb2583](https://github.com/guen-efanunji/loom/commit/fbb258387a319bf871d6400544388deedd63302b))
* **web:** restore provider-friendly busy status and align adaptive-chat e2e with current UI ([cd209f9](https://github.com/guen-efanunji/loom/commit/cd209f9f744b38561e3a2955a90bbc63c9f410ee))
* **web:** use SvelteKit navigation state updates ([c138f1d](https://github.com/guen-efanunji/loom/commit/c138f1d33bac94d241e0361d1ac30db09b478a3f))
* **workspaces:** guard lifecycle and route busy chats to isolation ([f119bc9](https://github.com/guen-efanunji/loom/commit/f119bc9f2bcb84656f44bd9f6326e83cbb2214d4))
* **worktree:** accept either path spelling when proving workspace ownership ([b37a78f](https://github.com/guen-efanunji/loom/commit/b37a78fa90034563118bc92b750f7a6000dc6389))
* **worktree:** compare workspace paths by identity, not spelling ([065d9a3](https://github.com/guen-efanunji/loom/commit/065d9a3d1faf5783ab2f6cfa05fc9f25dfea2ca5))
* **worktree:** support repositories without an initial commit ([6c66877](https://github.com/guen-efanunji/loom/commit/6c668778f380771a9721b1e4e2fe2a11332b3b79))


### Performance Improvements

* **chat:** make streaming updates feel live ([5dd6902](https://github.com/guen-efanunji/loom/commit/5dd6902cf30cbf372a1f47f4ab68a3afa91644cf))
* **web:** add lazy loading and scroll area to code and patch views ([cc84512](https://github.com/guen-efanunji/loom/commit/cc84512acf78482582e4865715f28f9c098bb12e))

## [0.3.7](https://github.com/guen-efanunji/loom/compare/v0.3.6...v0.3.7) (2026-11-08)


### Bug Fixes

* **opencode:** avoid legacy fallback on scoped status errors ([7e81ae7](https://github.com/guen-efanunji/loom/commit/7e81ae751b72c31bb4fb29e7d41c71254fe58005))

## [0.3.6](https://github.com/guen-efanunji/loom/compare/v0.3.5...v0.3.6) (2026-11-08)


### Bug Fixes

* **opencode:** preserve modern gateway on model selection errors ([9066a21](https://github.com/guen-efanunji/loom/commit/9066a21c8756a0fb1a37cc9f42a559e259f8b4c3))

## [0.3.5](https://github.com/guen-efanunji/loom/compare/v0.3.4...v0.3.5) (2026-11-08)


### Bug Fixes

* **opencode:** adapt to OpenCode 2.2.5 prompt/status/message APIs ([8ef907c](https://github.com/guen-efanunji/loom/commit/8ef907c739ff5410780f814765d01d28cb52936d))
* **opencode:** send auth headers after service discovery ([00ad0ff](https://github.com/guen-efanunji/loom/commit/00ad0ff867e902c3647fa9add66063b88152f8c3))

## [0.3.4](https://github.com/guen-efanunji/loom/compare/v0.3.3...v0.3.4) (2026-11-06)


### Bug Fixes

* **opencode:** unwrap 2.2+ data envelopes and guard list endpoints ([cf1079f](https://github.com/guen-efanunji/loom/commit/cf1079f3c11519eb3c81af1e9180808f151a1103))

## [0.3.3](https://github.com/guen-efanunji/loom/compare/v0.3.2...v0.3.3) (2026-11-06)


### Bug Fixes

* connect Loom to current OpenCode API ([765f6d8](https://github.com/guen-efanunji/loom/commit/765f6d8b67cea933c1f857f613382bb8b7e3dad5))
* stabilize automatic Kanban release test ([7545d7e](https://github.com/guen-efanunji/loom/commit/7545d7e68121e9e3f88c57a15f5c8a40a2f114c8))

## [0.3.2](https://github.com/guen-efanunji/loom/compare/v0.3.1...v0.3.2) (2026-11-05)


### Bug Fixes

* **providers:** persist update checks and detect CLI releases ([8ada082](https://github.com/guen-efanunji/loom/commit/8ada082ba4654e64868a8afb6b93c72cc4714d52))

## [0.3.0](https://github.com/guen-efanunji/loom/compare/v0.2.0...v0.3.0) (2026-11-04)


### Features

* **chat:** compact context and reference sessions ([4320c4c](https://github.com/guen-efanunji/loom/commit/4320c4c42b5fa9cfc571fb0759ee4c195ba27f07))
* **ssh:** open terminals in workspace tabs ([e1167ca](https://github.com/guen-efanunji/loom/commit/e1167ca1440817326a20ae86a7ec0340e049bf3a))

## [0.2.0](https://github.com/guen-efanunji/loom/compare/v0.1.3...v0.2.0) (2026-11-03)


### Features

* **cli:** show update download progress ([aa4d7d8](https://github.com/guen-efanunji/loom/commit/aa4d7d8afad42531831646500b61299a1de384bc))


### Bug Fixes

* **chat:** resume conversations after model quota errors ([f4cff9c](https://github.com/guen-efanunji/loom/commit/f4cff9c1e985b01c209e801692be6ef2abeed35d))
* **installer:** harden macOS startup validation ([def0710](https://github.com/guen-efanunji/loom/commit/def07105f16b1df155350b0598f64b95765ae3ee))
