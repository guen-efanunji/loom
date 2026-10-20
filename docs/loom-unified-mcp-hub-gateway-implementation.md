# Loom — Unified MCP Hub, Managed Connections and Runtime Gateway

Status: proposed implementation specification. No repository changes implied.
Purpose: evolve the current read-only MCP inventory into a capability-aware connection hub while preserving existing runtime flows and native configuration ownership.

## 1. Instructions to the implementation agent

Read this document and current repository instructions before editing. Inspect current HEAD; do not assume historical paths or prior chat observations describe current code completely. First trace MCP discovery, secret handling, provider routing, chat/task execution, permissions, server registration, UI settings and persistence end to end.

Produce a gap table: current capability, evidence file/symbol, missing behavior, minimal changes, supported runtime versions and tests. Read complete files, not only search snippets. Resolve actual custom-provider routing: a custom model may currently run inside OpenCode rather than a Loom-owned API harness.

Reuse current dependency injection, repositories, protocol schemas, services, transport and UI conventions. Do not create a second provider registry, coding harness, scheduler or permission system. Existing mcp-manager.ts and provider/runtime integration points are investigation hints, not mandatory replacement targets. Keep route handlers thin where consistent with current architecture.

Do not overwrite uncommitted changes, auto-initialize Git, commit, push or deploy. Do not execute discovered MCP commands, contact endpoints, install packages or change native configs merely during discovery. External actions follow explicit user/environment authorization. Implement incrementally with actual checks, then report changed files, migrations, supported capabilities, skipped checks, limitations and deferred phases.

## 2. Current user-visible baseline

The supplied screenshot shows /settings/mcp as read-only inventory: configured definitions, config sources read, Connection state Not observed, and a notice that discovery does not launch processes or contact servers. Preserve that honest discovery behavior.

Definition found is not connection active. Connection active is not authorization for every agent. Tools listed is not proof every invocation works.

Desired behavior:
- Discover definitions from supported OpenCode, Claude Code, Codex and Agy adapters.
- Observe actual native status only where supported.
- Add independent Loom-managed connections.
- Make approved tools available through actual runtime bindings or a Loom MCP gateway.
- Handle duplicate definitions without blindly merging identities.
- Support custom models through the runtime that really executes their tool calls.

Agy discovery, status observation, runtime injection and transport support remain unverified until adapter audit/tests establish them. Show unsupported/unknown, never fabricate parity.

## 3. Non-goals and terminology

Model provider: inference endpoint/model credentials.
Agent runtime: host/tool executor managing model turns and permissions.
MCP upstream: tool/resource/prompt server.
Loom connection: configuration and authentication ownership, not necessarily one globally shared protocol session.
Gateway binding: scoped access from a runtime/project/agent to managed upstream capabilities.

Do not assume a model endpoint itself speaks MCP. No transparent reuse of another runtime's internal MCP connection unless a documented supported API has been verified. No hidden extraction of native credential stores. No automatic replacement of native configurations. No promise of full protocol proxying in MVP.

## 4. Architecture

```text
Native config adapters ---> Discovered-definition registry
Native status adapters --> Observed status with freshness/source
                                      |
                         explicit adoption / new connection
                                      |
                        Loom Connection Manager
                      / auth / lifecycle / capability discovery
                                      |
                       Policy + Tool Routing Registry
                              /                
            Loom-owned tool harness        MCP Gateway
                                               |
                                 Supported CLI/runtime bindings
```

Loom is an MCP client toward upstream servers and an MCP server toward supported gateway clients. They have separate sessions, authentication and capability negotiation. Do not forward raw client credentials blindly.

A gateway is a controlled protocol termination/routing service, not arbitrary HTTP forwarding. Advertise only features implemented and authorized on both sides.

## 5. Four separate records

### Discovered definition

id, source runtime/connection, config path identity, scope, project, native key, transport, normalized nonsecret configuration, secret reference names, provenance, scan timestamp and parse errors.

Discovery records are read-only observations. Preserve multiple sources; never collapse them into one destructive config edit.

### Managed connection

id, label, owner scope, transport, endpoint or executable/args/cwd, secret references, policy, provenance links, version and lifecycle settings. Config secrets are private server-side refs, never UI-returned plaintext.

### Protocol session

id, managedConnectionId, downstream binding/run scope, upstream session identity, negotiated version/capabilities, auth identity reference, ownership, timestamps, state and last error. Sessions may be per run/project/client where upstream state demands isolation.

### Runtime binding

id, runtime connection, project/agent scope, managedConnectionId, effective route native/loom/disabled, selected capabilities/tools, permissions, auth identity, adapter version and configuration revision.

One record does not imply the others exist.

## 6. Discovery and native observation

Scan supported config sources with existing parsing/validation, bounded size and path scope. Refresh inventory is read-only. No process spawning, network handshake, environment expansion requiring execution or command substitution.

Preserve project/global distinctions and native precedence. Invalid config never wipes a last-known valid inventory silently; mark stale/error. Avoid logging secret values and command arguments that may contain credentials.

Status observation uses documented runtime APIs where available, read-only access and freshness metadata. Distinguish unknown, unsupported, stale and disconnected. Failure to observe cannot prove native disconnected.

## 7. Capability-driven adapters

Report independently per installed runtime/version:
- definition discovery;
- native status observation;
- supported MCP transports;
- per-run/session configuration injection;
- isolated config-overlay support;
- reload/reconnect behavior;
- managed auth integration;
- safe removal/rollback of Loom-owned configuration.

Custom providers inherit tool access from their actual host runtime. If OpenCode hosts a custom model, use its supported MCP binding path. If Loom controls messages/tool loop, expose validated MCP tools through the existing harness. Plain completion endpoints lacking a tool-capable harness remain unsupported, not magically upgraded by gateway registration.

Do not invent CLI flags/config filenames or assume identical configuration across versions. Never mutate global native config for convenience. Prefer verified run-scoped overlays. If not available, show exact proposed native edit and obtain explicit approval before writing. Back up/version-check and modify only the approved Loom-owned entry.

## 8. Adoption and new-connection flow

Actions: Add server, Review discovered definition, Add to Loom, Test connection, Authenticate, Connect, Disconnect, Inspect tools, Configure bindings.

Adopting a discovered definition:
1. Preview source, normalized config, launch/network implications and secret requirements.
2. User explicitly chooses managed scope and credential authorization.
3. Create Loom-owned config; retain provenance, do not silently delete native entry.
4. Resolve approved secrets or perform separate auth.
5. Connect only under approved policy; initialization + capability/tool discovery.
6. Display verified results and selected bindings.

Server launch is arbitrary code execution under OS rights. Connection test is a side-effecting/network operation and may spawn a process; it is not part of passive scanning. Disconnect affects only Loom-owned sessions/processes. Never kill native/user-owned processes.

## 9. Context7 use case

If Context7 exists in OpenCode:
- Keep original definition visible.
- Offer a separately approved Loom connection to the same endpoint.
- Verify credential availability/authorization; do not copy opaque OAuth tokens.
- Make Loom connection available to eligible custom-model host/harness.
- Optionally configure OpenCode to use Loom route, explicitly disabling duplicate exposure for that run where supported.

Alternative: independently connect both clients to a multi-client remote service. This is endpoint reuse, not shared internal runtime session.

Direct invocation through OpenCode internals is optional only if a stable API is verified and tested. It is not the baseline architecture. Stdio connections are not assumed shareable: Loom normally owns a separate process or mediates its own upstream connection safely.

## 10. Duplicate resolution and routing

Never deduplicate by display name alone. Compare transport, normalized endpoint/command, arguments, cwd, project/owner scope, account identity and secret reference provenance. Same endpoint can serve different tenants; same secret ref label can resolve differently in different scopes.

Normalization must not alter meaningful URL path/query, arguments, case-sensitive identifiers or environment semantics. Fingerprints use safe nonsecret identifiers; do not publish hashes of low-entropy secrets or credential-bearing URLs.

Possible duplicate is advisory. User chooses keep separate, link provenance, or adopt approved managed connection. Preserve auth/scope separation unless equivalence is established and approved.

Per runtime binding, choose one effective route for equivalent tool surface: native, Loom, disabled. Gateway namespaces prevent name collisions; mapping is deterministic, model-protocol length/character compatible and reversible. Names alone do not imply functional equivalence. Handle two unrelated tools with identical names without overwriting.

Native duplicate removal requires verified adapter control or explicit user config edit. If suppression cannot be enforced, expose warning and do not claim deduplicated execution.

## 11. Connection lifecycle

States: disconnected, connecting, auth_required, connected, degraded, error, stopping. Keep status facts separate from policy availability.

Record initialization time, protocol version, capability discovery time, status source, last observation, safe error and retry policy. Connected means handshake established at an observed point, not guaranteed future operation.

Use timeouts/backoff, bounded concurrency, process exit handling and cancellation. Never blindly retry write/destructive tools on timeout: unknown result requires reconciliation. List-change notifications update cached tool schemas and affected context bindings safely. Schema changes do not authorize new tools automatically.

Support stdio and Streamable HTTP first through verified SDK/runtime compatibility. Older transports only with explicit adapter coverage. Pin dependencies compatible with repository runtime and protocol versions; do not assume a particular SDK major is installed.

## 12. Gateway scope and session isolation

Bind local gateway to loopback by default. Local CLI gateway URL works only when that runtime can reach Loom's host; containers, WSL and remote runtimes require explicit networking design, not a localhost assumption. Do not expose publicly by default.

Authenticate downstream clients with dedicated scoped credentials, not the daemon admin token. Bind authorization to project/runtime/agent/tool subset. Validate Origin/Host and session ownership. Session ID is not authentication. Prevent SSRF, DNS rebinding exposure and redirect-based credential leakage through endpoint validation and explicit network policy. Private/local upstreams may be legitimate but require deliberate approval, not blanket unrestricted access.

Detect self-routing and multi-hop cycles; reject Loom importing its own gateway as upstream. Track origin chains/hop limits where supported. Do not allow arbitrary proxy targets via tool arguments.

Do not multiplex stateful upstream sessions across unrelated projects/accounts. Sharing one configuration does not promise one session/process. Thread/project state, filesystem roots and cancellation must not leak across clients.

## 13. Tools, permissions and agent loop

Only authorized tools appear in downstream tools/list or model tool schemas. Enforce the same policy again at tools/call. Tool annotations/descriptions are untrusted hints, not proof a call is read-only.

Use existing permission gates for operations. Native runtime approval does not automatically grant Loom approval, nor vice versa; define effective policy and avoid prompt loops. Attach run/binding/operation IDs to calls. Return tool errors as tool outcomes; distinguish transport failure from upstream tool error.

For Loom-owned model loops, validate model-generated arguments, transform supported JSON Schema deliberately, preserve tool-call/result pairing and multimodal content as supported. Unsupported schemas/content are explicit errors or limitations, not silent conversions. Bound output size without pretending truncated output is complete; retain protected artifact refs where appropriate.

Untrusted tool output cannot elevate privileges or rewrite trusted instructions. Log auditable metadata and redacted outcomes, not secrets. Do not automatically re-execute historical calls during fallback.

## 14. Resources, prompts and advanced MCP features

MVP may offer tools only. State that clearly. Do not advertise resources/prompts/subscriptions/sampling/elicitation/tasks/roots merely because upstream supports them. Implement each feature through downstream capability negotiation, authorization and lifecycle tests before enabling it.

Server instructions must retain untrusted origin and cannot override application policy. Upstream server-to-client requests cannot be forwarded arbitrarily to another client's model or UI. Roots remain project-scoped. If unsupported interactions are required, return clear unsupported behavior and surface connection limitations.

## 15. Credentials and OAuth

Use existing secure storage or approved OS-backed secret facility. Store references in database and redact UI/export/logs. Prevent secrets embedded in URLs/args from leaking. Define restart persistence and encryption constraints honestly.

Upstream OAuth authorization is distinct from downstream gateway authentication. Use provider/server-supported flows and current MCP auth requirements, including token audience/resource handling where applicable. Never pass downstream bearer tokens upstream or reuse native runtime tokens without supported authorization. Token refresh, revocation and account change invalidate affected sessions/bindings safely.

Cross-provider/project access is explicit. User selecting a connection does not authorize sending all project data to it. Preview sensitive call arguments through existing policy where appropriate.

## 16. UI evolution

Keep /settings/mcp route and returnTo navigation behavior, with safe validated local return targets. Preserve native inventory as its own tab.

Tabs:
1. Connections: Loom-owned lifecycle, auth, tool inspection, errors and scope.
2. Discovered: native source definitions, native status freshness and adoption/compare action.
3. Access & routing: runtime/project/agent bindings and native-vs-Loom route.

Summary cards separately count definitions, managed connections, observed connected sessions and effective eligible bindings. Never relabel all discovered definitions Connected.

UI states distinguish native unknown/unsupported/stale from verified native connected, Loom connected and available-to-agent. Disabled controls explain missing adapter support. Expose dry-run config diffs and explicit approval for native config changes. Refresh inventory and Test connection are separate buttons with different effects.

## 17. Persistence and recovery

Extend existing schema/repositories; proposed semantic records: discovered_definitions, managed_mcp_connections, secret_refs, mcp_protocol_sessions, runtime_bindings, tool_catalog_versions and redacted operation/audit records. Avoid duplicate provider registry.

Use versioned updates/idempotency for adoption, binding changes and config application. Filesystem/native-config changes and DB writes are not inherently atomic: persist intents, backups/expected versions and recovery state. Do not overwrite external edits during rollback.

On restart, only reconnect connections under previously approved persistent policy. Do not launch every discovered executable. Mark unverifiable sessions stale/interrupted and reconcile owned processes safely. Retain logs/artifacts according to project privacy policy. Removal cannot orphan owned processes; unrelated/native sessions remain untouched.

## 18. Existing Loom feature integration

Chat/Kanban/review use the same binding resolver and permission services, scoped per run/workspace. Agent configuration can choose a subset of MCP connections; per-run executor/context snapshots record effective binding versions.

Compaction includes connection/tool references and pending operation state, not credentials or fictional approval. Provider fallback resolves target capabilities and policy before continuing; same tool label does not prove same connection identity.

Parallel task workspaces need separate roots/session state where required. Non-Git support is independent of MCP support; never initialize a repository to connect a server.

## 19. Acceptance and security tests

Discovery:
- scan performs no spawn/network/config mutation;
- invalid/stale sources preserve honest state;
- Agy unsupported remains unsupported;
- same name/different accounts remain separate.

Connections:
- stdio launch only after approval, ownership cleanup verified;
- HTTP initialization/auth/tool discovery with timeouts;
- OAuth refresh/revocation and missing secret handling;
- no secret in responses/logs/export;
- test is not misrepresented as passive scan.

Gateway:
- valid authorized client can list/call permitted tool;
- denied tool excluded and direct calls rejected;
- cross-project/session/account requests denied;
- origin/host/token, redirects and SSRF policy enforced;
- self-loop/cycle rejected;
- unsupported protocol capabilities not advertised;
- upstream cancellation/list changes/errors map correctly;
- timeout with unknown write outcome never auto-replays.

Runtime integration:
- Context7 discovered in OpenCode can be adopted to Loom after approval;
- custom model through actual host runtime can use selected tools;
- Claude/Codex/OpenCode adapter verified individually;
- unsupported runtime clearly disabled;
- native and gateway duplicate tools not silently double exposed;
- config overlays leave global native config unchanged;
- approved config edits respect version checks and external changes.

Recovery and concurrency:
- isolated projects do not share stateful sessions;
- restart respects approved reconnect policy;
- disconnected/removed connection cancels only owned work;
- replayed adoption/binding action is idempotent;
- DB/file partial update exposes recoverable state;
- compaction/fallback does not duplicate tool side effects;
- tools-only MVP clearly reports resources/prompts unsupported.

Use fixture MCP servers, fake runtimes and isolated temp projects. Real endpoints, native credential stores and billable calls require authorization. Run relevant current lint/typecheck/tests using actual package scripts; disclose omitted checks.

## 20. Rollout

A. Audit and registry/provenance/status distinctions, no new execution.
B. Loom-managed connection/auth lifecycle and tools discovery behind feature flag.
C. Bind to actual custom-provider host/harness without a second agent loop.
D. Authenticated tools-only gateway plus one verified CLI adapter.
E. Additional Claude/Codex/OpenCode adapters and tested deduplication.
F. Agy after capability verification; advanced MCP features separately.

Default discovery read-only, auto-connect off until approved, no global config mutation, no public gateway and no auto-install. Ship support matrix by runtime/version and capability, not blanket all-provider claims.

## 21. Definition of done

Users can discover native definitions, explicitly create/adopt Loom connections, authenticate/test them and expose authorized tools through verified bindings. Duplicate identity and route conflicts are visible. Context7/custom-provider scenario works through actual runtime ownership without borrowing undocumented OpenCode internals. Native configurations and unrelated processes remain intact. Security, lifecycle and recovery tests pass. Unsupported adapters/features remain honestly unavailable.

## Documentation entry points for implementer verification

Recheck current protocol and installed runtime versions before implementation:
- https://modelcontextprotocol.io/docs/2026-07-28/learn/architecture
- https://modelcontextprotocol.io/specification
- https://ts.sdk.modelcontextprotocol.io/v2/clients/connect
- https://code.claude.com/docs/en/mcp
- https://developers.openai.com/learn/docs-mcp
- https://opencode.ai/docs/mcp-servers/

These references are verification starting points, not evidence that the project currently implements their features.
