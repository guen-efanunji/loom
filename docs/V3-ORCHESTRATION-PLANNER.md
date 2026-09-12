# V3 — Orchestration, Planner & Task Graph

> Goal: mengubah aplikasi dari "OpenCode GUI dengan parallel tasks" menjadi coding orchestrator yang bisa memecah pekerjaan, mengatur dependency, dan mengintegrasikan hasil beberapa agent.

Prerequisite: V2 parallel execution stabil.

---

## 1. Target V3

User cukup menulis high-level goal:

```text
Implement notification system:
- realtime websocket backend
- notification center UI
- integration tests
```

Planner menghasilkan:

```text
                 Epic
                  │
          ┌───────┴───────┐
          ▼               ▼
       Backend         Frontend
          │               │
          └───────┬───────┘
                  ▼
                Tests
```

Scheduler menjalankan task berdasarkan dependency.

---

## 2. New Concepts

Tambahkan:

```text
Epic
Task Graph
Dependency
Artifact
Project Context
Planner Run
Integration Run
```

---

## 3. Epic

```ts
export type Epic = {
  id: string;
  projectId: string;

  title: string;
  prompt: string;

  status:
    | "planning"
    | "ready"
    | "running"
    | "completed"
    | "failed";

  createdAt: string;
};
```

---

## 4. Task Dependency

```ts
export type TaskDependency = {
  taskId: string;
  dependsOnTaskId: string;
};
```

Rules:

```text
task runnable =
all dependencies completed
```

Scheduler jangan hard-code hanya linear dependency.

Harus support DAG.

---

## 5. DAG Validation

Saat planner menghasilkan task graph:

- tidak boleh ada cycle
- semua dependency harus valid
- semua task harus berada pada Epic/Project sama
- task ID harus unique

Implement:

```text
packages/orchestrator/src/graph
```

Functions:

```ts
validateGraph()
detectCycle()
getRunnableTasks()
getBlockedTasks()
```

---

## 6. Planner Abstraction

Planner juga AgentRuntime, tetapi role-nya berbeda.

```ts
export interface Planner {
  plan(input: {
    projectId: string;
    goal: string;
    context: ProjectContext;
  }): Promise<TaskPlan>;
}
```

Structured output:

```ts
export type TaskPlan = {
  tasks: Array<{
    key: string;
    title: string;
    prompt: string;
    dependsOn: string[];
  }>;
};
```

Validate output dengan Zod/Valibot.

Jangan trust raw LLM JSON.

---

## 7. Planner Prompt Requirements

Planner harus mengetahui:

- project structure
- package manager
- framework
- conventions
- relevant files
- current branch
- test commands

Tetapi jangan dump seluruh repository.

Gunakan project context yang terkontrol.

---

## 8. Project Context

Directory opsional:

```text
.loom/
├── context.md
├── architecture.md
└── conventions.md
```

Local generated context:

```text
~/.loom/projects/<project-id>/
```

Type:

```ts
export type ProjectContext = {
  summary: string;
  architecture?: string;
  conventions?: string;
  commands: {
    install?: string;
    lint?: string;
    test?: string;
    build?: string;
  };
};
```

---

## 9. Artifacts

Agent dapat menghasilkan artifact untuk agent lain.

```ts
export type TaskArtifact = {
  id: string;
  taskId: string;

  type:
    | "api-contract"
    | "schema"
    | "decision"
    | "documentation"
    | "custom";

  path: string;
  summary: string;
};
```

Contoh:

```text
Backend task
   ↓
docs/api/notifications.md
   ↓
Frontend task reads contract
```

---

## 10. Jangan Share Chat Mentah

Hindari:

```text
Frontend Agent
   ↓
read entire Backend Agent conversation
```

Gunakan:

```text
artifact
summary
contract
decision
```

agar context deterministic dan hemat token.

---

## 11. Task Handoff

Saat dependency selesai:

```text
Backend completed
    ↓
collect artifacts
    ↓
build dependent context
    ↓
Frontend becomes runnable
```

---

## 12. Integration Stage

Parallel tasks bisa sukses sendiri tetapi gagal bersama.

Setelah graph selesai:

```text
all implementation tasks complete
        ↓
integration workspace
        ↓
merge selected outputs
        ↓
build/test/lint
```

Buat konsep:

```ts
type IntegrationRun = {
  id: string;
  epicId: string;
  status: string;
  workspacePath: string;
};
```

---

## 13. Integration Agent

Jika integration test gagal:

```text
Integration Agent
```

mendapat:

- merged diff
- build errors
- test errors
- artifacts/decisions

Tujuan:

```text
fix integration only
```

Jangan membiarkannya redesign seluruh feature tanpa approval.

---

## 14. AI Conflict Resolver

V3 optional advanced.

Flow:

```text
merge conflict detected
    ↓
create temporary resolution workspace
    ↓
resolution agent
    ↓
show proposed resolution
    ↓
user approves
```

Tidak boleh langsung auto-merge konflik ke main branch tanpa review.

---

## 15. Epic UI

```text
Notification System

● Backend websocket
  Completed

● Notification center
  Running

○ Integration tests
  Blocked by: Notification center

Progress 2 / 3
```

Graph visualization boleh sederhana dahulu.

Tidak harus memakai graph library besar.

---

## 16. Planner UI

Flow:

```text
New Work

Goal:
[ Implement realtime notification system ]

[Plan Tasks]
```

Review:

```text
Proposed plan

1. Backend websocket
   No dependencies

2. Notification UI
   No dependencies

3. Integration tests
   Depends on: 1, 2

[Edit]
[Start]
```

**User harus bisa mengedit plan sebelum execution.**

---

## 17. Scheduler V3

Scheduler sekarang mempertimbangkan:

```text
concurrency
+
dependencies
+
project
+
epic state
```

Pseudo:

```ts
const runnable = tasks.filter(
  (task) =>
    task.status === "queued" &&
    dependenciesCompleted(task) &&
    hasCapacity(task.projectId)
);
```

---

## 18. Context Budget

Jangan kirim semua context ke semua agent.

Buat:

```text
ContextBuilder
```

Input:

- task
- dependencies
- relevant artifacts
- project conventions

Output:

- compact agent context

---

## 19. Auditability

Simpan decision/event penting:

```text
planner.created
plan.approved
task.started
artifact.created
task.completed
integration.started
integration.failed
integration.completed
```

User harus bisa mengetahui mengapa task tertentu dibuat.

---

## 20. Testing

### DAG

- cycle detection
- independent tasks parallel
- blocked task tidak jalan
- dependency failure

### Planner

- invalid structured output rejected
- duplicate keys rejected
- missing dependency rejected

### Integration

- merge multiple task branches
- run test command
- preserve failures
- resolution workflow

---

## 21. Milestones

### M1 — Epic

- [x] schema
- [x] lifecycle
- [x] UI

### M2 — DAG

- [x] dependencies
- [x] graph validation
- [x] scheduler integration

### M3 — Planner

- [x] planner prompt
- [x] structured output
- [x] editable plan UI

### M4 — Context

- [x] project context
- [x] context builder
- [x] conventions support

### M5 — Artifacts

- [x] artifact schema
- [x] handoff
- [x] dependent context

### M6 — Integration

- [x] integration workspace
- [x] test/build stage
- [x] integration result

### M7 — AI Resolution

- [x] conflict resolution agent
- [x] approval workflow
- [x] guardrails

---

## 22. Definition of Done V3

V3 selesai jika user dapat:

1. memasukkan satu high-level feature;
2. planner membuat beberapa task;
3. user mereview/mengedit plan;
4. task independen berjalan paralel;
5. task dependent menunggu dengan benar;
6. artifact/context bisa diteruskan ke task berikutnya;
7. hasil semua task diintegrasikan;
8. build/test integration dijalankan;
9. user mereview hasil akhir sebelum merge.

Pada titik ini aplikasi sudah benar-benar menjadi **multi-agent coding orchestrator**.

---

## 23. Tidak Masuk V3

- SaaS collaboration
- billing production
- remote worker
- organization/team permissions
- hosted execution
- VS Code extension
- marketplace

Fokus V3: **intelligent orchestration**.
