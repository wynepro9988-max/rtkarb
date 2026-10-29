# Aset identitas visual

**Status: logo resmi terpasang** (diterima dari pemilik proyek pada 29 Oktober 2026).

| File | Keterangan |
|------|------------|
| `logo-rumah-bintang.jpg` | Logo resmi "Rumah Bintang — Pusat Kemandirian dan Tumbuh Kembang Anak". JPEG 554×554 px, latar putih. Disimpan **apa adanya**, tanpa diubah warna maupun proporsinya |

## Satu sumber untuk web & Android

| Dipakai oleh | Cara |
|---|---|
| Web: sidebar, header seluler, halaman masuk/aktivasi, kuitansi | Diimpor langsung oleh `web/src/ui.tsx` |
| Favicon web (`web/public/favicon.png`, `apple-touch-icon.png`) | Diperkecil dari file yang sama (`sips`) |
| Ikon launcher Android (`android/app/src/main/res/mipmap-*`) | `bash scripts/build-android-icons.sh`. Logo diletakkan di tengah dengan latar putih agar tidak terpotong oleh bentuk ikon |

Warna UI diselaraskan dengan logo: navy `#2C378D` (teks "RUMAH BINTANG") sebagai
warna utama, dan oranye `#EF8A19` (bintang) sebagai aksen.

## Masih diperlukan

- **File resolusi tinggi atau vektor** (SVG/AI/PDF, atau PNG ≥ 1024 px). File saat ini
  554 px: cukup untuk layar, tetapi kurang tajam untuk cetak besar (spanduk, kop surat).
- Konfirmasi nama yang tampil di aplikasi. Saat ini judul aplikasi adalah "RTKA Rumah
  Bintang" sesuai master prompt, sedangkan tagline logo berbunyi "Pusat Kemandirian dan
  Tumbuh Kembang Anak".

## Mengganti / memperbarui logo

1. Ganti `brand/logo-rumah-bintang.jpg`. Bila format berubah (mis. `.svg`/`.png`),
   perbarui juga impor di `web/src/ui.tsx` dan `SRC` di `scripts/build-android-icons.sh`.
2. Buat ulang favicon:
   ```bash
   sips -s format png -z 64 64 brand/logo-rumah-bintang.jpg --out web/public/favicon.png
   sips -s format png -z 180 180 brand/logo-rumah-bintang.jpg --out web/public/apple-touch-icon.png
   ```
3. `bash scripts/build-android-icons.sh`, lalu `npm run build`, restart server, dan build
   ulang APK.
