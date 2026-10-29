# Laporan implementasi — Fase 0 s.d. 3 (lokal)

> Nama tampilan aplikasi kini **Rumah Bintang — Pusat Kemandirian dan Tumbuh Kembang Anak**
> (keputusan 29 Okt). Target deployment: **Git + Vercel + Supabase Free**. Lihat §14 dan
> [07-supabase-vercel](07-supabase-vercel.md).

Tanggal: 29 Oktober 2026 · Lingkungan: komputer pengembang lokal (macOS). **Tidak ada
staging/produksi yang disentuh atau dibuat.**

## 1. Fase yang dikerjakan

| Fase | Status |
|---|---|
| 0 — Audit | Selesai: tidak ada repository/sistem lama ([01-audit-fase0](01-audit-fase0.md)) |
| 1 — Desain teknis | Selesai ([02-desain-teknis](02-desain-teknis.md)) |
| 2 — Backend & database | Selesai dan diuji lokal |
| 3 — Web & Android | Web selesai dan dicoba di browser. Android: lihat §8 |
| 4 — Staging & UAT | **Belum.** Belum ada server staging; UAT owner belum dilakukan |
| 5 — Go-live | **Belum.** Prasyarat belum terpenuhi ([05-deployment](05-deployment.md) §6) |

## 2. Tujuan

Satu aplikasi untuk dua organisasi RTKA Rumah Bintang dengan data yang terisolasi
ketat di backend dan database, aman untuk data klinis anak, dengan transaksi yang
konsisten dan dapat ditelusuri.

## 3. Yang dibuat (≈12.800 baris)

| Area | Isi |
|---|---|
| `server/migrations` (3 file) | Skema 20 tabel, RLS di semua tabel bisnis, FK komposit tenant, hak per kolom, tabel append-only |
| `server/src` | API Fastify: auth & sesi, otorisasi terpusat, 14 modul rute |
| `server/test` (15 file) | 135 test integrasi terhadap PostgreSQL sungguhan |
| `server/scripts` | migrasi berchecksum, CLI administrasi platform, seeder DEMO (khusus `*_dev`) |
| `web/src` | 17 halaman React berbahasa Indonesia, responsif, dan dapat dicetak (kuitansi) |
| `android/` | Aplikasi Android native (Java, WebView aman, tanpa dependensi pihak ketiga) |
| `scripts/` | cluster DB lokal, backup terenkripsi, verifikasi pemulihan, ikon Android |
| `brand/` | Logo resmi (diterima 29 Okt), satu sumber untuk web, favicon & ikon Android |

## 4. Perintah penting yang dijalankan

`npm install` (0 kerentanan), `npm run db:init`, `npm run db:migrate`, `npm run seed:demo`,
`npm run typecheck`, `npm test`, `npm run build`, `npm start`, `bash scripts/backup.sh`,
`bash scripts/verify-restore.sh`, `./gradlew assembleDebug`, `./gradlew assembleRelease` (uji penolakan tanpa HTTPS).

Database yang dipakai adalah cluster **terpisah** milik proyek (`.data/pg`, port 54330).
Server PostgreSQL lain di mesin ini (port 5432) **tidak disentuh**.

## 5. Test yang dijalankan & hasil

`npm test`: **15 file, 135 test, 135 lulus, 0 gagal** (run terakhir 29 Okt 2026).
Test memakai data sintetis (label DEMO, email `.invalid`).

| File | Jumlah | Cakupan (acceptance criteria §13 master prompt) |
|---|---:|---|
| `rls.test.ts` | 13 | B: RLS tanpa konteks = 0 baris; A tidak bisa baca/tulis/pindah data ke B; FK komposit; saldo paket; audit append-only; hak kolom; owner/platform tidak bisa dinaikkan; mode READ ONLY |
| `auth.test.ts` | 21 | A: login, pesan generik, kunci akun, rate limit, akun nonaktif, logout, CSRF, Origin, header; undangan sekali pakai; owner tidak bisa diberikan; owner A tidak bisa kelola staf B; tidak membocorkan akun tenant lain; nonaktif/ubah role langsung berlaku; reset sandi |
| `isolation.test.ts` | 8 | B, D, E: baca/cari/ubah/hapus lintas tenant (404 identik); tautan ke objek B ditolak; dasbor, laporan, ekspor, dan audit tanpa data B; terapis A vs B |
| `therapy.test.ts` | 14 | C: penugasan terapis; admin/keuangan tanpa akses catatan (API & DB); revisi & alasan koreksi; hanya penulis yang mengubah; sesi gagal tanpa data parsial; kompensasi; reopen; no-show; bentrok jadwal |
| `finance.test.ts` | 10 | D: 6 penyelesaian bersamaan → tepat 1 sukses, saldo tidak minus; idempotensi; penyesuaian; kuitansi berurutan; pembatalan hanya owner; piutang; laporan tanpa "laba"; XLSX valid; skema honor per terapis |
| `support.test.ts` | 9 | F: tanpa akses default; butuh persetujuan; tidak bisa menyetujui sendiri; cakupan & baca-saja; catatan klinis hanya bila disetujui; pencabutan seketika; kedaluwarsa; audit setiap akses |
| `files.test.ts` | 6 | E: unggah/unduh terotorisasi; validasi isi berkas; batas ukuran; dokumen klinis; terapis tidak ditugaskan; aset web hilang → 404 (bukan HTML) |
| `logging.test.ts` | 1 | F: log tanpa kata sandi, query pencarian, isi catatan, cookie, token, nilai error DB |
| `supabase.test.ts` | 8 | Role Data API Supabase tanpa hak atas tabel/fungsi; semua tabel ber-RLS; arsip audit terkendali; driver Supabase Storage (header kunci); kuota berkas tanpa berkas yatim; panel kapasitas hanya untuk admin teknis; health `?db=1` |

Uji manual di browser (Playwright, data DEMO): halaman masuk, dasbor owner, detail
pasien dan catatan terapi, serta jadwal pada lebar layar ponsel (390 px).

## 6. Masalah yang ditemukan & diperbaiki selama pengerjaan

- PostgreSQL di macOS gagal start ("postmaster became multithreaded"). Diperbaiki dengan `LC_ALL=C`.
- Cakupan dukungan "catatan klinis" tanpa "data pasien" tidak akan berfungsi.
  Validasi sekarang mewajibkan `patient.read`.
- Audit di mode dukungan (transaksi READ ONLY) tidak boleh ditulis di dalam transaksi.
  Pencatatannya dipindah ke hook terpisah.
- Tombol "Tulis catatan" sempat tampil untuk owner yang tidak ditugaskan. Server tetap
  menolak dengan benar; tombolnya kini disembunyikan.
- `.env` lokal gagal dibaca bash karena path mengandung spasi. Generatornya diperbaiki.
- Setelah build web baru, permintaan aset yang belum dikenal server dijawab halaman HTML
  (status 200), sehingga CSS/JS gagal dimuat. Fallback halaman kini hanya untuk navigasi,
  aset yang tidak ada dijawab 404, aset ber-hash di-cache lama, dan ada test regresinya.
  **Server wajib di-restart setiap kali deploy** (sudah tercantum di prosedur rilis).
- Kuitansi menulis "Paket Paket …" bila nama paket sudah diawali "Paket". Sudah diperbaiki.

## 7. Backup & pemulihan

Backup terenkripsi dari database `rtka_dev` (data DEMO) **berhasil dipulihkan** ke
database sementara. Jumlah baris semua tabel dan versi migrasi cocok dengan manifest
(10 detik). Backup yang dirusak 1 byte ditolak oleh checksum. **Belum ada bukti untuk
produksi.**

## 8. Android

APK debug **berhasil dibangun**: `./gradlew assembleDebug` → `android/app/build/outputs/apk/debug/app-debug.apk` (255 KB, dengan ikon adaptif dari logo resmi).

Diverifikasi dengan `aapt2 dump` pada manifest final:

- `allowBackup=false`.
- `usesCleartextTraffic=false`.
- `dataExtractionRules` dan `networkSecurityConfig` terpasang.
- Satu-satunya izin: `INTERNET`.

`assembleRelease` tanpa `-Prtka.releaseUrl=https://…` **ditolak** sesuai rancangan.

**Belum diuji di perangkat atau emulator.** FLAG_SECURE, unggah berkas, unduhan, dan
tombol kembali perlu dicoba di HP Android nyata saat staging. Build rilis bertanda
tangan juga belum dibuat (butuh keystore dan URL produksi).

Catatan: kode awalnya ditulis dalam Kotlin. Build plugin Kotlin macet berulang di mesin
ini; ada juga daemon Gradle dari ekstensi Java VS Code yang ikut mengimpor folder
`android/`. Kode kemudian dipindah ke Java dengan perilaku yang sama, dan build langsung
berhasil.

## 9. Risiko yang belum terselesaikan

1. **Logo resmi sudah terpasang**, tetapi hanya tersedia JPEG 554 px. File vektor atau resolusi tinggi masih diperlukan untuk cetak.
2. **Belum ada staging/produksi, HTTPS, pemantauan, atau backup terjadwal** di server nyata.
3. **Kebijakan finansial & klinis** memakai default netral ([06](06-keputusan-terbuka.md)).
   Terutama: no-show, refund, diskon, retensi data, dan consent wali.
4. **Sistem lama** yang menurut prompt sedang dipakai tidak ditemukan. Data di dalamnya
   tidak dimigrasi dan statusnya tidak diketahui.
5. Belum ada uji penetrasi independen.
6. Unduhan di Android masuk ke folder Download publik (keluar dari sandbox aplikasi).

## 10. Dampak terhadap pengguna

Belum ada pengguna nyata. Saat go-live:

- Owner membuat akun staf melalui undangan.
- Terapis hanya melihat pasien yang ditugaskan kepadanya.
- Admin/koordinator tidak melihat keuangan maupun catatan klinis (default yang dapat
  diubah, lihat F8/K1).

## 11. Langkah rollback

Belum ada deployment, sehingga tidak ada yang perlu di-rollback. Prosedur untuk rilis
mendatang ada di [04-backup-rollback](04-backup-rollback.md).

## 12. Keputusan yang diperlukan dari owner

Lihat [06-keputusan-terbuka](06-keputusan-terbuka.md). Yang paling mendesak sebelum staging:

- **A9** (file logo resolusi tinggi & nama yang tampil di aplikasi).
- **A10** (server & domain).
- **A6** (penanggung jawab rollback & insiden).
- **A7** (ID aplikasi Android).
- **F2–F4** (no-show, pembatalan, refund).
- **K4/K6** (retensi data & consent wali).

## 13. Rekomendasi fase selanjutnya

1. Owner memutuskan butir mendesak di atas.
2. Siapkan server staging (VPS + domain + HTTPS) sesuai [05-deployment](05-deployment.md).
3. Deploy ke staging, jalankan backup terjadwal dan `backup:verify`, lalu UAT bersama
   owner A dan owner B memakai data DEMO.
4. Uji penetrasi singkat sebelum go-live.

## Pemisahan informasi

- **Fakta terverifikasi:** hasil test (§5), uji backup lokal (§7), build web, dan uji UI di browser.
- **Asumsi:** kebutuhan modul diturunkan dari master prompt; tidak ada wawancara langsung dengan owner.
- **Rekomendasi:** §13.
- **Belum dilakukan:** staging, produksi, UAT, uji penetrasi, migrasi/arsip data lama, uji APK di perangkat nyata.

## 14. Adaptasi Supabase + Vercel (29 Okt 2026)

**Dikerjakan:**

- Migrasi `004`:
  - Mencabut semua hak role Data API Supabase (`anon`, `authenticated`, `service_role`).
  - RLS diaktifkan di semua tabel.
  - Fungsi kapasitas (agregat saja).
  - Arsip audit terkendali.
- Penyimpanan berkas: driver Supabase Storage (REST, bucket privat) dan kuota per organisasi.
- Pool koneksi kecil dan SSL dengan verifikasi CA.
- Bundle Vercel (Build Output API v3): `npm run build:vercel`.
- Hemat ruang database:
  - Revisi catatan tidak lagi menggandakan versi terkini.
  - User-agent hanya disimpan untuk kejadian keamanan.
- Pemantauan kapasitas: `admin db-usage`, panel Kapasitas untuk admin teknis, dan pemakaian
  penyimpanan di Pengaturan organisasi.
- Backup/verify: dump schema `public` + berkas dari Storage; pemulihan diuji ke PostgreSQL lokal.

**Bukti:**

- 90 test lulus, termasuk 8 test Supabase. Driver Storage diuji terhadap server Storage tiruan.
- Uji mutasi: tanpa migrasi `004`, role `anon` masih bisa membaca tabel pasien; dengan `004`, tidak lagi.
- Bundle Vercel (±3 MB) dijalankan lokal: health+DB, login, dasbor, dan endpoint storage berhasil.
- Backup schema `public` berhasil dipulihkan dan cocok dengan manifest.

**Belum diuji:** proyek Supabase sungguhan (pooler, sertifikat CA, Storage dengan
`sb_secret_…`) dan deployment Vercel sungguhan. Langkah verifikasi pertamanya ada di
[07](07-supabase-vercel.md) §5 langkah 10.

**Perlu keputusan:** A12 (Vercel Pro karena penggunaan komersial), A13 (backup), A14
(jeda proyek Free), A15 (lokasi data / UU PDP).

## 15. Program terapi, invoice/diskon/refund, rekonsiliasi, notifikasi, PDF, privasi (29 Okt 2026)

**Dikerjakan:**

- Migrasi `005`: 10 tabel baru dengan RLS, FK komposit, dan hak kolom. Migrasi `006`
  menambal hak EXECUTE PUBLIC yang bersifat global (ditemukan oleh test).
- **Program terapi:** program per anak, tujuan, dan riwayat capaian (append-only). Aksesnya
  sama dengan catatan klinis.
- **Invoice:** harga paket/sesi diambil dari database, satu paket/sesi hanya di satu
  invoice aktif, pembayaran tidak melebihi sisa tagihan, dan PDF.
- **Diskon:** wajib beralasan. Owner bebas, kasir dibatasi persen organisasi (default 0%).
- **Refund:** hanya owner, tidak melebihi pembayaran (dijaga kunci baris dan trigger),
  mengurangi penerimaan bersih, dan ada bukti PDF.
- **Rekonsiliasi:** arus kas per metode & periode, verifikasi transaksi, dan finalisasi
  oleh owner. Yang sudah final terkunci.
- **Notifikasi sekali klik:** pengingat jadwal ke wali (WhatsApp, pesan tanpa info klinis,
  templat dapat diatur, tercatat) serta tautan undangan/reset via WhatsApp/email.
- **PDF tanpa dependensi:** kuitansi, invoice, bukti refund, laporan
  operasional/keuangan, dan ekspor data pasien. PDF berfungsi juga di Android, yang tidak
  mendukung `window.print()`.
- **Privasi (UU PDP):**
  - Register permintaan wali.
  - Ekspor data pasien (PDF bertanda RAHASIA).
  - Anonimisasi mode *identitas* (catatan klinis & keuangan tetap) atau *penuh*.
  - Kandidat retensi (tanpa hapus otomatis).

**Bukti:** 23 test baru (`programs`, `billing`, `privacy`); total 113 lulus. Di antaranya:

- 3 refund bersamaan menghasilkan 2 sukses + 1 ditolak, dengan total tepat sama dengan
  nominal pembayaran.
- PDF diperiksa isinya (data organisasi lain tidak ada).
- Anonimisasi menghapus berkas dari penyimpanan.
- Dicek di browser: halaman Pengingat dan formulir invoice.

**Temuan selama pengerjaan:**

- Hak EXECUTE PUBLIC untuk fungsi baru tidak tertutup oleh migrasi 004, sehingga ditambal di 006.
- Dua kegagalan test berasal dari test itu sendiri (input tidak valid dan tabel kosong), lalu diperbaiki.
- Helper PDF di test sempat loop tak berujung, lalu diperbaiki.

**Belum:** pengiriman notifikasi otomatis tanpa klik (butuh layanan berbayar & akun),
aturan bisnis refund/diskon/retensi yang final dari owner, dan uji di perangkat Android
untuk unduhan PDF.

## 16. Pengingat WhatsApp otomatis lewat Fonnte (29 Okt 2026)

**Dikerjakan:**

- Migrasi `007`:
  - `org_whatsapp`: token terenkripsi, aktif/nonaktif, menit sebelum jadwal.
  - `guardians.wa_opt_out`.
  - Status pengiriman di `notification_log`.
- **Kebijakan per organisasi:** owner menetapkan berapa jam sebelum jadwal pengingat
  dikirim (0,5–48 jam), misalnya 2 atau 3 jam.
- **Cron** `GET /api/cron/reminders` (Bearer `CRON_SECRET`) mengirim yang jatuh tempo,
  sekali per jadwal.
- Yang **tidak** dikirim otomatis:
  - jadwal yang dimulai kurang dari 15 menit lagi;
  - wali yang menolak;
  - nomor tidak valid;
  - jadwal yang sudah dikirimi manual.
- **Kirim manual sekaligus:** tombol *Kirim semua lewat Fonnte* untuk satu tanggal
  (admin/owner).
- **UI:**
  - Pengaturan → WhatsApp otomatis: hubungkan, cek koneksi & kuota, pesan uji, putuskan.
  - Status otomatis per jadwal di halaman Pengingat.
  - Centang "menolak" di data wali.

**Bukti:**

- 11 test baru (`whatsapp.test.ts`, memakai server Fonnte tiruan; tidak ada pesan
  sungguhan). Total 124 lulus.
- Uji mutasi: bila batas "N menit sebelum jadwal" diabaikan, 3 test gagal.
- Diperiksa juga di browser lokal: pengaturan dan halaman Pengingat.
- Endpoint cron dipanggil di server lokal: tanpa rahasia 401, dengan rahasia 200.

**Belum diuji:** akun & nomor Fonnte sungguhan, dan cron di Vercel. Langkah aktivasi ada
di `docs/07-supabase-vercel.md` §9.

## 17. Tampilan baru & admin merangkap keuangan (29 Okt 2026)

**Tampilan:**

- Gaya dasar diperbarui mengikuti warna logo:
  - menu samping navy;
  - aksen jingga hanya sebagai bintang (menu aktif dan penanda jam sekarang);
  - latar biru muda;
  - judul tabel dan menu tidak lagi huruf kapital semua.
- Dasbor:
  - sapaan sesuai jam di zona waktu organisasi;
  - papan jadwal hari ini per terapis, dengan warna status dan penanda jam sekarang;
  - di HP berganti menjadi daftar.
- Angka ringkasan Dasbor dan Laporan digabung dalam satu panel.
- Halaman masuk dibagi dua: panel busur bintang dan formulir dengan logo resmi.

**Admin merangkap keuangan** (keputusan owner, lihat [06](06-keputusan-terbuka.md) F8):

- Migrasi `008`: `memberships.handles_finance` dan `account_tokens.handles_finance`. Ada
  CHECK bahwa rangkap hanya untuk admin, dan kebijakan RLS aktivasi harus sama dengan
  undangan.
- Owner mencentangnya per admin di Staf → Ubah atau saat mengundang. Label peran menjadi
  "Admin & Keuangan". Perubahan tercatat di audit (`keuangan_sebelum` / `keuangan_sesudah`)
  dan langsung berlaku.

**Bukti:**

- 4 test baru (`staff-finance.test.ts`) memastikan bahwa:
  - akses keuangan terbuka dan dapat dicabut;
  - catatan klinis, pembatalan, dan pengaturan tetap tertutup;
  - rangkap hanya untuk admin;
  - undangan terbawa saat aktivasi;
  - RLS menolak aktivasi yang menambah akses;
  - pengaturan organisasi A tidak berlaku di B.
- Total 128 lulus.
- Uji mutasi: bila hak keuangan tidak ditambahkan, 3 test gagal.
- Diperiksa juga di browser lokal: owner A mencentang DEMO Admin A, lalu admin melihat menu
  keuangan. API pembayaran 200, audit log 403.

## 18. Batas wajib catatan sesi: akhir bulan (29 Okt 2026)

**Keputusan owner:** setiap sesi selesai wajib punya catatan **final** paling lambat akhir
bulan sesi (lihat [06](06-keputusan-terbuka.md) K7). Tidak ada migrasi; aturannya
dihitung dari `appointments.starts_at` dan `therapy_notes.finalized_at` di
`server/src/lib/note-deadline.ts`.

- **Dasbor:**
  - daftar *Catatan sesi belum final* diurutkan dari yang terlama;
  - setiap baris menampilkan tanggal batas atau tanda **Lewat batas**;
  - peringatan merah bila ada yang lewat batas;
  - peringatan kuning 3 hari sebelum akhir bulan.
  - Terapis hanya melihat miliknya sendiri.
- **Jadwal:** label "Belum ada catatan, lewat batas" atau "Catatan draf, lewat batas".
- **Laporan operasional, PDF, dan Excel:**
  - per terapis: jumlah *catatan belum final*, *lewat batas*, dan *final terlambat*;
  - Excel memakai kolom *Catatan*.
  - Peran tanpa akses catatan (admin) tidak mendapat hitungan ini, karena RLS
    menyembunyikan catatan sehingga angkanya akan menyesatkan.

**Bukti:**

- 4 test baru (`note-deadline.test.ts`), total 132 lulus.
- Uji mutasi: bila bulan berjalan dianggap lewat batas, 2 test gagal.
- Diperiksa di browser dengan satu sesi DEMO sementara bulan lalu (dihapus lagi setelahnya):
  dasbor terapis, laporan owner, dan jadwal.

## 19. Pengingat WhatsApp: satu pesan per anak per hari, H-3 jam (29 Okt 2026)

**Keputusan owner:** pengingat hanya satu kali per anak per hari, dikirim 3 jam sebelum sesi
pertamanya. Jam tetap bisa diatur owner masing-masing; bawaannya 3 jam.

- `loadReminders` mengelompokkan jadwal per anak dan per tanggal lokal. Pesan memakai
  `{jam}` = semua jam sesi ("09:00, 09:30, dan 14:00") dan `{terapis}` = daftar terapis.
- **Cron:**
  - grup diproses bila ada sesi yang belum diingatkan dalam batas N jam;
  - semua sesi layak di grup itu diklaim dan dicatat dengan ID pesan Fonnte yang sama;
  - sesi tambahan setelah pesan terkirim mendapat pesan tersendiri saat jatuh tempo.
- **Halaman Pengingat:**
  - satu baris per anak;
  - tombol *Kirim WhatsApp* menandai semua sesi anak itu
    (`POST /reminders/sent { appointmentIds }`, menggantikan `/reminders/:id/sent`);
  - jadwal organisasi lain ditolak 404.
- Tidak ada migrasi.

**Bukti:**

- 3 test baru di `whatsapp.test.ts`. Uji penggabungannya tidak bergantung pada jam
  dijalankan: batasnya dihitung dari waktu ke besok 09.00.
- Test lama disesuaikan agar satu anak per jadwal. Total 135 lulus.
- Uji mutasi: bila pengelompokan dimatikan, 3 test gagal.
- Diperiksa di browser dengan dua sesi DEMO sementara (dihapus lagi): satu baris
  "pukul 15:00, 16:00" dan pesan "pukul 15:00 dan 16:00".

