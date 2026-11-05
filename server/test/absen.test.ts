import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTx } from '../src/db.ts';
import { buildTenant, json, localDate, login, multipartBody, ORIGIN, setupEnv, type Agent, type Tenant, type TestEnv } from './helpers.ts';

// Jadwal tanpa terapis, absen sesi oleh terapis, video/foto sesi, data pendaftaran klinis, dan
// login orang tua dengan No. RM (keputusan owner 5 Nov 2026). Semua data uji adalah data DEMO.
let env: TestEnv;
let A: Tenant;
let B: Tenant;
let owner: Agent;
let admin: Agent;
let t1: Agent;
let t2: Agent;
let otServiceId: string;
let otPackageTypeId: string;
const TODAY = localDate();

// MP4 minimal: ftyp + mdat + moov/mvhd (versi 0) dengan durasi tertentu.
function mp4(seconds: number) {
  const ftyp = Buffer.alloc(20);
  ftyp.writeUInt32BE(20, 0);
  ftyp.write('ftypisom', 4, 'latin1');
  ftyp.write('isom', 16, 'latin1');
  const mdat = Buffer.alloc(64);
  mdat.writeUInt32BE(64, 0);
  mdat.write('mdat', 4, 'latin1');
  const mvhd = Buffer.alloc(108);
  mvhd.writeUInt32BE(108, 0);
  mvhd.write('mvhd', 4, 'latin1');
  mvhd.writeUInt32BE(1000, 8 + 12);
  mvhd.writeUInt32BE(seconds * 1000, 8 + 16);
  const moov = Buffer.concat([Buffer.alloc(8), mvhd]);
  moov.writeUInt32BE(moov.length, 0);
  moov.write('moov', 4, 'latin1');
  return Buffer.concat([ftyp, mdat, moov]);
}
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const HEIC = (() => {
  const b = Buffer.alloc(32);
  b.writeUInt32BE(24, 0);
  b.write('ftypheic', 4, 'latin1');
  return b;
})();

function upload(agent: Agent, appointmentId: string, name: string, content: Buffer) {
  const body = multipartBody({}, { name, content });
  return env.app.inject({
    method: 'POST',
    url: `/api/appointments/${appointmentId}/media`,
    payload: body.payload,
    headers: { cookie: agent.cookie, 'x-csrf-token': agent.csrf, origin: ORIGIN, 'content-type': body.contentType },
  });
}

async function newPatient(name: string, extra: object = {}) {
  const res = await admin.post('/api/patients', { fullName: name, ...extra });
  expect(res.statusCode).toBe(201);
  return json(res) as { id: string; patientCode: string };
}

const pkgUsed = async (id: string) => (await env.adminPool.query(`SELECT sessions_used FROM patient_packages WHERE id = $1`, [id])).rows[0].sessions_used;

beforeAll(async () => {
  env = await setupEnv();
  A = await buildTenant(env.adminPool, 'A');
  B = await buildTenant(env.adminPool, 'B');
  owner = await login(env.app, A.owner.email);
  admin = await login(env.app, A.admin.email);
  t1 = await login(env.app, A.therapist.email);
  t2 = await login(env.app, A.therapist2.email);
  const ot = await env.adminPool.query<{ id: string }>(
    `INSERT INTO therapy_services (organization_id, name, default_duration_minutes, default_price) VALUES ($1, 'Okupasi Terapi', 60, 175000) RETURNING id`,
    [A.orgId],
  );
  otServiceId = ot.rows[0].id;
  const pt = await env.adminPool.query<{ id: string }>(
    `INSERT INTO package_types (organization_id, name, service_id, sessions_total, price) VALUES ($1, 'Paket OT 4 Sesi', $2, 4, 600000) RETURNING id`,
    [A.orgId, otServiceId],
  );
  otPackageTypeId = pt.rows[0].id;
});
afterAll(() => env.close());

describe('Jadwal tanpa terapis dan absen', () => {
  const ids: Record<string, string> = {};

  it('admin membuat jadwal tanpa terapis; jadwal tampil di jadwal admin dan pengingat', async () => {
    const p = await newPatient('DEMO Anak Absen Satu');
    ids.patient = p.id;
    ids.code = p.patientCode;
    ids.otPackage = json(await owner.post(`/api/patients/${p.id}/packages`, { packageTypeId: otPackageTypeId })).id;
    const res = await admin.post('/api/appointments', { patientId: p.id, serviceId: otServiceId, date: TODAY, time: '07:00', billing: 'paket', patientPackageId: ids.otPackage });
    expect(res.statusCode).toBe(201);
    ids.appt = json(res).ids[0];
    const list = json(await admin.get(`/api/appointments?from=${TODAY}&to=${TODAY}`));
    expect(list.find((a: any) => a.id === ids.appt)).toMatchObject({ therapistMemberId: null, therapistName: null, patientCode: p.patientCode });
    const reminders = await admin.get(`/api/reminders?date=${TODAY}`);
    expect(reminders.statusCode).toBe(200);
  });

  it('terapis belum tertaut: hanya melihat identitas ringkas lewat pencarian No. RM dan jadwal terbuka', async () => {
    expect((await t1.get(`/api/patients/${ids.patient}`)).statusCode).toBe(404);
    const found = json(await t1.get(`/api/absen/patients?q=${encodeURIComponent(ids.code)}`));
    expect(found).toHaveLength(1);
    expect(Object.keys(found[0]).sort()).toEqual(['birthDate', 'fullName', 'id', 'nickname', 'patientCode']);
    const agenda = json(await t1.get('/api/absen/agenda'));
    expect(agenda.waiting.find((r: any) => r.id === ids.appt)).toMatchObject({ patientCode: ids.code, serviceName: 'Okupasi Terapi', therapistName: null });
    // Organisasi lain tidak terlihat; peran tanpa izin absen ditolak.
    const tB = await login(env.app, B.therapist.email);
    expect(json(await tB.get(`/api/absen/patients?q=${encodeURIComponent(ids.code)}`))).toEqual([]);
    const finance = await login(env.app, A.finance.email);
    expect((await finance.get('/api/absen/patients?q=DEMO')).statusCode).toBe(403);
  });

  it('terapis mengabsen jadwal terbuka: sesi selesai, paket terpotong, catatan aktivitas & PR final, terapis tertaut', async () => {
    expect((await t1.post('/api/absen', { patientId: ids.patient, appointmentId: ids.appt })).statusCode).toBe(400);
    const res = await t1.post('/api/absen', {
      patientId: ids.patient,
      appointmentId: ids.appt,
      activities: 'DEMO meronce manik dan meniti papan titian',
      homeProgram: 'DEMO latihan meronce 10 menit setiap hari',
    });
    expect(res.statusCode).toBe(201);
    const r = json(res);
    expect(r).toMatchObject({ appointmentId: ids.appt, billing: 'paket', packageName: 'Paket OT 4 Sesi', sessionsRemaining: 3 });
    expect(await pkgUsed(ids.otPackage)).toBe(1);

    const { rows } = await env.adminPool.query(
      `SELECT a.status, a.therapist_member_id, n.status AS note_status, n.activities IS NOT NULL AS has_act, n.home_program IS NOT NULL AS has_pr,
              (SELECT count(*)::int FROM therapist_compensations c WHERE c.appointment_id = a.id) AS comp
         FROM appointments a LEFT JOIN therapy_notes n ON n.appointment_id = a.id WHERE a.id = $1`,
      [ids.appt],
    );
    expect(rows[0]).toMatchObject({ status: 'selesai', therapist_member_id: A.therapist.memberId, note_status: 'final', has_act: true, has_pr: true });
    expect((await t1.get(`/api/patients/${ids.patient}`)).statusCode).toBe(200);
    // Absen ulang untuk jadwal yang sama ditolak.
    expect((await t1.post('/api/absen', { patientId: ids.patient, appointmentId: ids.appt, activities: 'DEMO' })).statusCode).toBe(409);
  });

  it('anak dengan dua layanan: OT dan TW di hari yang sama oleh terapis berbeda, paket per layanan', async () => {
    // Tanpa jadwal: OT memakai paket OT; absen OT kedua oleh terapis yang sama ditolak.
    const ot = await t1.post('/api/absen', { patientId: ids.patient, serviceId: otServiceId, activities: 'DEMO sesi OT tambahan' });
    expect(ot.statusCode).toBe(409);
    const tw = json(await t2.post('/api/absen', { patientId: ids.patient, serviceId: A.serviceId, activities: 'DEMO latihan artikulasi', homeProgram: 'DEMO menirukan bunyi hewan' }));
    // Belum ada paket TW: per sesi dengan tarif layanan.
    expect(tw).toMatchObject({ billing: 'per_sesi', price: 150000, packageName: null });
    const twPkg = json(await owner.post(`/api/patients/${ids.patient}/packages`, { packageTypeId: A.packageTypeId })).id;
    const yesterday = json(await t2.post('/api/absen', { patientId: ids.patient, serviceId: A.serviceId, date: localDate(-1), time: '09:00', activities: 'DEMO sesi kemarin' }));
    expect(yesterday).toMatchObject({ billing: 'paket', packageName: 'Paket 8 Sesi' });
    expect(await pkgUsed(twPkg)).toBe(1);
    expect(await pkgUsed(ids.otPackage)).toBe(1);
  });

  it('validasi absen: tanggal mendatang, aktivitas wajib untuk terapis, tidak boleh atas nama terapis lain', async () => {
    expect((await t1.post('/api/absen', { patientId: ids.patient, serviceId: A.serviceId, date: localDate(1), activities: 'DEMO' })).statusCode).toBe(400);
    expect((await t1.post('/api/absen', { patientId: ids.patient, serviceId: A.serviceId, date: localDate(-40), activities: 'DEMO' })).statusCode).toBe(400);
    expect((await t1.post('/api/absen', { patientId: ids.patient, serviceId: A.serviceId })).statusCode).toBe(400);
    expect((await t1.post('/api/absen', { patientId: ids.patient, serviceId: A.serviceId, therapistMemberId: A.therapist2.memberId, activities: 'DEMO' })).statusCode).toBe(403);
    expect((await t1.post('/api/absen', { patientId: A.patient2Id, activities: 'DEMO' })).statusCode).toBe(400);
  });

  it('admin mengabsenkan dengan memilih terapis (pengganti) tanpa menulis catatan klinis', async () => {
    const p = await newPatient('DEMO Anak Absen Dua');
    const appt = json(await admin.post('/api/appointments', { patientId: p.id, therapistMemberId: A.therapist.memberId, serviceId: A.serviceId, date: TODAY, time: '08:00', billing: 'per_sesi' })).ids[0];
    expect((await admin.post('/api/absen', { patientId: p.id, appointmentId: appt, therapistMemberId: A.therapist2.memberId, activities: 'DEMO' })).statusCode).toBe(403);
    const res = await admin.post('/api/absen', { patientId: p.id, appointmentId: appt, therapistMemberId: A.therapist2.memberId });
    expect(res.statusCode).toBe(201);
    expect(json(res).noteId).toBeNull();
    const { rows } = await env.adminPool.query(`SELECT meta FROM audit_logs WHERE action = 'sesi.diabsen' AND entity_id = $1`, [appt]);
    expect(rows[0].meta).toMatchObject({ terapis: A.therapist2.memberId, menggantikan: A.therapist.memberId, catatan: false });
    // Terapis pengganti kini tertaut dan dapat menulis catatan sesi itu belakangan.
    expect((await t2.get(`/api/patients/${p.id}`)).statusCode).toBe(200);

    // Tombol "Selesai" untuk jadwal tanpa terapis: admin wajib memilih terapis; terapis diarahkan ke absen.
    const open = json(await admin.post('/api/appointments', { patientId: p.id, serviceId: A.serviceId, date: TODAY, time: '09:30', billing: 'tanpa_biaya' })).ids[0];
    expect((await admin.post(`/api/appointments/${open}/complete`, {})).statusCode).toBe(400);
    expect((await t2.post(`/api/appointments/${open}/complete`, {})).statusCode).toBe(403);
    expect((await admin.post(`/api/appointments/${open}/complete`, { therapistMemberId: A.therapist.memberId })).statusCode).toBe(200);
  });
});

describe('Video/foto sesi', () => {
  let appt: string;
  let video: string;

  beforeAll(async () => {
    const agenda = json(await t1.get('/api/absen/agenda'));
    appt = agenda.done.find((r: any) => r.therapistMemberId === A.therapist.memberId).id;
  });

  it('terapis mengunggah video ≥30 detik dan foto; video pendek, HEIC, dan jenis lain ditolak', async () => {
    const ok = await upload(t1, appt, 'sesi.mp4', mp4(45));
    expect(ok.statusCode).toBe(201);
    video = json(ok).id;
    expect((await upload(t1, appt, 'foto.jpg', JPEG)).statusCode).toBe(201);
    const short = await upload(t1, appt, 'pendek.mp4', mp4(12));
    expect(short.statusCode).toBe(400);
    expect(json(short).error.message).toMatch(/minimal 30 detik \(video ini 12 detik\)/);
    expect((await upload(t1, appt, 'foto.heic', HEIC)).statusCode).toBe(400);
    expect((await upload(t1, appt, 'teks.txt', Buffer.from('DEMO bukan video'))).statusCode).toBe(400);
    // Terapis lain yang tidak menangani sesi ini tidak dapat menambah.
    expect((await upload(t2, appt, 'sesi.mp4', mp4(40))).statusCode).toBe(403);
  });

  it('hanya owner dan terapis yang menangani yang melihat; admin, keuangan, dan organisasi lain tertutup', async () => {
    expect(json(await t1.get(`/api/appointments/${appt}/media`)).map((m: any) => m.kind).sort()).toEqual(['foto', 'video']);
    expect(json(await owner.get(`/api/appointments/${appt}/media`))).toHaveLength(2);
    expect((await admin.get(`/api/appointments/${appt}/media`)).statusCode).toBe(403);
    expect((await admin.get(`/api/media/${video}`)).statusCode).toBe(403);
    const ownerB = await login(env.app, B.owner.email);
    expect((await ownerB.get(`/api/media/${video}`)).statusCode).toBe(404);

    const full = await t1.get(`/api/media/${video}`);
    expect(full.statusCode).toBe(200);
    expect(full.headers['content-type']).toBe('video/mp4');
    const part = await t1.request('GET', `/api/media/${video}`, undefined, { range: 'bytes=0-9' });
    expect(part.statusCode).toBe(206);
    expect(part.rawPayload.length).toBe(10);
    expect(part.headers['content-range']).toMatch(/^bytes 0-9\/\d+$/);
  });

  it('pengunggah dapat menghapus; kuota organisasi menghitung video/foto', async () => {
    const storage = json(await owner.get('/api/org/storage'));
    expect(storage.usedBytes).toBeGreaterThan(0);
    // Terapis 2 juga menangani anak ini (sesi TW): boleh melihat, tetapi tidak menghapus milik terapis lain.
    expect(json(await t2.get(`/api/appointments/${appt}/media`))).toHaveLength(2);
    expect((await t2.post(`/api/media/${video}/archive`)).statusCode).toBe(403);
    expect((await t1.post(`/api/media/${video}/archive`)).statusCode).toBe(200);
    expect(json(await t1.get(`/api/appointments/${appt}/media`))).toHaveLength(1);
  });
});

describe('Pendaftaran pasien baru dan login orang tua dengan No. RM', () => {
  let p: { id: string; patientCode: string };

  it('formulir lengkap: tempat lahir, ayah & ibu, keluhan awal, hasil pemeriksaan, program OT+TW', async () => {
    p = await newPatient('DEMO Anak Daftar Lengkap', {
      birthPlace: 'Karanganyar',
      birthDate: '2019-04-02',
      address: 'Jl. Demo Kenanga 3',
      guardians: [
        { fullName: 'DEMO Ayah Lengkap', relationship: 'Ayah', phone: '081200002001' },
        { fullName: 'DEMO Ibu Lengkap', relationship: 'Ibu', phone: '081200002002', isPrimary: true },
      ],
      intake: { complaint: 'DEMO keluhan awal', findings: 'DEMO hasil pemeriksaan', programServiceIds: [otServiceId, A.serviceId], programNotes: 'DEMO program sensori' },
    });
    const view = json(await admin.get(`/api/patients/${p.id}`));
    expect(view).toMatchObject({ birthPlace: 'Karanganyar', intake: { complaint: 'DEMO keluhan awal', programServices: ['Okupasi Terapi', 'Terapi Wicara'] } });
    expect(view.guardians).toHaveLength(2);
  });

  it('data pemeriksaan: keuangan tidak melihat; terapis melihat setelah tertaut; organisasi lain tertutup', async () => {
    const finance = await login(env.app, A.finance.email);
    expect(json(await finance.get(`/api/patients/${p.id}`)).intake).toBeUndefined();
    expect((await t1.put(`/api/patients/${p.id}/intake`, { findings: 'DEMO' })).statusCode).toBe(404);
    await t1.post('/api/absen', { patientId: p.id, serviceId: otServiceId, activities: 'DEMO sesi pertama' });
    expect(json(await t1.get(`/api/patients/${p.id}`)).intake.findings).toBe('DEMO hasil pemeriksaan');
    expect((await t1.put(`/api/patients/${p.id}/intake`, { findings: 'DEMO hasil asesmen ulang', programServiceIds: [otServiceId] })).statusCode).toBe(200);
    const { rows } = await env.adminPool.query(`SELECT findings, complaint FROM patient_intakes WHERE patient_id = $1`, [p.id]);
    expect(rows[0]).toEqual({ findings: 'DEMO hasil asesmen ulang', complaint: null });
    const ownerB = await login(env.app, B.owner.email);
    expect((await ownerB.put(`/api/patients/${p.id}/intake`, { findings: 'DEMO' })).statusCode).toBe(404);
    // Keuangan tidak boleh mengisi data pemeriksaan saat mendaftarkan pasien (keuangan juga tidak boleh mendaftarkan).
    expect((await finance.post('/api/patients', { fullName: 'DEMO X', intake: { complaint: 'DEMO' } })).statusCode).toBe(403);
  });

  it('informed consent: berkas berjenis informed_consent menandai pasien sudah ber-consent', async () => {
    expect(json(await admin.get(`/api/patients/${p.id}`)).hasConsent).toBe(false);
    const send = (fields: Record<string, string>) => {
      const body = multipartBody(fields, { name: 'consent.jpg', content: JPEG });
      return env.app.inject({
        method: 'POST',
        url: `/api/patients/${p.id}/documents`,
        payload: body.payload,
        headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf, origin: ORIGIN, 'content-type': body.contentType },
      });
    };
    expect((await send({ title: 'Foto informed consent', category: 'klinis', docType: 'informed_consent' })).statusCode).toBe(400);
    expect((await send({ title: 'Foto informed consent', category: 'administrasi', docType: 'lainnya' })).statusCode).toBe(400);
    expect((await send({ title: 'Foto informed consent', category: 'administrasi', docType: 'informed_consent' })).statusCode).toBe(201);
    expect(json(await admin.get(`/api/patients/${p.id}`)).hasConsent).toBe(true);
    const docs = json(await admin.get(`/api/patients/${p.id}/documents`));
    expect(docs.map((d: any) => d.docType)).toEqual(['informed_consent']);
  });

  it('undangan orang tua menyarankan No. RM anak sebagai username', async () => {
    const g = json(await admin.get(`/api/patients/${p.id}`)).guardians.find((x: any) => x.relationship === 'Ibu');
    const inv = json(await admin.post(`/api/guardians/${g.id}/invite`));
    const token = inv.url.split('#token=')[1];
    const info = json(await env.app.inject({ method: 'POST', url: '/api/auth/token-info', payload: { token }, headers: { origin: ORIGIN } }));
    expect(info.suggestedUsername).toBe(p.patientCode.toLowerCase());
    const accept = await env.app.inject({
      method: 'POST',
      url: '/api/auth/accept-invitation',
      payload: { token, username: info.suggestedUsername, password: 'SandiWaliAman#2026' },
      headers: { origin: ORIGIN },
    });
    expect(accept.statusCode).toBe(200);
    // Masuk dengan No. RM apa adanya (huruf besar).
    const parent = await login(env.app, p.patientCode, 'SandiWaliAman#2026');
    const portal = json(await parent.get('/api/portal'));
    expect(portal.children.map((c: any) => c.patientCode)).toEqual([p.patientCode]);
  });

  it('RLS: data pemeriksaan dan video/foto tertutup di database untuk cakupan none, terbuka untuk owner', async () => {
    const count = (settings: Record<string, string>) =>
      withTx(env.appPool, { settings: { 'app.mode': 'tenant', 'app.org_id': A.orgId, 'app.scope_finance': 'none', 'app.scope_audit': 'none', ...settings } }, async (db) => ({
        intakes: (await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM patient_intakes`)).n,
        media: (await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM session_media`)).n,
      }));
    const financeLike = await count({ 'app.member_id': A.finance.memberId, 'app.scope_patient': 'all', 'app.scope_note': 'none', 'app.scope_intake': 'none' });
    expect(financeLike).toEqual({ intakes: 0, media: 0 });
    const ownerLike = await count({ 'app.member_id': A.owner.memberId, 'app.scope_patient': 'all', 'app.scope_note': 'all', 'app.scope_intake': 'all' });
    expect(ownerLike.intakes).toBeGreaterThan(0);
    expect(ownerLike.media).toBeGreaterThan(0);
    // Admin: data pemeriksaan ya, video/foto tidak.
    const adminLike = await count({ 'app.member_id': A.admin.memberId, 'app.scope_patient': 'all', 'app.scope_note': 'none', 'app.scope_intake': 'all' });
    expect(adminLike.media).toBe(0);
    expect(adminLike.intakes).toBe(ownerLike.intakes);
  });

  it('anonimisasi menghapus tempat lahir dan video/foto anak', async () => {
    const appt = json(await t1.get('/api/absen/agenda')).done.find((r: any) => r.patientId === p.id).id;
    expect((await upload(t1, appt, 'sesi.mp4', mp4(31))).statusCode).toBe(201);
    const res = await owner.post(`/api/patients/${p.id}/anonymize`, { mode: 'penuh', confirmCode: p.patientCode, reason: 'DEMO permintaan penghapusan wali' });
    expect(res.statusCode).toBe(200);
    const { rows } = await env.adminPool.query(
      `SELECT p.birth_place, (SELECT count(*)::int FROM session_media m WHERE m.patient_id = p.id AND m.archived_at IS NULL) AS media,
              (SELECT findings FROM patient_intakes i WHERE i.patient_id = p.id) AS findings
         FROM patients p WHERE p.id = $1`,
      [p.id],
    );
    expect(rows[0]).toEqual({ birth_place: null, media: 0, findings: null });
  });
});
