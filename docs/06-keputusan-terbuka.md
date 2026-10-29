# Keputusan yang masih membutuhkan persetujuan

Untuk setiap kebijakan di bawah, sistem saat ini memakai **default yang paling aman
atau paling netral**. Default ini bukan aturan bisnis yang sudah disetujui.

## Finansial

| # | Topik | Perilaku saat ini | Yang perlu diputuskan |
|---|---|---|---|
| F1 | Pengakuan pendapatan | Laporan memakai **basis kas** (pembayaran tercatat pada tanggal bayar). Tidak ada angka "laba" | Apakah perlu basis akrual (pendapatan diakui saat sesi selesai)? |
| F2 | Ketidakhadiran (no-show) | **Tidak** memotong saldo paket dan tidak ditagih | Apakah no-show memotong sesi/ditagih? Berapa kali toleransi? |
| F3 | Pembatalan sesi | Tidak memotong saldo dan tidak ditagih | Batas waktu pembatalan, denda? |
| F4 | Refund | **Fitur tersedia (29 Okt):** refund terkait satu pembayaran, **hanya owner**, wajib beralasan, total ≤ nominal pembayaran, ada bukti PDF. Paket yang dibatalkan tidak otomatis direfund | Syarat refund (kapan boleh, berapa persen, potongan admin?) dan apakah kasir boleh mengajukan |
| F5 | Diskon | **Fitur tersedia (29 Okt):** diskon per baris invoice, wajib beralasan. Owner bebas, sedangkan kasir dibatasi **Pengaturan → Batas diskon kasir** (default **0%** = hanya owner) | Besaran batas diskon kasir; jenis diskon resmi (saudara kandung, subsidi, dsb.) |
| F6 | Paket kedaluwarsa | Masa berlaku opsional per jenis paket. Paket kedaluwarsa tidak dapat dipakai. Sisa sesi tidak dikembalikan | Perpanjangan, pengembalian sisa sesi |
| F7 | Koreksi transaksi | Pembayaran tidak dapat diedit. Pembatalan **hanya owner**, dengan alasan, lalu catat ulang | Apakah kasir boleh membatalkan dengan persetujuan owner? |
| F8 | Akses keuangan admin | **Diputuskan 29 Okt:** admin dapat merangkap keuangan. Owner mencentang *Merangkap keuangan / kasir* pada admin yang bersangkutan (Staf → Ubah). Default tidak dicentang; catatan klinis tetap tertutup | Admin mana saja yang merangkap di masing-masing organisasi |
| F9 | Invoice | **Fitur tersedia (29 Okt):** invoice bernomor (paket, sesi per-sesi, baris lain), PDF, pembayaran sebagian/lunas. Invoice berpembayaran tidak dapat dibatalkan | Apakah semua paket wajib lewat invoice; ketentuan jatuh tempo |
| F10 | Honor persentase untuk paket | Dasar tarif = harga paket ÷ jumlah sesi | Sesuai kontrak terapis? |
| F11 | QRIS | Dicatat manual, tanpa verifikasi ke penyedia | Perlu integrasi payment gateway? |
| F12 | Rekonsiliasi | **Fitur tersedia (29 Okt):** per metode & periode, centang transaksi yang cocok, simpan selisih, owner memfinalkan | Seberapa sering (harian kas, bulanan bank) dan siapa yang mencocokkan |

## Klinis & data

| # | Topik | Perilaku saat ini | Yang perlu diputuskan |
|---|---|---|---|
| K1 | Akses terapis | Hanya pasien yang **ditugaskan**. Menjadwalkan terapis otomatis menugaskannya | Apakah terapis perlu melihat semua pasien (mis. untuk menggantikan)? |
| K2 | Owner menulis catatan | Owner dapat membaca semua catatan. Menulis hanya bila ditandai "juga terapis" dan ditugaskan | Sesuai praktik klinis? |
| K3 | Persetujuan catatan | Tidak ada persetujuan koordinator. Terapis memfinalkan sendiri | Perlu review klinis untuk jenis catatan tertentu? |
| K4 | Retensi & penghapusan | **Mekanisme tersedia (29 Okt):** register permintaan wali, ekspor PDF (hak akses), anonimisasi mode *identitas* atau *penuh* (owner, konfirmasi kode pasien), dan kandidat retensi bila owner menetapkan masa retensi. **Tidak ada penghapusan otomatis** | Masa simpan wajib catatan klinis & pembukuan (perlu dicek dengan ahli hukum/regulasi yang berlaku), mode anonimisasi mana yang dipakai untuk permintaan hapus |
| K5 | Data minimum pasien | Nama, panggilan, tanggal lahir, jenis kelamin, alamat, wali. Tanpa NIK, diagnosis, atau data kesehatan di profil | Apakah ada data wajib lain (mis. sekolah, rujukan dokter)? |
| K7 | Batas catatan sesi | **Diputuskan 29 Okt:** terapis wajib membuat catatan untuk setiap sesi selesai, **final paling lambat akhir bulan sesi** (zona waktu organisasi). Penandaan "selesai" tidak diblokir. Yang lewat batas ditandai di dasbor, jadwal, laporan, dan Excel. Aturan sama untuk kedua organisasi | Apakah perlu sanksi atau tindak lanjut otomatis (mis. pengingat WhatsApp ke terapis)? Apakah sesi di hari terakhir bulan perlu tenggang? |
| K6 | Persetujuan wali | Belum ada pencatatan persetujuan (consent) pengolahan data | Perlu formulir consent dan dokumentasinya? |

## Akses & operasional

| # | Topik | Perilaku saat ini | Yang perlu diputuskan |
|---|---|---|---|
| A1 | Co-owner | Hanya satu jalur pembuatan owner (CLI). Owner tidak dapat menambah owner lain | Perlu lebih dari satu owner per organisasi? |
| A2 | Satu akun satu organisasi | Email yang sudah terdaftar tidak dapat diundang organisasi lain | Sesuai keputusan awal. Pemindahan lintas organisasi di luar cakupan |
| A3 | Durasi sesi login | Idle 12 jam, maksimum 14 hari | Lebih ketat untuk perangkat bersama? |
| A4 | Notifikasi | **Sekali klik** (wa.me/mailto) **dan otomatis lewat Fonnte (29 Okt)**: tiap owner menghubungkan nomornya sendiri dan menetapkan berapa jam sebelum sesi pertama pengingat dikirim (default 3 jam). **Diputuskan 29 Okt:** satu pesan per anak per hari, memuat semua jam sesinya. Nonaktif sampai owner mengaktifkan | Nomor WhatsApp khusus per organisasi; paket Fonnte (kuota); cara memberi tahu wali bahwa datanya diproses Fonnte; apakah menerima risiko gateway tidak resmi atau beralih ke WhatsApp Business API resmi |
| A5 | Admin teknis | Belum ada akun admin teknis. Dibuat via CLI bila perlu | Siapa yang menjadi admin teknis? Siapa selain owner yang boleh menyetujui akses? |
| A6 | Penanggung jawab rollback & insiden | Belum ditetapkan | Nama dan kontak |
| A7 | ID aplikasi Android | `id.rtka.rumahbintang` (permanen setelah terbit di Play Store) | Konfirmasi atau ganti sebelum rilis pertama |
| A8 | Android minimum | Android 10 (API 29) | Apakah ada staf dengan perangkat lebih lama? |
| A9 | Logo & nama | **Diputuskan 29 Okt:** nama tampilan mengikuti logo, yaitu "Rumah Bintang — Pusat Kemandirian dan Tumbuh Kembang Anak". Pengenal internal (`rtka_*`, nama paket, ID aplikasi Android) tidak diubah | Kirim file logo vektor/resolusi tinggi untuk cetak |
| A10 | Hosting & domain | **Diputuskan 29 Okt:** Git + Vercel + Supabase (Free). Lihat [07](07-supabase-vercel.md) | Domain dan pengelola akun Vercel/Supabase |
| A12 | Paket Vercel | Vercel Hobby **hanya untuk non-komersial**. Aplikasi operasional rumah terapi memerlukan **Pro** (mulai USD 20/bulan) | Setujui biaya Vercel Pro, atau pilih hosting lain (VPS, [05](05-deployment.md)) |
| A13 | Backup Supabase Free | Supabase Free **tanpa backup otomatis**. Backup berjalan lewat skrip dari komputer operator | Siapa yang menjalankan backup mingguan dan di mana disimpan, atau naik ke Supabase Pro (backup harian) |
| A14 | Jeda proyek Supabase Free | Proyek dijeda setelah 1 minggu tanpa aktivitas, sehingga libur panjang bisa menghentikan aplikasi | Terima risikonya, aktifkan cron harian Vercel ke `/api/health?db=1`, atau naik ke Pro |
| A15 | Lokasi data | Proyek Supabase dibuat di Mumbai (India) karena Singapura tidak dapat dipilih, sehingga data pasien tersimpan di luar Indonesia | Konfirmasi kepatuhan UU PDP (transfer data lintas negara, persetujuan wali) |
| A11 | Data aplikasi lama | Tidak ditemukan dan tidak dimigrasi | Di mana sistem lama berada, berapa lama dipertahankan, dan perlukah diarsipkan? |
