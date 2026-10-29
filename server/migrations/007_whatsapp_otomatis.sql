-- 007_whatsapp_otomatis.sql
-- Pengingat jadwal WhatsApp otomatis lewat gateway Fonnte (pihak ketiga).
-- Setiap organisasi menghubungkan nomor WhatsApp & token Fonnte-nya sendiri, sehingga
-- pesan organisasi A tidak pernah terkirim dari nomor/akun organisasi B.

-- ---------------------------------------------------------------------------
-- (1) Koneksi WhatsApp per organisasi. Token disimpan terenkripsi (AES-256-GCM,
--     kunci APP_ENCRYPTION_KEY di server, terikat ke ID organisasi); database
--     tidak pernah menyimpan token dalam bentuk asli.
-- ---------------------------------------------------------------------------
CREATE TABLE org_whatsapp (
  organization_id  uuid PRIMARY KEY REFERENCES organizations (id),
  provider         text NOT NULL DEFAULT 'fonnte' CHECK (provider IN ('fonnte')),
  token_ciphertext text NOT NULL CHECK (char_length(token_ciphertext) <= 1000),
  token_hint       text NOT NULL CHECK (char_length(token_hint) <= 8),
  auto_enabled     boolean NOT NULL DEFAULT false,
  -- Kebijakan tiap organisasi: pengingat dikirim N menit sebelum jadwal (mis. 120 = 2 jam).
  lead_minutes     integer NOT NULL DEFAULT 180 CHECK (lead_minutes BETWEEN 30 AND 2880),
  device_number    text CHECK (char_length(device_number) <= 20),
  device_status    text CHECK (char_length(device_status) <= 40),
  checked_at       timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid REFERENCES users (id)
);

-- Baca: pengguna organisasi itu sendiri (server membutuhkan token untuk mengirim atas
-- perintah admin). Tulis: hanya owner (cakupan audit). Mode dukungan & platform: tidak ada.
ALTER TABLE org_whatsapp ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_whatsapp_select ON org_whatsapp FOR SELECT
  USING (organization_id = app_org_id() AND app_mode() = 'tenant');
CREATE POLICY org_whatsapp_insert ON org_whatsapp FOR INSERT
  WITH CHECK (organization_id = app_org_id() AND app_mode() = 'tenant' AND app_scope('audit') = 'all');
CREATE POLICY org_whatsapp_update ON org_whatsapp FOR UPDATE
  USING (organization_id = app_org_id() AND app_mode() = 'tenant' AND app_scope('audit') = 'all')
  WITH CHECK (organization_id = app_org_id());
CREATE POLICY org_whatsapp_delete ON org_whatsapp FOR DELETE
  USING (organization_id = app_org_id() AND app_mode() = 'tenant' AND app_scope('audit') = 'all');

GRANT SELECT, INSERT, DELETE ON org_whatsapp TO rtka_app;
GRANT UPDATE (token_ciphertext, token_hint, auto_enabled, lead_minutes, device_number, device_status, checked_at, updated_at, updated_by)
  ON org_whatsapp TO rtka_app;

-- ---------------------------------------------------------------------------
-- (2) Wali dapat menolak pengingat otomatis (tetap dapat dikirimi manual oleh petugas).
-- ---------------------------------------------------------------------------
ALTER TABLE guardians ADD COLUMN wa_opt_out boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- (3) Log pengiriman otomatis. Satu baris per jadwal per kanal (constraint lama):
--     'mengirim'    = sedang dikirim (klaim sebelum memanggil Fonnte, cegah kirim ganda)
--     'terkirim'    = diterima Fonnte untuk dikirim
--     'gagal'       = ditolak Fonnte/jaringan; boleh dicoba ulang
--     'tidak_pasti' = tidak ada jawaban (waktu habis); TIDAK dicoba ulang otomatis
--                     agar wali tidak menerima pesan ganda
-- ---------------------------------------------------------------------------
ALTER TABLE notification_log DROP CONSTRAINT notification_log_channel_check;
ALTER TABLE notification_log ADD CONSTRAINT notification_log_channel_check
  CHECK (channel IN ('whatsapp', 'email', 'whatsapp_otomatis'));
ALTER TABLE notification_log
  ADD COLUMN status text NOT NULL DEFAULT 'terkirim'
    CHECK (status IN ('mengirim', 'terkirim', 'gagal', 'tidak_pasti')),
  ADD COLUMN provider_message_id text CHECK (char_length(provider_message_id) <= 100),
  ADD COLUMN failure_reason text CHECK (char_length(failure_reason) <= 200),
  ADD COLUMN attempts integer NOT NULL DEFAULT 1 CHECK (attempts BETWEEN 1 AND 20);

GRANT UPDATE (status, provider_message_id, failure_reason, attempts, sent_at) ON notification_log TO rtka_app;