# V4 — Distribution, Updates, Cloud & Production

> Goal: membuat produk bisa dipakai user lain dengan instalasi satu command, update otomatis, optional cloud account, dan release pipeline production-grade.

Prerequisite: V1–V3 core product sudah stabil.

---

## 1. Target User Experience

Install:

```bash
curl -fsSL https://loom.dev/install | bash
```

Run:

```bash
loom
```

Update:

```bash
loom update
```

Doctor:

```bash
loom doctor
```

Normal startup:

```text
Loom v1.x

✓ Git
✓ OpenCode
✓ Local database
✓ Agent daemon

Opening http://127.0.0.1:4317
```

---

## 2. Distribution Strategy

Target akhir:

```text
standalone Bun executable
```

Artifacts:

```text
loom-darwin-arm64
loom-darwin-x64
loom-linux-x64
loom-linux-arm64
loom-windows-x64.exe
```

User tidak perlu install Node/npm/Bun.

---

## 3. Build Binary

Entry:

```text
apps/daemon/src/cli.ts
```

Build konsep:

```bash
bun build ./apps/daemon/src/cli.ts \
  --compile \
  --outfile ./dist/loom
```

CI build per OS/architecture.

Pastikan seluruh static web assets tersedia pada distribution artifact.

---

## 4. CLI Commands

Minimum:

```bash
loom
loom start
loom stop
loom restart

loom update
loom doctor

loom --version
loom help
```

Optional:

```bash
loom open
loom logs
loom config
```

---

## 5. Install Directory

Unix:

```text
~/.loom/
├── bin/
│   └── loom
├── state.db
├── config.json
├── logs/
├── worktrees/
└── cache/
```

Platform-specific data directory dapat digunakan kemudian.

---

## 6. Installer

Endpoint:

```text
https://loom.dev/install
```

Installer responsibilities:

1. detect OS
2. detect architecture
3. resolve latest stable release
4. download artifact
5. verify checksum/signature
6. install binary
7. ensure PATH
8. print success

Jangan menjalankan arbitrary release script setelah download.

---

## 7. GitHub Release Pipeline

Recommended:

```text
push/merge
   ↓
versioning
   ↓
tag
   ↓
GitHub Actions
   ↓
test
   ↓
build matrix
   ↓
checksums
   ↓
GitHub Release
   ↓
latest manifest
```

Use:

- GitHub Actions
- Changesets atau release-please
- GitHub Releases

---

## 8. Release Manifest

Contoh:

```json
{
  "version": "1.4.0",
  "protocolVersion": 7,
  "releasedAt": "2026-09-12T00:00:00Z",
  "artifacts": {
    "darwin-arm64": {
      "url": "...",
      "sha256": "..."
    },
    "linux-x64": {
      "url": "...",
      "sha256": "..."
    },
    "windows-x64": {
      "url": "...",
      "sha256": "..."
    }
  }
}
```

Channels:

```text
stable
beta
nightly
```

Tidak perlu nightly pada initial production release.

---

## 9. Updater

Architecture:

```text
running daemon
    ↓
check manifest
    ↓
new release
    ↓
download temp binary
    ↓
verify
    ↓
spawn updater/helper
    ↓
old daemon exits
    ↓
atomic replace
    ↓
new daemon starts
```

Jangan overwrite executable secara sembarang saat sedang berjalan.

---

## 10. Update UX

UI:

```text
Loom 1.4.0 is available

Current: 1.3.2

[Release Notes]
[Update & Restart]
[Later]
```

CLI:

```bash
loom update
```

---

## 11. Automatic Check

Check update:

- pada startup
- maksimal sekali dalam interval tertentu
- request harus cepat
- kegagalan update check tidak boleh menghalangi app startup

Local cache:

```json
{
  "lastUpdateCheck": "...",
  "latestSeen": "1.4.0"
}
```

---

## 12. Protocol Version

Jangan gunakan app version sebagai satu-satunya compatibility signal.

```ts
export const PROTOCOL_VERSION = 7;
```

Daemon:

```json
{
  "version": "1.4.0",
  "protocolVersion": 7
}
```

Ini penting jika kelak UI dan daemon didistribusikan secara terpisah.

---

## 13. Optional Cloud Architecture

Cloud **bukan tempat OpenCode menjalankan coding task**.

```text
                Cloud
           ┌───────────────┐
           │ SvelteKit     │
           │ Hono API      │
           │ Auth          │
           │ Turso         │
           └───────┬───────┘
                   │
              metadata only
                   │
           ┌───────▼───────┐
           │ Local daemon  │
           │ OpenCode      │
           │ Git/worktree  │
           │ source code   │
           └───────────────┘
```

---

## 14. Vercel

Jika cloud dashboard diperlukan:

```text
apps/cloud-web
```

Deploy:

```text
Vercel
```

Use cases:

- landing page
- account dashboard
- documentation
- authentication
- device management
- subscription
- release metadata

Core local daemon tetap berjalan di user computer.

---

## 15. Turso

Cloud DB:

```text
Turso
```

ORM:

```text
Drizzle
```

Cloud tables:

```text
users
accounts
sessions
organizations
memberships

devices
licenses
subscriptions

cloud_settings
release_channels
```

Optional:

```text
projects metadata
task metadata
```

---

## 16. Data Privacy Rule

Default jangan upload:

- source files
- `.env`
- full diff
- terminal output
- local secrets
- OpenCode conversations
- arbitrary filesystem contents

Cloud sync harus explicit dan documented.

---

## 17. Better Auth

Jika account dibutuhkan:

```text
Better Auth
+
Turso
```

Local daemon tidak menggunakan browser session cookie sebagai permanent credential.

Gunakan device credential.

---

## 18. Device Authentication

Flow:

```bash
loom login
```

CLI:

```text
Open:
https://loom.dev/device

Code:
ABCD-EFGH
```

Browser authorizes device.

Daemon menerima device token.

Store securely.

---

## 19. Security Hardening

Daemon memiliki capability sangat tinggi.

Wajib:

- bind `127.0.0.1`
- authentication token
- origin validation
- path validation
- CSRF protections where applicable
- command argument escaping
- secret redaction
- update checksum/signature verification
- no wildcard CORS

Never:

```text
Access-Control-Allow-Origin: *
```

untuk endpoint shell/filesystem.

---

## 20. Telemetry

Jika telemetry ditambahkan:

- opt-in atau transparan
- tidak mengirim source code
- tidak mengirim prompt secara default
- document event list
- support disable command/config

Contoh safe events:

```text
app_started
task_created
task_completed
task_failed
update_installed
```

---

## 21. Crash Reporting

Pastikan redaction:

```text
paths
tokens
API keys
environment
prompts
source snippets
```

Crash report harus scrub sebelum upload.

---

## 22. Cloud Is Optional

Local app harus tetap dapat bekerja tanpa login jika business model memungkinkan.

Ideal:

```text
Core:
local-first

Cloud:
optional enhancements
```

Possible paid features:

```text
teams
sync
remote control
shared templates
organization policy
usage analytics
```

---

## 23. Documentation

Production docs wajib punya:

```text
Installation
Getting Started
OpenCode requirements
Project safety
Parallel tasks
Git worktrees
Updates
Uninstall
Troubleshooting
Privacy
Security
```

---

## 24. Uninstall

Provide:

```bash
loom uninstall
```

Jangan langsung delete user-created branches/worktrees tanpa confirmation.

Pisahkan:

```text
binary
app state
worktrees
logs
```

---

## 25. Doctor

```bash
loom doctor
```

Check:

```text
OS
architecture
Git
OpenCode
filesystem permissions
state DB
daemon port
worktrees
version/update
```

Output:

```text
✓ Git 2.x
✓ OpenCode available
✓ state.db healthy
✓ port 4317 free
✓ 0 orphan worktrees
```

---

## 26. Production Observability

Local logs:

```text
~/.loom/logs/
```

Structured logging:

```json
{
  "level": "info",
  "component": "scheduler",
  "event": "task.started",
  "taskId": "..."
}
```

Support:

```bash
loom logs
```

---

## 27. Release Channels

Config:

```json
{
  "releaseChannel": "stable"
}
```

Commands:

```bash
loom update
loom update --channel beta
```

Stable adalah default.

---

## 28. Rollback

Updater harus menyimpan previous executable sementara.

Flow:

```text
download new
→ preserve old
→ install
→ health check
→ success

if startup fails:
→ restore previous
```

Production updater tanpa rollback terlalu berisiko.

---

## 29. Milestones

### M1 — CLI packaging

- [ ] standalone binary
- [ ] static assets packaging
- [ ] platform detection

### M2 — GitHub release

- [ ] version workflow
- [ ] build matrix
- [ ] GitHub Release
- [ ] checksum

### M3 — Installer

- [ ] shell installer
- [ ] Windows install flow
- [ ] PATH setup

### M4 — Updater

- [ ] manifest
- [ ] version check
- [ ] download
- [ ] verification
- [ ] atomic replace
- [ ] restart
- [ ] rollback

### M5 — Cloud optional

- [ ] Vercel project
- [ ] Turso
- [ ] Better Auth
- [ ] device registration

### M6 — Security

- [ ] threat model
- [ ] local auth
- [ ] CORS/origin policy
- [ ] secret redaction
- [ ] updater integrity

### M7 — Production docs

- [ ] install
- [ ] updates
- [ ] troubleshooting
- [ ] privacy/security

---

## 30. Definition of Done V4

Fresh user dapat:

```bash
curl -fsSL https://loom.dev/install | bash
loom
```

dan:

1. app berjalan tanpa setup runtime JS tambahan;
2. UI lokal terbuka;
3. OpenCode terdeteksi/dikelola;
4. core multi-agent workflow tersedia;
5. app dapat mendeteksi versi baru;
6. update dapat dilakukan dengan aman;
7. rollback tersedia jika update gagal;
8. cloud account bersifat optional sesuai kebutuhan;
9. source code user tetap local secara default.

Pada tahap ini produk siap didistribusikan ke user eksternal.
