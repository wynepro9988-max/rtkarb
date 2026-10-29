# Keamanan data klinis anak

Dokumen ini mencatat kontrol yang **sudah diimplementasikan** beserta bukti test-nya,
lalu memisahkannya dari hal yang **belum** dapat dibuktikan.

## Kontrol yang diimplementasikan

| Area | Kontrol | Bukti |
|---|---|---|
| Isolasi tenant | Filter `organization_id` di setiap query, RLS di database, dan FK komposit | `server/test/rls.test.ts`, `isolation.test.ts` |
| Role koneksi | Aplikasi memakai `rtka_app` (NOBYPASSRLS, bukan owner). Server menolak start dengan role yang melewati RLS | `rls.test.ts` |
| Least privilege klinis | Terapis hanya mengakses pasien yang ditugaskan. Admin dan keuangan tidak dapat membaca catatan (403 di API, 0 baris di DB) | `therapy.test.ts` |
| Kata sandi | scrypt (N=2¹⁵, r=8, p=3) dengan salt per pengguna. Minimal 10 karakter. Tidak ada kata sandi default | `auth.test.ts` |
| Login | Pesan gagal generik, kunci 15 menit setelah 5 kali gagal, rate limit per IP | `auth.test.ts` |
| Sesi | Token acak 256-bit, hanya hash SHA-256 yang disimpan. Cookie `httpOnly`, `SameSite=Lax`, `Secure` di produksi. Idle timeout 12 jam, maksimum 14 hari | `auth.test.ts` |
| Pencabutan | Logout, logout semua perangkat, nonaktif staf, ganti/reset sandi, dan cabut akses dukungan berlaku pada permintaan berikutnya | `auth.test.ts`, `support.test.ts` |
| CSRF | Token CSRF per sesi untuk setiap permintaan yang mengubah data, cek `Origin`, dan tolak `Sec-Fetch-Site: cross-site` | `auth.test.ts` |
| Header | CSP ketat (`self`, `frame-ancestors 'none'`), `nosniff`, `Referrer-Policy: no-referrer`, HSTS di produksi, `Cache-Control: no-store` untuk API | `auth.test.ts` |
| Undangan/reset | Token sekali pakai, hanya hash yang disimpan, berlaku 72/24 jam. Token di fragmen URL (`#token=`), sehingga tidak tercatat di log server dan tidak terkirim sebagai referrer | `auth.test.ts` |
| Kebocoran keberadaan akun | Mengundang email yang terdaftar di organisasi lain memberi respons yang sama seperti undangan biasa. Objek tenant lain dijawab 404 | `auth.test.ts`, `isolation.test.ts` |
| Peran owner | Tidak dapat diberikan lewat API (validasi), kebijakan RLS, maupun trigger database | `auth.test.ts`, `rls.test.ts` |
| Integritas catatan | Hanya penulis yang mengubah catatan. Setiap simpan membuat revisi baru (append-only). Catatan final hanya dikoreksi dengan alasan. Tidak ada endpoint hapus | `therapy.test.ts` |
| Integritas keuangan | Nominal pembayaran tidak dapat diubah (hak kolom). Pembatalan oleh owner dengan alasan. Saldo paket dijaga CHECK constraint dan update bersyarat | `finance.test.ts`, `rls.test.ts` |
| Audit log | Append-only: trigger menolak UPDATE/DELETE/TRUNCATE, bahkan oleh pemilik skema. Isi klinis tidak pernah dicatat | `rls.test.ts`, `therapy.test.ts` |
| Logging | Log hanya mencatat pola rute, tanpa query string, body, cookie, maupun token. Error DB dicatat tanpa DETAIL (yang bisa berisi nilai data) | `logging.test.ts` |
| Berkas | Jenis divalidasi dari magic bytes (PDF/JPG/PNG), maksimal 5 MB, disimpan di luar web root dengan nama acak. Unduh hanya lewat endpoint terotorisasi (`nosniff`, `attachment`). Dokumen klinis mengikuti akses catatan | `files.test.ts` |
| Ekspor | XLSX dibuat di server dari data tenant aktif. Sel teks ditulis sebagai inline string (tidak dieksekusi sebagai formula). Setiap ekspor tercatat di audit | `isolation.test.ts`, `finance.test.ts` |
| Dukungan teknis | Ditolak secara default. Butuh persetujuan owner, berbatas waktu, baca-saja (`READ ONLY` di DB), dapat dicabut, dan setiap permintaan tercatat | `support.test.ts` |
| Supabase Data API | Migrasi `004` mencabut semua hak `anon`/`authenticated`/`service_role` atas tabel, sequence, dan fungsi aplikasi. Hak default untuk objek baru juga dicabut, dan RLS aktif di **semua** tabel. Data API sebaiknya juga dimatikan di dashboard | `supabase.test.ts` + uji mutasi |
| Kunci Supabase | Secret key hanya di variabel lingkungan server/Vercel, dikirim di header `apikey`, tidak pernah ke browser. Bucket berkas privat | `supabase.test.ts` |
| TLS ke database | Sertifikat CA Supabase diverifikasi (`DB_SSL_CA`). Opsi `no-verify` hanya untuk diagnosis | Peninjauan kode |
| WhatsApp otomatis (Fonnte) | Token per organisasi, AES-256-GCM dengan AAD = ID organisasi, tidak pernah dikembalikan API/log. Tulis hanya owner (RLS). Cron dilindungi `CRON_SECRET` (perbandingan waktu-konstan) dan berjalan per organisasi tanpa akses klinis/keuangan. Klaim sebelum kirim mencegah pesan ganda; jawaban tidak pasti tidak diulang | `whatsapp.test.ts` |
| Hak subjek data | Ekspor data pasien hanya owner (PDF bertanda RAHASIA, tercatat). Anonimisasi hanya owner, wajib alasan + mengetik ulang kode pasien, ditolak bila masih ada jadwal; dijalankan fungsi `SECURITY DEFINER` yang terkunci ke organisasi aktif; berkas ikut dihapus dari penyimpanan; audit tanpa data pribadi | `privacy.test.ts` |
| Integritas penagihan | Harga invoice dari database, diskon beralasan dengan batas peran, refund ≤ pembayaran (kunci baris + trigger), rekonsiliasi final tidak dapat diubah | `billing.test.ts` |
| AI / telemetry | Tidak ada analytics, telemetry, atau pengiriman data ke layanan AI pihak ketiga. Font di-host sendiri | Peninjauan kode |
| Dependensi | `npm audit`: 0 kerentanan (29 Okt 2026). Penulis XLSX dibuat sendiri agar tidak menarik dependensi besar | `npm audit` |

## Aplikasi Android

| Risiko | Kontrol |
|---|---|
| Screenshot / rekam layar / pratinjau Recent Apps | `FLAG_SECURE` di seluruh aplikasi |
| Backup perangkat (Google Drive / transfer perangkat) | `allowBackup=false` dan `dataExtractionRules` mengecualikan semua domain |
| Lalu lintas tanpa enkripsi | `usesCleartextTraffic=false`. Network security config hanya menerima CA sistem. Pengecualian HTTP hanya di build **debug** untuk `10.0.2.2`/`localhost` |
| Navigasi ke situs lain di dalam app | Hanya host `BASE_URL` yang dimuat. Tautan lain dibuka di browser eksternal |
| Akses berkas lokal / JS bridge | `allowFileAccess=false`, `allowContentAccess=false`, tanpa `addJavascriptInterface`, tanpa jendela pop-up |
| Cache data | API mengirim `no-store`. Cache WebView dihapus saat aplikasi ditutup. Token sesi berupa cookie `httpOnly` (tidak terbaca JavaScript) |
| Build rilis tanpa HTTPS | Gradle menolak `assembleRelease` bila `rtka.releaseUrl` bukan `https://` |
| Unduhan | File unduhan (laporan/dokumen) disimpan ke folder Download publik atas tindakan pengguna. **Ini memindahkan data keluar dari sandbox aplikasi**, jadi perlu kebijakan penggunaan perangkat |

## Belum dapat dibuktikan / di luar cakupan lokal

- **Enkripsi saat transit (HTTPS)** bergantung pada konfigurasi reverse proxy di server
  produksi, yang belum ada. Lihat [05-deployment.md](05-deployment.md).
- **Enkripsi saat tersimpan (at rest)** untuk disk database dan folder unggahan
  bergantung pada server. Backup **dapat** dienkripsi (`BACKUP_PASSPHRASE_FILE`).
- Belum ada uji penetrasi independen. Disarankan sebelum go-live.
- Belum ada pemantauan/alerting produksi.
- **Kebijakan retensi data** (berapa lama catatan klinis disimpan dan kapan dihapus)
  belum ditetapkan. Lihat keputusan terbuka.
- Akun dengan perangkat bersama: idle timeout 12 jam dapat diperketat bila perangkat
  dipakai bergantian (`SESSION_IDLE_MINUTES`).

## Prinsip operasional

- Debugging memakai metadata (ID, kode error, pola rute) dan data sintetis. Jangan
  menyalin data pasien ke tiket, chat, atau log.
- Jangan pernah memakai role `rtka_owner` untuk server web.
- Kredensial hanya di `.env` atau secret manager, tidak di repository (`.env` di-ignore).
