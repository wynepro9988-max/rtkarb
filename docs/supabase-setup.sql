-- RTKA Rumah Bintang: persiapan proyek Supabase (lihat 07-supabase-vercel.md §5).
-- Tempel seluruh isi berkas ini ke Dashboard → SQL Editor, lalu klik Run.
--
-- Yang dibuat:
--   rtka_owner      pemilik skema; hanya untuk migrasi, CLI admin, dan backup dari laptop operator
--   rtka_app        role aplikasi di Vercel; tunduk pada RLS
--   dokumen-pasien  bucket Storage privat (PDF/JPG/PNG, maks. 4 MB per berkas)
--
-- Sandi dibuat acak di database dan HANYA tampil sekali di hasil query. Salin segera ke tempat
-- aman. Sandi tidak ditulis di skrip ini, jadi tidak ikut tersimpan di riwayat SQL Editor.
-- Boleh dijalankan ulang, tetapi setiap kali dijalankan kedua sandi diganti baru.
-- Bila ada pemeriksaan yang gagal, seluruh perubahan dibatalkan.

CREATE OR REPLACE FUNCTION pg_temp.rtka_siapkan()
RETURNS TABLE (nama_role text, sandi text, dipakai_untuk text)
LANGUAGE plpgsql AS $$
DECLARE
  sandi_owner text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  sandi_app   text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rtka_owner') THEN
    EXECUTE format('ALTER ROLE rtka_owner WITH LOGIN PASSWORD %L', sandi_owner);
  ELSE
    EXECUTE format('CREATE ROLE rtka_owner WITH LOGIN PASSWORD %L', sandi_owner);
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rtka_app') THEN
    EXECUTE format('ALTER ROLE rtka_app WITH LOGIN PASSWORD %L', sandi_app);
  ELSE
    EXECUTE format('CREATE ROLE rtka_app WITH LOGIN PASSWORD %L', sandi_app);
  END IF;

  GRANT USAGE, CREATE ON SCHEMA public TO rtka_owner;

  INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  VALUES ('dokumen-pasien', 'dokumen-pasien', false, 4194304, ARRAY['application/pdf', 'image/jpeg', 'image/png'])
  ON CONFLICT (id) DO UPDATE
    SET public = false,
        file_size_limit = EXCLUDED.file_size_limit,
        allowed_mime_types = EXCLUDED.allowed_mime_types;

  IF EXISTS (SELECT 1 FROM pg_roles
             WHERE rolname IN ('rtka_owner', 'rtka_app')
               AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication)) THEN
    RAISE EXCEPTION 'rtka_owner/rtka_app tidak boleh punya hak superuser, BYPASSRLS, CREATEROLE, CREATEDB, atau REPLICATION';
  END IF;
  IF (SELECT public FROM storage.buckets WHERE id = 'dokumen-pasien') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'Bucket dokumen-pasien harus privat';
  END IF;

  RETURN QUERY VALUES
    ('rtka_owner', sandi_owner, 'Laptop operator: .env.supabase → DATABASE_ADMIN_URL (session pooler, port 5432)'),
    ('rtka_app',   sandi_app,   'Vercel nanti: DATABASE_URL (transaction pooler, port 6543)');
END $$;

SELECT * FROM pg_temp.rtka_siapkan();
