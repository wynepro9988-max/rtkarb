# Deployment (staging & produksi) — varian VPS

> Rencana utama pemilik proyek adalah **Git + Vercel + Supabase**: lihat
> [07-supabase-vercel.md](07-supabase-vercel.md). Dokumen ini untuk varian VPS.

> **Belum ada server staging maupun produksi.** Dokumen ini adalah prosedur yang
> disiapkan, bukan laporan deployment. Ikuti urutannya untuk staging dulu.

## 1. Kebutuhan server

- Linux (mis. Ubuntu 24.04), 2 vCPU, 2–4 GB RAM. Cukup untuk dua organisasi kecil.
- Node.js 24 LTS, PostgreSQL 16+ (disarankan 18), Caddy atau Nginx untuk HTTPS.
- Domain, mis. `app.<domain-rtka>.id`, dengan sertifikat TLS (Caddy mengurus otomatis).
- Disk server terenkripsi, bila penyedia mendukung.

## 2. Database

Jalankan sebagai superuser PostgreSQL, sekali saja:

```sql
CREATE ROLE rtka_owner LOGIN PASSWORD '<acak-panjang>';
CREATE ROLE rtka_app   LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '<acak-panjang>';
CREATE DATABASE rtka OWNER rtka_owner;
REVOKE ALL ON DATABASE rtka FROM PUBLIC;
GRANT CONNECT ON DATABASE rtka TO rtka_app;
```

Pengaturan `postgresql.conf` yang disarankan: `log_error_verbosity = terse` (DETAIL berisi
nilai data tidak ikut tercatat) dan `ssl = on` bila database berada di host lain.

## 3. Aplikasi

```bash
git clone <repo> /opt/rtka && cd /opt/rtka
npm ci
npm run build                       # web/dist
cp .env.example .env && chmod 600 .env   # isi nilai produksi
npm run db:migrate                  # memakai DATABASE_ADMIN_URL (rtka_owner)
```

Nilai wajib di `.env` produksi:

- `NODE_ENV=production`
- `COOKIE_SECURE=true`
- `TRUST_PROXY=true`
- `APP_ORIGINS=https://app…`
- `PUBLIC_BASE_URL=https://app…`
- `DATABASE_URL` (rtka_app)
- `DATABASE_ADMIN_URL` (rtka_owner)
- `UPLOAD_DIR=/var/lib/rtka/uploads` (`chmod 700`, dimiliki user service)

Server menolak start bila `COOKIE_SECURE` mati, bila `PUBLIC_BASE_URL` bukan https,
atau bila `DATABASE_URL` memakai role yang dapat melewati RLS.

### systemd

```ini
# /etc/systemd/system/rtka.service
[Unit]
Description=RTKA Rumah Bintang
After=network.target postgresql.service

[Service]
User=rtka
WorkingDirectory=/opt/rtka
ExecStart=/usr/bin/node --env-file=/opt/rtka/.env server/src/index.ts
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/rtka
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

### Caddy

```
app.<domain-rtka>.id {
    encode gzip
    reverse_proxy 127.0.0.1:3000
    request_body {
        max_size 6MB
    }
}
```

## 4. Membuat dua tenant & owner

```bash
npm run admin -- create-org --name "<Nama resmi organisasi A>" --patient-prefix RBA
npm run admin -- invite-owner --org <ID-A> --phone <whatsapp-owner-A> --name "<Nama owner A>"
npm run admin -- create-org --name "<Nama resmi organisasi B>" --patient-prefix RBB
npm run admin -- invite-owner --org <ID-B> --phone <whatsapp-owner-B> --name "<Nama owner B>"
npm run admin -- list-orgs   # catat kedua ID permanen
```

Tautan aktivasi dikirim langsung ke masing-masing owner melalui kanal pribadi.
Bila diperlukan admin teknis:

```bash
npm run admin -- create-platform-admin --email <email> --name "<nama>"
```

## 5. Android

```bash
cd android
./gradlew assembleRelease -Prtka.releaseUrl=https://app.<domain-rtka>.id
```

- Penandatanganan memakai `android/keystore.properties` (tidak di-commit), dengan
  kunci `storeFile`, `storePassword`, `keyAlias`, dan `keyPassword`. **Simpan keystore
  dengan aman.** Bila hilang, pembaruan aplikasi tidak dapat diterbitkan.
- Ikon launcher sudah memakai logo resmi. Bila logo diperbarui, ikuti `brand/README.md`.
- Uji di emulator (build debug): jalankan server lokal, tambahkan `http://10.0.2.2:3000`
  ke `APP_ORIGINS`, lalu `./gradlew installDebug`.

## 6. Checklist go-live

- [ ] Staging berjalan dengan konfigurasi identik produksi (HTTPS, role DB, `.env`).
- [ ] `npm test` lulus di server staging (butuh `TEST_DATABASE_*` terpisah, `*_test`).
- [ ] Backup terenkripsi berjalan terjadwal **dan** `backup:verify` berhasil di staging.
- [x] Logo resmi terpasang (29 Okt 2026). File resolusi tinggi untuk cetak masih diminta.
- [ ] Keputusan terbuka yang berdampak finansial/klinis sudah diputuskan ([06](06-keputusan-terbuka.md)).
- [ ] UAT owner A dan owner B selesai, dengan data DEMO di staging, bukan data nyata.
- [ ] Uji akses silang manual: owner/terapis A mencoba membuka URL objek B → 404.
- [ ] Penanggung jawab rollback ditetapkan, dan prosedur rollback diuji di staging.
- [ ] Pemantauan aktif: uptime `/api/health`, log error, kegagalan login, dan ruang disk.
- [ ] Persetujuan go-live tertulis dari kedua owner.
- [ ] Data DEMO **tidak** ada di database produksi (`seed:demo` menolak database selain `*_dev`).

## 7. Pemantauan pascarilis

Pantau tanpa memasukkan isi klinis ke log:

- Log server: `status >= 500`, `database menolak permintaan`, dan `rate_limited`.
- `audit_logs`: `auth.login_gagal` berulang, `dukungan.*`, `laporan.diekspor`,
  `pembayaran.dibatalkan`.
- Integritas berkala, misalnya `sessions_used` paket dibandingkan dengan jumlah ledger.
- Waktu respons dan ruang disk (`UPLOAD_DIR`, database, backup).
