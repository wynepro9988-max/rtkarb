-- Keputusan 2026-10-29: admin dapat merangkap keuangan/kasir.
-- Ditetapkan owner per admin di organisasinya sendiri (bukan otomatis untuk semua organisasi),
-- sehingga kebijakan owner lain tidak ikut berubah. Catatan klinis tetap tertutup untuk admin.

ALTER TABLE memberships ADD COLUMN handles_finance boolean NOT NULL DEFAULT false;
ALTER TABLE memberships ADD CONSTRAINT memberships_handles_finance_admin CHECK (role = 'admin' OR NOT handles_finance);

ALTER TABLE account_tokens ADD COLUMN handles_finance boolean NOT NULL DEFAULT false;
ALTER TABLE account_tokens ADD CONSTRAINT account_tokens_handles_finance_admin
  CHECK (role IS NOT DISTINCT FROM 'admin' OR NOT handles_finance);

GRANT UPDATE (handles_finance) ON memberships TO rtka_app;

-- Keanggotaan dari undangan harus sama persis dengan undangan, termasuk rangkap keuangan,
-- agar aktivasi tidak dapat menambah akses keuangan yang tidak diberikan owner.
DROP POLICY memberships_insert ON memberships;
CREATE POLICY memberships_insert ON memberships FOR INSERT WITH CHECK (
  app_mode() = 'auth' AND EXISTS (
    SELECT 1 FROM account_tokens t
    WHERE t.token_hash = app_token_hash()
      AND t.purpose = 'undangan'
      AND t.used_at IS NULL
      AND t.revoked_at IS NULL
      AND t.expires_at > now()
      AND t.organization_id = memberships.organization_id
      AND t.role = memberships.role
      AND t.handles_finance = memberships.handles_finance)
);
