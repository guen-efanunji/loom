# V2 — Parallel Agents

> Goal: menjalankan beberapa OpenCode agents secara bersamaan dalam project yang sama tanpa saling merusak workspace.

Prerequisite: V1 stabil.

---

## 1. Target V2

User dapat membuat:

```text
Frontend
Backend
Tests
```

dan menjalankannya bersamaan:

```text
             Project
               │
       ┌───────┼───────┐
       ▼       ▼       ▼
   Frontend Backend   Tests
       │       │       │
       ▼       ▼       ▼
   worktree worktree worktree
       │       │       │
       ▼       ▼       ▼
    agent A agent B agent C
```

---

## 2. Main Features

- multi-task execution
- concurrency scheduler
- isolated Git worktrees
- independent OpenCode sessions
- task queue
- cancel/retry
- per-task logs/status
- parallel UI
- merge conflict detection

---

## 3. Update Domain Model

### AgentRun

```ts
export type AgentRunStatus =
  | "queued"
  | "running"
  | "waiting_permission"
  | "completed"
  | "failed"
  | "cancelled";

export type AgentRun = {
  id: string;
  taskId: string;
  sessionId: string | null;

  status: AgentRunStatus;

  startedAt: string | null;
  completedAt: string | null;
};
```

Task dan run harus terpisah.

```text
Task
 ├── Run #1
 ├── retry #2
 └── retry #3
```

---

## 4. Scheduler

Buat:

```text
packages/orchestrator/src/scheduler.ts
```

Interface:

```ts
export interface Scheduler {
  enqueue(taskId: string): Promise<void>;
  dispatch(): Promise<void>;
  cancel(taskId: string): Promise<void>;
}
```

Config:

```ts
export type SchedulerConfig = {
  maxConcurrentAgents: number;
  maxConcurrentAgentsPerProject: number;
};
```

Default:

```text
global = 3
per project = 3
```

---

## 5. Scheduler State

```text
queued
   ↓
preparing
   ↓
running
   ├── completed
   ├── failed
   └── cancelled
```

Scheduler harus recover setelah daemon restart.

Saat startup:

```text
load unfinished runs
    ↓
check OpenCode session/process
    ↓
reconcile state
```

---

## 6. Parallel Worktree Rules

Setiap task:

```text
~/.loom/worktrees/<project>/<task>
```

Tidak boleh share writable workspace.

Contoh:

```text
~/.loom/worktrees/app/01-frontend
~/.loom/worktrees/app/02-backend
~/.loom/worktrees/app/03-tests
```

---

## 7. Task UI

Project screen:

```text
my-app

● Frontend dashboard
  Running · 01:42

● Backend analytics API
  Running · 01:20

○ Integration tests
  Queued

✓ Database schema
  Completed
```

Actions:

```text
New Task
Run
Cancel
Retry
Review
Merge
Discard
```

---

## 8. Batch Task Creation

User dapat memasukkan beberapa task:

```ts
type CreateTaskBatchInput = {
  projectId: string;
  tasks: Array<{
    title: string;
    prompt: string;
  }>;
};
```

API:

```text
POST /api/projects/:projectId/tasks/batch
```

---

## 9. Event Model V2

Tambahkan:

```ts
type DaemonEvent =
  | {
      type: "scheduler.changed";
      running: number;
      queued: number;
    }
  | {
      type: "run.started";
      taskId: string;
      runId: string;
    }
  | {
      type: "run.output";
      taskId: string;
      runId: string;
      payload: unknown;
    }
  | {
      type: "run.completed";
      taskId: string;
      runId: string;
    };
```

---

## 10. Resource Control

Parallel agent bisa mahal.

Tambahkan guard:

```text
max concurrent agents
```

Future config:

```text
CPU-aware
memory-aware
provider-aware
```

V2 belum perlu adaptive scheduler.

---

## 11. Permission Handling

OpenCode mungkin membutuhkan user approval.

Task status:

```text
waiting_permission
```

UI:

```text
Backend API

Agent requests permission:

Run:
bun db:migrate

[Allow Once]
[Allow]
[Deny]
```

Jangan auto-approve command berisiko.

---

## 12. Merge Queue

Masalah:

```text
task A completed
task B completed
```

A di-merge dahulu.

B dibuat dari commit lama.

Sebelum merge B:

```text
check mergeability
```

Flow:

```text
completed
   ↓
ready_to_merge
   ↓
check target HEAD
   ↓
merge
```

---

## 13. Merge Conflict

Status baru:

```text
merge_conflict
```

Data:

```ts
type MergeConflict = {
  taskId: string;
  files: string[];
};
```

UI:

```text
Backend task

⚠ Merge conflict

src/lib/types.ts
src/routes/api/+server.ts

[View Conflict]
```

V2 belum perlu AI resolve.

---

## 14. Retry

Retry harus menghasilkan AgentRun baru.

```text
Task
 ├── Run 1 failed
 └── Run 2 running
```

Jangan overwrite histori run sebelumnya.

---

## 15. Task Output

Simpan output secara bounded.

Pilihan:

```text
SQLite metadata
+
rotating log files
```

Contoh:

```text
~/.loom/logs/tasks/<task-id>/<run-id>.log
```

Jangan membuat SQLite membengkak karena raw stream besar.

---

## 16. Terminal

V2 optional tetapi recommended.

Tambah:

- xterm.js
- PTY service
- terminal per workspace

Terminal harus selalu terikat ke worktree task, bukan main project secara default.

---

## 17. API

```text
POST /tasks
POST /tasks/batch

POST /tasks/:id/start
POST /tasks/:id/cancel
POST /tasks/:id/retry

GET /tasks/:id
GET /tasks/:id/runs

POST /tasks/:id/merge
POST /tasks/:id/discard
```

---

## 18. Failure Recovery

Handle daemon mati saat:

```text
3 agents running
```

Saat restart:

- reload DB
- detect orphan worktree
- reconnect/check OpenCode session bila memungkinkan
- otherwise mark run interrupted
- jangan otomatis delete worktree

Status:

```text
interrupted
```

---

## 19. Tests V2

### Scheduler

- concurrency max tidak dilanggar
- queued tasks mendapat slot
- cancellation melepas slot
- project concurrency berlaku

### Parallel Git

- dua worktree edit file berbeda
- dua worktree edit file sama
- merge A lalu B
- detect conflict

### Recovery

- simulate daemon restart
- preserve workspace
- preserve task state

---

## 20. Milestones

### M1 — AgentRun

- [ ] schema
- [ ] repository
- [ ] retry model

### M2 — Scheduler

- [ ] queue
- [ ] max concurrency
- [ ] per-project concurrency
- [ ] dispatch loop

### M3 — Parallel OpenCode

- [ ] independent sessions
- [ ] independent cwd
- [ ] cancellation

### M4 — UI

- [ ] task cards
- [ ] running indicators
- [ ] queue state
- [ ] run history

### M5 — Merge

- [ ] merge queue
- [ ] target HEAD check
- [ ] conflict detection

### M6 — Reliability

- [ ] restart recovery
- [ ] orphan cleanup
- [ ] bounded logs
- [ ] stress test

---

## 21. Definition of Done V2

V2 selesai jika user dapat membuat:

```text
Frontend task
Backend task
```

kemudian keduanya:

- berjalan bersamaan;
- memakai OpenCode session berbeda;
- memakai Git worktree berbeda;
- output/status muncul real-time;
- dapat direview secara independen;
- dapat di-merge satu per satu;
- conflict terdeteksi dengan aman.

---

## 22. Tidak Masuk V2

- planner otomatis
- DAG dependencies
- AI conflict resolution
- cloud auth
- Turso
- billing
- remote execution
- updater production
- marketplace agent

Fokus V2: **parallel execution yang stabil**.
