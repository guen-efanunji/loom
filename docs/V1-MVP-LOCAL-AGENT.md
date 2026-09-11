# V1 — MVP Local Agent

> Goal: membuktikan core product bekerja end-to-end:
> user membuka project lokal, membuat task, OpenCode menjalankan agent di worktree terisolasi, hasilnya bisa direview lalu di-merge/discard.

## 1. Target V1

V1 **bukan** clone penuh OpenChamber.

V1 hanya harus membuktikan flow utama:

```text
Open Project
    ↓
Create Task
    ↓
Create Git Worktree
    ↓
Create OpenCode Session
    ↓
Run Agent
    ↓
Stream Status / Output
    ↓
Review Diff
    ↓
Merge / Discard
```

Satu task = satu workspace terisolasi.

---

## 2. Tech Stack

### Monorepo

- Better T Stack
- Bun
- Turborepo
- TypeScript strict
- Biome

### Web

- SvelteKit 5
- Svelte 5 Runes
- Tailwind CSS
- shadcn-svelte

### Local daemon

- Bun
- Hono
- WebSocket
- Zod/Valibot untuk runtime validation

### Local persistence

- SQLite
- Drizzle ORM

### Agent

- OpenCode Server (`opencode serve`)

### Git

- native Git CLI
- Git worktree

---

## 3. Bootstrap Project

Gunakan Better T Stack sebagai baseline.

Contoh:

```bash
bun create better-t-stack@latest loom \
  --frontend svelte \
  --backend hono \
  --runtime bun \
  --database sqlite \
  --orm drizzle \
  --addons turborepo biome
```

Sesuaikan opsi CLI jika versi Better T Stack yang dipakai memiliki perubahan.

---

## 4. Struktur Repository Target

```text
loom/
├── apps/
│   ├── web/
│   │   └── SvelteKit 5
│   │
│   └── daemon/
│       └── Bun + Hono
│
├── packages/
│   ├── protocol/
│   ├── database/
│   ├── opencode/
│   ├── worktree/
│   └── orchestrator/
│
├── turbo.json
├── biome.json
└── package.json
```

### Dependency rule

```text
web ──────────► protocol

daemon ───────► protocol
daemon ───────► database
daemon ───────► opencode
daemon ───────► worktree
daemon ───────► orchestrator
```

`web` tidak boleh mengakses filesystem, Git, atau OpenCode secara langsung.

---

## 5. Domain Model Minimal

### Project

```ts
export type Project = {
  id: string;
  name: string;
  path: string;
  defaultBranch: string;
  createdAt: string;
};
```

### Task

```ts
export type TaskStatus =
  | "queued"
  | "preparing"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type Task = {
  id: string;
  projectId: string;
  title: string;
  prompt: string;
  status: TaskStatus;

  workspaceId: string | null;
  sessionId: string | null;

  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};
```

### Workspace

```ts
export type Workspace = {
  id: string;
  taskId: string;
  projectId: string;

  path: string;
  branch: string;
  baseCommit: string;

  createdAt: string;
};
```

---

## 6. Database V1

Gunakan local SQLite.

Default:

```text
~/.loom/state.db
```

Tables:

```text
projects
tasks
workspaces
agent_runs
```

### Jangan simpan dahulu

- source code
- terminal history besar
- OpenCode messages penuh
- binary blobs
- credentials

---

## 7. Project Manager

Responsibilities:

- register local project
- validate Git repository
- detect default branch
- persist project metadata
- check project masih tersedia

API minimal:

```text
POST   /api/projects
GET    /api/projects
GET    /api/projects/:id
DELETE /api/projects/:id
```

Payload add project:

```json
{
  "path": "/Users/name/Projects/my-app"
}
```

Validation:

- directory exists
- `.git` / Git repository valid
- executable Git tersedia

---

## 8. OpenCode Manager

Buat abstraction sendiri.

```ts
export interface OpenCodeManager {
  discover(): Promise<boolean>;
  start(): Promise<void>;
  health(): Promise<boolean>;
  stop(): Promise<void>;
}
```

Startup daemon:

```text
check opencode
    ↓
check running server
    ↓
start `opencode serve`
    ↓
wait until healthy
```

Jangan campurkan lifecycle process dengan UI.

---

## 9. OpenCode Adapter

API internal:

```ts
export interface AgentRuntime {
  createSession(input: {
    cwd: string;
    title: string;
  }): Promise<{ id: string }>;

  prompt(input: {
    sessionId: string;
    prompt: string;
  }): Promise<void>;

  abort(sessionId: string): Promise<void>;

  getDiff(sessionId: string): Promise<unknown>;
}
```

Walaupun runtime awal hanya OpenCode, jangan expose OpenCode-specific object ke seluruh codebase.

Implementasi:

```text
packages/opencode
```

---

## 10. Worktree Manager

Critical component.

Directory:

```text
~/.loom/worktrees/<project-id>/<task-id>
```

Branch convention:

```text
loom/<task-id>
```

Flow:

```text
main project
    ↓
get HEAD commit
    ↓
git worktree add
    ↓
isolated branch
```

Interface:

```ts
export interface WorktreeManager {
  create(input: {
    projectPath: string;
    projectId: string;
    taskId: string;
  }): Promise<Workspace>;

  remove(workspace: Workspace): Promise<void>;

  merge(workspace: Workspace): Promise<void>;

  discard(workspace: Workspace): Promise<void>;
}
```

### Safety

Jangan pernah:

- `git reset --hard` di main workspace
- delete user branch otomatis tanpa verifikasi
- overwrite uncommitted user files

---

## 11. Task Orchestrator

Flow:

```text
create task
   ↓
status=queued
   ↓
create workspace
   ↓
status=preparing
   ↓
create OpenCode session
   ↓
status=running
   ↓
send prompt
   ↓
wait completed/error
```

Interface:

```ts
export interface TaskOrchestrator {
  create(input: CreateTaskInput): Promise<Task>;
  start(taskId: string): Promise<void>;
  cancel(taskId: string): Promise<void>;
}
```

V1 cukup support **1 active task** terlebih dahulu jika parallel execution belum stabil.

---

## 12. Event Protocol

Browser jangan polling terus.

Gunakan WebSocket.

Events:

```ts
export type DaemonEvent =
  | {
      type: "task.created";
      task: Task;
    }
  | {
      type: "task.started";
      taskId: string;
    }
  | {
      type: "task.updated";
      task: Task;
    }
  | {
      type: "task.completed";
      taskId: string;
    }
  | {
      type: "task.failed";
      taskId: string;
      message: string;
    };
```

Semua event contract berada di:

```text
packages/protocol
```

---

## 13. UI V1

Layout minimal:

```text
┌───────────────┬──────────────────────────────┐
│ Projects      │ Task                         │
│               │                              │
│ my-app        │ Implement login page         │
│               │                              │
│               │ Status: Running              │
│               │                              │
│               │ Agent Activity               │
│               │ ...                          │
│               │                              │
│               │ [Cancel]                     │
├───────────────┴──────────────────────────────┤
│ Diff                                         │
│                                             │
│ [Merge] [Discard]                           │
└─────────────────────────────────────────────┘
```

Screens:

```text
/projects
/project/:id
/task/:id
```

---

## 14. Svelte 5 State

Gunakan Runes.

Contoh:

```ts
class TaskStore {
  tasks = $state<Record<string, Task>>({});

  upsert(task: Task) {
    this.tasks[task.id] = task;
  }
}
```

Hindari menambahkan state library sebelum benar-benar diperlukan.

---

## 15. Diff Review

V1 harus bisa:

- daftar changed files
- additions/deletions
- unified diff
- merge
- discard

Jangan buat diff editor kompleks dahulu.

---

## 16. Merge Flow

V1:

```text
task completed
    ↓
review diff
    ↓
merge
    ↓
remove worktree
```

Strategi sederhana:

```text
squash merge
```

atau commit task kemudian cherry-pick.

Pilih satu strategi dan konsisten.

---

## 17. Error Handling Minimal

Handle:

- OpenCode tidak tersedia
- Git tidak tersedia
- project bukan repository
- worktree creation gagal
- agent gagal
- daemon restart
- workspace hilang
- merge conflict

Jangan swallow error.

UI harus menampilkan actionable message.

---

## 18. CLI V1

Command awal:

```bash
loom
loom --version
loom doctor
```

`loom`:

```text
start daemon
    ↓
start/check OpenCode
    ↓
serve UI
    ↓
open browser
```

Default:

```text
http://127.0.0.1:4317
```

Bind hanya ke:

```text
127.0.0.1
```

---

## 19. Security V1

Wajib:

- localhost only
- strict CORS
- random local auth token
- validate filesystem paths
- shell commands tidak menerima raw concatenated input

Simpan token:

```text
~/.loom/config.json
```

---

## 20. Testing

### Unit

- worktree path
- branch naming
- task state transition
- OpenCode response parser

### Integration

- create temp Git repo
- create worktree
- mutate file
- merge
- remove worktree

### E2E

```text
open project
→ create task
→ task completes
→ diff visible
→ merge
```

---

## 21. Milestones

### M1 — Foundation

- [ ] Better T Stack scaffold
- [ ] monorepo cleanup
- [ ] strict TypeScript
- [ ] Biome
- [ ] shared protocol package

### M2 — Local daemon

- [ ] Hono server
- [ ] health endpoint
- [ ] WebSocket
- [ ] config directory
- [ ] SQLite connection

### M3 — Project & Git

- [ ] add project
- [ ] validate repository
- [ ] WorktreeManager
- [ ] cleanup flow

### M4 — OpenCode

- [ ] detect installation
- [ ] launch server
- [ ] create session
- [ ] send prompt
- [ ] abort

### M5 — Task

- [ ] create task
- [ ] execute task
- [ ] persist lifecycle
- [ ] task events

### M6 — UI

- [ ] project selector
- [ ] task form
- [ ] task status
- [ ] diff viewer
- [ ] merge/discard

### M7 — Hardening

- [ ] errors
- [ ] test suite
- [ ] cleanup orphan worktrees
- [ ] doctor command

---

## 22. Definition of Done V1

V1 selesai jika fresh user dapat:

```bash
loom
```

kemudian:

1. memilih Git project lokal;
2. membuat satu coding task;
3. task berjalan melalui OpenCode;
4. perubahan dibuat di Git worktree terpisah;
5. user melihat diff;
6. user bisa merge atau discard;
7. main workspace user tidak rusak.

---

## 23. Tidak Masuk V1

Jangan kerjakan dahulu:

- parallel agents
- task DAG
- planner agent
- cloud auth
- Turso
- billing
- remote access
- VS Code extension
- terminal penuh
- AI merge conflict resolver
- auto updater
- team collaboration

Selesaikan core loop terlebih dahulu.
