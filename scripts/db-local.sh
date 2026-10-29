#!/usr/bin/env bash
# Cluster PostgreSQL lokal khusus proyek ini (pengembangan & pengujian).
# Terpisah dari server PostgreSQL lain di mesin: data di ./.data/pg, port 54330,
# hanya mendengarkan localhost, tanpa unix socket. Password dibuat acak.
#
#   bash scripts/db-local.sh init    # sekali: initdb, buat role & database, tulis .env
#   bash scripts/db-local.sh start|stop|status
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="$ROOT/.data/pg"
LOG_FILE="$ROOT/.data/pg.log"
PORT="${RTKA_PG_PORT:-54330}"
SECRETS_FILE="$ROOT/.data/pg-superuser.txt"

pg_bin() {
  if command -v "$1" >/dev/null 2>&1; then command -v "$1"; return; fi
  for d in /usr/local/opt/postgresql@18/bin /opt/homebrew/opt/postgresql@18/bin; do
    [ -x "$d/$1" ] && { echo "$d/$1"; return; }
  done
  echo "Tidak menemukan $1. Pasang PostgreSQL 16+ terlebih dahulu." >&2
  exit 1
}

start() {
  if "$(pg_bin pg_ctl)" -D "$DATA_DIR" status >/dev/null 2>&1; then
    echo "PostgreSQL lokal sudah berjalan di port $PORT."
    return
  fi
  # LC_ALL=C mencegah error "postmaster became multithreaded" di macOS.
  LC_ALL=C "$(pg_bin pg_ctl)" -D "$DATA_DIR" -l "$LOG_FILE" -w start >/dev/null
  echo "PostgreSQL lokal berjalan di localhost:$PORT."
}

init() {
  if [ -d "$DATA_DIR" ]; then
    echo "Cluster sudah ada di $DATA_DIR. Tidak ada yang diubah." >&2
    exit 1
  fi
  if [ -f "$ROOT/.env" ]; then
    echo "File .env sudah ada. Pindahkan/hapus dulu bila ingin membuat ulang." >&2
    exit 1
  fi
  mkdir -p "$ROOT/.data"
  chmod 700 "$ROOT/.data"

  local su_pw owner_pw app_pw pwfile
  su_pw="$(openssl rand -hex 24)"
  owner_pw="$(openssl rand -hex 24)"
  app_pw="$(openssl rand -hex 24)"
  pwfile="$(mktemp)"
  printf '%s\n' "$su_pw" > "$pwfile"

  "$(pg_bin initdb)" -D "$DATA_DIR" -U rtka_super --pwfile="$pwfile" \
    --auth=scram-sha-256 --encoding=UTF8 --locale=C >/dev/null
  rm -f "$pwfile"

  cat >> "$DATA_DIR/postgresql.conf" <<CONF

# --- RTKA Rumah Bintang (lokal) ---
listen_addresses = 'localhost'
port = $PORT
unix_socket_directories = ''
password_encryption = 'scram-sha-256'
# Jangan tulis DETAIL (yang dapat berisi nilai data) ke log server.
log_error_verbosity = terse
log_min_error_statement = panic
CONF

  printf 'superuser=rtka_super\npassword=%s\nport=%s\n' "$su_pw" "$PORT" > "$SECRETS_FILE"
  chmod 600 "$SECRETS_FILE"

  start

  PGPASSWORD="$su_pw" "$(pg_bin psql)" -X -q -v ON_ERROR_STOP=1 \
    -h localhost -p "$PORT" -U rtka_super -d postgres <<SQL
CREATE ROLE rtka_owner LOGIN CREATEDB PASSWORD '$owner_pw';
CREATE ROLE rtka_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '$app_pw';
-- Simulasi role Data API Supabase agar test dapat membuktikan hak aksesnya dicabut (migrasi 004).
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE DATABASE rtka_dev OWNER rtka_owner;
REVOKE ALL ON DATABASE rtka_dev FROM PUBLIC;
GRANT CONNECT ON DATABASE rtka_dev TO rtka_app;
SQL

  cat > "$ROOT/.env" <<ENV
# Dibuat oleh scripts/db-local.sh — khusus pengembangan lokal. Jangan di-commit.
NODE_ENV=development
HOST=127.0.0.1
PORT=3000
APP_ORIGINS=http://localhost:5173,http://localhost:3000
PUBLIC_BASE_URL=http://localhost:5173
COOKIE_SECURE=false
UPLOAD_DIR="$ROOT/.data/uploads"
DATABASE_URL=postgres://rtka_app:$app_pw@localhost:$PORT/rtka_dev
DATABASE_ADMIN_URL=postgres://rtka_owner:$owner_pw@localhost:$PORT/rtka_dev
TEST_DATABASE_URL=postgres://rtka_app:$app_pw@localhost:$PORT/rtka_test
TEST_DATABASE_ADMIN_URL=postgres://rtka_owner:$owner_pw@localhost:$PORT/rtka_test
ENV
  chmod 600 "$ROOT/.env"

  echo "Selesai. Role rtka_owner (migrasi) dan rtka_app (aplikasi) dibuat; kredensial ditulis ke .env."
  echo "Lanjutkan dengan: npm run db:migrate"
}

case "${1:-}" in
  init) init ;;
  start) start ;;
  stop) "$(pg_bin pg_ctl)" -D "$DATA_DIR" -w stop ;;
  status) "$(pg_bin pg_ctl)" -D "$DATA_DIR" status ;;
  *) echo "Penggunaan: $0 init|start|stop|status" >&2; exit 2 ;;
esac
