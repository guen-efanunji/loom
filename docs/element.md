# Rencana Implementasi AI Elements (shadcn-svelte)

Dokumen ini merinci tahapan perbaikan dan integrasi komponen **AI Elements** dari `shadcn-svelte` ke proyek **Loom**, berdasarkan analisis yang telah dilakukan. Tujuan utamanya adalah memastikan setiap pola AI Elements digunakan sesuai aslinya dari shadcn-svelte, bukan dibuat sendiri, dan benar-benar terintegrasi ke UI produk.

## Prinsip Umum

1. **Gunakan komponen asli shadcn-svelte** (`apps/web/src/lib/components/ai-elements/*`) sebagai sumber kebenaran. Jangan membuat implementasi paralel.
2. **Integrasi, bukan duplikasi.** Komponen produk seperti `Turn.svelte`, `Composer.svelte`, `TaskChatView.svelte`, dan `TaskRunChat.svelte` harus memakai komponen AI Elements, bukan meniru perilakunya.
3. **Bertahap.** Setiap tahap dapat diuji sendiri sebelum lanjut ke tahap berikutnya.
4. **Konsisten dengan sumber pesan yang ada.** AI Elements hanya membaca _message parts_, jadi harus kompatibel dengan `@ai-sdk/svelte` maupun sumber pesan lain di Loom.

---

## Tahap 0 — Inventarisasi dan Audit Komponen (Selesai)

**Tujuan:** Menentukan kondisi implementasi 21 pola AI Elements, memisahkan padanan fitur produk dari komponen shadcn-svelte, dan memastikan sumber/provenance komponen sebelum integrasi.

**Metode audit:**

- Inventarisasi direktori `apps/web/src/lib/components/ai-elements/` dan pencarian seluruh import/pemakaian di `apps/web/src/`.
- Pemeriksaan isi komponen perwakilan dan pola komponen lokal.
- Pencocokan fungsi dengan dokumentasi AI Elements shadcn-svelte. Pemeriksaan statis ini **tidak membuktikan** bahwa file lokal merupakan salinan resmi registry; provenance perlu diverifikasi sebelum komponen dianggap sebagai komponen shadcn-svelte asli.

### Hasil audit

> Catatan progres: setelah audit awal, Prompt Input lokal sudah disambungkan ke Composer pada Tahap 1. Status dan rekap Prompt Input di bawah diperbarui agar mencerminkan kondisi working tree saat ini; provenance tetap belum terverifikasi.

| AI Element       | Status di Loom                                       | Temuan                                                                                                                                                                                |
| ---------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chain of Thought | Stub / belum terverifikasi                           | File lokal hanya menampilkan daftar langkah; tidak ditemukan pemakaian aplikasi.                                                                                                      |
| Chat             | Stub / belum terverifikasi                           | File lokal berupa wrapper sederhana; tidak ditemukan pemakaian. Produk punya UI chat tersendiri.                                                                                      |
| Checkpoint       | Stub / belum terverifikasi                           | File lokal sederhana; tidak ditemukan pemakaian. Checkpoint produk yang ada adalah bagian alur kerja, bukan bukti bahwa pola UI AI Element ini terintegrasi.                          |
| Confirmation     | Stub / belum terverifikasi                           | File lokal sederhana; tidak ditemukan pemakaian. Produk memiliki alur persetujuan tool tersendiri.                                                                                    |
| Context          | Stub / belum terverifikasi                           | File lokal sederhana; tidak ditemukan pemakaian. Pengelolaan konteks produk bukan indikator pemakaian jendela konteks AI Element.                                                     |
| File Tree        | Stub / belum terverifikasi                           | File lokal menampilkan daftar file sederhana; tidak ditemukan pemakaian. Produk memiliki file/workspace explorer terpisah.                                                            |
| Inline Citation  | Stub / belum terverifikasi                           | File lokal hanya menampilkan teks; tidak ditemukan pemakaian.                                                                                                                         |
| Message          | Stub / belum terverifikasi                           | File lokal berupa blok teks dasar; tidak ditemukan pemakaian. Produk merender pesan melalui komponen chat lain.                                                                       |
| Model Selector   | Stub / belum terverifikasi                           | File lokal menggunakan pilihan model sederhana; tidak ditemukan pemakaian. Produk punya pemilih model sendiri.                                                                        |
| Plan             | Stub / belum terverifikasi                           | File lokal menampilkan daftar langkah; tidak ditemukan pemakaian. Produk memiliki PlanDialog tersendiri.                                                                              |
| Prompt Input     | Terhubung ke Composer; provenance belum diverifikasi | Keluarga lokal `ai-elements/prompt-input/` digunakan oleh `Composer.svelte`. Pemakaian lokal tidak dengan sendirinya membuktikan bahwa sumbernya adalah registry resmi shadcn-svelte. |
| Queue            | Stub / belum terverifikasi                           | File lokal menampilkan daftar item; tidak ditemukan pemakaian. Produk punya antrean follow-up tersendiri.                                                                             |
| Reasoning        | Terhubung, provenance belum terverifikasi            | `Turn.svelte` mengimpor dan merendernya untuk reasoning part. Komponen lokal menampilkan Markdown yang dapat dibuka/tutup.                                                            |
| Sources          | Stub / belum terverifikasi                           | File lokal menampilkan daftar sumber sederhana; tidak ditemukan pemakaian.                                                                                                            |
| Stack Trace      | Stub / belum terverifikasi                           | File lokal menampilkan teks dalam `<pre>`; tidak ditemukan pemakaian.                                                                                                                 |
| Subagent         | Stub / belum terverifikasi                           | File lokal menampilkan nama/status; tidak ditemukan pemakaian. Produk menampilkan sesi anak melalui UI lain.                                                                          |
| Suggestion       | Stub / belum terverifikasi                           | File lokal berupa tombol teks; tidak ditemukan pemakaian.                                                                                                                             |
| Task             | Stub / belum terverifikasi                           | File lokal menampilkan judul/status; tidak ditemukan pemakaian. Produk memiliki sistem task/Kanban tersendiri.                                                                        |
| Terminal         | Stub / belum terverifikasi                           | File lokal menampilkan output sederhana; tidak ditemukan pemakaian. Produk memiliki terminal terintegrasi terpisah.                                                                   |
| Test Results     | Stub / belum terverifikasi                           | File lokal menampilkan daftar hasil sederhana; tidak ditemukan pemakaian.                                                                                                             |
| Tool             | Diimpor, tetapi belum terhubung                      | `Turn.svelte` mengimpor komponen, tetapi tidak ditemukan elemen `<Tool>` yang dirender.                                                                                               |

**Rekap:** 21 pola tercatat; 1 terhubung (Reasoning, provenance belum terverifikasi), 1 terhubung ke Composer (Prompt Input, provenance belum terverifikasi), 1 diimpor tetapi belum dipakai (Tool), dan 18 file lokal belum terhubung/terverifikasi. Tidak ada pola yang tidak memiliki file; namun keberadaan file bukan bukti implementasi resmi.

**Catatan provenance penting:** AI Elements didistribusikan sebagai kode sumber yang disalin ke proyek, sehingga lokasi file lokal saja tidak mengidentifikasi sumbernya. Sebelum mengganti atau memperbarui file, cocokkan kode tiap pola dengan halaman dokumentasi/contoh resmi shadcn-svelte dan catat hasilnya. Jangan mengasumsikan bahwa file sederhana yang bernama sama merupakan komponen resmi. Jangan menimpa perubahan lokal yang sudah ada tanpa review diff.

**Kesimpulan tahap:** Audit inventaris dan pemakaian selesai. Gate berikutnya adalah verifikasi sumber resmi/API untuk pola yang akan dimigrasikan; implementasi pertama setelah gate ini adalah menyambungkan Prompt Input yang sudah tersedia ke Composer, bukan membuatnya dari nol.

---

## Tahap 1 — Pondasi: Chat, Message, dan Prompt Input

**Status:** Prompt Input tetap terhubung ke Composer (provenance belum diverifikasi). `Message.Root` dan `Message.Content` telah dipasang pada renderer user/assistant di `Turn.svelte`; Chat wrapper lokal tidak digunakan. Typecheck web lulus. E2E percakapan dan review visual/browser belum dijalankan, sehingga tahap ini belum dinyatakan tervalidasi sepenuhnya.

**Tujuan:** Menyatukan tampilan percakapan utama dengan komponen AI Elements asli.

**Langkah:**

1. Verifikasi dan, bila perlu, sinkronkan keluarga `prompt-input/` dengan implementasi resmi shadcn-svelte. Komponen sudah ada; jangan membuat ulang.
2. Refactor `Composer.svelte` agar memakai komposisi `PromptInput.*` yang sesuai dokumentasi, sambil mempertahankan lampiran, pemilihan model, agent, antrean, dan mekanisme submit Loom.
3. Verifikasi API komposisi `Message.Root`, `Message.Content`, alignment, header/footer melalui dokumentasi resmi. Gunakan `Message` untuk membungkus konten user/assistant yang telah ada di `Turn.svelte`; pertahankan Markdown, lampiran, reasoning/tool, diff, aksi, dan state Loom. Jangan gunakan `Chat.svelte` lokal sebagai bukti implementasi resmi; wrapper tersebut tidak diperlukan untuk renderer saat ini.
4. Pastikan peran user/assistant, Markdown, lampiran, status streaming, aksi pesan, aksesibilitas, dan error tetap terjaga.

**Kriteria selesai:** Keluarga Prompt Input lokal terhubung ke alur pengiriman Loom; status provenance-nya tetap belum diverifikasi dan tidak diklaim sebagai integrasi resmi. `Message` dipakai untuk komposisi di `Turn.svelte` sesuai API yang didokumentasikan, tanpa mengklaim provenance file lokal. Composer mempertahankan lampiran, mention, pemilihan model/agent, antrean, stop, dan submit. Typecheck web lulus; validasi penuh menunggu tes perilaku dan review browser/visual.

---

## Tahap 2 — Langkah dan Aktivitas Agent (Reasoning, Tool, Plan, Task, Queue, Subagent, Terminal, Confirmation)

**Status implementasi (19 Nov 2026): pola aktivitas telah diintegrasikan pada tampilan chat, task, plan, dan Kanban.** `Turn.svelte` memakai Reasoning, Tool, Terminal, Queue, dan Subagent; `TaskRunChat.svelte` memakai Task, Tool, Terminal, dan Confirmation; `SplitChatPane.svelte` memakai Queue dan Confirmation; `PlanDialog.svelte` memakai Plan; dan `KanbanBoard.svelte` memakai Task. Integrasi mempertahankan alur diff/editor Loom, pilihan izin, output terminal yang dapat dibuka/tutup, dan follow-up antrean. Ini tidak menyatakan bahwa file lokal merupakan salinan registry yang identik.

**Hasil verifikasi (19 Nov 2026):**

- `bun run check` dari `apps/web`: lulus, 0 error dan 0 warning.
- `bun run test:e2e -- tests/chat-lifecycle.e2e.ts --workers 1`: lulus, 6/6, termasuk reasoning, output terminal/tool dan error, native queue, Confirmation, serta lifecycle split chat.
- `bun run test:e2e -- tests/adaptive-chat.e2e.ts --workers 1`: lulus, 5/5, termasuk runtime todos dan fokus/kembali dari subagent.
- `bun run test:e2e -- tests/live-login-task-evidence.e2e.ts --workers 1`: lulus, 4/4 untuk board, tab progress tugas fixture, dan panel agent.
- `git diff --check`: lulus.

**Batas verifikasi:** ini belum merupakan validasi penuh Tahap 2. E2E `tests/kanban-parallel.e2e.ts` masih gagal membuka detail task pada fixture (heading yang diharapkan tidak muncul; indikasi route/fixture task, bukan bukti render AI Element gagal). Dialog Plan belum diuji menyeluruh dari generate sampai review/konversi; Task AI Element belum memperoleh E2E komponen mandiri. Task live yang diperiksa hanya berstatus Queued dan tidak dijalankan. Review visual dark/light belum dilakukan. Karena itu status Tahap 2 adalah **implementasi selesai, verifikasi parsial**.

**Tujuan:** Menampilkan aktivitas agent secara konsisten menggunakan komponen AI Elements.

**Langkah:**

1. **Reasoning** — sudah dirender di `Turn.svelte`; verifikasi/sinkronkan dengan sumber resmi terlebih dahulu, lalu pertahankan atau sesuaikan integrasinya tanpa membuat renderer duplikat.
2. **Tool** — `Tool.svelte` saat ini baru diimpor di `Turn.svelte`, belum dirender. Verifikasi/sinkronkan dengan sumber resmi, lalu integrasikan di `Turn.svelte` dan `TaskRunChat.svelte` untuk input/output, status, error, dan diff yang memang didukung pola tersebut.
3. **Plan** — integrasikan `Plan.svelte` ke `PlanDialog.svelte` untuk menampilkan langkah dan progres.
4. **Task** — integrasikan `Task.svelte` ke tampilan Kanban/task agent.
5. **Queue** — integrasikan `Queue.svelte` untuk daftar tugas yang tersisa/selesai dan follow-up.
6. **Subagent** — integrasikan `Subagent.svelte` di `Turn.svelte` untuk sesi anak.
7. **Terminal** — integrasikan `Terminal.svelte` untuk command dan output yang dijalankan agent.
8. **Confirmation** — integrasikan `Confirmation.svelte` untuk persetujuan tool di `SplitChatPane.svelte` dan `TaskRunChat.svelte`.

**Kriteria selesai:** Semua aktivitas agent dirender melalui komponen AI Elements; tidak ada trace kustom yang meniru pola tersebut.

---

## Tahap 3 — Konteks dan Navigasi (Context, Checkpoint, Model Selector)

**Status implementasi (21 Nov 2026):** `ModelSelector.svelte` dipakai di Composer untuk memilih model dan thinking mode. Picker Browse yang menyajikan pencarian, favorit, dan recent tetap ada. Panel Context menggunakan `Context.svelte` dan membedakan estimasi Loom dari usage provider; tidak menampilkan persentase saat jendela model tidak diketahui. `Checkpoint.svelte` menandai turn assistant dan menyediakan restore percakapan melalui endpoint terpisah. Restore hanya menyembunyikan pesan percakapan di history tampilan/konteks melalui metadata append-only; tidak melakukan rollback file workspace atau Git.

**Verifikasi:** `bun run check` (apps/web), `bun test apps/server/test/chat-provider.test.ts` (33/33), E2E `tests/chat-lifecycle.e2e.ts` + `tests/context-compaction.e2e.ts` (9/9), dan `git diff --check` lulus. E2E mencakup restore percakapan, pemilihan model katalog dan thinking mode, serta panel Context. Provenance file lokal belum diverifikasi terhadap registry resmi; review visual dark/light belum dilakukan.

**Tujuan:** Menambahkan indikator konteks dan navigasi percakapan yang sesuai pola AI Elements.

**Langkah:**

1. **Model Selector** — ganti pemilihan model di `Composer.svelte` dengan `ModelSelector.svelte` (model + thinking mode).
2. **Context** — tambahkan `Context.svelte` untuk menampilkan penggunaan jendela konteks (token/progress) di area chat.
3. **Checkpoint** — integrasikan `Checkpoint.svelte` agar pengguna dapat kembali ke titik percakapan tertentu (bukan hanya checkpoint internal sebelum merge).

**Kriteria selesai:** Pengguna dapat melihat penggunaan konteks, memilih model via komponen asli, dan kembali ke checkpoint percakapan.

---

## Tahap 4 — Hasil dan Sumber (Sources, Inline Citation, File Tree, Test Results, Stack Trace, Chain of Thought)

**Status implementasi (25 Nov 2026):** Keenam komponen disinkronkan ke pola resmi shadcn-svelte (komposisi `Trace`/`CodeBlock`/`HoverCard`/`Collapsible`/`Button`); `hover-card` ditambahkan via registry resmi. `Turn.svelte` menampilkan Chain of Thought (ringkasan turn riset), File Tree dari metadata edit tool, Sources (kondisional bila ada part `source-url`), dan Stack Trace (hanya bila error memuat frame). Test Results siap pakai menunggu data terstruktur dari provider. E2E `chat-lifecycle` 9/9 lulus, typecheck 0/0. Batas: Test Results/Sources menunggu data provider; Inline Citation belum dipakai (belum ada sumber); review visual belum.

**Tujuan:** Menyajikan hasil kerja agent dan sumber secara terstruktur.

**Langkah:**

1. **Chain of Thought** — ganti stub dengan `ChainOfThought.svelte` asli; tampilkan ringkasan yang dapat dibuka ke langkah agent.
2. **Sources** — integrasikan `Sources.svelte` untuk daftar tautan/sumber yang digunakan dalam jawaban AI.
3. **Inline Citation** — integrasikan `InlineCitation.svelte` agar sitasi muncul di dalam kalimat dan membuka sumber saat di-hover.
4. **File Tree** — integrasikan `FileTree.svelte` untuk menampilkan file yang diubah agent dalam bentuk struktur folder (bukan hanya panel file umum).
5. **Test Results** — integrasikan `TestResults.svelte` untuk ringkasan tes (suite, status lulus/gagal, detail).
6. **Stack Trace** — integrasikan `StackTrace.svelte` untuk menampilkan kegagalan tool beserta stack frames.

**Kriteria selesai:** Hasil kerja agent (file, tes, error) dan sumber ditampilkan melalui komponen AI Elements asli.

---

## Tahap 5 — Suggestion dan Polesan UX

**Status implementasi (25 Nov 2026):** `Suggestion.svelte` disinkronkan ke pola resmi (baris `Button` horizontal dengan scroll) dan diintegrasikan ke `Turn.svelte` melalui prop opsional `suggestions`/`onsuggest` (hanya muncul bila ada sumber saran nyata). Stub `Chat.svelte` yang tidak dipakai dihapus. Typecheck web dan E2E percakapan lulus. Review visual dark/light belum dilakukan.

**Tujuan:** Menambahkan saran prompt lanjutan dan menyempurnakan pengalaman.

**Langkah:**

1. **Suggestion** — integrasikan `Suggestion.svelte` untuk menampilkan saran prompt yang bisa dikirim sekali klik setelah balasan AI.
2. Pastikan semua komponen AI Elements yang digunakan konsisten secara styling dengan tema Loom (dark/light).
3. Hapus atau nonaktifkan stub yang tidak lagi dipakai agar tidak menimbulkan kebingungan.

**Kriteria selesai:** Saran prompt muncul kontekstual; tidak ada stub mati yang tertinggal.

---

## Tahap 6 — Pengujian dan Validasi

**Status (25 Nov 2026):** Lint (biome) 0 issue, typecheck web 0 error/0 warning, unit test suite 188 pass (0 fail), E2E 15 pass (chat-lifecycle, adaptive-chat, context-compaction), server chat-provider 33 pass, `git diff --check` bersih. Review visual dark/light belum dilakukan (memerlukan browser manual).

**Tujuan:** Memastikan integrasi tidak merusak fungsionalitas yang ada.

**Langkah:**

1. Tambahkan/ perbarui unit test untuk komponen yang direfactor (Chat, Message, PromptInput, Tool, dll.).
2. Tambahkan E2E test untuk alur percakapan, persetujuan tool, dan tampilan hasil (File Tree, Test Results).
3. Jalankan lint, typecheck, dan test suite proyek.
4. Lakukan review visual (dark/light mode) pada setiap komponen yang diintegrasikan.

**Kriteria selesai:** Semua test lulus; tidak ada regresi fungsional.

---

## Ringkasan Tahapan

| Tahap | Fokus                 | Komponen Utama                                                                   |
| ----- | --------------------- | -------------------------------------------------------------------------------- |
| 0     | Audit & inventarisasi | Semua komponen ai-elements                                                       |
| 1     | Pondasi percakapan    | Chat, Message, PromptInput                                                       |
| 2     | Aktivitas agent       | Reasoning, Tool, Plan, Task, Queue, Subagent, Terminal, Confirmation             |
| 3     | Konteks & navigasi    | Model Selector, Context, Checkpoint                                              |
| 4     | Hasil & sumber        | Chain of Thought, Sources, Inline Citation, File Tree, Test Results, Stack Trace |
| 5     | Suggestion & polesan  | Suggestion                                                                       |
| 6     | Pengujian & validasi  | Semua komponen                                                                   |

---

## Catatan Penting

- **Jangan membuat komponen baru** yang meniru AI Elements. Gunakan yang dari shadcn-svelte.
- **Jangan menghapus fitur yang ada** sebelum penggantinya siap; lakukan migrasi bertahap.
- Komponen AI Elements hanya membaca _message parts_, sehingga harus kompatibel dengan sumber pesan yang digunakan Loom (termasuk `@ai-sdk/svelte`).
- Setiap tahap sebaiknya diselesaikan dan diuji sebelum melanjutkan ke tahap berikutnya.
