-- Keputusan 2026-11-05: honor terapis dapat terdiri dari gaji pokok bulanan, tunjangan bulanan
-- (komponen tambahan bernama bebas, boleh lebih dari satu), dan honor per sesi (tabel lama).
-- Terapis yang hanya punya aturan per sesi tetap seperti sebelumnya.
--
-- Default yang BELUM disetujui owner (lihat 06-keputusan-terbuka.md F13): komponen bulanan
-- dihitung penuh untuk setiap bulan berlaku, tanpa prorata, potongan, pajak, atau BPJS.

CREATE TABLE compensation_components (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  member_id       uuid NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('gaji_pokok', 'tunjangan')),
  name            text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 2 AND 80),
  amount          bigint NOT NULL CHECK (amount > 0),
  -- Berlaku per bulan kalender; disimpan sebagai tanggal 1.
  start_month     date NOT NULL CHECK (extract(day FROM start_month) = 1),
  end_month       date CHECK (extract(day FROM end_month) = 1),
  notes           text CHECK (char_length(notes) <= 500),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users (id),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT compensation_components_period CHECK (end_month IS NULL OR end_month >= start_month),
  CONSTRAINT compensation_components_org_id_key UNIQUE (organization_id, id),
  CONSTRAINT compensation_components_member_fk FOREIGN KEY (organization_id, member_id)
    REFERENCES memberships (organization_id, id)
);
CREATE INDEX compensation_components_member_idx ON compensation_components (organization_id, member_id, start_month);
CREATE TRIGGER compensation_components_updated_at BEFORE UPDATE ON compensation_components
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Pembayaran komponen bulanan. Nama dan nominal disalin saat dibayar; baris tidak dapat diubah.
CREATE TABLE compensation_component_payouts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  member_id       uuid NOT NULL,
  component_id    uuid NOT NULL,
  period          date NOT NULL CHECK (extract(day FROM period) = 1),
  kind            text NOT NULL,
  name            text NOT NULL,
  amount          bigint NOT NULL CHECK (amount > 0),
  paid_on         date NOT NULL,
  recorded_by     uuid REFERENCES users (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT compensation_component_payouts_once UNIQUE (organization_id, component_id, period),
  CONSTRAINT compensation_component_payouts_component_fk FOREIGN KEY (organization_id, component_id)
    REFERENCES compensation_components (organization_id, id),
  CONSTRAINT compensation_component_payouts_member_fk FOREIGN KEY (organization_id, member_id)
    REFERENCES memberships (organization_id, id)
);
CREATE INDEX compensation_component_payouts_period_idx ON compensation_component_payouts (organization_id, period);

-- Sama dengan aturan honor per sesi: keuangan melihat semua, terapis hanya miliknya sendiri.
ALTER TABLE compensation_components ENABLE ROW LEVEL SECURITY;
CREATE POLICY compensation_components_select ON compensation_components FOR SELECT USING (
  organization_id = app_org_id() AND (app_scope('finance') = 'all' OR member_id = app_member_id())
);
CREATE POLICY compensation_components_insert ON compensation_components FOR INSERT WITH CHECK (
  organization_id = app_org_id() AND app_scope('finance') = 'all'
);
CREATE POLICY compensation_components_update ON compensation_components FOR UPDATE
  USING (organization_id = app_org_id() AND app_scope('finance') = 'all')
  WITH CHECK (organization_id = app_org_id() AND app_scope('finance') = 'all');

ALTER TABLE compensation_component_payouts ENABLE ROW LEVEL SECURITY;
CREATE POLICY compensation_component_payouts_select ON compensation_component_payouts FOR SELECT USING (
  organization_id = app_org_id() AND (app_scope('finance') = 'all' OR member_id = app_member_id())
);
CREATE POLICY compensation_component_payouts_insert ON compensation_component_payouts FOR INSERT WITH CHECK (
  organization_id = app_org_id() AND app_scope('finance') = 'all'
);

GRANT SELECT, INSERT ON compensation_components, compensation_component_payouts TO rtka_app;
-- Nominal tidak dapat diubah: perubahan dilakukan dengan mengakhiri komponen dan membuat yang baru.
GRANT UPDATE (end_month, notes) ON compensation_components TO rtka_app;
