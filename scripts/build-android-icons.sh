#!/usr/bin/env bash
# Membuat ikon launcher Android dari logo resmi brand/logo-rumah-bintang.jpg
# (satu sumber logo untuk web & Android). Memakai alat bawaan macOS (sips).
#
# - mipmap-*/ic_launcher.png              : ikon klasik (logo utuh, latar putih)
# - mipmap-*/ic_launcher_foreground.png   : lapisan depan ikon adaptif; logo diletakkan
#   di "safe zone" (≈66% tengah) agar tidak terpotong oleh bentuk ikon launcher.
# Logo tidak diubah warna maupun proporsinya, hanya diperkecil dan diberi ruang putih.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/brand/logo-rumah-bintang.jpg"
RES="$ROOT/android/app/src/main/res"
command -v sips >/dev/null || { echo "Butuh macOS (sips)." >&2; exit 1; }
[ -f "$SRC" ] || { echo "Logo tidak ditemukan: $SRC" >&2; exit 1; }

for spec in mdpi:48:108 hdpi:72:162 xhdpi:96:216 xxhdpi:144:324 xxxhdpi:192:432; do
  IFS=: read -r density legacy adaptive <<<"$spec"
  dir="$RES/mipmap-$density"
  mkdir -p "$dir"
  sips -s format png -z "$legacy" "$legacy" "$SRC" --out "$dir/ic_launcher.png" >/dev/null
  cp "$dir/ic_launcher.png" "$dir/ic_launcher_round.png"
  inner=$(( adaptive * 64 / 100 ))
  sips -s format png -z "$inner" "$inner" "$SRC" --out "$dir/ic_launcher_foreground.png" >/dev/null
  sips --padToHeightWidth "$adaptive" "$adaptive" --padColor FFFFFF "$dir/ic_launcher_foreground.png" >/dev/null 2>&1
done

mkdir -p "$RES/mipmap-anydpi-v26"
for name in ic_launcher ic_launcher_round; do
  cat > "$RES/mipmap-anydpi-v26/$name.xml" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/icon_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
XML
done
echo "Ikon launcher dibuat dari brand/logo-rumah-bintang.jpg"
