import { useState } from 'react';
import { post, put, qs, useApi } from '../api.ts';
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
          <MonthlyRecap key={month} month={month} />
          <div style={{ marginTop: 18 }}>
            <Recap range={monthRange(`${month}-01`)} />
          </div>
        </>
      ) : (
        <SchemesTab />
      )}
    </>
  );
}

// Gaji & tunjangan satu bulan dibayarkan tanggal 1 bulan berikutnya.
const payDay = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
};

function MonthlyRecap({ month }: { month: string }) {
  const { can, me } = useAuth();
  const toast = useToast();
  const { data, error, loading, reload } = useApi<any>(`/compensation/monthly${qs({ month })}`);
  const [selected, setSelected] = useState<string[]>([]);
  const [paidOn, setPaidOn] = useState(() => payDay(month));
  const manage = can('compensation.manage');
  const monthOver = todayIn(me?.organization?.timezone) >= payDay(month);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;
  // Satu baris per terapis: total gaji pokok + tunjangan (bulanan dan harian) bulan itu.
  const payRows = data.therapists
    .filter((t: any) => t.fixed.length)
    .map((t: any) => {
      const unpaid = t.fixed.filter((f: any) => !f.paidOn && Number(f.amount) > 0);
      const paid = t.fixed.filter((f: any) => f.paidOn);
      return {
        memberId: t.memberId as string,
        therapistName: t.therapistName as string,
        total: Number(t.fixedTotal),
        unpaidIds: unpaid.map((f: any) => f.componentId as string),
        unpaidAmount: unpaid.reduce((n: number, f: any) => n + Number(f.amount), 0),
        paidOn: (paid.map((f: any) => f.paidOn).sort().pop() ?? null) as string | null,
        partly: paid.length > 0 && unpaid.length > 0,
        days: (t.fixed.find((f: any) => f.basis === 'harian')?.days ?? null) as number | null,
      };
    });
  type PayRow = (typeof payRows)[number];
  const chosen = payRows.filter((r: PayRow) => selected.includes(r.memberId));
  const markPaid = async () => {
    const early = monthOver ? '' : `\n\n${formatMonth(month)} belum berakhir; hari hadir yang belum terhitung tidak ikut dibayar.`;
    if (!confirm(`Tandai gaji & tunjangan ${formatMonth(month)} untuk ${chosen.length} terapis sebagai dibayar pada ${formatDate(paidOn)}?${early}`)) return;
    try {
      await post<{ updated: number }>('/compensation/components/mark-paid', { month, componentIds: chosen.flatMap((r: PayRow) => r.unpaidIds), paidOn });
      toast(`Gaji & tunjangan ${chosen.length} terapis ditandai dibayar`);
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

      {payRows.length ? (
        <section className="card">
          <div className="card-head">
            <div>
              <h2>Gaji pokok & tunjangan</h2>
              <p className="small muted">
                Akumulasi {formatMonth(month)}, dibayarkan {formatDate(payDay(month))}
                {monthOver ? '' : '. Tunjangan harian masih bertambah sampai akhir bulan.'}
              </p>
            </div>
            {manage && payRows.some((r: PayRow) => r.unpaidIds.length) ? (
              <div className="row">
                <input className="input" type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} style={{ width: 'auto' }} aria-label="Tanggal bayar" />
                <button className="btn btn-sm" disabled={!chosen.length} onClick={markPaid}>
                  Tandai dibayar ({chosen.length})
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
                  <th className="num">Total</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {payRows.map((r: PayRow) => (
                  <tr key={r.memberId}>
                    {manage ? (
                      <td>
                        {r.unpaidIds.length ? (
                          <input
                            type="checkbox"
                            aria-label={`Pilih ${r.therapistName}`}
                            checked={selected.includes(r.memberId)}
                            onChange={(e) => setSelected(e.target.checked ? [...selected, r.memberId] : selected.filter((x) => x !== r.memberId))}
                          />
                        ) : null}
                      </td>
                    ) : null}
                    <td data-label="Terapis">{r.therapistName}</td>
                    <td data-label="Total" className="num">
                      <div>
                        <strong>{formatRupiah(r.total)}</strong>
                        {r.days !== null ? <div className="small muted">{r.days} hari hadir</div> : null}
                      </div>
                    </td>
                    <td data-label="Status">
                      {r.unpaidIds.length === 0 && r.paidOn ? (
                        <>
                          <Badge tone="ok">Dibayar</Badge>
                          <div className="small muted">{formatDate(r.paidOn)}</div>
                        </>
                      ) : r.partly ? (
                        <>
                          <Badge tone="warn">Sebagian dibayar</Badge>
                          <div className="small muted">Sisa {formatRupiah(r.unpaidAmount)}</div>
                        </>
                      ) : r.unpaidIds.length ? (
                        <Badge tone="warn">Belum dibayar</Badge>
                      ) : (
                        <Badge>Belum ada hari hadir</Badge>
                      )}
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

// ---------------------------------------------------------------------------
// Skema honor: satu kartu per terapis, diatur sekaligus lewat satu formulir.
// ---------------------------------------------------------------------------

type RateScheme = 'tetap_per_sesi' | 'persen_tarif';
interface Rate {
  scheme: RateScheme;
  amount: number | null;
  percent: number | string | null;
}
interface Scheme {
  memberId: string;
  fullName: string;
  specialization: string | null;
  active: boolean;
  baseSalary: number | null;
  allowances: { name: string; amount: number; basis: Basis }[];
  perSession: Rate | null;
  serviceRates: (Rate & { serviceId: string; serviceName: string })[];
  upcomingMonth: string | null;
}

// Tunjangan per bulan dibayar penuh; per hari hadir = tarif x tanggal dengan minimal satu sesi selesai.
type Basis = 'bulanan' | 'harian';
const BASIS_LABEL: Record<Basis, string> = { bulanan: 'per bulan', harian: 'per hari hadir' };
const monthlyFixed = (baseSalary: number | '' | null, allowances: { amount: number | ''; basis: Basis }[]) =>
  Number(baseSalary || 0) + allowances.filter((a) => a.basis === 'bulanan').reduce((n, a) => n + Number(a.amount || 0), 0);

const rateText = (r: Rate) => (r.scheme === 'tetap_per_sesi' ? `${formatRupiah(r.amount)} per sesi` : `${Number(r.percent)}% dari tarif sesi`);
const ALLOWANCE_PRESETS = ['Tunjangan transport', 'Tunjangan makan', 'Tunjangan jabatan', 'Tunjangan kehadiran', 'Tunjangan komunikasi'];

const schemeFlags = (s: Scheme) => ({
  hasBaseSalary: Boolean(s.baseSalary),
  hasAllowance: s.allowances.length > 0,
  hasPerSession: Boolean(s.perSession) || s.serviceRates.length > 0,
});

function SchemesTab() {
  const { can, me } = useAuth();
  const [month, setMonth] = useState(() => todayIn(me?.organization?.timezone).slice(0, 7));
  const { data, error, loading, reload } = useApi<Scheme[]>(`/compensation/schemes${qs({ month })}`);
  const [editing, setEditing] = useState<Scheme | null>(null);
  const manage = can('compensation.manage');
  return (
    <div className="stack">
      <div className="row">
        <Field label="Skema yang berlaku pada bulan">
          {(id) => <input id={id} className="input" type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />}
        </Field>
      </div>
      {loading && !data ? <Loading /> : null}
      <ErrorBox error={error} />
      {data?.length === 0 ? (
        <div className="card">
          <Empty title="Belum ada terapis">Tandai staf sebagai terapis di menu Staf, lalu atur skemanya di sini.</Empty>
        </div>
      ) : null}
      {data?.length ? (
        <div className="grid grid-2">
          {data.map((s) => (
            <SchemeCard key={s.memberId} scheme={s} manage={manage} onEdit={() => setEditing(s)} />
          ))}
        </div>
      ) : null}
      {can('compensation.read') ? <SchemeHistory /> : null}
      {editing && data ? <SchemeDialog scheme={editing} all={data} onClose={() => setEditing(null)} onSaved={reload} /> : null}
    </div>
  );
}

function SchemeCard({ scheme: s, manage, onEdit }: { scheme: Scheme; manage: boolean; onEdit: () => void }) {
  const label = schemeLabel(schemeFlags(s));
  const fixed = monthlyFixed(s.baseSalary, s.allowances);
  const daily = s.allowances.filter((a) => a.basis === 'harian');
  return (
    <article className="card">
      <div className="card-head">
        <div>
          <h2>{s.fullName}</h2>
          <p className="small muted">{[s.specialization, s.active ? null : 'nonaktif'].filter(Boolean).join(', ') || 'Terapis'}</p>
        </div>
        {manage ? (
          <button className="btn btn-sm btn-secondary" onClick={onEdit}>
            Atur skema
          </button>
        ) : null}
      </div>
      <div className="card-body stack" style={{ gap: 12 }}>
        <div>
          <Badge tone={label === 'Belum diatur' ? 'warn' : 'info'}>{label}</Badge>
        </div>
        {label === 'Belum diatur' ? (
          <p className="small muted">Honor terapis ini belum dihitung oleh sistem.</p>
        ) : (
          <dl className="scheme-lines">
            {s.baseSalary ? (
              <div>
                <dt>Gaji pokok</dt>
                <dd>{formatRupiah(s.baseSalary)}</dd>
              </div>
            ) : null}
            {s.allowances.map((a) => (
              <div key={a.name}>
                <dt>{a.name}</dt>
                <dd>
                  {formatRupiah(a.amount)}
                  {a.basis === 'harian' ? ' / hari hadir' : ''}
                </dd>
              </div>
            ))}
            {fixed ? (
              <div className="scheme-total">
                <dt>Tetap per bulan</dt>
                <dd>{formatRupiah(fixed)}</dd>
              </div>
            ) : null}
            {daily.length ? (
              <div>
                <dt>Ditambah tunjangan harian</dt>
                <dd>{formatRupiah(daily.reduce((n, a) => n + Number(a.amount), 0))} × hari hadir</dd>
              </div>
            ) : null}
            {s.perSession ? (
              <div>
                <dt>Honor per sesi</dt>
                <dd>{rateText(s.perSession)}</dd>
              </div>
            ) : null}
            {s.serviceRates.map((r) => (
              <div key={r.serviceId}>
                <dt>{r.serviceName}</dt>
                <dd>{rateText(r)}</dd>
              </div>
            ))}
          </dl>
        )}
        {s.upcomingMonth ? <p className="small muted">Ada perubahan terjadwal mulai {formatMonth(s.upcomingMonth)}.</p> : null}
      </div>
    </article>
  );
}

type SchemeKind = 'per_sesi' | 'gaji_per_sesi' | 'gaji';
const SCHEME_KINDS: { value: SchemeKind; label: string }[] = [
  { value: 'per_sesi', label: 'Hanya per sesi' },
  { value: 'gaji_per_sesi', label: 'Gaji + tunjangan + per sesi' },
  { value: 'gaji', label: 'Gaji + tunjangan saja' },
];

interface RateForm {
  scheme: RateScheme;
  amount: number | '';
  percent: string;
}
interface SchemeForm {
  kind: SchemeKind;
  baseSalary: number | '';
  allowances: { name: string; amount: number | ''; basis: Basis }[];
  perSession: RateForm;
  serviceRates: (RateForm & { serviceId: string })[];
}

const rateForm = (r: Rate | null): RateForm => ({
  scheme: r?.scheme ?? 'tetap_per_sesi',
  amount: r?.amount ?? '',
  percent: r?.percent != null ? String(Number(r.percent)) : '',
});
const rateBody = (r: RateForm) => (r.scheme === 'tetap_per_sesi' ? { scheme: r.scheme, amount: r.amount || 0 } : { scheme: r.scheme, percent: Number(r.percent) });

function toForm(s: Scheme): SchemeForm {
  const { hasBaseSalary, hasAllowance, hasPerSession } = schemeFlags(s);
  const fixed = hasBaseSalary || hasAllowance;
  return {
    kind: fixed ? (hasPerSession ? 'gaji_per_sesi' : 'gaji') : 'per_sesi',
    baseSalary: s.baseSalary ?? '',
    allowances: s.allowances.map((a) => ({ name: a.name, amount: Number(a.amount), basis: a.basis })),
    perSession: rateForm(s.perSession),
    serviceRates: s.serviceRates.map((r) => ({ ...rateForm(r), serviceId: r.serviceId })),
  };
}

function RateInputs({ value, onChange, label }: { value: RateForm; onChange: (v: RateForm) => void; label: string }) {
  return (
    <>
      <select className="select" aria-label={`Cara hitung ${label}`} value={value.scheme} onChange={(e) => onChange({ ...value, scheme: e.target.value as RateScheme })}>
        <option value="tetap_per_sesi">Nominal per sesi</option>
        <option value="persen_tarif">Persen dari tarif</option>
      </select>
      {value.scheme === 'tetap_per_sesi' ? (
        <MoneyInput ariaLabel={`Nominal ${label}`} value={value.amount} onChange={(v) => onChange({ ...value, amount: v })} required />
      ) : (
        <input
          className="input"
          aria-label={`Persen ${label}`}
          type="number"
          min={0.01}
          max={100}
          step={0.01}
          placeholder="%"
          value={value.percent}
          onChange={(e) => onChange({ ...value, percent: e.target.value })}
          required
        />
      )}
    </>
  );
}

function SchemeDialog({ scheme, all, onClose, onSaved }: { scheme: Scheme; all: Scheme[]; onClose: () => void; onSaved: () => void }) {
  const { me } = useAuth();
  const toast = useToast();
  const { data: services } = useApi<{ id: string; name: string; active: boolean }[]>('/services');
  const [f, setF] = useState<SchemeForm>(() => toForm(scheme));
  const [effectiveMonth, setEffectiveMonth] = useState(() => todayIn(me?.organization?.timezone).slice(0, 7));
  const withFixed = f.kind !== 'per_sesi';
  const withPerSession = f.kind !== 'gaji';
  const others = all.filter((s) => s.memberId !== scheme.memberId && schemeLabel(schemeFlags(s)) !== 'Belum diatur');
  const fixedTotal = withFixed ? monthlyFixed(f.baseSalary, f.allowances) : 0;
  const dailyTotal = withFixed ? f.allowances.filter((a) => a.basis === 'harian').reduce((n, a) => n + Number(a.amount || 0), 0) : 0;
  const usedServices = new Set(f.serviceRates.map((r) => r.serviceId));

  const { busy, error, submit } = useSubmit(
    () =>
      put(`/compensation/schemes/${scheme.memberId}`, {
        effectiveMonth,
        baseSalary: withFixed && f.baseSalary ? f.baseSalary : null,
        allowances: withFixed ? f.allowances.filter((a) => a.name.trim()).map((a) => ({ name: a.name.trim(), amount: a.amount || 0, basis: a.basis })) : [],
        perSession: withPerSession ? rateBody(f.perSession) : null,
        serviceRates: withPerSession ? f.serviceRates.filter((r) => r.serviceId).map((r) => ({ serviceId: r.serviceId, ...rateBody(r) })) : [],
      }),
    () => {
      toast(`Skema ${scheme.fullName} disimpan, berlaku mulai ${formatMonth(effectiveMonth)}`);
      onSaved();
      onClose();
    },
  );

  const setAllowance = (i: number, patchValue: Partial<SchemeForm['allowances'][number]>) =>
    setF({ ...f, allowances: f.allowances.map((a, j) => (j === i ? { ...a, ...patchValue } : a)) });
  const setServiceRate = (i: number, value: SchemeForm['serviceRates'][number]) => setF({ ...f, serviceRates: f.serviceRates.map((r, j) => (j === i ? value : r)) });
  const hasAllowance = (name: string) => f.allowances.some((a) => a.name.trim().toLowerCase() === name.toLowerCase());

  return (
    <Dialog title={`Skema honor — ${scheme.fullName}`} onClose={onClose} wide>
      <form className="form" onSubmit={submit}>
        {others.length ? (
          <Field label="Salin dari terapis lain" hint="Opsional. Mengisi formulir dengan skema terapis lain, lalu bisa diubah.">
            {(id) => (
              <select
                id={id}
                className="select"
                value=""
                onChange={(e) => {
                  const src = others.find((s) => s.memberId === e.target.value);
                  if (src) setF(toForm(src));
                }}
              >
                <option value="">Pilih terapis…</option>
                {others.map((s) => (
                  <option key={s.memberId} value={s.memberId}>
                    {s.fullName} ({schemeLabel(schemeFlags(s))})
                  </option>
                ))}
              </select>
            )}
          </Field>
        ) : null}

        <div className="field">
          <span className="label">Jenis skema</span>
          <div className="segmented" role="group" aria-label="Jenis skema">
            {SCHEME_KINDS.map((k) => (
              <button key={k.value} type="button" aria-pressed={f.kind === k.value} onClick={() => setF({ ...f, kind: k.value })}>
                {k.label}
              </button>
            ))}
          </div>
        </div>

        {withFixed ? (
          <section className="scheme-section">
            <h3>Gaji pokok & tunjangan</h3>
            <Field label="Gaji pokok (Rp)" hint="Kosongkan bila hanya tunjangan">
              {(id) => <MoneyInput id={id} value={f.baseSalary} onChange={(v) => setF({ ...f, baseSalary: v })} />}
            </Field>
            <div className="line-rows">
              {f.allowances.map((a, i) => (
                <div key={i} className="line-row allowance-row">
                  <input className="input" aria-label="Nama tunjangan" placeholder="Nama tunjangan" value={a.name} onChange={(e) => setAllowance(i, { name: e.target.value })} required minLength={2} maxLength={80} />
                  <MoneyInput ariaLabel={`Nominal ${a.name || 'tunjangan'}`} value={a.amount} onChange={(v) => setAllowance(i, { amount: v })} required />
                  <select className="select" aria-label={`Dihitung ${a.name || 'tunjangan'}`} value={a.basis} onChange={(e) => setAllowance(i, { basis: e.target.value as Basis })}>
                    <option value="bulanan">{BASIS_LABEL.bulanan}</option>
                    <option value="harian">{BASIS_LABEL.harian}</option>
                  </select>
                  <button type="button" className="icon-btn" aria-label={`Hapus ${a.name || 'tunjangan'}`} onClick={() => setF({ ...f, allowances: f.allowances.filter((_, j) => j !== i) })}>
                    <Icon name="x" />
                  </button>
                </div>
              ))}
            </div>
            <div className="chips" aria-label="Tambah tunjangan">
              {ALLOWANCE_PRESETS.map((name) => (
                <button key={name} type="button" className="chip" disabled={hasAllowance(name)} onClick={() => setF({ ...f, allowances: [...f.allowances, { name, amount: '', basis: 'bulanan' }] })}>
                  + {name.replace('Tunjangan ', '')}
                </button>
              ))}
              <button type="button" className="chip" onClick={() => setF({ ...f, allowances: [...f.allowances, { name: '', amount: '', basis: 'bulanan' }] })}>
                + Tunjangan lain
              </button>
            </div>
            {f.allowances.some((a) => a.basis === 'harian') ? (
              <p className="small muted">
                Per hari hadir: nominal dikali jumlah tanggal terapis mengabsen minimal satu sesi pada bulan itu. Beberapa sesi di tanggal yang sama tetap dihitung satu
                hari.
              </p>
            ) : null}
          </section>
        ) : null}

        {withPerSession ? (
          <section className="scheme-section">
            <h3>Honor per sesi</h3>
            <div className="line-row rate-row">
              <span className="small muted">Semua layanan</span>
              <RateInputs label="honor per sesi" value={f.perSession} onChange={(v) => setF({ ...f, perSession: v })} />
            </div>
            {f.serviceRates.map((r, i) => (
              <div key={i} className="line-row rate-row">
                <select className="select" aria-label="Layanan" value={r.serviceId} onChange={(e) => setServiceRate(i, { ...r, serviceId: e.target.value })} required>
                  <option value="">Pilih layanan…</option>
                  {services
                    ?.filter((s) => s.id === r.serviceId || (s.active && !usedServices.has(s.id)))
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                </select>
                <RateInputs label="tarif khusus" value={r} onChange={(v) => setServiceRate(i, { ...v, serviceId: r.serviceId })} />
                <button type="button" className="icon-btn" aria-label="Hapus tarif khusus" onClick={() => setF({ ...f, serviceRates: f.serviceRates.filter((_, j) => j !== i) })}>
                  <Icon name="x" />
                </button>
              </div>
            ))}
            <div className="chips">
              <button
                type="button"
                className="chip"
                disabled={!services || services.filter((s) => s.active).length <= usedServices.size}
                onClick={() => setF({ ...f, serviceRates: [...f.serviceRates, { serviceId: '', scheme: 'tetap_per_sesi', amount: '', percent: '' }] })}
              >
                + Tarif khusus untuk layanan tertentu
              </button>
            </div>
          </section>
        ) : null}

        <section className="scheme-section">
          <Field label="Berlaku mulai bulan" hint="Bulan sebelumnya tidak berubah. Honor sesi yang sudah dihitung tidak dihitung ulang.">
            {(id) => <input id={id} className="input" type="month" value={effectiveMonth} onChange={(e) => e.target.value && setEffectiveMonth(e.target.value)} required />}
          </Field>
          <dl className="scheme-lines">
            {withFixed ? (
              <div className="scheme-total">
                <dt>Tetap per bulan</dt>
                <dd>{formatRupiah(fixedTotal)}</dd>
              </div>
            ) : null}
            {dailyTotal ? (
              <div>
                <dt>Ditambah tunjangan harian</dt>
                <dd>{formatRupiah(dailyTotal)} × hari hadir</dd>
              </div>
            ) : null}
            {withPerSession ? (
              <div>
                <dt>Ditambah honor per sesi</dt>
                <dd>
                  {f.perSession.scheme === 'tetap_per_sesi'
                    ? f.perSession.amount
                      ? `${formatRupiah(f.perSession.amount)} per sesi`
                      : '—'
                    : f.perSession.percent
                      ? `${f.perSession.percent}% dari tarif`
                      : '—'}
                </dd>
              </div>
            ) : null}
          </dl>
        </section>

        <ErrorBox error={error} />
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Batal
          </button>
          <button className="btn" disabled={busy}>
            {busy ? 'Menyimpan…' : 'Simpan skema'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// Riwayat lengkap komponen & aturan (termasuk yang sudah berakhir), untuk penelusuran.
function SchemeHistory() {
  const [open, setOpen] = useState(false);
  const { data: components } = useApi<any[]>(open ? '/compensation/components' : null);
  const { data: rules } = useApi<any[]>(open ? '/compensation/rules' : null);
  return (
    <details className="card scheme-history" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="card-head">
        <h2>Riwayat skema</h2>
      </summary>
      {open && (!components || !rules) ? <Loading /> : null}
      {components && rules ? (
        <div className="table-wrap">
          <table className="table responsive">
            <thead>
              <tr>
                <th>Terapis</th>
                <th>Komponen</th>
                <th className="num">Nilai</th>
                <th>Berlaku</th>
              </tr>
            </thead>
            <tbody>
              {components.map((c) => (
                <tr key={c.id}>
                  <td data-label="Terapis">{c.therapistName}</td>
                  <td data-label="Komponen">
                    <ComponentName name={c.name} kind={c.kind} />
                  </td>
                  <td data-label="Nilai" className="num">
                    {formatRupiah(c.amount)} {c.basis === 'harian' ? '/ hari hadir' : '/ bulan'}
                  </td>
                  <td data-label="Berlaku">
                    {formatMonth(c.startMonth)} – {c.endMonth ? formatMonth(c.endMonth) : 'sekarang'}
                  </td>
                </tr>
              ))}
              {rules.map((r) => (
                <tr key={r.id}>
                  <td data-label="Terapis">{r.therapistName}</td>
                  <td data-label="Komponen">
                    Honor per sesi <span className="muted small">{r.serviceName ?? 'semua layanan'}</span>
                  </td>
                  <td data-label="Nilai" className="num">
                    {rateText(r)}
                  </td>
                  <td data-label="Berlaku">
                    {formatDate(r.effectiveFrom)} – {r.effectiveTo ? formatDate(r.effectiveTo) : 'sekarang'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </details>
  );
}
