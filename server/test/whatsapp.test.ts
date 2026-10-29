import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openSecret, sealSecret } from '../src/security/secret-box.ts';
import { buildTenant, createPatient, json, login, setupEnv, type Agent, type Tenant, type TestEnv } from './helpers.ts';

// Server Fonnte tiruan: tidak ada pesan yang benar-benar dikirim. Token & nomor sintetis.
const TOKEN_A = 'DEMO-TOKEN-A-1234';
const TOKEN_B = 'DEMO-TOKEN-B-5678';
const TOKEN_C = 'DEMO-TOKEN-C-9012';
const CRON_SECRET = 'demo-cron-secret-'.padEnd(48, 'x');

interface Captured {
  token: string;
  target: string | null;
  message: string | null;
  schedule: string | null;
}
const sent: Captured[] = [];
let mode: 'ok' | 'fail' | 'hang' = 'ok';
let fonnte: Server;

let env: TestEnv;
let A: Tenant;
let B: Tenant;
let C: Tenant;
let ownerA: Agent;
let adminA: Agent;
let ownerB: Agent;

async function startFonnte(): Promise<string> {
  fonnte = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const buf = Buffer.concat(chunks);
    const fields = new Map<string, string>();
    if (buf.length) {
      const fd = await new Response(buf, { headers: { 'content-type': String(req.headers['content-type']) } }).formData();
      fd.forEach((v, k) => fields.set(k, String(v)));
    }
    const token = String(req.headers.authorization ?? '');
    const reply = (o: unknown) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(o));
    };
    if (![TOKEN_A, TOKEN_B, TOKEN_C].includes(token)) return reply({ reason: 'token invalid', status: false });
    if (req.url === '/device') {
      return reply({ device: token === TOKEN_A ? '6281100000001' : '6281100000002', device_status: 'connect', expired: '18 November 2029', messages: 1, name: 'DEMO', package: 'Free', quota: '1000', status: true });
    }
    if (req.url === '/send') {
      sent.push({ token, target: fields.get('target') ?? null, message: fields.get('message') ?? null, schedule: fields.get('schedule') ?? null });
      if (mode === 'hang') return; // tidak menjawab -> waktu habis di sisi aplikasi
      if (mode === 'fail') return reply({ Status: false, reason: 'device disconnected', requestid: 1 });
      return reply({ detail: 'success! message in queue', id: [String(80000000 + sent.length)], process: 'pending', requestid: 1, status: true, target: [fields.get('target')] });
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => fonnte.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(fonnte.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  const url = await startFonnte();
  env = await setupEnv({
    whatsapp: { encryptionKey: randomBytes(32), cronSecret: CRON_SECRET, fonnteApiUrl: url, timeoutMs: 300, sendGapSeconds: 10 },
  });
  A = await buildTenant(env.adminPool, 'A');
  B = await buildTenant(env.adminPool, 'B');
  C = await buildTenant(env.adminPool, 'C');
  ownerA = await login(env.app, A.owner.email);
  adminA = await login(env.app, A.admin.email);
  ownerB = await login(env.app, B.owner.email);
});
afterAll(async () => {
  await env.close();
  fonnte.closeAllConnections();
  await new Promise((r) => fonnte.close(r));
});

// Anak sintetis dengan wali utama bernomor WhatsApp valid.
async function child(t: Tenant, label: string, phone: string): Promise<string> {
  const id = await createPatient(env.adminPool, t.orgId, label);
  await env.adminPool.query(
    `INSERT INTO guardians (organization_id, patient_id, full_name, relationship, phone, is_primary) VALUES ($1, $2, $3, 'Ibu', $4, true)`,
    [t.orgId, id, `DEMO Wali ${label}`, phone],
  );
  return id;
}

// Jadwal sintetis besok pukul `hhmm` waktu organisasi (Asia/Jakarta).
async function appointmentTomorrow(t: Tenant, patientId: string, hhmm: string): Promise<string> {
  const { rows } = await env.adminPool.query<{ id: string }>(
    `INSERT INTO appointments (organization_id, patient_id, therapist_member_id, service_id, starts_at, duration_minutes, billing, price)
     VALUES ($1, $2, $3, $4, (date_trunc('day', now() AT TIME ZONE 'Asia/Jakarta') + interval '1 day' + $5::time) AT TIME ZONE 'Asia/Jakarta',
             30, 'per_sesi', 150000) RETURNING id`,
    [t.orgId, patientId, t.therapist.memberId, t.serviceId, hhmm],
  );
  return rows[0].id;
}

// Jadwal sintetis N menit dari sekarang.
async function appointment(t: Tenant, minutes: number, patientId = t.patientId): Promise<string> {
  const { rows } = await env.adminPool.query<{ id: string }>(
    `INSERT INTO appointments (organization_id, patient_id, therapist_member_id, service_id, starts_at, duration_minutes, billing, price)
     VALUES ($1, $2, $3, $4, date_trunc('minute', now()) + make_interval(mins => $5), 60, 'per_sesi', 150000) RETURNING id`,
    [t.orgId, patientId, t.therapist.memberId, t.serviceId, minutes],
  );
  return rows[0].id;
}

const cron = (authorization?: string) =>
  env.app.inject({ method: 'GET', url: '/api/cron/reminders', headers: authorization ? { authorization } : {} });

const sentWith = (token: string) => sent.filter((s) => s.token === token);

async function autoLog(appointmentId: string) {
  const { rows } = await env.adminPool.query(
    `SELECT status, attempts, provider_message_id, failure_reason FROM notification_log WHERE appointment_id = $1 AND channel = 'whatsapp_otomatis'`,
    [appointmentId],
  );
  return rows[0] ?? null;
}

describe('Enkripsi token pihak ketiga', () => {
  it('token terenkripsi, terikat ke organisasi, dan menolak ciphertext yang diubah', () => {
    const key = randomBytes(32);
    const sealed = sealSecret(key, TOKEN_A, 'org-a');
    expect(sealed).not.toContain(TOKEN_A);
    expect(openSecret(key, sealed, 'org-a')).toBe(TOKEN_A);
    expect(() => openSecret(key, sealed, 'org-b')).toThrow();
    expect(() => openSecret(randomBytes(32), sealed, 'org-a')).toThrow();
    const parts = sealed.split('.');
    parts[3] = Buffer.from('ubah').toString('base64url');
    expect(() => openSecret(key, parts.join('.'), 'org-a')).toThrow();
  });
});

describe('Menghubungkan WhatsApp (Fonnte)', () => {
  it('hanya owner; token diperiksa ke Fonnte; token tidak pernah dikembalikan maupun disimpan asli', async () => {
    expect((await adminA.put('/api/org/whatsapp', { token: TOKEN_A, autoEnabled: true, leadMinutes: 180 })).statusCode).toBe(403);
    expect((await adminA.get('/api/org/whatsapp')).statusCode).toBe(403);

    const bad = await ownerA.put('/api/org/whatsapp', { token: 'DEMO-TOKEN-SALAH', autoEnabled: true, leadMinutes: 180 });
    expect(bad.statusCode).toBe(400);
    expect(json(bad).error.message).toContain('token invalid');
    expect((await ownerA.put('/api/org/whatsapp', { autoEnabled: true, leadMinutes: 180 })).statusCode).toBe(400);
    expect((await ownerA.put('/api/org/whatsapp', { token: TOKEN_A, autoEnabled: true, leadMinutes: 10 })).statusCode).toBe(400);

    const res = await ownerA.put('/api/org/whatsapp', { token: TOKEN_A, autoEnabled: true, leadMinutes: 180 });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(TOKEN_A);
    expect(json(res)).toMatchObject({ configured: true, tokenHint: '••••1234', autoEnabled: true, leadMinutes: 180, deviceNumber: '6281100000001' });

    const { rows } = await env.adminPool.query(`SELECT token_ciphertext FROM org_whatsapp WHERE organization_id = $1`, [A.orgId]);
    expect(rows[0].token_ciphertext).not.toContain('DEMO-TOKEN');
    const audit = await env.adminPool.query(`SELECT meta::text AS m FROM audit_logs WHERE organization_id = $1 AND action = 'whatsapp.diatur'`, [A.orgId]);
    expect(audit.rows.length).toBeGreaterThan(0);
    for (const r of audit.rows) expect(r.m).not.toContain('DEMO-TOKEN');

    // Organisasi lain tidak melihat koneksi organisasi A.
    expect(json(await ownerB.get('/api/org/whatsapp')).configured).toBe(false);
    const check = json(await ownerA.post('/api/org/whatsapp/check'));
    expect(check.check).toMatchObject({ ok: true, connected: true, quota: '1000' });
  });

  it('pesan uji terkirim lewat token organisasi sendiri', async () => {
    sent.length = 0;
    const r = json(await ownerA.post('/api/org/whatsapp/test', { phone: '0812 0000 0009' }));
    expect(r.outcome).toBe('terkirim');
    expect(sent).toEqual([expect.objectContaining({ token: TOKEN_A, target: '6281200000009' })]);
    expect((await ownerA.post('/api/org/whatsapp/test', { phone: '123' })).statusCode).toBe(400);
  });

  it('wali dapat ditandai menolak pengingat otomatis', async () => {
    const g = await ownerA.post(`/api/patients/${A.patient2Id}/guardians`, { fullName: 'DEMO Wali Menolak', relationship: 'Ayah', phone: '081200000002', isPrimary: true, waOptOut: true });
    expect(g.statusCode).toBe(201);
    const p = json(await ownerA.get(`/api/patients/${A.patient2Id}`));
    expect(p.guardians[0].waOptOut).toBe(true);
  });
});

describe('Pengingat otomatis terjadwal (cron)', () => {
  let due1: string;
  let due2: string;
  let notDue: string;
  let tooLate: string;
  let optedOut: string;
  let manual: string;

  it('hanya penjadwal dengan CRON_SECRET yang dapat memicu', async () => {
    expect((await cron()).statusCode).toBe(401);
    expect((await cron('Bearer salah')).statusCode).toBe(401);
    expect((await cron(CRON_SECRET)).statusCode).toBe(401);
  });

  it('mengirim tepat untuk jadwal yang masuk batas "N menit sebelum jadwal" kebijakan organisasi, sekali saja', async () => {
    // Satu anak per jadwal agar tidak digabung (penggabungan diuji terpisah di bawah).
    due1 = await appointment(A, 120);
    due2 = await appointment(A, 125, await child(A, 'due2', '081200000102'));
    notDue = await appointment(A, 300, await child(A, 'notdue', '081200000103'));
    tooLate = await appointment(A, 10, await child(A, 'telat', '081200000104'));
    optedOut = await appointment(A, 90, A.patient2Id);
    manual = await appointment(A, 100, await child(A, 'manual', '081200000105'));
    expect((await adminA.post('/api/reminders/sent', { appointmentIds: [manual] })).statusCode).toBe(200);

    sent.length = 0;
    const res = await cron(`Bearer ${CRON_SECRET}`);
    expect(res.statusCode).toBe(200);
    expect(json(res)).toMatchObject({ terkirim: 2, gagal: 0 });
    expect(sent).toHaveLength(2);
    expect(sent.map((s) => s.target).sort()).toEqual(['6280000000000', '6281200000102']);
    for (const s of sent) {
      expect(s.token).toBe(TOKEN_A);
      expect(s.message).toContain(A.name);
      expect(s.message).not.toContain('Terapi Wicara');
    }
    // Pesan kedua diberi jarak di antrean Fonnte.
    expect(sent[0].schedule).toBeNull();
    expect(Number(sent[1].schedule)).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000) + 5);

    expect(await autoLog(due1)).toMatchObject({ status: 'terkirim', attempts: 1 });
    expect((await autoLog(due1)).provider_message_id).toBeTruthy();
    for (const id of [notDue, tooLate, optedOut, manual]) expect(await autoLog(id)).toBeNull();

    sent.length = 0;
    expect(json(await cron(`Bearer ${CRON_SECRET}`)).terkirim).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('daftar pengingat menampilkan status otomatis dan perkiraan waktu kirim', async () => {
    const { rows } = await env.adminPool.query(`SELECT to_char(starts_at AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD') AS d, starts_at FROM appointments WHERE id = $1`, [notDue]);
    const list = json(await adminA.get(`/api/reminders?date=${rows[0].d}`));
    expect(list.whatsapp).toMatchObject({ configured: true, autoEnabled: true, leadMinutes: 180 });
    const item = list.items.find((g: any) => g.sessions.some((x: any) => x.appointmentId === notDue));
    expect(new Date(item.autoDueAt).getTime()).toBe(new Date(rows[0].starts_at).getTime() - 180 * 60_000);
    expect(item.sessions[0].auto).toBeNull();
  });

  it('kebijakan & token tiap organisasi terpisah', async () => {
    expect((await ownerB.put('/api/org/whatsapp', { token: TOKEN_B, autoEnabled: true, leadMinutes: 60 })).statusCode).toBe(200);
    const b45 = await appointment(B, 45);
    const b120 = await appointment(B, 120, await child(B, 'b120', '081400000001'));
    sent.length = 0;
    await cron(`Bearer ${CRON_SECRET}`);
    expect(sent).toHaveLength(1);
    expect(sent[0].token).toBe(TOKEN_B);
    expect(sent[0].message).toContain(B.name);
    expect(sent[0].message).not.toContain(A.name);
    expect(await autoLog(b45)).toMatchObject({ status: 'terkirim' });
    expect(await autoLog(b120)).toBeNull();
    // Organisasi yang mematikan otomatis tidak diproses.
    await ownerB.put('/api/org/whatsapp', { autoEnabled: false, leadMinutes: 180 });
    sent.length = 0;
    await cron(`Bearer ${CRON_SECRET}`);
    expect(sent).toHaveLength(0);
  });

  it('gagal dicatat beserta alasannya dan dicoba ulang; jawaban yang tidak pasti tidak dikirim ulang', async () => {
    mode = 'fail';
    const f = await appointment(A, 150, await child(A, 'gagal', '081200000106'));
    await cron(`Bearer ${CRON_SECRET}`);
    expect(await autoLog(f)).toMatchObject({ status: 'gagal', attempts: 1, failure_reason: 'device disconnected' });
    mode = 'ok';
    await cron(`Bearer ${CRON_SECRET}`);
    expect(await autoLog(f)).toMatchObject({ status: 'terkirim', attempts: 2, failure_reason: null });

    mode = 'hang';
    const h = await appointment(A, 160, await child(A, 'hang', '081200000107'));
    sent.length = 0;
    await cron(`Bearer ${CRON_SECRET}`);
    expect(await autoLog(h)).toMatchObject({ status: 'tidak_pasti' });
    mode = 'ok';
    await cron(`Bearer ${CRON_SECRET}`);
    expect(sent).toHaveLength(1);
  });

  it('petugas dapat mengirim semua pengingat satu tanggal lewat Fonnte; terapis tidak', async () => {
    const { rows } = await env.adminPool.query(`SELECT to_char(starts_at AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD') AS d FROM appointments WHERE id = $1`, [notDue]);
    const therapist = await login(env.app, A.therapist.email);
    expect((await therapist.post('/api/reminders/auto-send', { date: rows[0].d })).statusCode).toBe(403);
    const r = json(await adminA.post('/api/reminders/auto-send', { date: rows[0].d }));
    expect(r.gagal).toBe(0);
    expect(await autoLog(notDue)).toMatchObject({ status: 'terkirim' });
    expect(await autoLog(optedOut)).toBeNull();
    expect(await autoLog(manual)).toBeNull();
    const audit = await env.adminPool.query(`SELECT meta::text AS m FROM audit_logs WHERE organization_id = $1 AND action = 'pengingat.otomatis'`, [A.orgId]);
    for (const a of audit.rows) expect(a.m).not.toMatch(/628\d+|DEMO Wali/);
  });
});

describe('Satu pesan per anak per hari', () => {
  let ownerC: Agent;
  let c1: string;
  let c2: string;
  const ids: Record<string, string> = {};

  it('semua sesi anak pada hari itu digabung dalam satu pesan, dikirim sebelum sesi pertamanya', async () => {
    ownerC = await login(env.app, C.owner.email);
    // Batas kirim = sampai 1 jam setelah besok 09:00, sehingga sesi 09:00 & 10:00 jatuh tempo
    // sedangkan 14:00 belum; hasilnya tidak bergantung pada jam berapa test dijalankan.
    const { rows } = await env.adminPool.query(
      `SELECT ceil(extract(epoch FROM ((date_trunc('day', now() AT TIME ZONE 'Asia/Jakarta') + interval '1 day 9 hours') AT TIME ZONE 'Asia/Jakarta' - now())) / 60)::int AS m`,
    );
    expect((await ownerC.put('/api/org/whatsapp', { token: TOKEN_C, autoEnabled: true, leadMinutes: rows[0].m + 60 })).statusCode).toBe(200);
    c1 = await child(C, 'gabung1', '081300000001');
    c2 = await child(C, 'gabung2', '081300000002');
    ids.c1a = await appointmentTomorrow(C, c1, '09:00');
    ids.c1b = await appointmentTomorrow(C, c1, '14:00');
    ids.c2a = await appointmentTomorrow(C, c2, '10:00');

    sent.length = 0;
    await cron(`Bearer ${CRON_SECRET}`);
    const msgs = sentWith(TOKEN_C);
    expect(msgs.map((m) => m.target).sort()).toEqual(['6281300000001', '6281300000002']);
    const m1 = msgs.find((m) => m.target === '6281300000001')!;
    expect(m1.message).toContain('pukul 09:00 dan 14:00');
    const [a, b] = [await autoLog(ids.c1a), await autoLog(ids.c1b)];
    expect(a).toMatchObject({ status: 'terkirim' });
    expect(b).toMatchObject({ status: 'terkirim', provider_message_id: a.provider_message_id });

    sent.length = 0;
    await cron(`Bearer ${CRON_SECRET}`);
    expect(sentWith(TOKEN_C)).toHaveLength(0);
  });

  it('sesi yang ditambahkan setelah pesan terkirim diingatkan dengan pesan tersendiri saat jatuh tempo', async () => {
    const before = await autoLog(ids.c1a);
    ids.c1new = await appointmentTomorrow(C, c1, '09:30');
    sent.length = 0;
    await cron(`Bearer ${CRON_SECRET}`);
    const msgs = sentWith(TOKEN_C);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].message).toContain('pukul 09:00, 09:30, dan 14:00');
    expect(await autoLog(ids.c1new)).toMatchObject({ status: 'terkirim' });
    expect((await autoLog(ids.c1a)).provider_message_id).toBe(before.provider_message_id);
  });

  it('daftar pengingat per anak; kirim manual menandai semua sesinya dan menolak jadwal organisasi lain', async () => {
    const { rows } = await env.adminPool.query(`SELECT to_char(starts_at AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD') AS d FROM appointments WHERE id = $1`, [ids.c1a]);
    const list = json(await ownerC.get(`/api/reminders?date=${rows[0].d}`));
    const g = list.items.find((x: any) => x.patientId === c1);
    expect(g.sessions.map((x: any) => x.localTime)).toEqual(['09:00', '09:30', '14:00']);
    expect(g.waUrl).toContain(encodeURIComponent('09:00, 09:30, dan 14:00'));
    expect(list.items.filter((x: any) => x.patientId === c1)).toHaveLength(1);

    const g2 = list.items.find((x: any) => x.patientId === c2);
    expect((await ownerC.post('/api/reminders/sent', { appointmentIds: g2.sessions.map((x: any) => x.appointmentId) })).statusCode).toBe(200);
    const after = json(await ownerC.get(`/api/reminders?date=${rows[0].d}`)).items.find((x: any) => x.patientId === c2);
    expect(after.sessions.every((x: any) => x.sentAt)).toBe(true);

    const foreign = await appointment(A, 400, A.patientId);
    expect((await ownerC.post('/api/reminders/sent', { appointmentIds: [ids.c2a, foreign] })).statusCode).toBe(404);
    const { rows: logs } = await env.adminPool.query(`SELECT 1 FROM notification_log WHERE appointment_id = $1`, [foreign]);
    expect(logs).toHaveLength(0);
  });
});

describe('Tanpa konfigurasi server', () => {
  it('endpoint cron tidak tersedia dan pengaturan WhatsApp ditolak dengan jelas', async () => {
    const plain = await setupEnv({
      whatsapp: { encryptionKey: null, cronSecret: null, fonnteApiUrl: 'http://127.0.0.1:9', timeoutMs: 300, sendGapSeconds: 0 },
    });
    try {
      expect((await plain.app.inject({ method: 'GET', url: '/api/cron/reminders', headers: { authorization: `Bearer ${CRON_SECRET}` } })).statusCode).toBe(404);
      const t = await buildTenant(plain.adminPool, 'C');
      const owner = await login(plain.app, t.owner.email);
      expect(json(await owner.get('/api/org/whatsapp')).serverReady).toBe(false);
      expect((await owner.put('/api/org/whatsapp', { token: TOKEN_A, autoEnabled: true, leadMinutes: 120 })).statusCode).toBe(503);
    } finally {
      await plain.close();
    }
  });
});
