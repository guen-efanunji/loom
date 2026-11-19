# Rencana Implementasi: Plan Chat dan Mention Task di Loom

**Status:** Draft untuk ditinjau  
**Tanggal:** 2026-11-19  
**Cakupan:** Chat Plan mode, klarifikasi ala `grill-me`, persetujuan penambahan task ke Kanban, dan `@task` dalam sesi chat  

## 1. Tujuan

Meningkatkan alur chat Loom agar pengguna dapat memulai dari ide yang masih umum, menjawab pertanyaan klarifikasi dalam sesi yang sama, lalu meninjau tahapan kerja sebelum task dimasukkan ke Kanban. Pengguna juga harus dapat melanjutkan pekerjaan dari sesi tersebut dengan menyebut task Kanban menggunakan `@task`; task dikerjakan oleh agent/model yang dipilih untuk chat, bukan otomatis dialihkan ke executor Kanban yang berbeda.

## 2. Temuan Codebase

Temuan berikut berasal dari pemeriksaan codebase saat penyusunan dokumen:

- Composer berada di `apps/web/src/components/chat/Composer.svelte` dan saat ini properti `agent` bernilai awal `build`. UI selector memilih agent katalog; belum terbukti sebagai pemilih mode Plan/Build yang terpisah.
- Pengiriman chat dan penanganan task mention berada di `apps/web/src/components/ProjectsPage.svelte`. Saat ini `taskRefs` dikirim bersama chat, kemudian setiap task yang disebut langsung dimulai lewat `daemon.startTask()`.
- Pilihan task mention dibangun dari `tasks` yang diberikan Composer. Dua pemanggilan Composer utama memfilternya menggunakan project terpilih.
- Composer memang membangun pilihan task, namun elemen hasil suggestion dirender dengan ikon/label generik seperti file; tipe task tidak memperoleh representasi visual yang jelas.
- `legacyTasks` dimuat melalui `daemon.listTasks()` dan dipakai Kanban serta Composer. Perlu diverifikasi apakah pemuatan/refresh berjalan pada semua kondisi chat, khususnya setelah task baru dibuat atau saat project/session berganti.
- Plan saat ini dimulai melalui `PlanDialog.svelte`, yang membuat draft sekali jalan lewat `daemon.createPlan({ mode: "plan" })`, melakukan polling, lalu menyediakan tinjauan/edit sebelum persetujuan dan konversi ke Kanban.
- Planner server berada di `packages/automation/src/planner.ts`; planner membuat satu runtime session read-only dan mengharapkan keluaran JSON tervalidasi. Belum ada mekanisme tanya-jawab multi-turn yang terhubung ke sesi chat biasa.
- Endpoint task start `POST /api/tasks/:id/start` mengantrikan task ke orchestrator. Task memiliki lifecycle status seperti `queued`, `ready`, `preparing`, `running`, `completed`, `failed`, dan `cancelled`.
- Model yang dipilih dikirim dari Composer bersama chat. Implementasi task mention saat ini tidak menggunakan model tersebut untuk eksekusi task, melainkan memulai executor task Kanban.

## 3. Pengalaman Pengguna yang Dituju

### 3.1 Plan mode

1. Pengguna memilih **Plan** (bukan Build) pada kontrol mode chat.
2. Pengguna menjelaskan tujuan dengan bahasa bebas, termasuk saat detailnya belum lengkap.
3. Loom menanyakan pertanyaan klarifikasi yang relevan dalam beberapa putaran. Pertanyaan berikutnya mempertimbangkan jawaban sebelumnya; Loom tidak membuat asumsi penting tanpa menandainya.
4. Setelah kebutuhan cukup jelas, Loom merangkum keputusan dan menampilkan rencana sebagai tahapan/task yang dapat ditinjau.
5. Pengguna dapat menyetujui, mengedit, atau membatalkan. Hanya persetujuan eksplisit yang menambahkan task ke Kanban.
6. Percakapan Plan dan konteksnya tetap berada dalam session chat yang sama agar pengguna dapat melanjutkan ke pengerjaan.

### 3.2 Mention task dalam chat

1. Dalam session chat yang sama, pengguna mengetik `@` dan memilih task dari Kanban project aktif.
2. Task ditampilkan dengan ikon/label task, judul, dan status yang mudah dikenali. Daftar mengikuti project aktif dan memuat task yang masih relevan untuk dikerjakan.
3. Pengguna menyertakan instruksi pengerjaan. Task ID terpilih dikirim sebagai referensi terstruktur, bukan diturunkan dari pencocokan teks judul.
4. Loom menjalankan pekerjaan di percakapan aktif menggunakan agent/model yang dipilih di Composer. Mention sendiri tidak boleh diam-diam menjalankan executor Kanban kedua.
5. Task dikaitkan dengan session chat dan statusnya mencerminkan lifecycle kerja. Status hanya berubah menjadi `completed`/Done setelah hasil penyelesaian dikonfirmasi sesuai mekanisme yang disepakati; error atau respons yang belum menyelesaikan kriteria tidak boleh dianggap Done.

## 4. Persyaratan Fungsional

### Plan mode dan klarifikasi

- **FR-1** — UI chat MUST menyediakan cara yang jelas untuk memilih Plan atau Build; pemilihan mode MUST tidak disamakan secara ambigu dengan pemilihan agent/model.
- **FR-2** — Saat Plan dipilih, pesan pengguna MUST masuk ke alur klarifikasi Plan, bukan langsung diperlakukan sebagai permintaan Build biasa.
- **FR-3** — Alur klarifikasi MUST mendukung beberapa putaran tanya-jawab dalam session Loom yang sama.
- **FR-4** — Agent MUST menanyakan hal yang berdampak pada cakupan, pengguna, perilaku, integrasi, batasan, atau definisi selesai jika informasi tersebut belum tersedia; agent SHOULD menghindari pertanyaan yang jawabannya sudah ada di konteks.
- **FR-5** — Agent MUST memberi sinyal kapan klarifikasi cukup dan menyajikan ringkasan keputusan sebelum mengusulkan task.
- **FR-6** — Rencana MUST dapat ditinjau dan diedit sebelum konversi ke task Kanban.
- **FR-7** — Task MUST NOT dibuat di Kanban sampai pengguna memberi persetujuan eksplisit. Membatalkan dialog atau menutup tinjauan tidak boleh dianggap sebagai persetujuan.
- **FR-8** — Task yang dibuat dari rencana MUST memenuhi validasi task Loom yang sudah berlaku, termasuk acceptance criteria dan konfigurasi executor yang diwajibkan.
- **FR-9** — Build mode MUST mempertahankan perilaku chat Build yang sudah ada, kecuali perubahan UI yang diperlukan untuk membedakan mode.

### Mention task

- **FR-10** — Composer MUST menampilkan task project aktif pada suggestion `@`, dengan label/ikon yang membedakannya dari file, agent, session, dan SSH.
- **FR-11** — Pilihan task MUST membawa task ID sebagai referensi terstruktur dan ditampilkan sebagai konteks percakapan.
- **FR-12** — Task mention MUST dikaitkan dengan percakapan aktif dan MUST menggunakan model serta agent yang dipilih untuk chat tersebut.
- **FR-13** — Task mention MUST NOT memanggil jalur `startTask()` Kanban secara otomatis jika jalur itu menjalankan executor terpisah dari session chat.
- **FR-14** — Loom MUST memperbarui status task melalui mekanisme lifecycle yang aman dan tervalidasi; perubahan status tidak boleh dilakukan dengan patch status bebas dari client.
- **FR-15** — Status Done/completed MUST hanya diterapkan saat penyelesaian task dinyatakan berhasil berdasarkan hasil pengerjaan yang dapat diverifikasi. Kegagalan, pembatalan, atau respons parsial MUST NOT ditandai selesai.
- **FR-16** — Pengguna MUST dapat menyebut task dalam session Plan yang sama setelah task rencana dikonversi ke Kanban.
- **FR-17** — Daftar mention dan statusnya MUST diperbarui setelah task dibuat, dimulai, selesai, gagal, atau project/session berubah.

## 5. Persyaratan Non-Fungsional

- **NFR-1 — Integritas data:** Konfirmasi dan konversi plan MUST idempotent agar pengiriman ganda tidak menggandakan task.
- **NFR-2 — Keamanan lifecycle:** Hanya task milik project aktif dan status yang memenuhi transisi sah yang boleh dikaitkan/dimulai/diselesaikan.
- **NFR-3 — Kegagalan aman:** Jika pembaruan task gagal, percakapan tetap tersimpan; UI memberi tahu pengguna dan tidak menampilkan status sukses palsu.
- **NFR-4 — Aksesibilitas:** Mode Plan/Build, suggestion mention, persetujuan, pembatalan, dan status task MUST dapat digunakan dengan keyboard dan memiliki nama/label aksesibel.
- **NFR-5 — Kompatibilitas:** Session/chat dan task lama MUST tetap dapat dibuka; perubahan skema (bila diperlukan) harus bermigrasi tanpa menghapus data.
- **NFR-6 — Respons UI:** Status pemrosesan dan operasi Plan/task MUST terlihat; tidak ada nilai target latency yang ditentukan pada tahap ini karena belum ada baseline pengukuran.

## 6. Kriteria Penerimaan

- **AC-1 (FR-1, FR-2):** Given pengguna berada di chat, when pengguna memilih Plan dan mengirim ide yang belum lengkap, then Loom memulai alur klarifikasi dan UI tetap menunjukkan Plan aktif.
- **AC-2 (FR-3, FR-4):** Given Loom mengajukan pertanyaan dan pengguna menjawab, when Loom merespons, then jawaban berada dalam session yang sama dan pertanyaan berikutnya tidak mengabaikan jawaban tersebut.
- **AC-3 (FR-5, FR-6):** Given informasi rencana dinilai cukup, when Loom menyajikan tahapan, then pengguna dapat melihat ringkasan dan mengedit judul/deskripsi/urutan atau detail task sebelum konversi.
- **AC-4 (FR-7, NFR-1):** Given draft plan telah ditinjau, when pengguna membatalkan atau menutup tinjauan, then tidak ada task baru pada Kanban; when pengguna menyetujui sekali, then task dibuat satu kali.
- **AC-5 (FR-8):** Given rencana memiliki task tanpa acceptance criteria atau konfigurasi eksekusi wajib, when pengguna mencoba menyetujui, then validasi menjelaskan masalah dan task tidak dikonversi.
- **AC-6 (FR-9):** Given pengguna memilih Build, when pesan dikirim, then pesan tetap mengikuti jalur Build dan tidak masuk ke wawancara Plan tanpa permintaan pengguna.
- **AC-7 (FR-10, FR-11):** Given task tersedia pada Kanban project aktif, when pengguna mengetik `@`/judul task, then task muncul sebagai pilihan bertipe task, dan memilihnya menambahkan ID task yang benar ke referensi pesan.
- **AC-8 (FR-12, FR-13):** Given pengguna memilih task lalu mengirim instruksi di chat, when Loom memproses pesan, then task ditautkan ke session chat aktif dan model/agent chat terpilih digunakan; executor Kanban lain tidak dimulai bersamaan.
- **AC-9 (FR-14, FR-15):** Given task sedang dikerjakan melalui chat, when pekerjaan dimulai/berhasil/gagal/dibatalkan, then status mengikuti transisi lifecycle yang sah dan hanya hasil sukses tervalidasi yang menjadi Done.
- **AC-10 (FR-16, FR-17):** Given plan sudah dikonversi pada session aktif, when pengguna membuka mention task di session yang sama, then task baru terlihat; perubahan lifecycle berikutnya tercermin pada board dan suggestion.
- **AC-11 (NFR-3, NFR-4):** Given endpoint atau update status gagal, when UI menerima error, then percakapan tidak hilang, error dapat dipahami, fokus keyboard tetap dapat digunakan, dan UI tidak menampilkan task sebagai selesai.

## 7. Kasus Tepi dan Kegagalan

- **EC-1:** Model/provider gagal atau timeout saat bertanya, menyusun ringkasan, atau membuat draft; percakapan dan jawaban pengguna tetap tersedia untuk retry.
- **EC-2:** Pengguna mengubah dari Plan ke Build saat masih ada draft; draft tidak boleh otomatis dikonversi atau hilang tanpa konfirmasi/peringatan yang sesuai.
- **EC-3:** Pengguna mengirim balasan Plan ketika request sebelumnya masih berjalan; cegah balapan atau urutan jawaban yang salah.
- **EC-4:** User menutup browser/session lalu kembali; state percakapan dan status draft/konfirmasi harus dipulihkan atau secara eksplisit dinyatakan belum tersimpan.
- **EC-5:** Dua klik persetujuan atau retry bersamaan tidak boleh menghasilkan task duplikat.
- **EC-6:** Task mention tidak ada, telah dihapus, milik project berbeda, atau statusnya terminal; tampilkan error yang tepat dan jangan memulai eksekusi yang tidak sah.
- **EC-7:** Task sudah berjalan di executor Kanban atau session lain; jangan memulai eksekusi paralel tanpa aturan konflik yang eksplisit.
- **EC-8:** Mention task saja tanpa instruksi pengerjaan; Loom harus mengklarifikasi maksud atau meminta instruksi, bukan mengasumsikan pekerjaan.
- **EC-9:** Agent menghasilkan jawaban tetapi belum memenuhi acceptance criteria; task tidak boleh otomatis menjadi Done.
- **EC-10:** Task gagal di-update setelah jawaban agent selesai; tampilkan kegagalan sinkronisasi dan jangan mengklaim Kanban sudah diperbarui.
- **EC-11:** Task baru dibuat tetapi daftar Composer belum refresh; lakukan refresh/event sinkronisasi setelah konversi plan.
- **EC-12:** Judul task mirip/duplikat; task ID tetap menjadi identitas otoritatif dan UI harus membedakan status atau identifier tambahan bila dibutuhkan.

## 8. Kontrak Interaksi (Usulan)

Kontrak di bawah adalah batas perilaku untuk implementasi, bukan klaim bahwa endpoint baru telah ada. Implementasi harus memetakan ini ke API/runtime Loom yang telah diverifikasi.

```ts
type ChatMode = "build" | "plan";

type PlanConversationInput = {
  sessionId: string;
  text: string;
  mode: "plan";
  model?: { providerID: string; modelID: string };
  agent?: string;
};

type PlanConversationOutput =
  | { state: "clarifying"; assistantMessage: string; questions: string[] }
  | { state: "ready_for_review"; assistantMessage: string; draftPlanId: string };

type ApprovePlanInput = {
  planId: string;
  approved: true;
  edits?: {
    title?: string;
    summary?: string;
    tasks?: PlanTaskDraft[];
  };
};

type ChatTaskReference = {
  taskId: string;
  sessionId: string;
  instruction: string;
  model?: { providerID: string; modelID: string };
  agent?: string;
};

type ChatTaskLifecycle =
  | { state: "linked"; taskId: string }
  | { state: "running"; taskId: string; runId: string }
  | { state: "completed"; taskId: string; runId: string }
  | { state: "failed" | "cancelled"; taskId: string; runId?: string; message: string };
```

### Kontrak status yang harus diverifikasi sebelum implementasi

- Tentukan apakah task yang disebut dapat berasal dari status `queued`/`ready` saja, atau juga task `blocked`, `running`, `ready_to_merge`, dan terminal.
- Tentukan aturan bila task sudah berjalan di Kanban atau session lain.
- Verifikasi apakah chat runtime menyediakan completion hook/agent run identity yang dapat dipakai mengikat hasil ke task dan memperbarui status secara andal.
- Jika runtime chat tidak dapat menyediakan penyelesaian yang dapat diverifikasi, jangan otomatis menandai task Done berdasarkan teks akhir assistant. Tampilkan penyelesaian sebagai usulan/menunggu konfirmasi atau gunakan integrasi run yang eksplisit.
- Verifikasi executor configuration yang dibutuhkan saat konversi plan; jangan membuat task yang tidak dapat dijalankan.

## 9. Model Data

| Entitas | Bidang terkait | Kebutuhan |
|---|---|---|
| Chat session | `id`, project, pesan, model/agent | Plan clarification turns dan referensi task harus tetap berada pada session yang sama. Tambahan persistensi hanya jika bentuk pesan/session yang ada belum menyimpan data tersebut. |
| Plan | `id`, project, source session/message, status, title, summary, approval/conversion timestamps | Gunakan model plan yang ada sejauh sesuai; tambahkan state klarifikasi hanya jika tidak dapat direpresentasikan sebagai pesan session dan draft plan yang sudah ada. |
| Plan task draft | `key`, title, description, priority, dependencies, acceptance criteria, suggested files | Gunakan draft task existing; validasi semua syarat sebelum konversi. |
| Kanban task | `id`, `projectId`, `status`, `planId`, executor, `sessionId`, timestamps | Pertahankan ID task; tautkan session bila model/task lifecycle mengizinkan. Perubahan skema hanya setelah audit repository/migration. |
| Task execution/run | run identity, task ID, session/provider/model, state, outcome | Gunakan entitas run existing jika dapat mewakili eksekusi melalui chat; jangan menyamakan pesan assistant biasa dengan bukti run task. |

## 10. Tahapan Pengerjaan

### Phase 0 — Verifikasi desain dan lifecycle

**Tujuan:** Menutup ambiguitas yang berisiko sebelum perubahan skema atau eksekusi.

1. Tegaskan definisi mode: pisahkan mode `Build`/`Plan` dari agent selector bila selector saat ini memang mengirim nama agent.
2. Telusuri bagaimana chat session menyimpan pesan dan status, serta bagaimana event/runtime completion diberitakan ke UI.
3. Petakan status task dan transisi yang sah, termasuk konflik task aktif di Kanban/task session lain.
4. Verifikasi kebutuhan executor dan acceptance criteria ketika plan dikonversi.
5. Putuskan kontrak Done: sinyal sukses yang dapat diverifikasi, atau fallback konfirmasi manual.

**Gate:** Tidak ada perubahan yang membuat task dianggap selesai berdasarkan asumsi atau hanya teks balasan agent.

### Phase 1 — Perbaiki dan stabilkan mention `@task`

**Tujuan:** Membuat task yang tersedia di Kanban benar-benar dapat ditemukan dan dikenali di Composer.

1. Periksa lifecycle load/refresh `legacyTasks` untuk project aktif, session baru, session restore, dan setelah plan conversion.
2. Perbaiki renderer suggestion agar task memiliki ikon, tipe, judul, status, serta label aksesibel yang benar.
3. Verifikasi filter project, pencarian, batas hasil, navigasi keyboard, penambahan/penghapusan mention, dan penggunaan task ID.
4. Tambahkan/ajust test regresi untuk task existente yang tidak tampil, termasuk refresh board dan pergantian project/session.
5. Jangan ubah makna eksekusi mention dalam phase ini kecuali dibutuhkan untuk menghapus perilaku yang tidak aman; perubahan semantik dilakukan pada Phase 3.

**Kriteria selesai:** Task yang ada pada Kanban project aktif tampil sebagai pilihan `@task`, dan ID pilihan tepat masuk ke request chat.

### Phase 2 — Mode Plan dan tanya-jawab bertahap

**Tujuan:** Mengubah Plan dari one-shot planner menjadi alur percakapan klarifikasi.

1. Pisahkan kontrol mode Build/Plan dari selector agent/model dengan perubahan UI minimal dan jelas.
2. Definisikan routing/payload mode sehingga Plan dapat dibedakan di setiap turn dan mode tetap konsisten pada session yang sesuai.
3. Terapkan metode grill-me sebagai perilaku prompt: pertanyaan berbasis informasi yang belum diketahui, beberapa pertanyaan per putaran bila relevan, menjelaskan asumsi, dan berhenti saat keputusan penting telah terjawab.
4. Pastikan jawaban user dan pertanyaan agent masuk/terpulihkan di session chat yang sama.
5. Tambahkan status/indikator Plan seperti “mengklarifikasi”, “menyiapkan rencana”, dan error/retry yang tidak menghilangkan transcript.
6. Pertahankan Build behavior saat mode Build dipilih.

**Kriteria selesai:** Ide yang belum lengkap menghasilkan pertanyaan, jawaban berlanjut dalam session yang sama, dan agent tidak langsung membuat task sebelum kebutuhan cukup jelas.

### Phase 3 — Draft plan, review, dan konfirmasi Kanban

**Tujuan:** Mengubah hasil klarifikasi menjadi task dengan persetujuan eksplisit.

1. Buat ringkasan keputusan dan draft plan dari konteks conversation Plan.
2. Tampilkan tahapan, dependency, prioritas, acceptance criteria, dan informasi yang relevan untuk review.
3. Sediakan aksi edit, setujui/tambahkan ke Kanban, dan batalkan.
4. Validasi plan dan konfigurasi eksekusi sebelum persetujuan; jelaskan error dekat dengan task terkait.
5. Pastikan tombol persetujuan eksplisit, idempotent, serta menghasilkan task hanya sekali.
6. Setelah konversi berhasil, refresh task list/board dan pertahankan session sehingga task dapat disebut dengan `@`.

**Kriteria selesai:** Tidak ada task Kanban sebelum persetujuan; persetujuan membuat task valid satu kali dan hasilnya langsung tersedia di Kanban serta mention.

### Phase 4 — Hubungkan task mention ke sesi chat dan model terpilih

**Tujuan:** Menjalankan pekerjaan task dalam sesi chat yang sedang digunakan.

1. Ganti jalur yang saat ini selalu memanggil `daemon.startTask()` untuk `taskRefs` dengan kontrak pengaitan/pengerjaan task melalui chat session aktif.
2. Sertakan detail task yang diperlukan (prompt/description, acceptance criteria, status, dependencies yang relevan) sebagai konteks terstruktur pada turn chat; task ID menjadi sumber identitas.
3. Gunakan model dan agent yang dipilih di Composer untuk turn tersebut.
4. Cegah eksekusi duplikat atau bentrok jika task sedang berjalan melalui Kanban/other session.
5. Tentukan kapan status menjadi running berdasarkan sinyal dimulainya proses, bukan hanya karena mention dipilih.
6. Hubungkan keberhasilan/kegagalan/batal ke status task dengan mekanisme lifecycle server-side yang tervalidasi.
7. Jangan menandai Done dari respons chat saja tanpa completion signal yang dapat diverifikasi; jika tidak tersedia, tambahkan langkah konfirmasi/penyelesaian yang eksplisit.
8. Perbarui board, suggestion, dan pesan session ketika lifecycle task berubah.

**Kriteria selesai:** Task dikerjakan dalam chat session dan model terpilih, tidak ada executor kedua, dan status kanban sesuai hasil aktual.

### Phase 5 — Pengujian lintas alur dan regresi

**Tujuan:** Memastikan Plan, Build, Kanban, dan chat task mention bekerja bersama.

1. Unit test filter/renderer/selection task mention dan mode routing.
2. Integration test Plan clarification turns, persist/restore session, draft generation, validation, approval/cancel, dan idempotensi konversi.
3. Integration test task link, selected model/agent, transisi running/completed/failed/cancelled, dan konflik task yang sudah aktif.
4. UI/E2E test alur studi kasus: “buat aplikasi laundry dengan fitur 1, 2, 3” → klarifikasi → tinjau tahapan → setujui → sebut task di session yang sama → task dikerjakan oleh model terpilih → status selesai yang benar.
5. Regresi Build, task Kanban yang dijalankan dari board, chat session lama, keyboard/accessibility, dan error provider/API.
6. Jalankan pemeriksaan dan test commands resmi repository; catat hasil dan batas yang belum terverifikasi.

**Kriteria selesai:** Acceptance criteria pada dokumen ini terpenuhi, test yang relevan lulus, dan tidak ada regresi pada Build atau executor Kanban biasa.

## 11. Di Luar Cakupan

- Mengganti atau membangun ulang seluruh sistem chat, provider, Kanban, maupun orchestrator.
- Mengubah semua task Kanban agar hanya dapat dikerjakan dari chat.
- Menambahkan workflow approval organisasi, kolaborasi multi-user, atau role-based approval baru.
- Menjamin kualitas pertanyaan AI dengan jumlah putaran tetap; kualitas bergantung konteks dan keputusan yang diperlukan.
- Menandai task Done hanya berdasarkan inferensi bebas dari isi teks jawaban.
- Menginstal URL skill sebagai executable plugin tanpa terlebih dahulu memverifikasi format, lisensi, kompatibilitas, dan dukungan runtime. Untuk scope ini yang dibutuhkan adalah mengadopsi metodologi grill-me ke perilaku Plan Loom.

## 12. Risiko dan Hal yang Perlu Diputuskan

1. **Completion signal:** Belum diverifikasi apakah eksekusi melalui chat dapat dipetakan ke run task dan status terminal Kanban secara tepercaya. Ini blocking untuk otomatisasi Done.
2. **Task aktif:** Perlu kebijakan jika task yang dipilih sudah `running`/`preparing` atau sedang dikerjakan di session lain.
3. **Batas executor:** Task Kanban membutuhkan executor/configuration tertentu. Pekerjaan melalui model chat mungkin memiliki jalur runtime berbeda; perbedaan ini harus ditangani eksplisit agar status/task ownership tidak inkonsisten.
4. **Persistensi draft:** Tentukan apakah draft hasil klarifikasi hanya percakapan sampai disetujui, atau entitas plan tersimpan yang dapat dilanjutkan setelah refresh.
5. **Mode persistence:** Tentukan apakah mode Plan berlaku hanya untuk satu turn, satu tab, atau dipertahankan sebagai properti session.
6. **Konfirmasi penyelesaian:** Jika runtime tidak dapat membuktikan pemenuhan acceptance criteria, pilih antara konfirmasi user atau aksi finalisasi eksplisit; jangan membuat status Done palsu.

## 13. Definisi Selesai Keseluruhan

Fitur dinyatakan selesai jika pengguna dapat memilih Plan, menjalani klarifikasi multi-turn di session yang sama, meninjau dan secara eksplisit menyetujui task sebelum task ditambahkan ke Kanban, lalu menggunakan `@task` di session yang sama untuk memberikan konteks pekerjaan kepada model/agent terpilih. Task suggestion harus menampilkan task Kanban dengan benar dan status harus mengikuti hasil lifecycle yang benar, tanpa menandai pekerjaan gagal atau belum terverifikasi sebagai Done.
