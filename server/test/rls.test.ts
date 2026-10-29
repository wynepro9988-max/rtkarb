import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertSafeAppRole, createPool, withTx } from '../src/db.ts';
import { testUrls } from './env.ts';
import { buildTenant, setupEnv, type Tenant, type TestEnv } from './helpers.ts';

let env: TestEnv;
let A: Tenant;
let B: Tenant;

const tenantSettings = (t: Tenant, memberId: string | null = t.owner.memberId, scopes = 'all') => ({
  'app.mode': 'tenant',
  'app.org_id': t.orgId,
  'app.user_id': t.owner.userId,
  'app.member_id': memberId,
  'app.scope_patient': scopes,
  'app.scope_note': scopes,
  'app.scope_finance': scopes,
  'app.scope_audit': scopes,
});

beforeAll(async () => {
  env = await setupEnv();
  A = await buildTenant(env.adminPool, 'A');
  B = await buildTenant(env.adminPool, 'B');
});
afterAll(() => env.close());

describe('Row-Level Security (lapisan database)', () => {
  it('role aplikasi aman: bukan superuser, tanpa BYPASSRLS, bukan pemilik tabel', async () => {
    await expect(assertSafeAppRole(env.appPool)).resolves.toBeUndefined();
    // Role pemilik skema harus ditolak sebagai koneksi aplikasi.
    const ownerPool = createPool(testUrls().adminUrl, { max: 1 });
    await expect(assertSafeAppRole(ownerPool)).rejects.toThrow(/Row-Level Security/);
    await ownerPool.end();
  });

  it('tanpa konteks organisasi, role aplikasi tidak melihat baris apa pun', async () => {
    const counts = await withTx(env.appPool, {}, async (db) => {
      const tables = ['organizations', 'patients', 'guardians', 'appointments', 'therapy_notes', 'payments', 'patient_packages', 'audit_logs', 'memberships'];
      const out: Record<string, number> = {};
      for (const t of tables) out[t] = (await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`)).n;
      return out;
    });
    for (const n of Object.values(counts)) expect(n).toBe(0);
  });

  it('konteks A hanya melihat data A walaupun query tanpa filter organisasi', async () => {
    const rows = await withTx(env.appPool, { settings: tenantSettings(A) }, (db) =>
      db.many<{ organizationId: string }>(`SELECT organization_id FROM patients`),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.organizationId === A.orgId)).toBe(true);

    const bPatient = await withTx(env.appPool, { settings: tenantSettings(A) }, (db) =>
      db.maybe(`SELECT id FROM patients WHERE id = $1`, [B.patientId]),
    );
    expect(bPatient).toBeNull();
  });

  it('konteks A tidak dapat menulis baris dengan organization_id B', async () => {
    await expect(
      withTx(env.appPool, { settings: tenantSettings(A) }, (db) =>
        db.exec(`INSERT INTO patients (organization_id, patient_code, full_name) VALUES ($1, 'X-1', 'DEMO Sisip')`, [B.orgId]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('konteks A tidak dapat memindahkan data ke organisasi B', async () => {
    await expect(
      withTx(env.appPool, { settings: tenantSettings(A) }, (db) =>
        db.exec(`UPDATE guardians SET organization_id = $1 WHERE patient_id = $2`, [B.orgId, A.patientId]),
      ),
    ).rejects.toBeTruthy();
  });

  it('foreign key komposit menolak relasi lintas organisasi bahkan untuk pemilik skema', async () => {
    // Jadwal milik A yang menunjuk pasien B -> ditolak oleh database (bukan hanya aplikasi).
    await expect(
      env.adminPool.query(
        `INSERT INTO appointments (organization_id, patient_id, therapist_member_id, starts_at, duration_minutes)
         VALUES ($1, $2, $3, now(), 60)`,
        [A.orgId, B.patientId, A.therapist.memberId],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    // Terapis B pada jadwal A -> ditolak.
    await expect(
      env.adminPool.query(
        `INSERT INTO appointments (organization_id, patient_id, therapist_member_id, starts_at, duration_minutes)
         VALUES ($1, $2, $3, now(), 60)`,
        [A.orgId, A.patientId, B.therapist.memberId],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('paket hanya dapat dipakai oleh pasien pemiliknya (FK komposit)', async () => {
    const pkg = await env.adminPool.query<{ id: string }>(
      `INSERT INTO patient_packages (organization_id, patient_id, name, sessions_total, price, purchased_on)
       VALUES ($1, $2, 'DEMO', 4, 0, current_date) RETURNING id`,
      [A.orgId, A.patientId],
    );
    await expect(
      env.adminPool.query(
        `INSERT INTO appointments (organization_id, patient_id, therapist_member_id, starts_at, duration_minutes, billing, patient_package_id)
         VALUES ($1, $2, $3, now(), 60, 'paket', $4)`,
        [A.orgId, A.patient2Id, A.therapist.memberId, pkg.rows[0].id],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('saldo paket tidak dapat negatif atau melebihi total (CHECK constraint)', async () => {
    const pkg = await env.adminPool.query<{ id: string }>(
      `INSERT INTO patient_packages (organization_id, patient_id, name, sessions_total, price, purchased_on)
       VALUES ($1, $2, 'DEMO', 2, 0, current_date) RETURNING id`,
      [A.orgId, A.patientId],
    );
    await expect(env.adminPool.query(`UPDATE patient_packages SET sessions_used = 3 WHERE id = $1`, [pkg.rows[0].id])).rejects.toMatchObject({
      code: '23514',
    });
    await expect(env.adminPool.query(`UPDATE patient_packages SET sessions_used = -1 WHERE id = $1`, [pkg.rows[0].id])).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('audit log tidak dapat diubah atau dihapus, bahkan oleh pemilik skema', async () => {
    await env.adminPool.query(`INSERT INTO audit_logs (organization_id, action) VALUES ($1, 'uji.audit')`, [A.orgId]);
    await expect(env.adminPool.query(`UPDATE audit_logs SET action = 'diubah' WHERE action = 'uji.audit'`)).rejects.toThrow(/append-only/);
    await expect(env.adminPool.query(`DELETE FROM audit_logs WHERE action = 'uji.audit'`)).rejects.toThrow(/append-only/);
    await expect(env.adminPool.query(`TRUNCATE audit_logs`)).rejects.toBeTruthy();
    // Role aplikasi bahkan tidak memiliki hak UPDATE/DELETE.
    await expect(
      withTx(env.appPool, { settings: tenantSettings(A) }, (db) => db.exec(`DELETE FROM audit_logs`)),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('role aplikasi tidak dapat mengubah nominal pembayaran (hak kolom)', async () => {
    await env.adminPool.query(
      `INSERT INTO payments (organization_id, receipt_no, patient_id, paid_on, amount, method) VALUES ($1, $2, $3, current_date, 50000, 'tunai')`,
      [A.orgId, `UJI-${Date.now()}`, A.patientId],
    );
    await expect(
      withTx(env.appPool, { settings: tenantSettings(A) }, (db) => db.exec(`UPDATE payments SET amount = 1`)),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('role aplikasi tidak dapat menaikkan peran menjadi owner atau menjadi admin platform', async () => {
    await expect(
      withTx(env.appPool, { settings: tenantSettings(A) }, (db) =>
        db.exec(`UPDATE memberships SET role = 'owner' WHERE id = $1`, [A.admin.memberId]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      withTx(env.appPool, { settings: { ...tenantSettings(A), 'app.user_id': A.admin.userId } }, (db) =>
        db.exec(`UPDATE users SET platform_role = 'platform_admin' WHERE id = $1`, [A.admin.userId]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('cakupan keuangan "none" menyembunyikan pembayaran walaupun organisasi benar', async () => {
    const n = await withTx(env.appPool, { settings: { ...tenantSettings(A), 'app.scope_finance': 'none' } }, async (db) =>
      (await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM payments`)).n,
    );
    expect(n).toBe(0);
  });

  it('transaksi mode dukungan (READ ONLY) menolak semua penulisan', async () => {
    await expect(
      withTx(env.appPool, { readOnly: true, settings: { ...tenantSettings(A, null), 'app.mode': 'support' } }, (db) =>
        db.exec(`UPDATE patients SET nickname = 'x' WHERE organization_id = $1`, [A.orgId]),
      ),
    ).rejects.toMatchObject({ code: '25006' });
  });
});
