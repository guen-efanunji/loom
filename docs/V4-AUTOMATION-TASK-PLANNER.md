# DESIGN.md — Chat → Planner → Kanban Automation

## 1. Tujuan

Fitur ini memungkinkan user menulis brief besar di halaman Chat, lalu sistem otomatis membedah brief tersebut menjadi task terstruktur dan memasukkannya ke Kanban.

Target flow:

```text
Chat
  ↓
User memasukkan brief / DESIGN.md / PRD / feature request
  ↓
Planner
  ↓
Structured Plan
  ↓
Validator
  ↓
Task Creation
  ↓
Kanban
  ↓
Scheduler
  ↓
Progress
```

Contoh input:

```text
DESIGN.md — Aroma Atas Coffee

Landing page coffee shop.
HTML, CSS, JavaScript.
...
```

Expected result:

```text
1. Build semantic HTML structure
2. Implement CSS tokens and typography
3. Build navigation
4. Build hero
5. Build menu section
6. Build place/origin sections
7. Build reservation/footer
8. Implement motion.js
9. Accessibility pass
10. Responsive/performance QA
```

Task kemudian otomatis masuk ke Kanban.

---

## 2. Pembagian Tanggung Jawab Halaman

### Chat

Tempat user memberikan intent.

```text
User
  ↓
Goal / brief / request
  ↓
Planner
```

Chat bukan source of truth execution.

### Kanban

Source of truth pekerjaan.

```text
BACKLOG
READY
RUNNING
REVIEW
DONE
```

Semua hasil planner harus menjadi Task sebelum bisa dieksekusi.

### Progress

Source of truth runtime.

```text
Task
  ↓
AgentRun
  ↓
OpenCode
```

Progress menjawab:

```text
Apa yang sedang dikerjakan agent sekarang?
```

---

## 3. Prinsip Arsitektur

Pisahkan tiga entity utama:

```text
Plan
Task
AgentRun
```

Jangan:

```text
Chat message
  ↓
langsung spawn OpenCode
```

Gunakan:

```text
Chat message
  ↓
Plan
  ↓
Task
  ↓
AgentRun
```

Rule utama:

```text
AI proposes work.
Application validates work.
Kanban owns work.
Scheduler executes work.
OpenCode performs work.
Progress reports work.
```

AI tidak menjadi source of truth state aplikasi.

---

## 4. Mode di Chat

Sediakan tiga mode:

```text
Chat
Plan
Build
```

### Chat

Normal conversation.

Tidak membuat task.

### Plan

Flow:

```text
message
  ↓
planner
  ↓
draft plan
  ↓
user review
  ↓
add to Kanban
```

### Build

Flow:

```text
message
  ↓
planner
  ↓
validator
  ↓
create tasks
  ↓
scheduler
```

Default:

```text
Auto-start runnable tasks = OFF
```

---

## 5. Slash Commands

Support:

```text
/plan
/build
```

Contoh:

```text
/plan

DESIGN.md ...
```

atau:

```text
/build

Implement authentication system...
```

---

## 6. Entity Plan

```ts
export type PlanStatus =
  | "draft"
  | "validated"
  | "approved"
  | "executing"
  | "completed"
  | "failed";

export type Plan = {
  id: string;
  projectId: string;
  sourceMessageId: string;
  title: string;
  summary: string;
  status: PlanStatus;
  createdAt: string;
  approvedAt: string | null;
};
```

---

## 7. Entity PlanTask

PlanTask belum menjadi Kanban Task.

```ts
export type PlanTask = {
  key: string;
  title: string;
  description: string;

  priority:
    | "low"
    | "medium"
    | "high";

  dependencies: string[];

  acceptanceCriteria: string[];

  suggestedFiles?: string[];

  parallelGroup?: string;
};
```

Contoh:

```json
{
  "key": "hero",
  "title": "Implement hero section",
  "description": "Create the Aroma Atas hero layout.",
  "priority": "high",
  "dependencies": [
    "semantic-html",
    "design-system"
  ],
  "acceptanceCriteria": [
    "Desktop layout uses 7/5 columns",
    "Mobile layout is stacked",
    "Hero uses min-height 72vh",
    "Image uses 4/5 aspect ratio",
    "No drop shadow"
  ],
  "suggestedFiles": [
    "index.html",
    "styles.css"
  ],
  "parallelGroup": "sections"
}
```

---

## 8. Kanban Task Model

```ts
export type TaskStatus =
  | "backlog"
  | "ready"
  | "running"
  | "review"
  | "done"
  | "failed"
  | "blocked";

export type Task = {
  id: string;
  projectId: string;
  planId: string | null;

  title: string;
  description: string;

  status: TaskStatus;
  priority: "low" | "medium" | "high";

  acceptanceCriteria: string[];

  suggestedFiles: string[];

  source:
    | "manual"
    | "planner";

  createdAt: string;
};
```

Dependency sebaiknya tidak disimpan sebagai array di row Task.

Gunakan table terpisah.

---

## 9. Task Dependencies

```ts
export type TaskDependency = {
  taskId: string;
  dependsOnTaskId: string;
};
```

Database:

```text
task_dependencies
-----------------
task_id
depends_on_task_id
```

Rules:

```text
Task READY =
all dependencies DONE
```

Task dengan dependency belum selesai:

```text
BLOCKED
```

---

## 10. Database Changes

Tambahkan:

```text
plans
plan_tasks
task_dependencies
```

Optional:

```text
planner_runs
```

---

## 11. Struktur Package

```text
packages/
└── automation/
    ├── planner.ts
    ├── prompt.ts
    ├── schema.ts
    ├── validator.ts
    ├── converter.ts
    └── context-builder.ts
```

Responsibilities:

```text
planner
  generate structured plan

validator
  validate structure + graph

converter
  convert PlanTask → Task

context-builder
  collect project context

prompt
  planner system prompt
```

---

## 12. Planner Interface

```ts
export interface Planner {
  createPlan(input: {
    projectId: string;
    message: string;
    context: ProjectContext;
  }): Promise<PlannerResult>;
}
```

```ts
export type PlannerResult = {
  title: string;
  summary: string;
  tasks: PlanTask[];
};
```

---

## 13. Structured Output

Jangan parse Markdown response AI.

Gunakan schema validation.

Contoh Zod:

```ts
import { z } from "zod";

export const PlanTaskSchema = z.object({
  key: z.string().min(1),

  title: z.string().min(1),

  description: z.string().min(1),

  priority: z.enum([
    "low",
    "medium",
    "high"
  ]),

  dependencies: z
    .array(z.string())
    .default([]),

  acceptanceCriteria: z
    .array(z.string().min(1))
    .min(1),

  suggestedFiles: z
    .array(z.string())
    .default([]),

  parallelGroup: z
    .string()
    .optional()
});

export const PlannerResultSchema = z.object({
  title: z.string(),
  summary: z.string(),

  tasks: z
    .array(PlanTaskSchema)
    .min(1)
    .max(30)
});
```

---

## 14. Plan Validation

Setelah structured output lolos schema:

```text
validate keys
validate dependencies
validate cycles
validate task count
validate duplicates
```

### Unique key

Tidak boleh:

```text
hero
hero
```

### Valid dependency

Tidak boleh:

```text
hero depends on css-system
```

jika `css-system` tidak ada.

### Cycle detection

Tidak boleh:

```text
A depends B
B depends C
C depends A
```

Validator harus reject.

---

## 15. Plan Repair

Jika planner output invalid:

```text
Planner
  ↓
Validator
  ↓
Invalid
  ↓
Repair Prompt
  ↓
Validator
```

Maximum:

```text
1 repair attempt
```

Setelah itu tampilkan error.

Jangan infinite retry.

---

## 16. Planner Prompt Baseline

```text
You are the planning engine for a coding agent orchestrator.

Your job is to convert a user's development request into a small,
high-quality implementation plan.

Rules:

- Produce implementation tasks, not conversational advice.
- Preserve explicit constraints from the user.
- Do not invent requirements.
- Do not add features explicitly excluded by the user.
- Prefer independently executable tasks where practical.
- Identify dependencies explicitly.
- Avoid micro-tasks.
- Avoid tasks that are too broad.
- Every task must have measurable acceptance criteria.
- Respect the project's actual technology stack.
- Respect requested files and architecture.
- Prefer parallelizable work where safe.
- Final QA tasks should depend on implementation tasks.
- Do not include deployment unless requested.
- Do not include documentation unless needed by the request.
- Return only structured output matching the provided schema.
```

---

## 17. Project Context Builder

Minimal:

```ts
export type ProjectContext = {
  projectName: string;

  stack: string[];

  packageManager?: string;

  files: string[];

  scripts: Record<string, string>;

  conventions?: string;

  currentBranch?: string;
};
```

Collect:

```text
package.json
file tree
framework config
README
project instructions
```

Jangan dump seluruh repository.

---

## 18. Context Limits

Recommended:

```text
max file tree depth: 4
```

Ignore:

```text
node_modules
.git
dist
build
.svelte-kit
coverage
vendor
```

---

## 19. Chat Flow

Saat user mengirim Plan mode:

```text
POST /api/chat/messages
```

message stored.

Kemudian:

```text
POST /api/plans
```

Backend:

```text
message
  ↓
contextBuilder
  ↓
planner
  ↓
schema validation
  ↓
graph validation
  ↓
persist draft plan
```

---

## 20. Chat Response

Contoh:

```text
I broke this into 10 tasks.

6 can run independently.
4 depend on earlier work.

[Review Plan]
[Add to Kanban]
[Add & Start]
```

Jangan tampilkan raw JSON planner.

---

## 21. Plan Preview UI

```text
Aroma Atas Landing Page
10 tasks

1. Semantic page structure
   HIGH
   No dependencies

2. Design system
   HIGH
   Depends on: Semantic page structure

3. Navigation
   MEDIUM
   Depends on: Design system

...

[Edit Plan]
[Add to Kanban]
```

---

## 22. Editable Plan

User harus bisa:

```text
rename task
edit description
edit acceptance criteria
change priority
remove task
add task
change dependency
```

Setelah edit:

```text
revalidate DAG
```

---

## 23. Plan → Kanban Conversion

```ts
export interface PlanConverter {
  convert(planId: string): Promise<Task[]>;
}
```

Flow:

```text
load Plan
  ↓
create Task IDs
  ↓
map PlanTask.key → Task.id
  ↓
create dependencies
  ↓
set initial statuses
```

Initial status:

```text
no dependencies
  ↓
READY

has dependencies
  ↓
BLOCKED
```

---

## 24. Transaction

Conversion wajib atomic.

```ts
db.transaction(async (tx) => {
  createTasks();
  createDependencies();
  updatePlanStatus();
});
```

Kalau salah satu gagal:

```text
rollback all
```

Jangan membuat setengah plan masuk Kanban.

---

## 25. Kanban Integration

Columns:

```text
BACKLOG
READY
RUNNING
REVIEW
DONE
```

Untuk blocked task, rekomendasi:

```text
tetap di backlog
+
badge "Blocked"
```

Tidak harus membuat column BLOCKED.

---

## 26. Task Card

Planner-generated task:

```text
Hero section

HIGH

Generated from:
Aroma Atas plan

Blocked by:
Design system

Acceptance:
5 checks
```

Badge:

```text
AI Planned
```

---

## 27. Realtime Sync

Setelah conversion:

```ts
eventBus.publish({
  type: "plan.tasksCreated",
  planId,
  taskIds
});
```

Kanban update via WebSocket.

Tidak perlu reload.

---

## 28. Automation Setting

```text
Planning Automation

Mode:
● Review before creating tasks
○ Automatically create Kanban tasks
○ Automatically create and start
```

Recommended default:

```text
Review before creating tasks
```

---

## 29. Auto Create Mode

Flow:

```text
Chat brief
  ↓
Planner
  ↓
Validator
  ↓
Create Task
  ↓
Kanban
```

Chat:

```text
✓ Created 10 Kanban tasks

[Open Kanban]
```

Tidak menjalankan agent.

---

## 30. Auto Build Mode

Flow:

```text
Chat brief
  ↓
Planner
  ↓
Validator
  ↓
Task creation
  ↓
Scheduler dispatch
```

Hanya task `READY` yang dijalankan.

---

## 31. Scheduler Integration

```ts
const runnable = tasks.filter(
  (task) =>
    task.status === "ready" &&
    dependenciesAreDone(task)
);
```

Concurrency limit tetap berlaku.

Contoh:

```text
maxAgents = 3
```

Planner menghasilkan 6 runnable task:

```text
3 RUNNING
3 READY
```

---

## 32. Dependency Unlock

Ketika task selesai:

```text
task.completed
  ↓
dependencyResolver
  ↓
find blocked dependents
  ↓
all dependencies done?
  ↓
yes
  ↓
status READY
```

Event:

```ts
{
  type: "task.ready",
  taskId
}
```

---

## 33. Failure Propagation

Jika dependency gagal:

```text
A FAILED
  ↓
B depends A
  ↓
B remains BLOCKED
```

Jangan otomatis mark B failed.

UI:

```text
Blocked because:
"Design System" failed
```

Actions:

```text
Retry dependency
Remove dependency
Run anyway
```

---

## 34. Progress Integration

Progress page:

```text
Aroma Atas Landing Page

Progress 40%
4 / 10 done

Agents
3 running
2 ready
1 blocked
```

---

## 35. Progress Calculation

Gunakan:

```text
done tasks / total tasks
```

Jangan gunakan AI-generated percentage.

---

## 36. Plan Status Lifecycle

```text
DRAFT
  ↓
VALIDATED
  ↓
APPROVED
  ↓
EXECUTING
  ↓
COMPLETED
```

Failed generation:

```text
FAILED
```

---

## 37. Chat Timeline Events

Chat dapat menampilkan event penting:

```text
Plan created
10 tasks

Tasks added to Kanban

3 agents started

Hero completed

Menu completed

Plan 50% complete
```

Jangan spam tool call OpenCode ke chat.

---

## 38. Source Linking

Plan harus menyimpan:

```text
sourceMessageId
```

Task:

```text
planId
```

Navigasi:

```text
Task
  ↓
View source plan
  ↓
View original chat
```

---

## 39. Contoh Decomposition Aroma Atas

```text
1. Semantic HTML foundation

2. Design tokens, fonts, responsive primitives
   depends: 1

3. Header and mobile navigation
   depends: 2

4. Hero
   depends: 2

5. Hours, address, and menu
   depends: 2

6. Place and coffee origins
   depends: 2

7. Reservation and footer
   depends: 2

8. motion.js interactions
   depends: 3,4,5,6,7

9. Accessibility pass
   depends: 3,4,5,6,7,8

10. Responsive and performance QA
    depends: 9
```

Graph:

```text
1
↓
2
↓
┌────────┬────────┬────────┬────────┬────────┐
3        4        5        6        7
└────────┴────────┴────────┴────────┴────────┘
                  ↓
                  8
                  ↓
                  9
                  ↓
                 10
```

---

## 40. Task Granularity

Hindari micro-task.

Bad:

```text
Create h1
Create paragraph
Create button
Create image
```

Good:

```text
Implement hero section
```

Hindari juga task terlalu besar.

Bad:

```text
Build entire landing page
```

Recommended:

```text
5–15 tasks
```

Maximum awal:

```text
30 tasks
```

---

## 41. Acceptance Criteria

Wajib konkret.

Bad:

```text
Looks good
```

Good:

```text
- Header is 64px high
- Header uses espresso background
- Mobile navigation uses text "Menu"
- Escape closes mobile dialog
```

---

## 42. Suggested Files

`suggestedFiles` hanya hint.

OpenCode tetap boleh menemukan file lain yang relevan.

---

## 43. API Endpoints

Recommended:

```text
POST /api/plans
GET  /api/plans/:id
PATCH /api/plans/:id

POST /api/plans/:id/validate
POST /api/plans/:id/approve
POST /api/plans/:id/tasks
POST /api/plans/:id/start
```

---

## 44. Create Plan API

Request:

```json
{
  "projectId": "project_123",
  "sourceMessageId": "msg_123",
  "message": "DESIGN.md ..."
}
```

Response:

```json
{
  "planId": "plan_123",
  "status": "validated"
}
```

---

## 45. Idempotency

Jika user double-click:

```text
Add to Kanban
```

jangan create duplicate tasks.

Plan harus punya:

```text
convertedAt
```

atau equivalent unique protection.

---

## 46. Planner Run Record

Recommended:

```ts
type PlannerRun = {
  id: string;
  planId: string;

  status:
    | "running"
    | "completed"
    | "failed";

  model?: string;

  startedAt: string;
  completedAt: string | null;
};
```

---

## 47. Requirement Extraction

Untuk brief panjang, optional internal representation:

```ts
type RequirementSet = {
  goals: string[];
  constraints: string[];
  exclusions: string[];
  acceptanceCriteria: string[];
};
```

Sangat berguna untuk brief dengan banyak:

```text
must
must not
design token
motion rule
accessibility rule
```

---

## 48. Preserve Exclusions

Planner wajib menjaga bagian seperti:

```text
Yang tidak dibangun di v1
```

Contoh:

```text
dark mode
login
blog
slider
```

Jangan menghasilkan task tersebut.

---

## 49. Editing Setelah Execution Mulai

Untuk task RUNNING atau DONE:

- jangan ubah dependency sembarangan
- title boleh dibatasi
- acceptance criteria edit harus jelas
- task baru tetap boleh ditambahkan

Recommended:

```text
lock dependency edits for RUNNING/DONE tasks
```

---

## 50. Security

Planner input dianggap untrusted.

Jangan:

```text
execute commands from brief
```

Planner hanya menghasilkan data.

Execution terjadi setelah Task masuk scheduler.

---

## 51. Observability

Structured events:

```text
plan.created
plan.validated
plan.validation_failed
plan.approved
plan.converted
plan.started
task.unblocked
```

---

## 52. Testing

### Unit

- PlannerResult schema
- duplicate key validation
- dependency validation
- cycle detection
- status calculation
- PlanTask → Task conversion

### Integration

```text
create message
→ create plan
→ validate
→ convert
→ tasks persisted
→ dependencies persisted
```

### Scheduler Integration

```text
A ready
B depends A
C depends A

start A
complete A

expect:
B READY
C READY
```

### Failure

```text
A failed
B depends A

expect:
B BLOCKED
```

### Idempotency

```text
convert plan twice
```

expect:

```text
no duplicate tasks
```

---

## 53. E2E Scenario

```text
User opens Chat

selects Plan

pastes DESIGN.md

Planner generates 10 tasks

User reviews plan

click Add to Kanban

Kanban instantly shows 10 tasks

tasks without dependencies are READY

user clicks Start Ready Tasks

scheduler starts max allowed agents

Progress displays live agent execution
```

---

## 54. Milestones

### M1 — Plan Model

- [x] `plans` table
- [x] `plan_tasks` table
- [x] Plan repository
- [x] Plan lifecycle

### M2 — Planner

- [x] planner system prompt
- [x] project context builder
- [x] structured output
- [x] schema validation

### M3 — Graph Validator

- [x] unique keys
- [x] dependency validation
- [x] cycle detection
- [x] repair attempt

### M4 — Chat Integration

- [x] Chat / Plan / Build modes
- [x] `/plan`
- [x] `/build`
- [x] planning state
- [x] planner result message

### M5 — Plan Preview

- [x] plan task list
- [x] edit task
- [x] delete task
- [x] add task
- [x] edit dependency
- [x] revalidate

### M6 — Kanban Conversion

- [x] PlanTask → Task
- [x] dependency ID mapping
- [x] atomic transaction
- [x] idempotency
- [x] realtime Kanban event

### M7 — Scheduler Integration

- [x] READY calculation
- [x] BLOCKED state
- [x] dependency unlock
- [x] auto-start option
- [x] failure propagation

### M8 — Progress Integration

- [x] Plan progress
- [x] running agents
- [x] blocked count
- [x] ready count
- [x] completed count

### M9 — Reliability

- [x] daemon restart recovery
- [x] failed planner recovery
- [x] task conversion retry
- [x] plan cancellation
- [x] tests

---

## 55. Definition of Done

V4 selesai ketika user dapat:

```text
Chat
 ↓
paste large feature brief
 ↓
Plan
 ↓
automatic structured decomposition
 ↓
review/edit
 ↓
Add to Kanban
 ↓
tasks appear immediately
 ↓
dependency-aware READY/BLOCKED states
 ↓
start tasks
 ↓
parallel OpenCode execution
 ↓
Progress updates live
```

Tanpa user perlu membuat task satu per satu.

---

## 56. Tidak Masuk V4

Jangan tambahkan dulu:

- cloud planner
- Turso
- Vercel control plane
- team collaboration
- task marketplace
- multi-user planning
- autonomous infinite loops
- background cron automation
- GitHub issue ingestion
- Linear/Jira integration
- AI-generated deployment
- automatic merge without review

Fokus V4:

> **Chat intent → structured plan → validated Kanban tasks → scheduler.**

---

## 57. Urutan Implementasi

Kerjakan dalam urutan:

```text
1. Plan + PlanTask schema
2. structured planner
3. validator
4. plan preview
5. converter
6. Kanban integration
7. dependency resolver
8. scheduler integration
9. Progress integration
10. Build mode
```

Jangan mulai dari auto-start.

Pastikan dulu:

```text
Plan
→ Validate
→ Kanban
```

benar-benar stabil.
