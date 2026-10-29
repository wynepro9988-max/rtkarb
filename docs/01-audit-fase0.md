# Fase 0 — Hasil audit (29 Oktober 2026)

## Ringkasan

**Tidak ada repository yang dapat diaudit.** Folder kerja `~/Downloads/rumah bintang`
kosong. Pencarian nama terkait (`rtka`, `bintang`, `rbcms`, `rumah`, `tumbuh kembang`,
`terapi`) di Downloads, Documents, Desktop, dan home sampai kedalaman 5 tidak
menemukan source code, database, maupun APK.

Pemilik proyek kemudian memutuskan: *"jadikan ini foldernya saja, code isi di sini
semua"*. Proyek dibangun dari nol di folder ini.

## Fakta terverifikasi

| Hal | Temuan |
|---|---|
| Source code / repo git | Tidak ada |
| Database aplikasi lama | Tidak ditemukan secara lokal. Tidak ada kredensial atau akses ke server mana pun |
| Aplikasi Android lama | Tidak ditemukan |
| Logo resmi | Belum diperoleh. Halaman Facebook `rtka.rumahbintang` tidak dapat diakses dari lingkungan ini (awalnya DNS gagal, kemudian timeout) |
| PDF "RUMAH BINTANG - STAMPEL ..." | Berisi stempel **Yayasan Bersama Guna Nusantara** (logo BGN), bukan logo RTKA. Tidak dipakai |
| Lingkungan pengembangan | Node 24, PostgreSQL 18 (Homebrew), Android SDK 36, JDK 21 (bawaan Android Studio), Gradle 8.14.3 tercache |

## Risiko yang belum dapat diverifikasi

- Prompt proyek menyebut kedua organisasi *saat ini* sudah memakai satu aplikasi.
  Aplikasi lama itu tidak ditemukan. Lokasi data pasien lama, status backup-nya,
  dan siapa yang dapat mengaksesnya **belum diketahui**.
- Sesuai keputusan bisnis, **tidak ada migrasi data lama**. Kedua tenant dimulai
  kosong. Data lama harus dipertahankan di sistem lama sampai ada keputusan
  terpisah tentang retensi atau pemindahannya.

## Konsekuensi untuk fase berikutnya

Karena tidak ada sistem lama, tidak ada kontrak API, skema, atau perilaku yang harus
dipertahankan. Stack dipilih berdasarkan kebutuhan proyek dan alat yang sudah tersedia
di mesin; alasannya ada di [02-desain-teknis.md](02-desain-teknis.md).
