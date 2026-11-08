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
| `server/test` (18 file) | 173 test integrasi terhadap PostgreSQL sungguhan |
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

`npm test`: **18 file, 173 test, 173 lulus, 0 gagal** (run terakhir 5 Nov 2026).
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

## 20. Login username, undangan WhatsApp, dan dasbor orang tua (1 Nov 2026)

**Keputusan owner:** login memakai username, undangan lewat WhatsApp tanpa email, ada dasbor
orang tua, dan akun orang tua berasal dari undangan admin.

**Username**

- Migrasi `009`: `users.username` dan `users.phone`; `email` boleh kosong, tetapi setiap akun wajib
  punya email atau username. Format username tanpa `@`, jadi satu kolom login tidak pernah ambigu.
- `POST /auth/login` menerima `identifier` (username atau email). Akun email lama tetap dapat
  masuk dan dapat mengatur username di Profil (`POST /auth/username`, wajib kata sandi saat ini).
- Username unik lintas organisasi karena halaman login tidak memilih organisasi.
- Staf memilih username sendiri saat aktivasi; halaman aktivasi mengusulkannya dari nama.

**Undangan WhatsApp**

- `POST /staff/invitations` menerima nomor WhatsApp, bukan email. Tautan dibuka di `wa.me` ke
  nomor tujuan. Aplikasi tidak mengirim pesan sendiri; yang mengundang menekan tombol kirim.
- CLI `invite-owner` memakai `--phone`.
- **Risiko yang diterima:** token aktivasi ada di teks pesan, jadi melewati WhatsApp. Token
  sekali pakai, berlaku 72 jam, dan disimpan sebagai hash.

**Dasbor orang tua**

- Peran baru `wali`, mode sesi `portal`. `needTenant` selalu menolak mode portal, sehingga seluruh
  rute staf tertutup walau permission keliru. Test menelusuri semua rute di `server/src/routes`,
  jadi rute baru otomatis ikut diperiksa.
- `GET /portal` berjalan dalam transaksi READ ONLY.
- RLS: kebijakan baru hanya tambahan dan khusus SELECT (`guardians`, `patients`, `appointments`,
  `patient_packages`, `invoices`, `payments`, `refunds`, `therapy_notes`) lewat `app_is_guardian()`.
  Kebijakan staf tidak diubah. Draf catatan, revisi, dokumen, dan audit tidak terbuka untuk portal.
- Yang tampil: jadwal, riwayat sesi, kehadiran bulan ini, paket, tagihan, dan catatan terapis final
  (K8). Catatan admin, alasan pembatalan, dan harga per sesi tidak dikirim.
- Kebijakan RESTRICTIVE menutup untuk portal: revisi catatan, penugasan terapis, katalog paket,
  penomoran, log notifikasi, sesi login, serta akun orang tua lain. Test memeriksa seluruh tabel
  terhadap daftar yang disetujui, jadi membuka tabel baru harus berupa keputusan sadar.
- `GET /portal/notes` dimuat saat tab *Catatan terapis* dibuka dan dicatat sebagai
  `catatan.dilihat_wali`. Editor catatan memberi tahu terapis bahwa catatan final dibaca orang tua.
- Admin dan owner mengundang dari data wali di halaman pasien (`guardian.invite`). Nomor yang sudah
  punya akun wali di organisasi yang sama langsung dihubungkan (kakak-adik) tanpa undangan baru.
- Mencabut akses atau menghapus wali terakhir menutup akun dan sesinya seketika. Anonimisasi pasien
  menghapus baris wali, sehingga akses putus dan undangan yang tertunda ikut gugur.

## 21. Honor: gaji pokok, tunjangan, dan per sesi (5 Nov 2026)

**Permintaan owner:** ada terapis bergaji pokok + tunjangan + per sesi, ada yang hanya per sesi,
dan tunjangan bisa ditambah sesuai kebutuhan.

- Migrasi `010`: `compensation_components` (gaji pokok / tunjangan, nominal per bulan, berlaku
  per bulan kalender) dan `compensation_component_payouts` (pembayaran per bulan; nama dan nominal
  dibekukan; tidak dapat diubah atau dihapus oleh role aplikasi).
- Skema terbaca otomatis dari komponen yang berlaku: "Gaji pokok + tunjangan + per sesi",
  "Per sesi", dan seterusnya. Honor per sesi (aturan lama) tidak berubah.
- Satu gaji pokok per terapis per bulan; kenaikan gaji = akhiri yang lama lalu buat yang baru.
  Tunjangan boleh lebih dari satu. Bulan akhir tidak boleh sebelum bulan yang sudah dibayar.
- `GET /compensation/monthly?month=YYYY-MM`: per terapis gaji & tunjangan, honor sesi bulan itu,
  total, belum dibayar. `POST /compensation/components/mark-paid` menandai komponen bulan itu.
- Hak akses sama dengan honor per sesi: owner mengatur dan membayar, keuangan melihat, terapis
  hanya miliknya (juga di RLS).
- Laporan keuangan, PDF, dan Excel (sheet "Gaji & Tunjangan") ikut menghitung komponen bulanan
  untuk bulan yang tanggal 1-nya berada di rentang laporan.
- Default yang belum disetujui (F13): tanpa prorata, potongan, pajak, atau BPJS.

**Bukti:** 7 test baru (`compensation-fixed.test.ts`), total 165 lulus. Uji mutasi: mengabaikan
bulan akhir menggagalkan 3 test; membuka RLS komponen menggagalkan 1 test. Diperiksa di browser
dengan data DEMO lokal (dihapus lagi).

## 22. Skema honor diatur sekaligus (5 Nov 2026)

**Permintaan owner:** pengaturan gaji dibuat lebih praktis, boleh dibangun ulang.

- Tab *Skema honor* kini satu kartu per terapis: jenis skema, gaji pokok, tunjangan, total tetap
  per bulan, honor per sesi, dan tarif khusus per layanan, dengan tombol **Atur skema**.
- Satu formulir: pilih jenis (hanya per sesi / gaji + tunjangan + per sesi / gaji + tunjangan saja),
  tombol cepat tunjangan (transport, makan, jabatan, kehadiran, komunikasi, lainnya), tarif khusus
  per layanan, bulan berlaku, dan **salin dari terapis lain**. Riwayat lengkap tetap ada (dilipat).
- `PUT /compensation/schemes/:memberId` menyimpan sekaligus dalam satu transaksi: yang sama
  dibiarkan; yang berubah diakhiri di akhir bulan sebelumnya; yang baru dibuat untuk bulan itu dan
  belum dibayar/dipakai diganti (koreksi tidak menumpuk). Bulan yang sudah dibayar dan tarif yang
  sudah dipakai menghitung honor ditolak dengan pesan jelas. Honor sesi yang sudah dihitung tidak
  dihitung ulang. `GET /compensation/schemes?month=` menampilkan skema yang berlaku.
- Migrasi `011`: hak DELETE (beserta kebijakan RLS keuangan) untuk komponen dan aturan; baris yang
  sudah dibayar atau dipakai tetap terlindungi foreign key.

**Bukti:** 8 test baru (`compensation-scheme.test.ts`), total 173 lulus. Uji mutasi: melepas
perlindungan bulan dibayar menggagalkan 1 test; menyimpan ulang selalu membuat baris baru
menggagalkan 3 test. Diperiksa di browser (laptop dan HP) dengan data DEMO lokal (dihapus lagi).

## 23. Impor data pasien dari Excel berformat bebas (5 Nov 2026)

**Permintaan owner:** impor data pasien dari Excel dengan format bebas yang terdeteksi otomatis.
Ini keputusan baru yang eksplisit; tidak ada data lama yang dipindahkan otomatis. Admin/owner
sendiri yang memilih berkas dan baris yang diimpor.

- Halaman Pasien: tombol **Impor Excel** (hak `patient.manage`: owner dan admin). Menerima .xlsx
  dan .csv (pemisah `;`, `,`, tab, atau `|`). Berkas .xls lama, .ods, dan berkas berkata sandi ditolak
  dengan petunjuk untuk menyimpannya sebagai .xlsx.
- Deteksi otomatis: baris judul kolom dicari di 20 baris pertama (judul laporan di atasnya
  dilewati), judul dua tingkat ("Data Ibu" di atas "Nama" dan "No HP") digabung, dan judul seperti
  Nama/Nama Anak, Panggilan, Tgl Lahir/TTL, L/P/JK, Nama Ibu/Ayah/Orang Tua/Wali, No HP/WA,
  Email, Alamat, Tgl Daftar/Masuk, Status, Keterangan/Kode Pasien dikenali. Tanpa judul, kolom
  ditebak dari isinya (nama, tanggal, L/P, nomor HP, email).
- Setiap kolom dapat dikoreksi ("diimpor sebagai"); beberapa kolom boleh digabung ke catatan
  administrasi dengan label judulnya. Kolom seperti Diagnosa, Usia, atau Sekolah tidak diimpor
  kecuali dipilih.
- Perapian: tanggal 12/03/2019, 12-3-19, 2019-03-12, "12 Maret 2019", "Solo, 12 Maret 2019",
  sel tanggal Excel; kolom berformat bulan/tanggal dikenali sendiri. L/P dari Laki-laki/Perempuan/
  Pria/Wanita dan sejenisnya. Nomor HP dirapikan ke 08xx (nomor kedua diberi keterangan). Isian
  "-", "belum ada", "x" dianggap kosong. Nilai yang tidak dikenali dikosongkan dengan keterangan;
  baris tidak gagal karenanya.
- Wali: ibu, ayah, dan/atau orang tua/wali umum dibuat sebagai wali; yang punya nomor HP menjadi
  wali utama. Nomor tanpa nama diberi nama pengganti yang jelas ("Ibu <nama anak>").
- Pratinjau sebelum menyimpan: *Siap diimpor*, *Sudah terdaftar* (nama sama dengan tanggal lahir
  sama/kosong, di sistem atau di baris sebelumnya; tidak diimpor kecuali dicentang), dan *Tidak
  dapat diimpor* (nama kosong/tidak valid). Setiap baris dapat dicentang/dihapus centangnya.
- Server tidak menyimpan berkas. Pratinjau dan impor membaca ulang berkas yang sama; impor
  berjalan dalam satu transaksi dengan kunci per organisasi dan memeriksa duplikat ulang. Kode
  pasien dibuat berurutan seperti pendaftaran biasa. Audit `pasien.diimpor` (jumlah dan kode).
- Default yang dipilih tanpa aturan owner: baris duplikat tidak diimpor kecuali dicentang;
  status kosong dianggap aktif; tanggal pendaftaran kosong diisi hari impor; maks. 2.000 baris
  per impor.

**Bukti:** 12 test baru (`patient-import.test.ts`), total 185 lulus. Uji mutasi: mengabaikan
daftar baris yang dikecualikan menggagalkan 1 test; mengimpor duplikat tanpa diminta
menggagalkan 2 test. Diperiksa di browser (laptop dan HP) dengan berkas DEMO berjudul dua
tingkat dan format tanggal campur.

## 24. Absen sesi, jadwal tanpa terapis, No. RM, Pasien Baru, video/foto (5 Nov 2026)

**Permintaan klien (diteruskan owner):** anak bisa menjalani dua layanan (OT dan TW); jadwal cukup
pasien dan layanan, terapis ditentukan saat absen; satu pasien satu No. RM; terapis absen dengan
memilih No. RM/nama dan layanan, menulis aktivitas dan PR, serta mengunggah video/foto; menu Pasien
Baru yang lengkap; orang tua masuk dengan No. RM. Keputusan owner: K1, K5, K9, K10 di
[06-keputusan-terbuka.md](06-keputusan-terbuka.md).

- **No. RM**: kode pasien otomatis yang sudah ada (unik per organisasi, awalan diatur owner) kini
  disebut No. RM di semua layar, ekspor, dan pencarian.
- **Jadwal tanpa terapis** (migrasi `012`): `appointments.therapist_member_id` boleh kosong; sesi
  selesai wajib memiliki terapis (CHECK). Pemeriksaan bentrok tetap untuk pasien. Dasbor,
  pengingat WA ("terapis kami"), laporan, dan dasbor orang tua menampilkan jadwal tanpa terapis.
- **Absen sesi** (menu *Absen Sesi*): daftar jadwal yang menunggu absen (termasuk yang belum
  memiliki terapis) dan yang sudah diabsen; absen tanpa jadwal. Satu transaksi: terapis tertaut
  ke anak, jadwal dipakai bila ada (atau dibuat), paket layanan itu dipotong (atau per sesi),
  honor terhitung, aktivitas & PR menjadi catatan final. Admin dapat mengabsenkan dengan memilih
  terapis (termasuk pengganti; tercatat di audit `sesi.diabsen`).
- **Dua layanan**: paket sudah per layanan; OT dan TW di hari yang sama oleh terapis berbeda
  memotong paket masing-masing.
- **Video/foto sesi** (`session_media`): unggah dengan progres dari HP, durasi video diperiksa di
  perangkat dan di server, putar langsung (Range). Hak lihat mengikuti cakupan catatan klinis.
- **Pasien Baru** (menu baru): identitas, tempat lahir, ayah & ibu + No. WA, kontak utama,
  keluhan awal, hasil pemeriksaan, program (pilih layanan + uraian), berkas opsional KTP/KIA/foto
  anak (dokumen administrasi). Pemeriksaan awal dapat diubah dari halaman pasien.
- **Login orang tua dengan No. RM**: undangan wali menyimpan No. RM anak sebagai saran username;
  halaman aktivasi sudah terisi, dan login menerima No. RM (huruf besar/kecil sama).
- Anonimisasi kini juga menghapus tempat lahir dan video/foto anak; mode penuh mengosongkan data
  pemeriksaan.

**Bukti:** 14 test baru (`absen.test.ts`), total 199 lulus. Uji mutasi: tanpa penautan terapis
saat absen 4 test gagal; tanpa batas 30 detik 1 test gagal; kebijakan RLS data pemeriksaan
dilonggarkan 1 test gagal. Diperiksa di browser (laptop dan HP) dengan data DEMO: pendaftaran
lengkap, jadwal tanpa terapis, absen oleh terapis, unggah video/foto (video 10 detik ditolak),
undangan orang tua dengan username No. RM, dan aktivitas & PR tampil di dasbor orang tua tanpa video.

**Tambahan (5 Nov 2026, malam):**
- **Informed consent wajib** di formulir Pasien Baru (keputusan K6). `patient_documents.doc_type`
  menandai berkas pendaftaran (informed consent, KTP orang tua, KIA, foto anak). Pasien tanpa
  consent ditandai di daftar dan halaman pasien, dengan tombol unggah langsung.
- **Impor dari Google Form pendaftaran**: kolom *Timestamp/Cap waktu* menjadi tanggal daftar,
  *Tempat, tanggal lahir* dipisah menjadi tempat lahir dan tanggal lahir, *Keluhan* menjadi
  keluhan awal (data pemeriksaan), *Diagnosa/Hasil pemeriksaan* dan *Program* juga dikenali.
  Isian pemeriksaan hanya tersedia bagi pengguna berhak `patient.intake`. Berkas PDF ditolak
  dengan petunjuk mengunduh Excel dari Google Sheets (tabel PDF tidak terbaca andal).
- Bukti: 3 test tambahan (tiruan formulir Google berisi data DEMO, penolakan PDF, informed
  consent); total 202 lulus. Diperiksa di browser: formulir menolak kirim tanpa consent, tanda di
  daftar pasien, dan unggah consent dari halaman pasien.

## 25. Pendaftaran online pengganti Google Form (5 Nov 2026)

**Permintaan owner:** formulir Google "PENDAFTARAN PASIEN BARU DI RUMAH BINTANG" dipindah ke
aplikasi (keputusan K11).

- Halaman publik `/daftar/<token>` (nyaman di HP, tanpa akun): nama anak, tempat & tanggal lahir,
  nama orang tua/wali + hubungan, No. WA, alamat, keluhan, hari & jam asesmen, centang persetujuan.
- Menu Pasien Baru: panel *Pendaftaran online* berisi tautan (salin / bagikan lewat WhatsApp),
  tombol buka/tutup dan ganti tautan (owner), serta daftar kiriman masuk dengan penanda
  kemungkinan ganda. *Proses* mengisi formulir Pasien Baru; setelah disimpan No. RM terbit, data
  ditandai diterima, dan jendela jadwal asesmen terbuka dengan tanggal & jam pilihan orang tua
  (tagihan tetap dipilih admin). *Tolak* wajib beralasan. Dasbor admin/owner menampilkan jumlah
  pendaftaran yang menunggu.
- Migrasi `013`: `organizations.registration_token/registration_open`, tabel
  `registration_requests`, fungsi `public_registration_info` dan `submit_registration`.

**Bukti:** 7 test baru (`registrations.test.ts`), total 209 lulus. Uji mutasi: kebijakan baca
RLS tanpa syarat cakupan intake menggagalkan 1 test. Diperiksa di browser: owner membuka
pendaftaran, orang tua mengisi dari HP, admin melihat penanda di dasbor, memproses (formulir
terisi otomatis), No. RM terbit, dan jadwal asesmen dibuat sesuai pilihan orang tua.

**Tambahan: brosur di halaman pendaftaran (migrasi `014`).** Owner mengunggah gambar brosur paket
& harga (JPG/PNG/WebP, maks. 5 MB) dari panel Pendaftaran online; gambar tampil di atas formulir
publik selama pendaftaran dibuka, per organisasi (tidak ditanam di kode). 1 test baru, total 210
lulus. Diperiksa di browser dengan brosur dari owner (tampil penuh lebar di layar HP).

**Pemeriksaan ulang alur pendaftaran sebelum dipasang:** ditambahkan tombol *Hubungi lewat WA*
per pendaftaran masuk (pesan konfirmasi jadwal asesmen terisi otomatis, dikirim manual oleh
admin), tanda *Dikirim 2x* untuk kiriman ganda yang masih menunggu, serta telepon/WhatsApp dan
alamat klinik (dari Pengaturan organisasi) di bawah formulir publik. Total 210 test lulus.

**6 Nov 2026:** atas permintaan owner, foto informed consent di formulir Pasien Baru **sementara
opsional** (K6). Tanda *Belum ada informed consent* di daftar dan halaman pasien tetap ada sebagai
pengingat.

## 26. Tunjangan per hari hadir, gaji per terapis, dan paket lama (6 Nov 2026)

**Permintaan owner:** tunjangan operasional dihitung sekali per hari, BPJS sekali per bulan;
gaji dibayarkan tiap tanggal 1 (akumulasi satu bulan) dan ditampilkan per nama dengan total
saja; paket pasien yang sudah berjalan sebelum memakai aplikasi (mis. sisa 2 sesi) dapat dicatat.

- Tunjangan di *Skema honor* punya pilihan **per bulan** atau **per hari hadir**. Hari hadir =
  tanggal (zona waktu organisasi) ketika terapis punya minimal satu sesi berstatus selesai;
  beberapa sesi di tanggal yang sama tetap satu hari (pilihan owner, F13). Gaji pokok selalu
  bulanan. Sebelumnya semua tunjangan dibayar penuh sekali per bulan, sehingga tunjangan
  operasional Rp10.000 hanya terhitung Rp10.000 sebulan.
- *Rekap bulanan → Gaji pokok & tunjangan* kini **satu baris per terapis** berisi total bulan itu
  (gaji pokok + tunjangan bulanan + tarif harian × hari hadir) dan jumlah hari hadir. Tanggal
  bayar terisi otomatis **tanggal 1 bulan berikutnya**; bila bulan belum berakhir ada peringatan
  bahwa hari hadir masih bertambah. Saat ditandai dibayar, nominal dan jumlah hari dibekukan;
  absen susulan sesudahnya tidak mengubah yang sudah dibayar. Laporan keuangan dan ekspor
  Excel memakai nominal yang sama (kolom *Hari Hadir*).
- *Jual paket* punya pilihan **Paket lama (sebelum aplikasi)** untuk owner/keuangan: isi sisa sesi
  saat ini dan nominal yang sudah dibayar. Nominal itu **tidak masuk pemasukan** (uangnya
  diterima sebelum aplikasi), hanya mengurangi piutang; kekurangannya menjadi piutang biasa.
  Sesi terpakai dicatat di riwayat paket sebagai *Saldo awal paket lama*. Paket ditandai
  *Paket lama* di halaman pasien.
- Paket lama juga punya kolom **Harga saat dibeli** (bawaan: harga katalog), untuk paket yang
  dulu dibeli dengan harga berbeda.
- **Tautkan ke paket** (owner/keuangan): pembayaran berstatus *Umum* (tanpa tujuan) dapat
  dihubungkan sekali ke paket pasien yang sama, mis. pembayaran paket yang dicatat sebelum
  paketnya dibuat. Nomor kuitansi, tanggal, dan nominal tidak berubah; nominal tidak boleh
  melebihi sisa tagihan paket; tercatat di Audit Log (`pembayaran.ditautkan`). Database menolak
  mengubah tautan yang sudah ada (trigger `payments_link_guard`).
- **Satu langkah (permintaan owner, 6 Nov malam):** bila pasien belum punya paket, jendela *Tautkan
  ke paket* langsung berisi isian paket lama (jenis paket, sisa sesi, harga paket; bawaan harga =
  nominal pembayaran = lunas). *Simpan & tautkan* membuat paket lama bertanggal beli sama dengan
  tanggal bayar dan menautkan kuitansinya dalam satu transaksi; bila gagal, tidak ada paket yang
  tertinggal. Tanpa migrasi baru.
- Migrasi `015`: `compensation_components.basis`, `compensation_component_payouts.days`,
  `patient_packages.carried_over/opening_paid`, izin ubah `payments.patient_package_id` + trigger
  penjaga.

**Bukti:** 12 test baru (`tunjangan-harian-paket-lama.test.ts`), total 222 lulus. Uji mutasi:
menghitung semua sesi (bukan tanggal unik) menggagalkan 3 test; mengabaikan nominal "sudah
dibayar" paket lama menggagalkan 2 test; menghapus batas sisa tagihan saat menautkan
menggagalkan 1 test. Diperiksa di browser (desktop & HP): formulir skema dengan pilihan per hari
hadir, rekap gaji per terapis, formulir paket lama, dan menautkan pembayaran Umum Rp480.000 ke
paket lama (kuitansi tetap).

## 27. Bayar langsung untuk paket / sekali datang, dan admin boleh ubah harga (6 Nov 2026)

**Permintaan owner:** pembayaran langsung masuk ke paket atau ke kunjungan sekali datang tanpa harus
membuat paket dulu (tab Paket cukup untuk memantau/koreksi); admin dapat diberi akses mengubah tarif
dan harga paket.

- *Catat pembayaran* → **Untuk**: **Paket** (beli paket baru dari katalog → paket dibuat otomatis
  bertanggal beli = tanggal bayar; atau cicilan/pelunasan paket yang ada), **Sekali datang** (pilih
  layanan; bila ada sesi per-sesi yang belum dibayar, pembayaran masuk ke sesi itu, didahulukan yang
  sudah diabsen; bila tidak ada, dicatat sebagai **kunjungan prabayar** = paket 1 sesi bertarif
  layanan yang terpakai otomatis saat anak diabsen), atau **Lainnya** (umum). Nominal terisi
  otomatis; nominal di atas harga ditolak; pembuatan paket dan pembayaran dalam satu transaksi.
  Kunjungan prabayar bertanda *Prabayar* di tab Paket dan tidak ikut peringatan paket hampir habis.
- **Admin boleh mengubah tarif & harga paket:** owner mencentang per admin di *Staf → Ubah*
  (`memberships.manages_catalog`, hak `catalog.manage`); pengaturan organisasi lain tetap owner.
  Pindah peran melepas akses ini.
- Migrasi `016` (`patient_packages.is_visit`) dan `017` (`memberships.manages_catalog`). Endpoint
  baru `GET /patients/:id/unpaid-sessions`.

**Bukti:** 8 test baru (`bayar-langsung.test.ts`), total 230 lulus. Uji mutasi: menghapus batas
nominal ≤ harga menggagalkan 2 test; kunjungan prabayar ikut peringatan dasbor menggagalkan 1 test.
Diperiksa di browser: Catat pembayaran → Paket / Sekali datang (kunjungan prabayar tampil di tab
Paket), dan centang akses harga di Staf.

## 28. Impor rekap absensi lama (6 Nov 2026)

**Permintaan owner:** sesi November yang tercatat di Google Form absensi terapis (sebelum memakai
Absen Sesi di aplikasi) dimasukkan ke aplikasi beserta catatannya, pasien yang belum terdaftar
dibuat dengan data minimal, dan tunjangan operasional terapis menjadi per hari hadir mulai November.

- Alat baris perintah `server/scripts/impor-rekap.ts <file.json> [--commit]` dengan logika di
  `server/src/lib/impor-rekap.ts`. Seluruh impor berjalan dalam **satu transaksi**; tanpa
  `--commit` hanya uji coba (dibatalkan), dan satu baris gagal membatalkan semuanya. Hanya atas
  nama owner. Idempoten: pasien bernama sama dan sesi yang sama (pasien, terapis, layanan,
  tanggal) tidak dibuat ganda bila diulang.
- Sesi impor bertagihan **tanpa biaya** (sisa paket per hari ini dicatat terpisah sebagai paket
  lama), terapis tertaut ke pasien, honor per sesi dihitung seperti absen biasa, dan catatan sesi
  final ditulis **atas nama terapis** (terlihat orang tua sesuai K8). Audit log bertanda
  `lewat: impor_rekap`. File masukan berisi data nyata dan tidak disimpan di repositori.

**Bukti:** 4 test baru (`impor-rekap.test.ts`): uji coba tidak menyimpan; hasil simpan (pasien,
sesi tanpa biaya, paket tidak terpotong, tidak jadi tagihan, catatan penulis terapis, honor,
tunjangan harian, audit); impor ulang tidak menggandakan; bukan owner ditolak dan kesalahan satu
baris membatalkan semuanya. Total 234 lulus.

## 29. Jadwal tanpa terapis terlihat terapis, dan sisa tagihan di jadwal (8 Nov 2026)

**Laporan pengguna:** terapis tidak melihat jadwal besok yang sudah dibuat admin. Penyebabnya, jadwal
dibuat dengan terapis "Ditentukan saat absen" (§24), sedangkan terapis hanya melihat jadwal atas
namanya. **Keputusan owner:** jadwal tanpa terapis ikut tampil di jadwal semua terapis dengan tanda
*Belum ada terapis*. Untuk pasien yang belum bayar: jadwal tetap boleh dibuat; tagihannya terlihat.

- `GET /appointments` dan dasbor: terapis juga menerima jadwal **terjadwal tanpa terapis** lewat
  fungsi `app_open_appointments` yang sudah dipakai Absen (identitas ringkas: nama, No. RM, layanan,
  waktu; tanpa tagihan, harga, atau catatan admin). Profil pasien tetap tertutup sampai terapis
  mengabsen anak itu. Tidak ada migrasi.
- Baris jadwal bertanda **Belum ada terapis**; tombol *Absen* hanya untuk hari ini/sebelumnya dan
  membuka halaman Absen pada tanggal jadwal.
- **Sisa tagihan** (`outstanding`) dihitung hanya bagi yang berizin melihat pembayaran (owner,
  keuangan, admin dengan akses keuangan): per sesi = tarif sesi dikurangi yang sudah dibayar;
  paket = sisa harga paketnya. Yang sudah masuk invoice, tanpa biaya, batal, atau dipindah tidak
  ditandai. Baris bertanda *Belum dibayar Rp…* / *Paket belum lunas, kurang Rp…* dengan tombol
  **Catat bayar** (formulir pembayaran terisi pasien, tujuan, dan nominal).
- *Buat jadwal*: setelah pasien dipilih, tagihan otomatis **Paket** bila anak punya paket aktif
  (terpilih langsung bila hanya satu), selain itu **Per sesi**.

**Bukti:** 5 test baru (`jadwal-terapis-tagihan.test.ts`), total 239 lulus. Uji mutasi: tanpa
penggabungan jadwal terbuka, atau sisa tagihan dihitung tanpa izin pembayaran, masing-masing
menggagalkan test. Diperiksa di browser (lebar desktop dan 390 px): terapis melihat jadwal besok
tanpa terapis; owner melihat tanda belum dibayar, *Catat bayar* menghapus tandanya; Buat jadwal
memilih paket otomatis.

## 30. Login tidak keluar otomatis (8 Nov 2026)

**Keluhan:** pengguna sering harus login ulang. Catatan sesi 7 hari menunjukkan penyebabnya: batas
idle 12 jam (membuka aplikasi keesokan hari), komputer Windows dipakai bergantian (keluar-masuk akun),
dan login terpisah per perangkat. **Keputusan owner:** pengguna tidak keluar sama sekali kecuali
menekan Keluar.

- Bawaan baru: `SESSION_IDLE_MINUTES=0` (tanpa batas idle) dan `SESSION_MAX_DAYS=400`. Masa berlaku
  sesi dan cookie **diperpanjang otomatis** paling sering sekali sehari setiap kali sesi dipakai,
  sehingga hanya sesi yang tidak dipakai 400 hari yang berakhir (400 hari = batas umur cookie Chrome).
- Sesi tetap berakhir bila: pengguna menekan **Keluar** atau **Keluar dari semua perangkat**, kata
  sandi diganti/direset (sesi lain ditutup), atau akun dinonaktifkan. Batas idle dapat diaktifkan
  lagi lewat `SESSION_IDLE_MINUTES` tanpa ubah kode.
- Sesi lama yang belum dicabut dan belum lewat 14 hari menjadi berlaku lagi dan ikut diperpanjang.
- Risiko diterima owner: di komputer bersama, browser tetap masuk sebagai akun terakhir. Saran:
  profil Chrome terpisah per orang.

**Bukti:** 4 test baru (`sesi-login.test.ts`): diam 30 hari tetap masuk dan diperpanjang 400 hari
(cookie ikut diperbarui, sekali sehari); Keluar tetap menang walau perpanjangan jatuh pada permintaan
yang sama; sesi kedaluwarsa ditolak; batas idle tetap berfungsi bila diatur. Total 243 lulus. Uji
mutasi: tanpa perpanjangan sesi, atau tanpa pembaruan cookie, masing-masing menggagalkan test.

## 31. Jam dasbor akurat dan muat ulang otomatis (8 Nov 2026)

**Permintaan owner:** dasbor diperbarui otomatis agar jam akurat.

- Penanda jam di papan waktu dasbor berganti tepat saat menit berganti (sebelumnya selang 60 detik
  sejak halaman dibuka, bisa tertinggal hampir semenit) dan langsung diperbarui saat halaman
  terlihat lagi (layar HP dinyalakan, kembali dari aplikasi/tab lain), karena browser menahan timer
  selama halaman di belakang.
- Dasbor dan halaman Jadwal memuat ulang datanya tiap menit selama halaman terlihat dan segera saat
  halaman dibuka lagi (`useAutoRefresh`), tanpa layar berkedip; bila pemuatan ulang gagal sesaat,
  data terakhir tetap tampil.

**Bukti:** diperiksa di browser dengan jam simulasi: 10:00:30 → 10:01 tepat di pergantian menit;
data dasbor dan jadwal dimuat ulang tiap 60 detik tanpa menghilangkan tampilan; setelah "layar mati"
25 menit, jam langsung 10:27 saat halaman terlihat lagi. Tidak ada perubahan server; 243 test lulus.
