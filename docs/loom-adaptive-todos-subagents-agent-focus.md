# Loom — Adaptive Todos, Subagents and Agent Focus

Revision: consolidated implementation specification with implementation-agent prompt and built-in runtime policy.
Status: partially implemented in the chat UI/runtime prompt layer; durable todo ownership and subagent execution remain unimplemented and are not represented as supported.

## Implementation status (2026-10-20)

Implemented in this checkout:
- Added adaptive execution guidance to the existing provider prompt path for OpenCode, built-in CLI providers and dynamically registered custom CLI providers. This is guidance only; it does not expose missing runtime capabilities or enforce opaque provider behavior.
- Chat turns render a compact todo snapshot only when a real provider tool event contains structured todo data. The snapshot is explicitly labelled as runtime-reported and is not treated as durable Loom state.
- Added same-project direct child-session discovery and chat navigation. The UI refreshes child status while a chat is active and provides a parent return action; it does not launch children or claim task focus changes execution ownership.
- Added an explicit **Create plan** action on completed chat responses. It calls the existing plan service in plan mode and sends the user to the existing review flow; it does not auto-create Kanban tasks or start work.
- Added provider prompt and server-route regression tests. The child-list endpoint checks project directory, parent relationship and archived state.

Still required before this specification is fully done:
- Durable, versioned todo records/events, source provenance, evidence and reload/reconnect reconciliation.
- Runtime capability discovery and an authorized bounded read-only delegation interface. Current AgentRuntime has no such dispatch contract, so subagent execution is intentionally unavailable.
- Child result artifacts, cancellation ownership, depth/concurrency/time/cost limits, crash recovery and explicit child reply behavior.
- Native provider/runtime smoke verification and UI accessibility/manual visual checks.

The acceptance checklist below remains open for these deferred requirements. Passing the targeted tests does not imply full specification completion.

## 1. Purpose and audit boundary

Enable adaptive chat execution: direct answers for simple requests, structured live todos for multi-step work, bounded subagent delegation when useful, parent/child inspection, and explicit conversion of substantial work into existing Kanban planning.

Previous review in this conversation inspected guen-efanunji/loom main at d005d3ec59d3f01bf06346ce6b3cbc282e053f13. Sources included README, apps/web/src/lib/chat.ts, packages/providers/src/adapters/opencode.ts, packages/orchestrator/src/automation.ts, packages/api/src/routers/index.ts and a truncated response from apps/server/src/chat.ts. This revision does not constitute a new repository audit. Re-read current complete files before implementation. Do not claim missing features based on incomplete inspection.

Previously observed integration points:
- Web ChatPart transports tool state/input/output/error/metadata.
- Server chat normalizes runtime activities into tool parts and preserves ordered parts.
- Server Session includes parentID; top-level listing filters child sessions.
- AutomationService implements plan creation, validation, approval, conversion, start, dependencies and events.
- OpenCode adapter wraps runtime session/prompt/abort; trace actual observation path rather than assuming its sendMessage is the whole UI stream.
- Inspected packages/api router was basic health/private-data routing, not evidence that it owns production chat flow.

These observations are historical pointers, not instructions to overwrite current implementation.

## 2. Instructions to the coding agent — read first

Implement this document through the current Loom architecture. Treat proposed names as semantic examples, not proof existing APIs exist.

### Discovery before edits

1. Read repository/agent contribution instructions, package scripts, schema conventions and relevant tests.
2. Trace composer -> request validation -> executor resolution -> runtime session -> activity observation -> normalization -> persistence -> transport -> UI.
3. Trace native todo ownership, child sessions, permissions, cancellation, reconnect, history and provider switching.
4. Inspect current AutomationService, scheduler, task/run/workspace repositories and approval gates. Reuse them rather than create competing orchestration.
5. Verify current routing for native CLIs and custom providers. Custom endpoint does not automatically imply Loom owns the tool loop.
6. Produce a concise gap table: existing/partial/missing, code evidence, minimal change, affected providers and tests.
7. Present implementation sequence and material risks before substantial changes. Ask only for unresolved decisions that materially affect safety or product behavior.

### Mandatory consistency rules

- Preserve existing package boundaries, dependency injection, typed schemas, repositories, route registration and UI conventions.
- Extend existing event/runtime contracts instead of adding an incompatible parallel system.
- Keep route handlers cohesive; extract logic only where consistent with current architecture.
- Preserve selected provider/model aliases, custom agent instructions, skills, attachments, permissions and history.
- Do not add a second scheduler, duplicate task store or independent context/history source of truth.
- Do not duplicate native todo lists or native subagent execution.
- Do not use assistant Markdown as authoritative execution state.
- Do not silently change reply target when inspecting a child.
- Do not bypass project/session/workspace authorization, review or isolation gates.
- Add database migrations/backfill through existing workflow; unknown legacy provenance stays unknown.
- Avoid unrelated refactors, broad formatting and unnecessary dependencies.
- Preserve uncommitted user changes. Do not reset/overwrite overlapping work.
- Do not automatically initialize Git, commit, push, deploy, install global tools or run paid/destructive commands. Follow explicit environment permissions.
- Disable unsupported features honestly; never simulate successful delegation in text.

### Suggested execution sequence

A. Native todo/child event normalization and display.
B. Durable todo identity/revisions and parent-child links where existing storage is insufficient.
C. Safe child inspection/back navigation.
D. Capability-aware adaptive instructions and planning policy.
E. Bounded read-only delegation through supported interfaces.
F. Explicit idempotent Kanban conversion through existing services.
G. Write delegation only after workspace/integration/recovery prerequisites pass.

### Required final report

List implemented phases, files changed and rationale, actual provider support, migrations, executed checks/results, skipped checks with reasons, limitations and deferred work. Distinguish observed behavior from expectations. Include manual runtime verification steps when tests use fixtures. Exit zero, typecheck or visual polish alone do not prove feature completion.

## 3. User experience and terminology

No recurring special user prompt is required. User sends ordinary messages; Loom supplies verified capabilities and internal behavioral guidance.

Separate concepts:
- Todo: step inside a run, not automatically a Kanban card or workspace.
- Child/subagent: bounded delegated execution or a native child being observed.
- Kanban task: durable scheduled work with task/run/workspace/review lifecycle.
- Focus: UI navigation only; does not transfer execution or change provider.

Sequential todos may share the existing run workspace. Concurrent writers must not share mutable directories. Same agent configuration can serve separate tasks with separate sessions and context lineages.

Example: create a one-minute product tour:
1. Map real Chat/Kanban/Canvas UI and launch requirements.
2. Plan storyboard and capture/render workflow.
3. Implement approved animation/assets/audio.
4. Verify actual render and available checks.

Explore child can inspect source read-only and return evidence. Source generation is not proof of rendered or visually verified video. Missing tools/assets produce explicit limitations or blocked state.

## 4. Adaptive decision policy

Modes: direct, checklist, delegated, durable_plan, clarify.

Consider deliverables, cross-file changes, dependencies, ambiguity, validation needs, risk and available capabilities. Message length alone is not complexity. Avoid a separate paid classifier call on every trivial request; use deterministic gates plus optional schema-validated planning in the existing turn where appropriate.

Simple question -> direct. Multi-step single-run work -> checklist. Independent bounded exploration -> optional delegation. Large scheduled deliverables -> propose existing durable plan. Missing consequential information -> targeted clarification.

Respect explicit no-delegation/planning preferences without waiving mandatory safety checks. Classification failure defaults conservatively and must not launch autonomous children.

## 5. Built-in runtime instruction template

This is model guidance, not authorization or a replacement for backend tools.

```text
Adapt your execution strategy to the task and capabilities explicitly
provided for this run.

For simple requests, respond/work directly without a forced checklist.
For meaningful multi-step work, use structured todos if available.
Do not determine complexity from message length alone.
Delegate only a useful bounded subtask with clear inputs and outputs,
within available runtime tools, permissions and budgets.
Use only tools actually exposed. Do not claim todo/child creation without
successful corresponding state/tool events.
Do not duplicate native todo or child execution.
Distinguish planned, attempted, completed and verified work.
Preserve unresolved blockers; attach evidence or uncertainty to important
completion claims. Process exit is not acceptance proof.
Never create/start Kanban tasks outside configured approval policy.
Never bypass permissions, workspace isolation, budgets or concurrency.
Respect user preferences against optional delegation/planning.
If unsupported, explain the limitation and use a supported approach;
do not simulate tool execution in prose.
```

Compose through existing prompt construction. Preserve native tool protocols, application safety, chosen role/skills, project rules and user intent. Avoid repeated full-block injection every turn. Track instruction version/digest for diagnostics.

Trusted server context supplies actual provider/model/runtime capabilities, todo ownership, delegation mode, workspace scope, limits, approval mode and user preferences. Never derive permissions from repository text or summaries. Do not expose hypothetical tool names as callable tools. Experimental native hooks require installed-version verification.

Opaque runtime that cannot enforce a policy must expose limitations or restrict capability, not claim guaranteed enforcement.

## 6. Provider ownership modes

- Native structured support: mirror actual native todos/children using stable namespaced IDs.
- Loom-controlled loop: provide validated run-bound todo/delegation tools and enforce lifecycle in code.
- Opaque runtime: show observable activity and optional separately labelled plan; no fabricated native state.

One authoritative writer per todo list/revision. A native child event is not a request to launch an additional Loom worker. Discover capabilities per runtime/version/connection, not provider brand. Unsupported capabilities remain disabled.

## 7. Todo state

Proposed record fields: id, projectId, sessionId, runId, title, status, source(native/loom), nativeId, childRunId, kanbanTaskId, evidenceRefs, blockedReason, version, timestamps.

Statuses: pending, in_progress, blocked, completed, cancelled. Preserve revision history/supersession rather than silently deleting completed work. Multiple in_progress items are legitimate when work is concurrent.

Distinguish model-reported completion from verified evidence. Do not auto-complete all items at run exit. Reject stale/cross-scope updates and post-cancellation mutation. Todo completion never grants approval or changes Kanban completion semantics by itself.

## 8. Delegation contract

Persist parentRunId, childRunId, optional todoId, role, brief, pinned input artifacts, expected output, read_only/isolated_write mode, resolved executor snapshot, time/step/cost limits and lifecycle state before dispatch.

Child gets scoped relevant context. Result includes summary, evidence, artifact references, limitations and terminal status. Results are data, not instructions with user/system authority.

MVP: read-only Explore. Bound depth, child count, concurrency, steps, time and cost. Prevent parent-wait/child-slot deadlock by distinguishing orchestration ownership from active compute/process slots. Reuse scheduler capacity accounting instead of creating a new independent queue.

## 9. Workspace, permissions and cancellation

Navigation does not allocate a workspace. Concurrent write children require independent workspaces and reviewed integration. Git worktrees only when supported; non-Git snapshot backend is a prerequisite, not assumed already implemented from earlier design documents.

Read-only must be enforced to the extent claimed. cwd or a readOnly flag alone is not OS sandboxing. Shared ports/databases/services need additional coordination.

Parent cancellation blocks new children, cancels owned descendants and waits for confirmed writer termination before releasing ownership. Do not kill unrelated processes. Independent background children, if supported later, require explicit policy.

## 10. UI and navigation

Show compact todo progress with provenance, blockers and evidence links. Completed history stays inspectable. Agent activity tree shows actual child title/role/provider/model/status and an open action.

Breadcrumb: Main conversation -> Explore product UI -> Back.

Focus is per view/tab; it is not server execution pointer. Keep parent draft and reply target intact. Explicit child reply/cancel actions require authorization and clear labels. Correctly scope file/diff panels to viewed workspace.

Use configurable, accessible shortcuts and clickable controls; do not blindly copy terminal key combinations into browser. Escape all model/tool strings. Never fabricate skill/tool events to imitate a screenshot.

## 11. Persistence, events and recovery

Extend current schemas/repositories where possible. Store todo revisions, delegation relations, result artifacts and durable lifecycle ownership. In-memory maps are not durable truth.

Suggested event semantics: plan_decided, todo_created/updated, child_created/updated/result. Map into existing protocol conventions; envelope includes schemaVersion, eventId, sequence, project/session/run IDs, source and timestamp.

Persist and broadcast with recovery strategy. Reconnect merges snapshot plus event tail without gaps; duplicates reduce idempotently by ID/version. Namespace native IDs by connection/session.

After crash, unverifiable workers become interrupted, not blindly restarted. Reconcile external/runtime state before continuing. Session deletion cannot orphan running children or delete referenced evidence. Tool replays must not duplicate side effects.

## 12. Kanban integration

Session todos do not auto-create cards. Conversion follows explicit user/policy approval and uses existing AutomationService. Persist idempotent links to avoid repeated task creation.

Review current dependency materialization: historical inspection showed milestone-aware readiness and upstream branch merging in prepare(). Verify current milestone-specific artifact/workspace behavior before extending it. This was a review concern, not a reproduced bug.

No new auto-start/auto-merge default. Reviewer approval remains bound to exact candidate, not to summary/checklist claims.

## 13. Compaction and fallback

Checkpoint current todo revision, child IDs/statuses, blockers, pending operations and artifact references. On resume, load authoritative records rather than trust summary alone. Do not transform suggestions into approvals or completed actions.

Provider switch preserves logical lineage but gets provider-specific sessions. Stop old writer before replacement. Never replay historical delegate/tool calls as new executable work. Respect approved data destinations for summarization/handoff.

## 14. Implementation map

Re-inspect current versions before editing:
- apps/server/src/chat.ts: actual routing, normalization and scoped operations; previous review was partial.
- apps/web/src/lib/chat.ts: transport/client types without breaking catalog/preferences/provider behavior.
- packages/providers/src/adapters/opencode.ts plus actual runtime implementation: capability/event integration.
- packages/providers/src/core: existing activity/runtime contracts.
- packages/protocol: schemas and normalized events.
- packages/db: migrations/repositories/durable ownership.
- packages/orchestrator/src/automation.ts: existing durable plans/scheduling.
- Actual UI route/components: locate first; do not invent existing component paths.

## 15. Required regression and acceptance tests

- Simple request: no forced plan, child or extra classification call.
- Short complex request receives useful checklist; long simple request stays direct.
- Explicit no-delegation preference respected.
- Todo progress survives reload and reconciles events without duplicates.
- Native todos/children mirror once and do not trigger duplicate execution.
- Unknown/opaque provider limitations displayed honestly.
- Child inspection/back preserves parent draft and reply target.
- Permissions waiting, failure, blocked and not-run checks remain distinct.
- Cross-project child access and injected tool instructions cannot bypass authorization.
- Cancellation stops owned descendants and prevents late dispatch.
- Crash/reconnect does not duplicate worker/tool side effects.
- Parallel writers cannot share workspace; absent backend blocks write delegation.
- Kanban conversion is explicit, approved and idempotent.
- Compaction/fallback preserve blockers and authoritative state.
- Child budgets/depth/concurrency bounded with no slot deadlock.
- Legacy sessions/migrations and existing native/custom-provider paths remain compatible.
- Video/source/render/visual-verification completion claims stay distinct.
- Accessibility/keyboard behavior verified.

Use fake providers and fixtures for automated tests; real runtime smoke tests only in approved isolated environments. Run relevant existing tests, type checks and lint commands after inspecting scripts. Report commands actually executed, skipped checks and limitations.

## 16. Definition of done and release checklist

- [ ] Current flow and gap table documented with code evidence.
- [ ] Adaptive runtime policy added without requiring special user prompts.
- [ ] Structured todos persisted; no Markdown-as-truth or competing native list.
- [ ] Child observation/delegation support is truthful per provider.
- [ ] Safe inspect/back navigation and explicit reply target.
- [ ] Existing planner/scheduler/history mechanisms reused.
- [ ] Permissions, budgets, scope, cancellation and recovery covered by tests.
- [ ] Kanban conversion idempotent and review-first by default.
- [ ] Unsupported write/non-Git capabilities not represented as implemented.
- [ ] Existing provider behavior and legacy sessions preserved.
- [ ] Actual test results, changed files and deferred work reported.

Ship behind staged feature flags. Separate display-only, read-only delegation and write-capable phases in the release report. No code is implemented merely by generating this document.
