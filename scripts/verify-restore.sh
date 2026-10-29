#!/usr/bin/env bash
# Membuktikan backup dapat dipulihkan: verifikasi checksum, pulihkan ke database SEMENTARA
# (tidak menyentuh database aktif), bandingkan jumlah baris dengan manifest, lalu hapus
# database sementara tersebut.
#
#   bash scripts/verify-restore.sh backups/20261029-130000
#
# Variabel:
#   RESTORE_ADMIN_URL       server tempat database sementara dibuat (role dengan CREATEDB).
#                           Default DATABASE_ADMIN_URL. Untuk backup Supabase, arahkan ke cluster
#                           lokal (mis. URL rtka_owner dari .env pengembangan).
#   BACKUP_PASSPHRASE_FILE  bila backup terenkripsi.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$ROOT/.env" ] && set -a && . "$ROOT/.env" && set +a
RESTORE_URL="${RESTORE_ADMIN_URL:-${DATABASE_ADMIN_URL:-}}"
[ -n "$RESTORE_URL" ] || { echo "RESTORE_ADMIN_URL atau DATABASE_ADMIN_URL belum diisi" >&2; exit 1; }
DIR="${1:?Penggunaan: verify-restore.sh <folder-backup>}"
[ -d "$DIR" ] || { echo "Folder tidak ada: $DIR" >&2; exit 1; }

START=$(date +%s)
echo "1/4 Memeriksa checksum…"
(cd "$DIR" && shasum -a 256 -c SHA256SUMS --quiet)

WORK="$(mktemp -d)"
TMPDB="rtka_restore_check_$(date +%s)"
MAINT="$(node -e "const u=new URL(process.argv[1]);u.pathname='/postgres';console.log(u.toString())" "$RESTORE_URL")"
TARGET="$(node -e "const u=new URL(process.argv[1]);u.pathname='/'+process.argv[2];console.log(u.toString())" "$RESTORE_URL" "$TMPDB")"
cleanup() {
  psql "$MAINT" -Atqc "DROP DATABASE IF EXISTS \"$TMPDB\"" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

DUMP="$DIR/db.dump"
UPLOADS="$DIR/uploads.tar.gz"
if [ -f "$DIR/db.dump.enc" ]; then
  : "${BACKUP_PASSPHRASE_FILE:?Backup terenkripsi: isi BACKUP_PASSPHRASE_FILE}"
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$BACKUP_PASSPHRASE_FILE" -in "$DIR/db.dump.enc" -out "$WORK/db.dump"
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$BACKUP_PASSPHRASE_FILE" -in "$DIR/uploads.tar.gz.enc" -out "$WORK/uploads.tar.gz"
  DUMP="$WORK/db.dump"
  UPLOADS="$WORK/uploads.tar.gz"
fi

echo "2/4 Memulihkan ke database sementara $TMPDB…"
psql "$MAINT" -Atqc "CREATE DATABASE \"$TMPDB\"" >/dev/null
# Hak akses (GRANT) tidak dipulihkan: role penyedia lain (mis. anon/authenticated di Supabase) belum tentu ada
# di server uji. Verifikasi ini memeriksa kelengkapan data; pemulihan produksi menyertakan hak akses.
# Dump berisi CREATE SCHEMA public; database sementara masih kosong sehingga schema bawaannya dihapus dulu.
psql "$TARGET" -Atqc "DROP SCHEMA public" >/dev/null
pg_restore --exit-on-error --no-owner --no-privileges --role="$(node -e "console.log(decodeURIComponent(new URL(process.argv[1]).username))" "$RESTORE_URL")" -d "$TARGET" "$DUMP"

echo "3/4 Membandingkan jumlah baris dengan manifest…"
FAIL=0
while IFS='=' read -r key expected; do
  case "$key" in baris.*) ;; *) continue ;; esac
  table="${key#baris.}"
  actual="$(psql "$TARGET" -Atqc "SELECT count(*) FROM public.\"$table\"")"
  if [ "$actual" != "$expected" ]; then
    echo "   BEDA  $table: manifest=$expected pulih=$actual"
    FAIL=1
  fi
done < "$DIR/manifest.txt"
MIGR_EXPECTED="$(grep '^migrasi=' "$DIR/manifest.txt" | cut -d= -f2)"
MIGR_ACTUAL="$(psql "$TARGET" -Atqc "SELECT string_agg(version, ',' ORDER BY version) FROM schema_migrations")"
[ "$MIGR_EXPECTED" = "$MIGR_ACTUAL" ] || { echo "   BEDA  versi migrasi"; FAIL=1; }
tar -tzf "$UPLOADS" >/dev/null || { echo "   Arsip unggahan rusak"; FAIL=1; }

echo "4/4 Menghapus database sementara…"
cleanup
trap - EXIT

if [ "$FAIL" -ne 0 ]; then
  echo "HASIL: GAGAL — backup tidak identik dengan manifest." >&2
  exit 1
fi
echo "HASIL: BERHASIL — backup dapat dipulihkan dan jumlah baris sesuai manifest ($(( $(date +%s) - START )) detik)."
