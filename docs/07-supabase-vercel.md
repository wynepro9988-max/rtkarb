# Deployment: Git + Vercel + Supabase

Target deployment yang direncanakan pemilik proyek: kode di **Git**, aplikasi di
**Vercel**, database & berkas di **Supabase (paket Free)**. Dokumen ini berisi batas
resmi kedua layanan (dibaca dari situs resminya pada 29 Okt 2026), cara aplikasi dijaga
agar tidak melewatinya, dan langkah setup.

> **Status:** belum di-deploy. Bundle Vercel sudah dibuat dan dijalankan secara lokal
> terhadap PostgreSQL lokal. Koneksi ke Supabase sungguhan dan deployment Vercel belum
> diuji.

## 1. Hal penting sebelum mulai

| # | Temuan | Dampak |
|---|---|---|
| 1 | Vercel: *"Hobby teams are restricted to non-commercial personal use only. All commercial usage of the platform requires either a Pro or Enterprise plan."* ([fair-use-guidelines](https://vercel.com/docs/limits/fair-use-guidelines)) | Aplikasi operasional rumah terapi termasuk penggunaan komersial, jadi **perlu Vercel Pro** (mulai USD 20/bulan). Keputusan ada di pemilik |
| 2 | Supabase Free: *"Automatic backups: Not included"*. Supabase menyarankan proyek Free *"regularly export their data … and maintain off-site backups"* ([backups](https://supabase.com/docs/guides/platform/backups)) | Backup **wajib** dijalankan sendiri secara terjadwal (§6) |
| 3 | Supabase Free: *"Free projects are paused after 1 week of inactivity"* ([pricing](https://supabase.com/pricing)) | Libur panjang (mis. Lebaran) bisa membuat aplikasi berhenti sampai proyek diaktifkan ulang dari dashboard |
| 4 | Koneksi langsung (direct) Supabase Free hanya IPv6. Pooler bersama berjalan di IPv4 ([connecting](https://supabase.com/docs/guides/database/connecting-to-postgres)) | Vercel memakai **transaction pooler** (port 6543); migrasi/backup memakai **session pooler** (port 5432) |
| 5 | Body request/response Vercel Function maksimal **4,5 MB** ([limitations](https://vercel.com/docs/functions/limitations)) | Batas unggah diturunkan menjadi **4 MB** |
| 6 | Data API Supabase otomatis mengekspos schema `public` ([securing your API](https://supabase.com/docs/guides/api/securing-your-api)) | Migrasi `004` mencabut semua hak `anon`/`authenticated`/`service_role`. **Matikan juga Data API** di dashboard (§5 langkah 5) |
| 7 | Tidak ada region Supabase/Vercel di Indonesia; yang terdekat Singapura | Data pasien akan tersimpan di luar negeri. Perlu dinilai terhadap UU PDP (lihat keputusan terbuka) |

## 2. Batas paket Free & cara aplikasi menjaganya

| Batas (sumber) | Nilai | Pengaman di aplikasi |
|---|---|---|
| Ukuran database (pricing) | 500 MB | Revisi catatan hanya menyimpan versi **lama** (versi terkini tidak digandakan). User-agent hanya disimpan untuk kejadian keamanan. Audit lama dapat diarsipkan (`admin archive-audit`). Pemantauan `admin db-usage` dan panel Kapasitas di halaman admin teknis, dengan peringatan di atas 80% |
| Penyimpanan berkas (pricing) | 1 GB | Kuota per organisasi `ORG_STORAGE_QUOTA_MB=450` (2 × 450 MB = 900 MB). Unggahan yang melewati kuota ditolak (413) tanpa meninggalkan berkas yatim. Pemakaian tampil di Pengaturan organisasi |
| Ukuran unggah (pricing) | 50 MB | Dibatasi 4 MB (lebih ketat, karena batas Vercel) |
| Egress (pricing) | 5 GB + 5 GB cached / bulan | Daftar dibatasi maksimal 100–200 baris per permintaan. Laporan dihitung di database (yang dikirim hanya ringkasan). Unduhan dokumen hanya atas tindakan pengguna |
| Koneksi Nano (compute) | 60 direct / 200 pooler | `DB_POOL_MAX=3` per instance Vercel, idle timeout 10 detik, lewat transaction pooler |
| Proyek aktif (pricing) | 2 | Cukup satu proyek: kedua organisasi berbagi satu database dan terisolasi dengan RLS |
| Vercel Function: body, durasi, bundle | 4,5 MB; 300 s (Hobby); 250 MB | Unggah ≤ 4 MB, ekspor XLSX berukuran KB, `maxDuration` 30 s, bundle ±3 MB |

### Perkiraan pertumbuhan database (asumsi, bukan pengukuran)

Asumsinya:

- 2 organisasi, masing-masing ±25 sesi/hari, 26 hari kerja per bulan, sehingga **±1.300 sesi per bulan**.
- Catatan sesi rata-rata ±1,5 KB teks.
- ±30% catatan dikoreksi sekali.

| Komponen per sesi | Perkiraan |
|---|---|
| Jadwal + indeks | ±0,4 KB |
| Catatan terapi (+ revisi bila dikoreksi) | ±2,3 KB |
| Audit log (±7 kejadian: buat, selesai, catatan, lihat) | ±1,8 KB |
| Ledger paket, kompensasi, porsi pembayaran | ±0,6 KB |
| **Total** | **±5 KB per sesi → ±6,5 MB/bulan → ±80 MB/tahun** |

Dengan dasar database ±10–40 MB (bergantung pada schema bawaan Supabase), batas 500 MB
diperkirakan tercapai setelah **±5 tahun**. Bila audit lebih dari 12 bulan diarsipkan
rutin, batas itu tercapai jauh lebih lama. Angka ini **wajib dipantau dengan pengukuran
nyata** (`npm run admin -- db-usage`) setiap bulan, karena kebiasaan pemakaian bisa berbeda.

**Berkas** adalah batas yang paling cepat tercapai. Contohnya, 150 pasien per organisasi
× 3 dokumen × 1 MB = 450 MB, yang sudah sama dengan kuota per organisasi. Simpan hasil
pindai sebagai PDF terkompresi (±200–500 KB), bukan foto beresolusi penuh.

## 3. Arsitektur di Vercel

```
Git push ──▶ Vercel: npm ci → npm run build:vercel
             .vercel/output/static/              web (Vite) + header keamanan (CSP, HSTS, …)
             .vercel/output/functions/api.func/  satu Function Node 22: Fastify (bundle esbuild)
             .vercel/output/config.json          routing: berkas statis → /api/* → SPA
                         │
                         ├── Postgres  ─ Supabase transaction pooler :6543 (role rtka_app, TLS + CA)
                         └── Berkas    ─ Supabase Storage REST (bucket privat, secret key di server)
```

- `scripts/build-vercel.mjs` memakai [Build Output API v3](https://vercel.com/docs/build-output-api).
- Semua logika otorisasi tetap di server. RLS tetap berlaku karena aplikasi terhubung
  sebagai `rtka_app`.
- Sesi disimpan di database, sehingga aman untuk banyak instance serverless.
- **Keterbatasan:** rate limit per IP berjalan per instance (memori). Penguncian akun
  setelah 5 kali gagal tetap di database sehingga berlaku global.

## 4. Variabel lingkungan

Isi di Vercel → Project → Settings → Environment Variables (Production):

| Variabel | Nilai |
|---|---|
| `NODE_ENV` | `production` |
| `APP_ORIGINS`, `PUBLIC_BASE_URL` | `https://<domain-anda>` (plus `https://<proyek>.vercel.app` bila dipakai) |
| `COOKIE_SECURE`, `TRUST_PROXY` | `true` |
| `DATABASE_URL` | Transaction pooler (6543), user `rtka_app.<project-ref>` |
| `DB_POOL_MAX` | `3` |
| `DB_SSL_CA` | Isi sertifikat CA Supabase (PEM) |
| `STORAGE_DRIVER` | `supabase` |
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `SUPABASE_SECRET_KEY` | Secret key (`sb_secret_…`). **Jangan** pernah dipakai di browser |
| `SUPABASE_STORAGE_BUCKET` | `dokumen-pasien` |
| `MAX_UPLOAD_MB`, `ORG_STORAGE_QUOTA_MB` | `4`, `450` |
| `APP_ENCRYPTION_KEY` | Opsional (WhatsApp otomatis). `openssl rand -base64 32`. **Jangan diganti** setelah dipakai |
| `CRON_SECRET` | Opsional (WhatsApp otomatis). `openssl rand -hex 32` |
| `CRON_SCHEDULE` | Opsional. Paket Pro: `*/10 * * * *`. Paket Hobby: kosongkan (lihat §9) |

`DATABASE_ADMIN_URL` (rtka_owner) **tidak** diisi di Vercel. Variabel ini hanya ada di
komputer operator, untuk migrasi, CLI, dan backup.

## 5. Langkah setup

1. **Supabase:** buat proyek di region **Southeast Asia (Singapore)** dan simpan
   password `postgres`.
2. **Role database.** Jalankan di SQL Editor sebagai `postgres`, dengan password acak yang panjang:
   ```sql
   CREATE ROLE rtka_owner LOGIN PASSWORD '<acak>';
   CREATE ROLE rtka_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '<acak>';
   GRANT USAGE, CREATE ON SCHEMA public TO rtka_owner;
   ```
3. **Sertifikat:** Dashboard → Database → SSL Configuration → *Download certificate*.
   Simpan sebagai `DB_SSL_CA_FILE` (komputer operator) dan `DB_SSL_CA` (Vercel).
4. **Migrasi** dari komputer operator (session pooler):
   ```bash
   DATABASE_ADMIN_URL=postgres://rtka_owner.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres \
   DB_SSL_CA_FILE=./prod-ca-2021.crt npm run db:migrate
   ```
5. **Matikan Data API:** Dashboard → Integrations → Data API → *Enable Data API* = off.
   Aplikasi tidak memakainya, dan migrasi `004` sudah mencabut hak role-nya sebagai
   lapis kedua.
6. **Storage:** buat bucket **privat** `dokumen-pasien` (*Public bucket* = off) dengan
   *file size limit* 4 MB, lalu buat **secret key** (Settings → API Keys).
7. **Tenant & owner:** jalankan `npm run admin -- create-org …` dan `invite-owner …` dari
   komputer operator dengan `DATABASE_ADMIN_URL` Supabase (lihat
   [05-deployment](05-deployment.md) §4). Tautan aktivasi memakai `PUBLIC_BASE_URL`.
8. **Git:** push repository (`.env`, `.data/`, `backups/`, dan `.vercel/` sudah di-ignore).
9. **Vercel:** import repository. `vercel.json` sudah menetapkan `buildCommand` dan
   `installCommand`. Atur Node.js 22.x atau 24.x, region Functions **Singapore (sin1)**,
   lalu isi variabel §4 dan deploy.
10. **Verifikasi pertama** (wajib, karena pola ini belum pernah diuji di Vercel sungguhan):
    - `GET /api/health?db=1` → `{"ok":true}`.
    - Halaman masuk tampil dengan logo.
    - Login, unggah satu dokumen DEMO, lalu unduh kembali.
    - Header CSP ada pada `/` (DevTools → Network).
    - `/assets/tidak-ada.js` → 404.

## 6. Backup (wajib di paket Free)

Dari komputer operator, minimal **mingguan** dan sebelum setiap migrasi:

```bash
export DATABASE_ADMIN_URL='postgres://rtka_owner.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=verify-full&sslrootcert=./prod-ca-2021.crt'
export DB_SSL_CA_FILE=./prod-ca-2021.crt STORAGE_DRIVER=supabase SUPABASE_URL=… SUPABASE_SECRET_KEY=…
BACKUP_PASSPHRASE_FILE=~/.rtka-backup-pass npm run backup
# Verifikasi dengan memulihkan ke PostgreSQL lokal (bukan ke Supabase):
RESTORE_ADMIN_URL=<rtka_owner URL cluster lokal> BACKUP_PASSPHRASE_FILE=~/.rtka-backup-pass npm run backup:verify -- backups/<waktu>
```

- Backup hanya berisi schema aplikasi (`public`) ditambah semua berkas dari Supabase Storage.
- Simpan **terenkripsi** di dua lokasi (mis. komputer operator + drive eksternal).
- Jangan simpan backup di repository Git atau artifact CI.

## 7. Pemeliharaan kapasitas (bulanan)

```bash
npm run admin -- db-usage                       # ukuran DB, tabel terbesar, berkas per organisasi
npm run admin -- archive-audit --before 2026-01-01 --out arsip-audit-2025.jsonl.gz   # opsional, sesuai kebijakan retensi
```

Perintah `archive-audit` mengekspor audit sebelum tanggal tersebut ke berkas, baru
kemudian menghapusnya. Simpan berkas arsip terenkripsi bersama backup. Gunakan perintah
ini hanya sesuai kebijakan retensi yang disetujui owner.

## 8. Kapan perlu naik paket

Pertimbangkan **Supabase Pro** bila salah satu ini terjadi:

- Pemakaian database atau berkas di atas 80%.
- Libur panjang membuat proyek berisiko dijeda.
- Owner menginginkan backup otomatis harian dan PITR, yang **tidak** tersedia di Free.

Untuk data klinis anak, backup otomatis adalah alasan kuat untuk naik ke Pro sejak go-live.

## 9. Pengingat WhatsApp otomatis (Fonnte)

**Cara kerja:**

- Setiap organisasi menghubungkan nomor WhatsApp dan token Fonnte-nya sendiri di
  **Pengaturan → WhatsApp otomatis** (hanya owner).
- Owner juga menetapkan kebijakan **berapa jam sebelum sesi pertama** pengingat dikirim
  (0,5–48 jam; bawaan 3 jam).
- **Satu pesan per anak per hari** (keputusan 29 Okt 2026). Pesannya memuat semua jam sesi
  anak hari itu, misalnya "pukul 09:00 dan 14:00", dan dikirim N jam sebelum sesi pertama
  yang belum diingatkan. Sesi yang ditambahkan setelah pesan terkirim diingatkan dengan pesan
  tersendiri saat jatuh tempo.
- Penjadwal memanggil `GET /api/cron/reminders` (dengan `Authorization: Bearer <CRON_SECRET>`)
  setiap ±10 menit. Setiap panggilan mengirim pengingat yang sudah jatuh tempo; tiap sesi
  hanya diingatkan sekali.
- Waktu kirim sebenarnya = waktu kebijakan + paling lambat satu putaran penjadwal.

**Menjalankan penjadwal:**

| Paket Vercel | Cara |
|---|---|
| Pro | Isi `CRON_SCHEDULE=*/10 * * * *` sebelum build. Vercel Cron memanggil endpoint dan mengirim `CRON_SECRET` otomatis. Periksa di Project → Settings → Cron Jobs |
| Hobby | Cron Vercel hanya sekali sehari (deploy **gagal** bila lebih sering), jadi kosongkan `CRON_SCHEDULE`. Pakai penjadwal eksternal yang memanggil URL di atas tiap 10 menit dengan header `Authorization: Bearer <CRON_SECRET>`. Ingat: Hobby hanya untuk penggunaan non-komersial |
| Server sendiri | `crontab`: `*/10 * * * * curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/cron/reminders` |

Fakta dari dokumentasi Vercel (dicek 29 Okt 2026): Hobby minimal sekali sehari dengan
ketelitian ±59 menit; Pro minimal per menit.

**Fakta Fonnte** (dari docs.fonnte.com, dicek 29 Okt 2026):

- Nomor ditautkan dengan memindai QR (seperti WhatsApp Web), **bukan** API resmi WhatsApp
  Business.
- Kuota gratis 1.000 pesan/bulan per perangkat disebut "untuk pengembangan".
- Satu pesan memakai satu kuota.
- Harga paket berbayar belum dicek, jadi cek di fonnte.com.

**Risiko & mitigasi:**

- Nomor bisa diblokir WhatsApp. Pakai nomor khusus pusat terapi, kirim hanya ke wali yang
  terdaftar, dan beri jarak antarpesan (`WA_SEND_GAP_SECONDS`, default 10 detik, diatur
  lewat parameter `schedule` Fonnte).
- Data (nama panggilan anak, nama & nomor wali, tanggal & jam) melewati pihak ketiga.
  Pesan tidak memuat jenis terapi. Wali dapat ditandai menolak.
- Bila Fonnte tidak menjawab, statusnya dicatat *tidak pasti* dan **tidak** dikirim ulang
  otomatis, agar wali tidak menerima pesan ganda.
- Token disimpan terenkripsi AES-256-GCM, terikat ke ID organisasi, dan tidak pernah
  ditampilkan atau dicatat di log.

