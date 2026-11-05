-- Keputusan owner 5 Nov 2026 (docs/00 §24):
-- 1. Jadwal cukup berisi pasien, layanan, dan waktu. Terapis diisi saat absen, sehingga terapis lain
--    dapat menggantikan bila terapis biasanya berhalangan.
-- 2. Terapis absen sendiri: mencari pasien aktif lewat No. RM/nama (hanya identitas ringkas), lalu
--    otomatis tertaut ke pasien itu dan dapat membuka datanya seperti terapis yang ditugaskan.
-- 3. Data pendaftaran klinis (keluhan awal, hasil pemeriksaan, program terapi): owner, admin, dan
--    terapis yang menangani. Keuangan dan orang tua tidak.
-- 4. Video/foto sesi: owner dan terapis yang menangani (cakupan catatan klinis). Admin, keuangan,
--    dan orang tua tidak. Tidak ada penghapusan otomatis; kuota organisasi mencakup berkas ini.

-- ---------------------------------------------------------------------------
-- 1. Jadwal tanpa terapis
-- ---------------------------------------------------------------------------
ALTER TABLE appointments ALTER COLUMN therapist_member_id DROP NOT NULL;
ALTER TABLE appointments ADD CONSTRAINT appointments_done_has_therapist
  CHECK (status <> 'selesai' OR therapist_member_id IS NOT NULL);
GRANT UPDATE (therapist_member_id, service_id) ON appointments TO rtka_app;

-- Terapis boleh mencatat sesinya sendiri untuk pasien yang tertaut kepadanya.
CREATE POLICY appointments_insert_self ON appointments FOR INSERT WITH CHECK (
  organization_id = app_org_id() AND app_mode() = 'tenant'
  AND therapist_member_id = app_member_id()
  AND app_patient_visible(organization_id, patient_id)
);

-- ---------------------------------------------------------------------------
-- 2. Direktori untuk absen (SECURITY DEFINER, hanya untuk terapis aktif di organisasi aktif)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_is_active_therapist() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app_mode() = 'tenant' AND EXISTS (
    SELECT 1 FROM memberships m
     WHERE m.organization_id = app_org_id() AND m.id = app_member_id()
       AND m.status = 'active' AND m.is_therapist)
$$;

-- Pasien aktif: hanya No. RM, nama, panggilan, dan tanggal lahir (tanpa alamat, wali, atau data klinis).
-- p_query adalah pola ILIKE yang sudah di-escape oleh aplikasi.
CREATE FUNCTION app_patient_directory(p_query text, p_id uuid, p_limit integer)
RETURNS TABLE (id uuid, patient_code text, full_name text, nickname text, birth_date date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p.id, p.patient_code, p.full_name, p.nickname, p.birth_date
    FROM patients p
   WHERE app_is_active_therapist()
     AND p.organization_id = app_org_id()
     AND p.status = 'aktif' AND p.anonymized_at IS NULL
     AND (p_id IS NULL OR p.id = p_id)
     AND (p_query IS NULL OR p.full_name ILIKE p_query OR p.patient_code ILIKE p_query OR p.nickname ILIKE p_query)
   ORDER BY p.full_name
   LIMIT least(greatest(coalesce(p_limit, 20), 1), 50)
$$;

-- Jadwal yang belum memiliki terapis pada rentang waktu tertentu (untuk daftar absen).
CREATE FUNCTION app_open_appointments(p_from timestamptz, p_to timestamptz)
RETURNS TABLE (
  id uuid, patient_id uuid, patient_code text, full_name text, nickname text,
  service_id uuid, service_name text, starts_at timestamptz, duration_minutes integer
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT a.id, a.patient_id, p.patient_code, p.full_name, p.nickname, a.service_id, s.name, a.starts_at, a.duration_minutes
    FROM appointments a
    JOIN patients p ON p.organization_id = a.organization_id AND p.id = a.patient_id
    LEFT JOIN therapy_services s ON s.organization_id = a.organization_id AND s.id = a.service_id
   WHERE app_is_active_therapist()
     AND a.organization_id = app_org_id()
     AND a.status = 'terjadwal' AND a.therapist_member_id IS NULL
     AND a.starts_at >= p_from AND a.starts_at < p_to
   ORDER BY a.starts_at
$$;

REVOKE ALL ON FUNCTION app_is_active_therapist(), app_patient_directory(text, uuid, integer), app_open_appointments(timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_is_active_therapist(), app_patient_directory(text, uuid, integer), app_open_appointments(timestamptz, timestamptz) TO rtka_app;

-- ---------------------------------------------------------------------------
-- 3. Pendaftaran: tempat lahir (identitas) dan data klinis awal (tabel terpisah)
-- ---------------------------------------------------------------------------
ALTER TABLE patients ADD COLUMN birth_place text CHECK (char_length(birth_place) <= 100);
GRANT UPDATE (birth_place) ON patients TO rtka_app;

CREATE TABLE patient_intakes (
  organization_id     uuid NOT NULL,
  patient_id          uuid NOT NULL,
  complaint           text CHECK (char_length(complaint) <= 5000),   -- keluhan awal
  findings            text CHECK (char_length(findings) <= 10000),   -- hasil pemeriksaan
  program_service_ids uuid[] NOT NULL DEFAULT '{}',                  -- layanan program terapi (mis. OT, TW)
  program_notes       text CHECK (char_length(program_notes) <= 5000),
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid REFERENCES users (id),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid REFERENCES users (id),
  PRIMARY KEY (organization_id, patient_id),
  CONSTRAINT patient_intakes_patient_fk FOREIGN KEY (organization_id, patient_id)
    REFERENCES patients (organization_id, id),
  CONSTRAINT patient_intakes_services_limit CHECK (cardinality(program_service_ids) <= 10)
);
CREATE TRIGGER patient_intakes_updated_at BEFORE UPDATE ON patient_intakes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Cakupan 'intake': all (owner, admin) | assigned (terapis yang menangani) | none.
CREATE FUNCTION app_intake_visible(p_org uuid, p_patient uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT p_org = app_org_id() AND app_mode() IN ('tenant', 'support') AND (
    app_scope('intake') = 'all'
    OR (app_scope('intake') = 'assigned' AND EXISTS (
      SELECT 1 FROM patient_therapists pt
       WHERE pt.organization_id = p_org AND pt.patient_id = p_patient AND pt.member_id = app_member_id()))
  )
$$;

ALTER TABLE patient_intakes ENABLE ROW LEVEL SECURITY;
CREATE POLICY patient_intakes_all ON patient_intakes
  USING (app_intake_visible(organization_id, patient_id))
  WITH CHECK (app_intake_visible(organization_id, patient_id));
GRANT SELECT, INSERT ON patient_intakes TO rtka_app;
GRANT UPDATE (complaint, findings, program_service_ids, program_notes, updated_by) ON patient_intakes TO rtka_app;

-- ---------------------------------------------------------------------------
-- 4. Video/foto sesi
-- ---------------------------------------------------------------------------
CREATE TABLE session_media (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL,
  patient_id         uuid NOT NULL,
  appointment_id     uuid NOT NULL,
  uploader_member_id uuid NOT NULL,
  kind               text NOT NULL CHECK (kind IN ('video', 'foto')),
  mime_type          text NOT NULL,
  size_bytes         bigint NOT NULL CHECK (size_bytes > 0),
  duration_seconds   numeric(8, 1),
  storage_key        text NOT NULL UNIQUE,
  sha256             text NOT NULL,
  uploaded_by        uuid REFERENCES users (id),
  uploaded_at        timestamptz NOT NULL DEFAULT now(),
  archived_at        timestamptz,
  archived_by        uuid REFERENCES users (id),
  CONSTRAINT session_media_video_min CHECK (kind <> 'video' OR duration_seconds >= 30),
  CONSTRAINT session_media_appointment_fk FOREIGN KEY (organization_id, patient_id, appointment_id)
    REFERENCES appointments (organization_id, patient_id, id),
  CONSTRAINT session_media_uploader_fk FOREIGN KEY (organization_id, uploader_member_id)
    REFERENCES memberships (organization_id, id)
);
CREATE INDEX session_media_appointment_idx ON session_media (organization_id, appointment_id);
CREATE INDEX session_media_patient_idx ON session_media (organization_id, patient_id, uploaded_at DESC);

CREATE FUNCTION app_media_visible(p_org uuid, p_patient uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT p_org = app_org_id() AND app_mode() IN ('tenant', 'support') AND (
    app_scope('note') = 'all'
    OR (app_scope('note') = 'assigned' AND EXISTS (
      SELECT 1 FROM patient_therapists pt
       WHERE pt.organization_id = p_org AND pt.patient_id = p_patient AND pt.member_id = app_member_id()))
  )
$$;

ALTER TABLE session_media ENABLE ROW LEVEL SECURITY;
CREATE POLICY session_media_select ON session_media FOR SELECT USING (app_media_visible(organization_id, patient_id));
CREATE POLICY session_media_insert ON session_media FOR INSERT WITH CHECK (
  app_media_visible(organization_id, patient_id) AND app_mode() = 'tenant' AND uploader_member_id = app_member_id()
);
CREATE POLICY session_media_update ON session_media FOR UPDATE
  USING (app_media_visible(organization_id, patient_id) AND app_mode() = 'tenant')
  WITH CHECK (organization_id = app_org_id());
GRANT SELECT, INSERT ON session_media TO rtka_app;
GRANT UPDATE (archived_at, archived_by) ON session_media TO rtka_app;

REVOKE ALL ON FUNCTION app_intake_visible(uuid, uuid), app_media_visible(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_intake_visible(uuid, uuid), app_media_visible(uuid, uuid) TO rtka_app;

-- Penutup eksplisit untuk dasbor orang tua.
CREATE POLICY patient_intakes_no_portal ON patient_intakes AS RESTRICTIVE FOR SELECT USING (app_mode() IS DISTINCT FROM 'portal');
CREATE POLICY session_media_no_portal ON session_media AS RESTRICTIVE FOR SELECT USING (app_mode() IS DISTINCT FROM 'portal');

-- Kuota penyimpanan organisasi mencakup video/foto sesi.
CREATE OR REPLACE FUNCTION org_storage_bytes() RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT (SELECT coalesce(sum(size_bytes), 0) FROM patient_documents WHERE organization_id = app_org_id())
       + (SELECT coalesce(sum(size_bytes), 0) FROM session_media WHERE organization_id = app_org_id())
$$;

CREATE OR REPLACE FUNCTION platform_usage() RETURNS TABLE (
  org_id uuid, org_name text, storage_bytes bigint, patient_count bigint, note_count bigint, audit_rows bigint, db_bytes bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF app_mode() <> 'platform' THEN
    RAISE EXCEPTION 'hanya untuk admin teknis platform' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT o.id, o.name,
           (SELECT coalesce(sum(d.size_bytes), 0)::bigint FROM patient_documents d WHERE d.organization_id = o.id)
             + (SELECT coalesce(sum(m.size_bytes), 0)::bigint FROM session_media m WHERE m.organization_id = o.id),
           (SELECT count(*) FROM patients p WHERE p.organization_id = o.id),
           (SELECT count(*) FROM therapy_notes n WHERE n.organization_id = o.id),
           (SELECT count(*) FROM audit_logs a WHERE a.organization_id = o.id),
           pg_database_size(current_database())
      FROM organizations o ORDER BY o.name;
END $$;

-- ---------------------------------------------------------------------------
-- Anonimisasi: tempat lahir serta video/foto anak (mengenali wajah anak) ikut dihapus pada kedua
-- mode; data klinis pendaftaran dikosongkan pada mode penuh.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION anonymize_patient(p_patient_id uuid, p_mode text) RETURNS text[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_org  uuid := app_org_id();
  v_code text;
  v_keys text[];
  v_media text[];
BEGIN
  IF v_org IS NULL OR app_mode() <> 'tenant' OR app_scope('audit') <> 'all' THEN
    RAISE EXCEPTION 'tidak diizinkan' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_mode NOT IN ('identitas', 'penuh') THEN
    RAISE EXCEPTION 'mode tidak dikenal' USING ERRCODE = 'check_violation';
  END IF;
  SELECT patient_code INTO v_code FROM patients WHERE organization_id = v_org AND id = p_patient_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pasien tidak ditemukan' USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM set_config('rtka.allow_erasure', 'on', true);

  UPDATE patients
     SET full_name = 'Data dihapus (' || v_code || ')', nickname = NULL, birth_date = NULL, birth_place = NULL, sex = NULL,
         address = NULL, admin_notes = NULL, status = 'nonaktif', anonymized_at = now()
   WHERE organization_id = v_org AND id = p_patient_id;
  DELETE FROM guardians WHERE organization_id = v_org AND patient_id = p_patient_id;
  UPDATE appointments SET admin_notes = NULL, cancel_reason = NULL WHERE organization_id = v_org AND patient_id = p_patient_id;
  UPDATE data_requests SET requester_name = 'Data dihapus', requester_relation = NULL, details = NULL
   WHERE organization_id = v_org AND patient_id = p_patient_id;
  UPDATE payments SET notes = NULL WHERE organization_id = v_org AND patient_id = p_patient_id;
  UPDATE invoices SET notes = NULL WHERE organization_id = v_org AND patient_id = p_patient_id;

  SELECT coalesce(array_agg(storage_key), '{}') INTO v_keys
    FROM patient_documents WHERE organization_id = v_org AND patient_id = p_patient_id;
  UPDATE patient_documents
     SET title = 'Dokumen dihapus', original_name = 'dihapus', archived_at = coalesce(archived_at, now())
   WHERE organization_id = v_org AND patient_id = p_patient_id;

  SELECT coalesce(array_agg(storage_key), '{}') INTO v_media
    FROM session_media WHERE organization_id = v_org AND patient_id = p_patient_id;
  UPDATE session_media SET archived_at = coalesce(archived_at, now())
   WHERE organization_id = v_org AND patient_id = p_patient_id;

  IF p_mode = 'penuh' THEN
    UPDATE therapy_notes
       SET objectives = NULL, activities = NULL, home_program = NULL, next_plan = NULL,
           observations = 'Isi catatan dihapus atas permintaan penghapusan data.'
     WHERE organization_id = v_org AND patient_id = p_patient_id;
    DELETE FROM therapy_note_revisions r USING therapy_notes n
     WHERE r.organization_id = v_org AND n.organization_id = v_org AND r.note_id = n.id AND n.patient_id = p_patient_id;
    UPDATE goal_progress SET note = NULL WHERE organization_id = v_org AND patient_id = p_patient_id;
    UPDATE program_goals SET description = 'Dihapus', success_criteria = NULL WHERE organization_id = v_org AND patient_id = p_patient_id;
    UPDATE therapy_programs SET title = 'Dihapus', summary = NULL, end_reason = NULL WHERE organization_id = v_org AND patient_id = p_patient_id;
    UPDATE patient_intakes SET complaint = NULL, findings = NULL, program_notes = NULL
     WHERE organization_id = v_org AND patient_id = p_patient_id;
  END IF;
  RETURN v_keys || v_media;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Login orang tua dengan No. RM: undangan wali menyimpan No. RM anak sebagai saran username.
-- ---------------------------------------------------------------------------
ALTER TABLE account_tokens ADD COLUMN suggested_username text
  CONSTRAINT account_tokens_suggested_username_format CHECK (suggested_username ~ '^[a-z0-9][a-z0-9._-]{2,31}$');

-- ---------------------------------------------------------------------------
-- 6. Jenis berkas pendaftaran. Foto informed consent wajib di formulir Pasien Baru; pasien tanpa
--    consent (mis. hasil impor) ditandai di daftar dan halaman pasien.
-- ---------------------------------------------------------------------------
ALTER TABLE patient_documents ADD COLUMN doc_type text
  CONSTRAINT patient_documents_doc_type_check CHECK (doc_type IN ('informed_consent', 'ktp_ortu', 'kia', 'foto_anak'));
CREATE INDEX patient_documents_consent_idx ON patient_documents (organization_id, patient_id)
  WHERE doc_type = 'informed_consent' AND archived_at IS NULL;
