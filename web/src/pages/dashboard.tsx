import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useApi } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { APPT_STATUS, formatDate, formatDateShort, formatNumber, formatRupiah, formatWeekday } from '../format.ts';
import { Badge, Empty, ErrorBox, Loading, Stat, StatStrip } from '../ui.tsx';

// Menit sejak tengah malam pada zona waktu organisasi; diperbarui tiap menit.
function useNowMinutes(timeZone = 'Asia/Jakarta') {
  const read = () => {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    return get('hour') * 60 + get('minute');
  };
  const [now, setNow] = useState(read);
  useEffect(() => {
    const id = setInterval(() => setNow(read()), 60_000);
    return () => clearInterval(id);
  }, [timeZone]);
  return now;
}

function greeting(minutes: number) {
  if (minutes < 11 * 60) return 'Selamat pagi';
  if (minutes < 15 * 60) return 'Selamat siang';
  if (minutes < 18 * 60) return 'Selamat sore';
  return 'Selamat malam';
}

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const clock = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
// Status selain "terjadwal" ditulis di blok agar tidak hanya dibedakan lewat warna.
const SHORT_STATUS: Record<string, string> = { selesai: 'Selesai', tidak_hadir: 'Tidak hadir', dibatalkan: 'Batal' };

// Papan waktu hari ini: satu baris per terapis, blok per sesi, bintang jingga = sekarang.
function DayBoard({ appts, now, linkPatients }: { appts: any[]; now: number; linkPatients: boolean }) {
  const starts = appts.map((a) => toMinutes(a.localTime));
  const ends = appts.map((a, i) => starts[i] + a.durationMinutes);
  const from = Math.min(8, ...starts.map((m) => Math.floor(m / 60))) * 60;
  const to = Math.max(17, ...ends.map((m) => Math.ceil(m / 60))) * 60;
  const span = to - from;
  const pct = (m: number) => `${((m - from) / span) * 100}%`;

  const lanes = new Map<string, any[]>();
  for (const a of appts) lanes.set(a.therapistName, [...(lanes.get(a.therapistName) ?? []), a]);
  const hours = Array.from({ length: span / 60 + 1 }, (_, i) => from / 60 + i);

  return (
    <div className="daybar" style={{ ['--hours' as string]: span / 60 }}>
      <div className="daybar-inner">
        <div className="daybar-row daybar-head" aria-hidden="true">
          <div className="daybar-label" />
          <div className="daybar-hours">
            {hours.map((h) => (
              <span key={h} style={{ left: pct(h * 60) }}>
                {String(h).padStart(2, '0')}
              </span>
            ))}
          </div>
        </div>
        {[...lanes].map(([therapist, items]) => (
          <div className="daybar-row" key={therapist}>
            <div className="daybar-label">
              <strong title={therapist}>{therapist}</strong>
              <span>{items.length} sesi</span>
            </div>
            <div className="daybar-track">
              {items.map((a) => {
                const start = toMinutes(a.localTime);
                const status = APPT_STATUS[a.status]?.label ?? a.status;
                const label = `${a.localTime}, ${a.patientName ?? 'Pasien'}, ${a.serviceName ?? 'sesi terapi'}, ${status}`;
                const style = { left: pct(start), width: `calc(${(a.durationMinutes / span) * 100}% - 4px)` };
                const body = (
                  <>
                    <strong>{a.patientName ?? 'Pasien'}</strong>
                    <span>
                      {a.localTime}
                      {SHORT_STATUS[a.status] ? `, ${SHORT_STATUS[a.status]}` : ''}
                    </span>
                  </>
                );
                // Pasien di luar cakupan peran tidak bernama (disembunyikan RLS), jadi tidak ditautkan.
                return linkPatients && a.patientName ? (
                  <Link key={a.id} to={`/pasien/${a.patientId}`} className={`daybar-block ${a.status}`} style={style} aria-label={label} title={label}>
                    {body}
                  </Link>
                ) : (
                  <div key={a.id} className={`daybar-block ${a.status}`} style={style} aria-label={label} title={label}>
                    {body}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        {now >= from && now <= to ? (
          <div className="daybar-now-layer" aria-hidden="true">
            <span className="daybar-now-label" style={{ left: pct(now) }}>
              {clock(now)}
            </span>
            <div className="daybar-now" style={{ left: pct(now) }} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function DashboardPage() {
  const { me, can } = useAuth();
  const tz = me?.organization?.timezone;
  const now = useNowMinutes(tz);
  const { data, error, loading } = useApi<any>('/dashboard');
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;

  const appts: any[] = data.todayAppointments ?? [];
  const done = appts.filter((a) => a.status === 'selesai').length;
  const scheduled = appts.filter((a) => a.status === 'terjadwal').length;
  // Catatan sesi wajib final paling lambat akhir bulan sesi.
  const due = data.notesDue;
  const daysLeft = due ? Math.round((Date.parse(due.monthDeadline) - Date.parse(data.today)) / 86_400_000) : null;
  const dueThisMonth = due ? due.pending - due.overdue : 0;

  return (
    <>
      <div className="hello">
        <div>
          <p className="hello-date">{formatWeekday(data.today)}</p>
          <h1>
            {greeting(now)}, {me?.user.fullName.split(' ')[0]}
          </h1>
        </div>
        {data.todayAppointments ? (
          <Link className="btn btn-secondary" to="/jadwal">
            Buka jadwal
          </Link>
        ) : null}
      </div>

      {due?.overdue > 0 ? (
        <div className="alert error" style={{ marginBottom: 18 }}>
          {due.overdue} catatan sesi melewati batas akhir bulan dan belum final. Segera lengkapi di daftar <em>Catatan sesi belum final</em>.
        </div>
      ) : null}
      {dueThisMonth > 0 && daysLeft !== null && daysLeft <= 3 ? (
        <div className="alert warn" style={{ marginBottom: 18 }}>
          Batas catatan bulan ini {daysLeft === 0 ? 'hari ini' : `tinggal ${daysLeft} hari`} ({formatDate(due.monthDeadline)}). Masih ada {dueThisMonth} sesi yang
          catatannya belum final.
        </div>
      ) : null}

      {data.todayAppointments ? (
        <section className="card" style={{ marginBottom: 18 }}>
          <div className="card-head">
            <h2>Jadwal hari ini</h2>
            {appts.length ? (
              <div className="legend only-wide" aria-hidden="true">
                <span>
                  <i />
                  Terjadwal
                </span>
                <span>
                  <i className="selesai" />
                  Selesai
                </span>
                <span>
                  <i className="tidak_hadir" />
                  Tidak hadir
                </span>
                <span>
                  <i className="dibatalkan" />
                  Dibatalkan
                </span>
              </div>
            ) : null}
          </div>
          {appts.length === 0 ? (
            <Empty title="Belum ada jadwal hari ini">
              {can('schedule.manage') ? (
                <p style={{ marginTop: 8 }}>
                  <Link to="/jadwal">Buat jadwal</Link>
                </p>
              ) : null}
            </Empty>
          ) : (
            <>
              <div className="only-wide">
                <DayBoard appts={appts} now={now} linkPatients={can('patient.read', 'patient.read.assigned')} />
              </div>
              <div className="only-narrow">
                {appts.map((a) => (
                  <div className="appt" key={a.id}>
                    <div className="time">
                      {a.localTime}
                      <small>{a.durationMinutes} mnt</small>
                    </div>
                    <div className="who">
                      <strong>{a.patientName ?? 'Pasien'}</strong>
                      <span>
                        {a.serviceName ?? 'Sesi terapi'}, {a.therapistName}
                      </span>
                      <div style={{ marginTop: 6 }}>
                        <Badge tone={APPT_STATUS[a.status]?.tone}>{APPT_STATUS[a.status]?.label}</Badge>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      ) : null}

      <div style={{ marginBottom: 18 }}>
        <StatStrip>
          {data.todayAppointments ? <Stat label="Jadwal hari ini" value={formatNumber(appts.length)} hint={`${done} selesai, ${scheduled} belum`} /> : null}
          {data.monthSessions ? <Stat label="Sesi selesai bulan ini" value={formatNumber(data.monthSessions.completed)} hint={`${data.monthSessions.noShow} tidak hadir`} /> : null}
          {data.activePatients !== undefined ? <Stat label="Pasien aktif" value={formatNumber(data.activePatients)} /> : null}
          {data.payments ? <Stat label="Penerimaan bulan ini" value={formatRupiah(data.payments.month)} hint={`Hari ini ${formatRupiah(data.payments.today)}, basis kas`} /> : null}
          {data.myCompensation ? <Stat label="Honor bulan ini (belum dibayar)" value={formatRupiah(data.myCompensation.unpaid)} hint={`${data.myCompensation.sessions} sesi`} /> : null}
          {data.activeStaff !== undefined && !data.payments ? <Stat label="Staf aktif" value={formatNumber(data.activeStaff)} /> : null}
        </StatStrip>
      </div>

      {data.support?.pending > 0 ? (
        <div className="alert warn" style={{ marginBottom: 18 }}>
          Ada {data.support.pending} permintaan akses dukungan teknis yang menunggu keputusan Anda. <Link to="/dukungan">Tinjau sekarang</Link>
        </div>
      ) : null}

      <div className="grid grid-2">
        {data.pendingNotes ? (
          <section className="card">
            <div className="card-head">
              <div>
                <h2>Catatan sesi belum final</h2>
                <p className="small muted">Wajib final paling lambat akhir bulan sesi.</p>
              </div>
              <Badge tone={due?.overdue ? 'danger' : due?.pending ? 'warn' : 'ok'}>{formatNumber(due?.pending ?? data.pendingNotes.length)}</Badge>
            </div>
            {data.pendingNotes.length === 0 ? (
              <Empty title="Semua catatan sudah lengkap" />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <tbody>
                    {data.pendingNotes.map((n: any) => (
                      <tr key={n.appointmentId}>
                        <td>
                          <strong>{n.patientName}</strong>
                          <div className="small muted">
                            {n.sessionAt}, {n.therapistName}
                          </div>
                          <div style={{ marginTop: 4 }}>
                            {n.overdue ? <Badge tone="danger">Lewat batas {formatDateShort(n.deadline)}</Badge> : <span className="small muted">Batas {formatDateShort(n.deadline)}</span>}
                          </div>
                        </td>
                        <td className="num">
                          {can('therapy.note.write') && n.therapistMemberId === me?.membership?.id ? (
                            <Link
                              className="btn btn-sm btn-secondary"
                              to={n.noteId ? `/catatan/${n.noteId}` : `/catatan/baru?patientId=${n.patientId}&appointmentId=${n.appointmentId}`}
                            >
                              {n.noteId ? 'Lanjutkan draf' : 'Tulis catatan'}
                            </Link>
                          ) : (
                            <Badge tone="warn">{n.noteId ? 'Draf' : 'Belum ada'}</Badge>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {due && due.pending > data.pendingNotes.length ? (
                  <p className="small muted" style={{ padding: '10px 16px' }}>
                    Menampilkan {data.pendingNotes.length} sesi terlama dari {formatNumber(due.pending)}.
                  </p>
                ) : null}
              </div>
            )}
          </section>
        ) : null}

        {data.lowPackages ? (
          <section className="card">
            <div className="card-head">
              <h2>Paket hampir habis atau berakhir</h2>
            </div>
            {data.lowPackages.length === 0 ? (
              <Empty title="Tidak ada paket yang perlu diperhatikan" />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <tbody>
                    {data.lowPackages.map((p: any) => (
                      <tr key={p.id}>
                        <td>
                          <Link to={`/pasien/${p.patientId}`}>{p.patientName}</Link>
                          <div className="small muted">{p.name}</div>
                        </td>
                        <td className="num">
                          <Badge tone={p.sessionsRemaining <= 1 ? 'danger' : 'warn'}>Sisa {p.sessionsRemaining} sesi</Badge>
                          {p.expiresOn ? <div className="small muted">s.d. {formatDate(p.expiresOn)}</div> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        ) : null}
      </div>
    </>
  );
}
