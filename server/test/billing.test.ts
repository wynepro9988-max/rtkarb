import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTenant, json, localDate, login, pdfText, setupEnv, type Agent, type Tenant, type TestEnv } from './helpers.ts';

let env: TestEnv;
let A: Tenant;
let B: Tenant;
let owner: Agent;
let finance: Agent;

async function newPackage(patientId = A.patientId) {
  return json(await owner.post(`/api/patients/${patientId}/packages`, { packageTypeId: A.packageTypeId })).id as string;
}

async function newSession(time: string) {
  const r = await owner.post('/api/appointments', {
    patientId: A.patientId,
    therapistMemberId: A.therapist.memberId,
    serviceId: A.serviceId,
    date: localDate(-1),
    time,
    billing: 'per_sesi',
  });
  expect(r.statusCode, r.body).toBe(201);
  return json(r).ids[0] as string;
}

beforeAll(async () => {
  env = await setupEnv();
  A = await buildTenant(env.adminPool, 'A');
  B = await buildTenant(env.adminPool, 'B');
  owner = await login(env.app, A.owner.email);
  finance = await login(env.app, A.finance.email);
});
afterAll(() => env.close());

describe('Invoice & diskon', () => {
  it('harga paket/sesi diambil dari database; total = subtotal - diskon', async () => {
    const pkg = await newPackage();
    const sess = await newSession('07:00');
    const res = await owner.post('/api/invoices', {
      patientId: A.patientId,
      discountReason: 'DEMO keringanan keluarga',
      items: [
        { kind: 'paket', patientPackageId: pkg, discountAmount: 100000 },
        { kind: 'sesi', appointmentId: sess },
        { kind: 'lainnya', description: 'DEMO buku panduan', quantity: 2, unitPrice: 25000 },
      ],
    });
    expect(res.statusCode, res.body).toBe(201);
    const inv = json(await owner.get(`/api/invoices/${json(res).id}`));
    expect(inv.subtotal).toBe(1000000 + 150000 + 50000);
    expect(inv.discountTotal).toBe(100000);
    expect(inv.total).toBe(1100000);
    expect(inv.paymentStatus).toBe('belum_dibayar');
    expect(inv.invoiceNo).toMatch(/^INV\/\d{4}\/\d{5}$/);
  });

  it('diskon tanpa alasan ditolak; kasir tidak boleh memberi diskon bila batas organisasi 0%', async () => {
    const pkg = await newPackage();
    expect((await owner.post('/api/invoices', { patientId: A.patientId, items: [{ kind: 'paket', patientPackageId: pkg, discountAmount: 1000 }] })).statusCode).toBe(400);
    const res = await finance.post('/api/invoices', {
      patientId: A.patientId,
      discountReason: 'DEMO',
      items: [{ kind: 'paket', patientPackageId: pkg, discountAmount: 1000 }],
    });
    expect(res.statusCode).toBe(403);
  });

  it('kasir boleh memberi diskon sampai batas persen yang diatur owner', async () => {
    expect((await owner.patch('/api/org', { financeDiscountMaxPercent: 10 })).statusCode).toBe(200);
    const pkg = await newPackage();
    const over = await finance.post('/api/invoices', {
      patientId: A.patientId,
      discountReason: 'DEMO promo',
      items: [{ kind: 'paket', patientPackageId: pkg, discountAmount: 150000 }],
    });
    expect(over.statusCode).toBe(403);
    const ok = await finance.post('/api/invoices', {
      patientId: A.patientId,
      discountReason: 'DEMO promo',
      items: [{ kind: 'paket', patientPackageId: pkg, discountAmount: 100000 }],
    });
    expect(ok.statusCode, ok.body).toBe(201);
    await owner.patch('/api/org', { financeDiscountMaxPercent: 0 });
  });

  it('paket yang sama tidak dapat ditagihkan dua kali, dan tidak dapat dibayar langsung setelah ditagihkan', async () => {
    const pkg = await newPackage();
    const first = await owner.post('/api/invoices', { patientId: A.patientId, items: [{ kind: 'paket', patientPackageId: pkg }] });
    expect(first.statusCode).toBe(201);
    const again = await owner.post('/api/invoices', { patientId: A.patientId, items: [{ kind: 'paket', patientPackageId: pkg }] });
    expect(again.statusCode).toBe(409);
    const direct = await finance.post('/api/payments', { patientId: A.patientId, amount: 1000, method: 'tunai', paidOn: localDate(0), patientPackageId: pkg });
    expect(direct.statusCode).toBe(400);
    // Setelah invoice dibatalkan, paket dapat ditagihkan ulang.
    expect((await finance.post(`/api/invoices/${json(first).id}/void`, { reason: 'DEMO salah buat' })).statusCode).toBe(403);
    expect((await owner.post(`/api/invoices/${json(first).id}/void`, { reason: 'DEMO salah buat' })).statusCode).toBe(200);
    expect((await owner.post('/api/invoices', { patientId: A.patientId, items: [{ kind: 'paket', patientPackageId: pkg }] })).statusCode).toBe(201);
  });

  it('pembayaran invoice tidak boleh melebihi sisa tagihan; status menjadi lunas', async () => {
    const pkg = await newPackage();
    const inv = json(await owner.post('/api/invoices', { patientId: A.patientId, items: [{ kind: 'paket', patientPackageId: pkg }] }));
    expect((await finance.post('/api/payments', { patientId: A.patientId, amount: 1000001, method: 'transfer', paidOn: localDate(0), invoiceId: inv.id })).statusCode).toBe(400);
    expect((await finance.post('/api/payments', { patientId: A.patientId, amount: 400000, method: 'transfer', paidOn: localDate(0), invoiceId: inv.id })).statusCode).toBe(201);
    expect(json(await owner.get(`/api/invoices/${inv.id}`)).paymentStatus).toBe('sebagian');
    expect((await finance.post('/api/payments', { patientId: A.patientId, amount: 600000, method: 'transfer', paidOn: localDate(0), invoiceId: inv.id })).statusCode).toBe(201);
    expect(json(await owner.get(`/api/invoices/${inv.id}`)).paymentStatus).toBe('lunas');
    // Invoice berpembayaran tidak dapat dibatalkan.
    expect((await owner.post(`/api/invoices/${inv.id}/void`, { reason: 'DEMO coba batal' })).statusCode).toBe(409);
    const out = json(await finance.get('/api/finance/outstanding'));
    expect(out.invoices.some((i: any) => i.invoiceId === inv.id)).toBe(false);
  });

  it('invoice B tidak dapat diakses A; harga sesi B tidak dapat ditagihkan oleh A', async () => {
    const ownerB = await login(env.app, B.owner.email);
    const pkgB = json(await ownerB.post(`/api/patients/${B.patientId}/packages`, { packageTypeId: B.packageTypeId })).id;
    const invB = json(await ownerB.post('/api/invoices', { patientId: B.patientId, items: [{ kind: 'paket', patientPackageId: pkgB }] }));
    expect((await owner.get(`/api/invoices/${invB.id}`)).statusCode).toBe(404);
    expect((await owner.get(`/api/invoices/${invB.id}/pdf`)).statusCode).toBe(404);
    expect((await owner.post('/api/invoices', { patientId: A.patientId, items: [{ kind: 'paket', patientPackageId: pkgB }] })).statusCode).toBe(400);
    const list = json<any[]>(await owner.get(`/api/invoices?from=2020-01-01&to=2020-12-31`));
    expect(list).toEqual([]);
  });
});

describe('Refund', () => {
  it('hanya owner; tidak melebihi nominal pembayaran (termasuk permintaan bersamaan); mengurangi penerimaan bersih', async () => {
    const pay = json(await finance.post('/api/payments', { patientId: A.patient2Id, amount: 300000, method: 'tunai', paidOn: localDate(0) }));
    expect((await finance.post(`/api/payments/${pay.id}/refunds`, { amount: 1000, method: 'tunai', refundedOn: localDate(0), reason: 'DEMO uji' })).statusCode).toBe(403);
    const results = await Promise.all(
      [1, 2, 3].map(() => owner.post(`/api/payments/${pay.id}/refunds`, { amount: 150000, method: 'tunai', refundedOn: localDate(0), reason: 'DEMO paket dibatalkan' })),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 201, 409]);
    const { rows } = await env.adminPool.query(`SELECT coalesce(sum(amount), 0)::int AS total FROM refunds WHERE payment_id = $1 AND status = 'tercatat'`, [pay.id]);
    expect(rows[0].total).toBe(300000);
    // Pembayaran ber-refund tidak dapat dibatalkan.
    expect((await owner.post(`/api/payments/${pay.id}/void`, { reason: 'DEMO coba batal' })).statusCode).toBe(409);
    const rep = json(await owner.get(`/api/reports/finance?from=${localDate(-1)}&to=${localDate(1)}`));
    expect(rep.refunds.total).toBe(300000);
    expect(rep.cashDifference).toBe(rep.payments.total - rep.refunds.total - rep.expenses.total);
  });

  it('bukti refund PDF tersedia dan tidak dapat diakses organisasi lain', async () => {
    const list = json<any[]>(await owner.get(`/api/refunds?from=${localDate(-1)}&to=${localDate(1)}`));
    const res = await owner.get(`/api/refunds/${list[0].id}/pdf`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(pdfText(res.rawPayload)).toContain('BUKTI PENGEMBALIAN DANA');
    const ownerB = await login(env.app, B.owner.email);
    expect((await ownerB.get(`/api/refunds/${list[0].id}/pdf`)).statusCode).toBe(404);
  });
});

describe('Rekonsiliasi', () => {
  it('menghitung arus kas per metode, menandai transaksi cocok, dan rekonsiliasi final terkunci', async () => {
    const day = localDate(5);
    await finance.post('/api/payments', { patientId: A.patientId, amount: 500000, method: 'qris', paidOn: day });
    await finance.post('/api/expenses', { spentOn: day, category: 'Operasional', description: 'DEMO biaya admin QRIS', amount: 3500, method: 'qris' });
    const r = json(await finance.get(`/api/finance/reconciliation?from=${day}&to=${day}&method=qris`));
    expect(r.systemIn).toBe(500000);
    expect(r.systemOut).toBe(3500);
    expect(r.systemNet).toBe(496500);
    expect(r.unverified).toBe(2);
    const payRow = r.rows.find((x: any) => x.kind === 'pembayaran');
    expect((await finance.post('/api/finance/verify', { kind: 'pembayaran', id: payRow.id, verified: true })).statusCode).toBe(200);
    expect(json(await finance.get(`/api/finance/reconciliation?from=${day}&to=${day}&method=qris`)).unverified).toBe(1);

    const rec = json(await finance.post('/api/reconciliations', { from: day, to: day, method: 'qris', actualNet: 496000, notes: 'DEMO selisih 500' }));
    expect(rec.difference).toBe(-500);
    expect((await finance.post(`/api/reconciliations/${rec.id}/finalize`)).statusCode).toBe(403);
    expect((await owner.post(`/api/reconciliations/${rec.id}/finalize`)).statusCode).toBe(200);
    expect((await owner.post(`/api/reconciliations/${rec.id}/finalize`)).statusCode).toBe(409);
    await expect(env.adminPool.query(`UPDATE reconciliations SET notes = 'diubah' WHERE id = $1`, [rec.id])).rejects.toThrow(/final/);
    // Terapis dan admin tidak memiliki akses rekonsiliasi.
    const admin = await login(env.app, A.admin.email);
    expect((await admin.get(`/api/finance/reconciliation?from=${day}&to=${day}&method=qris`)).statusCode).toBe(403);
  });
});

describe('Dokumen PDF', () => {
  it('kuitansi, invoice, dan laporan PDF valid serta hanya memuat data organisasi aktif', async () => {
    const pay = json(await finance.post('/api/payments', { patientId: A.patientId, amount: 75000, method: 'tunai', paidOn: localDate(0) }));
    const receipt = await finance.get(`/api/payments/${pay.id}/pdf`);
    expect(receipt.statusCode).toBe(200);
    expect(receipt.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    const text = pdfText(receipt.rawPayload);
    expect(text).toContain(pay.receiptNo);
    expect(text).toContain('Rp');

    const rep = await owner.get(`/api/reports/keuangan/pdf?from=${localDate(-30)}&to=${localDate(30)}`);
    expect(rep.statusCode).toBe(200);
    const repText = pdfText(rep.rawPayload);
    expect(repText).toContain('Laporan Keuangan');
    expect(repText).toContain('bukan laba');
    expect(repText).toContain(A.name);
    expect(repText).not.toContain(B.name);
    // Peran tanpa akses laporan keuangan ditolak.
    const admin = await login(env.app, A.admin.email);
    expect((await admin.get(`/api/reports/keuangan/pdf?from=${localDate(-30)}&to=${localDate(30)}`)).statusCode).toBe(403);
    expect((await admin.get(`/api/reports/operasional/pdf?from=${localDate(-30)}&to=${localDate(30)}`)).statusCode).toBe(200);
  });
});
