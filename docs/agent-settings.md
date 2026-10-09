# Settings: Custom Agents

## Route

```text
/settings/agents
```

## Tujuan

Halaman ini memungkinkan user membuat, mengatur, mengaktifkan, dan menghapus agent kustom.

Setiap agent adalah konfigurasi yang menggabungkan:

- Identitas agent.
- Role atau spesialisasi kerja.
- Provider dan model yang digunakan.
- Skill bawaan berdasarkan role.
- Custom skill tambahan milik user.
- Aturan eksekusi ketika dipanggil dari Chat, Canvas, atau Kanban board.

Agent bukan provider. Provider adalah runtime seperti Claude Code, Codex, Agy, atau OpenCode. Agent memilih satu provider dan satu model sebagai konfigurasi utama, lalu menjalankan skill yang sesuai.

## Prinsip Produk

- Agent harus dapat dibuat tanpa menulis prompt dari nol.
- User dapat mulai dari role preset, lalu menambahkan atau mengganti skill.
- Provider dan model hanya boleh dipilih dari provider/model yang sudah connected dan tersedia di model catalog.
- Agent tidak boleh menjalankan task otomatis hanya karena dibuat. Agent berjalan setelah dipanggil dari Chat, Canvas, Kanban, atau workflow yang user aktifkan.
- Agent yang berjalan terus-menerus harus memiliki scope, batas retry, batas biaya/token, dan kondisi berhenti.
- Canvas agent tidak boleh langsung mengubah file project.
- Coding agent hanya boleh menulis file di project yang dipilih dan melalui runtime/permission coding yang tersedia.
- Semua eksekusi agent harus membuat run record, event stream, dan audit trail.

## Halaman List Agent

Tampilan awal `/settings/agents` menampilkan daftar agent user.

### Header

```text
Agents
Create reusable AI workers for coding, design, planning, testing, and automation.

[ + Create agent ]
```

### Agent Card

Setiap card menampilkan:

- Avatar/icon berdasarkan role.
- Label agent.
- Role.
- Provider dan model.
- Status: Active, Disabled, Needs attention.
- Jumlah custom skills.
- Last used.
- Trigger yang diizinkan: Chat, Canvas, Kanban.
- Menu tindakan: Edit, Duplicate, Disable/Enable, Delete.

Contoh:

```text
┌──────────────────────────────────────────────────────────────┐
│ ◈ Backend Builder                                             │
│ Backend Dev · Claude Code / BACKEND                           │
│ Skills: API implementation, database migration, test writer  │
│ Available in: Chat · Kanban                                   │
│ Last used: 12 minutes ago                                     │
│                                             [- - - ]             │
└──────────────────────────────────────────────────────────────┘
```

### Empty State

```text
No agents yet.

Create a reusable agent for UI/UX, frontend, backend, QA,
project planning, or a workflow unique to your project.

[ Create your first agent ]
```

## Create/Edit Agent Form

Gunakan halaman penuh atau sheet lebar. Jangan gunakan modal kecil karena konfigurasi agent cukup kompleks.

Tab atau section:

```text
[ General ] [ Skills ] [ Runtime ] [ Automation ] [ Preview ]
```

## General

### Label Agent

Field wajib.

```text
Label agent
[ Backend Builder                         ]

A short name shown in Chat, Canvas, Kanban, and run history.
```

Validasi:

- Wajib.
- Panjang 2 sampai 60 karakter.
- Unik per user dalam scope yang sama.
- Tidak boleh hanya berupa whitespace.
- Contoh: `Backend Builder`, `UI Designer`, `QA Regression Agent`.

### Role

Field wajib.

```text
Role
[ Backend Dev                              ▾ ]
```

Pilihan preset:

| Role ID | Label | Default capability |
|---|---|---|
| `uiux` | UI/UX Designer | Membuat dan merevisi preview UI/UX di Canvas |
| `frontend` | Frontend Developer | Mengubah komponen UI, styling, dan frontend test |
| `backend` | Backend Developer | API, database, service, auth, backend test |
| `fullstack` | Fullstack Developer | Koordinasi perubahan frontend dan backend |
| `qa` | QA Engineer | Menulis/menjalankan test, menganalisis failure |
| `pm` | Project Manager | Memecah requirement menjadi plan dan task Kanban |
| `custom` | Custom Role | User mengatur deskripsi dan skills sendiri |

Jika memilih `custom`, tampilkan field:

```text
Custom role description
[ Describe what this agent owns, what it should produce,
  and what it must avoid.                              ]
```

Role hanya memberi default skill dan batas kemampuan. User tetap dapat menambah atau mengurangi skill.

## Skills

### Konsep Skill

Skill adalah instruksi/prosedur yang dapat dipakai ulang oleh agent untuk tugas tertentu.

Skill dapat berasal dari:

- Built-in role skill.
- Project skill.
- User custom skill.
- Imported skill, jika fitur import tersedia di masa depan.

Skill bukan provider dan bukan model.

### Built-in Skills per Role

Saat user memilih role, Loom menambahkan default skills sebagai rekomendasi. User boleh menonaktifkan skill yang tidak diperlukan.

#### UI/UX Designer

```text
- design-screen
- design-refine
- design-system-fidelity
- responsive-layout
- accessibility-review
```

Scope:

```text
Canvas only by default.
No project file write access.
```

#### Frontend Developer

```text
- inspect-frontend
- implement-ui
- responsive-implementation
- component-testing
- accessibility-check
```

Scope:

```text
Chat and Kanban.
Can read/write frontend files inside selected project.
```

#### Backend Developer

```text
- inspect-backend
- implement-api
- database-change
- auth-and-validation
- backend-testing
```

Scope:

```text
Chat and Kanban.
Can read/write backend files inside selected project.
```

#### Fullstack Developer

```text
- inspect-project
- implement-frontend
- implement-backend
- integration-testing
- migration-review
```

Scope:

```text
Chat and Kanban.
Can read/write selected project files.
```

#### QA Engineer

```text
- inspect-test-suite
- write-tests
- run-tests
- analyze-failures
- regression-report
```

Scope:

```text
Chat and Kanban.
Read access by default.
Writing test files requires explicit write capability.
```

#### Project Manager

```text
- requirement-analysis
- task-breakdown
- acceptance-criteria
- dependency-planning
- kanban-planning
```

Scope:

```text
Chat and Kanban.
No project file write access by default.
```

### Custom Skills

Section:

```text
Custom skills
Attach reusable instructions that this agent should follow.

[ + Add custom skill ]
```

Setiap skill menampilkan:

```text
┌──────────────────────────────────────────────────────────────┐
│ API Contract Reviewer                              [Remove]   │
│ Review API changes for validation, error mapping, and tests. │
│ Source: Custom · Enabled                                     │
└──────────────────────────────────────────────────────────────┘
```

Form add custom skill:

```text
Skill name
[ API Contract Reviewer                   ]

Skill instructions
[ Read relevant API handlers, schemas, and tests before changing
  contracts. Preserve existing error conventions. Add or update
  tests for public behavior changes.                           ]

Allowed surfaces
[✓] Chat
[ ] Canvas
[✓] Kanban

Capabilities
[✓] Read project files
[ ] Write project files
[✓] Run project tests
[ ] Use network
```

Validasi skill:

- Nama wajib, 2–80 karakter.
- Instruksi wajib.
- Maksimal 20 custom skill per agent untuk MVP.
- Batasi ukuran total instruksi agent, misalnya 24 KB atau 6.000 token perkiraan.
- Instruksi custom tidak boleh mengubah policy keamanan sistem.
- Skill Canvas tidak boleh diberi `write project files`.

## Runtime

### Provider

```text
Provider
[ Claude Code                              ▾ ]
```

Sumber pilihan:

- Provider dengan status `connected`.
- Provider harus memiliki setidaknya satu model cached atau opsi provider default.
- Jika provider belum connected, tampilkan tautan ke `/settings/providers`.

Contoh status:

```text
Claude Code · Connected
Agy · Connected
OpenCode · Connected
Codex · Not connected
```

### Model

```text
Model
[ BACKEND                                   ▾ ]
```

Aturan:

- Daftar model selalu difilter berdasarkan provider yang dipilih.
- Gunakan `model_catalog` hasil discovery.
- Izinkan opsi `Use provider default`.
- Izinkan `Custom model / alias` untuk provider yang tidak punya katalog resmi atau memakai alias lokal.
- Simpan nilai model asli, bukan hanya label.

Contoh Claude user:

```text
Use provider default
BACKEND
FRONTEND
commandcode
cc/claude-haiku-4-5-20251001
Custom model / alias...
```

Jika provider berubah:

1. Kosongkan model sebelumnya jika model itu bukan milik provider baru.
2. Pilih default provider jika tersedia.
3. Jika tidak ada model, minta user memilih custom model/alias atau refresh provider models.
4. Jangan fallback diam-diam ke OpenCode.

### Effort

Opsional, hanya muncul jika model mendukung effort.

```text
Reasoning effort
[ Default                                    ▾ ]
```

Pilihan:

```text
Default
Low
Medium
High
Maximum
```

Simpan sebagai override agent. Jika provider/model tidak mendukung effort, jangan meneruskan flag effort.

### Agent System Instructions

```text
Agent instructions
[ Generated from role and enabled skills. You may add focused
  instructions that apply to every task for this agent.        ]
```

Aturan:

- Role + skill adalah sumber utama.
- Field ini untuk tambahan ringkas, bukan tempat memasukkan prompt sangat panjang.
- Jangan izinkan instruksi user menonaktifkan permission, logging, sandbox, atau batas system policy.
- Tampilkan preview prompt gabungan di tab Preview.

## Automation

Automation menentukan kapan dan bagaimana agent boleh dipanggil.

### Available Surfaces

```text
Available in
[✓] Chat
[✓] Canvas
[✓] Kanban board
```

Aturan role:

| Role | Chat | Canvas | Kanban |
|---|---:|---:|---:|
| UI/UX Designer | Ya | Ya | Ya |
| Frontend Developer | Ya | Tidak default | Ya |
| Backend Developer | Ya | Tidak | Ya |
| Fullstack Developer | Ya | Tidak default | Ya |
| QA Engineer | Ya | Tidak | Ya |
| Project Manager | Ya | Tidak | Ya |
| Custom Role | Berdasarkan capability | Berdasarkan capability | Berdasarkan capability |

Canvas untuk Frontend/Fullstack boleh ditambahkan nanti sebagai mode **Implement Design**, tetapi tidak boleh membuat file otomatis hanya karena agent dipanggil di Canvas.

### Execution Mode

```text
Execution mode
(- ) On demand
( ) Continue assigned Kanban tasks
( ) Monitor workflow continuously
```

Untuk MVP, hanya implementasikan `On demand` dan `Continue assigned Kanban tasks`.

#### On Demand

Agent berjalan ketika user secara eksplisit memilih agent dari:

- Chat provider/agent selector.
- Canvas agent selector.
- Tombol `Assign agent` di task Kanban.

#### Continue Assigned Kanban Tasks

Agent boleh mengambil task berikutnya jika:

- Agent ditugaskan ke kolom atau task tertentu.
- Task sebelumnya selesai atau masuk `needs_review`.
- Tidak ada run agent yang masih aktif untuk project yang sama.
- Batas concurrency belum tercapai.
- Task memiliki acceptance criteria atau detail yang cukup.

Agent tidak boleh mengambil task `Done`, `Blocked`, atau task tanpa scope yang jelas.

### Stop Conditions

```text
Stop conditions
[✓] Stop after task is complete
[✓] Stop when tests fail twice
[✓] Stop when permission is required
[✓] Stop when provider error occurs
[✓] Stop after maximum run duration

Maximum run duration
[ 30 ] minutes
```

Tambahkan:

```text
Maximum retries
[ 1 ]

Maximum task hops
[ 3 ]
```

`Maximum task hops` adalah jumlah task berurutan yang boleh dikerjakan agent dalam mode continuous.

### Approval Policy

```text
Approval policy
(- ) Ask before writing files
( ) Allow writes inside assigned task scope
( ) Read-only agent
```

Aturan wajib:

- Canvas selalu read-only terhadap project files.
- PM selalu read-only terhadap project files secara default.
- Agent dengan `Allow writes` hanya boleh menulis dalam project root aktif.
- Command berisiko, network access, install dependency, database migration, dan destructive changes tetap membutuhkan approval terpisah.
- Jangan pernah memakai `--dangerously-skip-permissions` sebagai default.

### Fallback Policy

```text
Provider fallback
[✓] Enable fallback when provider quota or runtime fails

Fallback provider
[ OpenCode                                  ▾ ]

Fallback model
[ opencode/free-model                       ▾ ]

Maximum fallback hops
[ 1 ]
```

Fallback tidak berlaku untuk:

- User membatalkan task.
- Test project gagal.
- Prompt/validation error.
- Permission request yang belum disetujui.
- Model ID tidak valid, kecuali user secara eksplisit memilih fallback untuk invalid model.
- Error coding yang perlu ditinjau manusia.

Saat fallback terjadi:

1. Loom menyimpan provider dan model asal.
2. Loom mengambil ringkasan task, progress, dan `git status`.
3. Loom membuat run baru pada provider/model fallback.
4. Loom menampilkan event di Chat/Kanban: `Continued with OpenCode / <model>`.
5. Loom tidak meneruskan CLI session ID antar provider.
6. Loom maksimal melakukan satu fallback.

## Preview

Tab Preview menampilkan:

- Role dan skill aktif.
- Provider dan model efektif.
- Surface yang diizinkan.
- Permission policy.
- Prompt/skill bundle yang sudah dirender, dengan secret disensor.
- Contoh action yang diizinkan dan ditolak.

Contoh:

```text
Agent: Backend Builder
Runtime: Claude Code / BACKEND
Available in: Chat, Kanban
Project write: Ask before writing
Tests: Allowed
Canvas: Not available
Fallback: OpenCode / opencode/free-model

Included skills:
- inspect-backend
- implement-api
- database-change
- backend-testing
- API Contract Reviewer
```

## Data Model

Tambahkan schema agent ke database.

### `agents`

```text
id
user_id
project_id                    -- nullable untuk reusable global agent
label
role                          -- uiux | frontend | backend | fullstack | qa | pm | custom
role_description              -- nullable
provider
model_id                      -- nullable = provider default
effort                        -- nullable
system_instructions
status                        -- active | disabled | needs_attention
execution_mode                -- on_demand | continuous_kanban | continuous_workflow
allow_chat
allow_canvas
allow_kanban
approval_policy               -- ask_before_write | task_scoped_write | read_only
max_run_duration_minutes
max_retries
max_task_hops
fallback_policy_id            -- nullable
created_at
updated_at
last_used_at
```

### `agent_skills`

```text
id
agent_id
skill_id                      -- nullable untuk custom inline skill
name
source                        -- builtin | project | custom | imported
instructions
enabled
allow_chat
allow_canvas
allow_kanban
can_read_files
can_write_files
can_run_tests
can_use_network
sort_order
created_at
updated_at
```

### `agent_assignments`

```text
id
agent_id
project_id
task_id                       -- nullable
kanban_column_id              -- nullable
status                        -- active | paused | completed | error
continuous_enabled
next_run_at                   -- nullable
last_run_id                   -- nullable
created_at
updated_at
```

### `agent_runs`

```text
id
agent_id
project_id
task_id                       -- nullable
chat_session_id               -- nullable
canvas_design_id              -- nullable
provider
model_id
fallback_from_run_id          -- nullable
status                        -- queued | running | waiting_approval | completed | failed | cancelled
trigger                       -- chat | canvas | kanban | scheduler
input_summary
output_summary
started_at
finished_at
error_class                   -- nullable
error_message                 -- sanitized
created_at
```

### `fallback_policies`

```text
id
user_id
project_id                    -- nullable
enabled
provider
model_id                      -- nullable
max_hops
created_at
updated_at
```

## API Contract

### List agents

```text
GET /api/agents?projectId=<project-id>
```

### Create agent

```text
POST /api/agents
```

```json
{
  "projectId": "project_123",
  "label": "Backend Builder",
  "role": "backend",
  "provider": "claude",
  "modelId": "BACKEND",
  "allowChat": true,
  "allowCanvas": false,
  "allowKanban": true,
  "approvalPolicy": "ask_before_write",
  "executionMode": "on_demand",
  "skills": [
    {
      "name": "API Contract Reviewer",
      "source": "custom",
      "instructions": "Review API handlers and tests before changing public contracts.",
      "enabled": true,
      "canReadFiles": true,
      "canWriteFiles": false,
      "canRunTests": true,
      "canUseNetwork": false
    }
  ]
}
```

### Run agent from chat

```text
POST /api/agent-runs/chat
```

```json
{
  "agentId": "agent_backend_builder",
  "projectId": "project_123",
  "chatSessionId": "chat_123",
  "message": "Tambahkan endpoint untuk daftar invoice."
}
```

### Assign agent to Kanban task

```text
POST /api/agent-assignments
```

```json
{
  "agentId": "agent_backend_builder",
  "projectId": "project_123",
  "taskId": "task_invoice_api",
  "continuousEnabled": false
}
```

### Continue Kanban work

```text
POST /api/agent-assignments/:id/continue
```

Jangan membuat scheduler mengambil task otomatis sampai user mengaktifkan mode continuous dan menyetujui permission policy.

## Agent Runtime Flow

### Chat

1. User memilih agent pada selector chat.
2. Loom membaca konfigurasi agent.
3. Loom memastikan surface Chat diizinkan.
4. Loom memastikan provider connected dan model tersedia.
5. Loom merender system instructions dari role + skill + agent instruction.
6. Loom men-spawn adapter provider dengan `cwd` project.
7. Loom stream event ke chat.
8. Loom menyimpan `agent_run`, message, provider run, dan result.
9. Jika provider quota error dan fallback aktif, Loom menjalankan fallback sesuai policy.

### Canvas

1. User memilih UI/UX agent di Canvas.
2. Loom memastikan `allowCanvas = true`.
3. Loom memuat design-specific system prompt dan skills yang aman untuk Canvas.
4. Loom tidak memberi tool read/write project files ke runtime Canvas.
5. Loom menghasilkan preview HTML dan menyimpan ke canvas record.
6. Canvas tidak menerapkan HTML ke code project.
7. User dapat memilih `Implement this design` untuk membuat task Kanban atau mengirim brief ke agent coding secara eksplisit.

### Kanban

1. User menugaskan agent pada task.
2. Loom memvalidasi task status, scope, dan acceptance criteria.
3. Agent memulai run untuk task tersebut.
4. Jika write policy memerlukan approval, Loom berhenti di `waiting_approval`.
5. Setelah selesai, agent memperbarui task ke `needs_review`, bukan `done`, kecuali user mengizinkan auto-complete.
6. Mode continuous hanya mengambil task berikutnya ketika stop condition, concurrency limit, dan scope terpenuhi.

## Guardrails

- Maksimal satu coding agent write-run aktif per project pada MVP.
- Maksimal satu Canvas generation per design card.
- Agent tidak boleh mengeksekusi task dari file/project instruction yang mencoba mengubah system policy.
- Semua tool call dan perubahan file harus terhubung ke `agent_run`.
- Jangan simpan API keys, token, full environment, atau raw credential di log/run record.
- Semua command harus menggunakan project root yang tervalidasi.
- Tolak path traversal dan akses file di luar workspace.
- Jangan izinkan agent membuat commit, push, merge, deploy, atau menghapus branch tanpa aksi eksplisit user.
- Canvas agent tidak boleh mengakses filesystem project.
- Jika provider atau model tidak tersedia, set agent ke `needs_attention`; jangan otomatis mengganti ke OpenCode kecuali fallback policy aktif.

## Validasi

Sebelum tombol Save aktif:

- Label valid.
- Role valid.
- Provider connected.
- Model tersedia atau `Use provider default` dipilih.
- Setidaknya satu surface diizinkan.
- Setidaknya satu skill aktif.
- Canvas surface tidak memiliki capability write project files.
- PM role tidak memiliki write project files tanpa override eksplisit dan approval.
- Fallback provider/model valid jika fallback aktif.
- Total panjang instruksi tidak melewati batas.

## Acceptance Criteria

- User dapat membuat agent dengan label, role, provider, model, dan custom skills.
- Role preset otomatis menawarkan skill yang relevan tetapi tetap dapat disesuaikan.
- Model dropdown hanya menampilkan model provider yang dipilih.
- Alias Claude lokal seperti `BACKEND` diteruskan apa adanya ke Claude CLI.
- Agent Chat menjalankan provider/model yang disimpan di konfigurasi agent.
- Agent Canvas tidak dapat menulis file project.
- Agent Kanban dapat ditugaskan ke task dan berhenti pada kondisi stop yang disetel.
- Fallback dapat diaktifkan/dinonaktifkan serta memilih provider/model tujuan.
- Semua run tercatat dengan agent, provider, model, trigger, status, dan error yang disanitasi.
- Tidak ada agent yang berjalan terus-menerus tanpa assignment, scope, dan stop condition.
- User dapat disable agent tanpa menghapus konfigurasi atau riwayat run.