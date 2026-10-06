# Loom: Provider-Aware Chat and Model Discovery

## Tujuan

Perbaiki alur chat agar provider dan model yang dipilih user benar-benar dipakai saat pesan dikirim. Setelah itu tambahkan discovery model yang seragam untuk Claude Code, Codex, Agy, dan OpenCode, fallback provider yang dapat dikonfigurasi, serta test yang membuktikan chat dikirim melalui provider pilihan.

Canvas UI/UX tetap terpisah. Canvas hanya memanggil model tanpa tool dan tidak boleh menulis file proyek.

## Masalah utama

- Dropdown model sudah menampilkan model, tetapi request chat tidak selalu membawa `provider` dan `model`.
- Server masih dapat fallback ke OpenCode secara implisit.
- Loading UI masih memakai label tetap seperti "opencode is working".
- Model Antigravity dipilih di UI, tetapi proses yang di-spawn dapat tetap OpenCode.
- Status connected hanya menunjukkan provider terhubung; status itu belum menjamin model katalog dapat dipakai.
- Tidak semua CLI memiliki perintah list model resmi yang sama.
- Fallback belum memiliki konfigurasi, batas hop, atau handoff yang tersimpan.

## Arsitektur target

### Chat coding

- Route: `/project/[id]`.
- Server: `apps/server/src/chat.ts` dan service provider.
- Working directory: folder project user.
- Runtime: CLI provider dengan tools dan izin coding.
- Output: event stream, perubahan file, command output, error, dan final response.
- Chat tidak menghasilkan kartu HTML.

### Canvas

- Route: `/project/[id]/canvas`.
- Runtime: model API/design provider tanpa tools dan tanpa akses ke folder project.
- Output: HTML self-contained yang disimpan di state kartu/canvas.
- Tidak boleh men-spawn `claude`, `codex`, `agy`, atau `opencode`.
- Tidak boleh menulis, mengubah, atau menghapus file project.

## 1. Perbaiki request chat

### Payload UI

Saat user mengirim pesan, UI wajib mengirim object berikut:

```ts
type SendChatInput = {
  projectId: string;
  chatSessionId: string;
  message: string;
  provider: "claude" | "codex" | "agy" | "opencode";
  modelId: string | null;
  fallbackPolicyId?: string | null;
};
```

`modelId: null` berarti gunakan default provider. Jangan mengganti null dengan OpenCode.

### Validasi server

`apps/server/src/chat.ts` harus:

1. Memvalidasi `projectId`, `chatSessionId`, `provider`, dan `modelId`.
2. Memastikan provider terhubung untuk user tersebut.
3. Memastikan model berasal dari katalog atau manual override yang disimpan user.
4. Memilih adapter berdasarkan `provider`, bukan berdasarkan model name.
5. Meneruskan `modelId` ke adapter.
6. Menyimpan command efektif dan provider efektif ke `cli_runs` sebelum proses dimulai.

Jika provider tidak tersedia, kembalikan error terstruktur. Jangan diam-diam mengganti provider ke OpenCode.

```ts
type ProviderRunRequest = {
  provider: ProviderId;
  modelId?: string;
  cwd: string;
  prompt: string;
  sessionId?: string;
  systemPromptFile?: string;
};
```

### Loading UI

Jangan hardcode `opencode is working`.

```ts
const workingLabel = `${providerLabel} is working`;
```

Label harus berasal dari run event server:

```ts
type RunStartedEvent = {
  runId: string;
  provider: ProviderId;
  modelId: string | null;
  displayName: string;
};
```

Jika provider yang dipilih adalah Agy, loading wajib menyebut Agy. Jika server benar-benar menjalankan OpenCode karena fallback, UI harus menampilkan `Fallback: OpenCode`.

## 2. Provider adapter contract

Semua adapter mengimplementasikan kontrak yang sama:

```ts
interface ProviderAdapter {
  id: ProviderId;
  detect(input: DetectInput): Promise<ProviderInstallStatus>;
  connect(input: ConnectInput): Promise<ProviderConnectionStatus>;
  discoverModels(input: DiscoverModelInput): Promise<DiscoveredModel[]>;
  start(input: StartRunInput): Promise<ProviderProcess>;
  resume(input: ResumeRunInput): Promise<ProviderProcess>;
  classifyError(error: ProviderErrorInput): ProviderErrorClass;
}
```

`start()` dan `resume()` harus menerima provider serta model eksplisit. Adapter tidak boleh memanggil OpenCode sebagai default.

Provider IDs:

```ts
type ProviderId = "claude" | "codex" | "agy" | "opencode";
```

## 3. Command mapping

Jangan menganggap semua CLI memiliki command yang sama. Gunakan adapter masing-masing.

### Claude Code

Giliran baru:

```bash
claude -p --output-format stream-json --model "<modelId>" "<prompt>"
```

Jika `modelId` null, hilangkan `--model`.

Lanjut sesi Claude yang sama:

```bash
claude -p --resume "<cliSessionId>" "<prompt>"
```

Sesi terakhir hanya untuk penggunaan manual:

```bash
claude -c
```

Jangan pakai `claude models`. Tidak ada katalog non-interaktif yang stabil. Discovery Claude menggabungkan model/alias dari konfigurasi lokal dan manual override. Alias seperti `BACKEND`, `FRONTEND`, dan `commandcode` harus diteruskan apa adanya.

### Codex

Giliran baru memakai `codex exec`:

```bash
codex exec --json --model "<modelId>" "<prompt>"
```

Jika CLI versi terpasang menyediakan resume exec, gunakan:

```bash
codex exec resume "<cliSessionId>" "<prompt>"
```

Jangan mengasumsikan sesi interactive Codex dapat dilanjutkan oleh sesi `exec`. Jika resume tidak tersedia atau gagal, buat proses baru dengan handoff Loom.

### Agy / Antigravity

Giliran baru:

```bash
agy --print \
  --output-format stream-json \
  --model "<modelId>" \
  "<prompt>"
```

Sesi Agy yang sama:

```bash
agy --print \
  --output-format stream-json \
  --conversation "<cliSessionId>" \
  "<prompt>"
```

Agy tidak memiliki flag `--append-system-prompt-file`. Isi `coding.md` harus digabungkan ke prompt, atau menggunakan mekanisme agent/skill yang didukung Agy. Jangan menjalankan `agy auth`, `agy login`, atau `agy models` sebagai asumsi universal tanpa memeriksa versi CLI.

### OpenCode

Giliran baru:

```bash
opencode run --model "<provider>/<model>" "<prompt>"
```

Lanjut sesi:

```bash
opencode run --session "<cliSessionId>" "<prompt>"
```

Model wajib dipertahankan dalam bentuk provider/model jika OpenCode memerlukannya. Jangan hanya menyimpan label tampilan.

## 4. Model discovery universal

Gunakan satu model internal untuk semua provider:

```ts
type DiscoveredModel = {
  provider: ProviderId;
  id: string;
  label: string;
  source: "cli" | "config" | "managed" | "manual";
  isDefault: boolean;
  isAvailable: boolean;
  supportsEffort?: boolean;
  metadata?: Record<string, unknown>;
};
```

Sumber discovery:

- OpenCode: `opencode models`.
- Agy: `agy models` bila tersedia.
- Claude: konfigurasi lokal, alias yang ditemukan, default provider, dan manual override.
- Codex: katalog yang tersedia pada versi CLI, konfigurasi lokal, atau manual override.

Discovery tidak boleh menghapus model lama ketika refresh gagal. Tandai `isAvailable: false` dan simpan `lastSeenAt`.

UI harus dapat memilih:

- default provider (`modelId: null`);
- model hasil discovery;
- custom alias/model manual.

## 5. Fallback provider

Fallback hanya aktif bila policy mengizinkan dan error tergolong:

- quota / credit exhausted;
- rate limit / 429;
- provider auth expired;
- provider binary unavailable.

Jangan fallback untuk:

- syntax error aplikasi;
- test project gagal;
- user cancel;
- permission denial yang harus dilihat user;
- prompt validation error;
- model name invalid, kecuali policy secara eksplisit mengizinkan.

Policy:

```ts
type FallbackPolicy = {
  enabled: boolean;
  provider: ProviderId | null;
  modelId: string | null;
  maxHops: 0 | 1;
};
```

Default aman:

```json
{
  "enabled": false,
  "provider": null,
  "modelId": null,
  "maxHops": 0
}
```

Jika user mengaktifkan fallback, contoh:

```json
{
  "enabled": true,
  "provider": "opencode",
  "modelId": "opencode/big-pickle",
  "maxHops": 1
}
```

Flow:

1. Start provider/model yang user pilih.
2. Simpan run sebagai `running`.
3. Jika proses selesai normal, simpan response dan session ID.
4. Jika error fallbackable, klasifikasikan error.
5. Buat handoff dari thread Loom dan `git status`.
6. Start provider fallback di `cwd` yang sama.
7. Kirim handoff sebagai prompt baru.
8. UI menampilkan event `fallback_started`.
9. Jika fallback gagal, berhenti; jangan fallback kedua kalinya.

ID sesi CLI tidak boleh dipindahkan antar-provider. Yang dipindahkan adalah handoff:

```md
Continue the user's task in the current project.

Original request:
{{request}}

Completed work:
{{completed}}

Changed files:
{{gitStatus}}

Last provider error:
{{safeError}}

Remaining work:
{{remaining}}

Do not undo valid changes. Inspect the current files before editing.
```

Jangan masukkan API key, token, environment secret, atau transcript sensitif ke handoff.

## 6. Rancangan database

Tambahkan tabel berikut melalui `packages/db/src/schema`.

### `chat_sessions`

```text
id
project_id
user_id
title
status              -- idle | running | fallback | completed | error | cancelled
selected_provider
selected_model_id
active_provider
active_model_id
active_cli_session_id
fallback_policy_id
created_at
updated_at
```

### `chat_messages`

```text
id
session_id
role                -- user | assistant | system | tool
content
sequence
provider
model_id
run_id
created_at
```

### `cli_runs`

```text
id
chat_session_id
provider
model_id
cli_session_id
cwd
status              -- queued | running | completed | failed | cancelled
command_display     -- redacted; jangan simpan secret
exit_code
error_class
error_message       -- sanitized
started_at
finished_at
```

### `fallback_policies`

```text
id
user_id
project_id
name
enabled
fallback_provider
fallback_model_id
max_hops
created_at
updated_at
```

### `model_catalog`

```text
id
user_id
project_id
provider
model_id
label
source
is_default
is_available
supports_effort
metadata_json
last_seen_at
created_at
updated_at
```

Tambahkan unique key untuk `(user_id, project_id, provider, model_id)`.

## 7. Perubahan UI settings

Di `/settings/providers` tampilkan tiga keadaan berbeda:

- Installed: binary ditemukan.
- Connected: login atau health check berhasil.
- Models loaded: katalog berhasil dibaca atau cache tersedia.

Jangan menampilkan connected sebagai jaminan model tersedia.

Tambahkan form fallback:

- Enable fallback.
- Fallback provider.
- Fallback model.
- Test fallback connection.
- Reset to disabled.

Jika model dari discovery gagal, user dapat memilih `Custom model / alias`.

## 8. Startup model loading

Saat daemon dimulai:

1. Baca katalog dari database.
2. Tampilkan cache ke UI segera.
3. Jalankan discovery provider secara paralel dengan timeout sekitar 5 detik per provider.
4. Merge berdasarkan `(provider, model_id)`.
5. Kirim event catalog updated.
6. Jangan menghapus cache jika command discovery gagal.

Jangan spawn sesi interaktif untuk membuka `/models`. Gunakan command discovery non-interaktif atau konfigurasi lokal.

## 9. Test wajib: provider yang dipilih

Ini bagian wajib sebelum fitur dianggap selesai. Test harus membuktikan bahwa pesan benar-benar dikirim ke provider dan model yang dipilih, bukan hanya dropdown berubah.

### Unit test request mapping

File: `packages/providers/test/adapters.test.ts`.

Gunakan fake process runner. Jangan menjalankan CLI asli.

```ts
it("sends Agy chat to agy with selected model", async () => {
  await adapter.start({
    provider: "agy",
    modelId: "gemini-custom",
    cwd: "/tmp/project",
    prompt: "hello",
  });

  expect(spawnMock).toHaveBeenCalledWith(
    "agy",
    expect.arrayContaining([
      "--print",
      "--output-format",
      "stream-json",
      "--model",
      "gemini-custom",
    ]),
    expect.objectContaining({ cwd: "/tmp/project" }),
  );
});
```

Buat test ekuivalen untuk Claude, Codex, dan OpenCode. Pastikan assertion provider executable tidak hanya model.

### Server integration test

File: `apps/server/test/chat-provider-routing.test.ts`.

Test case minimal:

1. User memilih `agy` + `gemini-custom`.
2. POST/send chat dikirim.
3. Fake runner menerima executable `agy`.
4. Fake runner menerima model `gemini-custom`.
5. Event `run_started` berisi `provider: "agy"`.
6. Response assistant masuk ke session yang sama.
7. Tidak ada panggilan ke `opencode`.

```ts
expect(runner.calls).toEqual([
  expect.objectContaining({
    executable: "agy",
    modelId: "gemini-custom",
  }),
]);
expect(runner.calls.some((call) => call.executable === "opencode")).toBe(false);
```

Buat test yang sama untuk:

- Claude + alias `BACKEND`;
- Codex + model ID custom;
- OpenCode + `provider/model`;
- `modelId: null` memakai default provider tanpa menambahkan flag model yang salah.

### UI test

File: `apps/web/src` test sesuai setup proyek.

Test:

1. Pilih provider Agy.
2. Pilih model `gemini-custom`.
3. Klik Send.
4. Request body berisi `provider: "agy"` dan `modelId: "gemini-custom"`.
5. Loading menampilkan `Agy is working`, bukan `OpenCode is working`.
6. Event fallback baru mengubah label menjadi `Fallback: OpenCode`.

### Fallback test

Test kondisi berikut:

- Claude mengembalikan quota error: satu run OpenCode dibuat.
- Claude mengembalikan syntax/test error: tidak ada fallback.
- Fallback disabled: tidak ada run kedua.
- `maxHops: 1`: provider kedua tidak membuat provider ketiga.
- Fallback memakai model yang dikonfigurasi user, bukan model default hardcoded.
- Handoff berisi changed files dan remaining work.
- API key dan secret tidak muncul di message atau handoff.

### CLI smoke test terpisah

Sediakan test manual/CI opt-in, bukan test unit default:

```bash
bun run test:provider --provider claude
bun run test:provider --provider codex
bun run test:provider --provider agy
bun run test:provider --provider opencode
```

Smoke test harus:

- memakai prompt read-only seperti `Reply with exactly PONG`;
- tidak menggunakan `--dangerously-skip-permissions`;
- memiliki timeout;
- tidak mengubah file project;
- menampilkan command yang sudah disanitasi;
- dilewati jika provider belum connected.

## 10. Observability dan error

Setiap run harus memiliki `runId`. Log minimal:

```text
runId
sessionId
provider
modelId
status
exitCode
errorClass
durationMs
```

Sanitasi:

- redaksi API key dan token;
- jangan menyimpan seluruh environment;
- jangan menampilkan command dengan secret;
- simpan stderr terpotong dan aman untuk UI.

Frontend wajib menerima terminal event:

- `run_started`;
- `assistant_delta`;
- `tool_started`;
- `tool_finished`;
- `run_completed`;
- `run_failed`;
- `fallback_started`.

Jika stream putus, server tetap menandai run sebagai `failed` setelah timeout. UI tidak boleh loading selamanya.

## 11. Urutan implementasi

1. Tambahkan `provider`, `modelId`, dan `chatSessionId` ke payload chat.
2. Perbaiki routing server agar adapter dipilih dari provider eksplisit.
3. Ganti loading hardcoded dengan data `run_started`.
4. Tambahkan fake runner dan routing test untuk empat provider.
5. Pastikan response Agy, Claude, dan Codex masuk ke UI.
6. Tambahkan `model_catalog` dan discovery cache.
7. Tambahkan tabel chat session, messages, dan cli runs.
8. Tambahkan fallback policy dan handoff.
9. Tambahkan fallback tests.
10. Pisahkan dan stabilkan canvas setelah chat provider routing lulus.

## Acceptance criteria

- Memilih Agy dan mengirim pesan menjalankan executable `agy`, bukan OpenCode.
- Memilih Claude dan alias `BACKEND` meneruskan `--model BACKEND`.
- Memilih Codex meneruskan model yang dipilih ke `codex exec`.
- Memilih OpenCode tetap menggunakan format model OpenCode yang benar.
- Loading menunjukkan provider yang sedang berjalan.
- Provider default tidak berubah diam-diam.
- Fallback dapat dimatikan.
- Fallback dapat memilih provider dan model tertentu.
- Fallback hanya terjadi maksimal satu kali per pesan.
- Chat thread tetap sama setelah fallback.
- Canvas tidak pernah menulis file project.
- Tidak ada chat yang loading selamanya setelah proses gagal.
- Semua routing provider dibuktikan dengan test otomatis.
