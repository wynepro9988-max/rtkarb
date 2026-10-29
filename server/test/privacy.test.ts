import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizePhone } from '../src/routes/reminders.ts';
import { buildTenant, createPatient, json, localDate, login, multipartBody, ORIGIN, pdfText, setupEnv, type Agent, type Tenant, type TestEnv } from './helpers.ts';

let env: TestEnv;
let A: Tenant;
let B: Tenant;
let owner: Agent;
let admin: Agent;

const PDF = Buffer.from('%PDF-1.4\n% DEMO berkas privasi\n%%EOF\n');

beforeAll(async () => {
  env = await setupEnv();
  A = await buildTenant(env.adminPool, 'A');
  B = await buildTenant(env.adminPool, 'B');
  owner = await login(env.app, A.owner.email);
  admin = await login(env.app, A.admin.email);
});
afterAll(() => env.close());

describe('Pengingat jadwal (WhatsApp sekali klik)', () => {
  it('normalisasi nomor Indonesia ke format wa.me', () => {
    expect(normalizePhone('0812-3456-7890')).toBe('6281234567890');
    expect(normalizePhone('+62 812 3456 7890')).toBe('6281234567890');
    expect(normalizePhone('812345678')).toBe('62812345678');
    expect(normalizePhone('123')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });

  it('daftar pengingat memuat tautan wa.me berisi pesan minimal (tanpa jenis terapi) dan dapat ditandai terkirim sekali', async () => {
    await env.adminPool.query(`UPDATE guardians SET phone = '0812 3456 7890' WHERE patient_id = $1`, [A.patientId]);
    const appt = json(
      await owner.post('/api/appointments', {
        patientId: A.patientId,
        therapistMemberId: A.therapist.memberId,
        serviceId: A.serviceId,
        date: localDate(1),
        time: '10:00',
        billing: 'per_sesi',
      }),
    ).ids[0];
    const list = json(await admin.get(`/api/reminders?date=${localDate(1)}`));
    const item = list.items.find((g: any) => g.sessions.some((x: any) => x.appointmentId === appt));
    expect(item.phone).toBe('6281234567890');
    expect(item.waUrl).toMatch(/^https:\/\/wa\.me\/6281234567890\?text=/);
    expect(item.message).toContain('10:00');
    expect(item.message).toContain(A.name);
    expect(item.message).not.toContain('Terapi Wicara');
    expect(item.sessions[0].sentAt).toBeNull();
    expect((await admin.post('/api/reminders/sent', { appointmentIds: [appt] })).statusCode).toBe(200);
    expect((await admin.post('/api/reminders/sent', { appointmentIds: [appt] })).statusCode).toBe(200);
    const { rows } = await env.adminPool.query(`SELECT count(*)::int AS n FROM notification_log WHERE appointment_id = $1`, [appt]);
    expect(rows[0].n).toBe(1);
    const again = json(await admin.get(`/api/reminders?date=${localDate(1)}`)).items.find((g: any) => g.sessions.some((x: any) => x.appointmentId === appt));
    expect(again.sessions[0].sentAt).not.toBeNull();
  });

  it('templat pengingat dapat diatur owner; terapis & keuangan tidak memiliki akses pengingat', async () => {
    await owner.patch('/api/org', { reminderTemplate: 'DEMO Yth {wali}: {anak} {tanggal} {jam}' });
    const list = json(await admin.get(`/api/reminders?date=${localDate(1)}`));
    expect(list.items[0].message).toMatch(/^DEMO Yth Bapak\/Ibu /);
    for (const p of [A.therapist, A.finance]) {
      const agent = await login(env.app, p.email);
      expect((await agent.get(`/api/reminders?date=${localDate(1)}`)).statusCode).toBe(403);
    }
    const ownerB = await login(env.app, B.owner.email);
    expect(json(await ownerB.get(`/api/reminders?date=${localDate(1)}`)).items).toEqual([]);
  });
});

describe('Privasi data pasien (UU PDP)', () => {
  it('register permintaan wali hanya untuk owner', async () => {
    const res = await owner.post('/api/privacy/requests', {
      patientId: A.patientId,
      kind: 'akses',
      requesterName: 'DEMO Wali Peminta',
      requesterRelation: 'Ibu',
      receivedOn: localDate(0),
    });
    expect(res.statusCode).toBe(201);
    expect((await admin.get('/api/privacy/requests')).statusCode).toBe(403);
    const ownerB = await login(env.app, B.owner.email);
    expect(json<any[]>(await ownerB.get('/api/privacy/requests'))).toEqual([]);
  });

  it('ekspor data pasien (PDF) memuat data pasien tersebut saja dan ditandai rahasia', async () => {
    const t = await login(env.app, A.therapist.email);
    await t.post('/api/notes', { patientId: A.patientId, observations: 'DEMO observasi untuk ekspor', finalize: true });
    const res = await owner.get(`/api/patients/${A.patientId}/export.pdf`);
    expect(res.statusCode).toBe(200);
    const text = pdfText(res.rawPayload);
    expect(text).toContain('Ringkasan Data Pasien');
    expect(text).toContain('DEMO observasi untuk ekspor');
    expect(text).toContain('RAHASIA');
    expect(text).not.toContain('DEMO Anak A2');
    expect((await admin.get(`/api/patients/${A.patientId}/export.pdf`)).statusCode).toBe(403);
    expect((await owner.get(`/api/patients/${B.patientId}/export.pdf`)).statusCode).toBe(404);
  });

  it('anonimisasi mode identitas: identitas, wali & berkas dihapus; catatan klinis dan keuangan tetap', async () => {
    const pid = await createPatient(env.adminPool, A.orgId, 'Hapus1');
    await env.adminPool.query(`INSERT INTO guardians (organization_id, patient_id, full_name, relationship, phone) VALUES ($1, $2, 'DEMO Wali Hapus', 'Ibu', '081111111111')`, [A.orgId, pid]);
    await env.adminPool.query(`INSERT INTO patient_therapists (organization_id, patient_id, member_id) VALUES ($1, $2, $3)`, [A.orgId, pid, A.therapist.memberId]);
    const body = multipartBody({ title: 'DEMO KK', category: 'administrasi' }, { name: 'kk.pdf', content: PDF });
    const up = await env.app.inject({
      method: 'POST',
      url: `/api/patients/${pid}/documents`,
      payload: body.payload,
      headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrf, origin: ORIGIN, 'content-type': body.contentType },
    });
    expect(up.statusCode).toBe(201);
    const { rows: docRows } = await env.adminPool.query(`SELECT storage_key FROM patient_documents WHERE id = $1`, [json(up).id]);
    const filePath = path.join(env.config.uploadDir, docRows[0].storage_key);
    expect(existsSync(filePath)).toBe(true);
    const t = await login(env.app, A.therapist.email);
    await t.post('/api/notes', { patientId: pid, observations: 'DEMO catatan pasien dihapus', finalize: true });
    await env.app.inject({ method: 'POST', url: '/api/payments', payload: { patientId: pid, amount: 50000, method: 'tunai', paidOn: localDate(0) }, headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrf, origin: ORIGIN } });
    const code = (await env.adminPool.query(`SELECT patient_code FROM patients WHERE id = $1`, [pid])).rows[0].patient_code;

    expect((await admin.post(`/api/patients/${pid}/anonymize`, { mode: 'identitas', confirmCode: code, reason: 'DEMO permintaan wali' })).statusCode).toBe(403);
    expect((await owner.post(`/api/patients/${pid}/anonymize`, { mode: 'identitas', confirmCode: 'SALAH', reason: 'DEMO permintaan wali' })).statusCode).toBe(400);
    const res = await owner.post(`/api/patients/${pid}/anonymize`, { mode: 'identitas', confirmCode: code, reason: 'DEMO permintaan penghapusan wali' });
    expect(res.statusCode, res.body).toBe(200);
    expect(json(res).filesRemoved).toBe(1);
    expect(existsSync(filePath)).toBe(false);

    const { rows } = await env.adminPool.query(
      `SELECT p.full_name, p.birth_date, p.anonymized_at IS NOT NULL AS anon,
              (SELECT count(*)::int FROM guardians WHERE patient_id = p.id) AS guardians,
              (SELECT observations FROM therapy_notes WHERE patient_id = p.id LIMIT 1) AS note,
              (SELECT count(*)::int FROM payments WHERE patient_id = p.id) AS payments
         FROM patients p WHERE p.id = $1`,
      [pid],
    );
    expect(rows[0]).toMatchObject({ birth_date: null, anon: true, guardians: 0, note: 'DEMO catatan pasien dihapus', payments: 1 });
    expect(rows[0].full_name).toBe(`Data dihapus (${code})`);
    const { rows: audit } = await env.adminPool.query(`SELECT meta::text AS m FROM audit_logs WHERE action = 'privasi.anonimisasi' AND entity_id = $1`, [pid]);
    expect(audit[0].m).not.toContain('Hapus1');
    expect((await owner.post(`/api/patients/${pid}/anonymize`, { mode: 'penuh', confirmCode: code, reason: 'DEMO ulang' })).statusCode).toBe(409);
  });

  it('anonimisasi mode penuh mengosongkan isi catatan & revisi; ditolak bila masih ada jadwal terjadwal', async () => {
    const pid = await createPatient(env.adminPool, A.orgId, 'Hapus2');
    await env.adminPool.query(`INSERT INTO patient_therapists (organization_id, patient_id, member_id) VALUES ($1, $2, $3)`, [A.orgId, pid, A.therapist.memberId]);
    const t = await login(env.app, A.therapist.email);
    const note = json(await t.post('/api/notes', { patientId: pid, observations: 'DEMO rahasia v1' }));
    await t.put(`/api/notes/${note.id}`, { observations: 'DEMO rahasia v2', finalize: true });
    const code = (await env.adminPool.query(`SELECT patient_code FROM patients WHERE id = $1`, [pid])).rows[0].patient_code;
    const appt = json(
      await owner.post('/api/appointments', { patientId: pid, therapistMemberId: A.therapist.memberId, date: localDate(3), time: '15:00', billing: 'tanpa_biaya' }),
    ).ids[0];
    expect((await owner.post(`/api/patients/${pid}/anonymize`, { mode: 'penuh', confirmCode: code, reason: 'DEMO hapus penuh' })).statusCode).toBe(409);
    await owner.post(`/api/appointments/${appt}/cancel`, { reason: 'DEMO batal' });
    expect((await owner.post(`/api/patients/${pid}/anonymize`, { mode: 'penuh', confirmCode: code, reason: 'DEMO hapus penuh' })).statusCode).toBe(200);
    const { rows } = await env.adminPool.query(
      `SELECT n.observations, (SELECT count(*)::int FROM therapy_note_revisions r WHERE r.note_id = n.id) AS revisions FROM therapy_notes n WHERE n.id = $1`,
      [note.id],
    );
    expect(rows[0].observations).not.toContain('DEMO rahasia');
    expect(rows[0].revisions).toBe(0);
    // Role aplikasi tetap tidak memiliki hak menghapus revisi secara langsung (hanya lewat fungsi anonimisasi).
    const { rows: priv } = await env.adminPool.query(`SELECT has_table_privilege('rtka_app', 'public.therapy_note_revisions', 'DELETE') AS can`);
    expect(priv[0].can).toBe(false);
  });

  it('kandidat retensi muncul hanya setelah owner menetapkan masa retensi', async () => {
    expect(json(await owner.get('/api/privacy/retention')).configured).toBe(false);
    const pid = await createPatient(env.adminPool, A.orgId, 'Lama');
    await env.adminPool.query(`UPDATE patients SET status = 'selesai', registered_on = '2015-01-01' WHERE id = $1`, [pid]);
    await owner.patch('/api/org', { retentionYears: 5 });
    const r = json(await owner.get('/api/privacy/retention'));
    expect(r.configured).toBe(true);
    expect(r.items.some((i: any) => i.id === pid)).toBe(true);
    expect(r.items.some((i: any) => i.id === A.patientId)).toBe(false);
  });
});
