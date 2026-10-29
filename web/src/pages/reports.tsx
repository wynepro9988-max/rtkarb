import { useState } from 'react';
import { downloadUrl, qs, useApi } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { APPT_STATUS, formatNumber, formatRupiah, METHOD, monthRange, todayIn } from '../format.ts';
import { Empty, ErrorBox, Field, Icon, Loading, PageHeader, Stat, StatStrip, Tabs } from '../ui.tsx';

function Definitions({ defs }: { defs: Record<string, string> }) {
  return (
    <details className="card card-pad small">
      <summary style={{ cursor: 'pointer', fontWeight: 700 }}>Definisi angka pada laporan ini</summary>
      <dl className="kv" style={{ marginTop: 10 }}>
        {Object.entries(defs).map(([k, v]) => (
          <div key={k} style={{ display: 'contents' }}>
            <dt>{k.replaceAll('_', ' ')}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

export function ReportsPage() {
  const { can, me } = useAuth();
  const tabs = [
    ...(can('report.operational') ? [{ value: 'operasional' as const, label: 'Operasional' }] : []),
    ...(can('report.finance') ? [{ value: 'keuangan' as const, label: 'Keuangan' }] : []),
  ];
  const [tab, setTab] = useState(tabs[0]?.value ?? 'operasional');
  const [range, setRange] = useState(() => monthRange(todayIn(me?.organization?.timezone)));
  return (
    <>
      <PageHeader
        title="Laporan"
        subtitle={`Hanya data ${me?.organization?.name}. Tidak ada laporan gabungan antar-organisasi.`}
        actions={
          can('report.export') ? (
            <>
              <button className="btn btn-secondary" onClick={() => downloadUrl(`/reports/${tab}/pdf${qs(range)}`)}>
                <Icon name="download" /> Unduh PDF
              </button>
              <button className="btn btn-secondary" onClick={() => downloadUrl(`/reports/${tab}/export${qs(range)}`)}>
                <Icon name="download" /> Ekspor Excel
              </button>
            </>
          ) : null
        }
      />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      <div className="row" style={{ marginBottom: 14 }}>
        <Field label="Dari">{(id) => <input id={id} className="input" type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />}</Field>
        <Field label="Sampai">{(id) => <input id={id} className="input" type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />}</Field>
      </div>
      {tab === 'operasional' ? <Operational range={range} /> : <Finance range={range} />}
    </>
  );
}

function Operational({ range }: { range: { from: string; to: string } }) {
  const { data, error, loading } = useApi<any>(`/reports/operational${qs(range)}`);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;
  const status = Object.fromEntries(data.sessionsByStatus.map((s: any) => [s.status, s.count]));
  return (
    <div className="stack">
      <StatStrip>
        <Stat label="Pasien aktif" value={formatNumber(data.patients.active)} hint="Saat ini" />
        <Stat label="Pasien baru" value={formatNumber(data.patients.newInRange)} hint="Terdaftar pada rentang" />
        <Stat label="Sesi selesai" value={formatNumber(status.selesai ?? 0)} hint={`${status.tidak_hadir ?? 0} tidak hadir · ${status.dibatalkan ?? 0} dibatalkan`} />
        <Stat label="Sesi paket terpakai" value={formatNumber(data.packageUsage.sessionsUsed)} />
      </StatStrip>
      {data.pendingNotes !== null ? (
        <div className={`alert ${data.overdueNotes ? 'error' : 'info'}`}>
          Sesi selesai tanpa catatan final pada rentang ini: {data.pendingNotes}
          {data.overdueNotes ? `, ${data.overdueNotes} di antaranya lewat batas akhir bulan` : ''}.
          {data.lateNotes ? ` ${data.lateNotes} catatan difinalkan setelah batas.` : ''}
        </div>
      ) : null}
      <div className="grid grid-2">
        {/* Dengan kolom kepatuhan catatan, tabel terapis memakai lebar penuh. */}
        <section className="card" style={data.pendingNotes !== null ? { gridColumn: '1 / -1' } : undefined}>
          <div className="card-head">
            <h2>Per terapis</h2>
          </div>
          {data.byTherapist.length === 0 ? <Empty title="Tidak ada sesi" /> : null}
          {data.byTherapist.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Terapis</th>
                    <th className="num">{APPT_STATUS.selesai.label}</th>
                    <th className="num">Tidak hadir</th>
                    <th className="num">Dibatalkan</th>
                    <th className="num">Terjadwal</th>
                    {data.pendingNotes !== null ? (
                      <>
                        <th className="num">Catatan belum final</th>
                        <th className="num">Final terlambat</th>
                      </>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {data.byTherapist.map((t: any) => (
                    <tr key={t.therapistName}>
                      <td>{t.therapistName}</td>
                      <td className="num">{t.completed}</td>
                      <td className="num">{t.noShow}</td>
                      <td className="num">{t.cancelled}</td>
                      <td className="num">{t.scheduled}</td>
                      {data.pendingNotes !== null ? (
                        <>
                          <td className="num">
                            {t.notesPending}
                            {t.notesOverdue ? <div className="small" style={{ color: 'var(--c-danger)', fontWeight: 700 }}>{t.notesOverdue} lewat batas</div> : null}
                          </td>
                          <td className="num">{t.notesLate}</td>
                        </>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
        <section className="card">
          <div className="card-head">
            <h2>Sesi selesai per layanan</h2>
          </div>
          {data.byService.length === 0 ? <Empty title="Tidak ada sesi" /> : null}
          {data.byService.map((s: any) => (
            <div key={s.serviceName} className="card-body spread" style={{ borderBottom: '1px solid var(--c-border)' }}>
              <span>{s.serviceName}</span>
              <strong>{s.completed}</strong>
            </div>
          ))}
        </section>
      </div>
      <Definitions defs={data.definitions} />
    </div>
  );
}

function Finance({ range }: { range: { from: string; to: string } }) {
  const { data, error, loading } = useApi<any>(`/reports/finance${qs(range)}`);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;
  return (
    <div className="stack">
      <StatStrip>
        <Stat label="Penerimaan" value={formatRupiah(data.payments.total)} hint={`${data.payments.count} transaksi · basis kas`} />
        <Stat label="Refund & pengeluaran" value={formatRupiah(data.refunds.total + data.expenses.total)} hint={`Refund ${formatRupiah(data.refunds.total)} · pengeluaran ${formatRupiah(data.expenses.total)}`} />
        <Stat label="Selisih kas" value={formatRupiah(data.cashDifference)} hint="Bukan laba" />
        <Stat label="Piutang saat ini" value={formatRupiah(data.receivables.sessions + data.receivables.packages + data.receivables.invoices)} hint="Invoice + sesi + paket belum lunas" />
      </StatStrip>
      <div className="grid grid-2">
        <section className="card">
          <div className="card-head">
            <h2>Penerimaan per metode</h2>
          </div>
          {data.byMethod.length === 0 ? <Empty title="Tidak ada penerimaan" /> : null}
          {data.byMethod.map((m: any) => (
            <div key={m.method} className="card-body spread" style={{ borderBottom: '1px solid var(--c-border)' }}>
              <span>
                {METHOD[m.method]} <span className="muted small">({m.count})</span>
              </span>
              <strong className="mono">{formatRupiah(m.total)}</strong>
            </div>
          ))}
        </section>
        <section className="card">
          <div className="card-head">
            <h2>Pengeluaran per kategori</h2>
          </div>
          {data.expensesByCategory.length === 0 ? <Empty title="Tidak ada pengeluaran" /> : null}
          {data.expensesByCategory.map((c: any) => (
            <div key={c.category} className="card-body spread" style={{ borderBottom: '1px solid var(--c-border)' }}>
              <span>{c.category}</span>
              <strong className="mono">{formatRupiah(c.total)}</strong>
            </div>
          ))}
        </section>
      </div>
      <StatStrip>
        <Stat label="Honor belum dibayar" value={formatRupiah(data.compensation.unpaid)} hint="Sesi pada rentang" />
        <Stat label="Honor sudah dibayar" value={formatRupiah(data.compensation.paid)} />
        <Stat label="Pembayaran dibatalkan" value={formatNumber(data.payments.voided)} />
      </StatStrip>
      <Definitions defs={data.definitions} />
    </div>
  );
}
