# Rumah Bintang — Pusat Kemandirian dan Tumbuh Kembang Anak

Sistem manajemen Rumah Bintang untuk dua organisasi dengan
owner berbeda. Kedua organisasi memakai satu aplikasi, tetapi datanya terpisah.
Pemisahan dijalankan di server dan di database (PostgreSQL Row-Level Security),
bukan hanya di tampilan.

- **Web** responsif: React + Vite (`web/`)
- **API**: Node.js 24 + Fastify + PostgreSQL 16+ (`server/`)
- **Android**: aplikasi native Android (Java, tanpa dependensi pihak ketiga) yang memuat aplikasi web dengan aman (`android/`)
- **Dokumentasi**: `docs/`

> **Status:** sudah dikembangkan dan diuji di lingkungan lokal. Belum ada staging,
> produksi, maupun UAT. Lihat [docs/00-laporan-implementasi.md](docs/00-laporan-implementasi.md).

## Menjalankan di komputer lokal

Prasyarat: Node.js 24+ dan PostgreSQL 16+ (binary `initdb`, `pg_ctl`, `psql`).

```bash
npm install
npm run db:init        # cluster PostgreSQL khusus proyek (port 54330), role rtka_owner + rtka_app, menulis .env
npm run db:migrate     # menerapkan server/migrations/*.sql
npm run seed:demo      # opsional: dua organisasi DEMO berisi data sintetis
npm test               # 135 test (database uji dibuat ulang setiap kali)

npm run dev:server     # API di http://127.0.0.1:3000
npm run dev:web        # UI di http://localhost:5173 (proxy /api ke :3000)
```

Ada dua cara deployment:

- **Vercel + Supabase** (rencana utama): `npm run build:vercel` menghasilkan `.vercel/output`.
  Lihat [docs/07-supabase-vercel.md](docs/07-supabase-vercel.md), termasuk batas paket
  Free dan cara aplikasi menjaganya.
- **VPS:** `npm run build` lalu `npm start`. Lihat [docs/05-deployment.md](docs/05-deployment.md).

## Menyiapkan dua organisasi

Gunakan CLI administrasi, bukan antarmuka web:

```bash
npm run admin -- create-org --name "RTKA Rumah Bintang <Nama A>" --patient-prefix RBA
npm run admin -- invite-owner --org <id-org-A> --email owner-a@... --name "Nama Owner A"
npm run admin -- create-org --name "RTKA Rumah Bintang <Nama B>" --patient-prefix RBB
npm run admin -- invite-owner --org <id-org-B> --email owner-b@... --name "Nama Owner B"
```

Setiap owner menerima tautan aktivasi sekali pakai dan mengatur kata sandinya
sendiri. Setelah itu owner mengundang stafnya dari menu **Staf**.

## Struktur

```
server/migrations/   Skema SQL, kebijakan RLS, dan hak akses role (migrasi berurutan + checksum)
server/src/          API: authz/ (sesi, permission, konteks tenant), routes/, security/
server/scripts/      migrate, admin (CLI platform), seed-demo
server/test/         Test integrasi terhadap PostgreSQL sungguhan
web/src/             UI React (pages/, ui.tsx, api.ts, auth.tsx)
android/             Aplikasi Android (WebView aman)
brand/               SATU sumber logo resmi untuk web & Android
scripts/             db-local, backup, verify-restore, build-android-icons
docs/                Audit, desain teknis, keamanan, backup/rollback, deployment, keputusan terbuka
```

## Dokumentasi

| Dokumen | Isi |
|---|---|
| [00-laporan-implementasi](docs/00-laporan-implementasi.md) | Laporan tahap: yang dikerjakan, bukti test, risiko |
| [01-audit-fase0](docs/01-audit-fase0.md) | Hasil audit Fase 0 |
| [02-desain-teknis](docs/02-desain-teknis.md) | Arsitektur, skema, RLS, matriks permission, API |
| [03-keamanan](docs/03-keamanan.md) | Kontrol keamanan data klinis anak, termasuk Android |
| [04-backup-rollback](docs/04-backup-rollback.md) | Prosedur backup, uji pemulihan, rollback, insiden |
| [05-deployment](docs/05-deployment.md) | Langkah staging/produksi dan checklist go-live |
| [06-keputusan-terbuka](docs/06-keputusan-terbuka.md) | Kebijakan yang masih menunggu keputusan owner |
| [07-supabase-vercel](docs/07-supabase-vercel.md) | Deployment Git + Vercel + Supabase, batas paket Free, kapasitas, backup |
