# Loom V1 MVP Implementation Plan

Referensi utama: [`docs/V1-MVP-LOCAL-AGENT.md`](docs/V1-MVP-LOCAL-AGENT.md)

## Tujuan V1

Membuktikan core loop secara end-to-end:

```text
Open Project → Create Task → Create Git Worktree → Create OpenCode Session
→ Run Agent → Stream Status/Output → Review Diff → Merge/Discard
```

Batasan utama V1:

- Satu task menggunakan satu workspace terisolasi.
- Maksimal satu active task terlebih dahulu.
- Web tidak mengakses filesystem, Git, atau OpenCode secara langsung.
- Fokus pada local-only workflow di `127.0.0.1`.
- Jangan mengerjakan fitur di luar V1 sebelum core loop stabil.

## Arsitektur Target

```text
apps/web
  └── packages/protocol

apps/daemon
  ├── packages/protocol
  ├── packages/database
  ├── packages/opencode
  ├── packages/worktree
  └── packages/orchestrator
```

Komponen utama:

- `apps/web`: UI SvelteKit 5.
- `apps/daemon`: daemon lokal Bun + Hono + WebSocket.
- `packages/protocol`: domain type dan event contract bersama.
- `packages/database`: SQLite + Drizzle.
- `packages/opencode`: adapter dan lifecycle OpenCode.
- `packages/worktree`: operasi Git worktree yang aman.
- `packages/orchestrator`: lifecycle task dari queued sampai selesai/gagal.

---

## Phase 0 — Audit dan Persiapan Repository

### Tujuan

Memastikan baseline repository sesuai dengan kebutuhan V1 sebelum menambah fitur baru.

### Langkah

- [ ] Audit struktur monorepo yang sudah ada.
- [ ] Cocokkan app dan package saat ini dengan struktur target.
- [ ] Tentukan apakah `apps/server` akan diubah menjadi `apps/daemon` atau dipertahankan dengan peran daemon.
- [ ] Audit script Bun, Turborepo, TypeScript, dan Biome.
- [ ] Pastikan strict TypeScript aktif.
- [ ] Pastikan file environment dan secret tidak ikut ter-commit.
- [ ] Tetapkan aturan dependency antar-app dan package.
- [ ] Catat keputusan arsitektur penting sebelum implementasi lintas package.

### Output

- Struktur repository yang dipahami dan disepakati.
- Daftar cleanup atau rename yang diperlukan.
- Baseline `bun run check` dan typecheck yang berhasil.

### Selesai jika

Repository siap menjadi fondasi implementasi tanpa mengubah scope V1.

---

## Phase 1 — Foundation dan Shared Protocol

### Tujuan

Membangun kontrak domain bersama agar web dan daemon berkomunikasi melalui tipe yang konsisten.

### Langkah

- [ ] Buat atau rapikan `packages/protocol`.
- [ ] Definisikan `Project`.
- [ ] Definisikan `TaskStatus` dan `Task`.
- [ ] Definisikan `Workspace`.
- [ ] Definisikan input API seperti `CreateProjectInput` dan `CreateTaskInput`.
- [ ] Definisikan seluruh `DaemonEvent`.
- [ ] Tambahkan runtime validation menggunakan library yang sudah dipakai repository.
- [ ] Pastikan package protocol tidak bergantung pada filesystem, database, Git, atau OpenCode.
- [ ] Tambahkan unit test untuk parsing dan validasi contract.

### Output

- Shared domain types.
- Shared API payload schemas.
- Shared WebSocket event schemas.

### Selesai jika

Web dan daemon dapat mengimpor contract yang sama tanpa duplikasi type.

---

## Phase 2 — Local Daemon dan Runtime Configuration

### Tujuan

Menyediakan daemon lokal sebagai satu-satunya gateway untuk filesystem, Git, database, dan OpenCode.

### Langkah

- [ ] Buat atau rapikan `apps/daemon` berbasis Bun + Hono.
- [ ] Tambahkan `GET /health`.
- [ ] Bind server hanya ke `127.0.0.1`.
- [ ] Tambahkan endpoint WebSocket untuk event daemon.
- [ ] Implementasikan broadcast event ke client yang terhubung.
- [ ] Buat resolver direktori `~/.loom`.
- [ ] Buat pengelolaan `~/.loom/config.json`.
- [ ] Generate dan simpan random local auth token.
- [ ] Terapkan strict CORS untuk origin UI lokal.
- [ ] Tambahkan middleware validasi token lokal.
- [ ] Tambahkan graceful shutdown.
- [ ] Pastikan error daemon tidak ditelan dan memiliki format yang konsisten.

### Output

- Daemon dapat start secara lokal.
- Health endpoint dan WebSocket tersedia.
- Konfigurasi lokal aman dan tidak bergantung pada working directory.

### Selesai jika

Daemon bisa dijalankan, diverifikasi melalui health check, dan menerima koneksi UI lokal.

---

## Phase 3 — Database dan Persistence

### Tujuan

Menyimpan metadata workflow di SQLite tanpa menyimpan source code atau payload besar.

### Langkah

- [ ] Buat atau rapikan `packages/database` berbasis SQLite + Drizzle.
- [ ] Gunakan default database `~/.loom/state.db`.
- [ ] Buat tabel `projects`.
- [ ] Buat tabel `tasks`.
- [ ] Buat tabel `workspaces`.
- [ ] Buat tabel `agent_runs`.
- [ ] Tambahkan relasi dan index untuk lookup task/project/workspace.
- [ ] Tambahkan migration atau schema push sesuai pola repository.
- [ ] Implementasikan repository/query untuk CRUD minimal.
- [ ] Tambahkan validasi state dan foreign key yang relevan.
- [ ] Jangan simpan source code, credentials, binary blobs, terminal history besar, atau full OpenCode messages.
- [ ] Tambahkan test persistence menggunakan database sementara.

### Output

- Schema database V1.
- Data access layer untuk project, task, workspace, dan agent run.

### Selesai jika

Daemon dapat restart tanpa kehilangan metadata workflow yang sudah tersimpan.

---

## Phase 4 — Project Manager

### Tujuan

Memungkinkan user mendaftarkan dan memilih project Git lokal yang valid.

### Langkah

- [ ] Implementasikan project manager di daemon.
- [ ] Tambahkan `POST /api/projects`.
- [ ] Tambahkan `GET /api/projects`.
- [ ] Tambahkan `GET /api/projects/:id`.
- [ ] Tambahkan `DELETE /api/projects/:id`.
- [ ] Validasi path berbentuk directory.
- [ ] Validasi project adalah repository Git.
- [ ] Validasi executable Git tersedia.
- [ ] Deteksi default branch.
- [ ] Simpan metadata project ke SQLite.
- [ ] Tambahkan pengecekan project masih tersedia saat dibaca atau dipakai.
- [ ] Validasi path agar tidak membuka akses di luar kebutuhan local workflow.
- [ ] Tambahkan test untuk project valid, path tidak ada, dan non-repository.

### Output

- Project bisa didaftarkan, ditampilkan, dibaca, dan dihapus.
- Project menyimpan path dan default branch.

### Selesai jika

User dapat mendaftarkan repository lokal valid melalui API daemon.

---

## Phase 5 — Worktree Manager

### Tujuan

Menyediakan workspace terisolasi untuk setiap task tanpa merusak main workspace user.

### Langkah

- [ ] Buat `packages/worktree`.
- [ ] Tentukan root path `~/.loom/worktrees/<project-id>/<task-id>`.
- [ ] Terapkan branch convention `loom/<task-id>`.
- [ ] Implementasikan pembacaan HEAD/base commit.
- [ ] Implementasikan `git worktree add` melalui command runner yang aman.
- [ ] Simpan metadata workspace ke SQLite.
- [ ] Implementasikan `remove`.
- [ ] Implementasikan `merge`.
- [ ] Implementasikan `discard`.
- [ ] Pilih satu strategi merge V1 dan gunakan konsisten: squash merge atau commit lalu cherry-pick.
- [ ] Jangan menjalankan `git reset --hard` pada main workspace.
- [ ] Jangan menghapus user branch otomatis tanpa verifikasi.
- [ ] Jangan overwrite uncommitted user files.
- [ ] Tangani worktree yang sudah hilang atau tidak valid.
- [ ] Tambahkan unit test untuk path dan nama branch.
- [ ] Tambahkan integration test dengan temporary Git repository.

### Output

- Workspace task terisolasi.
- Operasi create, remove, merge, dan discard yang aman.

### Selesai jika

Task dapat memiliki branch/worktree sendiri dan main workspace tetap aman.

---

## Phase 6 — OpenCode Manager dan Agent Adapter

### Tujuan

Mengintegrasikan OpenCode melalui abstraction internal tanpa menyebarkan detail OpenCode ke seluruh codebase.

### Langkah

- [ ] Buat `packages/opencode`.
- [ ] Implementasikan interface `OpenCodeManager`.
- [ ] Implementasikan discovery executable OpenCode.
- [ ] Implementasikan pengecekan server yang sedang berjalan.
- [ ] Implementasikan start `opencode serve`.
- [ ] Implementasikan health polling dengan timeout.
- [ ] Implementasikan stop dan cleanup process.
- [ ] Implementasikan interface `AgentRuntime`.
- [ ] Implementasikan `createSession` dengan cwd workspace.
- [ ] Implementasikan `prompt`.
- [ ] Implementasikan `abort`.
- [ ] Implementasikan `getDiff` atau adapter diff dari workspace.
- [ ] Buat parser response/status OpenCode yang tervalidasi.
- [ ] Pisahkan lifecycle process dari UI.
- [ ] Tangani OpenCode tidak terpasang, server gagal start, timeout, dan response invalid.
- [ ] Tambahkan unit test parser dan mock adapter.

### Output

- OpenCode server lifecycle manager.
- Runtime adapter yang bisa dipakai orchestrator.

### Selesai jika

Daemon dapat mendeteksi, menjalankan, dan berkomunikasi dengan OpenCode melalui interface internal.

---

## Phase 7 — Task Orchestrator

### Tujuan

Menghubungkan project, worktree, OpenCode, dan database menjadi lifecycle task end-to-end.

### Langkah

- [ ] Buat `packages/orchestrator`.
- [ ] Implementasikan `create(input)` dengan status `queued`.
- [ ] Implementasikan `start(taskId)`.
- [ ] Buat workspace dan ubah status menjadi `preparing`.
- [ ] Buat OpenCode session menggunakan cwd workspace.
- [ ] Simpan session ID.
- [ ] Ubah status menjadi `running`.
- [ ] Kirim prompt user ke agent.
- [ ] Stream atau teruskan status/output yang aman ke event bus.
- [ ] Ubah status menjadi `completed` jika agent selesai.
- [ ] Simpan waktu mulai dan selesai.
- [ ] Ubah status menjadi `failed` untuk error yang dapat ditindaklanjuti.
- [ ] Implementasikan `cancel(taskId)` dengan abort agent dan cleanup yang aman.
- [ ] Batasi satu active task pada V1.
- [ ] Pastikan restart daemon dapat merekonsiliasi task yang sebelumnya aktif.
- [ ] Jangan menghapus metadata error.
- [ ] Tambahkan unit test state transition.
- [ ] Tambahkan integration test lifecycle task dengan dependency yang dimock.

### Output

- Task lifecycle queued → preparing → running → completed/failed/cancelled.
- Event task yang konsisten.

### Selesai jika

Satu task dapat berjalan dari prompt sampai status terminal tanpa operasi manual di luar daemon.

---

## Phase 8 — API dan Event Delivery

### Tujuan

Menyediakan API yang dibutuhkan UI dan delivery event real-time melalui WebSocket.

### Langkah

- [ ] Tambahkan endpoint project manager ke daemon.
- [ ] Tambahkan endpoint create/list/detail task.
- [ ] Tambahkan endpoint start/cancel task.
- [ ] Tambahkan endpoint detail workspace/task.
- [ ] Tambahkan endpoint diff: changed files, additions/deletions, unified diff.
- [ ] Tambahkan endpoint merge task.
- [ ] Tambahkan endpoint discard task.
- [ ] Validasi seluruh payload request dan response.
- [ ] Emit `task.created`.
- [ ] Emit `task.started`.
- [ ] Emit `task.updated`.
- [ ] Emit `task.completed`.
- [ ] Emit `task.failed` dengan actionable message.
- [ ] Tangani reconnect WebSocket.
- [ ] Pastikan event hanya mengandung data yang diperlukan.
- [ ] Tambahkan test API untuk success dan error path.

### Output

- API lengkap untuk core workflow.
- Real-time task status/output tanpa polling terus-menerus.

### Selesai jika

Client dapat membuat, memantau, membatalkan, mereview, merge, dan discard task melalui daemon.

---

## Phase 9 — UI V1

### Tujuan

Membangun UI minimal yang menyelesaikan flow utama tanpa state library tambahan.

### Langkah

- [ ] Buat route `/projects`.
- [ ] Buat route `/project/:id`.
- [ ] Buat route `/task/:id`.
- [ ] Implementasikan project selector/list.
- [ ] Implementasikan form add project.
- [ ] Implementasikan task creation form dengan title dan prompt.
- [ ] Implementasikan Svelte 5 Runes untuk state task/project.
- [ ] Implementasikan WebSocket client dan reconnect.
- [ ] Tampilkan status task: queued, preparing, running, completed, failed, cancelled.
- [ ] Tampilkan agent activity/output yang relevan.
- [ ] Tambahkan tombol Cancel saat task aktif.
- [ ] Implementasikan diff viewer sederhana.
- [ ] Tampilkan daftar changed files.
- [ ] Tampilkan additions/deletions.
- [ ] Tampilkan unified diff.
- [ ] Tambahkan tombol Merge dan Discard.
- [ ] Tampilkan error actionable di UI.
- [ ] Jangan membuat diff editor kompleks.
- [ ] Tambahkan loading, empty, dan unavailable states.

### Output

- UI project/task/diff yang dapat menjalankan core workflow.

### Selesai jika

User dapat menyelesaikan workflow V1 hanya melalui UI lokal.

---

## Phase 10 — CLI dan Doctor

### Tujuan

Menyediakan entry point `loom` untuk menjalankan seluruh local experience.

### Langkah

- [ ] Buat command `loom`.
- [ ] Buat command `loom --version`.
- [ ] Buat command `loom doctor`.
- [ ] Saat `loom` dijalankan, start daemon.
- [ ] Check atau start OpenCode.
- [ ] Serve UI.
- [ ] Buka browser ke `http://127.0.0.1:4317`.
- [ ] Pastikan bind hanya ke localhost.
- [ ] `doctor` memeriksa Bun, Git, OpenCode, config, database, port, dan permission directory.
- [ ] Format output doctor agar actionable.
- [ ] Tangani daemon/OpenCode process cleanup saat CLI berhenti.

### Output

- Fresh user dapat menjalankan aplikasi dengan `loom`.
- Masalah environment dapat didiagnosis dengan `loom doctor`.

### Selesai jika

Perintah `loom` menjalankan daemon, OpenCode, UI, dan browser secara konsisten.

---

## Phase 11 — Error Handling dan Security Hardening

### Tujuan

Membuat V1 aman digunakan pada local machine dan memiliki pesan error yang dapat ditindaklanjuti.

### Langkah

- [ ] Tangani Git tidak tersedia.
- [ ] Tangani OpenCode tidak tersedia.
- [ ] Tangani project bukan repository.
- [ ] Tangani worktree creation gagal.
- [ ] Tangani agent gagal atau timeout.
- [ ] Tangani daemon restart.
- [ ] Tangani workspace hilang.
- [ ] Tangani merge conflict.
- [ ] Tampilkan error dengan context dan recovery action.
- [ ] Pastikan localhost-only.
- [ ] Terapkan strict CORS.
- [ ] Terapkan random local auth token.
- [ ] Validasi filesystem paths.
- [ ] Pastikan command shell tidak menggunakan raw concatenated input.
- [ ] Audit logging agar tidak membocorkan credentials.
- [ ] Verifikasi cleanup orphan worktrees.
- [ ] Verifikasi tidak ada perubahan tak disengaja pada main workspace.

### Output

- Error model dan UI error state yang konsisten.
- Local security baseline V1.

### Selesai jika

Failure umum menghasilkan pesan jelas dan tidak merusak project utama atau membocorkan secret.

---

## Phase 12 — Testing dan Verifikasi End-to-End

### Tujuan

Memastikan core loop bekerja secara otomatis dan dapat diregresikan.

### Unit Test

- [ ] Worktree path generation.
- [ ] Branch naming.
- [ ] Task state transition.
- [ ] Protocol/schema validation.
- [ ] OpenCode response parser.
- [ ] Config/token handling.
- [ ] Error mapping.

### Integration Test

- [ ] Buat temporary Git repository.
- [ ] Register project.
- [ ] Buat worktree.
- [ ] Mutasi file dari workspace.
- [ ] Review diff.
- [ ] Merge.
- [ ] Verifikasi perubahan ada di target branch.
- [ ] Remove worktree.
- [ ] Verifikasi discard tidak mengubah main workspace.
- [ ] Verifikasi merge conflict ditangani.

### E2E Test

- [ ] Open project.
- [ ] Create task.
- [ ] Task berjalan sampai completed.
- [ ] Diff terlihat.
- [ ] Merge berhasil.
- [ ] Main workspace tetap valid.

### Verification Commands

- [ ] `bun run check`
- [ ] `bun run check-types`
- [ ] Test unit.
- [ ] Test integration.
- [ ] Test E2E.
- [ ] `loom doctor` pada environment bersih.
- [ ] Manual smoke test dari command `loom`.

### Selesai jika

Semua test utama pass dan core loop dapat diulang pada repository temporary maupun project lokal nyata.

---

## Urutan Milestone

| Milestone | Phase | Fokus | Exit Criteria |
| --- | --- | --- | --- |
| M1 | 0–1 | Foundation | Struktur dan protocol stabil |
| M2 | 2–3 | Daemon + persistence | Daemon hidup dan metadata tersimpan |
| M3 | 4–5 | Project + Git | Project tervalidasi dan worktree aman |
| M4 | 6 | OpenCode | Session dan prompt berjalan |
| M5 | 7–8 | Task orchestration | Lifecycle dan event tersedia |
| M6 | 9–10 | UI + CLI | Core flow bisa dipakai user |
| M7 | 11–12 | Hardening + verification | Definition of Done V1 tercapai |

## Definition of Done V1

V1 dianggap selesai jika fresh user dapat menjalankan:

```bash
loom
```

Lalu:

1. Memilih Git project lokal.
2. Membuat satu coding task.
3. Menjalankan task melalui OpenCode.
4. Membuat perubahan di Git worktree terpisah.
5. Melihat diff.
6. Merge atau discard perubahan.
7. Memastikan main workspace user tidak rusak.

## Di luar Scope V1

Jangan kerjakan sebelum core loop stabil:

- Parallel agents.
- Task DAG.
- Planner agent.
- Cloud auth.
- Turso.
- Billing.
- Remote access.
- VS Code extension.
- Terminal penuh.
- AI merge conflict resolver.
- Auto updater.
- Team collaboration.

## Aturan Eksekusi

- Kerjakan phase secara berurutan, tetapi izinkan test dan hardening berjalan sejak komponen pertama dibuat.
- Setiap phase harus memiliki exit criteria yang diverifikasi sebelum lanjut.
- Jangan menambah abstraction yang belum dibutuhkan oleh core loop.
- Semua operasi filesystem, Git, SQLite, dan OpenCode tetap berada di daemon/package backend.
- Setiap perubahan lintas package harus diikuti check, typecheck, dan test relevan.
- Jangan commit perubahan sebelum review diff dan verifikasi lokal selesai.
