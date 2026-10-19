# Loom — Parallel Kanban Agents, Review, and Integration

Status: implemented across the server, orchestrator, database, worktree and Kanban UI. The workflow remains bounded by explicit task scope and approval gates; automatic promotion is opt-in.

Verification on 2026-10-17: `bun run test` (152 passing) and `bun run check-types` pass. Implementation-specific runtime limits and replay behavior are recorded in §§14–16.

## 1. Objective

Allow a user to create Kanban tasks executed by either a custom agent from Settings/Agents or a direct provider/model selection. Independent tasks may run in parallel in separate Git worktrees. Explicit dependencies coordinate shared contracts. Review and integration are separate gates before promotion to the target branch.

Do not synchronize live working files between agents. Share versioned artifacts and committed outputs at safe checkpoints.

## 2. Evidence and scope

Previous inspection read apps/server/src/agents.ts, packages/orchestrator/src/scheduler.ts, packages/worktree/src/index.ts, and the visible portion of packages/orchestrator/src/index.ts. Re-read current files before implementation; the repository may have changed.

Observed foundations: scheduler concurrency, lifecycle hooks, managed worktrees, merge queue, expected-HEAD checks, assignments and custom agent configuration.

Observed gaps requiring verification against current code:
- Assignment continuation uses a read-only path rather than the coding worktree pipeline.
- Agent create/update hardcodes all surfaces true.
- Task execution does not visibly pass an executor snapshot into runtime creation/prompting.
- Execution completion and merge completion reuse completed status.
- Merge cleanup uses forced worktree removal and must protect uncommitted output.
- Custom model aliases can be lost if catalog lookup returns no matching model.

Do not infer missing functionality merely from filenames. Trace service wiring, database schema, protocol types and tests before replacing existing code.

## 3. Non-goals

- No unrestricted autonomous execution or indefinite task loops.
- No automatic push, deploy, publish, or remote PR merge.
- No cross-provider reuse of CLI session IDs.
- No canvas-generated HTML written to project files without an explicit coding assignment.
- No full container sandbox implementation in this milestone.

## 4. Core invariants

1. One active writer per worktree.
2. Every coding attempt has a distinct run ID, owned workspace, executor snapshot and event trail.
3. Every integration candidate identifies exact input and output commit SHAs.
4. Reviews approve exact content, not a mutable branch name.
5. Independent work may run concurrently; integration mutations serialize per target branch.
6. Process success is not acceptance success.
7. No cleanup may discard unarchived output.
8. Explicit permissions govern writes, commands, commits and merges. Prompts are not enforcement.
9. No silent provider/model substitution.
10. Worktrees isolate checkouts, not processes, credentials, ports or databases.

## 5. Task creation UX

Extend the existing Kanban create/edit task form rather than inventing a second task store.

Required: project, title, implementation brief, acceptance criteria, target branch.

Executor selection:
- Custom agent: select an active global/project agent allowed on Kanban.
- Direct runtime: select a connected provider and model or provider default.

Optional: dependency milestones, allowed path hints, shared contract artifacts, review policy, execution timeout, fallback policy.

Show effective permissions, model, review mode, dependency blockers and worktree policy before Run.

Changing executor configuration affects future runs only. Running attempts retain their snapshot. Editing a running task's behavioral scope requires pause/cancel and a new revision.

## 6. Executor resolution

Use a discriminated union:

```ts
type TaskExecutor =
  | { kind: 'agent'; agentId: string }
  | { kind: 'direct'; providerId: string; modelId: string | null };
```

Resolve once per attempt into an immutable snapshot containing provider, exact model identifier or null default, role, rendered instructions, enabled skills and versions, permissions, fallback policy, effort, timeout and source configuration version/hash.

Validate project ownership, agent scope, active status, allowKanban, provider availability and runtime capabilities. Keep display labels separate from machine IDs. Unknown manual aliases may be accepted by configured provider capability; never discard them because catalog lookup misses.

Direct execution uses shared coding instructions and identical safety gates. Custom skills can narrow but never expand host permissions.

## 7. State model

Keep run, review and integration states separate:

- Execution: queued, preparing, running, waiting_permission, succeeded, failed, cancelled, interrupted.
- Review: pending, running, approved, changes_requested, blocked, superseded.
- Integration: pending, assembling, conflicted, checking, ready, promoting, merged, failed, stale, cancelled.

Kanban display projection:
- Backlog: unstarted draft.
- Ready: valid configuration and eligible dependencies.
- In Progress: active execution/preparation.
- Review: implementation output exists but required gates are pending.
- Done: promoted output and all required acceptance gates satisfied.

Show blocked/error badges without overloading execution status. Validate transitions server-side. A CLI exit code zero only produces execution succeeded after output checkpointing; it does not produce Done.

## 8. Scheduling and dependencies

Reuse existing scheduler and lifecycle hooks. Eligibility must be checked again immediately before claiming a task.

A dependency identifies producer task, consumer task and required milestone:
- contract_published: approved/versioned contract artifact exists.
- artifact_ready: required generated client/schema/output is available.
- implementation_ready: producer has a verified committed output.
- integrated: producer output is in the relevant integration baseline/target.

Reject cycles, cross-project references and duplicate edges. A failed dependency blocks consumers with an actionable reason. Milestone events redispatch the queue.

Concurrency limits: global, per project and optionally per provider. Distinct worktrees permit multiple writers in a project. Use persistent leases/atomic claims; in-memory maps alone are not sufficient for crash recovery or multiple workers.

Avoid double scheduling through separate custom-agent and task-run endpoints. All Kanban writes use one execution pipeline.

## 9. Contract-first parallel workflow

Example invoice feature:
1. Publish a versioned API schema covering route, request, response, auth, errors and pagination.
2. Pin frontend and backend tasks to the same contract SHA/hash.
3. Start both from a recorded baseline that contains required shared contract files.
4. Frontend implements UI/client and test fixtures; backend implements API/persistence/tests.
5. Both publish output commits and verification evidence.
6. Assemble them in an integration worktree and run combined checks.

Visual slicing can run independently. Live API integration may wait for contract_published or artifact_ready, not necessarily full backend completion.

Shared contract changes require a new version and a contract-change event. Affected consumers become stale until reconciled. Never merge or rebase a worktree while its agent is writing. Stop the writer, checkpoint output, update dependencies, then start a new attempt/resume safely.

Use path ownership hints for shared schemas, migrations, root config and lockfiles. They help scheduling but are not security isolation. Overlapping planned changes should serialize or be assigned to a dedicated integration task.

## 10. Workspace lifecycle

Record project ID, task ID, run ID, branch, explicit base commit, worktree path, target branch and ownership metadata.

Suggested branches:
- loom/tasks/<task-id>/<run-id>
- loom/integration/<batch-id>

Create managed worktrees outside the user checkout. Do not assume current HEAD is the desired target branch. Record the selected target ref and resolved SHA explicitly. If user checkout is dirty, do not stash/reset/commit it automatically. Require a deliberate snapshot or use the selected committed baseline and disclose excluded local changes.

Before launch prepare dependencies with the project's package manager under approved policy. Allocate unique ports, temporary directories and isolated test databases where needed. Do not share mutable node_modules or database state without a documented safe strategy. Never copy all environment variables into task metadata.

Checkpoint flow:
1. Stop/confirm worker completion.
2. Inspect tracked, staged and untracked output.
3. Exclude secrets, runtime metadata and generated noise according to project policy.
4. Verify scope and checks.
5. Create an output commit only if task policy explicitly authorizes Loom-managed commits; otherwise request approval.
6. Record output SHA and evidence.

Git worktree creation is not a filesystem sandbox. A cwd alone does not prevent a CLI from reading/writing elsewhere. Enforce available runtime sandbox/capability controls and disclose limitations.

Store Loom ownership metadata outside committed source where feasible. Never accidentally include .loom-worktree.json in task output.

Cleanup is explicit and retention-aware. Refuse removal when uncommitted changes or unarchived artifacts exist. Normal successful merge should not require unconditional --force removal. Preserve failed workspaces for review unless user requests discard.

## 11. Execution pipeline

Claim task and lease → resolve snapshot → prepare owned worktree → materialize pinned dependency artifacts → create runtime in worktree → stream events → process permission decisions → wait for terminal result → checkpoint output → verify task → publish implementation_ready → request review/integration.

Preserve the actual provider and model on every run. Carry cancellation to the subprocess tree. Do not free a writer slot until process termination is confirmed.

On fallback, stop and confirm the previous writer is gone, preserve its workspace/checkpoint, classify the eligible provider failure, and create a replacement attempt under an explicit fallback policy. Resume in the preserved workspace when safe; do not create a fresh baseline that loses partial work. Use a handoff, never another provider's session ID. Bound retries/hops and record their linkage.

Do not convert failed project tests, permission denial, user cancellation or invalid input into silent provider fallback.

## 12. Review modes

manual: required checks plus human decision.
automatic: required checks plus selected reviewer agent verdict.
hybrid (recommended default): required checks, agent findings and human approval.

Review approval and merge authorization are separate. Automatic review does not imply automatic merge.

Reviewer selection may reference a custom Fullstack or QA agent, or a direct provider/model with read-only review instructions. Reviewer runtime receives candidate diff, exact SHAs, acceptance criteria and check evidence, not unrestricted write permission.

Structured verdict:

```ts
type Verdict = {
  decision: 'approve' | 'request_changes' | 'blocked';
  summary: string;
  findings: Array<{
    severity: 'critical' | 'high' | 'medium' | 'low';
    file?: string;
    line?: number;
    message: string;
    suggestedAction?: string;
  }>;
};
```

Validate verdict schema. Malformed output, timeout or unavailable reviewer means blocked, never implicit approval. Missing mandatory checks block approval/promotion according to policy.

Bind review to subject SHA, base SHA, evidence digest and policy version. Changes invalidate relevant approvals. Identity of author/reviewer must be recorded; high-risk changes should require independent human approval.

Reviewer defaults to read-only. Findings either return to original worker or create a separate integration-fix task. If a Fullstack agent changes code, candidate SHA changes and checks/review restart. Bound revision rounds; escalate instead of looping forever.

## 13. Integration and promotion

1. Acquire integration lease for project + target branch.
2. Resolve target SHA and ordered member output SHAs.
3. Create integration worktree from target SHA.
4. Merge member commits in dependency order, sequentially.
5. On textual conflict, preserve evidence and stop; offer human resolution or authorized integration-fix task in the integration workspace.
6. Run required combined typecheck/build/tests and contract/integration checks.
7. Obtain candidate review/approval under policy.
8. Revalidate target SHA and approved candidate.
9. If target moved, rebuild against new target, rerun checks and invalidate prior approvals as needed.
10. Promote exact candidate under explicit merge permission, recording actual resulting target SHA.
11. Mark members Done only after required gates and promotion succeed.

Do not run branch integration inside the user's dirty checkout. If target branch is checked out there, require a clean approved update or wait; never reset user changes. Promotion should use a safe expected-old-SHA mechanism supported by the chosen Git strategy. Do not check out the same branch in two worktrees. Define and test the exact promotion strategy before coding it.

Use a per-target durable lock and expected SHA verification, not only an in-memory global merge queue. Serialize promotions but allow independent workers to keep running.

Do not merge branch tips that have moved since reviewed input capture. Git merge success proves textual compatibility only; combined behavior requires checks.

## 14. Continuous Kanban execution

Opt-in only, assignment-scoped. User selects eligible project, task filter, concurrency, maximum task count, retry/repair limits and duration budget.

The current bounded assignment API accepts an explicit `taskIds` allowlist (maximum 20), `maxTasks` (1–20), `concurrency` (1–3 and no greater than `maxTasks`), `durationMinutes` (1–120), `maxRetries` (0–2), and an idempotency key. It does not discover additional tasks outside this allowlist. Retries apply only to failed attempts; cancellation is never retried. The agent must have `executionMode=continuous_kanban`, remain active, and allow Kanban execution. Active runs are unique per assignment and interrupted on daemon restart. Use `POST /api/agents/assignments/:id/continue`, `GET /api/agents/assignments/:id/runs`, and `POST /api/agents/assignments/:id/cancel`.

After completion, claim the next eligible task atomically. Do not execute blocked, done, cancelled or dependency-incomplete tasks. Pause on approval requirements, unavailable resources, exhausted limits, disable/cancel, or unresolved integration conflict.

The service schedules only selected tasks through the regular orchestrator, so its persistent task lease and dependency checks remain authoritative. It pauses when an attempt reaches `ready_to_merge` and leaves review, approval, integration and promotion to their existing gates. This mode does not auto-approve or promote outputs.

Agent disable prevents new runs; offer a separate explicit action to cancel active runs. Continuous execution never expands scope or auto-deploys.

## 15. Database extensions

Map these concepts onto existing tables instead of duplicating current task/run systems. Add migrations with backward-compatible defaults and tests.

### Task execution configuration
- task_id (unique), executor_kind, agent_id nullable, provider_id nullable, model_id nullable, target_branch, review_policy_id, fallback_policy_id, config_version.
- Check executor discriminant consistency server-side and at DB level where supported.

### Task dependencies
- id, producer_task_id, consumer_task_id, required_milestone, artifact_id nullable, created_at.
- Unique dependency edge and no self-dependency; cycle validation in transactional application logic.

### Run snapshots and workspace records
- run_id, attempt_number, executor_snapshot_json, snapshot_hash, effective_provider/model, workspace_id, base_sha, output_sha, retry_of_run_id, fallback_from_run_id, lease_owner, lease_expires_at, heartbeat_at, terminal_reason.
- Preserve provider session identifiers scoped to their provider/run.

### Task artifacts
- id, task_id, producer_run_id, kind, version, commit_sha, relative_path/storage_key, content_hash, status, created_at.
- Artifacts use immutable content references; do not store secrets.

### Review policies
- id, project_id, mode, reviewer_executor_json, auto_merge default false, required_checks_json, max_revision_rounds, version.

### Reviews
- id, task_id nullable, batch_id nullable, reviewer_kind, reviewer_identity, base_sha, subject_sha, evidence_hash, policy_version, status, verdict_json, created_at, decided_at.

### Integration batches and members
- batch: id, project_id, target_branch, target_base_sha, candidate_sha, promoted_sha, status, lease fields, error details, timestamps.
- member: batch_id, task_id, run_id, output_sha, merge_order; unique batch/task.

### Checks and events
- check: id, run_id/batch_id, name, command_redacted, status, exit_code, evidence_ref, subject_sha, timestamps.
- event: id, scope_id, sequence, type, payload_redacted, created_at.
- Current implementation stores daemon events in `orchestration_events` with a monotonically increasing SQLite cursor; replay is available at authenticated `GET /api/events/replay?after=<cursor>&limit=<1..500>`. Websocket messages carry the same `replayCursor`. Event payloads are redacted before persistence. Assignment runs persist their explicit task filter, bounds, status, idempotency key, and active task IDs.
- Durable idempotency keys for enqueue, approvals, promotion and request replay.

Use transactions for configuration + skills/assignment updates and state transitions that must be atomic. Database transactions do not atomically commit Git operations; reconcile recorded intent with actual refs after crashes.

## 16. API/service contracts

Use current Hono/oRPC conventions rather than forcing these example endpoint names.

- create/update task executor and policy.
- start/pause/cancel task.
- list eligible custom agents.
- add/remove dependency with cycle validation.
- publish/list pinned artifacts.
- request review and submit human verdict.
- create/rebuild integration batch.
- request promotion of exact candidate SHA.
- resume bounded continuous assignment.

Every mutation validates project/resource scope, task version, allowed transition and required approval. Return conflict/stale errors rather than overwriting concurrent edits. Approval requests show exact target, commit SHA and intended operation.

Events: task.blocked, task.eligible, run.started, run.output, run.permission_required, run.finished, artifact.published, review.started, review.decided, review.invalidated, integration.conflicted, integration.check_failed, integration.ready, integration.promoted. UI reconnection reads a latest cursor before refreshing its task snapshot, then replays subsequent pages and deduplicates by cursor.

UI derives activity from real events and can recover using a snapshot plus replay cursor. Terminal failure must clear loading.

## 17. File-level implementation map

Inspect current layout first, then adapt:

- apps/server/src/agents.ts: preserve surface fields, validate scope, route Kanban coding to orchestrator, preserve model aliases, atomic updates.
- packages/orchestrator/src/scheduler.ts: dependency readiness, eligibility wakeup, resource claims and cancellation integration.
- packages/orchestrator/src/index.ts: executor resolution, snapshots, explicit output checkpoint, separate execution/review/integration outcomes.
- packages/orchestrator/src/automation.ts: reuse existing dependency/artifact hooks where appropriate.
- packages/worktree/src/index.ts: explicit base/target, dirty-state protection, integration workspaces, safe retention, actual promotion SHA.
- packages/providers: runtime selection by snapshot, capability validation, cancellation and provider-specific session handling.
- packages/protocol: validated input unions, state transitions, event payloads.
- packages/db: extend existing schema/repositories and migrations.
- Kanban UI: executor selector, dependencies, review mode, active provider/model, worktree details, review findings and integration state.

Avoid one monolithic orchestrator file: introduce focused executor-resolver, review-service and integration-service modules if consistent with project conventions.

## 18. Required automated tests

Use fake runtime adapters for ordinary tests and real temporary Git repositories for Git integration tests. No paid services or user's repository in default tests.

### Executor and agent tests
- Agent config resolves provider/model/skills exactly.
- Direct executor routes to requested runtime, never implicit OpenCode.
- Manual aliases survive missing catalog entries.
- Surface flags persist and unauthorized surfaces are rejected.
- Agent edits do not mutate a running snapshot.
- Disabled or out-of-project agents cannot start.

### Parallel and dependency tests
- Two independent tasks start concurrently in distinct paths/branches.
- Concurrency caps and atomic task claims prevent duplicate workers.
- Contract milestone releases eligible consumers; incomplete dependencies block.
- Dependency cycles and cross-project edges are rejected.
- Shared resource constraints serialize only conflicting tasks.

### Workspace tests
- Explicit baseline excludes uncommitted user checkout changes without deleting them.
- Uncommitted tracked/untracked output prevents cleanup.
- Secret/runtime metadata is not checkpointed.
- Checkpoint commit requires explicit policy authorization.
- Retry/fallback preserves partial output as designed.
- No merge/rebase while writer is active.

### Review and integration tests
- Manual mode never auto-approves or auto-merges.
- Automatic approval still respects auto_merge=false.
- Malformed reviewer output blocks.
- Candidate changes invalidate approval.
- Combined semantic/API mismatch fails tests even when merge is clean.
- Conflicts preserve task worktrees and leave user checkout untouched.
- Moved target triggers rebuild/retest, not stale promotion.
- Actual promoted SHA is recorded.
- Two promotion requests serialize/idempotently reconcile.

### Lifecycle tests
- Cancel waits for subprocess termination before releasing writer ownership.
- Fallback cannot overlap old/new writers.
- Restart marks missing workers interrupted and does not duplicate work.
- Crash after Git promotion but before DB update is reconciled correctly.
- Continuous mode honors task-hop, duration and retry limits.
- Bounded assignment rejects out-of-scope task IDs, prevents concurrent runs for one assignment, enforces the selected task cap, pauses at review gates, and returns the same run for a matching idempotency key.
- Event replay is authenticated, paginated, redacts token-shaped values, and recovers task events after a reconnect cursor.
- UI clears loading on failure and reconstructs state after reconnect.

## 19. Rollout phases

Phase A: Correct surface persistence, aliases and executor routing; add tests.
Phase B: One task/run/worktree with safe checkpoint and explicit merge approval.
Phase C: Two independent parallel tasks and durable claims.
Phase D: Contract artifacts and dependency milestones.
Phase E: Integration worktree, required checks and manual promotion.
Phase F: Read-only automatic/hybrid review with SHA-bound verdicts.
Phase G: Opt-in auto-merge and bounded continuous assignments.

Keep unsafe automation behind disabled-by-default feature flags. Automatic merge is gated by `LOOM_ENABLE_KANBAN_AUTO_MERGE=true`; it remains unavailable unless the operator explicitly opts in. Do not activate later phases until preceding acceptance tests pass.

## 20. Acceptance criteria

A user can create two tasks assigned to frontend/backend custom agents or direct provider/model executors. Independent work runs concurrently in isolated worktrees. Both pin the same approved contract when required. Outputs become committed, traceable artifacts without losing user changes. An integration candidate combines exact outputs, passes required checks and receives policy-compliant review. Promotion is serialized and stale approvals cannot authorize changed content. Done means integrated output, not merely CLI success. Failure, cancellation, fallback and restart never cause duplicate writers, silent data loss or indefinite loading.

## Public background

- Git worktree: https://git-scm.com/docs/git-worktree
- Git merge: https://git-scm.com/docs/git-merge

These references describe Git mechanics, not a security sandbox or proof of application compatibility.
