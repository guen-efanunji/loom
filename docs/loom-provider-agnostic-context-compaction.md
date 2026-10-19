# Loom — Provider-Agnostic Context Management and Compaction

Status: proposed implementation specification, not a claim of existing implementation.
Scope: Chat, Kanban coding runs, reviews and provider fallback. Inspect current repository, runtime versions and protocols before implementing. Extend existing context/session services instead of creating competing sources of truth.

## 1. Objective

Build one Loom-owned context management layer usable across native coding CLIs and custom API providers. Preserve original conversation records subject to explicit retention/security policy while reducing the context sent on subsequent requests. Preserve task correctness, provenance, permissions and workspace isolation.

Universal policy does not imply universal control over provider internals. Every adapter must expose its actual capabilities. Never claim that a wrapper can replace an opaque CLI's active internal context without a supported interface.

Token savings of 60–70% are a benchmark target, not a guarantee. Evaluate summary generation cost, later request costs, task success and information retention together.

## 2. Concepts and ownership

- Original event log: durable user/assistant/tool events with provenance and ordering.
- Task state: structured facts grounded in execution records, not free-form model assertions.
- Context checkpoint: versioned summary plus source references covering a known event prefix.
- Context packet: exact provider-specific request/handoff material assembled for one step.
- Provider session: runtime-specific opaque identifier; not a universal session ID.
- Context lineage: task/run-specific history across supported retries and provider handoffs.

Agent configuration is reusable. Two tasks assigned to one agent do not share mutable context by default. Cross-task context is explicitly published through pinned artifacts/contracts/decisions. Review context is scoped to the exact candidate being reviewed.

## 3. Architecture

```text
Chat / Kanban / Review
         |
ContextStore + TaskStateStore + ArtifactStore
         |
ContextBudgeter -> CompactionEngine -> ContextPacketBuilder
         |
ProviderContextAdapter
         |
CLI / native API / custom OpenAI-compatible or Claude-compatible API
```

Loom owns portable state. Native runtime context may be used for performance but is never the only copy of recoverable task state. Runtime-owned hidden information cannot be assumed recoverable or portable.

## 4. Capability-driven adapter modes

```ts
type ContextMode = 'loom_owned' | 'native_assisted' | 'handoff_only';
interface ContextCapabilities {
  mode: ContextMode;
  ownsRequestMessages: boolean;
  canObserveUsage: boolean;
  canCountTokens: boolean;
  canRequestNativeCompaction: boolean;
  canCustomizeNativeCompaction: boolean;
  canDisableNativeCompaction: boolean;
  canExportPortableHistory: boolean;
  canStartFreshSession: boolean;
  contextWindowTokens: number | null;
  maxOutputTokens: number | null;
  capabilitySource: string;
}
```

Resolve capabilities per connection/model/runtime version, not solely provider brand. Persist the resolved capability snapshot for each run. Unknown capability is unsupported until verified; never invent flags/commands.

### loom_owned

Loom constructs messages and controls the tool loop. Suitable for custom APIs integrated through Loom's coding harness. Compose native protocol messages correctly; compatible endpoint labels do not prove support for every optional API feature.

### native_assisted

Use supported hooks/SDK/config to supply persistent state, request native compaction or customize compaction instructions. Verify installed version. Experimental hooks require adapter tests and graceful downgrade.

### handoff_only

CLI internal context is opaque. Maintain observable history and structured task state; when necessary stop at a safe boundary and start a fresh session with a portable packet. State gaps must be disclosed. No claim of exact internal-session restoration.

If session export/start is unavailable, block automatic handoff and provide a clear manual continuation path.

## 5. Original history versus active context

Do not silently delete original user input or assistant output merely to fit a request. Compaction changes active context, not necessarily stored history.

Summaries are lossy. They cannot guarantee every historical detail remains visible to the model. Preserve original references so relevant detail can be retrieved. Exact original retransmission on every turn is incompatible with savings obtained by replacing those turns with summaries.

Retention limits, user deletion and security redaction are independent policies, explicitly visible. Store credentials through secret facilities, not searchable prompts. Never promise indefinite retention of secrets/raw output.

## 6. Canonical event representation

Normalize events without discarding provider-native source data where storage is permitted:

```ts
interface ContextEvent {
  id: string;
  lineageId: string;
  sequence: number;
  kind: 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'artifact' | 'state';
  sourceRole: string;
  contentRef: string;
  providerId?: string;
  runtimeSessionId?: string;
  toolCallId?: string;
  trust: 'user' | 'application' | 'untrusted_content';
  createdAt: string;
}
```

Preserve ordering, role boundaries, tool call/result relationships and multimodal references. Do not flatten tool outputs into trusted user instructions. Provider-specific adapters handle role/protocol differences explicitly.

## 7. Dynamic budgets

Compute usable history budget from verified context limit minus instructions/tool definitions, reserved output, protocol overhead and a safety margin. Also respect provider-specific independent input/output limits.

Unknown model limits require user configuration or a visible conservative policy; do not pretend exact model knowledge. Token counts may be authoritative, locally estimated or unknown; label their provenance. Include system messages, tool schemas, attachments and summary text in accounting.

Policy knobs:
- soft pressure threshold;
- hard request-fit limit;
- output reserve;
- safety margin;
- recent-turn budget;
- protected-context budget;
- retrieval budget;
- compactor model and maximum cost;
- minimum event delta and cooldown between compactions.

Suggested thresholds are configurable starting points, not provider facts. React to real usage and overflow feedback, with bounded retries. If protected content alone exceeds budget, block and explain or ask for a narrower scope; never silently drop constraints.

## 8. Context selection and compaction pipeline

1. Pin an event-prefix boundary and task/workspace version.
2. Resolve applicable instructions and permissions from authoritative stores.
3. Keep current task brief, acceptance criteria and relevant user constraints.
4. Select recent complete interactions and active artifacts.
5. Avoid irrelevant/redundant material before summarizing.
6. Replace old bulky tool results with validated references/excerpts when safe.
7. Summarize older settled history into structured checkpoint.
8. Validate coverage, references, protected facts and protocol boundaries.
9. Atomically activate checkpoint for its exact prefix/version.
10. Build provider packet with checkpoint plus events after its boundary.

Events arriving during compaction remain in the tail; they must not be lost or duplicated. Use optimistic version checks and serialized context updates per lineage.

Do not repeatedly summarize only prior summaries. Re-anchor to original events/artifacts periodically and when important state changes, to reduce accumulated drift. Bound compaction loops and total spending.

## 9. Structured checkpoint

```json
{
  "schemaVersion": 1,
  "lineageId": "lineage-login",
  "coveredThroughSequence": 120,
  "task": {
    "id": "task-login",
    "goal": "Implement login",
    "acceptanceCriteria": [],
    "status": "in_progress"
  },
  "constraints": [],
  "decisions": [],
  "workspace": {
    "id": "workspace-2",
    "baselineArtifactId": "baseline-17"
  },
  "changedFiles": [],
  "dependencyArtifacts": [],
  "checks": [],
  "unresolvedIssues": [],
  "nextSteps": [],
  "sourceReferences": [],
  "uncertainties": []
}
```

Use deterministic facts from task/run/check records whenever available. Model-generated descriptions must link to evidence. Planned work is not completed work. A failed test cannot become a passing test. File state is time-sensitive; reference observed hash/version and reread before edits when stale.

Checkpoint is not an authorization token. Load current permissions and approvals separately; no model-generated summary can grant access, approve a merge or waive review.

## 10. Safe compaction boundaries

Prefer completed interaction/tool boundaries. Never discard a pending tool call or separate its required result in a way that violates the target protocol. Wait for completion, preserve the whole pending group if supported, or pause with an explicit recovery state.

No compaction-triggered duplicate tool execution. Reuse persisted operation IDs and idempotency records. If a tool's external outcome is unknown after a crash, reconcile rather than automatically retry a destructive action.

Cancellation and task lease ownership override compaction/continuation. A summary job cannot restart a cancelled task.

## 11. Native compaction coordination

Each run has one declared primary context policy. Native compaction may remain active as a safety mechanism when it cannot be disabled. Observe native events when exposed; record when native context becomes opaque.

OpenCode adapter: verify documented compaction settings/hooks against installed version. Preserve Loom task state through supported hooks where available; do not assume experimental API stability.

Claude Code adapter: use supported session/compaction integration only. Do not confuse CLI behavior with Claude API features.

OpenAI/Claude API adapter: optional native compaction requires actual model/endpoint support. Keep a separate portable checkpoint if cross-provider fallback is needed. Native encrypted/opaque compaction artifacts are not assumed readable by another provider.

Avoid uncontrolled Loom-summary -> native-summary -> fallback-summary cascades. Track checkpoint origin, covered prefix and native compaction events. Do not repeatedly compact unchanged content.

## 12. Custom providers

Custom connection contains label, protocol, base URL, secret reference and model alias. Capability overrides must be explicit and validated where possible. Preserve aliases exactly.

No native compaction endpoint is required for client-side Loom summaries. The compactor can be:
- the same model via a supported independent request;
- another explicitly configured model;
- deterministic state extraction plus retrieval when model summarization is unavailable.

A different compactor is a separate data destination with potential cost/privacy consequences. Never send project history to an unapproved provider silently. Fail closed or use an approved alternative if summarizer fails. A deterministic checkpoint is not a claim to summarize all semantic content.

A generic completion API alone is not a coding agent: Loom must supply tool execution, permissions, workspace isolation and an agent loop.

## 13. Provider fallback and session handoff

1. Record reason and confirm fallback policy permits transition.
2. Wait for a safe tool boundary; terminate old writer/process before starting another.
3. Preserve workspace, latest output artifacts and exact task state.
4. Produce a versioned portable handoff packet.
5. Apply target provider's budget and protocol conversion.
6. Start a new provider-specific session and record lineage.
7. Ask the new runtime to inspect current files/check evidence before continuing uncertain work.

Do not replay old assistant actions as new executable requests. Do not re-execute already completed tools. Session continuity is semantic, not transfer of hidden reasoning or identical provider memory. Hidden chain-of-thought is neither required nor requested; use explicit decisions, results and next actions.

If fallback target has a smaller context window, build a smaller validated packet. Never silently omit required constraints. If packet cannot fit, block with actionable explanation.

## 14. Kanban and multi-agent integration

Context lineage belongs to task/run scope. Workspaces remain separate per task even when one agent configuration serves multiple tasks. New retry attempts reference correct task lineage and baseline.

Shared knowledge is versioned and explicit: API contracts, architecture decisions, conventions, dependency outputs and integration checks. A dependent task receives the pinned artifact in its workspace/context; merely unblocking it does not materialize files.

Reviewer sees exact candidate artifact digest and observed check results. A checkpoint referencing a previous candidate cannot approve a new candidate. Non-Git projects use workspace/artifact IDs, not fabricated commit SHAs.

## 15. Persistence and recovery

Extend existing data model with:
- context_events and content references;
- context_lineages linking task/run/provider sessions;
- context_checkpoints with schema, digest, covered prefix, evidence, compactor snapshot and status;
- context_packets with selected references, estimated/actual usage and policy version;
- provider_context_capabilities with version/source;
- compaction_jobs with lease, idempotency key, costs and terminal reason;
- handoffs with source/target runs and portable artifact references.

Secrets are not plaintext in these records. Apply project authorization, encryption policy and retention. Content-addressed artifacts remain protected from garbage collection while referenced.

Crash behavior: unfinished checkpoint stays inactive; last validated checkpoint remains usable. Recover event tail from durable records. Never publish partial summary as authoritative state. DB and artifact writes need explicit reconciliation since they are not inherently atomic together.

## 16. Security and trust

Treat repository text, tool output and imported summaries as untrusted data. Preserve origin labels across compression. Validate references and output schema, but do not claim schema checks prove semantic accuracy.

Protect path scope and project isolation. Summary instructions must not expose credentials or unrelated projects. Sanitize logs and UI previews. Retained full logs have privacy/storage implications; expose retention/deletion controls and honor deletion in derived artifacts according to policy.

User-visible tool outputs may contain prompt injection. Never promote their instructions into system policy during summarization. Authorization remains deterministic and outside model control.

## 17. UI and observability

Display effective context mode, model budget source, estimated/actual usage, last checkpoint boundary, compaction reason, native assistance and known limitations.

Provide checkpoint inspection, source references and history retrieval. Let users request compaction at safe boundaries, configure approved compactor and inspect fallback packet. Native opacity must be visible, not represented as perfect context accounting.

Metrics: total input/output tokens, cache usage where exposed, compactor cost/latency, context overflows, re-read overhead, checkpoint validation failures, handoff success, task acceptance and constraint-retention failures. Distinguish context reduction from billing savings.

## 18. Required tests

### Protocol and boundaries
- Completed tool call/results remain valid for each protocol.
- Pending tool operation blocks unsafe compaction/handoff.
- New messages during compaction appear once in subsequent packet.
- Hidden/opaque native artifacts are not treated as portable text.
- Multimodal content is preserved as supported references or explicitly unsupported.

### Correctness
- User constraints survive long history.
- Failed checks remain failed.
- Planned file changes are not recorded as applied.
- Superseded decisions do not override latest decisions.
- Stale file facts trigger reread.
- Source lookup recovers exact details omitted from summary.
- Summary cannot grant permission or approve integration.

### Provider coverage
- OpenCode native-assisted and downgraded handoff modes.
- Opaque CLI without compaction controls.
- Custom OpenAI-compatible and Claude-compatible endpoints without native compaction.
- Unknown model limit, exact alias preservation, unsupported tokenizer.
- Compactor rate limit/outage/malformed result and unapproved destination.

### Lifecycle
- Cancellation does not auto-resume.
- Fallback cannot overlap writers.
- Restart does not duplicate summarization/tool execution.
- Two tasks sharing agent configuration keep isolated context.
- Git and non-Git workspace references both work.
- Recovery keeps last validated checkpoint and complete event tail.

### Evaluation

Compare baseline, selection-only, Loom compaction and native-assisted strategies on identical task suites. Record task completion, constraint retention, total billed usage where available, latency, summary cost and failure rates. Use adversarial histories, large tool results and smaller fallback windows. Report savings with workload/model/protocol assumptions rather than a universal percentage.

## 19. Rollout

1. Audit current session/context storage and add capability reporting.
2. Add original event log, structured state and packet observability.
3. Implement Loom-owned context for custom APIs behind a feature flag.
4. Add checkpoint validation, retrieval and safe boundary handling.
5. Integrate verified native hooks per runtime version.
6. Add bounded portable fallback and crash recovery.
7. Benchmark before enabling automatic policy broadly.

Default to conservative context management. No silent cross-provider data transfer, no destructive history replacement and no unsupported CLI manipulation.

## 20. Definition of done

Custom API providers can use Loom compaction without native endpoint support. Native CLIs expose truthful integration modes. Original history and compact active context are distinct. Critical task state, permissions, tool consistency and workspace identity survive supported compaction/handoff. Concurrent task contexts remain isolated. Recovery tests and representative quality/cost benchmarks pass with limitations disclosed.

## Public references for adapter verification

These are documentation entry points, not guarantees about the installed runtime. Recheck current version before coding.

- OpenCode config: https://opencode.ai/docs/config/
- OpenCode plugins: https://opencode.ai/docs/plugins/
- Claude Code context window: https://code.claude.com/docs/en/context-window
- Claude API compaction: https://platform.claude.com/docs/en/build-with-claude/compaction
- Claude context engineering: https://platform.claude.com/cookbook/tool-use-context-engineering-context-engineering-tools
- OpenAI API compaction: https://developers.openai.com/api/docs/guides/compaction
- Codex prompting guide: https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide
