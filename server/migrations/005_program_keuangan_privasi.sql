-- 005_program_keuangan_privasi.sql
-- (1) Program terapi: rencana jangka panjang per anak, tujuan, dan riwayat capaian.
-- (2) Invoice (dengan diskon beralasan), refund, verifikasi & rekonsiliasi keuangan.
-- (3) Log pengingat (WhatsApp/email sekali klik).
-- (4) Privasi data: register permintaan wali dan anonimisasi pasien yang terkendali.
-- Semua tabel ber-organization_id, FK komposit, RLS, dan hak kolom seperti migrasi 001-004.

-- ---------------------------------------------------------------------------
-- Pengaturan organisasi baru (semua bersifat kebijakan; default paling konservatif)
-- ---------------------------------------------------------------------------
ALTER TABLE organizations
  ADD COLUMN invoice_prefix text NOT NULL DEFAULT 'INV' CHECK (invoice_prefix ~ '^[A-Z0-9]{1,8}$'),
  -- Batas diskon yang boleh diberikan peran keuangan (persen dari subtotal baris). 0 = hanya owner.
  ADD COLUMN finance_discount_max_percent numeric(5, 2) NOT NULL DEFAULT 0
    CHECK (finance_discount_max_percent BETWEEN 0 AND 100),
  ADD COLUMN reminder_template text CHECK (char_length(reminder_template) <= 600),
  -- Retensi: pasien tidak aktif lebih dari N tahun ditampilkan sebagai kandidat (tanpa hapus otomatis).
  ADD COLUMN retention_years integer CHECK (retention_years BETWEEN 1 AND 50);

GRANT UPDATE (invoice_prefix, finance_discount_max_percent, reminder_template, retention_years) ON organizations TO rtka_app;

ALTER TABLE patients ADD COLUMN anonymized_at timestamptz;

-- ---------------------------------------------------------------------------
-- (1) Program terapi (data klinis: mengikuti cakupan catatan)
-- ---------------------------------------------------------------------------
CREATE TABLE therapy_programs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL,
  patient_id           uuid NOT NULL,
  service_id           uuid,
  title                text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 2 AND 150),
  summary              text CHECK (char_length(summary) <= 5000),
  status               text NOT NULL DEFAULT 'aktif' CHECK (status IN ('aktif', 'selesai', 'dihentikan')),
  start_date           date NOT NULL,
  target_end_date      date,
  ended_at             timestamptz,
  end_reason           text CHECK (char_length(end_reason) <= 500),
  created_by_member_id uuid NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT therapy_programs_dates CHECK (target_end_date IS NULL OR target_end_date >= start_date),
  CONSTRAINT therapy_programs_org_id_key UNIQUE (organization_id, id),
  CONSTRAINT therapy_programs_org_patient_id_key UNIQUE (organization_id, patient_id, id),
  CONSTRAINT therapy_programs_patient_fk FOREIGN KEY (organization_id, patient_id) REFERENCES patients (organization_id, id),
  CONSTRAINT therapy_programs_service_fk FOREIGN KEY (organization_id, service_id) REFERENCES therapy_services (organization_id, id),
  CONSTRAINT therapy_programs_author_fk FOREIGN KEY (organization_id, created_by_member_id) REFERENCES memberships (organization_id, id)
);
CREATE INDEX therapy_programs_patient_idx ON therapy_programs (organization_id, patient_id);
CREATE TRIGGER therapy_programs_updated_at BEFORE UPDATE ON therapy_programs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE program_goals (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL,
  patient_id           uuid NOT NULL,
  program_id           uuid NOT NULL,
  description          text NOT NULL CHECK (char_length(btrim(description)) BETWEEN 2 AND 1000),
  success_criteria     text CHECK (char_length(success_criteria) <= 1000),
  status               text NOT NULL DEFAULT 'berjalan' CHECK (status IN ('berjalan', 'tercapai', 'dihentikan')),
  sort_order           integer NOT NULL DEFAULT 0,
  achieved_at          timestamptz,
  created_by_member_id uuid NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT program_goals_org_id_key UNIQUE (organization_id, id),
  CONSTRAINT program_goals_org_patient_id_key UNIQUE (organization_id, patient_id, id),
  CONSTRAINT program_goals_program_fk FOREIGN KEY (organization_id, patient_id, program_id)
    REFERENCES therapy_programs (organization_id, patient_id, id),
  CONSTRAINT program_goals_author_fk FOREIGN KEY (organization_id, created_by_member_id) REFERENCES memberships (organization_id, id)
);
CREATE INDEX program_goals_program_idx ON program_goals (organization_id, program_id, sort_order);
CREATE TRIGGER program_goals_updated_at BEFORE UPDATE ON program_goals FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Riwayat capaian (append-only). progress_percent adalah perkiraan capaian 0–100 oleh terapis.
CREATE TABLE goal_progress (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL,
  patient_id           uuid NOT NULL,
  goal_id              uuid NOT NULL,
  appointment_id       uuid,
  progress_percent     integer NOT NULL CHECK (progress_percent BETWEEN 0 AND 100),
  note                 text CHECK (char_length(note) <= 2000),
  recorded_by_member_id uuid NOT NULL,
  recorded_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT goal_progress_goal_fk FOREIGN KEY (organization_id, patient_id, goal_id) REFERENCES program_goals (organization_id, patient_id, id),
  CONSTRAINT goal_progress_appointment_fk FOREIGN KEY (organization_id, patient_id, appointment_id)
    REFERENCES appointments (organization_id, patient_id, id),
  CONSTRAINT goal_progress_author_fk FOREIGN KEY (organization_id, recorded_by_member_id) REFERENCES memberships (organization_id, id)
);
CREATE INDEX goal_progress_goal_idx ON goal_progress (organization_id, goal_id, recorded_at DESC);
CREATE TRIGGER goal_progress_append_only BEFORE UPDATE OR DELETE ON goal_progress FOR EACH ROW EXECUTE FUNCTION reject_modification();

-- ---------------------------------------------------------------------------
-- (2) Invoice, refund, rekonsiliasi
-- ---------------------------------------------------------------------------
CREATE TABLE invoices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  invoice_no      text NOT NULL,
  patient_id      uuid NOT NULL,
  issued_on       date NOT NULL,
  due_on          date,
  subtotal        bigint NOT NULL CHECK (subtotal >= 0),
  discount_total  bigint NOT NULL DEFAULT 0 CHECK (discount_total >= 0),
  total           bigint NOT NULL CHECK (total >= 0),
  discount_reason text CHECK (char_length(discount_reason) <= 500),
  notes           text CHECK (char_length(notes) <= 1000),
  status          text NOT NULL DEFAULT 'terbit' CHECK (status IN ('terbit', 'dibatalkan')),
  void_reason     text CHECK (char_length(void_reason) <= 500),
  voided_at       timestamptz,
  voided_by       uuid REFERENCES users (id),
  created_by      uuid REFERENCES users (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invoices_totals CHECK (total = subtotal - discount_total),
  CONSTRAINT invoices_discount_reason CHECK (discount_total = 0 OR discount_reason IS NOT NULL),
  CONSTRAINT invoices_due CHECK (due_on IS NULL OR due_on >= issued_on),
  CONSTRAINT invoices_void_fields CHECK ((status = 'dibatalkan') = (voided_at IS NOT NULL)),
  CONSTRAINT invoices_org_no_key UNIQUE (organization_id, invoice_no),
  CONSTRAINT invoices_org_id_key UNIQUE (organization_id, id),
  CONSTRAINT invoices_org_patient_id_key UNIQUE (organization_id, patient_id, id),
  CONSTRAINT invoices_patient_fk FOREIGN KEY (organization_id, patient_id) REFERENCES patients (organization_id, id)
);
CREATE INDEX invoices_org_date_idx ON invoices (organization_id, issued_on);

CREATE TABLE invoice_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL,
  patient_id         uuid NOT NULL,
  invoice_id         uuid NOT NULL,
  description        text NOT NULL CHECK (char_length(btrim(description)) BETWEEN 2 AND 200),
  quantity           integer NOT NULL CHECK (quantity BETWEEN 1 AND 1000),
  unit_price         bigint NOT NULL CHECK (unit_price >= 0),
  discount_amount    bigint NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  line_total         bigint NOT NULL,
  patient_package_id uuid,
  appointment_id     uuid,
  -- false bila invoice dibatalkan, agar paket/sesi dapat ditagihkan ulang.
  active             boolean NOT NULL DEFAULT true,
  CONSTRAINT invoice_items_line CHECK (discount_amount <= quantity * unit_price AND line_total = quantity * unit_price - discount_amount),
  CONSTRAINT invoice_items_single_target CHECK (num_nonnulls(patient_package_id, appointment_id) <= 1),
  CONSTRAINT invoice_items_invoice_fk FOREIGN KEY (organization_id, patient_id, invoice_id) REFERENCES invoices (organization_id, patient_id, id),
  CONSTRAINT invoice_items_package_fk FOREIGN KEY (organization_id, patient_id, patient_package_id)
    REFERENCES patient_packages (organization_id, patient_id, id),
  CONSTRAINT invoice_items_appointment_fk FOREIGN KEY (organization_id, patient_id, appointment_id)
    REFERENCES appointments (organization_id, patient_id, id)
);
CREATE INDEX invoice_items_invoice_idx ON invoice_items (organization_id, invoice_id);
-- Satu paket / satu sesi hanya boleh ada di satu invoice aktif.
CREATE UNIQUE INDEX invoice_items_one_active_package ON invoice_items (organization_id, patient_package_id)
  WHERE active AND patient_package_id IS NOT NULL;
CREATE UNIQUE INDEX invoice_items_one_active_appointment ON invoice_items (organization_id, appointment_id)
  WHERE active AND appointment_id IS NOT NULL;

-- Pembayaran dapat ditujukan ke invoice; verifikasi untuk rekonsiliasi.
ALTER TABLE payments
  ADD COLUMN invoice_id uuid,
  ADD COLUMN verified_at timestamptz,
  ADD COLUMN verified_by uuid REFERENCES users (id),
  DROP CONSTRAINT payments_single_target,
  ADD CONSTRAINT payments_single_target CHECK (num_nonnulls(patient_package_id, appointment_id, invoice_id) <= 1),
  ADD CONSTRAINT payments_invoice_fk FOREIGN KEY (organization_id, patient_id, invoice_id) REFERENCES invoices (organization_id, patient_id, id),
  ADD CONSTRAINT payments_org_id_key UNIQUE (organization_id, id);
CREATE INDEX payments_invoice_idx ON payments (organization_id, invoice_id) WHERE invoice_id IS NOT NULL;
GRANT UPDATE (verified_at, verified_by) ON payments TO rtka_app;

ALTER TABLE expenses
  ADD COLUMN verified_at timestamptz,
  ADD COLUMN verified_by uuid REFERENCES users (id);
GRANT UPDATE (verified_at, verified_by) ON expenses TO rtka_app;

-- Refund: selalu terkait satu pembayaran; total refund tidak melebihi nominal pembayaran (dijaga aplikasi
-- dengan penguncian baris pembayaran, dan diperiksa ulang oleh trigger di bawah).
CREATE TABLE refunds (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  refund_no       text NOT NULL,
  payment_id      uuid NOT NULL,
  patient_id      uuid NOT NULL,
  refunded_on     date NOT NULL,
  amount          bigint NOT NULL CHECK (amount > 0),
  method          text NOT NULL CHECK (method IN ('tunai', 'transfer', 'qris')),
  reference       text CHECK (char_length(reference) <= 120),
  reason          text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 5 AND 500),
  status          text NOT NULL DEFAULT 'tercatat' CHECK (status IN ('tercatat', 'dibatalkan')),
  void_reason     text CHECK (char_length(void_reason) <= 500),
  voided_at       timestamptz,
  voided_by       uuid REFERENCES users (id),
  verified_at     timestamptz,
  verified_by     uuid REFERENCES users (id),
  recorded_by     uuid REFERENCES users (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refunds_void_fields CHECK ((status = 'dibatalkan') = (voided_at IS NOT NULL)),
  CONSTRAINT refunds_org_no_key UNIQUE (organization_id, refund_no),
  CONSTRAINT refunds_payment_fk FOREIGN KEY (organization_id, payment_id) REFERENCES payments (organization_id, id),
  CONSTRAINT refunds_patient_fk FOREIGN KEY (organization_id, patient_id) REFERENCES patients (organization_id, id)
);
CREATE INDEX refunds_org_date_idx ON refunds (organization_id, refunded_on);
CREATE INDEX refunds_payment_idx ON refunds (organization_id, payment_id);

CREATE FUNCTION refunds_within_payment() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_paid bigint; v_refunded bigint;
BEGIN
  SELECT amount INTO v_paid FROM payments WHERE organization_id = NEW.organization_id AND id = NEW.payment_id AND status = 'tercatat';
  IF v_paid IS NULL THEN
    RAISE EXCEPTION 'refund hanya untuk pembayaran yang tercatat' USING ERRCODE = 'check_violation';
  END IF;
  SELECT coalesce(sum(amount), 0) INTO v_refunded FROM refunds
   WHERE organization_id = NEW.organization_id AND payment_id = NEW.payment_id AND status = 'tercatat' AND id <> NEW.id;
  IF NEW.status = 'tercatat' AND v_refunded + NEW.amount > v_paid THEN
    RAISE EXCEPTION 'total refund melebihi nominal pembayaran' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER refunds_within_payment BEFORE INSERT ON refunds FOR EACH ROW EXECUTE FUNCTION refunds_within_payment();

CREATE TABLE reconciliations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  period_from     date NOT NULL,
  period_to       date NOT NULL,
  method          text NOT NULL CHECK (method IN ('tunai', 'transfer', 'qris')),
  system_in       bigint NOT NULL,
  system_out      bigint NOT NULL,
  system_net      bigint NOT NULL,
  actual_net      bigint NOT NULL,
  difference      bigint NOT NULL,
  unverified_count integer NOT NULL,
  notes           text CHECK (char_length(notes) <= 1000),
  status          text NOT NULL DEFAULT 'draf' CHECK (status IN ('draf', 'final')),
  created_by      uuid REFERENCES users (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  finalized_by    uuid REFERENCES users (id),
  finalized_at    timestamptz,
  CONSTRAINT reconciliations_period CHECK (period_to >= period_from),
  CONSTRAINT reconciliations_math CHECK (system_net = system_in - system_out AND difference = actual_net - system_net),
  CONSTRAINT reconciliations_final CHECK ((status = 'final') = (finalized_at IS NOT NULL))
);
CREATE INDEX reconciliations_org_idx ON reconciliations (organization_id, period_from DESC);

-- ---------------------------------------------------------------------------
-- (3) Log pengingat & berbagi tautan
-- ---------------------------------------------------------------------------
CREATE TABLE notification_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  patient_id      uuid NOT NULL,
  appointment_id  uuid NOT NULL,
  channel         text NOT NULL CHECK (channel IN ('whatsapp', 'email')),
  sent_by         uuid REFERENCES users (id),
  sent_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_log_appointment_fk FOREIGN KEY (organization_id, patient_id, appointment_id)
    REFERENCES appointments (organization_id, patient_id, id),
  CONSTRAINT notification_log_once UNIQUE (organization_id, appointment_id, channel)
);

-- ---------------------------------------------------------------------------
-- (4) Privasi data
-- ---------------------------------------------------------------------------
CREATE TABLE data_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  patient_id      uuid NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('akses', 'koreksi', 'hapus')),
  requester_name  text NOT NULL CHECK (char_length(btrim(requester_name)) BETWEEN 2 AND 150),
  requester_relation text CHECK (char_length(requester_relation) <= 60),
  received_on     date NOT NULL,
  details         text CHECK (char_length(details) <= 2000),
  status          text NOT NULL DEFAULT 'diterima' CHECK (status IN ('diterima', 'diproses', 'selesai', 'ditolak')),
  resolution      text CHECK (char_length(resolution) <= 2000),
  handled_by      uuid REFERENCES users (id),
  handled_at      timestamptz,
  created_by      uuid REFERENCES users (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT data_requests_patient_fk FOREIGN KEY (organization_id, patient_id) REFERENCES patients (organization_id, id)
);
CREATE INDEX data_requests_org_idx ON data_requests (organization_id, received_on DESC);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
ALTER TABLE therapy_programs ENABLE ROW LEVEL SECURITY;
CREATE POLICY therapy_programs_all ON therapy_programs
  USING (app_note_visible(organization_id, patient_id, created_by_member_id))
  WITH CHECK (app_note_visible(organization_id, patient_id, created_by_member_id) AND app_scope('note') <> 'none');

ALTER TABLE program_goals ENABLE ROW LEVEL SECURITY;
CREATE POLICY program_goals_all ON program_goals
  USING (app_note_visible(organization_id, patient_id, created_by_member_id))
  WITH CHECK (app_note_visible(organization_id, patient_id, created_by_member_id) AND app_scope('note') <> 'none');

ALTER TABLE goal_progress ENABLE ROW LEVEL SECURITY;
CREATE POLICY goal_progress_select ON goal_progress FOR SELECT USING (app_note_visible(organization_id, patient_id, recorded_by_member_id));
CREATE POLICY goal_progress_insert ON goal_progress FOR INSERT WITH CHECK (
  recorded_by_member_id = app_member_id() AND app_note_visible(organization_id, patient_id, recorded_by_member_id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['invoices', 'invoice_items', 'refunds', 'reconciliations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (organization_id = app_org_id() AND app_scope(''finance'') = ''all'') '
      'WITH CHECK (organization_id = app_org_id() AND app_scope(''finance'') = ''all'')', t || '_finance', t);
  END LOOP;
END $$;

ALTER TABLE notification_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY notification_log_tenant ON notification_log USING (organization_id = app_org_id()) WITH CHECK (organization_id = app_org_id());

-- Register privasi: hanya peran dengan cakupan audit (owner) — data permintaan berisi identitas peminta.
ALTER TABLE data_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY data_requests_owner ON data_requests
  USING (organization_id = app_org_id() AND app_scope('audit') = 'all')
  WITH CHECK (organization_id = app_org_id() AND app_scope('audit') = 'all');

-- ---------------------------------------------------------------------------
-- Hak akses
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT ON therapy_programs, program_goals TO rtka_app;
GRANT UPDATE (title, summary, status, target_end_date, ended_at, end_reason, service_id) ON therapy_programs TO rtka_app;
GRANT UPDATE (description, success_criteria, status, sort_order, achieved_at) ON program_goals TO rtka_app;
GRANT SELECT, INSERT ON goal_progress TO rtka_app;
GRANT SELECT, INSERT ON invoices, invoice_items, refunds, reconciliations, notification_log, data_requests TO rtka_app;
GRANT UPDATE (status, void_reason, voided_at, voided_by) ON invoices TO rtka_app;
GRANT UPDATE (active) ON invoice_items TO rtka_app;
GRANT UPDATE (status, void_reason, voided_at, voided_by, verified_at, verified_by) ON refunds TO rtka_app;
GRANT UPDATE (actual_net, difference, notes, status, finalized_by, finalized_at) ON reconciliations TO rtka_app;
GRANT UPDATE (status, resolution, handled_by, handled_at) ON data_requests TO rtka_app;

-- Rekonsiliasi final tidak dapat diubah lagi.
CREATE FUNCTION reconciliations_lock_final() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'final' THEN
    RAISE EXCEPTION 'rekonsiliasi final tidak dapat diubah' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reconciliations_lock_final BEFORE UPDATE ON reconciliations FOR EACH ROW EXECUTE FUNCTION reconciliations_lock_final();

-- ---------------------------------------------------------------------------
-- Anonimisasi pasien (hak penghapusan). Dijalankan dari transaksi tenant oleh owner.
-- SECURITY DEFINER agar dapat menghapus/menimpa data yang biasanya terkunci (revisi
-- catatan, riwayat capaian), tetapi tetap dikunci ke organisasi aktif.
--   p_mode = 'identitas' : identitas & kontak dihapus, berkas dihapus; catatan klinis &
--                          keuangan tetap (teranonimkan) untuk kewajiban pencatatan.
--   p_mode = 'penuh'     : juga mengosongkan isi catatan, revisi, program & capaian.
-- Mengembalikan daftar storage_key berkas yang harus dihapus dari penyimpanan.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reject_modification() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_owner boolean := current_user = (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = TG_RELID);
BEGIN
  IF TG_OP = 'DELETE' AND TG_TABLE_NAME = 'audit_logs' AND v_owner
     AND current_setting('rtka.allow_audit_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  IF TG_TABLE_NAME IN ('therapy_note_revisions', 'goal_progress') AND v_owner
     AND current_setting('rtka.allow_erasure', true) = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION 'tabel % bersifat append-only', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE FUNCTION anonymize_patient(p_patient_id uuid, p_mode text) RETURNS text[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_org  uuid := app_org_id();
  v_code text;
  v_keys text[];
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
     SET full_name = 'Data dihapus (' || v_code || ')', nickname = NULL, birth_date = NULL, sex = NULL,
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
  END IF;
  RETURN v_keys;
END $$;

REVOKE ALL ON FUNCTION anonymize_patient(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION anonymize_patient(uuid, text) TO rtka_app;
