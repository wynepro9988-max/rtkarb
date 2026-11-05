-- Keputusan owner 5 Nov 2026: formulir Google "PENDAFTARAN PASIEN BARU" dipindah ke aplikasi.
-- Orang tua mengisi halaman publik /daftar/<token> (tanpa akun). Kiriman masuk sebagai
-- pendaftaran online yang diperiksa admin/owner: diterima menjadi pasien (No. RM terbit) lalu
-- dijadwalkan asesmen, atau ditolak dengan alasan. Data berisi keluhan, jadi hanya owner dan
-- admin (cakupan intake 'all') yang dapat membacanya.

ALTER TABLE organizations
  ADD COLUMN registration_token text CONSTRAINT organizations_registration_token_format CHECK (registration_token ~ '^[A-Za-z0-9_-]{20,64}$'),
  ADD COLUMN registration_open boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX organizations_registration_token_key ON organizations (registration_token) WHERE registration_token IS NOT NULL;
GRANT UPDATE (registration_token, registration_open) ON organizations TO rtka_app;

CREATE TABLE registration_requests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES organizations (id),
  child_name            text NOT NULL CHECK (char_length(btrim(child_name)) BETWEEN 2 AND 150),
  birth_place           text NOT NULL CHECK (char_length(btrim(birth_place)) BETWEEN 2 AND 100),
  birth_date            date NOT NULL,
  guardian_name         text NOT NULL CHECK (char_length(btrim(guardian_name)) BETWEEN 2 AND 150),
  guardian_relationship text NOT NULL CHECK (guardian_relationship IN ('Ibu', 'Ayah', 'Wali')),
  phone                 text NOT NULL CHECK (phone ~ '^62[0-9]{8,13}$'),
  address               text NOT NULL CHECK (char_length(btrim(address)) BETWEEN 3 AND 500),
  complaint             text NOT NULL CHECK (char_length(btrim(complaint)) BETWEEN 2 AND 2000),
  assessment_date       date NOT NULL,
  assessment_time       time NOT NULL,
  status                text NOT NULL DEFAULT 'baru' CHECK (status IN ('baru', 'diterima', 'ditolak')),
  patient_id            uuid,
  decided_by            uuid REFERENCES users (id),
  decided_at            timestamptz,
  reject_reason         text CHECK (char_length(reject_reason) <= 300),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT registration_requests_patient_fk FOREIGN KEY (organization_id, patient_id)
    REFERENCES patients (organization_id, id),
  CONSTRAINT registration_requests_accepted_patient CHECK ((status = 'diterima') = (patient_id IS NOT NULL))
);
CREATE INDEX registration_requests_org_status_idx ON registration_requests (organization_id, status, created_at DESC);

ALTER TABLE registration_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY registration_requests_select ON registration_requests FOR SELECT USING (
  organization_id = app_org_id() AND app_mode() IN ('tenant', 'support') AND app_scope('intake') = 'all'
);
CREATE POLICY registration_requests_update ON registration_requests FOR UPDATE
  USING (organization_id = app_org_id() AND app_mode() = 'tenant' AND app_scope('intake') = 'all')
  WITH CHECK (organization_id = app_org_id());
CREATE POLICY registration_requests_no_portal ON registration_requests AS RESTRICTIVE FOR SELECT USING (app_mode() IS DISTINCT FROM 'portal');
-- INSERT hanya lewat submit_registration() di bawah.
GRANT SELECT ON registration_requests TO rtka_app;
GRANT UPDATE (status, patient_id, decided_by, decided_at, reject_reason) ON registration_requests TO rtka_app;

-- Info halaman publik: nama organisasi dan apakah pendaftaran dibuka. Tanpa data lain.
CREATE FUNCTION public_registration_info(p_token text)
RETURNS TABLE (organization_name text, is_open boolean, today date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT o.name, o.registration_open AND o.status = 'active', (now() AT TIME ZONE o.timezone)::date
    FROM organizations o
   WHERE o.registration_token IS NOT NULL AND o.registration_token = p_token
$$;

-- Menyimpan kiriman formulir publik. Menolak bila tautan salah/ditutup, tanggal tidak masuk akal,
-- atau antrean pendaftaran baru organisasi itu sudah terlalu banyak (perlindungan banjir kiriman).
CREATE FUNCTION submit_registration(
  p_token text, p_child_name text, p_birth_place text, p_birth_date date, p_guardian_name text,
  p_relationship text, p_phone text, p_address text, p_complaint text, p_assessment_date date, p_assessment_time time
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_org   uuid;
  v_today date;
  v_id    uuid;
BEGIN
  SELECT o.id, (now() AT TIME ZONE o.timezone)::date INTO v_org, v_today
    FROM organizations o
   WHERE o.registration_token IS NOT NULL AND o.registration_token = p_token
     AND o.registration_open AND o.status = 'active';
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'pendaftaran tidak tersedia' USING ERRCODE = 'no_data_found';
  END IF;
  IF p_birth_date > v_today OR p_birth_date < v_today - interval '25 years' THEN
    RAISE EXCEPTION 'tanggal lahir tidak valid' USING ERRCODE = 'check_violation';
  END IF;
  IF p_assessment_date < v_today OR p_assessment_date > v_today + 180 THEN
    RAISE EXCEPTION 'tanggal asesmen tidak valid' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(*) FROM registration_requests r WHERE r.organization_id = v_org AND r.status = 'baru') >= 300 THEN
    RAISE EXCEPTION 'antrean pendaftaran penuh' USING ERRCODE = 'program_limit_exceeded';
  END IF;
  INSERT INTO registration_requests
    (organization_id, child_name, birth_place, birth_date, guardian_name, guardian_relationship, phone, address, complaint, assessment_date, assessment_time)
  VALUES (v_org, p_child_name, p_birth_place, p_birth_date, p_guardian_name, p_relationship, p_phone, p_address, p_complaint, p_assessment_date, p_assessment_time)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION public_registration_info(text), submit_registration(text, text, text, date, text, text, text, text, text, date, time) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_registration_info(text), submit_registration(text, text, text, date, text, text, text, text, text, date, time) TO rtka_app;
