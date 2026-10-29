-- 001_schema.sql
-- Skema inti RTKA Rumah Bintang.
-- Prinsip: setiap data bisnis memiliki organization_id, dan relasi antar-tabel
-- memakai foreign key komposit (organization_id, ...) sehingga database menolak
-- relasi lintas organisasi walaupun kode aplikasi keliru.

-- ---------------------------------------------------------------------------
-- Fungsi konteks permintaan. Nilai di-set per transaksi oleh aplikasi
-- (SET LOCAL / set_config(..., true)) dan dipakai oleh kebijakan RLS.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_setting(p_name text) RETURNS text
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting(p_name, true), '') $$;

CREATE FUNCTION app_org_id() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT app_setting('app.org_id')::uuid $$;

CREATE FUNCTION app_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT app_setting('app.user_id')::uuid $$;

CREATE FUNCTION app_member_id() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT app_setting('app.member_id')::uuid $$;

-- 'tenant' | 'support' | 'auth' | 'platform' | 'none'
CREATE FUNCTION app_mode() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT coalesce(app_setting('app.mode'), 'none') $$;

-- Cakupan akses: patient | note | finance | audit -> 'all' | 'assigned' | 'none'
CREATE FUNCTION app_scope(p_name text) RETURNS text
LANGUAGE sql STABLE AS $$ SELECT coalesce(app_setting('app.scope_' || p_name), 'none') $$;

CREATE FUNCTION app_token_hash() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT app_setting('app.token_hash') $$;

CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE FUNCTION reject_modification() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'tabel % bersifat append-only', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END $$;

-- ---------------------------------------------------------------------------
-- Organisasi (tenant) dan identitas
-- ---------------------------------------------------------------------------
CREATE TABLE organizations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 2 AND 200),
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  timezone             text NOT NULL DEFAULT 'Asia/Jakarta'
                       CHECK (timezone IN ('Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura')),
  patient_code_prefix  text NOT NULL DEFAULT 'RB' CHECK (patient_code_prefix ~ '^[A-Z0-9]{1,8}$'),
  receipt_prefix       text NOT NULL DEFAULT 'KW' CHECK (receipt_prefix ~ '^[A-Z0-9]{1,8}$'),
  address              text CHECK (char_length(address) <= 500),
  phone                text CHECK (char_length(phone) <= 40),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER organizations_updated_at BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email               text NOT NULL CHECK (email = lower(btrim(email)) AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  full_name           text NOT NULL CHECK (char_length(btrim(full_name)) BETWEEN 2 AND 150),
  password_hash       text NOT NULL,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  platform_role       text CHECK (platform_role IN ('platform_admin')),
  failed_login_count  integer NOT NULL DEFAULT 0,
  locked_until        timestamptz,
  last_login_at       timestamptz,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (email);
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Keanggotaan: satu pengguna hanya pada satu organisasi (ruang lingkup awal).
CREATE TABLE memberships (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  user_id         uuid NOT NULL REFERENCES users (id),
  role            text NOT NULL CHECK (role IN ('owner', 'admin', 'terapis', 'keuangan')),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  is_therapist    boolean NOT NULL DEFAULT false,
  specialization  text CHECK (char_length(specialization) <= 120),
  deactivated_at  timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users (id),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES users (id),
  CONSTRAINT memberships_org_id_key UNIQUE (organization_id, id),
  CONSTRAINT memberships_one_org_per_user UNIQUE (user_id),
  CONSTRAINT memberships_therapist_role CHECK (role <> 'terapis' OR is_therapist)
);
CREATE TRIGGER memberships_updated_at BEFORE UPDATE ON memberships
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Penjaga: organisasi/pengguna pada keanggotaan tidak boleh dipindah, dan peran
-- owner hanya dapat diberikan oleh pemilik skema (prosedur administrasi CLI).
CREATE FUNCTION memberships_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organization_id <> OLD.organization_id OR NEW.user_id <> OLD.user_id THEN
    RAISE EXCEPTION 'organisasi dan pengguna pada keanggotaan tidak dapat diubah'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.role = 'owner' AND OLD.role <> 'owner'
     AND current_user <> (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.memberships'::regclass) THEN
    RAISE EXCEPTION 'peran owner hanya dapat diberikan melalui prosedur administrasi'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER memberships_guard BEFORE UPDATE ON memberships
  FOR EACH ROW EXECUTE FUNCTION memberships_guard();

-- Token undangan dan reset kata sandi. Hanya hash yang disimpan.
CREATE TABLE account_tokens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  purpose         text NOT NULL CHECK (purpose IN ('undangan', 'reset_sandi')),
  token_hash      text NOT NULL UNIQUE,
  email           text NOT NULL CHECK (email = lower(btrim(email))),
  full_name       text,
  role            text CHECK (role IN ('owner', 'admin', 'terapis', 'keuangan')),
  is_therapist    boolean NOT NULL DEFAULT false,
  specialization  text,
  user_id         uuid REFERENCES users (id),
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz,
  revoked_at      timestamptz,
  created_by      uuid REFERENCES users (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT account_tokens_purpose_fields CHECK (
    (purpose = 'undangan' AND role IS NOT NULL AND full_name IS NOT NULL)
    OR (purpose = 'reset_sandi' AND user_id IS NOT NULL)
  )
);
CREATE INDEX account_tokens_org_idx ON account_tokens (organization_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Akses dukungan teknis terbatas (deny by default, berbatas waktu, disetujui owner)
-- ---------------------------------------------------------------------------
CREATE TABLE support_access_grants (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations (id),
  requested_by      uuid NOT NULL REFERENCES users (id),
  requested_by_name text NOT NULL,
  reason            text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 10 AND 1000),
  scopes            text[] NOT NULL CHECK (cardinality(scopes) BETWEEN 1 AND 20),
  duration_minutes  integer NOT NULL CHECK (duration_minutes BETWEEN 15 AND 480),
  status            text NOT NULL DEFAULT 'menunggu'
                    CHECK (status IN ('menunggu', 'disetujui', 'ditolak', 'dicabut')),
  decided_by        uuid REFERENCES users (id),
  decided_at        timestamptz,
  decision_note     text CHECK (char_length(decision_note) <= 1000),
  starts_at         timestamptz,
  expires_at        timestamptz,
  revoked_by        uuid REFERENCES users (id),
  revoked_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT support_no_self_approval CHECK (decided_by IS DISTINCT FROM requested_by),
  CONSTRAINT support_window CHECK (
    status <> 'disetujui' OR (starts_at IS NOT NULL AND expires_at IS NOT NULL AND expires_at > starts_at)
  )
);
CREATE INDEX support_access_grants_org_idx ON support_access_grants (organization_id, created_at DESC);

-- Sesi login (token disimpan sebagai hash).
CREATE TABLE sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash       text NOT NULL UNIQUE,
  user_id          uuid NOT NULL REFERENCES users (id),
  organization_id  uuid REFERENCES organizations (id),
  support_grant_id uuid REFERENCES support_access_grants (id),
  csrf_token       text NOT NULL,
  ip               text,
  user_agent       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  revoked_at       timestamptz
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- Penomoran per organisasi (kode pasien, nomor kuitansi).
CREATE TABLE org_counters (
  organization_id uuid NOT NULL REFERENCES organizations (id),
  name            text NOT NULL,
  value           bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (organization_id, name)
);

-- ---------------------------------------------------------------------------
-- Layanan, pasien, wali, penugasan terapis
-- ---------------------------------------------------------------------------
CREATE TABLE therapy_services (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid NOT NULL REFERENCES organizations (id),
  name                     text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 2 AND 120),
  default_duration_minutes integer NOT NULL DEFAULT 60 CHECK (default_duration_minutes BETWEEN 5 AND 480),
  default_price            bigint NOT NULL DEFAULT 0 CHECK (default_price >= 0),
  active                   boolean NOT NULL DEFAULT true,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT therapy_services_org_id_key UNIQUE (organization_id, id),
  CONSTRAINT therapy_services_org_name_key UNIQUE (organization_id, name)
);
CREATE TRIGGER therapy_services_updated_at BEFORE UPDATE ON therapy_services
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE patients (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  patient_code    text NOT NULL,
  full_name       text NOT NULL CHECK (char_length(btrim(full_name)) BETWEEN 2 AND 150),
  nickname        text CHECK (char_length(nickname) <= 60),
  birth_date      date,
  sex             text CHECK (sex IN ('L', 'P')),
  status          text NOT NULL DEFAULT 'aktif' CHECK (status IN ('aktif', 'nonaktif', 'selesai')),
  registered_on   date NOT NULL DEFAULT current_date,
  address         text CHECK (char_length(address) <= 500),
  admin_notes     text CHECK (char_length(admin_notes) <= 2000),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users (id),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES users (id),
  CONSTRAINT patients_org_id_key UNIQUE (organization_id, id),
  CONSTRAINT patients_org_code_key UNIQUE (organization_id, patient_code)
);
CREATE INDEX patients_org_status_idx ON patients (organization_id, status, full_name);
CREATE TRIGGER patients_updated_at BEFORE UPDATE ON patients
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE guardians (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  patient_id      uuid NOT NULL,
  full_name       text NOT NULL CHECK (char_length(btrim(full_name)) BETWEEN 2 AND 150),
  relationship    text NOT NULL CHECK (char_length(btrim(relationship)) BETWEEN 2 AND 40),
  phone           text CHECK (char_length(phone) <= 40),
  email           text CHECK (char_length(email) <= 200),
  address         text CHECK (char_length(address) <= 500),
  is_primary      boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users (id),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES users (id),
  CONSTRAINT guardians_patient_fk FOREIGN KEY (organization_id, patient_id)
    REFERENCES patients (organization_id, id)
);
CREATE INDEX guardians_patient_idx ON guardians (organization_id, patient_id);
CREATE TRIGGER guardians_updated_at BEFORE UPDATE ON guardians
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Penugasan terapis ke pasien: dasar akses terapis ke data pasien & catatan.
CREATE TABLE patient_therapists (
  organization_id uuid NOT NULL,
  patient_id      uuid NOT NULL,
  member_id       uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users (id),
  PRIMARY KEY (organization_id, patient_id, member_id),
  CONSTRAINT patient_therapists_patient_fk FOREIGN KEY (organization_id, patient_id)
    REFERENCES patients (organization_id, id),
  CONSTRAINT patient_therapists_member_fk FOREIGN KEY (organization_id, member_id)
    REFERENCES memberships (organization_id, id)
);
CREATE INDEX patient_therapists_member_idx ON patient_therapists (organization_id, member_id);

-- ---------------------------------------------------------------------------
-- Paket terapi
-- ---------------------------------------------------------------------------
CREATE TABLE package_types (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  name            text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 2 AND 120),
  service_id      uuid,
  sessions_total  integer NOT NULL CHECK (sessions_total BETWEEN 1 AND 500),
  price           bigint NOT NULL CHECK (price >= 0),
  valid_days      integer CHECK (valid_days BETWEEN 1 AND 3650),
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT package_types_org_id_key UNIQUE (organization_id, id),
  CONSTRAINT package_types_org_name_key UNIQUE (organization_id, name),
  CONSTRAINT package_types_service_fk FOREIGN KEY (organization_id, service_id)
    REFERENCES therapy_services (organization_id, id)
);
CREATE TRIGGER package_types_updated_at BEFORE UPDATE ON package_types
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE patient_packages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  patient_id      uuid NOT NULL,
  package_type_id uuid,
  service_id      uuid,
  name            text NOT NULL,
  sessions_total  integer NOT NULL CHECK (sessions_total BETWEEN 1 AND 500),
  sessions_used   integer NOT NULL DEFAULT 0,
  price           bigint NOT NULL CHECK (price >= 0),
  purchased_on    date NOT NULL,
  expires_on      date,
  status          text NOT NULL DEFAULT 'aktif' CHECK (status IN ('aktif', 'selesai', 'dibatalkan')),
  cancel_reason   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users (id),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES users (id),
  CONSTRAINT patient_packages_balance CHECK (sessions_used >= 0 AND sessions_used <= sessions_total),
  CONSTRAINT patient_packages_org_id_key UNIQUE (organization_id, id),
  CONSTRAINT patient_packages_org_patient_id_key UNIQUE (organization_id, patient_id, id),
  CONSTRAINT patient_packages_patient_fk FOREIGN KEY (organization_id, patient_id)
    REFERENCES patients (organization_id, id),
  CONSTRAINT patient_packages_type_fk FOREIGN KEY (organization_id, package_type_id)
    REFERENCES package_types (organization_id, id),
  CONSTRAINT patient_packages_service_fk FOREIGN KEY (organization_id, service_id)
    REFERENCES therapy_services (organization_id, id)
);
CREATE INDEX patient_packages_patient_idx ON patient_packages (organization_id, patient_id);
CREATE TRIGGER patient_packages_updated_at BEFORE UPDATE ON patient_packages
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Jadwal / sesi terapi
-- ---------------------------------------------------------------------------
CREATE TABLE appointments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL,
  patient_id          uuid NOT NULL,
  therapist_member_id uuid NOT NULL,
  service_id          uuid,
  starts_at           timestamptz NOT NULL,
  duration_minutes    integer NOT NULL CHECK (duration_minutes BETWEEN 5 AND 480),
  status              text NOT NULL DEFAULT 'terjadwal'
                      CHECK (status IN ('terjadwal', 'selesai', 'tidak_hadir', 'dibatalkan', 'dijadwal_ulang')),
  billing             text NOT NULL DEFAULT 'per_sesi' CHECK (billing IN ('paket', 'per_sesi', 'tanpa_biaya')),
  patient_package_id  uuid,
  price               bigint NOT NULL DEFAULT 0 CHECK (price >= 0),
  rescheduled_from_id uuid,
  cancel_reason       text CHECK (char_length(cancel_reason) <= 500),
  admin_notes         text CHECK (char_length(admin_notes) <= 1000),
  completed_at        timestamptz,
  completed_by        uuid REFERENCES users (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid REFERENCES users (id),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid REFERENCES users (id),
  CONSTRAINT appointments_billing_package CHECK ((billing = 'paket') = (patient_package_id IS NOT NULL)),
  CONSTRAINT appointments_price_billing CHECK (billing = 'per_sesi' OR price = 0),
  CONSTRAINT appointments_org_id_key UNIQUE (organization_id, id),
  CONSTRAINT appointments_org_patient_id_key UNIQUE (organization_id, patient_id, id),
  CONSTRAINT appointments_patient_fk FOREIGN KEY (organization_id, patient_id)
    REFERENCES patients (organization_id, id),
  CONSTRAINT appointments_therapist_fk FOREIGN KEY (organization_id, therapist_member_id)
    REFERENCES memberships (organization_id, id),
  CONSTRAINT appointments_service_fk FOREIGN KEY (organization_id, service_id)
    REFERENCES therapy_services (organization_id, id),
  -- paket harus milik pasien yang sama pada organisasi yang sama
  CONSTRAINT appointments_package_fk FOREIGN KEY (organization_id, patient_id, patient_package_id)
    REFERENCES patient_packages (organization_id, patient_id, id),
  CONSTRAINT appointments_rescheduled_fk FOREIGN KEY (organization_id, rescheduled_from_id)
    REFERENCES appointments (organization_id, id)
);
CREATE INDEX appointments_org_time_idx ON appointments (organization_id, starts_at);
CREATE INDEX appointments_therapist_idx ON appointments (organization_id, therapist_member_id, starts_at);
CREATE INDEX appointments_patient_idx ON appointments (organization_id, patient_id, starts_at);
CREATE TRIGGER appointments_updated_at BEFORE UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Riwayat saldo paket (append-only).
CREATE TABLE package_ledger (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL,
  patient_id         uuid NOT NULL,
  patient_package_id uuid NOT NULL,
  appointment_id     uuid,
  kind               text NOT NULL CHECK (kind IN ('pemakaian', 'pembatalan_pemakaian', 'penyesuaian')),
  sessions_delta     integer NOT NULL CHECK (sessions_delta <> 0),
  sessions_used_after integer NOT NULL,
  reason             text CHECK (char_length(reason) <= 500),
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid REFERENCES users (id),
  CONSTRAINT package_ledger_package_fk FOREIGN KEY (organization_id, patient_id, patient_package_id)
    REFERENCES patient_packages (organization_id, patient_id, id),
  CONSTRAINT package_ledger_appointment_fk FOREIGN KEY (organization_id, patient_id, appointment_id)
    REFERENCES appointments (organization_id, patient_id, id)
);
CREATE INDEX package_ledger_package_idx ON package_ledger (organization_id, patient_package_id, created_at);
CREATE TRIGGER package_ledger_append_only BEFORE UPDATE OR DELETE ON package_ledger
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

-- ---------------------------------------------------------------------------
-- Catatan terapi + riwayat revisi (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE therapy_notes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL,
  patient_id       uuid NOT NULL,
  appointment_id   uuid,
  author_member_id uuid NOT NULL,
  note_type        text NOT NULL CHECK (note_type IN ('sesi', 'asesmen', 'evaluasi', 'lainnya')),
  status           text NOT NULL DEFAULT 'draf' CHECK (status IN ('draf', 'final')),
  objectives       text CHECK (char_length(objectives) <= 5000),
  activities       text CHECK (char_length(activities) <= 5000),
  observations     text CHECK (char_length(observations) <= 10000),
  home_program     text CHECK (char_length(home_program) <= 5000),
  next_plan        text CHECK (char_length(next_plan) <= 5000),
  revision_no      integer NOT NULL DEFAULT 1,
  finalized_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT therapy_notes_org_id_key UNIQUE (organization_id, id),
  CONSTRAINT therapy_notes_patient_fk FOREIGN KEY (organization_id, patient_id)
    REFERENCES patients (organization_id, id),
  CONSTRAINT therapy_notes_appointment_fk FOREIGN KEY (organization_id, patient_id, appointment_id)
    REFERENCES appointments (organization_id, patient_id, id),
  CONSTRAINT therapy_notes_author_fk FOREIGN KEY (organization_id, author_member_id)
    REFERENCES memberships (organization_id, id)
);
CREATE UNIQUE INDEX therapy_notes_one_per_appointment ON therapy_notes (organization_id, appointment_id)
  WHERE appointment_id IS NOT NULL;
CREATE INDEX therapy_notes_patient_idx ON therapy_notes (organization_id, patient_id, created_at DESC);
CREATE TRIGGER therapy_notes_updated_at BEFORE UPDATE ON therapy_notes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE therapy_note_revisions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL,
  note_id             uuid NOT NULL,
  revision_no         integer NOT NULL,
  status              text NOT NULL CHECK (status IN ('draf', 'final')),
  content             jsonb NOT NULL,
  reason              text CHECK (char_length(reason) <= 500),
  edited_by_member_id uuid NOT NULL,
  edited_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT therapy_note_revisions_unique UNIQUE (organization_id, note_id, revision_no),
  CONSTRAINT therapy_note_revisions_note_fk FOREIGN KEY (organization_id, note_id)
    REFERENCES therapy_notes (organization_id, id),
  CONSTRAINT therapy_note_revisions_editor_fk FOREIGN KEY (organization_id, edited_by_member_id)
    REFERENCES memberships (organization_id, id)
);
CREATE TRIGGER therapy_note_revisions_append_only BEFORE UPDATE OR DELETE ON therapy_note_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

-- ---------------------------------------------------------------------------
-- Berkas pasien (disimpan di luar web root, diakses hanya lewat endpoint terotorisasi)
-- ---------------------------------------------------------------------------
CREATE TABLE patient_documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  patient_id      uuid NOT NULL,
  category        text NOT NULL CHECK (category IN ('administrasi', 'klinis')),
  title           text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 2 AND 150),
  original_name   text NOT NULL CHECK (char_length(original_name) <= 255),
  mime_type       text NOT NULL CHECK (mime_type IN ('application/pdf', 'image/jpeg', 'image/png')),
  size_bytes      integer NOT NULL CHECK (size_bytes > 0),
  storage_key     text NOT NULL UNIQUE,
  sha256          text NOT NULL,
  uploaded_by     uuid REFERENCES users (id),
  uploaded_at     timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz,
  archived_by     uuid REFERENCES users (id),
  CONSTRAINT patient_documents_patient_fk FOREIGN KEY (organization_id, patient_id)
    REFERENCES patients (organization_id, id)
);
CREATE INDEX patient_documents_patient_idx ON patient_documents (organization_id, patient_id);

-- ---------------------------------------------------------------------------
-- Keuangan: pembayaran (kuitansi), pengeluaran
-- ---------------------------------------------------------------------------
CREATE TABLE payments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL,
  receipt_no         text NOT NULL,
  patient_id         uuid NOT NULL,
  patient_package_id uuid,
  appointment_id     uuid,
  paid_on            date NOT NULL,
  amount             bigint NOT NULL CHECK (amount > 0),
  method             text NOT NULL CHECK (method IN ('tunai', 'transfer', 'qris')),
  reference          text CHECK (char_length(reference) <= 120),
  notes              text CHECK (char_length(notes) <= 500),
  status             text NOT NULL DEFAULT 'tercatat' CHECK (status IN ('tercatat', 'dibatalkan')),
  void_reason        text CHECK (char_length(void_reason) <= 500),
  voided_at          timestamptz,
  voided_by          uuid REFERENCES users (id),
  recorded_by        uuid REFERENCES users (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payments_single_target CHECK (num_nonnulls(patient_package_id, appointment_id) <= 1),
  CONSTRAINT payments_void_fields CHECK ((status = 'dibatalkan') = (voided_at IS NOT NULL)),
  CONSTRAINT payments_org_receipt_key UNIQUE (organization_id, receipt_no),
  CONSTRAINT payments_patient_fk FOREIGN KEY (organization_id, patient_id)
    REFERENCES patients (organization_id, id),
  CONSTRAINT payments_package_fk FOREIGN KEY (organization_id, patient_id, patient_package_id)
    REFERENCES patient_packages (organization_id, patient_id, id),
  CONSTRAINT payments_appointment_fk FOREIGN KEY (organization_id, patient_id, appointment_id)
    REFERENCES appointments (organization_id, patient_id, id)
);
CREATE INDEX payments_org_date_idx ON payments (organization_id, paid_on);
CREATE INDEX payments_patient_idx ON payments (organization_id, patient_id);

CREATE TABLE expenses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  spent_on        date NOT NULL,
  category        text NOT NULL CHECK (char_length(btrim(category)) BETWEEN 2 AND 60),
  description     text NOT NULL CHECK (char_length(btrim(description)) BETWEEN 2 AND 500),
  amount          bigint NOT NULL CHECK (amount > 0),
  method          text NOT NULL CHECK (method IN ('tunai', 'transfer', 'qris')),
  reference       text CHECK (char_length(reference) <= 120),
  status          text NOT NULL DEFAULT 'tercatat' CHECK (status IN ('tercatat', 'dibatalkan')),
  void_reason     text CHECK (char_length(void_reason) <= 500),
  voided_at       timestamptz,
  voided_by       uuid REFERENCES users (id),
  recorded_by     uuid REFERENCES users (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT expenses_void_fields CHECK ((status = 'dibatalkan') = (voided_at IS NOT NULL))
);
CREATE INDEX expenses_org_date_idx ON expenses (organization_id, spent_on);

-- ---------------------------------------------------------------------------
-- Kompensasi (honor) terapis: aturan per terapis + hasil perhitungan per sesi
-- ---------------------------------------------------------------------------
CREATE TABLE compensation_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  member_id       uuid NOT NULL,
  service_id      uuid,
  scheme          text NOT NULL CHECK (scheme IN ('tetap_per_sesi', 'persen_tarif')),
  amount          bigint CHECK (amount >= 0),
  percent         numeric(5, 2) CHECK (percent > 0 AND percent <= 100),
  effective_from  date NOT NULL,
  effective_to    date,
  notes           text CHECK (char_length(notes) <= 500),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users (id),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT compensation_rules_scheme_fields CHECK (
    (scheme = 'tetap_per_sesi' AND amount IS NOT NULL AND percent IS NULL)
    OR (scheme = 'persen_tarif' AND percent IS NOT NULL AND amount IS NULL)
  ),
  CONSTRAINT compensation_rules_period CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT compensation_rules_org_id_key UNIQUE (organization_id, id),
  CONSTRAINT compensation_rules_member_fk FOREIGN KEY (organization_id, member_id)
    REFERENCES memberships (organization_id, id),
  CONSTRAINT compensation_rules_service_fk FOREIGN KEY (organization_id, service_id)
    REFERENCES therapy_services (organization_id, id)
);
CREATE TRIGGER compensation_rules_updated_at BEFORE UPDATE ON compensation_rules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE therapist_compensations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  member_id       uuid NOT NULL,
  appointment_id  uuid NOT NULL,
  rule_id         uuid NOT NULL,
  session_date    date NOT NULL,
  basis           jsonb NOT NULL,
  amount          bigint NOT NULL CHECK (amount >= 0),
  status          text NOT NULL DEFAULT 'dihitung' CHECK (status IN ('dihitung', 'dibayar', 'dibatalkan')),
  paid_on         date,
  cancel_reason   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES users (id),
  CONSTRAINT therapist_compensations_paid CHECK ((status = 'dibayar') = (paid_on IS NOT NULL)),
  CONSTRAINT therapist_compensations_member_fk FOREIGN KEY (organization_id, member_id)
    REFERENCES memberships (organization_id, id),
  CONSTRAINT therapist_compensations_appointment_fk FOREIGN KEY (organization_id, appointment_id)
    REFERENCES appointments (organization_id, id),
  CONSTRAINT therapist_compensations_rule_fk FOREIGN KEY (organization_id, rule_id)
    REFERENCES compensation_rules (organization_id, id)
);
CREATE UNIQUE INDEX therapist_compensations_one_active ON therapist_compensations (organization_id, appointment_id)
  WHERE status <> 'dibatalkan';
CREATE INDEX therapist_compensations_member_idx ON therapist_compensations (organization_id, member_id, session_date);
CREATE TRIGGER therapist_compensations_updated_at BEFORE UPDATE ON therapist_compensations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Audit log (append-only). Tidak menyimpan isi klinis, hanya metadata tindakan.
-- ---------------------------------------------------------------------------
CREATE TABLE audit_logs (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id  uuid REFERENCES organizations (id),
  actor_user_id    uuid REFERENCES users (id),
  actor_member_id  uuid,
  support_grant_id uuid REFERENCES support_access_grants (id),
  action           text NOT NULL,
  entity_type      text,
  entity_id        text,
  meta             jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip               text,
  user_agent       text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_org_time_idx ON audit_logs (organization_id, created_at DESC);
CREATE INDEX audit_logs_entity_idx ON audit_logs (organization_id, entity_type, entity_id);
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION reject_modification();
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION reject_modification();
