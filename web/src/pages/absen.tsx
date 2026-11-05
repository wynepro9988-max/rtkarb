import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { get, post, qs, useApi } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { SessionMediaDialog, SessionMedia } from '../components/session-media.tsx';
import { addDays, ageLabel, formatDate, formatRupiah, todayIn } from '../format.ts';
import { Badge, Dialog, Empty, ErrorBox, Field, Icon, Loading, PageHeader, useSubmit, useToast } from '../ui.tsx';

// Absen sesi: jadwal cukup berisi pasien dan layanan; terapis yang menangani mengabsen sendiri
// (atau admin memilih terapisnya), menulis aktivitas dan PR, lalu boleh menambah video/foto.

type Row = {
  id: string;
  patientId: string;
  patientCode: string;
  patientName: string;
  nickname: string | null;
  serviceId: string | null;
  serviceName: string | null;
  localTime: string;
  therapistMemberId: string | null;
  therapistName: string | null;
  noteId: string | null;
  mediaCount: number;
};

export function AbsenPage() {
  const { me, can } = useAuth();
  const tz = me?.organization?.timezone;
  const [params, setParams] = useSearchParams();
  const [date, setDate] = useState(() => todayIn(tz));
  const { data, error, loading, reload } = useApi<{ waiting: Row[]; done: Row[]; today: string }>(`/absen/agenda${qs({ date })}`);
  const [form, setForm] = useState<null | { row?: Row }>(null);
  const [media, setMedia] = useState<Row | null>(null);
  const canSeeMedia = can('therapy.note.read', 'therapy.note.read.assigned');

  // Tautan "Absen" dari halaman jadwal: /absen?jadwal=<id>
  const fromSchedule = params.get('jadwal');
  useEffect(() => {
    if (!fromSchedule || !data) return;
    const row = data.waiting.find((r) => r.id === fromSchedule);
    if (row) setForm({ row });
    setParams({}, { replace: true });
  }, [fromSchedule, data, setParams]);

  return (
    <>
      <PageHeader
        title="Absen sesi"
        subtitle="Pilih anak dan layanan, tulis aktivitas dan PR hari ini, lalu tambahkan video/foto bila perlu."
        actions={
          <button className="btn" onClick={() => setForm({})}>
            <Icon name="plus" /> Absen tanpa jadwal
          </button>
        }
      />
      <div className="row" style={{ marginBottom: 16 }}>
        <button className="btn btn-sm btn-secondary" onClick={() => setDate(addDays(date, -1))} aria-label="Hari sebelumnya">
          ‹
        </button>
        <input className="input" type="date" value={date} max={data?.today} onChange={(e) => e.target.value && setDate(e.target.value)} style={{ width: 'auto' }} aria-label="Tanggal" />
        <button className="btn btn-sm btn-secondary" onClick={() => setDate(addDays(date, 1))} disabled={Boolean(data && date >= data.today)} aria-label="Hari berikutnya">
          ›
        </button>
      </div>
      <ErrorBox error={error} />
      {loading && !data ? <Loading /> : null}
      {data ? (
        <div className="stack">
          <section className="card">
            <div className="card-head">
              <h2>Menunggu absen</h2>
              <span className="small muted">{data.waiting.length} jadwal</span>
            </div>
            {data.waiting.length === 0 ? <Empty title="Tidak ada jadwal yang menunggu absen">Anak tanpa jadwal tetap dapat diabsen lewat tombol Absen tanpa jadwal.</Empty> : null}
            {data.waiting.map((r) => (
              <div key={r.id} className="absen-row">
                <div className="time">{r.localTime}</div>
                <div className="who">
                  <strong>{r.patientName}</strong>
                  <span className="small muted">
                    <span className="mono">{r.patientCode}</span>
                    {r.nickname ? `, dipanggil ${r.nickname}` : ''}
                  </span>
                  <span className="small">
                    {r.serviceName ?? 'Layanan belum ditentukan'}
                    {r.therapistName ? `, ${r.therapistName}` : ''}
                  </span>
                </div>
                <button className="btn btn-sm" onClick={() => setForm({ row: r })}>
                  Absen
                </button>
              </div>
            ))}
          </section>
          <section className="card">
            <div className="card-head">
              <h2>Sudah diabsen</h2>
              <span className="small muted">{data.done.length} sesi</span>
            </div>
            {data.done.length === 0 ? <Empty title="Belum ada sesi yang diabsen pada tanggal ini" /> : null}
            {data.done.map((r) => (
              <div key={r.id} className="absen-row">
                <div className="time">{r.localTime}</div>
                <div className="who">
                  <strong>{r.patientName}</strong>
                  <span className="small muted">
                    <span className="mono">{r.patientCode}</span>, {r.serviceName ?? 'Sesi terapi'}, {r.therapistName}
                  </span>
                  <span className="row" style={{ gap: 6 }}>
                    {r.noteId ? <Badge tone="ok">Aktivitas & PR tercatat</Badge> : <Badge tone="warn">Belum ada aktivitas & PR</Badge>}
                    {canSeeMedia && r.mediaCount ? <Badge tone="info">{r.mediaCount} video/foto</Badge> : null}
                  </span>
                </div>
                <div className="row">
                  {canSeeMedia ? (
                    <button className="btn btn-sm btn-secondary" onClick={() => setMedia(r)}>
                      Video/foto
                    </button>
                  ) : null}
                  {!r.noteId && can('therapy.note.write') && r.therapistMemberId === me?.membership?.id ? (
                    <Link className="btn btn-sm btn-ghost" to={`/catatan/baru?patientId=${r.patientId}&appointmentId=${r.id}`}>
                      Tulis aktivitas & PR
                    </Link>
                  ) : null}
                </div>
              </div>
            ))}
          </section>
        </div>
      ) : null}
      {form ? <AbsenDialog row={form.row} date={date} onClose={() => setForm(null)} onSaved={() => void reload()} /> : null}
      {media ? (
        <SessionMediaDialog
          appointmentId={media.id}
          title={`Video/foto: ${media.patientName}`}
          canUpload={can('session.media.upload') && (media.therapistMemberId === me?.membership?.id || can('therapy.note.read'))}
          onClose={() => {
            setMedia(null);
            void reload();
          }}
        />
      ) : null}
    </>
  );
}

function PatientSearch({ value, onChange }: { value: any | null; onChange: (p: any | null) => void }) {
  const { me } = useAuth();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<any[] | null>(null);
  const today = todayIn(me?.organization?.timezone);
  useEffect(() => {
    if (value || !q.trim()) return setResults(null);
    const t = setTimeout(() => get<any[]>(`/absen/patients${qs({ q: q.trim() })}`).then(setResults, () => setResults([])), 250);
    return () => clearTimeout(t);
  }, [q, value]);
  if (value) {
    return (
      <div className="spread input" style={{ display: 'flex' }}>
        <span>
          <span className="mono">{value.patientCode}</span> <strong>{value.fullName}</strong>
        </span>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => onChange(null)}>
          Ganti
        </button>
      </div>
    );
  }
  return (
    <div>
      <div className="search">
        <Icon name="search" />
        <input className="input" placeholder="Ketik No. RM atau nama anak" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Cari anak" autoComplete="off" />
      </div>
      {results ? (
        <div className="pick-list">
          {results.length === 0 ? <p className="small muted" style={{ padding: '10px 14px' }}>Tidak ada anak aktif yang cocok.</p> : null}
          {results.map((p) => (
            <button key={p.id} type="button" onClick={() => onChange(p)}>
              <span className="mono">{p.patientCode}</span>
              <strong>{p.fullName}</strong>
              <span className="small muted">
                {p.nickname ? `${p.nickname}, ` : ''}
                {ageLabel(p.birthDate, today)}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AbsenDialog({ row, date, onClose, onSaved }: { row?: Row; date: string; onClose: () => void; onSaved: () => void }) {
  const { me, can } = useAuth();
  const toast = useToast();
  const manager = can('session.complete');
  const { data: services } = useApi<any[]>('/services');
  const { data: therapists } = useApi<any[]>(manager ? '/staff/therapists' : null);
  const [patient, setPatient] = useState<any | null>(row ? { id: row.patientId, patientCode: row.patientCode, fullName: row.patientName } : null);
  const [serviceId, setServiceId] = useState(row?.serviceId ?? '');
  const [therapistId, setTherapistId] = useState(manager ? '' : (me?.membership?.id ?? ''));
  const [time, setTime] = useState('');
  const [activities, setActivities] = useState('');
  const [homeProgram, setHomeProgram] = useState('');
  const [saved, setSaved] = useState<null | { appointmentId: string; summary: string }>(null);
  const activeServices = services?.filter((s) => s.active) ?? [];
  // Aktivitas & PR hanya ditulis oleh terapis yang menangani sesi.
  const writesNote = Boolean(therapistId) && therapistId === me?.membership?.id && can('therapy.note.write');

  const { busy, error, submit } = useSubmit(
    () =>
      post<any>('/absen', {
        patientId: patient?.id,
        ...(row ? { appointmentId: row.id } : { serviceId: serviceId || null, date, ...(time ? { time } : {}) }),
        ...(row && !row.serviceId && serviceId ? { serviceId } : {}),
        ...(manager ? { therapistMemberId: therapistId } : {}),
        ...(writesNote ? { activities: activities || null, homeProgram: homeProgram || null } : {}),
      }),
    (r) => {
      const bill =
        r.billing === 'paket'
          ? `Paket ${r.packageName}${r.sessionsRemaining !== null ? `, sisa ${r.sessionsRemaining} sesi` : ''}`
          : r.billing === 'per_sesi'
            ? `Per sesi ${formatRupiah(r.price)}`
            : 'Tanpa biaya';
      toast('Absen tersimpan');
      onSaved();
      setSaved({ appointmentId: r.appointmentId, summary: bill });
    },
  );

  if (saved) {
    return (
      <Dialog title="Absen tersimpan" onClose={onClose} wide>
        <div className="form">
          <div className="alert ok">
            <strong>{patient?.fullName}</strong> sudah diabsen. {saved.summary}.
          </div>
          {can('session.media.upload') && writesNote ? <SessionMedia appointmentId={saved.appointmentId} canUpload /> : null}
          <div className="form-actions">
            <button type="button" className="btn" onClick={onClose}>
              Selesai
            </button>
          </div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title={row ? `Absen ${row.localTime}` : 'Absen tanpa jadwal'} onClose={onClose} wide>
      <form className="form" onSubmit={submit}>
        <div className="field">
          <span className="label">Anak</span>
          {row ? (
            <div className="input">
              <span className="mono">{row.patientCode}</span> <strong>{row.patientName}</strong>
            </div>
          ) : (
            <PatientSearch value={patient} onChange={setPatient} />
          )}
        </div>
        <div className="field">
          <span className="label">Layanan</span>
          {row?.serviceId ? (
            <div className="input">{row.serviceName}</div>
          ) : (
            <div className="segmented" role="group" aria-label="Layanan">
              {activeServices.map((s) => (
                <button key={s.id} type="button" aria-pressed={serviceId === s.id} onClick={() => setServiceId(s.id)}>
                  {s.name}
                </button>
              ))}
            </div>
          )}
        </div>
        {manager ? (
          <Field label="Terapis yang menangani" hint="Boleh terapis pengganti.">
            {(id) => (
              <select id={id} className="select" value={therapistId} onChange={(e) => setTherapistId(e.target.value)} required>
                <option value="">Pilih terapis…</option>
                {therapists?.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.fullName}
                    {t.id === me?.membership?.id ? ' (saya)' : ''}
                  </option>
                ))}
              </select>
            )}
          </Field>
        ) : null}
        {!row ? (
          <Field label="Jam mulai" hint={`Tanggal ${formatDate(date)}. Kosongkan untuk jam sekarang.`}>
            {(id) => <input id={id} className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} style={{ maxWidth: 180 }} />}
          </Field>
        ) : null}
        {writesNote ? (
          <>
            <Field label="Aktivitas hari ini" hint="Langsung terlihat oleh orang tua di dasbor orang tua.">
              {(id) => <textarea id={id} className="textarea" value={activities} onChange={(e) => setActivities(e.target.value)} maxLength={5000} required />}
            </Field>
            <Field label="PR untuk di rumah" hint="Opsional.">
              {(id) => <textarea id={id} className="textarea" style={{ minHeight: 72 }} value={homeProgram} onChange={(e) => setHomeProgram(e.target.value)} maxLength={5000} />}
            </Field>
          </>
        ) : therapistId ? (
          <p className="small muted">Aktivitas dan PR ditulis oleh terapis yang menangani lewat menu Absen.</p>
        ) : null}
        <ErrorBox error={error} />
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Batal
          </button>
          <button className="btn" disabled={busy || !patient || (!row?.serviceId && !serviceId) || !therapistId}>
            {busy ? 'Menyimpan…' : 'Simpan absen'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
