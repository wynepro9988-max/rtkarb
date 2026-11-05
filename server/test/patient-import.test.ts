import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { headerField, parseDate } from '../src/lib/patient-import.ts';
import { readSpreadsheet } from '../src/lib/spreadsheet-read.ts';
import { buildXlsx, zip } from '../src/lib/xlsx.ts';
import { buildTenant, json, login, multipartBody, ORIGIN, setupEnv, type Agent, type Tenant, type TestEnv } from './helpers.ts';

// Impor pasien dari Excel/CSV berformat bebas. Semua data uji adalah data DEMO.
let env: TestEnv;
let A: Tenant;
let B: Tenant;
let owner: Agent;

function send(agent: Agent, url: string, file: { name: string; content: Buffer }, fields: Record<string, string> = {}) {
  const body = multipartBody(fields, file);
  return env.app.inject({
    method: 'POST',
    url,
    payload: body.payload,
    headers: { cookie: agent.cookie, 'x-csrf-token': agent.csrf, origin: ORIGIN, 'content-type': body.contentType },
  });
}
const preview = (agent: Agent, file: { name: string; content: Buffer }, fields?: Record<string, string>) => send(agent, '/api/patients/import/preview', file, fields);
const commit = (agent: Agent, file: { name: string; content: Buffer }, fields?: Record<string, string>) => send(agent, '/api/patients/import', file, fields);

// Lembar "bebas": judul laporan, baris kosong, judul kolom dua tingkat, format tanggal campur.
const messy = {
  name: 'data-anak.xlsx',
  content: buildXlsx([
    {
      name: 'Pasien',
      columns: [{ header: 'DATA ANAK DEMO 2025' }, ...Array.from({ length: 11 }, () => ({ header: '' }))],
      rows: [
        [],
        ['No', 'Nama Anak', 'Panggilan', 'Tgl Lahir', 'L/P', 'Data Ibu', '', 'Data Ayah', '', 'Alamat', 'Sekolah', 'Status'],
        ['', '', '', '', '', 'Nama', 'No HP', 'Nama', 'No HP', '', '', ''],
        [1, 'DEMO Anak Satu', 'Satu', '12/03/2019', 'L', 'DEMO Ibu Satu', '0812-0000-0001 / 0813-0000-0009', 'DEMO Ayah Satu', 81200000002, 'Jl. Demo 1', 'TK Demo', 'Aktif'],
        [2, 'DEMO Anak Dua', '', '5 Juni 2018', 'Perempuan', '', '081200000003', '', '', '', '', 'cuti'],
        [3, '', '', '', '', '', '', '', '', '', '', ''],
        [4, 'DEMO Anak Tiga', '', '31/02/2019', 'LP', 'DEMO Ibu Tiga', '', '', '', '', '', 'Lulus'],
        [5, 'DEMO Anak Satu', '', '12/03/2019', 'L', '', '', '', '', '', '', ''],
        [6, 'DEMO Sudah Ada', '', '', '', '', '', '', '', '', '', ''],
        [7, '-', '', '01/01/2020', 'P', '', '', '', '', '', '', ''],
      ],
    },
  ]),
};

beforeAll(async () => {
  env = await setupEnv();
  A = await buildTenant(env.adminPool, 'A');
  B = await buildTenant(env.adminPool, 'B');
  owner = await login(env.app, A.owner.email);
  expect((await owner.post('/api/patients', { fullName: 'DEMO Sudah Ada' })).statusCode).toBe(201);
});
afterAll(() => env.close());

describe('Pengenalan judul kolom dan tanggal', () => {
  it('judul kolom yang umum dipakai dikenali', () => {
    const cases: Record<string, string | null> = {
      Nama: 'fullName',
      'NAMA LENGKAP ANAK': 'fullName',
      'Nama Panggilan': 'nickname',
      'Tgl. Lahir': 'birthDate',
      'Tempat, Tanggal Lahir': 'birthDate',
      'Tempat Lahir': 'birthPlace',
      'L/P': 'sex',
      'Jenis Kelamin': 'sex',
      'Nama Ibu': 'motherName',
      'No. WA Ayah': 'fatherPhone',
      'Nama Orang Tua/Wali': 'guardianName',
      'No. HP/WA': 'guardianPhone',
      'E-mail Ortu': 'guardianEmail',
      'Alamat Orang Tua': 'address',
      'Pekerjaan Ibu': 'lain',
      'Nama Sekolah': 'lain',
      'Nama Terapis': 'lain',
      'Tgl Daftar': 'registeredOn',
      'Status Anak': 'status',
      'Kode Pasien': 'notes',
      Keterangan: 'notes',
      Diagnosa: 'findings',
      KELUHAN: 'complaint',
      'Cap waktu': 'registeredOn',
      Timestamp: 'registeredOn',
      'HARI PEMERIKSAAN ASSESMENT': 'lain',
      'Budi Santoso': null,
    };
    for (const [label, field] of Object.entries(cases)) expect([label, headerField(label)]).toEqual([label, field]);
  });

  it('tanggal berbagai bentuk; tanggal mustahil ditolak', () => {
    expect(parseDate('12/03/2019')).toBe('2019-03-12');
    expect(parseDate('12-3-19')).toBe('2019-03-12');
    expect(parseDate('03/25/2019')).toBe('2019-03-25');
    expect(parseDate('03/04/2019')).toBe('2019-04-03');
    expect(parseDate('03/04/2019', { monthFirst: true })).toBe('2019-03-04');
    expect(parseDate('5 Juni 2018')).toBe('2018-06-05');
    expect(parseDate('12-Mar-2019')).toBe('2019-03-12');
    expect(parseDate('2019-03-12 00:00:00')).toBe('2019-03-12');
    expect(parseDate('Surakarta, 12 Maret 2019')).toBeNull();
    expect(parseDate('Surakarta, 12 Maret 2019', { loose: true })).toBe('2019-03-12');
    expect(parseDate('31/02/2019')).toBeNull();
    expect(parseDate('0812-3456-7890', { loose: true })).toBeNull();
  });
});

describe('Pembaca berkas', () => {
  it('XLSX: shared string, rich text, sel tanggal, angka besar, lembar tersembunyi dilewati', () => {
    const x = (s: string) => Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>${s}`, 'utf8');
    const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
    const buf = zip([
      {
        name: 'xl/workbook.xml',
        data: x(
          `<workbook ${NS} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
            '<sheet name="Rahasia" sheetId="1" state="hidden" r:id="rId1"/><sheet name="Data &amp; Pasien" sheetId="2" r:id="rId2"/></sheets></workbook>',
        ),
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        data: x(
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
            '<Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/>' +
            '<Relationship Id="rId2" Type="worksheet" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
        ),
      },
      {
        name: 'xl/sharedStrings.xml',
        data: x(`<sst ${NS}><si><t>Nama</t></si><si><r><t>Tgl </t></r><r><t>Lahir</t></r></si><si><t>DEMO Anak &amp; Satu</t><rPh><t>x</t></rPh></si></sst>`),
      },
      {
        name: 'xl/styles.xml',
        data: x(
          `<styleSheet ${NS}><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy;@"/></numFmts>` +
            '<cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="3"/></cellXfs></styleSheet>',
        ),
      },
      { name: 'xl/worksheets/sheet1.xml', data: x(`<worksheet ${NS}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>rahasia</t></is></c></row></sheetData></worksheet>`) },
      {
        name: 'xl/worksheets/sheet2.xml',
        data: x(
          `<worksheet ${NS}><sheetData>` +
            '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>No HP</t></is></c></row>' +
            '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" s="1"><v>43536</v></c><c r="C2"><v>81200000001</v></c></row>' +
            '<row r="4"><c r="A4" t="str"><f>A2</f><v>DEMO Dua</v></c><c r="B4" s="2"><v>43800.5</v></c><c r="D4" s="3"><v>1234.5</v></c></row>' +
            '</sheetData></worksheet>',
        ),
      },
    ]);
    const sheets = readSpreadsheet(buf);
    expect(sheets.map((s) => s.name)).toEqual(['Data & Pasien']);
    expect(sheets[0].rows).toEqual([
      ['Nama', 'Tgl Lahir', 'No HP'],
      ['DEMO Anak & Satu', '2019-03-12', '81200000001'],
      [],
      ['DEMO Dua', '2019-12-01', '', '1234.5'],
    ]);
  });

  it('CSV: pemisah titik koma, tanda kutip, BOM, dan Windows-1252', () => {
    const utf8 = Buffer.from('﻿Nama;Alamat\r\nDEMO Anak;"Jl. Demo; No ""4""\nRT 1"\r\n', 'utf8');
    expect(readSpreadsheet(utf8)[0].rows).toEqual([
      ['Nama', 'Alamat'],
      ['DEMO Anak', 'Jl. Demo; No "4"\nRT 1'],
    ]);
    const latin = Buffer.concat([Buffer.from('Nama,Kota\nDEMO Ren'), Buffer.from([0xe9]), Buffer.from(',Solo\n')]);
    expect(readSpreadsheet(latin)[0].rows[1]).toEqual(['DEMO René', 'Solo']);
  });

  it('format lama .xls ditolak dengan petunjuk', () => {
    const xls = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64)]);
    expect(() => readSpreadsheet(xls)).toThrow(/\.xls/);
  });
});

describe('Pratinjau dan impor melalui API', () => {
  it('pratinjau mendeteksi judul dua tingkat, merapikan isi, dan menandai duplikat', async () => {
    const res = await preview(owner, messy);
    expect(res.statusCode).toBe(200);
    const p = json(res);
    expect(p.headerRows).toEqual([3, 4]);
    const byLetter = Object.fromEntries(p.columns.map((c: any) => [c.letter, c.field]));
    expect(byLetter).toEqual({
      A: null,
      B: 'fullName',
      C: 'nickname',
      D: 'birthDate',
      E: 'sex',
      F: 'motherName',
      G: 'motherPhone',
      H: 'fatherName',
      I: 'fatherPhone',
      J: 'address',
      K: null,
      L: 'status',
    });
    expect(p.summary).toEqual({ total: 6, siap: 3, duplikat: 2, dilewati: 1 });

    const row = (n: number) => p.rows.find((r: any) => r.row === n);
    expect(row(5)).toMatchObject({
      status: 'siap',
      patient: {
        fullName: 'DEMO Anak Satu',
        nickname: 'Satu',
        birthDate: '2019-03-12',
        sex: 'L',
        status: 'aktif',
        address: 'Jl. Demo 1',
        guardians: [
          { fullName: 'DEMO Ibu Satu', relationship: 'Ibu', phone: '081200000001', isPrimary: true },
          { fullName: 'DEMO Ayah Satu', relationship: 'Ayah', phone: '081200000002', isPrimary: false },
        ],
      },
    });
    expect(row(5).issues).toEqual(['No. HP ibu: hanya nomor pertama yang diimpor']);
    expect(row(6).patient).toMatchObject({ birthDate: '2018-06-05', sex: 'P', status: 'nonaktif', guardians: [{ fullName: 'Ibu DEMO Anak Dua', phone: '081200000003' }] });
    expect(row(8).patient).toMatchObject({ birthDate: null, sex: null, status: 'selesai' });
    expect(row(8).issues.join(' ')).toMatch(/Tanggal lahir "31\/02\/2019" tidak dikenali.*Jenis kelamin "LP"/);
    expect(row(9)).toMatchObject({ status: 'duplikat', issues: ['Sama dengan baris 5'] });
    expect(row(10).status).toBe('duplikat');
    expect(row(10).issues[0]).toMatch(/^Sudah terdaftar sebagai /);
    expect(row(11)).toMatchObject({ status: 'dilewati', issues: ['Nama anak kosong'] });
    // Baris 7 hanya berisi nomor urut: tidak ditampilkan.
    expect(row(7)).toBeUndefined();
  });

  it('pemetaan manual: beberapa kolom digabung ke catatan; satu isian tidak boleh dua kolom', async () => {
    const auto = json(await preview(owner, messy));
    const mapping = Object.fromEntries(auto.columns.map((c: any) => [c.index, c.field ?? '']));
    const J = auto.columns.find((c: any) => c.letter === 'J').index;
    const K = auto.columns.find((c: any) => c.letter === 'K').index;
    const manual = json(await preview(owner, messy, { mapping: JSON.stringify({ ...mapping, [J]: 'notes', [K]: 'notes' }) }));
    const r5 = manual.rows.find((r: any) => r.row === 5).patient;
    expect(r5).toMatchObject({ address: null, adminNotes: 'Alamat: Jl. Demo 1\nSekolah: TK Demo' });

    const B_ = auto.columns.find((c: any) => c.letter === 'B').index;
    const C_ = auto.columns.find((c: any) => c.letter === 'C').index;
    const twice = await preview(owner, messy, { mapping: JSON.stringify({ [B_]: 'fullName', [C_]: 'fullName' }) });
    expect(twice.statusCode).toBe(400);
    expect(json(twice).error.message).toMatch(/Nama lengkap anak/);

    const noName = json(await preview(owner, messy, { mapping: JSON.stringify({ [C_]: 'nickname' }) }));
    expect(noName.rows).toEqual([]);
    expect(noName.hasName).toBe(false);
    expect((await commit(owner, messy, { mapping: JSON.stringify({ [C_]: 'nickname' }) })).statusCode).toBe(400);
  });

  it('impor menyimpan baris yang siap, melewati baris yang dikecualikan dan duplikat, lalu tercatat di audit', async () => {
    const res = await commit(owner, messy, { skip: JSON.stringify([6]) });
    expect(res.statusCode).toBe(201);
    const r = json(res);
    expect(r).toMatchObject({ created: 2, notImported: 4 });

    const { rows } = await env.adminPool.query(
      `SELECT p.full_name, p.birth_date::text AS birth_date, p.sex, p.status, p.patient_code,
              (SELECT json_agg(json_build_object('n', g.full_name, 'r', g.relationship, 'ph', g.phone, 'pr', g.is_primary) ORDER BY g.created_at, g.relationship DESC)
                 FROM guardians g WHERE g.patient_id = p.id) AS guardians
         FROM patients p WHERE p.organization_id = $1 AND p.full_name IN ('DEMO Anak Satu', 'DEMO Anak Dua', 'DEMO Anak Tiga') ORDER BY p.patient_code`,
      [A.orgId],
    );
    expect(rows.map((p) => [p.full_name, p.birth_date, p.sex, p.status])).toEqual([
      ['DEMO Anak Satu', '2019-03-12', 'L', 'aktif'],
      ['DEMO Anak Tiga', null, null, 'selesai'],
    ]);
    expect(rows[0].guardians).toHaveLength(2);
    expect(rows[0].guardians.filter((g: any) => g.pr)).toEqual([{ n: 'DEMO Ibu Satu', r: 'Ibu', ph: '081200000001', pr: true }]);
    expect([r.firstCode, r.lastCode]).toEqual([rows[0].patient_code, rows[1].patient_code]);

    const audit = await env.adminPool.query(`SELECT meta FROM audit_logs WHERE organization_id = $1 AND action = 'pasien.diimpor'`, [A.orgId]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].meta).toMatchObject({ jumlah: 2, duplikat_diimpor: 0, tidak_diimpor: 4 });

    // Impor ulang berkas yang sama: yang sudah masuk kini terdeteksi sebagai duplikat.
    expect((await commit(owner, messy, { skip: JSON.stringify([6]) })).statusCode).toBe(400);
    const again = json(await preview(owner, messy));
    expect(again.summary).toMatchObject({ siap: 1, duplikat: 4 });
  });

  it('duplikat tetap dapat diimpor bila dipilih', async () => {
    const csv = { name: 'ulang.csv', content: Buffer.from('Nama;Tgl Lahir\nDEMO Sudah Ada;01/02/2019\n') };
    expect(json(await preview(owner, csv)).summary).toMatchObject({ siap: 0, duplikat: 1 });
    expect((await commit(owner, csv)).statusCode).toBe(400);
    expect(json(await commit(owner, csv, { includeDuplicates: 'true' })).created).toBe(1);
  });

  it('CSV tanpa judul kolom: kolom ditebak dari isinya', async () => {
    const csv = { name: 'tanpa-judul.csv', content: Buffer.from('DEMO Anak Empat;2017-08-17;P;0812 0000 0004\nDEMO Anak Lima;17-08-2016;L;\n') };
    const p = json(await preview(owner, csv));
    expect(p.headerRows).toEqual([]);
    expect(p.columns.map((c: any) => c.field)).toEqual(['fullName', 'birthDate', 'sex', 'guardianPhone']);
    expect(p.notices[0]).toMatch(/Judul kolom tidak ditemukan/);
    expect(p.rows[0].patient).toMatchObject({ fullName: 'DEMO Anak Empat', birthDate: '2017-08-17', sex: 'P' });
    // Nomor tanpa nama wali tetap disimpan dengan nama pengganti yang jelas.
    expect(p.rows[0].patient.guardians).toEqual([{ fullName: 'Orang tua DEMO Anak Empat', relationship: 'Orang tua', phone: '081200000004', email: null, isPrimary: true }]);
  });

  it('formulir Google (tiruan DEMO): TTL dipisah jadi tempat & tanggal lahir, keluhan jadi data pemeriksaan, kiriman ganda terdeteksi', async () => {
    const form = {
      name: 'form-responses.xlsx',
      content: buildXlsx([
        {
          name: 'Form Responses 1',
          columns: ['Timestamp', 'NAMA LENGKAP ANAK', 'TEMPAT, TANGGAL LAHIR ANAK', 'NAMA ORANG TUA / WALI', 'ALAMAT', 'KELUHAN', 'HARI PEMERIKSAAN ASSESMENT', 'Nomor WA AKTIF', 'JAM PEMERIKSAAN ASSESMENT'].map((header) => ({ header })),
          rows: [
            ['16/07/2025 10:33:06', 'DEMO Form Satu', 'Wonogiri, 31 Maret 2021', 'DEMO Ibu & DEMO Ayah', 'DEMO Perum Contoh RT 01', 'DEMO kurang fokus', 'Kamis sore', '081200004001', ''],
            ['01/08/2025 12:49:20', 'DEMO Form Dua', 'Karanganyar 18 September 2019', 'DEMO Wali Dua', 'DEMO Dusun Contoh', 'DEMO motorik halus kurang', 'Rabu', '089600004002', ''],
            ['02/08/2025 12:12:43', 'DEMO Form Satu', 'Wonogiri, 31 Maret 2021', 'DEMO Ibu & DEMO Ayah', 'DEMO Perum Contoh RT 01', 'DEMO kurang fokus', 'Selasa', '081200004001', ''],
            ['07/05/2026 17:24:34', 'DEMO FORM TIGA', 'SURAKARTA, 11 APRIL 2025', 'DEMO WALI TIGA', 'DEMO PERUM', 'DEMO GTM', '08/05/2026', '08562900825', '11:00:00'],
          ],
        },
      ]),
    };
    const p = json(await preview(owner, form));
    expect(Object.fromEntries(p.columns.map((c: any) => [c.label, c.field]))).toEqual({
      Timestamp: 'registeredOn',
      'NAMA LENGKAP ANAK': 'fullName',
      'TEMPAT, TANGGAL LAHIR ANAK': 'birthDate',
      'NAMA ORANG TUA / WALI': 'guardianName',
      ALAMAT: 'address',
      KELUHAN: 'complaint',
      'HARI PEMERIKSAAN ASSESMENT': null,
      'Nomor WA AKTIF': 'guardianPhone',
      'JAM PEMERIKSAAN ASSESMENT': null,
    });
    expect(p.fields.find((f: any) => f.key === 'complaint')).toMatchObject({ group: 'pemeriksaan' });
    expect(p.summary).toEqual({ total: 4, siap: 3, duplikat: 1, dilewati: 0 });
    expect(p.rows[0].patient).toMatchObject({
      birthPlace: 'Wonogiri',
      birthDate: '2021-03-31',
      registeredOn: '2025-07-16',
      intake: { complaint: 'DEMO kurang fokus', findings: null },
      guardians: [{ fullName: 'DEMO Ibu & DEMO Ayah', relationship: 'Orang tua', phone: '081200004001', isPrimary: true }],
    });
    expect(p.rows[1].patient).toMatchObject({ birthPlace: 'Karanganyar', birthDate: '2019-09-18' });
    expect(p.rows[2]).toMatchObject({ status: 'duplikat', issues: ['Sama dengan baris 2'] });
    expect(p.rows[3].patient).toMatchObject({ birthPlace: 'SURAKARTA', birthDate: '2025-04-11', registeredOn: '2026-05-07' });

    const r = json(await commit(owner, form));
    expect(r.created).toBe(3);
    const { rows } = await env.adminPool.query(
      `SELECT p.full_name, p.birth_place, p.registered_on::text AS reg, i.complaint
         FROM patients p LEFT JOIN patient_intakes i ON i.patient_id = p.id
        WHERE p.organization_id = $1 AND p.full_name ILIKE 'DEMO Form%' ORDER BY lower(p.full_name)`,
      [A.orgId],
    );
    expect(rows).toEqual([
      { full_name: 'DEMO Form Dua', birth_place: 'Karanganyar', reg: '2025-08-01', complaint: 'DEMO motorik halus kurang' },
      { full_name: 'DEMO Form Satu', birth_place: 'Wonogiri', reg: '2025-07-16', complaint: 'DEMO kurang fokus' },
      { full_name: 'DEMO FORM TIGA', birth_place: 'SURAKARTA', reg: '2026-05-07', complaint: 'DEMO GTM' },
    ]);
    // Pasien hasil impor belum punya foto informed consent.
    const list = json(await owner.get('/api/patients?q=DEMO%20Form&status=aktif'));
    expect(list.items.every((x: any) => x.hasConsent === false)).toBe(true);
  });

  it('PDF ditolak dengan petunjuk mengunduh Excel dari Google Sheets', async () => {
    const pdf = { name: 'form.pdf', content: Buffer.from('%PDF-1.4\n% DEMO\n') };
    const res = await preview(owner, pdf);
    expect(res.statusCode).toBe(400);
    expect(json(res).error.message).toMatch(/Download → Microsoft Excel/);
  });

  it('batas jumlah baris dan jenis berkas', async () => {
    const big = { name: 'besar.csv', content: Buffer.from(`Nama\n${Array.from({ length: 2001 }, (_, i) => `DEMO Anak ${i}`).join('\n')}\n`) };
    const res = await preview(owner, big);
    expect(res.statusCode).toBe(400);
    expect(json(res).error.message).toMatch(/Maksimal 2000 baris/);
    const xls = { name: 'lama.xls', content: Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64)]) };
    expect((await preview(owner, xls)).statusCode).toBe(400);
  });

  it('hak akses: admin boleh, terapis dan keuangan tidak; organisasi lain tidak melihat pasien organisasi ini', async () => {
    const admin = await login(env.app, A.admin.email);
    expect((await preview(admin, messy)).statusCode).toBe(200);
    for (const who of [A.therapist.email, A.finance.email]) {
      const agent = await login(env.app, who);
      expect((await preview(agent, messy)).statusCode).toBe(403);
      expect((await commit(agent, messy)).statusCode).toBe(403);
    }
    const ownerB = await login(env.app, B.owner.email);
    const p = json(await preview(ownerB, messy));
    // "DEMO Sudah Ada" dan pasien hasil impor A tidak terlihat sebagai duplikat di organisasi B.
    expect(p.summary).toMatchObject({ siap: 4, duplikat: 1 });
    expect(p.rows.find((r: any) => r.row === 9).issues).toEqual(['Sama dengan baris 5']);
  });
});
