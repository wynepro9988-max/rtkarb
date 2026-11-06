import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { downloadUrl, get, post, qs, useApi } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { formatDate, formatDateTime, formatRupiah, METHOD, monthRange, todayIn } from '../format.ts';
import { Badge, Dialog, Empty, ErrorBox, Field, Icon, Loading, LOGO_ALT, logoUrl, MoneyInput, PageHeader, ReasonDialog, Stat, Tabs, useSubmit, useToast } from '../ui.tsx';
import { InvoiceDetailDialog, InvoicesTab, ReconciliationTab, RefundDialog, RefundsTab } from './billing.tsx';
import { PatientPicker } from './schedule.tsx';

type Tab = 'bayar' | 'invoice' | 'piutang' | 'refund' | 'keluar' | 'rekon';

export function FinancePage() {
  const { can, me } = useAuth();
  const tabs = [
    ...(can('payment.read') ? [{ value: 'bayar' as Tab, label: 'Pembayaran' }] : []),
    ...(can('invoice.read') ? [{ value: 'invoice' as Tab, label: 'Invoice' }] : []),
    ...(can('payment.read') ? [{ value: 'piutang' as Tab, label: 'Belum lunas' }, { value: 'refund' as Tab, label: 'Refund' }] : []),
    ...(can('expense.read') ? [{ value: 'keluar' as Tab, label: 'Pengeluaran' }] : []),
    ...(can('finance.reconcile') ? [{ value: 'rekon' as Tab, label: 'Rekonsiliasi' }] : []),
  ];
  const [tab, setTab] = useState<Tab>(tabs[0]?.value ?? 'bayar');
  const [range, setRange] = useState(() => monthRange(todayIn(me?.organization?.timezone)));

  return (
    <>
      <PageHeader title="Pembayaran & Kas" subtitle="Pencatatan transaksi organisasi Anda. QRIS dan transfer dicatat manual — sistem tidak memverifikasi ke bank/penyedia." />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab !== 'piutang' ? (
        <div className="row" style={{ marginBottom: 14 }}>
          <Field label="Dari">{(id) => <input id={id} className="input" type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />}</Field>
          <Field label="Sampai">{(id) => <input id={id} className="input" type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />}</Field>
        </div>
      ) : null}
      {tab === 'bayar' ? <PaymentsList range={range} /> : null}
      {tab === 'invoice' ? <InvoicesTab range={range} /> : null}
      {tab === 'piutang' ? <Outstanding /> : null}
      {tab === 'refund' ? <RefundsTab range={range} /> : null}
      {tab === 'keluar' ? <ExpensesList range={range} /> : null}
      {tab === 'rekon' ? <ReconciliationTab range={range} /> : null}
    </>
  );
}

function PaymentsList({ range }: { range: { from: string; to: string } }) {
  const { can } = useAuth();
  const { data, error, loading, reload } = useApi<any[]>(`/payments${qs(range)}`);
  const [recording, setRecording] = useState(false);
  const total = (data ?? []).filter((p) => p.status === 'tercatat').reduce((n, p) => n + p.amount, 0);
  return (
    <div className="stack">
      <div className="grid grid-3">
        <Stat label="Total penerimaan (tercatat)" value={formatRupiah(total)} hint="Basis kas pada rentang tanggal" />
        <Stat label="Jumlah transaksi" value={(data ?? []).filter((p) => p.status === 'tercatat').length} />
        <Stat label="Dibatalkan" value={(data ?? []).filter((p) => p.status === 'dibatalkan').length} />
      </div>
      <section className="card">
        <div className="card-head">
          <h2>Daftar pembayaran</h2>
          {can('payment.record') ? (
            <button className="btn btn-sm" onClick={() => setRecording(true)}>
              <Icon name="plus" /> Catat pembayaran
            </button>
          ) : null}
        </div>
        {loading && !data ? <Loading /> : null}
        <ErrorBox error={error} />
        {data?.length === 0 ? <Empty title="Belum ada pembayaran pada rentang ini" /> : null}
        {data?.length ? (
          <div className="table-wrap">
            <table className="table responsive">
              <thead>
                <tr>
                  <th>Tanggal</th>
                  <th>No. kuitansi</th>
                  <th>Pasien</th>
                  <th>Untuk</th>
                  <th>Metode</th>
                  <th className="num">Nominal</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.map((p) => (
                  <tr key={p.id}>
                    <td data-label="Tanggal">{formatDate(p.paidOn)}</td>
                    <td data-label="No. kuitansi">
                      <Link className="mono" to={`/kuitansi/${p.id}`}>
                        {p.receiptNo}
                      </Link>
                    </td>
                    <td data-label="Pasien">
                      <Link to={`/pasien/${p.patientId}`}>{p.patientName}</Link>
                    </td>
                    <td data-label="Untuk">{p.packageName ?? (p.appointmentId ? 'Sesi' : 'Umum')}</td>
                    <td data-label="Metode">{METHOD[p.method]}</td>
                    <td data-label="Nominal" className="num">
                      {formatRupiah(p.amount)}
                    </td>
                    <td data-label="Status">
                      <Badge tone={p.status === 'tercatat' ? 'ok' : 'danger'}>{p.status === 'tercatat' ? 'Tercatat' : 'Dibatalkan'}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
      {recording ? <PaymentDialog onClose={() => setRecording(false)} onSaved={reload} /> : null}
    </div>
  );
}

function Outstanding() {
  const { can } = useAuth();
  const { data, error, loading, reload } = useApi<any>('/finance/outstanding');
  const [paying, setPaying] = useState<any | null>(null);
  const [invoice, setInvoice] = useState<string | null>(null);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;
  return (
    <div className="grid grid-2">
      <section className="card" style={{ gridColumn: '1 / -1' }}>
        <div className="card-head">
          <h2>Invoice belum lunas</h2>
        </div>
        {data.invoices.length === 0 ? <Empty title="Tidak ada" /> : null}
        {data.invoices.map((i: any) => (
          <div key={i.invoiceId} className="card-body spread" style={{ borderBottom: '1px solid var(--c-border)' }}>
            <div>
              <button type="button" className="btn btn-ghost btn-sm mono" style={{ padding: 0 }} onClick={() => setInvoice(i.invoiceId)}>
                {i.invoiceNo}
              </button>{' '}
              <strong>{i.patientName}</strong>
              <div className="small muted">
                {formatDate(i.issuedOn)}
                {i.dueOn ? ` · jatuh tempo ${formatDate(i.dueOn)}` : ''} · terbayar {formatRupiah(i.paid)} dari {formatRupiah(i.price)}
              </div>
            </div>
            <div className="row">
              <strong className="mono">{formatRupiah(i.outstanding)}</strong>
              {can('payment.record') ? (
                <button
                  className="btn btn-sm btn-secondary"
                  onClick={() => setPaying({ patient: { id: i.patientId, fullName: i.patientName, patientCode: i.patientCode }, invoice: { id: i.invoiceId, invoiceNo: i.invoiceNo }, amount: i.outstanding })}
                >
                  Catat
                </button>
              ) : null}
            </div>
          </div>
        ))}
      </section>
      <section className="card">
        <div className="card-head">
          <h2>Paket belum lunas</h2>
        </div>
        {data.packages.length === 0 ? <Empty title="Tidak ada" /> : null}
        {data.packages.map((p: any) => (
          <div key={p.patientPackageId} className="card-body spread" style={{ borderBottom: '1px solid var(--c-border)' }}>
            <div>
              <Link to={`/pasien/${p.patientId}`}>
                <strong>{p.patientName}</strong>
              </Link>
              <div className="small muted">
                {p.name} · dibeli {formatDate(p.purchasedOn)} · terbayar {formatRupiah(p.paid)} dari {formatRupiah(p.price)}
              </div>
            </div>
            <div className="row">
              <strong className="mono">{formatRupiah(p.outstanding)}</strong>
              {can('payment.record') ? (
                <button className="btn btn-sm btn-secondary" onClick={() => setPaying({ patient: { id: p.patientId, fullName: p.patientName, patientCode: p.patientCode }, packageId: p.patientPackageId, amount: p.outstanding })}>
                  Catat
                </button>
              ) : null}
            </div>
          </div>
        ))}
      </section>
      <section className="card">
        <div className="card-head">
          <h2>Sesi per-sesi belum lunas</h2>
        </div>
        {data.sessions.length === 0 ? <Empty title="Tidak ada" /> : null}
        {data.sessions.map((s: any) => (
          <div key={s.appointmentId} className="card-body spread" style={{ borderBottom: '1px solid var(--c-border)' }}>
            <div>
              <Link to={`/pasien/${s.patientId}`}>
                <strong>{s.patientName}</strong>
              </Link>
              <div className="small muted">
                {s.serviceName ?? 'Sesi'} · {s.sessionAt}
              </div>
            </div>
            <div className="row">
              <strong className="mono">{formatRupiah(s.outstanding)}</strong>
              {can('payment.record') ? (
                <button className="btn btn-sm btn-secondary" onClick={() => setPaying({ patient: { id: s.patientId, fullName: s.patientName, patientCode: s.patientCode }, appointmentId: s.appointmentId, amount: s.outstanding })}>
                  Catat
                </button>
              ) : null}
            </div>
          </div>
        ))}
      </section>
      {paying ? (
        <PaymentDialog
          presetPatient={paying.patient}
          presetInvoice={paying.invoice}
          presetPackageId={paying.packageId}
          presetAppointmentId={paying.appointmentId}
          presetAmount={paying.amount}
          onClose={() => setPaying(null)}
          onSaved={reload}
        />
      ) : null}
      {invoice ? <InvoiceDetailDialog id={invoice} onClose={() => setInvoice(null)} onChanged={reload} /> : null}
    </div>
  );
}

type PayKind = 'paket' | 'sekali' | 'lainnya';

// "Untuk" tanpa preset: paket (beli baru / cicilan), sekali datang (sesi belum dibayar, atau kunjungan
// prabayar yang terpakai saat absen), atau lainnya. Paket & kunjungan dibuat otomatis bersama pembayarannya.
export function PaymentDialog({
  presetPatient,
  presetInvoice,
  presetPackageId,
  presetAppointmentId,
  presetAmount,
  onClose,
  onSaved,
}: {
  presetPatient?: any;
  presetInvoice?: { id: string; invoiceNo: string };
  presetPackageId?: string;
  presetAppointmentId?: string;
  presetAmount?: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { can, me } = useAuth();
  const toast = useToast();
  const [patient, setPatient] = useState<any | null>(presetPatient ?? null);
  const [packages, setPackages] = useState<any[]>([]);
  const [unpaid, setUnpaid] = useState<any[] | null>(null);
  const { data: types } = useApi<any[]>('/package-types');
  const { data: services } = useApi<any[]>('/services');
  const fixed = Boolean(presetInvoice || presetPackageId || presetAppointmentId);
  const sell = can('package.sell');
  const [kind, setKind] = useState<PayKind | null>(null);
  const [pick, setPick] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [f, setF] = useState({
    amount: (presetAmount ?? '') as number | '',
    method: 'tunai',
    paidOn: todayIn(me?.organization?.timezone),
    reference: '',
    notes: '',
  });
  useEffect(() => {
    if (!patient) return;
    setUnpaid(null);
    get<any[]>(`/patients/${patient.id}/packages`).then((r) => setPackages(r.filter((p) => p.status !== 'dibatalkan')), () => setPackages([]));
    get<any[]>(`/patients/${patient.id}/unpaid-sessions`).then(setUnpaid, () => setUnpaid([]));
  }, [patient]);

  const newTypes = sell ? (types ?? []).filter((t) => t.active) : [];
  const owing = packages
    .filter((p) => !p.isVisit && p.paidAmount !== null && p.price - p.paidAmount > 0)
    .map((p) => ({ ...p, outstanding: p.price - p.paidAmount }));
  const visitServices = (services ?? []).filter((s) => s.active);
  // Bawaan: sekali datang bila ada sesi yang sudah diabsen dan belum dibayar, selain itu paket.
  const current: PayKind | null = kind ?? (unpaid ? (unpaid.some((u) => u.status === 'selesai') ? 'sekali' : 'paket') : null);
  const session = unpaid?.find((u) => u.serviceId === serviceId) ?? null;
  const service = visitServices.find((s) => s.id === serviceId);
  const chooseKind = (k: PayKind) => {
    setKind(k);
    setPick('');
    setServiceId('');
    setF({ ...f, amount: '' });
  };
  const choosePick = (v: string) => {
    setPick(v);
    const amount = v.startsWith('new:') ? newTypes.find((t) => t.id === v.slice(4))?.price : owing.find((p) => p.id === v.slice(4))?.outstanding;
    setF({ ...f, amount: amount ?? '' });
  };
  const chooseService = (id: string) => {
    setServiceId(id);
    const s = unpaid?.find((u) => u.serviceId === id);
    setF({ ...f, amount: s ? Number(s.outstanding) : (visitServices.find((x) => x.id === id)?.defaultPrice ?? '') });
  };

  const target = () => {
    if (presetInvoice) return { invoiceId: presetInvoice.id };
    if (presetPackageId) return { patientPackageId: presetPackageId };
    if (presetAppointmentId) return { appointmentId: presetAppointmentId };
    if (current === 'paket' && pick.startsWith('new:')) return { newPackage: { packageTypeId: pick.slice(4) } };
    if (current === 'paket' && pick.startsWith('pkg:')) return { patientPackageId: pick.slice(4) };
    if (current === 'sekali' && serviceId) return session ? { appointmentId: session.appointmentId } : { prepaidVisit: { serviceId } };
    return {};
  };
  const ready = fixed || current === 'lainnya' || (current === 'paket' && pick) || (current === 'sekali' && serviceId && (session || Number(service?.defaultPrice) > 0));

  const { busy, error, submit } = useSubmit(
    () =>
      post<{ id: string; receiptNo: string }>('/payments', {
        patientId: patient?.id,
        amount: f.amount === '' ? 0 : f.amount,
        method: f.method,
        paidOn: f.paidOn,
        reference: f.reference || null,
        notes: f.notes || null,
        ...target(),
      }),
    (r) => {
      toast(`Pembayaran tercatat — kuitansi ${r.receiptNo}`);
      onSaved();
      onClose();
    },
  );

  const fixedLabel = presetInvoice
    ? `Invoice ${presetInvoice.invoiceNo}`
    : presetPackageId
      ? `Paket: ${packages.find((p) => p.id === presetPackageId)?.name ?? ''}`
      : presetAppointmentId
        ? 'Sesi per sesi'
        : '';

  return (
    <Dialog title="Catat pembayaran" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="field">
          <span className="label">Pasien</span>
          {presetPatient ? (
            <div className="input">
              <strong>{presetPatient.fullName}</strong> <span className="muted mono">{presetPatient.patientCode}</span>
            </div>
          ) : (
            <PatientPicker value={patient} onChange={setPatient} />
          )}
        </div>
        {fixed ? (
          <div className="field">
            <span className="label">Untuk</span>
            <div className="input">{fixedLabel}</div>
          </div>
        ) : patient ? (
          <div className="field">
            <span className="label">Untuk</span>
            <div className="segmented" role="group" aria-label="Untuk">
              {(
                [
                  ['paket', 'Paket'],
                  ['sekali', 'Sekali datang'],
                  ['lainnya', 'Lainnya'],
                ] as const
              ).map(([k, label]) => (
                <button key={k} type="button" aria-pressed={current === k} onClick={() => chooseKind(k)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {!fixed && patient && current === 'paket' ? (
          <Field
            label="Paket"
            hint={
              pick.startsWith('new:')
                ? 'Paket otomatis tercatat di tab Paket dan terpakai saat anak diabsen.'
                : pick.startsWith('pkg:')
                  ? 'Cicilan atau pelunasan paket ini.'
                  : undefined
            }
          >
            {(id) => (
              <select id={id} className="select" value={pick} onChange={(e) => choosePick(e.target.value)} required>
                <option value="">Pilih paket…</option>
                {newTypes.length ? (
                  <optgroup label="Beli paket baru">
                    {newTypes.map((t) => (
                      <option key={t.id} value={`new:${t.id}`}>
                        {t.name} — {t.sessionsTotal} sesi · {formatRupiah(t.price)}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
                {owing.length ? (
                  <optgroup label="Cicilan / pelunasan">
                    {owing.map((p) => (
                      <option key={p.id} value={`pkg:${p.id}`}>
                        {p.name}, sisa tagihan {formatRupiah(p.outstanding)}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
              </select>
            )}
          </Field>
        ) : null}
        {!fixed && patient && current === 'sekali' ? (
          <Field
            label="Layanan"
            hint={
              !serviceId
                ? undefined
                : session
                  ? session.status === 'selesai'
                    ? `Untuk sesi ${session.serviceName ?? ''} ${formatDate(session.localDate)} yang sudah diabsen dan belum dibayar.`
                    : `Untuk jadwal ${session.serviceName ?? ''} ${formatDate(session.localDate)} pukul ${session.localTime}.`
                  : Number(service?.defaultPrice) > 0
                    ? 'Belum ada sesi yang belum dibayar. Dicatat sebagai 1 kunjungan prabayar dan terpakai otomatis saat anak diabsen.'
                    : 'Tarif layanan ini belum diatur. Isi di Pengaturan → Layanan.'
            }
          >
            {(id) => (
              <select id={id} className="select" value={serviceId} onChange={(e) => chooseService(e.target.value)} required>
                <option value="">Pilih layanan…</option>
                {visitServices.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {Number(s.defaultPrice) > 0 ? ` — ${formatRupiah(s.defaultPrice)}` : ''}
                  </option>
                ))}
              </select>
            )}
          </Field>
        ) : null}
        {!fixed && patient && current === 'lainnya' ? (
          <p className="small muted">Tidak terhubung ke paket atau sesi, mis. biaya asesmen atau keperluan lain.</p>
        ) : null}
        <div className="form-grid">
          <Field label="Nominal (Rp)">{(id) => <MoneyInput id={id} value={f.amount} onChange={(v) => setF({ ...f, amount: v })} required />}</Field>
          <Field label="Tanggal bayar">{(id) => <input id={id} className="input" type="date" value={f.paidOn} onChange={(e) => setF({ ...f, paidOn: e.target.value })} required />}</Field>
          <Field label="Metode" full>
            {(id) => (
              <select id={id} className="select" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>
                {Object.entries(METHOD).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {f.method !== 'tunai' ? (
            <Field label="No. referensi" hint="Dari bukti transfer / struk QRIS" full>
              {(id) => <input id={id} className="input" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} maxLength={120} />}
            </Field>
          ) : null}
          <Field label="Keterangan" full>
            {(id) => <input id={id} className="input" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} maxLength={500} />}
          </Field>
        </div>
        <p className="small muted">Pembayaran yang sudah tercatat tidak dapat diedit. Kesalahan dikoreksi dengan pembatalan oleh owner lalu dicatat ulang.</p>
        <ErrorBox error={error} />
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Batal
          </button>
          <button className="btn" disabled={busy || !patient || !f.amount || !ready}>
            {busy ? 'Menyimpan…' : 'Simpan'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function ExpensesList({ range }: { range: { from: string; to: string } }) {
  const { can, me } = useAuth();
  const toast = useToast();
  const { data, error, loading, reload } = useApi<any[]>(`/expenses${qs(range)}`);
  const [creating, setCreating] = useState(false);
  const [voiding, setVoiding] = useState<string | null>(null);
  const [f, setF] = useState({ spentOn: todayIn(me?.organization?.timezone), category: 'Operasional', description: '', amount: '' as number | '', method: 'tunai', reference: '' });
  const total = (data ?? []).filter((e) => e.status === 'tercatat').reduce((n, e) => n + e.amount, 0);
  const { busy, error: saveError, submit } = useSubmit(() => post('/expenses', { ...f, amount: f.amount || 0, reference: f.reference || null }), () => {
    toast('Pengeluaran dicatat');
    setCreating(false);
    setF({ ...f, description: '', amount: '', reference: '' });
    reload();
  });
  return (
    <div className="stack">
      <div className="grid grid-3">
        <Stat label="Total pengeluaran (tercatat)" value={formatRupiah(total)} />
      </div>
      <section className="card">
        <div className="card-head">
          <h2>Pengeluaran</h2>
          {can('expense.record') ? (
            <button className="btn btn-sm" onClick={() => setCreating(true)}>
              <Icon name="plus" /> Catat pengeluaran
            </button>
          ) : null}
        </div>
        {loading && !data ? <Loading /> : null}
        <ErrorBox error={error} />
        {data?.length === 0 ? <Empty title="Belum ada pengeluaran pada rentang ini" /> : null}
        {data?.length ? (
          <div className="table-wrap">
            <table className="table responsive">
              <thead>
                <tr>
                  <th>Tanggal</th>
                  <th>Kategori</th>
                  <th>Keterangan</th>
                  <th>Metode</th>
                  <th className="num">Nominal</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.map((e) => (
                  <tr key={e.id}>
                    <td data-label="Tanggal">{formatDate(e.spentOn)}</td>
                    <td data-label="Kategori">{e.category}</td>
                    <td data-label="Keterangan">{e.description}</td>
                    <td data-label="Metode">{METHOD[e.method]}</td>
                    <td data-label="Nominal" className="num">
                      {formatRupiah(e.amount)}
                    </td>
                    <td data-label="Status">
                      <Badge tone={e.status === 'tercatat' ? 'ok' : 'danger'}>{e.status === 'tercatat' ? 'Tercatat' : 'Dibatalkan'}</Badge>
                    </td>
                    <td>
                      {e.status === 'tercatat' && can('expense.void') ? (
                        <button className="btn btn-sm btn-ghost" onClick={() => setVoiding(e.id)}>
                          Batalkan
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
      {creating ? (
        <Dialog title="Catat pengeluaran" onClose={() => setCreating(false)}>
          <form className="form" onSubmit={submit}>
            <div className="form-grid">
              <Field label="Tanggal">{(id) => <input id={id} className="input" type="date" value={f.spentOn} onChange={(e) => setF({ ...f, spentOn: e.target.value })} required />}</Field>
              <Field label="Kategori">
                {(id) => (
                  <>
                    <input id={id} className="input" list="kategori-pengeluaran" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} required minLength={2} />
                    <datalist id="kategori-pengeluaran">
                      {['Operasional', 'Sewa', 'Listrik & air', 'Alat terapi', 'ATK', 'Gaji/honor', 'Lainnya'].map((c) => (
                        <option key={c} value={c} />
                      ))}
                    </datalist>
                  </>
                )}
              </Field>
              <Field label="Keterangan" full>
                {(id) => <input id={id} className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} required minLength={2} maxLength={500} />}
              </Field>
              <Field label="Nominal (Rp)">{(id) => <MoneyInput id={id} value={f.amount} onChange={(v) => setF({ ...f, amount: v })} required />}</Field>
              <Field label="Metode">
                {(id) => (
                  <select id={id} className="select" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>
                    {Object.entries(METHOD).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            </div>
            <ErrorBox error={saveError} />
            <div className="form-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setCreating(false)}>
                Batal
              </button>
              <button className="btn" disabled={busy || !f.amount}>
                Simpan
              </button>
            </div>
          </form>
        </Dialog>
      ) : null}
      {voiding ? (
        <ReasonDialog
          title="Batalkan pengeluaran"
          danger
          confirmLabel="Batalkan"
          onClose={() => setVoiding(null)}
          onConfirm={async (reason) => {
            await post(`/expenses/${voiding}/void`, { reason });
            toast('Pengeluaran dibatalkan');
            reload();
          }}
        />
      ) : null}
    </div>
  );
}

export function ReceiptPage() {
  const { id = '' } = useParams();
  const { can, me } = useAuth();
  const toast = useToast();
  const { data: r, error, loading, reload } = useApi<any>(`/payments/${id}`);
  const [voiding, setVoiding] = useState(false);
  const [refunding, setRefunding] = useState(false);
  if (loading && !r) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!r) return null;
  return (
    <>
      <div className="row no-print" style={{ marginBottom: 16 }}>
        <Link className="btn btn-secondary btn-sm" to="/keuangan">
          <Icon name="back" /> Keuangan
        </Link>
        <button className="btn btn-sm" onClick={() => downloadUrl(`/payments/${id}/pdf`)}>
          <Icon name="download" /> Unduh PDF
        </button>
        <button className="btn btn-sm btn-secondary" onClick={() => window.print()}>
          <Icon name="print" /> Cetak
        </button>
        {r.status === 'tercatat' && can('refund.record') && r.amount - r.refunded > 0 ? (
          <button className="btn btn-sm btn-secondary" onClick={() => setRefunding(true)}>
            Refund
          </button>
        ) : null}
        {r.status === 'tercatat' && can('payment.void') ? (
          <button className="btn btn-sm btn-ghost" style={{ color: 'var(--c-danger)' }} onClick={() => setVoiding(true)}>
            Batalkan pembayaran
          </button>
        ) : null}
      </div>
      <article className="card receipt">
        <header className="receipt-head">
          <div>
            <img src={logoUrl} alt={LOGO_ALT} />
            <div className="small" style={{ marginTop: 8 }}>
              <strong>{r.organizationName}</strong>
              {r.organizationAddress ? <div>{r.organizationAddress}</div> : null}
              {r.organizationPhone ? <div>{r.organizationPhone}</div> : null}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <h2>KUITANSI</h2>
            <div className="mono">{r.receiptNo}</div>
            <div className="small muted">{formatDate(r.paidOn)}</div>
            {r.status === 'dibatalkan' ? (
              <div style={{ marginTop: 10 }}>
                <span className="receipt-void">DIBATALKAN</span>
              </div>
            ) : null}
          </div>
        </header>
        <dl className="kv">
          <dt>Diterima dari</dt>
          <dd>
            Wali dari <strong>{r.patientName}</strong> ({r.patientCode})
          </dd>
          <dt>Untuk pembayaran</dt>
          <dd>{r.invoiceNo ? `Invoice ${r.invoiceNo}` : r.packageName ? (/^paket\b/i.test(r.packageName) ? r.packageName : `Paket ${r.packageName}`) : r.sessionAt ? `Sesi ${r.serviceName ?? 'terapi'} ${r.sessionAt}` : (r.notes ?? 'Layanan terapi')}</dd>
          <dt>Metode</dt>
          <dd>
            {METHOD[r.method]}
            {r.reference ? ` · ref. ${r.reference}` : ''}
          </dd>
          {r.notes && (r.packageName || r.sessionAt) ? (
            <>
              <dt>Keterangan</dt>
              <dd>{r.notes}</dd>
            </>
          ) : null}
        </dl>
        <div className="receipt-amount mono">{formatRupiah(r.amount)}</div>
        {r.refunds?.length ? (
          <div className="small" style={{ marginBottom: 12 }}>
            <strong>Pengembalian dana:</strong>
            {r.refunds.map((x: any) => (
              <div key={x.id}>
                {x.refundNo} · {formatDate(x.refundedOn)} · {formatRupiah(x.amount)} · {x.reason} {x.status === 'dibatalkan' ? '(dibatalkan)' : ''}{' '}
                <button type="button" className="btn btn-sm btn-ghost no-print" onClick={() => downloadUrl(`/refunds/${x.id}/pdf`)}>
                  PDF
                </button>
              </div>
            ))}
          </div>
        ) : null}
        {r.status === 'dibatalkan' ? (
          <p className="small" style={{ color: 'var(--c-danger)' }}>
            Dibatalkan {formatDateTime(r.voidedAt, me?.organization?.timezone)} — {r.voidReason}
          </p>
        ) : null}
        <div className="receipt-sign">
          <div>
            <div className="small muted">Petugas</div>
            <div style={{ height: 56 }} />
            <strong>{r.recordedByName}</strong>
          </div>
        </div>
      </article>
      {refunding ? <RefundDialog payment={r} onClose={() => setRefunding(false)} onSaved={reload} /> : null}
      {voiding ? (
        <ReasonDialog
          title="Batalkan pembayaran"
          danger
          description="Pembayaran yang dibatalkan tetap tersimpan sebagai riwayat dan tidak dihitung dalam laporan."
          confirmLabel="Batalkan pembayaran"
          onClose={() => setVoiding(false)}
          onConfirm={async (reason) => {
            await post(`/payments/${id}/void`, { reason });
            toast('Pembayaran dibatalkan');
            reload();
          }}
        />
      ) : null}
    </>
  );
}
