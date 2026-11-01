-- Keputusan 2026-11-01:
-- (1) Login memakai username. Undangan dikirim lewat WhatsApp, tanpa email. Akun lama yang
--     memakai email tetap dapat masuk dengan emailnya.
-- (2) Orang tua/wali punya akun sendiri (peran 'wali') dari undangan admin/owner, dan hanya
--     melihat data anak yang terhubung ke akunnya.

-- ---------------------------------------------------------------------------
-- Username & nomor WhatsApp
-- ---------------------------------------------------------------------------
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
-- Tanpa '@' agar username tidak pernah bentrok dengan email di kolom login yang sama.
ALTER TABLE users ADD COLUMN username text CONSTRAINT users_username_format CHECK (username ~ '^[a-z0-9][a-z0-9._-]{2,31}$');
ALTER TABLE users ADD COLUMN phone text CONSTRAINT users_phone_format CHECK (phone ~ '^62[0-9]{8,13}$');
ALTER TABLE users ADD CONSTRAINT users_login_identifier CHECK (email IS NOT NULL OR username IS NOT NULL);
CREATE UNIQUE INDEX users_username_key ON users (username);
GRANT UPDATE (username) ON users TO rtka_app;

ALTER TABLE account_tokens ALTER COLUMN email DROP NOT NULL;
ALTER TABLE account_tokens ADD COLUMN phone text CONSTRAINT account_tokens_phone_format CHECK (phone ~ '^62[0-9]{8,13}$');
ALTER TABLE account_tokens ADD CONSTRAINT account_tokens_invite_contact
  CHECK (purpose <> 'undangan' OR email IS NOT NULL OR phone IS NOT NULL);

-- ---------------------------------------------------------------------------
-- Peran wali
-- ---------------------------------------------------------------------------
ALTER TABLE memberships DROP CONSTRAINT memberships_role_check;
ALTER TABLE memberships ADD CONSTRAINT memberships_role_check
  CHECK (role IN ('owner', 'admin', 'terapis', 'keuangan', 'wali'));
ALTER TABLE memberships ADD CONSTRAINT memberships_wali_not_therapist CHECK (role <> 'wali' OR NOT is_therapist);

ALTER TABLE account_tokens DROP CONSTRAINT account_tokens_role_check;
ALTER TABLE account_tokens ADD CONSTRAINT account_tokens_role_check
  CHECK (role IN ('owner', 'admin', 'terapis', 'keuangan', 'wali'));

-- Satu akun wali dapat terhubung ke beberapa anak dalam satu organisasi (satu baris wali per anak).
ALTER TABLE guardians ADD CONSTRAINT guardians_org_id_key UNIQUE (organization_id, id);
ALTER TABLE guardians ADD COLUMN member_id uuid;
ALTER TABLE guardians ADD CONSTRAINT guardians_member_fk FOREIGN KEY (organization_id, member_id)
  REFERENCES memberships (organization_id, id);
CREATE INDEX guardians_member_idx ON guardians (organization_id, member_id) WHERE member_id IS NOT NULL;

-- Undangan wali gugur bersama baris walinya (mis. saat data wali dihapus atau pasien dianonimkan).
ALTER TABLE account_tokens ADD COLUMN guardian_id uuid;
ALTER TABLE account_tokens ADD CONSTRAINT account_tokens_guardian_fk FOREIGN KEY (organization_id, guardian_id)
  REFERENCES guardians (organization_id, id) ON DELETE CASCADE;
ALTER TABLE account_tokens ADD CONSTRAINT account_tokens_wali_guardian
  CHECK (role IS DISTINCT FROM 'wali' OR guardian_id IS NOT NULL);

-- ---------------------------------------------------------------------------
-- RLS mode portal: baca-saja, hanya anak yang terhubung ke akun wali ini.
-- Kebijakan baru bersifat tambahan dan khusus SELECT; kebijakan staf tidak diubah.
-- Catatan terapi hanya yang berstatus final (keputusan 1 Nov 2026); draf, riwayat revisi,
-- dokumen, dan program terapi sengaja tidak mendapat kebijakan portal.
-- ---------------------------------------------------------------------------
CREATE POLICY guardians_portal ON guardians FOR SELECT USING (
  app_mode() = 'portal' AND organization_id = app_org_id() AND member_id = app_member_id()
);

CREATE FUNCTION app_is_guardian(p_org uuid, p_patient uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app_mode() = 'portal' AND p_org = app_org_id() AND EXISTS (
    SELECT 1 FROM guardians g
    WHERE g.organization_id = p_org
      AND g.patient_id = p_patient
      AND g.member_id = app_member_id())
$$;
REVOKE ALL ON FUNCTION app_is_guardian(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_is_guardian(uuid, uuid) TO rtka_app;

CREATE POLICY patients_portal ON patients FOR SELECT USING (app_is_guardian(organization_id, id));

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['appointments', 'patient_packages', 'invoices', 'payments', 'refunds'] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT USING (app_is_guardian(organization_id, patient_id))',
      t || '_portal', t);
  END LOOP;
END $$;

CREATE POLICY therapy_notes_portal ON therapy_notes FOR SELECT USING (
  status = 'final' AND app_is_guardian(organization_id, patient_id)
);

-- Penutup eksplisit (RESTRICTIVE) untuk mode portal. Revisi menumpang kebijakan catatan induknya,
-- padahal orang tua hanya boleh membaca versi terbaru; tabel lain terbuka sebatas organisasi atau
-- untuk semua mode, dan tidak dibutuhkan dasbor orang tua.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['therapy_note_revisions', 'patient_therapists', 'package_types', 'org_counters', 'notification_log', 'sessions'] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON %I AS RESTRICTIVE FOR SELECT USING (app_mode() IS DISTINCT FROM ''portal'')',
      t || '_no_portal', t);
  END LOOP;
END $$;

-- Nama staf tetap terbaca untuk menampilkan terapis; akun orang tua lain tidak.
CREATE POLICY memberships_portal_limit ON memberships AS RESTRICTIVE FOR SELECT USING (
  app_mode() IS DISTINCT FROM 'portal' OR user_id = app_user_id() OR role <> 'wali'
);
CREATE POLICY users_portal_limit ON users AS RESTRICTIVE FOR SELECT USING (
  app_mode() IS DISTINCT FROM 'portal' OR id = app_user_id()
  OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = users.id AND m.organization_id = app_org_id())
);

-- Aktivasi menghubungkan wali ke akunnya, hanya dengan undangan sah untuk baris wali tersebut.
CREATE POLICY guardians_activation_select ON guardians FOR SELECT USING (
  app_mode() = 'auth' AND EXISTS (
    SELECT 1 FROM account_tokens t
    WHERE t.token_hash = app_token_hash()
      AND t.purpose = 'undangan'
      AND t.used_at IS NULL
      AND t.revoked_at IS NULL
      AND t.expires_at > now()
      AND t.organization_id = guardians.organization_id
      AND t.guardian_id = guardians.id)
);
CREATE POLICY guardians_activation_update ON guardians FOR UPDATE
  USING (
    app_mode() = 'auth' AND EXISTS (
      SELECT 1 FROM account_tokens t
      WHERE t.token_hash = app_token_hash()
        AND t.purpose = 'undangan'
        AND t.used_at IS NULL
        AND t.revoked_at IS NULL
        AND t.expires_at > now()
        AND t.organization_id = guardians.organization_id
        AND t.guardian_id = guardians.id)
  )
  WITH CHECK (app_mode() = 'auth');
