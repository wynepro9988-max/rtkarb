# Desain teknis

## 1. Arsitektur

```
 Browser / Android WebView ──HTTPS──▶ reverse proxy (Caddy/Nginx, TLS)
                                          │
                                          ▼
                         Node.js 24 + Fastify  (satu origin: /api + web/dist)
                         ├─ sesi cookie httpOnly + token CSRF per sesi
                         ├─ otorisasi terpusat (authz/context.ts + permissions.ts)
                         └─ setiap query di dalam transaksi berkonteks tenant
                                          │  role DB: rtka_app (tanpa BYPASSRLS, bukan owner tabel)
                                          ▼
                         PostgreSQL 16+  ── Row-Level Security + FK komposit + hak kolom
```

| Keputusan | Alasan |
|---|---|
| PostgreSQL + RLS | Isolasi tenant di lapisan database. Bug pada satu endpoint tidak membuka data organisasi lain |
| Satu database, `organization_id` di semua tabel bisnis | Cukup untuk dua tenant. Backup dan operasional sederhana |
| Fastify + SQL eksplisit (`pg`), tanpa ORM | Setiap query terlihat jelas dan mudah diaudit. Pengaturan konteks RLS per transaksi juga lebih mudah dikendalikan |
| Sesi cookie (bukan JWT) | Pencabutan sesi berlaku seketika saat staf dinonaktifkan atau akses dukungan dicabut |
| Android = WebView native (Java, tanpa library pihak ketiga) | Satu sumber logika bisnis. Pengamanan perangkat (FLAG_SECURE, tanpa backup) dikendalikan di sisi aplikasi. Awalnya ditulis dalam Kotlin, tetapi build plugin Kotlin macet berulang di mesin ini, sehingga ~200 baris kode dipindah ke Java: build lebih sederhana dan APK hanya 111 KB |
| TypeScript dijalankan langsung oleh Node 24 | Tidak perlu tahap build untuk server |

### Varian deployment

| Varian | Web | API | Database | Berkas |
|---|---|---|---|---|
| VPS ([05](05-deployment.md)) | Disajikan Fastify | `node server/src/index.ts` | PostgreSQL | Disk lokal (`STORAGE_DRIVER=local`) |
| Vercel + Supabase ([07](07-supabase-vercel.md)) | CDN Vercel (`.vercel/output/static`) | Satu Vercel Function (bundle esbuild dari `server/src/vercel.ts`) | Supabase Postgres lewat transaction pooler | Supabase Storage, bucket privat (`STORAGE_DRIVER=supabase`) |

Kode otorisasi, RLS, dan skema sama persis di kedua varian.

## 2. Model tenant & identitas

- `organizations`: ID UUID permanen yang dibuat sekali melalui CLI. Nama bukan kunci.
- `users`: identitas global. Login memakai **username** (unik lintas organisasi, huruf kecil). Email
  boleh kosong dan hanya dipakai akun lama; setiap akun wajib punya salah satunya.
- `memberships`: menghubungkan `user`, `organization`, `role`, dan `status`.
  **Satu pengguna hanya pada satu organisasi** (constraint `UNIQUE (user_id)`), sesuai
  ruang lingkup awal: tidak ada pemindahan terapis lintas organisasi.
- Organisasi aktif **ditentukan server** dari sesi dan keanggotaan. Klien tidak pernah
  mengirim `organization_id`. Jika klien mengirimnya, nilai itu diabaikan (ada testnya).
- Admin teknis platform (`users.platform_role = 'platform_admin'`) **tidak memiliki
  keanggotaan**, sehingga tidak dapat mengakses data tenant tanpa *support grant*.

## 3. Alur setiap permintaan

1. `preHandler` membaca cookie `rb_sid`, lalu mencari hash token di `sessions`
   (cek kedaluwarsa dan idle timeout).
2. Server memuat `users`. Akun nonaktif membuat sesi dicabut.
3. Mode `tenant`: server memuat keanggotaan **aktif** pada organisasi sesi yang
   berstatus aktif. Jika tidak ada, sesi dicabut dan respons 401.
   Mode `support`: server memuat grant yang disetujui, belum dicabut, dan dalam
   rentang waktunya.
4. Permission diturunkan dari role (atau dari cakupan grant).
5. Route memanggil `needTenant(req, ...permission)`. Tanpa permission yang sesuai,
   respons 403.
6. `tenantTx()` menjalankan `BEGIN` (atau `BEGIN READ ONLY` untuk mode dukungan) dan
   `set_config('app.org_id' …, true)` beserta cakupan data. Semua pengaturan bersifat
   lokal terhadap transaksi, sehingga tidak bocor ke permintaan lain di pool.
7. Query **tetap** menyertakan `WHERE organization_id = $1`, dan RLS menjadi lapisan
   kedua.
8. Tindakan sensitif dicatat ke `audit_logs` dalam transaksi yang sama.

Respons untuk objek milik tenant lain adalah **404**, identik dengan objek yang memang
tidak ada. ID yang formatnya tidak valid juga dijawab 404.

## 4. Skema (ringkas)

Semua tabel bisnis memiliki `organization_id`. Relasi memakai **foreign key komposit**,
misalnya `(organization_id, patient_id) → patients(organization_id, id)`, sehingga
database menolak relasi lintas tenant walaupun kode aplikasi keliru.

| Domain | Tabel |
|---|---|
| Identitas & akses | `organizations`, `users`, `memberships`, `sessions`, `account_tokens` (undangan/reset, hanya hash), `support_access_grants` |
| Pasien | `patients` (kode unik per organisasi), `guardians`, `patient_therapists` (penugasan = dasar akses terapis), `patient_documents` |
| Layanan & paket | `therapy_services`, `package_types`, `patient_packages` (CHECK `0 ≤ sessions_used ≤ sessions_total`), `package_ledger` (append-only) |
| Jadwal & klinis | `appointments`, `therapy_notes` (satu per sesi), `therapy_note_revisions` (append-only, snapshot penuh setiap simpan) |
| Keuangan | `payments` (nomor kuitansi unik per organisasi; nominal tidak dapat diubah), `expenses`, `compensation_rules`, `therapist_compensations` |
| Program terapi | `therapy_programs`, `program_goals`, `goal_progress` (append-only); akses = akses catatan klinis |
| Penagihan | `invoices`, `invoice_items` (satu paket/sesi per invoice aktif), `refunds` (≤ nominal pembayaran, trigger), `reconciliations` (final terkunci); `payments.invoice_id`, kolom verifikasi di pembayaran/refund/pengeluaran |
| Notifikasi & privasi | `org_whatsapp` (token Fonnte terenkripsi, kebijakan `lead_minutes`, tulis hanya owner), `guardians.wa_opt_out`, `notification_log` (sekali per jadwal per kanal; status otomatis `mengirim/terkirim/gagal/tidak_pasti`), `data_requests` (register permintaan wali, hanya owner); fungsi `anonymize_patient()` |
| Lain-lain | `org_counters` (penomoran atomik), `audit_logs` (append-only, trigger menolak UPDATE/DELETE/TRUNCATE) |

Beberapa jaminan integritas penting:

- Paket pada jadwal harus milik **pasien yang sama**: FK `(org, patient_id, patient_package_id)`.
- Pembayaran sesi/paket harus milik pasien yang sama (FK komposit serupa).
- Catatan sesi harus menunjuk jadwal pasien yang sama.
- `therapy_note_revisions` hanya menyimpan versi yang **sudah digantikan**. Versi terkini
  ada di `therapy_notes`, jadi teks klinis tidak tersimpan dua kali.
- Kompensasi hanya satu yang aktif per sesi (unique index parsial).

## 5. Row-Level Security

Konteks transaksi diisi oleh aplikasi melalui pengaturan berikut:

- `app.org_id`, `app.user_id`, `app.member_id`, dan `app.mode` (`tenant` | `support` | `auth` | `platform`).
- `app.scope_patient` / `app.scope_note`: `all` | `assigned` | `none`.
- `app.scope_finance` / `app.scope_audit`: `all` | `none`.

| Tabel | Kebijakan |
|---|---|
| `patients`, `guardians`, `patient_packages`, `package_ledger` | Organisasi cocok **dan** (cakupan pasien `all`, atau `assigned` + ada penugasan terapis) |
| `appointments` | Seperti pasien, atau terapis jadwal tersebut adalah pengguna aktif |
| `therapy_notes` | Cakupan catatan `all`, atau `assigned` + (penulis atau ditugaskan). INSERT/UPDATE **hanya oleh penulis** |
| `patient_documents` | Pasien terlihat **dan** (kategori administrasi, atau cakupan catatan ≠ none) |
| `payments`, `expenses` | Organisasi cocok + cakupan keuangan `all` |
| `therapist_compensations`, `compensation_rules` | Cakupan keuangan `all`, atau baris milik terapis itu sendiri (baca) |
| `audit_logs` | Baca: organisasi + cakupan audit. Tulis: hanya INSERT |
| `memberships` | INSERT hanya dalam mode `auth` dengan token undangan yang sah, belum dipakai, dan role/organisasi yang sama persis |
| `account_tokens` | INSERT dengan role `owner` ditolak; owner hanya dibuat lewat CLI |

Tanpa konteks, role aplikasi melihat **0 baris** di semua tabel bisnis (ada testnya).

Server menolak start bila `DATABASE_URL` memakai role superuser, role dengan
BYPASSRLS, atau pemilik tabel (`assertSafeAppRole`).

Hak role `rtka_app` dibatasi lebih jauh:

- Tidak ada `DELETE` pada data historis.
- `UPDATE` hanya untuk kolom tertentu. Contohnya, nominal pembayaran tidak bisa
  diubah, dan `platform_role`/`email` pengguna tidak bisa diubah dari aplikasi.

## 6. Role & matriks permission

Role tetap: **owner**, **admin** (koordinator), **terapis**, dan **keuangan** (kasir). Peran **wali**
(orang tua) bukan staf dan tidak ada di matriks ini; lihat catatan di bawah.
Admin teknis platform berada di luar tenant.

| Kemampuan | Owner | Admin | Terapis | Keuangan |
|---|:-:|:-:|:-:|:-:|
| Dasbor organisasi | ✓ | ✓ | ✓ (milik sendiri) | ✓ |
| Kelola staf (undang, ubah peran, nonaktifkan, tautan reset) | ✓ | lihat | – | – |
| Data pasien & wali | ✓ | ✓ | hanya pasien yang ditugaskan | lihat (administratif) |
| Penugasan terapis ke pasien | ✓ | ✓ | – | – |
| Undang orang tua, cabut akses, tautan reset orang tua | ✓ | ✓ | – | – |
| Jadwal: lihat | semua | semua | sesi sendiri | semua |
| Jadwal: buat / jadwal ulang / batalkan | ✓ | ✓ | – | – |
| Tandai sesi selesai / tidak hadir | ✓ | ✓ | sesi sendiri | – |
| Koreksi status sesi (reopen) | ✓ | – | – | – |
| Catatan terapi: baca | ✓ | – | pasien yang ditugaskan | – |
| Catatan terapi: tulis | ✓ (bila ditugaskan) | – | ✓ (bila ditugaskan) | – |
| Katalog layanan & jenis paket | ✓ | – | – | – |
| Jual paket ke pasien | ✓ | ✓ | – | ✓ |
| Penyesuaian / pembatalan paket | ✓ | – | – | – |
| Catat pembayaran & pengeluaran | ✓ | – | – | ✓ |
| Batalkan pembayaran / pengeluaran | ✓ | – | – | – |
| Honor terapis: lihat | ✓ | – | milik sendiri | ✓ |
| Honor terapis: aturan & tandai dibayar | ✓ | – | – | – |
| Laporan operasional | ✓ | ✓ | – | – |
| Laporan keuangan | ✓ | – | – | ✓ |
| Ekspor Excel | ✓ | ✓ (operasional) | – | ✓ (keuangan) |
| Dokumen administrasi / klinis | ✓ / ✓ | ✓ / – | ✓ / ✓ (ditugaskan) | lihat / – |
| Audit log | ✓ | – | – | – |
| Setujui / cabut akses dukungan | ✓ | – | – | – |

**Admin merangkap keuangan (keputusan 29 Okt 2026):** owner dapat mencentang
*Merangkap keuangan / kasir* pada admin tertentu (`memberships.handles_finance`, migrasi
`008`). Admin tersebut mendapat **seluruh hak kolom Keuangan** di atas: mencatat pembayaran,
pengeluaran, dan invoice, melakukan rekonsiliasi, serta melihat honor dan laporan keuangan.
Batas diskonnya sama dengan kasir. Catatan klinis, pembatalan transaksi, pengaturan, audit log,
dan pengelolaan staf tetap tertutup. Pilihan ini berlaku per admin di organisasi owner
tersebut saja. Database menolak kombinasi peran selain admin dengan rangkap keuangan, dan
aktivasi undangan harus sama persis dengan undangan (kebijakan RLS `memberships_insert`).

**Orang tua / wali (keputusan 1 Nov 2026):** akun berperan `wali`, berasal dari undangan admin atau
owner pada baris wali di halaman pasien (`guardians.member_id`, migrasi `009`). Sesinya bermode
`portal`: `needTenant` selalu menolak, jadi tidak ada rute staf yang terbuka. Datanya hanya
`GET /portal` dan `GET /portal/notes`, dalam transaksi READ ONLY, dan RLS hanya membuka anak yang
terhubung ke akun itu: jadwal, paket, invoice, catatan terapi **final**, serta pembayaran dan refund
untuk menghitung sisa tagihan. Draf catatan, riwayat revisi, dokumen, program terapi, dan audit log
tertutup di kedua lapisan (keputusan K8). Pembacaan catatan dicatat sebagai `catatan.dilihat_wali`.

Matriks ini didefinisikan di `server/src/authz/permissions.ts` (`permissionsForMember`).
Pilihan yang masih berupa default tercatat di [06-keputusan-terbuka.md](06-keputusan-terbuka.md).

## 7. Akses dukungan teknis

1. Admin teknis mengajukan permintaan dari menu **Dukungan Teknis**. Isinya:
   - Organisasi tujuan.
   - Alasan (minimal 10 karakter).
   - Cakupan **baca-saja**. Cakupan yang bergantung pada data pasien wajib
     menyertakan `patient.read`.
   - Durasi 15–480 menit.
2. Owner organisasi tujuan menyetujui atau menolak. Constraint database melarang
   persetujuan oleh peminta sendiri.
3. Admin teknis masuk mode dukungan. Selama mode ini:
   - Semua transaksi berjalan `READ ONLY` di database.
   - Banner "Mode dukungan teknis" tampil terus.
   - Setiap permintaan dicatat sebagai `dukungan.akses` di audit organisasi.
4. Akses berakhir otomatis pada `expires_at`. Owner juga dapat mencabutnya kapan
   saja, dan pencabutan berlaku seketika.

Catatan klinis hanya terbaca bila cakupan `therapy.note.read` dipilih **dan** disetujui.
Di layar persetujuan, cakupan ini diberi tanda merah.

## 8. Daftar endpoint (`/api`)

| Area | Endpoint |
|---|---|
| Auth | `POST auth/login`, `GET auth/me`, `POST auth/logout`, `POST auth/logout-all`, `POST auth/change-password`, `POST auth/token-info`, `POST auth/accept-invitation`, `POST auth/reset-password` |
| Organisasi | `GET/PATCH org`, `GET/POST services`, `PATCH services/:id`, `GET/POST package-types`, `PATCH package-types/:id` |
| Staf | `GET staff`, `GET staff/therapists`, `GET/POST staff/invitations`, `POST staff/invitations/:id/revoke`, `PATCH staff/:id`, `POST staff/:id/deactivate`, `POST staff/:id/reactivate`, `POST staff/:id/reset-link` |
| Pasien | `GET/POST patients`, `GET/PATCH patients/:id`, `POST patients/:id/guardians`, `PATCH/DELETE guardians/:id`, `PUT patients/:id/therapists`, `GET patients/:id/{appointments,notes,packages,payments,documents}` |
| Jadwal | `GET/POST appointments`, `GET appointments/:id`, `POST appointments/:id/{complete,no-show,cancel,reschedule,reopen}` |
| Catatan | `POST notes`, `GET/PUT notes/:id`, `GET notes/:id/revisions` |
| Paket | `POST patients/:id/packages`, `GET patient-packages/:id`, `POST patient-packages/:id/{adjust,cancel}` |
| Keuangan | `GET/POST payments`, `GET payments/:id`, `POST payments/:id/void`, `GET finance/outstanding`, `GET/POST expenses`, `POST expenses/:id/void` |
| Honor | `GET/POST compensation/rules`, `POST compensation/rules/:id/end`, `GET compensation`, `POST compensation/mark-paid` |
| Laporan | `GET reports/operational`, `GET reports/finance`, `GET reports/{operasional,keuangan}/export` (XLSX) |
| Berkas | `POST patients/:id/documents` (multipart), `GET documents/:id/download`, `POST documents/:id/archive` |
| Program | `GET/POST patients/:id/programs`, `PATCH programs/:id`, `POST programs/:id/goals`, `PATCH goals/:id`, `GET/POST goals/:id/progress` |
| Penagihan | `GET/POST invoices`, `GET invoices/:id`, `GET invoices/:id/pdf`, `POST invoices/:id/void`, `GET patients/:id/billable`, `POST payments/:id/refunds`, `GET refunds`, `POST refunds/:id/void`, `GET refunds/:id/pdf`, `GET payments/:id/pdf`, `GET finance/reconciliation`, `POST finance/verify`, `GET/POST reconciliations`, `POST reconciliations/:id/finalize`, `GET reports/{operasional,keuangan}/pdf` |
| Pengingat & privasi | `GET reminders`, `POST reminders/:id/sent`, `POST reminders/auto-send`, `GET/PUT/DELETE org/whatsapp`, `POST org/whatsapp/check`, `POST org/whatsapp/test`, `GET cron/reminders` (Bearer `CRON_SECRET`), `GET/POST privacy/requests`, `PATCH privacy/requests/:id`, `GET patients/:id/export.pdf`, `POST patients/:id/anonymize`, `GET privacy/retention` |
| Lain-lain | `GET dashboard`, `GET audit`, `GET support/requests`, `POST support/requests/:id/{approve,reject,revoke}`, `GET platform/organizations`, `GET/POST platform/support-requests`, `POST platform/support-requests/:id/enter`, `POST platform/support/exit`, `GET health` |

Tidak ada webhook, background job, cache server, atau integrasi pihak ketiga. Notifikasi
hanya berupa indikator di dasbor (paket hampir habis, catatan belum final, permintaan
akses dukungan).

## 9. Transaksi & konkurensi

- **Menyelesaikan sesi** dijalankan dalam satu transaksi:
  1. Kunci baris jadwal (`FOR UPDATE`).
  2. `UPDATE patient_packages … WHERE sessions_used < sessions_total RETURNING`.
  3. Tulis ledger.
  4. Ubah status jadwal.
  5. Panggil `compute_compensation()`.

  Bila satu langkah gagal, semuanya dibatalkan. Test membuktikan: 6 permintaan
  bersamaan pada paket yang tersisa 1 sesi menghasilkan tepat 1 sukses dan 5 respons 409.
- Penomoran kode pasien dan kuitansi memakai `org_counters` dengan upsert atomik.
- Jadwal bentrok (terapis atau pasien) ditolak. Pemeriksaannya dikunci dengan advisory
  lock per terapis.
