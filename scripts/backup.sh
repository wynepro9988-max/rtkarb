#!/usr/bin/env bash
# Backup konsisten: database (pg_dump format custom, satu snapshot) + berkas unggahan.
# Menghasilkan folder backups/<waktu>/ berisi db.dump, uploads.tar.gz, manifest.txt, SHA256SUMS.
#
# Variabel:
#   DATABASE_ADMIN_URL      wajib (role pemilik skema)
#   UPLOAD_DIR              folder berkas pasien (STORAGE_DRIVER=local)
#   STORAGE_DRIVER=supabase berkas diunduh dari Supabase Storage (butuh SUPABASE_URL & SUPABASE_SECRET_KEY)
#   BACKUP_SCHEMA           default public (schema aplikasi; schema bawaan Supabase tidak ikut)
#   BACKUP_DIR              default ./backups
#   BACKUP_PASSPHRASE_FILE  bila diisi, isi backup dienkripsi (AES-256, openssl -pbkdf2)
#
# Supabase: pakai koneksi "session pooler" (port 5432) atau direct, bukan transaction pooler.
#
# Backup memuat data klinis anak: simpan terenkripsi, batasi akses, dan uji pemulihan
# secara berkala dengan scripts/verify-restore.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# .env hanya dipakai bila alamat belum diberikan, agar backup produksi tidak diam-diam menjadi
# backup database lokal di komputer operator.
if [ -z "${DATABASE_ADMIN_URL:-}" ] && [ -f "$ROOT/.env" ]; then
  set -a; . "$ROOT/.env"; set +a
fi
: "${DATABASE_ADMIN_URL:?DATABASE_ADMIN_URL belum diisi}"

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="${BACKUP_DIR:-$ROOT/backups}/$STAMP"
umask 077
mkdir -p "$OUT"

echo "Membuat backup ke $OUT"
START=$(date +%s)
pg_dump "$DATABASE_ADMIN_URL" --schema="${BACKUP_SCHEMA:-public}" --format=custom --compress=6 --file="$OUT/db.dump"

if [ "${STORAGE_DRIVER:-local}" = "supabase" ]; then
  FILES="$(mktemp -d)"
  node --env-file-if-exists="$ROOT/.env" "$ROOT/server/scripts/storage-export.ts" --out "$FILES"
  tar -czf "$OUT/uploads.tar.gz" -C "$FILES" .
  rm -rf "$FILES"
elif [ -n "${UPLOAD_DIR:-}" ] && [ -d "$UPLOAD_DIR" ]; then
  tar -czf "$OUT/uploads.tar.gz" -C "$UPLOAD_DIR" .
else
  tar -czf "$OUT/uploads.tar.gz" --files-from /dev/null
fi

{
  echo "dibuat_pada=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "database=$(psql "$DATABASE_ADMIN_URL" -Atqc 'SELECT current_database()')"
  echo "versi_postgres=$(psql "$DATABASE_ADMIN_URL" -Atqc 'SHOW server_version')"
  echo "migrasi=$(psql "$DATABASE_ADMIN_URL" -Atqc "SELECT string_agg(version, ',' ORDER BY version) FROM schema_migrations")"
  echo "git_commit=$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo tidak-ada)"
  echo "# jumlah baris per tabel saat backup"
  psql "$DATABASE_ADMIN_URL" -Atq -F '=' -c "
    SELECT 'baris.' || relname, n FROM (
      SELECT c.relname, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', c.relname), false, true, '')))[1]::text::bigint AS n
        FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
       WHERE s.nspname = '${BACKUP_SCHEMA:-public}' AND c.relkind = 'r') t ORDER BY relname"
} > "$OUT/manifest.txt"

if [ -n "${BACKUP_PASSPHRASE_FILE:-}" ]; then
  for f in db.dump uploads.tar.gz; do
    openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "file:$BACKUP_PASSPHRASE_FILE" -in "$OUT/$f" -out "$OUT/$f.enc"
    rm -f "$OUT/$f"
  done
  echo "terenkripsi=ya" >> "$OUT/manifest.txt"
fi

(cd "$OUT" && shasum -a 256 ./* > SHA256SUMS)
echo "Selesai dalam $(( $(date +%s) - START )) detik."
echo "$OUT"
