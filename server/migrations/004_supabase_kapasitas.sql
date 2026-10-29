-- 004_supabase_kapasitas.sql
-- (1) Pengamanan untuk Supabase: Data API (PostgREST) mengekspos schema public, dan
--     Supabase memberi hak default ke anon/authenticated/service_role. Aplikasi ini tidak
--     memakai Data API, jadi semua hak role tersebut atas objek aplikasi dicabut.
--     Di PostgreSQL biasa (tanpa role-role itu) bagian ini dilewati.
-- (2) Fungsi pemantauan kapasitas (agregat saja, tanpa data pasien).
-- (3) Mekanisme arsip audit log yang terkendali (hanya pemilik skema + flag eksplisit).

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);
      -- Objek baru yang dibuat pemilik skema juga tidak otomatis terekspos.
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', r);
    END IF;
  END LOOP;
END $$;

-- Fungsi aplikasi hanya dapat dieksekusi oleh role aplikasi (bukan PUBLIC).
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_setting(text), app_org_id(), app_user_id(), app_member_id(), app_mode(),
  app_scope(text), app_token_hash(), app_patient_visible(uuid, uuid), app_note_visible(uuid, uuid, uuid),
  compute_compensation(uuid) TO rtka_app;

-- Tabel tanpa data tenant tetap ber-RLS agar tidak terbaca role lain sama sekali.
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY sessions_app_only ON sessions TO rtka_app USING (true) WITH CHECK (true);
ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Kapasitas
-- ---------------------------------------------------------------------------
-- Total berkas organisasi aktif (termasuk dokumen klinis & arsip), untuk kuota unggah.
CREATE FUNCTION org_storage_bytes() RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(sum(size_bytes), 0)::bigint FROM patient_documents WHERE organization_id = app_org_id()
$$;

-- Ringkasan kapasitas untuk admin teknis platform (hanya angka).
CREATE FUNCTION platform_usage() RETURNS TABLE (
  org_id uuid, org_name text, storage_bytes bigint, patient_count bigint, note_count bigint, audit_rows bigint, db_bytes bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF app_mode() <> 'platform' THEN
    RAISE EXCEPTION 'hanya untuk admin teknis platform' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT o.id, o.name,
           (SELECT coalesce(sum(d.size_bytes), 0)::bigint FROM patient_documents d WHERE d.organization_id = o.id),
           (SELECT count(*) FROM patients p WHERE p.organization_id = o.id),
           (SELECT count(*) FROM therapy_notes n WHERE n.organization_id = o.id),
           (SELECT count(*) FROM audit_logs a WHERE a.organization_id = o.id),
           pg_database_size(current_database())
      FROM organizations o ORDER BY o.name;
END $$;

REVOKE ALL ON FUNCTION org_storage_bytes(), platform_usage() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION org_storage_bytes(), platform_usage() TO rtka_app;

-- ---------------------------------------------------------------------------
-- Arsip audit log: DELETE pada audit_logs hanya diizinkan untuk pemilik skema yang
-- secara eksplisit menyalakan flag rtka.allow_audit_purge di transaksinya (dipakai CLI
-- `admin archive-audit`, yang mengekspor dulu baris yang dihapus). Tabel append-only lain
-- (ledger paket, revisi catatan) tetap tidak dapat dihapus. TRUNCATE tetap ditolak.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reject_modification() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND TG_TABLE_NAME = 'audit_logs'
     AND current_setting('rtka.allow_audit_purge', true) = 'on'
     AND current_user = (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.audit_logs'::regclass) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'tabel % bersifat append-only', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END $$;
