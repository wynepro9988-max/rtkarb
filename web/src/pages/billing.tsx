import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { downloadUrl, get, post, qs, useApi } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { formatDate, formatRupiah, METHOD, todayIn } from '../format.ts';
import { Badge, Dialog, Empty, ErrorBox, Field, Icon, Loading, MoneyInput, ReasonDialog, Stat, useSubmit, useToast } from '../ui.tsx';
import { PaymentDialog } from './finance.tsx';
import { PatientPicker } from './schedule.tsx';

export const INVOICE_STATUS: Record<string, { label: string; tone: string }> = {
  belum_dibayar: { label: 'Belum dibayar', tone: 'warn' },
  sebagian: { label: 'Dibayar sebagian', tone: 'info' },
  lunas: { label: 'Lunas', tone: 'ok' },
  dibatalkan: { label: 'Dibatalkan', tone: 'danger' },
};

// ---------------------------------------------------------------------------
// Invoice
// ---------------------------------------------------------------------------
export function InvoicesTab({ range }: { range: { from: string; to: string } }) {
  const { can } = useAuth();
  const { data, error, loading, reload } = useApi<any[]>(`/invoices${qs(range)}`);
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  return (
    <section className="card">
      <div className="card-head">
        <h2>Invoice</h2>
        {can('invoice.create') ? (
          <button className="btn btn-sm" onClick={() => setCreating(true)}>
            <Icon name="plus" /> Buat invoice
          </button>
        ) : null}
      </div>
      {loading && !data ? <Loading /> : null}
      <ErrorBox error={error} />
      {data?.length === 0 ? <Empty title="Belum ada invoice pada rentang ini" /> : null}
      {data?.length ? (
        <div className="table-wrap">
          <table className="table responsive">
            <thead>
              <tr>
                <th>Tanggal</th>
                <th>No. invoice</th>
                <th>Pasien</th>
                <th className="num">Total</th>
                <th className="num">Terbayar</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.map((i) => (
                <tr key={i.id} className="clickable" onClick={() => setDetail(i.id)}>
                  <td data-label="Tanggal">{formatDate(i.issuedOn)}</td>
                  <td data-label="No. invoice" className="mono">
                    {i.invoiceNo}
                  </td>
                  <td data-label="Pasien">{i.patientName}</td>
                  <td data-label="Total" className="num">
                    {formatRupiah(i.total)}
                  </td>
                  <td data-label="Terbayar" className="num">
                    {formatRupiah(i.paid)}
                  </td>
                  <td data-label="Status">
                    <Badge tone={INVOICE_STATUS[i.paymentStatus]?.tone}>{INVOICE_STATUS[i.paymentStatus]?.label}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {creating ? <InvoiceCreateDialog onClose={() => setCreating(false)} onSaved={(id) => (reload(), setDetail(id))} /> : null}
      {detail ? <InvoiceDetailDialog id={detail} onClose={() => setDetail(null)} onChanged={reload} /> : null}
    </section>
  );
}

interface Line {
  key: string;
  kind: 'paket' | 'sesi' | 'lainnya';
  refId?: string;
  description: string;
  quantity: number;
  unitPrice: number | '';
  discount: number | '';
}

export function InvoiceCreateDialog({ presetPatient, onClose, onSaved }: { presetPatient?: any; onClose: () => void; onSaved: (id: string) => void }) {
  const { me, can } = useAuth();
  const toast = useToast();
  const [patient, setPatient] = useState<any | null>(presetPatient ?? null);
  const [billable, setBillable] = useState<{ packages: any[]; sessions: any[] } | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [f, setF] = useState({ issuedOn: todayIn(me?.organization?.timezone), dueOn: '', notes: '', discountReason: '' });
  const { data: org } = useApi<any>('/org');

  useEffect(() => {
    setLines([]);
    if (!patient) return setBillable(null);
    get(`/patients/${patient.id}/billable`).then(setBillable, () => setBillable({ packages: [], sessions: [] }));
  }, [patient]);

  const toggle = (kind: 'paket' | 'sesi', item: any) => {
    const key = `${kind}:${item.id}`;
    if (lines.some((l) => l.key === key)) return setLines(lines.filter((l) => l.key !== key));
    setLines([
      ...lines,
      {
        key,
        kind,
        refId: item.id,
        description: kind === 'paket' ? item.name : `Sesi ${item.serviceName ?? 'terapi'} ${item.sessionAt}`,
        quantity: 1,
        unitPrice: item.price,
        discount: '',
      },
    ]);
  };
  const update = (key: string, patch: Partial<Line>) => setLines(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const gross = (l: Line) => l.quantity * (l.unitPrice || 0);
  const subtotal = lines.reduce((n, l) => n + gross(l), 0);
  const discount = lines.reduce((n, l) => n + (l.discount || 0), 0);
  const maxPercent = can('invoice.discount') ? 100 : Number(org?.financeDiscountMaxPercent ?? 0);

  const { busy, error, submit } = useSubmit(
    () =>
      post<{ id: string; invoiceNo: string }>('/invoices', {
        patientId: patient?.id,
        issuedOn: f.issuedOn,
        dueOn: f.dueOn || null,
        notes: f.notes || null,
        discountReason: f.discountReason || null,
        items: lines.map((l) =>
          l.kind === 'paket'
            ? { kind: 'paket', patientPackageId: l.refId, discountAmount: l.discount || 0 }
            : l.kind === 'sesi'
              ? { kind: 'sesi', appointmentId: l.refId, discountAmount: l.discount || 0 }
              : { kind: 'lainnya', description: l.description, quantity: l.quantity, unitPrice: l.unitPrice || 0, discountAmount: l.discount || 0 },
        ),
      }),
    (r) => {
      toast(`Invoice ${r.invoiceNo} dibuat`);
      onSaved(r.id);
      onClose();
    },
  );

  return (
    <Dialog title="Buat invoice" onClose={onClose} wide>
      <form className="form" onSubmit={submit}>
        <div className="field">
          <span className="label">Pasien</span>
          {presetPatient ? (
            <div className="input">
              <strong>{presetPatient.fullName}</strong>
            </div>
          ) : (
            <PatientPicker value={patient} onChange={setPatient} />
          )}
        </div>
        {billable ? (
          <div className="grid grid-2">
            <div className="card card-pad">
              <h3 style={{ marginBottom: 8 }}>Paket belum ditagih</h3>
              {billable.packages.length === 0 ? <p className="small muted">Tidak ada.</p> : null}
              {billable.packages.map((p) => (
                <label key={p.id} className="check">
                  <input type="checkbox" checked={lines.some((l) => l.key === `paket:${p.id}`)} onChange={() => toggle('paket', p)} />
                  <span>
                    {p.name} · {formatRupiah(p.price)} <span className="muted small">({formatDate(p.purchasedOn)})</span>
                  </span>
                </label>
              ))}
            </div>
            <div className="card card-pad">
              <h3 style={{ marginBottom: 8 }}>Sesi per-sesi belum ditagih</h3>
              {billable.sessions.length === 0 ? <p className="small muted">Tidak ada.</p> : null}
              {billable.sessions.map((s) => (
                <label key={s.id} className="check">
                  <input type="checkbox" checked={lines.some((l) => l.key === `sesi:${s.id}`)} onChange={() => toggle('sesi', s)} />
                  <span>
                    {s.sessionAt} · {s.serviceName ?? 'Sesi'} · {formatRupiah(s.price)}
                  </span>
                </label>
              ))}
            </div>
          </div>
        ) : null}
        {patient ? (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            style={{ alignSelf: 'flex-start' }}
            onClick={() => setLines([...lines, { key: `lain:${Date.now()}`, kind: 'lainnya', description: '', quantity: 1, unitPrice: '', discount: '' }])}
          >
            <Icon name="plus" /> Baris lain (mis. biaya asesmen)
          </button>
        ) : null}
        {lines.length ? (
          <div className="table-wrap card">
            <table className="table">
              <thead>
                <tr>
                  <th>Keterangan</th>
                  <th className="num">Jml</th>
                  <th className="num">Harga</th>
                  <th className="num">Diskon</th>
                  <th className="num">Total</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.key}>
                    <td>
                      {l.kind === 'lainnya' ? (
                        <input className="input" aria-label="Keterangan" value={l.description} onChange={(e) => update(l.key, { description: e.target.value })} required minLength={2} maxLength={200} />
                      ) : (
                        l.description
                      )}
                    </td>
                    <td className="num" style={{ width: 80 }}>
                      {l.kind === 'lainnya' ? (
                        <input className="input" type="number" min={1} max={1000} aria-label="Jumlah" value={l.quantity} onChange={(e) => update(l.key, { quantity: Number(e.target.value) || 1 })} />
                      ) : (
                        1
                      )}
                    </td>
                    <td className="num" style={{ width: 140 }}>
                      {l.kind === 'lainnya' ? <MoneyInput id={`${l.key}-p`} value={l.unitPrice} onChange={(v) => update(l.key, { unitPrice: v })} required /> : formatRupiah(l.unitPrice || 0)}
                    </td>
                    <td className="num" style={{ width: 140 }}>
                      {maxPercent > 0 ? <MoneyInput id={`${l.key}-d`} value={l.discount} onChange={(v) => update(l.key, { discount: v })} /> : '—'}
                    </td>
                    <td className="num">{formatRupiah(gross(l) - (l.discount || 0))}</td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={3}>
                    <strong>Total</strong>
                  </td>
                  <td className="num">{formatRupiah(discount)}</td>
                  <td className="num">
                    <strong>{formatRupiah(subtotal - discount)}</strong>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : null}
        <p className="small muted">
          {can('invoice.discount')
            ? 'Sebagai owner, Anda dapat memberi diskon. Diskon wajib disertai alasan dan tercatat di audit log.'
            : maxPercent > 0
              ? `Diskon maksimal ${maxPercent}% per baris sesuai kebijakan owner, wajib disertai alasan.`
              : 'Diskon hanya dapat diberikan oleh owner.'}
        </p>
        <div className="form-grid">
          {discount > 0 ? (
            <Field label="Alasan diskon" full>
              {(id) => <input id={id} className="input" value={f.discountReason} onChange={(e) => setF({ ...f, discountReason: e.target.value })} required maxLength={500} />}
            </Field>
          ) : null}
          <Field label="Tanggal invoice">{(id) => <input id={id} className="input" type="date" value={f.issuedOn} onChange={(e) => setF({ ...f, issuedOn: e.target.value })} required />}</Field>
          <Field label="Jatuh tempo">{(id) => <input id={id} className="input" type="date" value={f.dueOn} onChange={(e) => setF({ ...f, dueOn: e.target.value })} />}</Field>
          <Field label="Catatan" full>
            {(id) => <input id={id} className="input" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} maxLength={1000} />}
          </Field>
        </div>
        <ErrorBox error={error} />
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Batal
          </button>
          <button className="btn" disabled={busy || !patient || lines.length === 0}>
            Terbitkan invoice
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function InvoiceDetailDialog({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const { data: inv, error, reload } = useApi<any>(`/invoices/${id}`);
  const [paying, setPaying] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const refresh = () => {
    reload();
    onChanged();
  };
  return (
    <Dialog title={inv ? `Invoice ${inv.invoiceNo}` : 'Invoice'} onClose={onClose} wide>
      <ErrorBox error={error} />
      {!inv ? <Loading /> : null}
      {inv ? (
        <div className="stack">
          <div className="spread">
            <div>
              <strong>{inv.patientName}</strong> <span className="muted mono">{inv.patientCode}</span>
              <div className="small muted">
                {formatDate(inv.issuedOn)}
                {inv.dueOn ? ` · jatuh tempo ${formatDate(inv.dueOn)}` : ''}
              </div>
            </div>
            <Badge tone={INVOICE_STATUS[inv.paymentStatus]?.tone}>{INVOICE_STATUS[inv.paymentStatus]?.label}</Badge>
          </div>
          <div className="table-wrap card">
            <table className="table">
              <thead>
                <tr>
                  <th>Keterangan</th>
                  <th className="num">Jml</th>
                  <th className="num">Harga</th>
                  <th className="num">Diskon</th>
                  <th className="num">Total</th>
                </tr>
              </thead>
              <tbody>
                {inv.items.map((it: any) => (
                  <tr key={it.id}>
                    <td>{it.description}</td>
                    <td className="num">{it.quantity}</td>
                    <td className="num">{formatRupiah(it.unitPrice)}</td>
                    <td className="num">{it.discountAmount ? formatRupiah(it.discountAmount) : '—'}</td>
                    <td className="num">{formatRupiah(it.lineTotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {inv.discountReason ? <p className="small muted">Alasan diskon: {inv.discountReason}</p> : null}
          <div className="grid grid-3">
            <Stat label="Total" value={formatRupiah(inv.total)} />
            <Stat label="Terbayar (bersih)" value={formatRupiah(inv.paid)} />
            <Stat label="Sisa" value={formatRupiah(Math.max(0, inv.total - inv.paid))} />
          </div>
          {inv.payments.length ? (
            <div>
              <h3 style={{ marginBottom: 6 }}>Pembayaran</h3>
              {inv.payments.map((p: any) => (
                <div key={p.id} className="spread small" style={{ padding: '6px 0', borderTop: '1px dashed var(--c-border)' }}>
                  <Link to={`/kuitansi/${p.id}`} className="mono">
                    {p.receiptNo}
                  </Link>
                  <span>
                    {formatDate(p.paidOn)} · {METHOD[p.method]} · {formatRupiah(p.amount)}
                    {p.refunded ? ` (refund ${formatRupiah(p.refunded)})` : ''} {p.status === 'dibatalkan' ? <Badge tone="danger">Batal</Badge> : null}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          <div className="row">
            <button className="btn btn-sm btn-secondary" onClick={() => downloadUrl(`/invoices/${id}/pdf`)}>
              <Icon name="download" /> Unduh PDF
            </button>
            {inv.status === 'terbit' && inv.paid < inv.total && can('payment.record') ? (
              <button className="btn btn-sm" onClick={() => setPaying(true)}>
                Catat pembayaran
              </button>
            ) : null}
            {inv.status === 'terbit' && can('invoice.void') ? (
              <button className="btn btn-sm btn-ghost" style={{ color: 'var(--c-danger)' }} onClick={() => setVoiding(true)}>
                Batalkan invoice
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      {paying && inv ? (
        <PaymentDialog
          presetPatient={{ id: inv.patientId, fullName: inv.patientName, patientCode: inv.patientCode }}
          presetInvoice={{ id: inv.id, invoiceNo: inv.invoiceNo }}
          presetAmount={inv.total - inv.paid}
          onClose={() => setPaying(false)}
          onSaved={refresh}
        />
      ) : null}
      {voiding ? (
        <ReasonDialog
          title="Batalkan invoice"
          danger
          description="Paket/sesi di invoice ini dapat ditagihkan ulang setelah dibatalkan."
          confirmLabel="Batalkan invoice"
          onClose={() => setVoiding(false)}
          onConfirm={async (reason) => {
            await post(`/invoices/${id}/void`, { reason });
            toast('Invoice dibatalkan');
            refresh();
          }}
        />
      ) : null}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Refund
// ---------------------------------------------------------------------------
export function RefundsTab({ range }: { range: { from: string; to: string } }) {
  const { can } = useAuth();
  const toast = useToast();
  const { data, error, loading, reload } = useApi<any[]>(`/refunds${qs(range)}`);
  const [voiding, setVoiding] = useState<string | null>(null);
  const total = (data ?? []).filter((r) => r.status === 'tercatat').reduce((n, r) => n + r.amount, 0);
  return (
    <div className="stack">
      <div className="alert info">Refund dicatat dari halaman kuitansi pembayaran terkait (hanya owner). Total refund tidak dapat melebihi nominal pembayaran.</div>
      <div className="grid grid-3">
        <Stat label="Total refund (tercatat)" value={formatRupiah(total)} />
      </div>
      <section className="card">
        {loading && !data ? <Loading /> : null}
        <ErrorBox error={error} />
        {data?.length === 0 ? <Empty title="Belum ada refund pada rentang ini" /> : null}
        {data?.length ? (
          <div className="table-wrap">
            <table className="table responsive">
              <thead>
                <tr>
                  <th>Tanggal</th>
                  <th>No. refund</th>
                  <th>Pasien</th>
                  <th>Atas kuitansi</th>
                  <th className="num">Nominal</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.map((r) => (
                  <tr key={r.id}>
                    <td data-label="Tanggal">{formatDate(r.refundedOn)}</td>
                    <td data-label="No." className="mono">
                      {r.refundNo}
                    </td>
                    <td data-label="Pasien">{r.patientName}</td>
                    <td data-label="Kuitansi">
                      <Link to={`/kuitansi/${r.paymentId}`} className="mono">
                        {r.receiptNo}
                      </Link>
                    </td>
                    <td data-label="Nominal" className="num">
                      {formatRupiah(r.amount)}
                    </td>
                    <td data-label="Status">
                      <Badge tone={r.status === 'tercatat' ? 'warn' : 'danger'}>{r.status === 'tercatat' ? 'Tercatat' : 'Dibatalkan'}</Badge>
                    </td>
                    <td>
                      <div className="row">
                        <button className="btn btn-sm btn-ghost" onClick={() => downloadUrl(`/refunds/${r.id}/pdf`)}>
                          PDF
                        </button>
                        {r.status === 'tercatat' && can('refund.void') ? (
                          <button className="btn btn-sm btn-ghost" onClick={() => setVoiding(r.id)}>
                            Batalkan
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
      {voiding ? (
        <ReasonDialog
          title="Batalkan refund"
          danger
          confirmLabel="Batalkan refund"
          onClose={() => setVoiding(null)}
          onConfirm={async (reason) => {
            await post(`/refunds/${voiding}/void`, { reason });
            toast('Refund dibatalkan');
            reload();
          }}
        />
      ) : null}
    </div>
  );
}

export function RefundDialog({ payment, onClose, onSaved }: { payment: any; onClose: () => void; onSaved: () => void }) {
  const { me } = useAuth();
  const toast = useToast();
  const remaining = payment.amount - (payment.refunded ?? 0);
  const [f, setF] = useState({ amount: remaining as number | '', method: payment.method, refundedOn: todayIn(me?.organization?.timezone), reference: '', reason: '' });
  const { busy, error, submit } = useSubmit(
    () => post<{ refundNo: string }>(`/payments/${payment.id}/refunds`, { ...f, amount: f.amount || 0, reference: f.reference || null }),
    (r) => {
      toast(`Refund ${r.refundNo} dicatat`);
      onSaved();
      onClose();
    },
  );
  return (
    <Dialog title={`Refund atas ${payment.receiptNo}`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <p className="small muted">Maksimal yang dapat dikembalikan: {formatRupiah(remaining)}. Refund tercatat di audit log dan mengurangi penerimaan bersih.</p>
        <div className="form-grid">
          <Field label="Nominal (Rp)">{(id) => <MoneyInput id={id} value={f.amount} onChange={(v) => setF({ ...f, amount: v })} required />}</Field>
          <Field label="Tanggal">{(id) => <input id={id} className="input" type="date" value={f.refundedOn} onChange={(e) => setF({ ...f, refundedOn: e.target.value })} required />}</Field>
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
          <Field label="No. referensi">{(id) => <input id={id} className="input" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} maxLength={120} />}</Field>
          <Field label="Alasan" full>
            {(id) => <textarea id={id} className="textarea" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} required minLength={5} maxLength={500} />}
          </Field>
        </div>
        <ErrorBox error={error} />
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Batal
          </button>
          <button className="btn btn-danger" disabled={busy || !f.amount}>
            Catat refund
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Rekonsiliasi
// ---------------------------------------------------------------------------
const KIND_LABEL: Record<string, string> = { pembayaran: 'Pembayaran', refund: 'Refund', pengeluaran: 'Pengeluaran' };

export function ReconciliationTab({ range }: { range: { from: string; to: string } }) {
  const { can } = useAuth();
  const toast = useToast();
  const [method, setMethod] = useState('transfer');
  const { data, error, loading, reload } = useApi<any>(`/finance/reconciliation${qs({ ...range, method })}`);
  const { data: history, reload: reloadHistory } = useApi<any[]>('/reconciliations');
  const [actual, setActual] = useState<number | ''>('');
  const [notes, setNotes] = useState('');

  const verify = async (row: any) => {
    try {
      await post('/finance/verify', { kind: row.kind, id: row.id, verified: !row.verifiedAt });
      reload();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const { busy, error: saveError, submit } = useSubmit(
    () => post<{ difference: number }>('/reconciliations', { ...range, method, actualNet: actual === '' ? 0 : actual, notes: notes || null }),
    (r) => {
      toast(r.difference === 0 ? 'Rekonsiliasi disimpan: cocok' : `Rekonsiliasi disimpan: selisih ${formatRupiah(r.difference)}`);
      setActual('');
      setNotes('');
      reloadHistory();
    },
  );
  const finalize = async (id: string) => {
    if (!confirm('Finalkan rekonsiliasi ini? Setelah final tidak dapat diubah.')) return;
    try {
      await post(`/reconciliations/${id}/finalize`);
      reloadHistory();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  return (
    <div className="stack">
      <div className="row">
        <Field label="Metode">
          {(id) => (
            <select id={id} className="select" value={method} onChange={(e) => setMethod(e.target.value)}>
              {Object.entries(METHOD).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      {loading && !data ? <Loading /> : null}
      <ErrorBox error={error} />
      {data ? (
        <>
          <div className="grid grid-4">
            <Stat label="Masuk (sistem)" value={formatRupiah(data.systemIn)} />
            <Stat label="Keluar (refund + pengeluaran)" value={formatRupiah(data.systemOut)} />
            <Stat label="Bersih menurut sistem" value={formatRupiah(data.systemNet)} />
            <Stat label="Belum dicocokkan" value={data.unverified} hint="Centang setelah cocok dengan mutasi/kas" />
          </div>
          <section className="card">
            <div className="card-head">
              <h2>Transaksi {METHOD[method]}</h2>
            </div>
            {data.rows.length === 0 ? <Empty title="Tidak ada transaksi" /> : null}
            {data.rows.length ? (
              <div className="table-wrap">
                <table className="table responsive">
                  <thead>
                    <tr>
                      <th>Cocok</th>
                      <th>Tanggal</th>
                      <th>Jenis</th>
                      <th>Ref.</th>
                      <th>Keterangan</th>
                      <th className="num">Nominal</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r: any) => (
                      <tr key={`${r.kind}-${r.id}`}>
                        <td data-label="Cocok">
                          <input type="checkbox" aria-label="Sudah dicocokkan" checked={Boolean(r.verifiedAt)} onChange={() => verify(r)} />
                        </td>
                        <td data-label="Tanggal">{formatDate(r.date)}</td>
                        <td data-label="Jenis">{KIND_LABEL[r.kind]}</td>
                        <td data-label="Ref." className="mono small">
                          {r.ref}
                        </td>
                        <td data-label="Keterangan">{r.description}</td>
                        <td data-label="Nominal" className="num" style={{ color: r.amount < 0 ? 'var(--c-danger)' : undefined }}>
                          {formatRupiah(r.amount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </section>
          <form className="card card-pad form" onSubmit={submit}>
            <h2>Simpan hasil pencocokan</h2>
            <div className="form-grid">
              <Field label="Saldo bersih menurut bank/kas (Rp)" hint="Mutasi rekening koran / hitungan kas pada periode yang sama">
                {(id) => <MoneyInput id={id} value={actual} onChange={setActual} required />}
              </Field>
              <div className="field">
                <span className="label">Selisih</span>
                <div className="input mono">{actual === '' ? '—' : formatRupiah(actual - data.systemNet)}</div>
              </div>
              <Field label="Catatan" full>
                {(id) => <input id={id} className="input" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} placeholder="Mis. biaya admin bank belum dicatat" />}
              </Field>
            </div>
            <ErrorBox error={saveError} />
            <div className="form-actions">
              <button className="btn" disabled={busy || actual === ''}>
                Simpan rekonsiliasi
              </button>
            </div>
          </form>
        </>
      ) : null}
      <section className="card">
        <div className="card-head">
          <h2>Riwayat rekonsiliasi</h2>
        </div>
        {history?.length === 0 ? <Empty title="Belum ada" /> : null}
        {history?.map((h) => (
          <div key={h.id} className="card-body spread" style={{ borderBottom: '1px solid var(--c-border)' }}>
            <div>
              <strong>
                {formatDate(h.periodFrom)} – {formatDate(h.periodTo)} · {METHOD[h.method]}
              </strong>{' '}
              <Badge tone={h.status === 'final' ? 'ok' : 'warn'}>{h.status === 'final' ? 'Final' : 'Draf'}</Badge>
              <div className="small muted">
                Sistem {formatRupiah(h.systemNet)} · nyata {formatRupiah(h.actualNet)} · selisih {formatRupiah(h.difference)} · {h.unverifiedCount} belum dicocokkan · {h.createdByName}
                {h.notes ? ` · ${h.notes}` : ''}
              </div>
            </div>
            {h.status === 'draf' && can('finance.reconcile.finalize') ? (
              <button className="btn btn-sm btn-secondary" onClick={() => finalize(h.id)}>
                Finalkan
              </button>
            ) : null}
          </div>
        ))}
      </section>
    </div>
  );
}
