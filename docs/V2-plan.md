# Loom V2 Parallel Agents Implementation Plan

Referensi utama: [`docs/V2-PARALLEL-AGENTS.md`](./V2-PARALLEL-AGENTS.md)

## Tujuan V2

Membuktikan bahwa Loom dapat menjalankan beberapa task OpenCode secara bersamaan dalam satu project, dengan worktree, session, status, output, retry, cancellation, dan review yang terisolasi.

Core loop V2:

```text
Create Batch Tasks → Enqueue → Schedule in Parallel → Run Independent Agents
→ Stream Status/Output → Review Independently → Merge Sequentially
→ Detect Conflicts Safely → Recover After Restart
```

## Prasyarat dan batasan

- V1 harus stabil sebelum phase V2 dimulai.
- Setiap task memiliki satu worktree writable sendiri.
- Setiap task memiliki AgentRun dan OpenCode session sendiri.
- Tidak ada planner otomatis, DAG dependency, AI conflict resolution, cloud auth, Turso, billing, remote execution, updater, atau marketplace agent.
- Scheduler V2 menggunakan batas concurrency statis, bukan adaptive CPU/memory/provider-aware scheduling.
- Command yang membutuhkan permission tidak boleh auto-approved.
- Raw agent output harus bounded dan tidak boleh membuat SQLite membengkak.
- Terminal bersifat opsional dan, jika dikerjakan, selalu terikat ke worktree task.

---

## Phase 0 — Audit V1 dan Baseline V2

### Tujuan

Memastikan baseline V1 benar-benar siap menerima multi-task execution tanpa merusak core loop existing.

### Task

- Audit status V1 terhadap Definition of Done.
- Pastikan daemon, database bootstrap, protocol, worktree, OpenCode adapter, orchestrator, API, UI, dan CLI dapat diverifikasi.
- Audit semua asumsi single-active-task pada database, orchestrator, event bus, API, UI, dan CLI.
- Audit naming dan lifecycle status yang akan dipakai ulang oleh V2.
- Pastikan `AgentRun` existing dapat diperluas menjadi histori run tanpa overwrite.
- Tetapkan keputusan apakah perubahan dilakukan langsung pada package existing atau melalui abstraction tambahan yang minimal.
- Catat keputusan arsitektur V2 sebelum implementasi lintas package.
- Jalankan baseline:
  - `bun test`
  - `bun run check-types`
  - `bun run build`
  - `bunx biome check .`

### Output

- Baseline V1 terdokumentasi.
- Daftar single-task constraint yang harus dihapus atau digeneralisasi.
- Keputusan arsitektur V2.

### Selesai jika

V1 tetap lulus seluruh verifikasi dan daftar gap V2 telah dipetakan.

### Dependensi

Tidak ada. Phase ini menjadi prasyarat semua phase berikutnya.

---

## Phase 1 — AgentRun Model, Retry, dan Run History

### Tujuan

Memisahkan lifecycle Task dari setiap percobaan eksekusi AgentRun sehingga retry tidak menimpa histori sebelumnya.

### Task

- Merapikan `AgentRunStatus`:
  - `queued`
  - `running`
  - `waiting_permission`
  - `completed`
  - `failed`
  - `cancelled`
  - `interrupted`
- Memastikan `AgentRun` menyimpan:
  - `id`
  - `taskId`
  - `sessionId`
  - `status`
  - `startedAt`
  - `completedAt`
  - error/recovery metadata yang diperlukan.
- Menambahkan relasi Task → banyak AgentRun.
- Menambahkan repository:
  - create run,
  - get run by ID,
  - list runs by task,
  - update run,
  - list unfinished runs.
- Menambahkan `POST /api/tasks/:id/retry`.
- Memastikan retry hanya dapat dilakukan dari status yang valid.
- Membuat AgentRun baru untuk retry.
- Mempertahankan semua run sebelumnya secara immutable terhadap histori.
- Menentukan apakah retry menggunakan worktree lama atau membuat worktree baru; rekomendasi V2: membuat worktree/run context baru bila workspace sebelumnya tidak aman digunakan.
- Menambahkan event run lifecycle.

### Output

- Model domain AgentRun V2.
- Repository run history.
- Retry service dan API.

### Selesai jika

Task dapat memiliki Run 1 yang gagal dan Run 2 yang berjalan tanpa histori Run 1 hilang.

### Dependensi

- Phase 0.
- Protocol dan database V1.

---

## Phase 2 — Parallel Worktree Isolation

### Tujuan

Memastikan beberapa task pada project yang sama memiliki workspace writable yang benar-benar terisolasi.

### Task

- Memastikan path setiap task tetap:
  `~/.loom/worktrees/<project-id>/<task-id>`.
- Menambahkan run-aware path bila diperlukan tanpa mengizinkan collision.
- Memastikan setiap task memakai branch unik, misalnya `loom/<task-id>`.
- Menolak collision directory, branch, dan metadata workspace.
- Memastikan worktree tidak pernah share writable directory.
- Menambahkan ownership metadata untuk membedakan worktree Loom dari worktree lain.
- Menambahkan validasi bahwa workspace task tidak menunjuk ke main workspace.
- Memperkuat operasi remove/discard agar hanya menghapus worktree milik task terkait.
- Menambahkan pemeriksaan orphan worktree tanpa otomatis menghapusnya.
- Menguji dua task yang mengedit file berbeda.
- Menguji dua task yang mengedit file sama.
- Menguji missing workspace dan branch collision.

### Output

- Worktree manager yang aman untuk concurrent task.
- Orphan detection dan workspace ownership validation.

### Selesai jika

Dua atau lebih task dapat berjalan bersamaan tanpa berbagi workspace writable dan tanpa mengubah main workspace sebelum merge.

### Dependensi

- Phase 1 untuk task/run identity.
- Package worktree V1.

---

## Phase 3 — Scheduler dan Queue

### Tujuan

Menjalankan task secara paralel dengan batas concurrency global dan per-project.

### Task

- Membuat `packages/orchestrator/src/scheduler.ts`.
- Mendefinisikan interface:
  - `enqueue(taskId)`
  - `dispatch()`
  - `cancel(taskId)`
- Mendefinisikan `SchedulerConfig`:
  - `maxConcurrentAgents`
  - `maxConcurrentAgentsPerProject`
- Default:
  - global: `3`
  - per project: `3`
- Mengimplementasikan queue FIFO atau kebijakan deterministic yang didokumentasikan.
- Mengimplementasikan state:
  - `queued`
  - `preparing`
  - `running`
  - `completed`
  - `failed`
  - `cancelled`
- Memastikan queued task memperoleh slot setelah slot tersedia.
- Memastikan cancellation melepaskan slot dan memicu dispatch berikutnya.
- Menolak atau mengantrikan task berdasarkan batas concurrency, bukan menggagalkan task secara salah.
- Mengirim `scheduler.changed` saat jumlah running/queued berubah.
- Menyediakan active task/run lookup untuk API dan UI.
- Menjamin dispatch tidak menjalankan task yang sama dua kali.
- Menentukan shutdown behavior ketika scheduler sedang dispatch.

### Output

- Scheduler yang mendukung parallel execution.
- Queue state dan concurrency metrics.

### Selesai jika

Concurrency global dan per-project tidak pernah dilanggar, task queued berjalan otomatis saat slot tersedia, dan cancellation melepaskan slot.

### Dependensi

- Phase 1 dan Phase 2.
- Orchestrator V1.

---

## Phase 4 — Parallel OpenCode Sessions dan Runtime Lifecycle

### Tujuan

Menjalankan session OpenCode independen untuk setiap AgentRun dengan cwd worktree yang tepat.

### Task

- Memastikan setiap AgentRun membuat session OpenCode baru.
- Memastikan setiap session memiliki `cwd` worktree task sendiri.
- Memastikan session ID disimpan pada AgentRun, bukan hanya Task.
- Memastikan cancellation hanya meng-abort session/run target.
- Memastikan satu session tidak dapat dipakai dua task.
- Mengintegrasikan scheduler dengan `OpenCodeServerManager` dan `AgentRuntime`.
- Menangani status `waiting_permission` dari OpenCode.
- Memetakan output/status OpenCode ke event V2 yang tervalidasi.
- Menambahkan timeout per run dan cleanup yang aman.
- Memastikan OpenCode server tetap shared bila arsitektur V1 menggunakannya, tetapi session dan cwd tetap independen.
- Menangani server restart dan session yang hilang.
- Menambahkan mock runtime untuk parallel tests.

### Output

- Independent OpenCode session per AgentRun.
- Cancellation dan status runtime per run.
- Mapping output/status yang aman.

### Selesai jika

Dua task berjalan simultan pada session berbeda dan perubahan masing-masing hanya terjadi di worktree masing-masing.

### Dependensi

- Phase 2 dan Phase 3.
- OpenCode adapter V1.

---

## Phase 5 — Event Model V2 dan Bounded Output

### Tujuan

Menyediakan real-time status/output per run tanpa membebani database atau membocorkan payload besar.

### Task

- Memperluas `DaemonEvent` dengan:
  - `scheduler.changed`
  - `run.started`
  - `run.output`
  - `run.completed`
  - `run.failed`
  - `run.cancelled`
  - `run.waiting_permission`
  - `run.interrupted`
  - `merge_conflict.detected`
- Memastikan event membawa `taskId` dan `runId` bila relevan.
- Memvalidasi semua event melalui shared protocol.
- Menambahkan sequence/timestamp bila diperlukan untuk reconnect dan ordering.
- Membuat bounded output policy:
  - maksimum ukuran event,
  - truncation policy,
  - hanya output relevan ke UI.
- Menambahkan rotating log files:
  `~/.loom/logs/tasks/<task-id>/<run-id>.log`.
- Menulis raw stream ke file secara bounded/rotating, bukan SQLite metadata.
- Menyimpan metadata ringkas output dan error pada database.
- Memastikan credentials dan secret tidak masuk log.
- Menambahkan reconnect reconciliation: client mengambil state terbaru setelah reconnect.

### Output

- Shared V2 event contract.
- Bounded output/logging service.
- Reconnect-safe event delivery.

### Selesai jika

UI menerima status/output setiap run secara real-time, output besar tidak memenuhi SQLite, dan reconnect tidak membuat state UI salah.

### Dependensi

- Phase 3 dan Phase 4.
- Event bus V1.

---

## Phase 6 — Permission Handling

### Tujuan

Menangani approval OpenCode secara eksplisit dan aman tanpa auto-approve command berisiko.

### Task

- Memperluas AgentRun state dengan `waiting_permission`.
- Menyimpan permission request secara bounded:
  - command/action,
  - cwd,
  - alasan/ringkasan,
  - timestamp,
  - run ID.
- Menambahkan API untuk mengambil pending permission.
- Menambahkan action:
  - Allow Once,
  - Allow,
  - Deny.
- Memastikan keputusan diterapkan hanya pada AgentRun target.
- Menolak auto-approval untuk command berisiko.
- Mengirim event permission ke UI.
- Menampilkan UI approval dengan konteks yang jelas.
- Menangani timeout atau daemon restart saat permission pending.
- Mencatat keputusan tanpa menyimpan credential.

### Output

- Permission workflow end-to-end.
- UI approval state.
- Audit trail keputusan permission.

### Selesai jika

Agent dapat berhenti pada `waiting_permission`, user dapat memberi keputusan eksplisit, dan command berisiko tidak pernah di-approve otomatis.

### Dependensi

- Phase 4 dan Phase 5.
- Kontrak permission OpenCode yang tervalidasi.

---

## Phase 7 — Batch Task Creation dan API V2

### Tujuan

Memungkinkan user membuat banyak task sekaligus dan mengelolanya melalui API yang konsisten.

### Task

- Menambahkan `CreateTaskBatchInput`.
- Menambahkan schema runtime validation untuk batch.
- Menambahkan endpoint:
  `POST /api/projects/:projectId/tasks/batch`.
- Menambahkan endpoint/kontrak:
  - `POST /api/tasks`
  - `POST /api/tasks/:id/start`
  - `POST /api/tasks/:id/cancel`
  - `POST /api/tasks/:id/retry`
  - `GET /api/tasks/:id`
  - `GET /api/tasks/:id/runs`
  - `POST /api/tasks/:id/merge`
  - `POST /api/tasks/:id/discard`
- Menentukan apakah task batch langsung queued atau dapat langsung dijalankan; rekomendasi: queued lalu scheduler dispatch.
- Memvalidasi seluruh request dan response.
- Mengembalikan scheduler state dan run history yang diperlukan UI.
- Menangani error partial batch secara deterministic.
- Menambahkan API auth/error tests.

### Output

- API V2 task, batch, run history, retry, scheduler, dan permission.

### Selesai jika

User dapat membuat beberapa task dalam satu request dan melihat masing-masing task/run dengan status yang tervalidasi.

### Dependensi

- Phase 1, Phase 3, Phase 5, dan Phase 6.

---

## Phase 8 — Merge Queue dan Conflict Detection

### Tujuan

Menggabungkan hasil task satu per satu dengan pemeriksaan target HEAD dan conflict yang aman.

### Task

- Menambahkan state merge:
  - `ready_to_merge`
  - `merge_conflict`.
- Menambahkan `MergeConflict` dengan:
  - `taskId`
  - `files`.
- Membuat merge queue deterministic.
- Sebelum merge:
  - memeriksa target HEAD,
  - memeriksa main workspace clean,
  - memeriksa worktree/branch masih valid,
  - memeriksa mergeability.
- Jika target HEAD berubah, lakukan revalidation sebelum merge.
- Jika conflict terjadi:
  - abort operasi merge yang dibuat Loom,
  - jangan merusak main workspace,
  - pertahankan worktree task,
  - simpan daftar file conflict,
  - emit event `merge_conflict.detected`.
- Menambahkan UI `View Conflict`.
- Tidak mengimplementasikan AI conflict resolver.
- Memastikan merge A lalu B memvalidasi B terhadap HEAD terbaru.
- Membuat merge/discard operation idempotent atau error yang jelas.

### Output

- Merge queue.
- Conflict detection dan safe recovery.
- Conflict metadata/UI.

### Selesai jika

Task dapat di-merge satu per satu, target HEAD selalu diverifikasi, dan conflict terdeteksi tanpa merusak main workspace.

### Dependensi

- Phase 2, Phase 7.
- Worktree merge strategy V1.

---

## Phase 9 — Parallel UI dan Run History

### Tujuan

Menyediakan UI untuk memonitor banyak task, queue, run, permission, review, merge, dan retry.

### Task

- Mengubah project screen menjadi daftar task parallel seperti:
  - Frontend dashboard — Running,
  - Backend analytics API — Running,
  - Integration tests — Queued,
  - Database schema — Completed.
- Menambahkan task cards dengan:
  - status,
  - duration,
  - run ID,
  - output ringkas,
  - workspace/branch.
- Menambahkan actions:
  - New Task,
  - Run,
  - Cancel,
  - Retry,
  - Review,
  - Merge,
  - Discard.
- Menambahkan batch task form.
- Menampilkan scheduler counters running/queued.
- Menampilkan run history dan detail retry.
- Menampilkan permission request dan action buttons.
- Menampilkan merge conflict dan file list.
- Menambahkan independent diff/review per task.
- Menambahkan WebSocket reconnect dan state refresh.
- Menggunakan shared protocol schemas untuk event parsing.
- Menyediakan loading, empty, unavailable, stale, dan error states.

### Output

UI parallel-agent V2 yang dapat memonitor dan mengontrol task/run secara independen.

### Selesai jika

User dapat membuat dua atau lebih task, melihat keduanya berjalan bersamaan, melakukan review terpisah, retry/cancel, dan merge/discard satu per satu.

### Dependensi

- Phase 5, Phase 7, dan Phase 8.

---

## Phase 10 — Failure Recovery dan Restart Reconciliation

### Tujuan

Memulihkan state ketika daemon mati saat beberapa agent sedang berjalan tanpa menghapus workspace atau histori secara otomatis.

### Task

- Saat startup, load unfinished AgentRuns.
- Periksa setiap OpenCode session/process bila memungkinkan.
- Periksa keberadaan worktree dan ownership.
- Reconcile state menjadi:
  - running jika masih dapat dipastikan aktif,
  - queued jika aman untuk dijalankan ulang sesuai kebijakan,
  - interrupted jika tidak dapat dilanjutkan.
- Jangan otomatis delete orphan worktree.
- Tandai orphan worktree untuk user review/cleanup.
- Update scheduler slots berdasarkan hasil reconciliation.
- Simpan error/recovery reason secara actionable.
- Emit state changes setelah daemon siap.
- Pastikan UI mengambil snapshot state setelah reconnect/startup.
- Uji daemon mati saat 3 agent running.
- Uji session hilang, worktree hilang, database metadata tersisa, dan process orphan.

### Output

- Restart recovery.
- Orphan worktree detection.
- Interrupted run state.

### Selesai jika

Restart daemon tidak menghilangkan task, run history, atau workspace; run yang tidak dapat dipulihkan ditandai `interrupted` dengan recovery action.

### Dependensi

- Phase 1–5.
- Scheduler dan OpenCode lifecycle V2.

---

## Phase 11 — Optional Terminal Per Workspace

### Tujuan

Menyediakan terminal opsional untuk task tanpa pernah mengarah default ke main workspace.

### Task

- Evaluasi kebutuhan terminal sebelum implementasi.
- Jika disetujui, tambahkan xterm.js pada UI.
- Tambahkan PTY service di daemon.
- Ikat setiap terminal ke path worktree task.
- Tolak terminal tanpa task/workspace valid.
- Tambahkan lifecycle open/resize/input/close.
- Batasi output dan cleanup process PTY.
- Pastikan permission/security policy diterapkan.
- Tambahkan tests bahwa terminal tidak berjalan pada main project secara default.

### Output

- Terminal per workspace atau keputusan tertulis untuk menunda fitur ini.

### Selesai jika

Terminal tersedia secara aman pada worktree task, atau phase ditutup dengan keputusan eksplisit bahwa terminal belum diperlukan V2.

### Dependensi

- Phase 2 dan Phase 9.
- Tidak memblokir core V2 bila ditunda.

---

## Phase 12 — Testing, Stress Test, dan Verifikasi V2

### Tujuan

Memastikan parallel execution, recovery, merge, dan UI dapat diregresikan.

### Unit test wajib

- AgentRun status dan retry transition.
- Scheduler queue ordering.
- Global concurrency limit.
- Per-project concurrency limit.
- Cancellation slot release.
- Worktree path/branch isolation.
- Event schema parsing dan bounded output.
- Permission state/decision.
- Mergeability and conflict mapping.
- Recovery reconciliation.

### Integration test wajib

- Dua worktree mengedit file berbeda.
- Dua worktree mengedit file sama.
- Dua agent memakai session berbeda dan cwd berbeda.
- Queue tiga task dengan concurrency limit.
- Cancel task queued dan running.
- Retry menghasilkan AgentRun baru.
- Merge A lalu B terhadap target HEAD terbaru.
- Conflict terdeteksi dan main workspace tetap aman.
- Daemon restart menjaga workspace dan metadata.
- Orphan worktree tidak dihapus otomatis.
- Bounded log rotation.

### E2E wajib

- Buat batch Frontend/Backend/Tests.
- Jalankan minimal dua task bersamaan.
- Tampilkan status/output real-time.
- Review diff masing-masing task.
- Cancel atau retry salah satu task.
- Merge task pertama.
- Deteksi conflict pada task kedua bila perubahan bertabrakan.
- Pastikan task kedua tetap dapat direview/discard.

### Command verifikasi

```bash
bun test
bun run check-types
bun run build
bunx biome check .
```

Tambahan:

```bash
loom doctor
```

dan smoke test manual pada temporary Git repository dengan OpenCode tersedia.

### Selesai jika

Seluruh test V2 pass dan Definition of Done V2 dapat diulang pada temporary repository.

---

## Milestone V2

| Milestone | Phase | Fokus | Exit criteria |
|---|---:|---|---|
| M1 | 0–1 | Baseline dan AgentRun | Run history serta retry tersedia tanpa merusak V1 |
| M2 | 2–3 | Isolation dan scheduler | Beberapa task dapat queued/running dalam batas concurrency |
| M3 | 4–5 | OpenCode dan events | Session/cwd independen dan output real-time tersedia |
| M4 | 6–7 | Permission dan API | Batch task, retry, permission, dan run history tersedia |
| M5 | 8 | Merge queue | Merge sequential dan conflict detection aman |
| M6 | 9 | UI parallel | Monitoring dan control multi-task tersedia |
| M7 | 10–11 | Reliability dan optional terminal | Restart recovery, orphan handling, dan keputusan terminal selesai |
| M8 | 12 | Verification | Definition of Done V2 tervalidasi |

## Definition of Done V2

V2 selesai jika user dapat membuat task:

```text
Frontend task
Backend task
```

Kemudian keduanya:

- berjalan bersamaan;
- memakai OpenCode session berbeda;
- memakai Git worktree berbeda;
- output/status muncul real-time;
- dapat direview secara independen;
- dapat di-merge satu per satu;
- conflict terdeteksi dengan aman;
- dapat di-cancel atau di-retry tanpa menghapus histori run;
- tetap memiliki state dan workspace yang dapat direkonsiliasi setelah daemon restart.

## Di luar scope V2

- Planner otomatis.
- DAG dependencies.
- AI conflict resolution.
- Cloud auth.
- Turso.
- Billing.
- Remote execution.
- Production updater.
- Marketplace agent.
