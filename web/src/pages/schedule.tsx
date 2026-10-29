import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { get, post, qs, useApi } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { addDays, APPT_STATUS, BILLING, formatRupiah, formatWeekday, todayIn } from '../format.ts';
import { Badge, Dialog, Empty, ErrorBox, Field, Icon, Loading, MoneyInput, PageHeader, ReasonDialog, useSubmit, useToast } from '../ui.tsx';
import { searchPatients } from './patients.tsx';

export function SchedulePage() {
  const { me, can } = useAuth();
  const tz = me?.organization?.timezone;
  const [date, setDate] = useState(() => todayIn(tz));
  const [view, setView] = useState<'hari' | 'minggu'>('hari');
  const [therapistId, setTherapistId] = useState('');
  const [creating, setCreating] = useState(false);
  const { data: therapists } = useApi<any[]>(can('schedule.read') ? '/staff/therapists' : null);

  const to = view === 'hari' ? date : addDays(date, 6);
  const { data, error, loading, reload } = useApi<any[]>(`/appointments${qs({ from: date, to, therapistId })}`);

  const byDay = useMemo(() => {
    const groups = new Map<string, any[]>();
    for (const a of data ?? []) {
      if (a.status === 'dijadwal_ulang') continue;
      groups.set(a.localDate, [...(groups.get(a.localDate) ?? []), a]);
    }
    return [...groups.entries()];
  }, [data]);

  return (
    <>
      <PageHeader
        title="Jadwal & Sesi"
        subtitle={can('schedule.read') ? 'Semua jadwal organisasi' : 'Jadwal sesi yang Anda tangani'}
        actions={
          can('schedule.manage') ? (
            <button className="btn" onClick={() => setCreating(true)}>
              <Icon name="plus" /> Buat jadwal
            </button>
          ) : null
        }
      />
      <div className="card">
        <div className="card-head">
          <div className="row">
            <button className="btn btn-sm btn-secondary" onClick={() => setDate(addDays(date, view === 'hari' ? -1 : -7))} aria-label="Sebelumnya">
              ‹
            </button>
            <input className="input" type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} style={{ width: 'auto' }} aria-label="Tanggal" />
            <button className="btn btn-sm btn-secondary" onClick={() => setDate(addDays(date, view === 'hari' ? 1 : 7))} aria-label="Berikutnya">
              ›
            </button>
            <button className="btn btn-sm btn-ghost" onClick={() => setDate(todayIn(tz))}>
              Hari ini
            </button>
          </div>
          <div className="row">
            <select className="select" style={{ width: 'auto' }} value={view} onChange={(e) => setView(e.target.value as 'hari' | 'minggu')} aria-label="Tampilan">
              <option value="hari">Per hari</option>
              <option value="minggu">7 hari</option>
            </select>
            {therapists ? (
              <select className="select" style={{ width: 'auto' }} value={therapistId} onChange={(e) => setTherapistId(e.target.value)} aria-label="Terapis">
                <option value="">Semua terapis</option>
                {therapists.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.fullName}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
        </div>
        {loading && !data ? <Loading /> : null}
        <ErrorBox error={error} />
        {data && byDay.length === 0 ? <Empty title="Tidak ada jadwal pada periode ini" /> : null}
        {byDay.map(([day, items]) => (
          <div key={day}>
            <div className="day-head">
              {formatWeekday(day)} · {items.length} jadwal
            </div>
            {items.map((a) => (
              <AppointmentRow key={a.id} a={a} onChanged={reload} />
            ))}
          </div>
        ))}
      </div>
      {creating ? <AppointmentDialog presetDate={date} onClose={() => setCreating(false)} onSaved={reload} /> : null}
    </>
  );
}

function AppointmentRow({ a, onChanged }: { a: any; onChanged: () => void }) {
  const { can, me } = useAuth();
  const toast = useToast();
  const [dialog, setDialog] = useState<null | 'cancel' | 'reopen' | 'reschedule'>(null);
  const [busy, setBusy] = useState(false);
  const own = a.therapistMemberId === me?.membership?.id;
  const canRecord = can('session.complete') || (can('session.complete.own') && own);

  const act = async (path: string, message: string) => {
    setBusy(true);
    try {
      const r = await post<any>(`/appointments/${a.id}/${path}`);
      toast(r?.sessionsRemaining !== null && r?.sessionsRemaining !== undefined ? `${message}. Sisa paket: ${r.sessionsRemaining} sesi` : message);
      onChanged();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="appt">
      <div className="time">
        {a.localTime}
        <small>{a.durationMinutes} mnt</small>
      </div>
      <div className="who">
        <strong>
          {a.patientId && can('patient.read', 'patient.read.assigned') ? <Link to={`/pasien/${a.patientId}`}>{a.patientName}</Link> : (a.patientName ?? 'Pasien')}
        </strong>
        <span>
          {a.serviceName ?? 'Sesi terapi'} · {a.therapistName} · {BILLING[a.billing]}
          {a.packageName ? ` (${a.packageName})` : ''}
          {a.billing === 'per_sesi' && a.price ? ` · ${formatRupiah(a.price)}` : ''}
        </span>
        <div className="row" style={{ marginTop: 6 }}>
          <Badge tone={APPT_STATUS[a.status]?.tone}>{APPT_STATUS[a.status]?.label}</Badge>
          {a.cancelReason ? <span className="small muted">{a.cancelReason}</span> : null}
          {a.status === 'selesai' && a.noteStatus !== 'final' && can('therapy.note.read', 'therapy.note.read.assigned') ? (
            // Batas wajib catatan final: akhir bulan sesi.
            a.localDate.slice(0, 7) < todayIn(me?.organization?.timezone).slice(0, 7) ? (
              <Badge tone="danger">{a.noteId ? 'Catatan draf, lewat batas' : 'Belum ada catatan, lewat batas'}</Badge>
            ) : (
              <Badge tone="warn">{a.noteId ? 'Catatan masih draf' : 'Belum ada catatan'}</Badge>
            )
          ) : null}
        </div>
      </div>
      <div className="actions row">
        {a.status === 'terjadwal' && canRecord ? (
          <>
            <button className="btn btn-sm" disabled={busy} onClick={() => act('complete', 'Sesi ditandai selesai')}>
              <Icon name="check" /> Selesai
            </button>
            <button className="btn btn-sm btn-secondary" disabled={busy} onClick={() => confirm('Tandai pasien tidak hadir?') && act('no-show', 'Ditandai tidak hadir')}>
              Tidak hadir
            </button>
          </>
        ) : null}
        {a.status === 'terjadwal' && can('schedule.manage') ? (
          <>
            <button className="btn btn-sm btn-ghost" onClick={() => setDialog('reschedule')}>
              Jadwal ulang
            </button>
            <button className="btn btn-sm btn-ghost" onClick={() => setDialog('cancel')}>
              Batalkan
            </button>
          </>
        ) : null}
        {a.status === 'selesai' && can('therapy.note.write') && own ? (
          <Link className="btn btn-sm btn-secondary" to={a.noteId ? `/catatan/${a.noteId}` : `/catatan/baru?patientId=${a.patientId}&appointmentId=${a.id}`}>
            {a.noteId ? 'Catatan' : 'Tulis catatan'}
          </Link>
        ) : a.noteId && can('therapy.note.read', 'therapy.note.read.assigned') ? (
          <Link className="btn btn-sm btn-ghost" to={`/catatan/${a.noteId}`}>
            Lihat catatan
          </Link>
        ) : null}
        {(a.status === 'selesai' || a.status === 'tidak_hadir') && can('session.reopen') ? (
          <button className="btn btn-sm btn-ghost" onClick={() => setDialog('reopen')}>
            Koreksi
          </button>
        ) : null}
      </div>
      {dialog === 'cancel' ? (
        <ReasonDialog
          title="Batalkan jadwal"
          minLength={3}
          description="Pembatalan tidak memotong saldo paket."
          confirmLabel="Batalkan jadwal"
          danger
          onClose={() => setDialog(null)}
          onConfirm={async (reason) => {
            await post(`/appointments/${a.id}/cancel`, { reason });
            toast('Jadwal dibatalkan');
            onChanged();
          }}
        />
      ) : null}
      {dialog === 'reopen' ? (
        <ReasonDialog
          title="Koreksi status sesi"
          description="Sesi dikembalikan ke status terjadwal. Pemakaian paket dikembalikan dan honor yang belum dibayar dibatalkan. Semua tercatat di riwayat."
          confirmLabel="Kembalikan ke terjadwal"
          onClose={() => setDialog(null)}
          onConfirm={async (reason) => {
            await post(`/appointments/${a.id}/reopen`, { reason });
            toast('Status sesi dikoreksi');
            onChanged();
          }}
        />
      ) : null}
      {dialog === 'reschedule' ? <RescheduleDialog a={a} onClose={() => setDialog(null)} onSaved={onChanged} /> : null}
    </div>
  );
}

function RescheduleDialog({ a, onClose, onSaved }: { a: any; onClose: () => void; onSaved: () => void }) {
  const { data: therapists } = useApi<any[]>('/staff/therapists');
  const [date, setDate] = useState(a.localDate);
  const [time, setTime] = useState(a.localTime);
  const [therapist, setTherapist] = useState(a.therapistMemberId);
  const toast = useToast();
  const { busy, error, submit } = useSubmit(
    () => post(`/appointments/${a.id}/reschedule`, { date, time, ...(therapist !== a.therapistMemberId ? { therapistMemberId: therapist } : {}) }),
    () => {
      toast('Jadwal dipindahkan');
      onSaved();
      onClose();
    },
  );
  return (
    <Dialog title={`Jadwal ulang — ${a.patientName ?? ''}`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="form-grid">
          <Field label="Tanggal baru">{(id) => <input id={id} className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />}</Field>
          <Field label="Jam">{(id) => <input id={id} className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} required />}</Field>
          <Field label="Terapis" full>
            {(id) => (
              <select id={id} className="select" value={therapist} onChange={(e) => setTherapist(e.target.value)}>
                {therapists?.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.fullName}
                  </option>
                ))}
              </select>
            )}
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

export function PatientPicker({ value, onChange }: { value: any | null; onChange: (p: any | null) => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<any[]>([]);
  useEffect(() => {
    if (value || q.trim().length < 2) {
      setResults([]);
      return;
    }
    const t = setTimeout(() => searchPatients(q.trim()).then(setResults, () => setResults([])), 250);
    return () => clearTimeout(t);
  }, [q, value]);
  if (value) {
    return (
      <div className="spread input" style={{ display: 'flex' }}>
        <span>
          <strong>{value.fullName}</strong> <span className="muted mono">{value.patientCode}</span>
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
        <input className="input" placeholder="Ketik minimal 2 huruf nama/kode pasien" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Cari pasien" />
      </div>
      {results.length ? (
        <div className="card" style={{ marginTop: 6, maxHeight: 220, overflowY: 'auto' }}>
          {results.map((p) => (
            <button
              key={p.id}
              type="button"
              className="btn btn-ghost"
              style={{ width: '100%', justifyContent: 'flex-start', borderRadius: 0, color: 'var(--c-ink)' }}
              onClick={() => onChange(p)}
            >
              {p.fullName} <span className="muted mono">{p.patientCode}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function AppointmentDialog({ presetPatient, presetDate, onClose, onSaved }: { presetPatient?: any; presetDate?: string; onClose: () => void; onSaved: () => void }) {
  const { me } = useAuth();
  const toast = useToast();
  const [patient, setPatient] = useState<any | null>(presetPatient ?? null);
  const { data: therapists } = useApi<any[]>('/staff/therapists');
  const { data: services } = useApi<any[]>('/services');
  const [packages, setPackages] = useState<any[]>([]);
  const [f, setF] = useState({
    therapistMemberId: '',
    serviceId: '',
    date: presetDate ?? todayIn(me?.organization?.timezone),
    time: '09:00',
    durationMinutes: 60,
    billing: 'per_sesi',
    patientPackageId: '',
    price: '' as number | '',
    repeatWeeks: 1,
    adminNotes: '',
  });
  const activeServices = services?.filter((s) => s.active) ?? [];

  useEffect(() => {
    if (!patient) return setPackages([]);
    get<any[]>(`/patients/${patient.id}/packages`).then(
      (rows) => setPackages(rows.filter((p) => p.status === 'aktif' && p.sessionsRemaining > 0 && !p.expired)),
      () => setPackages([]),
    );
  }, [patient]);

  const chooseService = (id: string) => {
    const s = activeServices.find((x) => x.id === id);
    setF({ ...f, serviceId: id, durationMinutes: s?.defaultDurationMinutes ?? f.durationMinutes, price: s ? s.defaultPrice : f.price });
  };

  const { busy, error, submit } = useSubmit(
    () =>
      post('/appointments', {
        patientId: patient?.id,
        therapistMemberId: f.therapistMemberId,
        serviceId: f.serviceId || null,
        date: f.date,
        time: f.time,
        durationMinutes: Number(f.durationMinutes),
        billing: f.billing,
        patientPackageId: f.billing === 'paket' ? f.patientPackageId : null,
        ...(f.billing === 'per_sesi' && f.price !== '' ? { price: f.price } : {}),
        repeatWeeks: Number(f.repeatWeeks),
        adminNotes: f.adminNotes || null,
      }),
    () => {
      toast(f.repeatWeeks > 1 ? `${f.repeatWeeks} jadwal dibuat` : 'Jadwal dibuat');
      onSaved();
      onClose();
    },
  );

  return (
    <Dialog title="Buat jadwal sesi" onClose={onClose} wide>
      <form className="form" onSubmit={submit}>
        <div className="form-grid">
          <div className="field full">
            <span className="label">Pasien</span>
            {presetPatient ? (
              <div className="input">
                <strong>{presetPatient.fullName}</strong> <span className="muted mono">{presetPatient.patientCode}</span>
              </div>
            ) : (
              <PatientPicker value={patient} onChange={setPatient} />
            )}
          </div>
          <Field label="Terapis">
            {(id) => (
              <select id={id} className="select" value={f.therapistMemberId} onChange={(e) => setF({ ...f, therapistMemberId: e.target.value })} required>
                <option value="">Pilih terapis…</option>
                {therapists?.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.fullName}
                    {t.specialization ? ` — ${t.specialization}` : ''}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Layanan">
            {(id) => (
              <select id={id} className="select" value={f.serviceId} onChange={(e) => chooseService(e.target.value)}>
                <option value="">Tanpa layanan khusus</option>
                {activeServices.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Tanggal">{(id) => <input id={id} className="input" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} required />}</Field>
          <Field label="Jam mulai">{(id) => <input id={id} className="input" type="time" value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} required />}</Field>
          <Field label="Durasi (menit)">
            {(id) => (
              <input id={id} className="input" type="number" min={5} max={480} step={5} value={f.durationMinutes} onChange={(e) => setF({ ...f, durationMinutes: Number(e.target.value) })} required />
            )}
          </Field>
          <Field label="Ulangi setiap minggu" hint="Jumlah pertemuan, termasuk tanggal ini">
            {(id) => (
              <select id={id} className="select" value={f.repeatWeeks} onChange={(e) => setF({ ...f, repeatWeeks: Number(e.target.value) })}>
                {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n === 1 ? 'Sekali' : `${n} kali`}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <div className="field full">
            <span className="label">Tagihan</span>
            <div className="row">
              {(['paket', 'per_sesi', 'tanpa_biaya'] as const).map((b) => (
                <label key={b} className="check" style={{ marginRight: 12 }}>
                  <input type="radio" name="billing" checked={f.billing === b} onChange={() => setF({ ...f, billing: b })} /> {BILLING[b]}
                </label>
              ))}
            </div>
          </div>
          {f.billing === 'paket' ? (
            <Field label="Paket yang dipakai" full hint="Saldo dipotong saat sesi ditandai selesai">
              {(id) => (
                <select id={id} className="select" value={f.patientPackageId} onChange={(e) => setF({ ...f, patientPackageId: e.target.value })} required>
                  <option value="">{patient ? (packages.length ? 'Pilih paket…' : 'Pasien belum memiliki paket aktif') : 'Pilih pasien dahulu'}</option>
                  {packages.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} — sisa {p.sessionsRemaining} sesi
                    </option>
                  ))}
                </select>
              )}
            </Field>
          ) : null}
          {f.billing === 'per_sesi' ? (
            <Field label="Tarif sesi (Rp)">{(id) => <MoneyInput id={id} value={f.price} onChange={(v) => setF({ ...f, price: v })} />}</Field>
          ) : null}
          <Field label="Catatan administrasi" full>
            {(id) => <input id={id} className="input" value={f.adminNotes} onChange={(e) => setF({ ...f, adminNotes: e.target.value })} maxLength={1000} placeholder="Opsional, non-klinis" />}
          </Field>
        </div>
        <ErrorBox error={error} />
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Batal
          </button>
          <button className="btn" disabled={busy || !patient}>
            {busy ? 'Menyimpan…' : 'Simpan jadwal'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
