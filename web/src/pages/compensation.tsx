import { useState } from 'react';
import { post, qs, useApi } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { formatDate, formatRupiah, monthRange, todayIn } from '../format.ts';
import { Badge, Dialog, Empty, ErrorBox, Field, Icon, Loading, MoneyInput, PageHeader, Tabs, useSubmit, useToast } from '../ui.tsx';

const COMP_STATUS: Record<string, { label: string; tone: string }> = {
  dihitung: { label: 'Belum dibayar', tone: 'warn' },
  dibayar: { label: 'Dibayar', tone: 'ok' },
  dibatalkan: { label: 'Dibatalkan', tone: '' },
};

export function CompensationPage() {
  const { can, me } = useAuth();
  const [tab, setTab] = useState<'rekap' | 'aturan'>('rekap');
  const [range, setRange] = useState(() => monthRange(todayIn(me?.organization?.timezone)));
  const own = !can('compensation.read');
  return (
    <>
      <PageHeader
        title="Honor Terapis"
        subtitle={own ? 'Honor dari sesi yang Anda tangani' : 'Dihitung otomatis dari sesi selesai berdasarkan aturan masing-masing terapis'}
      />
      <Tabs
        tabs={[
          { value: 'rekap', label: 'Rekap' },
          { value: 'aturan', label: 'Aturan honor' },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'rekap' ? (
        <>
          <div className="row" style={{ marginBottom: 14 }}>
            <Field label="Dari">{(id) => <input id={id} className="input" type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />}</Field>
            <Field label="Sampai">{(id) => <input id={id} className="input" type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />}</Field>
          </div>
          <Recap range={range} />
        </>
      ) : (
        <Rules />
      )}
    </>
  );
}

function Recap({ range }: { range: { from: string; to: string } }) {
  const { can, me } = useAuth();
  const toast = useToast();
  const { data, error, loading, reload } = useApi<any>(`/compensation${qs(range)}`);
  const [selected, setSelected] = useState<string[]>([]);
  const [paidOn, setPaidOn] = useState(todayIn(me?.organization?.timezone));
  const manage = can('compensation.manage');

  const markPaid = async () => {
    if (!confirm(`Tandai ${selected.length} honor sebagai dibayar pada ${formatDate(paidOn)}?`)) return;
    try {
      const r = await post<{ updated: number }>('/compensation/mark-paid', { ids: selected, paidOn });
      toast(`${r.updated} honor ditandai dibayar`);
      setSelected([]);
      reload();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;
  const unpaid = data.items.filter((i: any) => i.status === 'dihitung');
  return (
    <div className="stack">
      <section className="card">
        <div className="card-head">
          <h2>Ringkasan per terapis</h2>
        </div>
        {data.summary.length === 0 ? <Empty title="Belum ada honor pada periode ini">Honor dihitung saat sesi ditandai selesai dan terapis memiliki aturan honor.</Empty> : null}
        {data.summary.length ? (
          <div className="table-wrap">
            <table className="table responsive">
              <thead>
                <tr>
                  <th>Terapis</th>
                  <th className="num">Sesi</th>
                  <th className="num">Belum dibayar</th>
                  <th className="num">Sudah dibayar</th>
                </tr>
              </thead>
              <tbody>
                {data.summary.map((s: any) => (
                  <tr key={s.memberId}>
                    <td data-label="Terapis">{s.therapistName}</td>
                    <td data-label="Sesi" className="num">
                      {s.sessions}
                    </td>
                    <td data-label="Belum dibayar" className="num">
                      {formatRupiah(s.unpaid)}
                    </td>
                    <td data-label="Sudah dibayar" className="num">
                      {formatRupiah(s.paid)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
      <section className="card">
        <div className="card-head">
          <h2>Rincian per sesi</h2>
          {manage && unpaid.length ? (
            <div className="row">
              <input className="input" type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} style={{ width: 'auto' }} aria-label="Tanggal bayar" />
              <button className="btn btn-sm" disabled={!selected.length} onClick={markPaid}>
                Tandai dibayar ({selected.length})
              </button>
            </div>
          ) : null}
        </div>
        {data.items.length === 0 ? <Empty title="Tidak ada rincian" /> : null}
        {data.items.length ? (
          <div className="table-wrap">
            <table className="table responsive">
              <thead>
                <tr>
                  {manage ? <th /> : null}
                  <th>Tanggal</th>
                  <th>Terapis</th>
                  <th>Sesi</th>
                  <th>Dasar perhitungan</th>
                  <th className="num">Honor</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((i: any) => (
                  <tr key={i.id}>
                    {manage ? (
                      <td>
                        {i.status === 'dihitung' ? (
                          <input
                            type="checkbox"
                            aria-label="Pilih"
                            checked={selected.includes(i.id)}
                            onChange={(e) => setSelected(e.target.checked ? [...selected, i.id] : selected.filter((x) => x !== i.id))}
                          />
                        ) : null}
                      </td>
                    ) : null}
                    <td data-label="Tanggal">{formatDate(i.sessionDate)}</td>
                    <td data-label="Terapis">{i.therapistName}</td>
                    <td data-label="Sesi">
                      {i.patientName ?? '—'} <span className="muted small">{i.serviceName ?? ''}</span>
                    </td>
                    <td data-label="Dasar" className="small">
                      {i.basis.skema === 'tetap_per_sesi'
                        ? `Tetap ${formatRupiah(i.basis.nominal_tetap)}/sesi`
                        : `${i.basis.persen}% × ${formatRupiah(i.basis.dasar_tarif)} (${i.basis.jenis_tagihan === 'paket' ? 'nilai per sesi paket' : 'tarif sesi'})`}
                    </td>
                    <td data-label="Honor" className="num">
                      {formatRupiah(i.amount)}
                    </td>
                    <td data-label="Status">
                      <Badge tone={COMP_STATUS[i.status]?.tone}>{COMP_STATUS[i.status]?.label}</Badge>
                      {i.paidOn ? <div className="small muted">{formatDate(i.paidOn)}</div> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function Rules() {
  const { can } = useAuth();
  const { data, error, loading, reload } = useApi<any[]>('/compensation/rules');
  const [creating, setCreating] = useState(false);
  const [ending, setEnding] = useState<any | null>(null);
  return (
    <section className="card">
      <div className="card-head">
        <h2>Aturan honor</h2>
        {can('compensation.manage') ? (
          <button className="btn btn-sm" onClick={() => setCreating(true)}>
            <Icon name="plus" /> Aturan baru
          </button>
        ) : null}
      </div>
      <p className="card-body small muted" style={{ paddingBottom: 0 }}>
        Setiap terapis dapat memiliki skema berbeda sesuai kontrak. Aturan khusus layanan diutamakan di atas aturan umum. Perubahan tarif dilakukan dengan mengakhiri aturan lama dan membuat aturan baru.
      </p>
      {loading && !data ? <Loading /> : null}
      <ErrorBox error={error} />
      {data?.length === 0 ? <Empty title="Belum ada aturan honor" /> : null}
      {data?.length ? (
        <div className="table-wrap">
          <table className="table responsive">
            <thead>
              <tr>
                <th>Terapis</th>
                <th>Layanan</th>
                <th>Skema</th>
                <th>Berlaku</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.id}>
                  <td data-label="Terapis">{r.therapistName}</td>
                  <td data-label="Layanan">{r.serviceName ?? 'Semua layanan'}</td>
                  <td data-label="Skema">{r.scheme === 'tetap_per_sesi' ? `${formatRupiah(r.amount)} per sesi` : `${r.percent}% dari tarif`}</td>
                  <td data-label="Berlaku">
                    {formatDate(r.effectiveFrom)} – {r.effectiveTo ? formatDate(r.effectiveTo) : 'sekarang'}
                  </td>
                  <td>
                    {can('compensation.manage') && !r.effectiveTo ? (
                      <button className="btn btn-sm btn-ghost" onClick={() => setEnding(r)}>
                        Akhiri
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {creating ? <RuleDialog onClose={() => setCreating(false)} onSaved={reload} /> : null}
      {ending ? <EndRuleDialog rule={ending} onClose={() => setEnding(null)} onSaved={reload} /> : null}
    </section>
  );
}

function RuleDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { me } = useAuth();
  const { data: therapists } = useApi<any[]>('/staff/therapists');
  const { data: services } = useApi<any[]>('/services');
  const [f, setF] = useState({ memberId: '', serviceId: '', scheme: 'tetap_per_sesi', amount: '' as number | '', percent: '', effectiveFrom: todayIn(me?.organization?.timezone), notes: '' });
  const { busy, error, submit } = useSubmit(
    () =>
      post('/compensation/rules', {
        memberId: f.memberId,
        serviceId: f.serviceId || null,
        scheme: f.scheme,
        amount: f.scheme === 'tetap_per_sesi' ? f.amount || 0 : null,
        percent: f.scheme === 'persen_tarif' ? Number(f.percent) : null,
        effectiveFrom: f.effectiveFrom,
        notes: f.notes || null,
      }),
    () => {
      onSaved();
      onClose();
    },
  );
  return (
    <Dialog title="Aturan honor baru" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="form-grid">
          <Field label="Terapis" full>
            {(id) => (
              <select id={id} className="select" value={f.memberId} onChange={(e) => setF({ ...f, memberId: e.target.value })} required>
                <option value="">Pilih terapis…</option>
                {therapists?.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.fullName}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Layanan" full>
            {(id) => (
              <select id={id} className="select" value={f.serviceId} onChange={(e) => setF({ ...f, serviceId: e.target.value })}>
                <option value="">Semua layanan</option>
                {services?.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Skema">
            {(id) => (
              <select id={id} className="select" value={f.scheme} onChange={(e) => setF({ ...f, scheme: e.target.value })}>
                <option value="tetap_per_sesi">Nominal tetap per sesi</option>
                <option value="persen_tarif">Persentase dari tarif sesi</option>
              </select>
            )}
          </Field>
          {f.scheme === 'tetap_per_sesi' ? (
            <Field label="Nominal per sesi (Rp)">{(id) => <MoneyInput id={id} value={f.amount} onChange={(v) => setF({ ...f, amount: v })} required />}</Field>
          ) : (
            <Field label="Persentase (%)" hint="Untuk sesi paket, dasar tarif = harga paket ÷ jumlah sesi">
              {(id) => <input id={id} className="input" type="number" min={0.01} max={100} step={0.01} value={f.percent} onChange={(e) => setF({ ...f, percent: e.target.value })} required />}
            </Field>
          )}
          <Field label="Berlaku mulai">{(id) => <input id={id} className="input" type="date" value={f.effectiveFrom} onChange={(e) => setF({ ...f, effectiveFrom: e.target.value })} required />}</Field>
          <Field label="Catatan" hint="Mis. nomor kontrak" full>
            {(id) => <input id={id} className="input" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} maxLength={500} />}
          </Field>
        </div>
        <ErrorBox error={error} />
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Batal
          </button>
          <button className="btn" disabled={busy}>
            Simpan
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function EndRuleDialog({ rule, onClose, onSaved }: { rule: any; onClose: () => void; onSaved: () => void }) {
  const { me } = useAuth();
  const [date, setDate] = useState(todayIn(me?.organization?.timezone));
  const { busy, error, submit } = useSubmit(() => post(`/compensation/rules/${rule.id}/end`, { effectiveTo: date }), () => {
    onSaved();
    onClose();
  });
  return (
    <Dialog title={`Akhiri aturan — ${rule.therapistName}`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <Field label="Berlaku sampai">{(id) => <input id={id} className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />}</Field>
        <ErrorBox error={error} />
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Batal
          </button>
          <button className="btn" disabled={busy}>
            Simpan
          </button>
        </div>
      </form>
    </Dialog>
  );
}
