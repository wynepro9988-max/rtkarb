import { useState } from 'react';
import { post, qs, useApi } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { formatDate, formatMonth, formatRupiah, monthRange, todayIn } from '../format.ts';
import { Badge, Dialog, Empty, ErrorBox, Field, Icon, Loading, MoneyInput, PageHeader, Tabs, useSubmit, useToast } from '../ui.tsx';

const COMP_STATUS: Record<string, { label: string; tone: string }> = {
  dihitung: { label: 'Belum dibayar', tone: 'warn' },
  dibayar: { label: 'Dibayar', tone: 'ok' },
  dibatalkan: { label: 'Dibatalkan', tone: '' },
};

// Skema honor seorang terapis dari komponen yang berlaku: gaji pokok, tunjangan, per sesi.
export function schemeLabel(t: { hasBaseSalary: boolean; hasAllowance: boolean; hasPerSession: boolean }) {
  const parts = [t.hasBaseSalary ? 'Gaji pokok' : null, t.hasAllowance ? 'tunjangan' : null, t.hasPerSession ? 'per sesi' : null].filter(Boolean) as string[];
  if (parts.length === 0) return 'Belum diatur';
  const label = parts.join(' + ');
  return label.charAt(0).toUpperCase() + label.slice(1);
}

const KIND_LABEL: Record<string, string> = { gaji_pokok: 'Gaji pokok', tunjangan: 'Tunjangan' };

// Nama komponen, dengan jenisnya bila nama tidak sudah menyebutnya.
function ComponentName({ name, kind }: { name: string; kind: string }) {
  const label = KIND_LABEL[kind];
  return (
    <>
      {name} {label && !name.toLowerCase().startsWith(label.toLowerCase()) ? <span className="muted small">{label}</span> : null}
    </>
  );
}

export function CompensationPage() {
  const { can, me } = useAuth();
  const [tab, setTab] = useState<'rekap' | 'aturan'>('rekap');
  const [month, setMonth] = useState(() => todayIn(me?.organization?.timezone).slice(0, 7));
  const own = !can('compensation.read');
  return (
    <>
      <PageHeader
        title="Honor Terapis"
        subtitle={own ? 'Gaji, tunjangan, dan honor sesi Anda' : 'Gaji pokok, tunjangan, dan honor per sesi sesuai skema masing-masing terapis'}
      />
      <Tabs
        tabs={[
          { value: 'rekap', label: 'Rekap bulanan' },
          { value: 'aturan', label: 'Skema honor' },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'rekap' ? (
        <>
          <div className="row" style={{ marginBottom: 14 }}>
            <Field label="Bulan">{(id) => <input id={id} className="input" type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />}</Field>
          </div>
          <MonthlyRecap month={month} />
          <div style={{ marginTop: 18 }}>
            <Recap range={monthRange(`${month}-01`)} />
          </div>
        </>
      ) : (
        <div className="stack">
          <FixedComponents />
          <Rules />
        </div>
      )}
    </>
  );
}

function MonthlyRecap({ month }: { month: string }) {
  const { can, me } = useAuth();
  const toast = useToast();
  const { data, error, loading, reload } = useApi<any>(`/compensation/monthly${qs({ month })}`);
  const [selected, setSelected] = useState<string[]>([]);
  const [paidOn, setPaidOn] = useState(todayIn(me?.organization?.timezone));
  const manage = can('compensation.manage');

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;
  const fixedRows = data.therapists.flatMap((t: any) => t.fixed.map((f: any) => ({ ...f, therapistName: t.therapistName })));
  const markPaid = async () => {
    if (!confirm(`Tandai ${selected.length} komponen ${formatMonth(month)} sebagai dibayar pada ${formatDate(paidOn)}?`)) return;
    try {
      const r = await post<{ updated: number }>('/compensation/components/mark-paid', { month, componentIds: selected, paidOn });
      toast(`${r.updated} komponen ditandai dibayar`);
      setSelected([]);
      reload();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  return (
    <div className="stack">
      <section className="card">
        <div className="card-head">
          <h2>Ringkasan {formatMonth(month)}</h2>
        </div>
        {data.therapists.length === 0 ? <Empty title="Belum ada honor pada bulan ini">Atur skema honor terapis di tab Skema honor.</Empty> : null}
        {data.therapists.length ? (
          <div className="table-wrap">
            <table className="table responsive">
              <thead>
                <tr>
                  <th>Terapis</th>
                  <th>Skema</th>
                  <th className="num">Gaji & tunjangan</th>
                  <th className="num">Honor sesi</th>
                  <th className="num">Total</th>
                  <th className="num">Belum dibayar</th>
                </tr>
              </thead>
              <tbody>
                {data.therapists.map((t: any) => (
                  <tr key={t.memberId}>
                    <td data-label="Terapis">{t.therapistName}</td>
                    <td data-label="Skema" className="small">
                      {schemeLabel(t)}
                    </td>
                    <td data-label="Gaji & tunjangan" className="num">
                      {formatRupiah(t.fixedTotal)}
                    </td>
                    <td data-label="Honor sesi" className="num">
                      {formatRupiah(t.sessionTotal)} <span className="muted small">({t.sessions} sesi)</span>
                    </td>
                    <td data-label="Total" className="num">
                      <strong>{formatRupiah(t.total)}</strong>
                    </td>
                    <td data-label="Belum dibayar" className="num">
                      {formatRupiah(t.unpaid)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      {fixedRows.length ? (
        <section className="card">
          <div className="card-head">
            <h2>Gaji pokok & tunjangan</h2>
            {manage && fixedRows.some((f: any) => !f.paidOn) ? (
              <div className="row">
                <input className="input" type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} style={{ width: 'auto' }} aria-label="Tanggal bayar" />
                <button className="btn btn-sm" disabled={!selected.length} onClick={markPaid}>
                  Tandai dibayar ({selected.length})
                </button>
              </div>
            ) : null}
          </div>
          <div className="table-wrap">
            <table className="table responsive">
              <thead>
                <tr>
                  {manage ? <th /> : null}
                  <th>Terapis</th>
                  <th>Komponen</th>
                  <th className="num">Nominal</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {fixedRows.map((f: any) => (
                  <tr key={f.componentId}>
                    {manage ? (
                      <td>
                        {!f.paidOn ? (
                          <input
                            type="checkbox"
                            aria-label="Pilih"
                            checked={selected.includes(f.componentId)}
                            onChange={(e) => setSelected(e.target.checked ? [...selected, f.componentId] : selected.filter((x) => x !== f.componentId))}
                          />
                        ) : null}
                      </td>
                    ) : null}
                    <td data-label="Terapis">{f.therapistName}</td>
                    <td data-label="Komponen">
                      <ComponentName name={f.name} kind={f.kind} />
                    </td>
                    <td data-label="Nominal" className="num">
                      {formatRupiah(f.amount)}
                    </td>
                    <td data-label="Status">
                      <Badge tone={f.paidOn ? 'ok' : 'warn'}>{f.paidOn ? 'Dibayar' : 'Belum dibayar'}</Badge>
                      {f.paidOn ? <div className="small muted">{formatDate(f.paidOn)}</div> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function FixedComponents() {
  const { can } = useAuth();
  const { data, error, loading, reload } = useApi<any[]>('/compensation/components');
  const [creating, setCreating] = useState(false);
  const [ending, setEnding] = useState<any | null>(null);
  const manage = can('compensation.manage');
  return (
    <section className="card">
      <div className="card-head">
        <h2>Gaji pokok & tunjangan (bulanan)</h2>
        {manage ? (
          <button className="btn btn-sm" onClick={() => setCreating(true)}>
            <Icon name="plus" /> Tambah komponen
          </button>
        ) : null}
      </div>
      <p className="card-body small muted" style={{ paddingBottom: 0 }}>
        Untuk terapis bergaji tetap. Tunjangan bisa ditambah sebanyak yang dibutuhkan, misalnya transport, makan, atau jabatan. Terapis yang hanya dibayar per sesi tidak
        perlu komponen di sini. Nominal dihitung penuh per bulan berlaku, tanpa prorata atau potongan.
      </p>
      {loading && !data ? <Loading /> : null}
      <ErrorBox error={error} />
      {data?.length === 0 ? <Empty title="Belum ada gaji pokok atau tunjangan" /> : null}
      {data?.length ? (
        <div className="table-wrap">
          <table className="table responsive">
            <thead>
              <tr>
                <th>Terapis</th>
                <th>Komponen</th>
                <th className="num">Per bulan</th>
                <th>Berlaku</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((c) => (
                <tr key={c.id}>
                  <td data-label="Terapis">{c.therapistName}</td>
                  <td data-label="Komponen">
                    <ComponentName name={c.name} kind={c.kind} />
                  </td>
                  <td data-label="Per bulan" className="num">
                    {formatRupiah(c.amount)}
                  </td>
                  <td data-label="Berlaku">
                    {formatMonth(c.startMonth)} – {c.endMonth ? formatMonth(c.endMonth) : 'sekarang'}
                  </td>
                  <td>
                    {manage && !c.endMonth ? (
                      <button className="btn btn-sm btn-ghost" onClick={() => setEnding(c)}>
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
      {creating ? <ComponentDialog onClose={() => setCreating(false)} onSaved={reload} /> : null}
      {ending ? <EndComponentDialog component={ending} onClose={() => setEnding(null)} onSaved={reload} /> : null}
    </section>
  );
}

function ComponentDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { me } = useAuth();
  const { data: therapists } = useApi<any[]>('/staff/therapists');
  const [f, setF] = useState({
    memberId: '',
    kind: 'gaji_pokok',
    name: 'Gaji pokok',
    amount: '' as number | '',
    startMonth: todayIn(me?.organization?.timezone).slice(0, 7),
    endMonth: '',
    notes: '',
  });
  const { busy, error, submit } = useSubmit(
    () => post('/compensation/components', { ...f, amount: f.amount || 0, endMonth: f.endMonth || null, notes: f.notes || null }),
    () => {
      onSaved();
      onClose();
    },
  );
  const setKind = (kind: string) => setF({ ...f, kind, name: kind === 'gaji_pokok' ? 'Gaji pokok' : f.name === 'Gaji pokok' ? '' : f.name });
  return (
    <Dialog title="Tambah gaji pokok / tunjangan" onClose={onClose}>
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
          <Field label="Jenis">
            {(id) => (
              <select id={id} className="select" value={f.kind} onChange={(e) => setKind(e.target.value)}>
                <option value="gaji_pokok">Gaji pokok</option>
                <option value="tunjangan">Tunjangan</option>
              </select>
            )}
          </Field>
          <Field label="Nama komponen" hint={f.kind === 'tunjangan' ? 'Mis. Tunjangan transport, Tunjangan makan' : undefined}>
            {(id) => <input id={id} className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required minLength={2} maxLength={80} />}
          </Field>
          <Field label="Nominal per bulan (Rp)">{(id) => <MoneyInput id={id} value={f.amount} onChange={(v) => setF({ ...f, amount: v })} required />}</Field>
          <Field label="Berlaku mulai bulan">
            {(id) => <input id={id} className="input" type="month" value={f.startMonth} onChange={(e) => setF({ ...f, startMonth: e.target.value })} required />}
          </Field>
          <Field label="Sampai bulan" hint="Kosongkan bila masih berlaku">
            {(id) => <input id={id} className="input" type="month" value={f.endMonth} min={f.startMonth} onChange={(e) => setF({ ...f, endMonth: e.target.value })} />}
          </Field>
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

function EndComponentDialog({ component, onClose, onSaved }: { component: any; onClose: () => void; onSaved: () => void }) {
  const { me } = useAuth();
  const [month, setMonth] = useState(todayIn(me?.organization?.timezone).slice(0, 7));
  const { busy, error, submit } = useSubmit(() => post(`/compensation/components/${component.id}/end`, { endMonth: month }), () => {
    onSaved();
    onClose();
  });
  return (
    <Dialog title={`Akhiri ${component.name} — ${component.therapistName}`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <Field label="Berlaku sampai bulan" hint="Bulan terakhir komponen ini masih dibayarkan">
          {(id) => <input id={id} className="input" type="month" value={month} min={component.lastPaidMonth ?? component.startMonth} onChange={(e) => setMonth(e.target.value)} required />}
        </Field>
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
          <h2>Rincian honor per sesi</h2>
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
        <h2>Honor per sesi</h2>
        {can('compensation.manage') ? (
          <button className="btn btn-sm" onClick={() => setCreating(true)}>
            <Icon name="plus" /> Aturan per sesi
          </button>
        ) : null}
      </div>
      <p className="card-body small muted" style={{ paddingBottom: 0 }}>
        Dihitung otomatis saat sesi ditandai selesai: nominal tetap atau persentase dari tarif. Bisa berdiri sendiri (hanya per sesi) atau ditambahkan di atas gaji pokok. Aturan khusus layanan diutamakan di atas aturan umum. Perubahan tarif dilakukan dengan mengakhiri aturan lama dan membuat aturan baru.
      </p>
      {loading && !data ? <Loading /> : null}
      <ErrorBox error={error} />
      {data?.length === 0 ? <Empty title="Belum ada aturan honor per sesi" /> : null}
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
    <Dialog title="Aturan honor per sesi" onClose={onClose}>
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
