# Loom: Chat, Canvas, dan Provider

Dokumen ini adalah rencana perubahan. Chat menjadi agent coding yang boleh membaca dan menulis folder proyek. Canvas hanya menghasilkan mockup UI dan tidak menulis file. Settings harus bisa mendeteksi serta menghubungkan Claude, Codex, Agy, dan OpenCode dengan aturan yang berbeda.

## Tujuan

- Satu thread chat tetap satu percakapan di UI, meskipun proses CLI berganti saat fallback.
- Canvas tidak pernah men-spawn CLI dan tidak pernah menulis ke folder proyek.
- Connect gagal hanya jika binary atau login benar-benar gagal, bukan karena provider belum punya adapter.

## 1. Dua runtime

| | Chat | Canvas |
|---|---|---|
| Route | `/project/[id]` | `/project/[id]/canvas` |
| Runtime | Proses CLI | `packages/providers`, tools kosong |
| Working directory | Folder proyek | Tidak ada, atau scratch yang tidak di-commit |
| Prompt | `prompts/coding.md` | `prompts/design/system.md` + `craft.md` |
| Hasil | Diff di repo | HTML di state kartu |
| Parser | Jangan parse balasan sebagai HTML | `extractDesignScreens` |

Jangan kirim pesan canvas ke CLI. Jangan kirim instruksi `<!-- design: -->` ke agent chat.

Tombol "kirim ke chat" boleh menyusul nanti. HTML kartu menjadi lampiran permintaan, lalu agent chat yang menulis komponen sungguhan. Canvas sendiri tidak menulis file itu.

## 2. Prompt

Pindahkan teks instruksi keluar dari string TypeScript. Parser, regex, dan schema tetap di kode.

```text
prompts/
  coding.md
  design/
    system.md
    craft.md
    refine.md
    classify.md
```

`system.md` hanya berisi peran dan pilihan mode: CHAT, CLARIFY, DESIGN. `craft.md` adalah satu-satunya kontrak output dan hanya ditempel saat DESIGN atau REFINE.

Kontrak craft:

- Catatan pendek, paling banyak 2 kalimat, tanpa HTML.
- Sebelum setiap dokumen: `<!-- design: JUDUL -->`.
- Setiap dokumen mulai `<!DOCTYPE html>` dan selesai `</html>`.
- CSS hanya di satu blok `<style>`. Tidak ada resource eksternal.
- Responsif dari 390px sampai 1440px.

Hapus kalimat "reply with the HTML only" dari `buildDesignPrompt`. Generate dan refine harus memakai `craft.md` yang sama.

`{{projectContext}}` diisi kode: nama, folder, stack, branch, maksimal 160 path, dan theme tokens. Jangan menulis file tree ke dalam markdown.

`prompts/coding.md` tetap pendek: kerjakan permintaan terakhir, baca file yang relevan, jangan membuat mockup HTML, jangan mengubah state canvas.

## 3. Alur canvas

Satu giliran berakhir di satu mode.

1. CHAT menulis paling banyak 3 kalimat. Canvas tidak berubah.
2. CLARIFY menampilkan blok `loom-questions`. Jangan buat kartu. Jika JSON gagal, tampilkan teksnya, jangan iframe kosong.
3. DESIGN langsung membuat kartu `generating`. Catatan di-stream ke chat. HTML ditahan sampai `</html>`, lalu iframe diisi dan status menjadi `ready`. Parser gagal berarti status `error`.
4. Refine memakai kartu yang dipilih. `wantsAllNodes` hanya menyalin permintaan ke kartu `ready`.

Iframe memakai `srcdoc` dan `sandbox` tanpa `allow-same-origin`. Jangan merender HTML agen di halaman induk.

Classifier satu kata tetap terpisah. Regex `looksLikeDesignRequest` hanya cadangan jika jawaban classifier rusak. Jangan menyuruh model utama memilih mode sekaligus.

## 4. Alur chat dan fallback

Satu sesi Loom bukan satu proses CLI. Proses boleh mati. Yang dijaga adalah thread UI dan folder proyek.

1. User memilih provider. Adapter men-spawn CLI dengan `cwd` folder proyek.
2. Loom menyimpan pesan di database sendiri, bukan mengandalkan ID percakapan CLI.
3. Jika proses keluar karena kuota, 429, atau auth habis, tulis handoff singkat: tujuan, yang sudah selesai, file dari `git status`, sisa pekerjaan.
4. Spawn provider berikutnya di `cwd` yang sama. Prompt pertama adalah handoff plus `prompts/coding.md`.
5. UI tetap satu thread, dengan tanda "dilanjutkan di OpenCode".

ID `agy --conversation` hanya berlaku untuk Agy. Jangan mencoba membuka ID Claude di OpenCode. Fallback otomatis paling banyak satu kali. Jika provider kedua gagal, berhenti dan beri tahu user.

Jangan memakai `--dangerously-skip-permissions` sebagai default.

## 5. Cara menempel prompt ke CLI

| CLI | Prompt coding |
|---|---|
| Claude | `--append-system-prompt-file prompts/coding.md` |
| OpenCode | `--system` atau `AGENTS.md` |
| Codex | `AGENTS.md`. Jangan mengandalkan flag append. |
| Agy | Tidak ada flag append. Sisipkan isi `coding.md` ke prompt `--print`, atau lewat agent yang Agy baca. |

Mode headless:

- Claude dan OpenCode: print / non-interaktif, stream jika ada.
- Agy: `--print` dan `--output-format stream-json`. `--conversation` hanya untuk melanjutkan sesi Agy sendiri.

## 6. Settings provider

Halaman `apps/web/src/routes/settings/providers` hanya menampilkan status. Keputusan ada di `packages/providers`.

Sekarang hanya `opencode.ts` yang adapter sungguhan. Claude, Codex, dan Agy jatuh ke `unsupported.ts`, jadi Connect gagal meskipun binary sudah terpasang.

Buat adapter berikut, dengan pola yang sama seperti `opencode.ts`, lalu daftarkan di `definitions.ts`:

- `packages/providers/src/adapters/claude.ts`
- `packages/providers/src/adapters/codex.ts`
- `packages/providers/src/adapters/agy.ts`

Pisahkan dua status.

| Provider | Terpasang | Terhubung |
|---|---|---|
| OpenCode | Adapter yang sudah ada | Adapter yang sudah ada |
| Claude | `claude --version` | `claude auth status`, atau file kredensial ada |
| Codex | `codex --version` | `codex login status` |
| Agy | `agy models` atau `agy --version` | `agy --print` singkat berhasil. Tidak ada perintah login. |

Cek binary memakai PATH yang sama dengan terminal user. Server yang dibuka dari shortcut sering tidak memuat `~/.local/bin` atau direktori npm. Jika itu penyebabnya, simpan path absolut saat install terdeteksi, jangan hanya mengandalkan `PATH` proses server.

Agy tidak punya subcommand `login`, `auth`, atau `connect`. Jangan menyalin perintah login OpenCode ke Agy.

## 7. Urutan kerja

1. Samakan kontrak output canvas dan pindahkan prompt ke `prompts/`.
2. Pastikan `design.ts` tidak men-spawn CLI dan tidak menulis folder proyek.
3. Batasi chat ke spawn CLI dengan `cwd` proyek.
4. Tambah adapter Claude, Codex, dan Agy. Hapus ketiganya dari jalur `unsupported.ts`.
5. Bedakan status installed dan connected di settings.
6. Baru setelah itu tambah fallback satu kali dengan handoff.

## Di luar lingkup

- Canvas yang langsung menulis komponen ke repo.
- Fallback berantai lebih dari satu provider.
- Mengganti system prompt bawaan harness. Loom hanya menempel.
