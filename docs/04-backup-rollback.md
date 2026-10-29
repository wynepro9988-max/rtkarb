# Backup, pemulihan, dan rollback

## Backup

```bash
BACKUP_PASSPHRASE_FILE=/etc/rtka/backup-pass npm run backup
```

Perintah ini menghasilkan `backups/<waktu>/` yang berisi:

- `db.dump(.enc)`: dump PostgreSQL format custom dari **satu snapshot** konsisten.
- `uploads.tar.gz(.enc)`: berkas pasien.
- `manifest.txt`: waktu, versi PostgreSQL, daftar migrasi, commit git, dan jumlah baris per tabel.
- `SHA256SUMS`.

Aturan:

- Backup memuat data klinis anak, jadi **wajib terenkripsi** di produksi. Simpan
  passphrase terpisah dari backup.
- Simpan salinan di luar server (offsite), dengan akses dibatasi ke penanggung jawab.
- Jadwal yang disarankan: harian (cron/systemd timer), dengan retensi sesuai
  keputusan owner.

## Uji pemulihan (wajib berkala dan sebelum setiap migrasi produksi)

```bash
BACKUP_PASSPHRASE_FILE=/etc/rtka/backup-pass npm run backup:verify -- backups/<waktu>
```

Langkah yang dijalankan skrip:

1. Memeriksa checksum.
2. Mendekripsi ke folder sementara.
3. Memulihkan ke database **sementara** (database aktif tidak disentuh).
4. Membandingkan jumlah baris tiap tabel dan versi migrasi dengan manifest.
5. Memeriksa arsip unggahan, lalu menghapus database sementara.

**Bukti lokal (29 Okt 2026):** backup terenkripsi dari database `rtka_dev` (berisi data
DEMO) berhasil dipulihkan, dan seluruh jumlah baris cocok dengan manifest (10 detik).
Backup yang sengaja dirusak satu byte ditolak di tahap checksum. Ini belum menjadi bukti
untuk produksi, karena server produksi belum ada.

## Migrasi skema

- File di `server/migrations/NNN_nama.sql` diterapkan berurutan di dalam transaksi.
  Checksum setiap file dicatat di `schema_migrations`.
- Mengubah file migrasi yang sudah diterapkan **ditolak**. Perubahan selalu dibuat
  sebagai file baru.
- Migrasi dijalankan dengan `DATABASE_ADMIN_URL` (rtka_owner), tidak pernah dengan
  role aplikasi.

## Prosedur rilis yang aman

1. Catat versi aplikasi (commit) dan daftar migrasi saat ini.
2. `npm run backup` lalu `npm run backup:verify`. **Jangan lanjut bila verifikasi gagal.**
3. Terapkan dan uji migrasi di **staging** dengan salinan backup produksi.
4. Hentikan sementara penulisan (mode pemeliharaan) bila migrasinya berat.
5. `npm run db:migrate`, deploy kode baru, restart, lalu cek `/api/health`.
6. Smoke test oleh owner A dan owner B: login, dasbor, satu transaksi uji DEMO.

## Rollback

| Situasi | Tindakan |
|---|---|
| Bug aplikasi, skema tidak berubah | Deploy ulang commit sebelumnya dan restart. Data tidak disentuh |
| Migrasi baru bersifat aditif (tabel/kolom baru) | Deploy ulang kode lama. Kolom baru dibiarkan (kompatibel). Hapus kolom hanya lewat migrasi baru yang terencana |
| Migrasi gagal di tengah | Migrasi berjalan dalam transaksi, jadi otomatis dibatalkan. Perbaiki lalu ulangi |
| Kerusakan data / skema tidak dapat diperbaiki | Pulihkan dari backup ke database baru, verifikasi, lalu alihkan `DATABASE_URL`. **Data yang ditulis setelah backup akan hilang.** Keputusan ini wajib diambil oleh penanggung jawab rollback setelah menilai transaksi baru yang perlu dicatat ulang |

**Jangan** menjalankan pemulihan database secara membabi buta bila ada transaksi baru
(pembayaran, catatan sesi) yang harus dipertahankan. Ekspor dulu transaksi sejak waktu
backup melalui `audit_logs`, laporan, dan ekspor Excel untuk dicatat ulang.

Penanggung jawab keputusan rollback: **belum ditetapkan** (lihat keputusan terbuka).

## Bila terjadi kebocoran tenant / insiden

1. Batasi akses: nonaktifkan akun terdampak (`npm run admin -- disable-user`), cabut
   akses dukungan, atau nonaktifkan organisasi (`set-org-status --status inactive`,
   yang juga mencabut semua sesi).
2. Pertahankan bukti: **jangan** menghapus `audit_logs` (memang tidak bisa dihapus).
   Salin log server.
3. Identifikasi jalur kebocoran dari audit log (aktor, rute, waktu).
4. Perbaiki otorisasi, lalu tambahkan test regresi yang mereproduksi kebocoran.
5. Jalankan seluruh test, deploy, lalu tangani pemberitahuan kepada pihak terdampak
   sesuai kebijakan dan regulasi yang berlaku (termasuk UU PDP).
