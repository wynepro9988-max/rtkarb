// Data DEMO untuk pengembangan lokal. SEMUA data sintetis, berlabel "DEMO", email *.invalid.
// Menolak berjalan di produksi atau di database yang namanya tidak berakhiran _dev.
//   npm run seed:demo                -> kata sandi acak dicetak sekali
//   DEMO_PASSWORD=... npm run seed:demo
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { hashPassword } from '../src/security/password.ts';

const url = process.env.DATABASE_ADMIN_URL;
if (!url) throw new Error('DATABASE_ADMIN_URL belum diisi');
const dbName = new URL(url).pathname.slice(1);
if (process.env.NODE_ENV === 'production' || !dbName.endsWith('_dev')) {
  console.error(`Menolak membuat data DEMO di database "${dbName}". Hanya untuk database *_dev.`);
  process.exit(1);
}

const password = process.env.DEMO_PASSWORD ?? `Demo-${randomBytes(6).toString('base64url')}`;
const hash = await hashPassword(password);
const client = new pg.Client({ connectionString: url });
await client.connect();

const existing = await client.query(`SELECT 1 FROM organizations WHERE name LIKE 'DEMO %' LIMIT 1`);
if (existing.rowCount) {
  console.error('Data DEMO sudah ada. Tidak ada yang diubah.');
  await client.end();
  process.exit(1);
}

const q = async <T extends pg.QueryResultRow = any>(sql: string, params: unknown[] = []) => (await client.query<T>(sql, params)).rows;
const accounts: string[] = [];

async function user(email: string, name: string, platform = false) {
  const [u] = await q(`INSERT INTO users (email, full_name, password_hash, platform_role) VALUES ($1, $2, $3, $4) RETURNING id`, [
    email,
    name,
    hash,
    platform ? 'platform_admin' : null,
  ]);
  accounts.push(email);
  return u.id as string;
}

async function member(org: string, email: string, name: string, role: string, isTherapist = role === 'terapis', specialization: string | null = null) {
  const uid = await user(email, name);
  const [m] = await q(`INSERT INTO memberships (organization_id, user_id, role, is_therapist, specialization) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [
    org,
    uid,
    role,
    isTherapist,
    specialization,
  ]);
  return { userId: uid, memberId: m.id as string };
}

async function seedOrg(letter: 'A' | 'B', prefix: string) {
  const l = letter.toLowerCase();
  const [org] = await q(`INSERT INTO organizations (name, patient_code_prefix, address, phone) VALUES ($1, $2, $3, $4) RETURNING id`, [
    `DEMO Rumah Bintang ${letter}`,
    prefix,
    `DEMO Jl. Contoh No. ${letter === 'A' ? 1 : 2}`,
    '0000-DEMO',
  ]);
  const orgId = org.id as string;
  const owner = await member(orgId, `owner.${l}@demo.invalid`, `DEMO Owner ${letter}`, 'owner');
  await member(orgId, `admin.${l}@demo.invalid`, `DEMO Admin ${letter}`, 'admin');
  await member(orgId, `keuangan.${l}@demo.invalid`, `DEMO Kasir ${letter}`, 'keuangan');
  const t1 = await member(orgId, `terapis1.${l}@demo.invalid`, `DEMO Terapis Wicara ${letter}`, 'terapis', true, 'Terapi Wicara');
  const t2 = await member(orgId, `terapis2.${l}@demo.invalid`, `DEMO Terapis Okupasi ${letter}`, 'terapis', true, 'Terapi Okupasi');

  const services: Record<string, string> = {};
  for (const [name, price] of [
    ['Terapi Wicara', 150000],
    ['Terapi Okupasi', 150000],
    ['Sensori Integrasi', 175000],
  ] as const) {
    const [s] = await q(`INSERT INTO therapy_services (organization_id, name, default_duration_minutes, default_price) VALUES ($1, $2, 60, $3) RETURNING id`, [orgId, name, price]);
    services[name] = s.id;
  }
  const [pt] = await q(
    `INSERT INTO package_types (organization_id, name, service_id, sessions_total, price, valid_days) VALUES ($1, 'Paket Wicara 8 Sesi', $2, 8, 1100000, 90) RETURNING id`,
    [orgId, services['Terapi Wicara']],
  );
  await q(`INSERT INTO package_types (organization_id, name, sessions_total, price) VALUES ($1, 'Paket Umum 12 Sesi', 12, 1650000)`, [orgId]);

  await q(`INSERT INTO compensation_rules (organization_id, member_id, scheme, amount, effective_from) VALUES ($1, $2, 'tetap_per_sesi', 60000, '2026-01-01')`, [orgId, t1.memberId]);
  await q(`INSERT INTO compensation_rules (organization_id, member_id, scheme, percent, effective_from) VALUES ($1, $2, 'persen_tarif', 40, '2026-01-01')`, [orgId, t2.memberId]);

  const patients: string[] = [];
  for (let i = 1; i <= 6; i++) {
    const [p] = await q(
      `INSERT INTO patients (organization_id, patient_code, full_name, nickname, birth_date, sex, registered_on, created_by)
       VALUES ($1, $2, $3, $4, current_date - make_interval(years => $5, months => $6), $7, current_date - $8::int, $9) RETURNING id`,
      [orgId, `${prefix}-${String(i).padStart(4, '0')}`, `DEMO Anak ${letter}${i}`, `Demo${i}`, 3 + (i % 4), i, i % 2 ? 'L' : 'P', i * 9, owner.userId],
    );
    patients.push(p.id);
    await q(
      `INSERT INTO guardians (organization_id, patient_id, full_name, relationship, phone, is_primary) VALUES ($1, $2, $3, $4, $5, true)`,
      [orgId, p.id, `DEMO Wali ${letter}${i}`, i % 2 ? 'Ibu' : 'Ayah', `080000${letter === 'A' ? 1 : 2}000${String(i).padStart(2, '0')}`],
    );
    const therapist = i % 2 ? t1 : t2;
    await q(`INSERT INTO patient_therapists (organization_id, patient_id, member_id) VALUES ($1, $2, $3)`, [orgId, p.id, therapist.memberId]);
  }
  await q(`INSERT INTO org_counters (organization_id, name, value) VALUES ($1, 'patient', 6)`, [orgId]);

  // Paket untuk pasien 1 dan jadwal hari ini.
  const [pkg] = await q(
    `INSERT INTO patient_packages (organization_id, patient_id, package_type_id, service_id, name, sessions_total, price, purchased_on, expires_on, created_by)
     VALUES ($1, $2, $3, $4, 'Paket Wicara 8 Sesi', 8, 1100000, current_date - 20, current_date + 70, $5) RETURNING id`,
    [orgId, patients[0], pt.id, services['Terapi Wicara'], owner.userId],
  );
  const slots = [
    { p: 0, t: t1, svc: 'Terapi Wicara', day: -7, time: '09:00', billing: 'paket', done: true },
    { p: 0, t: t1, svc: 'Terapi Wicara', day: 0, time: '09:00', billing: 'paket', done: false },
    { p: 1, t: t2, svc: 'Terapi Okupasi', day: 0, time: '10:00', billing: 'per_sesi', done: false },
    { p: 2, t: t1, svc: 'Terapi Wicara', day: 0, time: '13:00', billing: 'per_sesi', done: false },
    { p: 3, t: t2, svc: 'Sensori Integrasi', day: -1, time: '14:00', billing: 'per_sesi', done: true },
    { p: 4, t: t1, svc: 'Terapi Wicara', day: 1, time: '09:00', billing: 'per_sesi', done: false },
  ];
  for (const s of slots) {
    const price = s.billing === 'per_sesi' ? (s.svc === 'Sensori Integrasi' ? 175000 : 150000) : 0;
    const [a] = await q(
      `INSERT INTO appointments (organization_id, patient_id, therapist_member_id, service_id, starts_at, duration_minutes, billing, patient_package_id, price, status, completed_at, created_by)
       VALUES ($1, $2, $3, $4, ((current_date + $5::int) + $6::time)::timestamp AT TIME ZONE 'Asia/Jakarta', 60, $7, $8, $9, $10, CASE WHEN $10 = 'selesai' THEN now() END, $11)
       RETURNING id`,
      [orgId, patients[s.p], s.t.memberId, services[s.svc], s.day, s.time, s.billing, s.billing === 'paket' ? pkg.id : null, price, s.done ? 'selesai' : 'terjadwal', owner.userId],
    );
    if (s.done) {
      if (s.billing === 'paket') {
        await q(`UPDATE patient_packages SET sessions_used = sessions_used + 1 WHERE id = $1`, [pkg.id]);
        await q(
          `INSERT INTO package_ledger (organization_id, patient_id, patient_package_id, appointment_id, kind, sessions_delta, sessions_used_after) VALUES ($1, $2, $3, $4, 'pemakaian', 1, 1)`,
          [orgId, patients[s.p], pkg.id, a.id],
        );
      }
      await client.query('BEGIN');
      await q(`SELECT set_config('app.mode', 'tenant', true), set_config('app.org_id', $1, true)`, [orgId]);
      await q(`SELECT compute_compensation($1)`, [a.id]);
      await client.query('COMMIT');
      await q(
        `INSERT INTO therapy_notes (organization_id, patient_id, appointment_id, author_member_id, note_type, status, objectives, activities, observations, home_program, finalized_at)
         VALUES ($1, $2, $3, $4, 'sesi', 'final', 'DEMO: target latihan contoh', 'DEMO: aktivitas contoh', 'DEMO: observasi contoh (bukan data nyata)', 'DEMO: latihan rumah contoh', now())`,
        [orgId, patients[s.p], a.id, s.t.memberId],
      );
    }
  }
  await q(
    `INSERT INTO payments (organization_id, receipt_no, patient_id, patient_package_id, paid_on, amount, method, reference, recorded_by)
     VALUES ($1, $2, $3, $4, current_date - 20, 1100000, 'transfer', 'DEMO-REF-001', $5)`,
    [orgId, `KW/${new Date().getFullYear()}/00001`, patients[0], pkg.id, owner.userId],
  );
  await q(`INSERT INTO org_counters (organization_id, name, value) VALUES ($1, $2, 1)`, [orgId, `receipt:${new Date().getFullYear()}`]);
  await q(
    `INSERT INTO expenses (organization_id, spent_on, category, description, amount, method, recorded_by) VALUES ($1, current_date - 3, 'Alat terapi', 'DEMO pembelian alat peraga', 350000, 'tunai', $2)`,
    [orgId, owner.userId],
  );
  return orgId;
}

await seedOrg('A', 'RBA');
await seedOrg('B', 'RBB');
await user('platform@demo.invalid', 'DEMO Admin Teknis', true);
await client.end();

console.log('Data DEMO dibuat (dua organisasi terpisah, semua data sintetis).');
console.log(`Kata sandi semua akun DEMO: ${password}`);
console.log(`Akun: ${accounts.join(', ')}`);
