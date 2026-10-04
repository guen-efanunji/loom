# DESIGN.md — Multi-CLI Provider Architecture

> Goal: aplikasi menjadi **provider-agnostic local coding agent orchestrator**. User dapat menghubungkan OpenCode, Claude Code, Codex CLI, Antigravity CLI, Grok CLI, dan provider lain melalui adapter yang memiliki kontrak seragam.

## 1. Target flow

```text
Providers Settings
       ↓
Connect provider
       ↓
Detect install + auth
       ↓
Discover provider models
       ↓
Normalize models
       ↓
Chat model selector updates
       ↓
User chooses provider/model
       ↓
Unified Agent Runtime
       ↓
Provider Adapter
       ↓
Local CLI
```

Contoh:

```text
Connect Antigravity CLI
        ↓
AntigravityAdapter.listModels()
        ↓
ModelCatalog
        ↓
provider.modelsUpdated
        ↓
Chat:
Antigravity
  ├─ Model A
  ├─ Model B
  └─ Model C
```

---

## 2. Core architectural rule

Jangan membuat Chat, Kanban, Scheduler, atau Progress mengetahui detail CLI tertentu.

Hindari:

```ts
if (provider === "opencode") {}
if (provider === "claude-code") {}
if (provider === "codex") {}
```

Provider-specific branching hanya boleh berada di:

```text
packages/providers/<provider>/
```

Application core hanya mengenal:

```text
Provider
Connection
Model
Session
Capability
AgentEvent
```

---

## 3. High-level architecture

```text
┌─────────────────────────────────────────┐
│                Web UI                   │
│                                         │
│ Chat                                    │
│ Kanban                                  │
│ Progress                                │
│ Providers Settings                      │
└────────────────┬────────────────────────┘
                 │ typed API / WebSocket
                 ▼
┌─────────────────────────────────────────┐
│              Local Daemon               │
│                                         │
│ ProviderRegistry                        │
│ ProviderManager                         │
│ ModelCatalog                            │
│ AgentRuntime                            │
│ SessionManager                          │
│ CapabilityResolver                      │
│ AuthManager                             │
│ ProcessManager                          │
│ EventBus                                │
└────────────────┬────────────────────────┘
                 │
      ┌──────────┼──────────┬──────────┐
      ▼          ▼          ▼          ▼
  OpenCode   Claude Code   Codex   Antigravity
  Adapter      Adapter     Adapter    Adapter
      │          │          │          │
      ▼          ▼          ▼          ▼
          local CLI processes/APIs
```

---

## 4. Provider ≠ Model

Pisahkan empat konsep berikut:

```text
Provider
Connection
Model
Session
```

Contoh:

```text
Provider:
Antigravity CLI

Connection:
local-antigravity

Models:
- model-a
- model-b
- model-c

Session:
chat-session-123
```

Jangan simpan `provider = model`.

---

## 5. Provider Definition

Metadata statis milik adapter.

```ts
export type ProviderCapability =
  | "chat"
  | "coding"
  | "streaming"
  | "models"
  | "sessions"
  | "resume-session"
  | "tool-use"
  | "permissions"
  | "diff"
  | "structured-output"
  | "image-input"
  | "reasoning-effort"
  | "system-prompt"
  | "custom-model";

export type ProviderDefinition = {
  id: string;
  name: string;
  executable: string;
  homepage?: string;
  capabilities: ProviderCapability[];
  minimumVersion?: string;
  install: {
    supported: boolean;
    url?: string;
  };
};
```

UI harus capability-aware. Jangan anggap semua provider punya feature yang sama.

---

## 6. Provider Connection

Connection adalah instance provider yang tersedia di mesin user.

```ts
export type ProviderConnectionStatus =
  | "disconnected"
  | "checking"
  | "connected"
  | "auth-required"
  | "error";

export type ProviderConnection = {
  id: string;
  providerId: string;
  name: string;
  status: ProviderConnectionStatus;

  executablePath: string | null;
  version: string | null;

  authenticated: boolean;

  lastCheckedAt: string | null;
  error?: string;
};
```

Walau versi awal hanya satu connection per provider, jangan hardcode asumsi tersebut.

Future:

```text
OpenCode Personal
OpenCode Work
```

---

## 7. Unified Model Descriptor

Semua provider menormalisasi model ke format internal:

```ts
export type ModelCapability =
  | "text"
  | "image"
  | "tools"
  | "reasoning"
  | "coding"
  | "structured-output";

export type AgentModel = {
  id: string;

  providerId: string;
  connectionId: string;

  name: string;
  displayName: string;

  description?: string;
  contextWindow?: number;

  capabilities: ModelCapability[];

  isDefault?: boolean;
  isAvailable: boolean;

  metadata?: Record<string, unknown>;
};
```

Gunakan composite identity:

```text
providerId + connectionId + modelId
```

Contoh:

```text
antigravity:local:model-a
claude-code:local:sonnet
```

---

## 8. Provider Adapter Contract

Ini interface inti.

```ts
export interface CliProviderAdapter {
  readonly definition: ProviderDefinition;

  detect(): Promise<ProviderDetectionResult>;

  getVersion(): Promise<string | null>;

  getAuthStatus(): Promise<AuthStatus>;

  authenticate(
    input?: AuthenticateInput
  ): Promise<AuthResult>;

  disconnect(): Promise<void>;

  listModels(): Promise<AgentModel[]>;

  createSession(
    input: CreateSessionInput
  ): Promise<AgentSession>;

  sendMessage(
    input: SendMessageInput
  ): AsyncIterable<AgentEvent>;

  cancelSession(
    sessionId: string
  ): Promise<void>;

  resumeSession?(
    sessionId: string
  ): Promise<AgentSession>;
}
```

Tidak boleh ada command CLI spesifik bocor keluar adapter.

---

## 9. Detection

```ts
export type ProviderDetectionResult = {
  installed: boolean;
  executablePath?: string;
  version?: string;
  authenticated?: boolean;
  error?: string;
};
```

Flow:

```text
Provider page opens
    ↓
ProviderManager.refreshAll()
    ↓
adapter.detect()
    ↓
installed?
version?
auth?
```

Check provider harus berjalan independen. Satu provider gagal tidak boleh membuat provider lain gagal.

---

## 10. Provider Registry

```ts
export class ProviderRegistry {
  private providers = new Map<string, CliProviderAdapter>();

  register(adapter: CliProviderAdapter) {
    this.providers.set(
      adapter.definition.id,
      adapter
    );
  }

  get(providerId: string) {
    return this.providers.get(providerId);
  }

  list() {
    return [...this.providers.values()];
  }
}
```

Bootstrap:

```ts
registry.register(new OpenCodeProviderAdapter(...));
registry.register(new ClaudeCodeProviderAdapter(...));
registry.register(new CodexProviderAdapter(...));
registry.register(new AntigravityProviderAdapter(...));
```

---

## 11. Provider Manager

Registry menyimpan adapter. ProviderManager mengelola lifecycle.

```ts
export interface ProviderManager {
  refreshAll(): Promise<void>;

  refresh(
    providerId: string
  ): Promise<ProviderConnection>;

  connect(
    providerId: string
  ): Promise<ProviderConnection>;

  disconnect(
    providerId: string
  ): Promise<void>;

  getModels(
    providerId: string
  ): Promise<AgentModel[]>;
}
```

---

## 12. Connect Flow

```text
User clicks Connect
        ↓
detect installation
        ↓
installed?
   ├─ no → Install / documentation
   └─ yes
        ↓
check authentication
        ↓
authenticated?
   ├─ no → provider auth flow
   └─ yes
        ↓
discover models
        ↓
normalize + cache models
        ↓
persist connection
        ↓
emit provider.connected
        ↓
Chat model selector updates
```

---

## 13. Authentication Abstraction

```ts
export type AuthStrategy =
  | "none"
  | "browser"
  | "device-code"
  | "terminal"
  | "api-key"
  | "provider-managed";

export type AuthStatus = {
  authenticated: boolean;
  strategy: AuthStrategy;
  accountLabel?: string;
  message?: string;
};
```

### Rule

Jika CLI sudah mengelola auth sendiri, biarkan CLI menjadi source of truth.

Aplikasi cukup menyimpan:

```text
authenticated = true
```

Jangan menyalin OAuth token/API key ke SQLite kecuali benar-benar diperlukan.

Jika secret storage kelak diperlukan, gunakan OS keychain.

---

## 14. Terminal Auth

Untuk provider yang memerlukan terminal interaktif:

```text
Connect
  ↓
spawn PTY
  ↓
provider login/auth
  ↓
stream terminal to UI
  ↓
re-check auth status
```

Gunakan PTY hanya untuk proses interaktif.

---

## 15. Browser Auth

Jika provider membuka browser:

```text
connect
  ↓
spawn login command
  ↓
provider opens browser
  ↓
poll/check auth
  ↓
connected
```

UI:

```text
Waiting for authentication...
```

Harus ada timeout/cancel.

---

## 16. Model Discovery

Ini fitur utama.

```text
Provider connected
      ↓
adapter.listModels()
      ↓
normalize
      ↓
ModelCatalog
      ↓
provider.modelsUpdated
      ↓
Chat updates selector
```

---

## 17. Model Discovery Strategy

Tidak semua CLI punya `models list --json`.

Support beberapa strategi:

```ts
export type ModelDiscoveryStrategy =
  | "cli-json"
  | "cli-text"
  | "config"
  | "static"
  | "runtime";
```

Priority:

```text
machine-readable JSON/API
>
config
>
static fallback
>
human-readable text parsing
```

Parsing ANSI/TUI adalah pilihan terakhir.

---

## 18. Static Fallback

Jika provider tidak dapat expose daftar model:

```text
Provider Default
```

boleh dipakai sebagai model virtual/default, tetapi jangan membuat daftar model palsu.

Capability:

```text
models = false
```

UI dapat menampilkan:

```text
Uses provider default model
```

---

## 19. Model Catalog

```ts
export type ModelRef = {
  providerId: string;
  connectionId: string;
  modelId: string;
};

export interface ModelCatalog {
  refresh(
    connectionId: string
  ): Promise<void>;

  listAvailable(): AgentModel[];

  listByProvider(
    providerId: string
  ): AgentModel[];

  get(
    modelRef: ModelRef
  ): AgentModel | null;
}
```

Refresh saat:

```text
provider connected
app startup
manual refresh
CLI version changed
cache expired
```

---

## 20. Model Persistence

SQLite:

```text
provider_connections
provider_models
provider_settings
```

Conceptual schema:

```text
provider_connections
--------------------
id
provider_id
display_name
executable_path
version
status
authenticated
last_checked_at
```

```text
provider_models
---------------
connection_id
model_id
display_name
capabilities_json
metadata_json
is_available
last_seen_at
```

Jika model hilang dari provider:

```text
is_available = false
```

jangan hapus histori lama.

---

## 21. Chat Model Selector

Chat tidak boleh hardcoded.

Source:

```text
GET /api/models
```

UI:

```text
Model
┌────────────────────────────┐
│ OpenCode                   │
│   Model A                  │
│   Model B                  │
│                            │
│ Claude Code                │
│   Sonnet                   │
│   Opus                     │
│                            │
│ Antigravity                │
│   Model X                  │
│   Model Y                  │
└────────────────────────────┘
```

Hanya tampilkan model:

```text
provider connected
+
model available
```

---

## 22. Chat Session

```ts
export type ChatSession = {
  id: string;
  projectId: string;

  providerId: string;
  connectionId: string;
  modelId: string;

  providerSessionId?: string;

  createdAt: string;
};
```

Pilihan provider/model disimpan per session.

---

## 23. Switching Provider / Model

Jangan assume semua CLI mendukung mengganti model di tengah session.

Rule:

```text
same provider + adapter supports dynamic model
  → switch if supported

different provider
  → create new provider session
```

Visible chat history tetap milik aplikasi.

Provider session hanyalah execution context.

---

## 24. Unified Runtime Input

```ts
export type SendMessageInput = {
  sessionId: string;
  model: ModelRef;
  message: string;
  cwd: string;
  attachments?: AgentAttachment[];
};
```

---

## 25. Unified Agent Events

Semua provider harus menghasilkan event internal yang sama:

```ts
export type AgentEvent =
  | {
      type: "message.delta";
      text: string;
    }
  | {
      type: "message.completed";
    }
  | {
      type: "tool.started";
      tool: string;
      input?: unknown;
    }
  | {
      type: "tool.completed";
      tool: string;
      output?: unknown;
    }
  | {
      type: "permission.requested";
      request: AgentPermissionRequest;
    }
  | {
      type: "session.started";
      providerSessionId?: string;
    }
  | {
      type: "session.completed";
    }
  | {
      type: "error";
      message: string;
    };
```

Chat/Progress hanya memahami `AgentEvent`.

---

## 26. Adapter Translation

```text
Antigravity raw output
        ↓
AntigravityAdapter
        ↓
AgentEvent
        ↓
Chat / Progress
```

```text
Claude-specific tool event
        ↓
ClaudeCodeAdapter
        ↓
tool.started
```

```text
OpenCode event
        ↓
OpenCodeAdapter
        ↓
AgentEvent
```

---

## 27. Transport Layer

Provider dapat memakai:

```text
HTTP local server
CLI process
JSONL stdin/stdout
one-shot process
PTY
```

Pisahkan transport dari provider semantics.

```text
Provider Adapter
      ↓
Transport
```

Normal process spawn untuk:

```text
JSON
JSONL
non-interactive command
```

PTY hanya untuk:

```text
interactive auth
interactive TUI
```

---

## 28. Prefer Machine-Readable Output

Jika CLI menyediakan:

```text
--json
--jsonl
--output json
SDK
server mode
```

gunakan itu.

Jangan parse pretty terminal output jika tersedia interface machine-readable.

---

## 29. Package Structure

```text
packages/
└── providers/
    ├── core/
    │   ├── types.ts
    │   ├── registry.ts
    │   ├── manager.ts
    │   ├── model-catalog.ts
    │   ├── runtime.ts
    │   └── events.ts
    │
    ├── opencode/
    │   ├── adapter.ts
    │   ├── definition.ts
    │   ├── auth.ts
    │   ├── models.ts
    │   ├── session.ts
    │   └── transport.ts
    │
    ├── claude-code/
    │   └── ...
    │
    ├── codex/
    │   └── ...
    │
    ├── antigravity/
    │   └── ...
    │
    └── grok/
        └── ...
```

---

## 30. Antigravity Adapter Example

```text
antigravity/
├── adapter.ts
├── definition.ts
├── detection.ts
├── auth.ts
├── models.ts
├── session.ts
├── parser.ts
└── transport.ts
```

Conceptual flow:

```text
Connect
  ↓
detect()
  ↓
getAuthStatus()
  ↓
authenticate() if needed
  ↓
listModels()
  ↓
cache normalized models
  ↓
provider.modelsUpdated
  ↓
Chat sees models
```

Important:

**jangan mengasumsikan nama command Antigravity atau provider lain.**

Adapter harus mengikuti interface resmi/aktual provider tersebut.

Core hanya memanggil:

```ts
adapter.listModels()
```

Implementation boleh berbeda total.

---

## 31. Provider Settings UI

Desain halaman saat ini sudah cocok sebagai foundation.

Connected:

```text
OpenCode CLI
v1.x

✓ Connected
3 models

[Models] [Disconnect]
```

Installed tetapi auth belum:

```text
Antigravity CLI
v1.x

Authentication required

[Connect]
```

Tidak terinstall:

```text
Antigravity CLI

Not installed

[Install]
```

---

## 32. Provider Detail View

```text
Antigravity CLI

Status
Connected

Version
1.x

Executable
/path/to/antigravity

Authentication
Signed in

Models
- Model A
- Model B
- Model C

[Refresh Models]
[Disconnect]
```

---

## 33. Install Button

Untuk tahap awal, `Install` sebaiknya membuka dokumentasi resmi provider.

Jangan langsung menjalankan shell installer arbitrary.

```ts
type InstallStrategy =
  | "url"
  | "command"
  | "package-manager"
  | "manual";
```

Auto-install bisa dibuat belakangan.

---

## 34. Provider API

```text
GET  /api/providers
GET  /api/providers/:id

POST /api/providers/:id/connect
POST /api/providers/:id/disconnect
POST /api/providers/:id/refresh

GET  /api/models
GET  /api/providers/:id/models

POST /api/providers/:id/models/refresh
```

---

## 35. Empty Chat State

Jika belum ada provider:

```text
No agent provider connected.

Connect a supported local CLI
to start chatting.

[Open Providers]
```

---

## 36. Default Runtime Selection

```ts
export type AgentRuntimeSelection = {
  providerId: string;
  connectionId: string;
  modelId: string;
};
```

Priority:

```text
chat/task override
>
project default
>
global default
```

---

## 37. Project Default Provider

Project settings:

```text
Default coding agent

Antigravity CLI
Model A
```

Task dapat override:

```text
Use Claude Code / Opus for this task
```

---

## 38. Planner and Executor May Differ

Architecture jangan mengunci:

```text
Planner = executor
```

Support:

```text
Planner:
Claude Code / Model A

Implementation:
Antigravity / Model B

Review:
Codex / Model C
```

---

## 39. Capability-Aware UI

Provider tidak support image:

```text
disable/hide image attachment
```

Provider support reasoning effort:

```text
Reasoning:
Auto / Low / Medium / High
```

Provider tidak support:

```text
hide control
```

Jangan membuat kontrol palsu yang tidak didukung provider.

---

## 40. Capability-Aware Scheduler

Task dapat membutuhkan:

```text
coding
tools
image
```

Sebelum execution:

```text
selected model satisfies capability?
```

Jika tidak:

```text
reject before spawning CLI
```

---

## 41. Unified Error Model

```ts
export type ProviderErrorCode =
  | "NOT_INSTALLED"
  | "AUTH_REQUIRED"
  | "AUTH_FAILED"
  | "MODEL_NOT_FOUND"
  | "PROCESS_FAILED"
  | "RATE_LIMITED"
  | "CONTEXT_LIMIT"
  | "PERMISSION_DENIED"
  | "UNSUPPORTED"
  | "UNKNOWN";
```

UI tidak perlu memahami raw stderr.

Debug log boleh menyimpan:

```text
raw message
exit code
stderr
```

secara lokal.

---

## 42. Provider Events

```ts
export type ProviderEvent =
  | {
      type: "provider.detected";
      providerId: string;
    }
  | {
      type: "provider.connected";
      providerId: string;
    }
  | {
      type: "provider.disconnected";
      providerId: string;
    }
  | {
      type: "provider.authRequired";
      providerId: string;
    }
  | {
      type: "provider.modelsUpdated";
      providerId: string;
    }
  | {
      type: "provider.error";
      providerId: string;
      message: string;
    };
```

Chat listens to:

```text
provider.modelsUpdated
```

lalu refresh daftar model.

---

## 43. Provider Health

Connected belum tentu healthy.

```ts
export type ProviderHealth = {
  status:
    | "healthy"
    | "degraded"
    | "unavailable";

  checkedAt: string;
  message?: string;
};
```

---

## 44. Version Compatibility

Adapter boleh menentukan:

```text
minimumVersion
```

Jika terlalu lama:

```text
Installed: x
Required: >= y

[Update CLI]
```

Jangan menjalankan parser baru terhadap CLI lama yang incompatible.

---

## 45. Timeouts

Recommended:

```text
detect: 5s
version: 5s
model discovery: 15s
auth: provider-specific
chat execution: long-running
```

Halaman Providers tidak boleh freeze karena satu CLI hang.

---

## 46. Parallel Detection

Saat halaman Providers dibuka:

```text
OpenCode check ──────┐
Claude check ────────┤
Codex check ─────────┼→ UI updates independently
Antigravity check ───┤
Grok check ──────────┘
```

Gunakan pola seperti `Promise.allSettled`, bukan all-or-nothing.

---

## 47. Security

Treat provider executable dan output sebagai untrusted boundary.

Jangan:

```ts
exec(`${provider} ${userInput}`)
```

Gunakan executable + argument array:

```ts
spawn(executablePath, args)
```

Jika user memilih custom executable:

```text
validate exists
validate executable
store absolute path
```

Jangan menerima arbitrary shell prefix/suffix.

---

## 48. Auth Secrets

Default:

```text
provider owns provider credentials
```

Aplikasi tidak menyalin:

```text
API keys
OAuth token
session cookie
```

Jika integrasi tertentu membutuhkan secret langsung:

```text
OS keychain
```

bukan plain SQLite.

---

## 49. Session Persistence

Table:

```text
agent_sessions
```

Fields:

```text
id
chat_id
task_id
provider_id
connection_id
model_id
provider_session_id
status
created_at
updated_at
```

`provider_session_id` nullable karena ada provider stateless.

---

## 50. Stateless Provider

Jika provider tidak punya persistent session:

```text
app chat history
  ↓
adapter rebuilds context
  ↓
new provider invocation
```

Visible chat history tetap source of truth aplikasi.

---

## 51. CLI Update Check

Pisahkan:

```text
Loom app update
```

dengan:

```text
provider CLI update
```

Per provider:

```ts
type ProviderUpdateInfo = {
  supported: boolean;
  currentVersion?: string;
  latestVersion?: string;
  updateAvailable?: boolean;
};
```

Tidak semua provider wajib mendukung latest-version lookup.

---

## 52. Testing

Setiap adapter punya fixtures.

Example:

```text
providers/antigravity/test/fixtures/
├── models.json
├── stream.jsonl
├── auth-error.txt
└── version.txt
```

Test:

```text
model parser
event parser
auth status
version parser
error normalization
cancel behavior
```

Tambahkan shared provider contract tests:

```text
definition valid
model IDs unique
normalized events valid
failure isolated
```

---

## 53. Recommended Implementation Order

### Phase 1 — Provider Core

- [ ] `ProviderDefinition`
- [ ] `ProviderConnection`
- [ ] `AgentModel`
- [ ] `ProviderCapability`
- [ ] `CliProviderAdapter`
- [ ] `ProviderRegistry`
- [ ] `ProviderManager`
- [ ] `AgentRuntimeSelection`

### Phase 2 — Migrate OpenCode

- [ ] pindahkan existing OpenCode integration ke adapter
- [ ] Chat tidak lagi import OpenCode-specific code
- [ ] normalize session
- [ ] normalize event
- [ ] normalize model
- [ ] existing behavior tetap bekerja

**Ini proof utama arsitektur.**

### Phase 3 — Model Catalog

- [ ] ModelCatalog
- [ ] SQLite cache
- [ ] `/api/models`
- [ ] refresh events
- [ ] grouped selector di Chat

### Phase 4 — Second Provider

Implement satu provider kedua yang behavior-nya berbeda dari OpenCode.

Recommended:

```text
Claude Code atau Codex
```

Tujuan:

```text
membuktikan abstraction benar-benar generic
```

Jika provider kedua mengharuskan banyak perubahan di Chat, abstraction belum cukup baik.

### Phase 5 — Auth Abstraction

- [ ] provider-managed auth
- [ ] terminal auth
- [ ] browser auth
- [ ] auth status UI
- [ ] timeout/cancel

### Phase 6 — Antigravity

- [ ] detection
- [ ] version
- [ ] auth
- [ ] model discovery
- [ ] session execution
- [ ] stream parser
- [ ] cancel
- [ ] error mapping
- [ ] fixtures/tests

### Phase 7 — Provider Settings UX

- [ ] parallel provider checks
- [ ] connect/disconnect
- [ ] provider detail
- [ ] models list
- [ ] refresh models
- [ ] update status

### Phase 8 — Runtime Preferences

- [ ] global default
- [ ] project default
- [ ] chat override
- [ ] task override

---

## 54. MVP Provider Scope

Target awal:

```text
OpenCode
Claude Code
Codex
Antigravity
```

Provider lain seperti Grok dapat tampil sebagai:

```text
Coming soon
```

sampai adapter benar-benar diuji.

Jangan menyebut provider “supported” hanya karena executable berhasil dideteksi.

---

## 55. Definition of Done

Fitur dianggap selesai jika:

1. OpenCode bukan dependency langsung dari Chat.
2. Semua provider diregistrasikan melalui `ProviderRegistry`.
3. User dapat connect provider yang sudah terinstall.
4. Authentication status tampil benar.
5. Setelah connect, adapter dapat menemukan model jika provider mendukungnya.
6. Model yang ditemukan otomatis muncul di Chat selector.
7. User dapat memilih provider + model.
8. Message dieksekusi melalui adapter provider yang benar.
9. Streaming output dinormalisasi menjadi `AgentEvent`.
10. Chat UI tidak memiliki provider-specific branching.
11. Satu provider gagal tidak merusak provider lain.
12. Provider baru dapat ditambahkan terutama lewat folder adapter baru.
13. Kanban/Scheduler dapat menggunakan provider/model selection yang sama.
14. Progress tetap bekerja tanpa mengetahui provider-specific output.

---

## 56. Non-Goals

Belum perlu:

- cloud provider marketplace
- remote provider server
- OAuth broker sendiri
- API key vault sendiri
- auto-install semua CLI
- auto-update provider tanpa approval
- unified token/cost accounting sempurna
- third-party provider plugin marketplace

Fokus:

> **Local CLI providers → common adapter → common model catalog → common agent runtime.**

---

## 57. Final Mental Model

```text
                 Application Core

Chat ────────┐
Kanban ──────┼────► AgentRuntime
Scheduler ───┤          │
Progress ────┘          ▼
                     ModelRef
                        │
                        ▼
                 ProviderRegistry
                        │
        ┌───────────────┼───────────────┐
        ▼               ▼               ▼
    OpenCode       Claude Code         Codex
     Adapter         Adapter          Adapter
        │               │               │
        └───────────────┼───────────────┘
                        │
                  Antigravity
                     Adapter
                        │
                        ▼
                   Local CLIs
```

Provider baru tidak boleh membutuhkan redesign Chat/Kanban/Progress. Tambahkan adapter, register, expose capabilities/models, selesai.
