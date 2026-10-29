-- 006_cabut_execute_public.sql
-- Hak EXECUTE bawaan PostgreSQL untuk PUBLIC atas fungsi baru bersifat GLOBAL, sehingga tidak
-- dapat dicabut per schema (seperti di 004). Akibatnya fungsi yang dibuat setelah 004 kembali
-- dapat dieksekusi role lain, termasuk anon/authenticated milik Data API Supabase
-- (terdeteksi oleh supabase.test.ts). Cabut secara global untuk objek buatan pemilik skema,
-- lalu cabut dari semua fungsi yang sudah ada. Role aplikasi memakai GRANT eksplisit.
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
    END IF;
  END LOOP;
END $$;
