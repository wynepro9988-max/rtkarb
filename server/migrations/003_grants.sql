-- 003_grants.sql
-- Hak akses role aplikasi web (rtka_app). Role ini:
--   * bukan pemilik tabel (sehingga RLS selalu berlaku),
--   * tidak memiliki BYPASSRLS / SUPERUSER (diperiksa saat aplikasi start),
--   * tidak dapat DELETE data historis, dan hanya dapat UPDATE kolom tertentu.
-- Role rtka_app dibuat oleh DBA / skrip scripts/db-local.sh sebelum migrasi.

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO rtka_app;

GRANT SELECT ON organizations TO rtka_app;
GRANT UPDATE (name, timezone, patient_code_prefix, receipt_prefix, address, phone) ON organizations TO rtka_app;

GRANT SELECT, INSERT ON users TO rtka_app;
GRANT UPDATE (full_name, password_hash, failed_login_count, locked_until, last_login_at, password_changed_at)
  ON users TO rtka_app;

GRANT SELECT, INSERT ON memberships TO rtka_app;
GRANT UPDATE (role, status, is_therapist, specialization, deactivated_at, updated_by) ON memberships TO rtka_app;

GRANT SELECT, INSERT ON account_tokens TO rtka_app;
GRANT UPDATE (used_at, revoked_at) ON account_tokens TO rtka_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO rtka_app;

GRANT SELECT, INSERT ON support_access_grants TO rtka_app;
GRANT UPDATE (status, decided_by, decided_at, decision_note, starts_at, expires_at, revoked_by, revoked_at)
  ON support_access_grants TO rtka_app;

GRANT SELECT, INSERT, UPDATE ON org_counters TO rtka_app;
GRANT SELECT, INSERT, UPDATE ON therapy_services, package_types TO rtka_app;

GRANT SELECT, INSERT ON patients TO rtka_app;
GRANT UPDATE (full_name, nickname, birth_date, sex, status, registered_on, address, admin_notes, updated_by)
  ON patients TO rtka_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON guardians, patient_therapists TO rtka_app;

GRANT SELECT, INSERT ON patient_packages TO rtka_app;
GRANT UPDATE (sessions_used, status, cancel_reason, updated_by) ON patient_packages TO rtka_app;

GRANT SELECT, INSERT ON appointments TO rtka_app;
GRANT UPDATE (status, cancel_reason, admin_notes, completed_at, completed_by, updated_by) ON appointments TO rtka_app;

GRANT SELECT, INSERT ON therapy_notes TO rtka_app;
GRANT UPDATE (status, objectives, activities, observations, home_program, next_plan, revision_no, finalized_at)
  ON therapy_notes TO rtka_app;

GRANT SELECT, INSERT ON patient_documents TO rtka_app;
GRANT UPDATE (archived_at, archived_by) ON patient_documents TO rtka_app;

GRANT SELECT, INSERT ON payments TO rtka_app;
GRANT UPDATE (status, void_reason, voided_at, voided_by) ON payments TO rtka_app;

GRANT SELECT, INSERT ON expenses TO rtka_app;
GRANT UPDATE (status, void_reason, voided_at, voided_by) ON expenses TO rtka_app;

GRANT SELECT, INSERT ON compensation_rules TO rtka_app;
GRANT UPDATE (effective_to, notes) ON compensation_rules TO rtka_app;

GRANT SELECT ON therapist_compensations TO rtka_app;
GRANT UPDATE (status, paid_on, cancel_reason, updated_by) ON therapist_compensations TO rtka_app;

-- Tabel append-only: hanya SELECT + INSERT.
GRANT SELECT, INSERT ON package_ledger, therapy_note_revisions, audit_logs TO rtka_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO rtka_app;

REVOKE ALL ON FUNCTION compute_compensation(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION compute_compensation(uuid) TO rtka_app;
