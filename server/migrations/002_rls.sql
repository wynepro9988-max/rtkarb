-- 002_rls.sql
-- Row-Level Security sebagai lapisan pertahanan kedua di bawah otorisasi aplikasi.
-- Aplikasi web terhubung sebagai role non-owner tanpa BYPASSRLS, sehingga setiap
-- query hanya melihat baris organisasi aktif. Tanpa konteks -> tidak ada baris.

-- ---------------------------------------------------------------------------
-- Fungsi visibilitas (berjalan sebagai pemanggil, sehingga RLS tetap berlaku)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_patient_visible(p_org uuid, p_patient uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT p_org = app_org_id() AND (
    app_scope('patient') = 'all'
    OR (app_scope('patient') = 'assigned' AND EXISTS (
      SELECT 1 FROM patient_therapists pt
      WHERE pt.organization_id = p_org
        AND pt.patient_id = p_patient
        AND pt.member_id = app_member_id()))
  )
$$;

CREATE FUNCTION app_note_visible(p_org uuid, p_patient uuid, p_author uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT p_org = app_org_id() AND (
    app_scope('note') = 'all'
    OR (app_scope('note') = 'assigned' AND (
      p_author = app_member_id()
      OR EXISTS (
        SELECT 1 FROM patient_therapists pt
        WHERE pt.organization_id = p_org
          AND pt.patient_id = p_patient
          AND pt.member_id = app_member_id())))
  )
$$;

-- ---------------------------------------------------------------------------
-- Organisasi & identitas
-- ---------------------------------------------------------------------------
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY organizations_select ON organizations FOR SELECT USING (
  id = app_org_id()
  OR app_mode() = 'platform'
  OR EXISTS (SELECT 1 FROM memberships m WHERE m.organization_id = organizations.id AND m.user_id = app_user_id())
  OR (app_mode() = 'auth' AND EXISTS (
    SELECT 1 FROM account_tokens t WHERE t.organization_id = organizations.id AND t.token_hash = app_token_hash()))
);
CREATE POLICY organizations_update ON organizations FOR UPDATE
  USING (id = app_org_id() AND app_mode() = 'tenant')
  WITH CHECK (id = app_org_id());

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_select ON users FOR SELECT USING (
  id = app_user_id()
  OR app_mode() = 'auth'
  OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = users.id AND m.organization_id = app_org_id())
);
CREATE POLICY users_insert ON users FOR INSERT WITH CHECK (app_mode() = 'auth' AND platform_role IS NULL);
CREATE POLICY users_update ON users FOR UPDATE
  USING (id = app_user_id() OR app_mode() = 'auth')
  WITH CHECK (true);

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY memberships_select ON memberships FOR SELECT USING (
  organization_id = app_org_id() OR user_id = app_user_id()
);
-- Keanggotaan baru hanya lahir dari undangan yang sah dan belum dipakai,
-- dengan organisasi & peran yang sama persis dengan undangan.
CREATE POLICY memberships_insert ON memberships FOR INSERT WITH CHECK (
  app_mode() = 'auth' AND EXISTS (
    SELECT 1 FROM account_tokens t
    WHERE t.token_hash = app_token_hash()
      AND t.purpose = 'undangan'
      AND t.used_at IS NULL
      AND t.revoked_at IS NULL
      AND t.expires_at > now()
      AND t.organization_id = memberships.organization_id
      AND t.role = memberships.role)
);
CREATE POLICY memberships_update ON memberships FOR UPDATE
  USING (organization_id = app_org_id() AND app_mode() = 'tenant')
  WITH CHECK (organization_id = app_org_id());

ALTER TABLE account_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY account_tokens_select ON account_tokens FOR SELECT USING (
  (organization_id = app_org_id() AND app_mode() = 'tenant')
  OR (app_mode() = 'auth' AND token_hash = app_token_hash())
);
-- Undangan owner tidak dapat dibuat oleh aplikasi; hanya lewat CLI administrasi.
CREATE POLICY account_tokens_insert ON account_tokens FOR INSERT WITH CHECK (
  organization_id = app_org_id() AND app_mode() = 'tenant' AND role IS DISTINCT FROM 'owner'
);
CREATE POLICY account_tokens_update ON account_tokens FOR UPDATE
  USING (
    (organization_id = app_org_id() AND app_mode() = 'tenant')
    OR (app_mode() = 'auth' AND token_hash = app_token_hash())
  )
  WITH CHECK (
    (organization_id = app_org_id() AND app_mode() = 'tenant')
    OR (app_mode() = 'auth' AND token_hash = app_token_hash())
  );

ALTER TABLE support_access_grants ENABLE ROW LEVEL SECURITY;
CREATE POLICY support_grants_select ON support_access_grants FOR SELECT USING (
  (organization_id = app_org_id() AND app_mode() = 'tenant')
  OR (app_mode() = 'platform' AND requested_by = app_user_id())
);
CREATE POLICY support_grants_insert ON support_access_grants FOR INSERT WITH CHECK (
  app_mode() = 'platform' AND requested_by = app_user_id() AND status = 'menunggu'
);
-- Hanya pengguna tenant (bukan mode dukungan) yang dapat memutuskan/mencabut.
CREATE POLICY support_grants_update ON support_access_grants FOR UPDATE
  USING (organization_id = app_org_id() AND app_mode() = 'tenant')
  WITH CHECK (organization_id = app_org_id());

-- ---------------------------------------------------------------------------
-- Tabel yang cukup dibatasi per organisasi
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['org_counters', 'therapy_services', 'package_types', 'patient_therapists'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (organization_id = app_org_id()) WITH CHECK (organization_id = app_org_id())',
      t || '_tenant', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Data pasien (dibatasi cakupan: semua pasien / pasien yang ditugaskan)
-- ---------------------------------------------------------------------------
ALTER TABLE patients ENABLE ROW LEVEL SECURITY;
CREATE POLICY patients_select ON patients FOR SELECT USING (app_patient_visible(organization_id, id));
CREATE POLICY patients_insert ON patients FOR INSERT WITH CHECK (
  organization_id = app_org_id() AND app_scope('patient') = 'all'
);
CREATE POLICY patients_update ON patients FOR UPDATE
  USING (app_patient_visible(organization_id, id))
  WITH CHECK (organization_id = app_org_id());

ALTER TABLE guardians ENABLE ROW LEVEL SECURITY;
CREATE POLICY guardians_all ON guardians
  USING (app_patient_visible(organization_id, patient_id))
  WITH CHECK (app_patient_visible(organization_id, patient_id));

ALTER TABLE patient_packages ENABLE ROW LEVEL SECURITY;
CREATE POLICY patient_packages_all ON patient_packages
  USING (app_patient_visible(organization_id, patient_id))
  WITH CHECK (app_patient_visible(organization_id, patient_id));

ALTER TABLE package_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY package_ledger_all ON package_ledger
  USING (app_patient_visible(organization_id, patient_id))
  WITH CHECK (app_patient_visible(organization_id, patient_id));

ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
CREATE POLICY appointments_select ON appointments FOR SELECT USING (
  organization_id = app_org_id()
  AND (app_patient_visible(organization_id, patient_id) OR therapist_member_id = app_member_id())
);
CREATE POLICY appointments_insert ON appointments FOR INSERT WITH CHECK (
  organization_id = app_org_id() AND app_scope('patient') = 'all'
);
CREATE POLICY appointments_update ON appointments FOR UPDATE
  USING (
    organization_id = app_org_id()
    AND (app_patient_visible(organization_id, patient_id) OR therapist_member_id = app_member_id())
  )
  WITH CHECK (organization_id = app_org_id());

-- Berkas klinis mengikuti cakupan catatan klinis; berkas administrasi mengikuti cakupan pasien.
ALTER TABLE patient_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY patient_documents_all ON patient_documents
  USING (
    app_patient_visible(organization_id, patient_id)
    AND (category = 'administrasi' OR app_scope('note') <> 'none')
  )
  WITH CHECK (
    app_patient_visible(organization_id, patient_id)
    AND (category = 'administrasi' OR app_scope('note') <> 'none')
  );

-- ---------------------------------------------------------------------------
-- Catatan klinis: hanya penulis yang dapat menulis/mengubah catatannya.
-- ---------------------------------------------------------------------------
ALTER TABLE therapy_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY therapy_notes_select ON therapy_notes FOR SELECT USING (
  app_note_visible(organization_id, patient_id, author_member_id)
);
CREATE POLICY therapy_notes_insert ON therapy_notes FOR INSERT WITH CHECK (
  author_member_id = app_member_id()
  AND app_note_visible(organization_id, patient_id, author_member_id)
  AND (app_scope('note') = 'all' OR EXISTS (
    SELECT 1 FROM patient_therapists pt
    WHERE pt.organization_id = therapy_notes.organization_id
      AND pt.patient_id = therapy_notes.patient_id
      AND pt.member_id = app_member_id()))
);
CREATE POLICY therapy_notes_update ON therapy_notes FOR UPDATE
  USING (author_member_id = app_member_id() AND app_note_visible(organization_id, patient_id, author_member_id))
  WITH CHECK (organization_id = app_org_id() AND author_member_id = app_member_id());

ALTER TABLE therapy_note_revisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY therapy_note_revisions_select ON therapy_note_revisions FOR SELECT USING (
  organization_id = app_org_id() AND EXISTS (
    SELECT 1 FROM therapy_notes n
    WHERE n.organization_id = therapy_note_revisions.organization_id AND n.id = therapy_note_revisions.note_id)
);
CREATE POLICY therapy_note_revisions_insert ON therapy_note_revisions FOR INSERT WITH CHECK (
  organization_id = app_org_id() AND edited_by_member_id = app_member_id() AND EXISTS (
    SELECT 1 FROM therapy_notes n
    WHERE n.organization_id = therapy_note_revisions.organization_id
      AND n.id = therapy_note_revisions.note_id
      AND n.author_member_id = app_member_id())
);

-- ---------------------------------------------------------------------------
-- Keuangan: hanya cakupan keuangan; kompensasi juga terlihat oleh terapis ybs.
-- ---------------------------------------------------------------------------
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY payments_all ON payments
  USING (organization_id = app_org_id() AND app_scope('finance') = 'all')
  WITH CHECK (organization_id = app_org_id() AND app_scope('finance') = 'all');

ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
CREATE POLICY expenses_all ON expenses
  USING (organization_id = app_org_id() AND app_scope('finance') = 'all')
  WITH CHECK (organization_id = app_org_id() AND app_scope('finance') = 'all');

ALTER TABLE compensation_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY compensation_rules_select ON compensation_rules FOR SELECT USING (
  organization_id = app_org_id() AND (app_scope('finance') = 'all' OR member_id = app_member_id())
);
CREATE POLICY compensation_rules_insert ON compensation_rules FOR INSERT WITH CHECK (
  organization_id = app_org_id() AND app_scope('finance') = 'all'
);
CREATE POLICY compensation_rules_update ON compensation_rules FOR UPDATE
  USING (organization_id = app_org_id() AND app_scope('finance') = 'all')
  WITH CHECK (organization_id = app_org_id() AND app_scope('finance') = 'all');

ALTER TABLE therapist_compensations ENABLE ROW LEVEL SECURITY;
CREATE POLICY therapist_compensations_select ON therapist_compensations FOR SELECT USING (
  organization_id = app_org_id() AND (app_scope('finance') = 'all' OR member_id = app_member_id())
);
CREATE POLICY therapist_compensations_update ON therapist_compensations FOR UPDATE
  USING (organization_id = app_org_id() AND app_scope('finance') = 'all')
  WITH CHECK (organization_id = app_org_id() AND app_scope('finance') = 'all');
-- INSERT hanya melalui fungsi compute_compensation (SECURITY DEFINER) di bawah.

-- ---------------------------------------------------------------------------
-- Audit log
-- ---------------------------------------------------------------------------
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_logs_select ON audit_logs FOR SELECT USING (
  organization_id = app_org_id() AND app_scope('audit') = 'all'
);
CREATE POLICY audit_logs_insert ON audit_logs FOR INSERT WITH CHECK (
  organization_id IS NULL
  OR organization_id = app_org_id()
  OR app_mode() IN ('auth', 'platform')
);

-- ---------------------------------------------------------------------------
-- Perhitungan kompensasi sesi selesai. SECURITY DEFINER agar dapat membaca
-- aturan kompensasi walaupun sesi diselesaikan oleh peran tanpa akses keuangan,
-- namun tetap dikunci ke organisasi aktif.
-- ---------------------------------------------------------------------------
CREATE FUNCTION compute_compensation(p_appointment_id uuid) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_org   uuid := app_org_id();
  a       record;
  r       record;
  v_date  date;
  v_base  bigint;
  v_amt   bigint;
BEGIN
  IF v_org IS NULL OR app_mode() <> 'tenant' THEN
    RAISE EXCEPTION 'konteks organisasi tidak valid' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT ap.*, o.timezone, pp.price AS package_price, pp.sessions_total AS package_sessions
    INTO a
    FROM appointments ap
    JOIN organizations o ON o.id = ap.organization_id
    LEFT JOIN patient_packages pp
      ON pp.organization_id = ap.organization_id AND pp.id = ap.patient_package_id
   WHERE ap.id = p_appointment_id AND ap.organization_id = v_org AND ap.status = 'selesai';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'sesi tidak valid untuk perhitungan kompensasi' USING ERRCODE = 'check_violation';
  END IF;

  v_date := (a.starts_at AT TIME ZONE a.timezone)::date;

  SELECT * INTO r FROM compensation_rules cr
   WHERE cr.organization_id = v_org
     AND cr.member_id = a.therapist_member_id
     AND (cr.service_id IS NULL OR cr.service_id = a.service_id)
     AND cr.effective_from <= v_date
     AND (cr.effective_to IS NULL OR cr.effective_to >= v_date)
   ORDER BY (cr.service_id IS NULL), cr.effective_from DESC
   LIMIT 1;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  v_base := CASE a.billing
    WHEN 'per_sesi' THEN a.price
    WHEN 'paket' THEN round(a.package_price::numeric / a.package_sessions)::bigint
    ELSE 0 END;

  v_amt := CASE r.scheme
    WHEN 'tetap_per_sesi' THEN r.amount
    ELSE round(v_base * r.percent / 100)::bigint END;

  INSERT INTO therapist_compensations
    (organization_id, member_id, appointment_id, rule_id, session_date, basis, amount)
  VALUES (
    v_org, a.therapist_member_id, a.id, r.id, v_date,
    jsonb_build_object(
      'skema', r.scheme,
      'nominal_tetap', r.amount,
      'persen', r.percent,
      'jenis_tagihan', a.billing,
      'dasar_tarif', v_base),
    v_amt);
  RETURN v_amt;
END $$;
