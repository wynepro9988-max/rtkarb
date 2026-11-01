import { useState } from 'react';
import { useApi } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { APPT_STATUS, formatDate, formatDateShort, formatRupiah, formatWeekday, NOTE_TYPE } from '../format.ts';
import { Badge, Empty, ErrorBox, Loading, PageHeader, Stat, StatStrip, Tabs } from '../ui.tsx';

interface Session {
  id: string;
  patientId: string;
  status: string;
  durationMinutes: number;
  localDate: string;
  localTime: string;
  serviceName: string | null;
  therapistName: string;
}
interface Portal {
  children: { id: string; fullName: string; nickname: string | null; patientCode: string }[];
  upcoming: Session[];
  history: Session[];
  attendance: { patientId: string; attended: number; missed: number }[];
  packages: { id: string; patientId: string; name: string; sessionsTotal: number; sessionsUsed: number; expiresOn: string | null }[];
  invoices: { id: string; patientId: string; invoiceNo: string; issuedOn: string; dueOn: string | null; total: number; paid: number }[];
}

interface Note {
  id: string;
  noteType: string;
  objectives: string | null;
  activities: string | null;
  observations: string | null;
  homeProgram: string | null;
  nextPlan: string | null;
  authorName: string;
  localDate: string;
}

const NOTE_LIMIT = 50;
const NOTE_FIELDS: { key: keyof Note; label: string }[] = [
  { key: 'objectives', label: 'Tujuan / target sesi' },
  { key: 'activities', label: 'Aktivitas' },
  { key: 'observations', label: 'Observasi & respons anak' },
  { key: 'homeProgram', label: 'Program di rumah' },
  { key: 'nextPlan', label: 'Rencana sesi berikutnya' },
];

function NotesPanel({ childId }: { childId: string }) {
  const { data, error, loading } = useApi<Note[]>(`/portal/notes?patientId=${childId}`);
  if (loading) return <Loading />;
  if (error || !data) return <ErrorBox error={error} />;
  if (data.length === 0) {
    return (
      <div className="card">
        <Empty title="Belum ada catatan terapis">Catatan tampil di sini setelah terapis menyelesaikannya.</Empty>
      </div>
    );
  }
  return (
    <div className="stack">
      {data.map((n) => (
        <article key={n.id} className="card">
          <div className="card-head">
            <div>
              <h2>{formatDate(n.localDate)}</h2>
              <p className="small muted">
                {NOTE_TYPE[n.noteType] ?? n.noteType} oleh {n.authorName}
              </p>
            </div>
          </div>
          <div className="card-body">
            <dl className="note-read">
              {NOTE_FIELDS.filter((f) => n[f.key]).map((f) => (
                <div key={f.key}>
                  <dt>{f.label}</dt>
                  <dd>{n[f.key]}</dd>
                </div>
              ))}
            </dl>
          </div>
        </article>
      ))}
      {data.length === NOTE_LIMIT ? <p className="small muted">Menampilkan {NOTE_LIMIT} catatan terbaru.</p> : null}
    </div>
  );
}

function invoiceStatus(i: Portal['invoices'][number]) {
  if (i.paid >= i.total) return { label: 'Lunas', tone: 'ok' };
  return i.paid > 0 ? { label: 'Dibayar sebagian', tone: 'warn' } : { label: 'Belum dibayar', tone: 'warn' };
}

// Sesi lampau yang masih "terjadwal" berarti staf belum menandai hasilnya.
const historyStatus = (status: string) => (status === 'terjadwal' ? { label: 'Belum dikonfirmasi', tone: '' } : (APPT_STATUS[status] ?? { label: status, tone: '' }));

function SessionRow({ s, showStatus }: { s: Session; showStatus?: boolean }) {
  const status = historyStatus(s.status);
  return (
    <div className="card-body spread portal-row">
      <div>
        <strong>{showStatus ? formatDateShort(s.localDate) : formatWeekday(s.localDate)}</strong>, pukul {s.localTime}
        <div className="small muted">
          {s.serviceName ?? 'Sesi terapi'} bersama {s.therapistName}
        </div>
      </div>
      {showStatus ? <Badge tone={status.tone}>{status.label}</Badge> : null}
    </div>
  );
}

type View = 'ringkasan' | 'catatan';

function ChildPanel({ data, childId }: { data: Portal; childId: string }) {
  const [view, setView] = useState<View>('ringkasan');
  const mine = <T extends { patientId: string }>(rows: T[]) => rows.filter((r) => r.patientId === childId);
  const upcoming = mine(data.upcoming);
  const history = mine(data.history);
  const packages = mine(data.packages);
  const invoices = mine(data.invoices);
  const attendance = data.attendance.find((a) => a.patientId === childId);
  const remaining = packages.reduce((n, p) => n + p.sessionsTotal - p.sessionsUsed, 0);
  const unpaid = invoices.reduce((n, i) => n + Math.max(i.total - i.paid, 0), 0);
  const next = upcoming[0];

  const tabs = (
    <Tabs<View>
      tabs={[
        { value: 'ringkasan', label: 'Ringkasan' },
        { value: 'catatan', label: 'Catatan terapis' },
      ]}
      value={view}
      onChange={setView}
    />
  );
  if (view === 'catatan') {
    return (
      <>
        {tabs}
        <NotesPanel childId={childId} />
      </>
    );
  }

  return (
    <div className="stack">
      {tabs}
      <StatStrip>
        <Stat label="Sesi berikutnya" value={next ? formatDateShort(next.localDate) : '—'} hint={next ? `Pukul ${next.localTime}` : 'Belum ada jadwal'} />
        <Stat label="Hadir bulan ini" value={attendance?.attended ?? 0} hint={attendance?.missed ? `${attendance.missed} kali tidak hadir` : undefined} />
        <Stat label="Sisa sesi paket" value={packages.length ? remaining : '—'} hint={packages.length ? undefined : 'Tidak ada paket aktif'} />
        <Stat label="Sisa tagihan" value={formatRupiah(unpaid)} />
      </StatStrip>

      <div className="grid grid-2">
        <section className="card">
          <div className="card-head">
            <h2>Jadwal mendatang</h2>
          </div>
          {upcoming.length === 0 ? <Empty title="Belum ada jadwal mendatang" /> : upcoming.map((s) => <SessionRow key={s.id} s={s} />)}
        </section>
        <section className="card">
          <div className="card-head">
            <h2>Riwayat sesi</h2>
          </div>
          {history.length === 0 ? <Empty title="Belum ada riwayat sesi" /> : history.map((s) => <SessionRow key={s.id} s={s} showStatus />)}
        </section>
        <section className="card">
          <div className="card-head">
            <h2>Paket terapi</h2>
          </div>
          {packages.length === 0 ? <Empty title="Tidak ada paket aktif" /> : null}
          {packages.map((p) => (
            <div key={p.id} className="card-body spread portal-row">
              <div>
                <strong>{p.name}</strong>
                <div className="small muted">{p.expiresOn ? `Berlaku sampai ${formatDate(p.expiresOn)}` : 'Tanpa batas waktu'}</div>
              </div>
              <span className="small">
                Sisa <strong>{p.sessionsTotal - p.sessionsUsed}</strong> dari {p.sessionsTotal} sesi
              </span>
            </div>
          ))}
        </section>
        <section className="card">
          <div className="card-head">
            <h2>Tagihan</h2>
          </div>
          {invoices.length === 0 ? <Empty title="Belum ada tagihan" /> : null}
          {invoices.map((i) => {
            const status = invoiceStatus(i);
            return (
              <div key={i.id} className="card-body spread portal-row">
                <div>
                  <strong>{formatRupiah(i.total)}</strong>
                  <div className="small muted">
                    {i.invoiceNo}, terbit {formatDateShort(i.issuedOn)}
                    {i.dueOn && i.paid < i.total ? `, jatuh tempo ${formatDateShort(i.dueOn)}` : ''}
                  </div>
                  {i.paid > 0 && i.paid < i.total ? <div className="small muted">Sudah dibayar {formatRupiah(i.paid)}</div> : null}
                </div>
                <Badge tone={status.tone}>{status.label}</Badge>
              </div>
            );
          })}
        </section>
      </div>
    </div>
  );
}

export function PortalPage() {
  const { me } = useAuth();
  const { data, error, loading } = useApi<Portal>('/portal');
  const [selected, setSelected] = useState<string | null>(null);

  if (loading) return <Loading />;
  if (error || !data) return <ErrorBox error={error} />;
  const childId = selected ?? data.children[0]?.id;
  const child = data.children.find((c) => c.id === childId);

  return (
    <>
      <PageHeader title={`Halo, ${me?.user.fullName.split(' ')[0]}`} subtitle={child && data.children.length === 1 ? `Jadwal, catatan terapis, dan tagihan ${child.nickname ?? child.fullName}` : me?.organization?.name} />
      {!child ? (
        <div className="card">
          <Empty title="Belum ada anak yang terhubung">Hubungi admin {me?.organization?.name} untuk menghubungkan data anak ke akun Anda.</Empty>
        </div>
      ) : (
        <>
          {data.children.length > 1 ? (
            <Tabs tabs={data.children.map((c) => ({ value: c.id, label: c.nickname ?? c.fullName }))} value={child.id} onChange={setSelected} />
          ) : null}
          <ChildPanel key={child.id} data={data} childId={child.id} />
        </>
      )}
    </>
  );
}
