import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, del, downloadUrl, get, patch, post, put, qs, useApi } from '../api.ts';
import { useAuth } from '../auth.tsx';
import {
  ageLabel,
  APPT_STATUS,
  BILLING,
  formatDate,
  formatBytes,
  formatDateTime,
  formatRupiah,
  METHOD,
  NOTE_TYPE,
  PACKAGE_STATUS,
  PATIENT_STATUS,
  todayIn,
} from '../format.ts';
import { Badge, Dialog, Empty, ErrorBox, Field, Icon, Loading, PageHeader, ReasonDialog, Tabs, useSubmit, useToast } from '../ui.tsx';
import { AppointmentDialog } from './schedule.tsx';
import { InvoiceCreateDialog } from './billing.tsx';
import { PaymentDialog } from './finance.tsx';
import { PatientPrivacyPanel } from './privacy.tsx';
import { ProgramsTab } from './programs.tsx';

// ---------------------------------------------------------------------------
// Daftar pasien
// ---------------------------------------------------------------------------
export function PatientsPage() {
  const { can, me } = useAuth();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState('aktif');
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  const { data, error, loading } = useApi<{ total: number; items: any[] }>(`/patients${qs({ q: debounced, status, limit: 100 })}`);
  const today = todayIn(me?.organization?.timezone);

  return (
    <>
      <PageHeader
        title="Pasien"
        subtitle={can('patient.read') ? 'Data pasien organisasi Anda' : 'Pasien yang ditugaskan kepada Anda'}
        actions={
          can('patient.manage') ? (
            <button className="btn" onClick={() => setCreating(true)}>
              <Icon name="plus" /> Pasien baru
            </button>
          ) : null
        }
      />
      <div className="card">
        <div className="card-head">
          <div className="search" style={{ flex: '1 1 280px' }}>
            <Icon name="search" />
            <input className="input" placeholder="Cari nama, panggilan, atau kode pasien" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Cari pasien" />
          </div>
          <select className="select" style={{ width: 'auto' }} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status pasien">
            <option value="">Semua status</option>
            <option value="aktif">Aktif</option>
            <option value="nonaktif">Nonaktif</option>
            <option value="selesai">Selesai program</option>
          </select>
        </div>
        {loading && !data ? <Loading /> : null}
        <ErrorBox error={error} />
        {data && data.items.length === 0 ? <Empty title="Belum ada pasien">{debounced ? 'Tidak ada yang cocok dengan pencarian.' : null}</Empty> : null}
        {data && data.items.length > 0 ? (
          <div className="table-wrap">
            <table className="table responsive">
              <thead>
                <tr>
                  <th>Kode</th>
                  <th>Nama</th>
                  <th>Usia</th>
                  <th>Wali utama</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((p) => (
                  <tr key={p.id} className="clickable" onClick={() => navigate(`/pasien/${p.id}`)}>
                    <td data-label="Kode" className="mono">
                      {p.patientCode}
                    </td>
                    <td data-label="Nama">
                      <Link to={`/pasien/${p.id}`} onClick={(e) => e.stopPropagation()}>
                        <strong>{p.fullName}</strong>
                      </Link>
                      {p.nickname ? <span className="muted"> ({p.nickname})</span> : null}
                    </td>
                    <td data-label="Usia">{ageLabel(p.birthDate, today)}</td>
                    <td data-label="Wali utama">{p.guardianName ?? '—'}</td>
                    <td data-label="Status">
                      <Badge tone={PATIENT_STATUS[p.status]?.tone}>{PATIENT_STATUS[p.status]?.label}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {data && data.total > data.items.length ? <p className="small muted card-body">Menampilkan {data.items.length} dari {data.total}. Persempit pencarian.</p> : null}
      </div>
      {creating ? <PatientDialog onClose={() => setCreating(false)} onSaved={(id) => navigate(`/pasien/${id}`)} /> : null}
    </>
  );
}

const emptyPatient = { fullName: '', nickname: '', birthDate: '', sex: '', registeredOn: '', address: '', adminNotes: '', status: 'aktif' };

function PatientDialog({ initial, onClose, onSaved }: { initial?: any; onClose: () => void; onSaved: (id: string) => void }) {
  const editing = Boolean(initial);
  const [f, setF] = useState(() => (initial ? { ...emptyPatient, ...Object.fromEntries(Object.entries(initial).map(([k, v]) => [k, v ?? ''])) } : emptyPatient));
  const [g, setG] = useState({ fullName: '', relationship: 'Ibu', phone: '' });
  const toast = useToast();
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });

  const { busy, error, submit } = useSubmit(
    async () => {
      const body: Record<string, unknown> = {
        fullName: f.fullName,
        nickname: f.nickname || null,
        birthDate: f.birthDate || null,
        sex: f.sex || null,
        address: f.address || null,
        adminNotes: f.adminNotes || null,
        ...(f.registeredOn ? { registeredOn: f.registeredOn } : {}),
      };
      if (editing) {
        await patch(`/patients/${initial.id}`, { ...body, status: f.status });
        return initial.id as string;
      }
      if (g.fullName.trim()) body.guardians = [{ ...g, phone: g.phone || null, isPrimary: true }];
      const r = await post<{ id: string }>('/patients', body);
      return r.id;
    },
    (id) => {
      toast(editing ? 'Data pasien diperbarui' : 'Pasien terdaftar');
      onSaved(id);
      onClose();
    },
  );

  return (
    <Dialog title={editing ? 'Ubah data pasien' : 'Pendaftaran pasien baru'} onClose={onClose} wide>
      <form className="form" onSubmit={submit}>
        <p className="small muted">Kumpulkan hanya data yang diperlukan untuk layanan. Informasi klinis dicatat di catatan terapi, bukan di sini.</p>
        <div className="form-grid">
          <Field label="Nama lengkap anak" full>
            {(id) => <input id={id} className="input" value={f.fullName} onChange={set('fullName')} required minLength={2} maxLength={150} />}
          </Field>
          <Field label="Nama panggilan">{(id) => <input id={id} className="input" value={f.nickname} onChange={set('nickname')} maxLength={60} />}</Field>
          <Field label="Tanggal lahir">{(id) => <input id={id} className="input" type="date" value={f.birthDate} onChange={set('birthDate')} />}</Field>
          <Field label="Jenis kelamin">
            {(id) => (
              <select id={id} className="select" value={f.sex} onChange={set('sex')}>
                <option value="">—</option>
                <option value="L">Laki-laki</option>
                <option value="P">Perempuan</option>
              </select>
            )}
          </Field>
          <Field label="Tanggal pendaftaran" hint="Kosongkan untuk hari ini">
            {(id) => <input id={id} className="input" type="date" value={f.registeredOn} onChange={set('registeredOn')} />}
          </Field>
          {editing ? (
            <Field label="Status">
              {(id) => (
                <select id={id} className="select" value={f.status} onChange={set('status')}>
                  <option value="aktif">Aktif</option>
                  <option value="nonaktif">Nonaktif</option>
                  <option value="selesai">Selesai program</option>
                </select>
              )}
            </Field>
          ) : null}
          <Field label="Alamat" full>
            {(id) => <textarea id={id} className="textarea" style={{ minHeight: 64 }} value={f.address} onChange={set('address')} maxLength={500} />}
          </Field>
          <Field label="Catatan administrasi" hint="Non-klinis, mis. preferensi jadwal" full>
            {(id) => <textarea id={id} className="textarea" style={{ minHeight: 64 }} value={f.adminNotes} onChange={set('adminNotes')} maxLength={2000} />}
          </Field>
        </div>
        {!editing ? (
          <>
            <h3>Wali utama</h3>
            <div className="form-grid">
              <Field label="Nama wali">{(id) => <input id={id} className="input" value={g.fullName} onChange={(e) => setG({ ...g, fullName: e.target.value })} />}</Field>
              <Field label="Hubungan">
                {(id) => (
                  <select id={id} className="select" value={g.relationship} onChange={(e) => setG({ ...g, relationship: e.target.value })}>
                    {['Ibu', 'Ayah', 'Wali', 'Kakek/Nenek', 'Lainnya'].map((r) => (
                      <option key={r}>{r}</option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label="Nomor telepon / WhatsApp">
                {(id) => <input id={id} className="input" inputMode="tel" value={g.phone} onChange={(e) => setG({ ...g, phone: e.target.value })} maxLength={40} />}
              </Field>
            </div>
          </>
        ) : null}
        <ErrorBox error={error} />
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Batal
          </button>
          <button className="btn" disabled={busy}>
            {busy ? 'Menyimpan…' : 'Simpan'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Detail pasien
// ---------------------------------------------------------------------------
type Tab = 'profil' | 'jadwal' | 'catatan' | 'program' | 'paket' | 'bayar' | 'dokumen';

export function PatientDetailPage() {
  const { id = '' } = useParams();
  const { can, me } = useAuth();
  const { data: p, error, loading, reload } = useApi<any>(`/patients/${id}`);
  const [editing, setEditing] = useState(false);

  const tabs = useMemo(() => {
    const t: { value: Tab; label: string }[] = [{ value: 'profil', label: 'Profil & wali' }];
    if (can('schedule.read', 'schedule.read.own')) t.push({ value: 'jadwal', label: 'Jadwal' });
    if (can('therapy.note.read', 'therapy.note.read.assigned')) t.push({ value: 'catatan', label: 'Catatan terapi' }, { value: 'program', label: 'Program terapi' });
    if (can('package.read')) t.push({ value: 'paket', label: 'Paket' });
    if (can('payment.read')) t.push({ value: 'bayar', label: 'Pembayaran' });
    if (can('document.read')) t.push({ value: 'dokumen', label: 'Dokumen' });
    return t;
  }, [can]);
  const [tab, setTab] = useState<Tab>('profil');

  if (loading && !p) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!p) return null;
  const today = todayIn(me?.organization?.timezone);

  return (
    <>
      <PageHeader
        back={{ to: '/pasien', label: 'Daftar pasien' }}
        title={
          <span className="row">
            {p.fullName} <Badge tone={PATIENT_STATUS[p.status]?.tone}>{PATIENT_STATUS[p.status]?.label}</Badge>
          </span>
        }
        subtitle={`${p.patientCode} · ${ageLabel(p.birthDate, today)}${p.nickname ? ` · dipanggil "${p.nickname}"` : ''}`}
        actions={
          can('patient.manage') ? (
            <button className="btn btn-secondary" onClick={() => setEditing(true)}>
              Ubah data
            </button>
          ) : null
        }
      />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'profil' ? <ProfileTab patient={p} reload={reload} /> : null}
      {tab === 'jadwal' ? <AppointmentsTab patient={p} /> : null}
      {tab === 'catatan' ? <NotesTab patient={p} /> : null}
      {tab === 'program' ? <ProgramsTab patient={p} /> : null}
      {tab === 'paket' ? <PackagesTab patient={p} /> : null}
      {tab === 'bayar' ? <PaymentsTab patient={p} /> : null}
      {tab === 'dokumen' ? <DocumentsTab patient={p} /> : null}
      {editing ? <PatientDialog initial={p} onClose={() => setEditing(false)} onSaved={() => reload()} /> : null}
    </>
  );
}

function ProfileTab({ patient: p, reload }: { patient: any; reload: () => void }) {
  const { can } = useAuth();
  const [guardian, setGuardian] = useState<any | null>(null);
  const [assigning, setAssigning] = useState(false);
  const toast = useToast();

  return (
    <div className="grid grid-2">
      <section className="card card-pad">
        <h2 style={{ marginBottom: 12 }}>Data administrasi</h2>
        <dl className="kv">
          <dt>Kode pasien</dt>
          <dd className="mono">{p.patientCode}</dd>
          <dt>Tanggal lahir</dt>
          <dd>{formatDate(p.birthDate)}</dd>
          <dt>Jenis kelamin</dt>
          <dd>{p.sex === 'L' ? 'Laki-laki' : p.sex === 'P' ? 'Perempuan' : '—'}</dd>
          <dt>Terdaftar</dt>
          <dd>{formatDate(p.registeredOn)}</dd>
          <dt>Alamat</dt>
          <dd>{p.address ?? '—'}</dd>
          <dt>Catatan admin</dt>
          <dd style={{ whiteSpace: 'pre-wrap' }}>{p.adminNotes ?? '—'}</dd>
        </dl>
      </section>
      <div className="stack">
        <section className="card">
          <div className="card-head">
            <h2>Wali</h2>
            {can('patient.manage') ? (
              <button className="btn btn-sm btn-secondary" onClick={() => setGuardian({})}>
                <Icon name="plus" /> Tambah wali
              </button>
            ) : null}
          </div>
          {p.guardians.length === 0 ? <Empty title="Belum ada data wali" /> : null}
          {p.guardians.map((g: any) => (
            <div key={g.id} className="card-body spread" style={{ borderBottom: '1px solid var(--c-border)' }}>
              <div>
                <strong>{g.fullName}</strong> {g.isPrimary ? <Badge tone="star">Utama</Badge> : null}
                <div className="small muted">
                  {g.relationship}
                  {g.phone ? ` · ${g.phone}` : ''}
                  {g.email ? ` · ${g.email}` : ''}
                </div>
                {g.waOptOut ? <div className="small muted">Menolak pengingat WhatsApp otomatis</div> : null}
              </div>
              {can('patient.manage') ? (
                <button className="btn btn-sm btn-ghost" onClick={() => setGuardian(g)}>
                  Ubah
                </button>
              ) : null}
            </div>
          ))}
        </section>
        <section className="card">
          <div className="card-head">
            <h2>Terapis yang ditugaskan</h2>
            {can('patient.assign') ? (
              <button className="btn btn-sm btn-secondary" onClick={() => setAssigning(true)}>
                Atur
              </button>
            ) : null}
          </div>
          <div className="card-body">
            {p.therapists.length === 0 ? (
              <p className="muted">Belum ada terapis. Terapis hanya dapat melihat pasien yang ditugaskan kepadanya.</p>
            ) : (
              <div className="row">
                {p.therapists.map((t: any) => (
                  <Badge key={t.id} tone={t.status === 'active' ? 'info' : ''}>
                    {t.fullName}
                    {t.specialization ? ` · ${t.specialization}` : ''}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
      {can('privacy.manage') ? (
        <div style={{ gridColumn: '1 / -1' }}>
          <PatientPrivacyPanel patient={p} onChanged={reload} />
        </div>
      ) : null}
      {guardian ? (
        <GuardianDialog
          patientId={p.id}
          guardian={guardian}
          onClose={() => setGuardian(null)}
          onSaved={() => {
            toast('Data wali disimpan');
            reload();
          }}
        />
      ) : null}
      {assigning ? <AssignDialog patient={p} onClose={() => setAssigning(false)} onSaved={reload} /> : null}
    </div>
  );
}

function GuardianDialog({ patientId, guardian, onClose, onSaved }: { patientId: string; guardian: any; onClose: () => void; onSaved: () => void }) {
  const editing = Boolean(guardian.id);
  const [f, setF] = useState({
    fullName: guardian.fullName ?? '',
    relationship: guardian.relationship ?? 'Ibu',
    phone: guardian.phone ?? '',
    email: guardian.email ?? '',
    address: guardian.address ?? '',
    isPrimary: Boolean(guardian.isPrimary),
    waOptOut: Boolean(guardian.waOptOut),
  });
  const { busy, error, submit } = useSubmit(
    async () => {
      const body = { ...f, phone: f.phone || null, email: f.email || null, address: f.address || null };
      return editing ? patch(`/guardians/${guardian.id}`, body) : post(`/patients/${patientId}/guardians`, body);
    },
    () => {
      onSaved();
      onClose();
    },
  );
  const remove = async () => {
    if (!confirm('Hapus data wali ini?')) return;
    await del(`/guardians/${guardian.id}`);
    onSaved();
    onClose();
  };
  return (
    <Dialog title={editing ? 'Ubah wali' : 'Tambah wali'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="form-grid">
          <Field label="Nama" full>
            {(id) => <input id={id} className="input" value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} required minLength={2} />}
          </Field>
          <Field label="Hubungan">{(id) => <input id={id} className="input" value={f.relationship} onChange={(e) => setF({ ...f, relationship: e.target.value })} required />}</Field>
          <Field label="Telepon / WhatsApp">{(id) => <input id={id} className="input" inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />}</Field>
          <Field label="Email" full>
            {(id) => <input id={id} className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />}
          </Field>
          <Field label="Alamat" full>
            {(id) => <input id={id} className="input" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} />}
          </Field>
        </div>
        <label className="check">
          <input type="checkbox" checked={f.isPrimary} onChange={(e) => setF({ ...f, isPrimary: e.target.checked })} /> Jadikan wali utama
        </label>
        <label className="check">
          <input type="checkbox" checked={f.waOptOut} onChange={(e) => setF({ ...f, waOptOut: e.target.checked })} /> Wali menolak pengingat WhatsApp otomatis
        </label>
        <ErrorBox error={error} />
        <div className="form-actions">
          {editing ? (
            <button type="button" className="btn btn-ghost" style={{ marginRight: 'auto', color: 'var(--c-danger)' }} onClick={remove}>
              Hapus
            </button>
          ) : null}
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

function AssignDialog({ patient, onClose, onSaved }: { patient: any; onClose: () => void; onSaved: () => void }) {
  const { data: therapists } = useApi<any[]>('/staff/therapists');
  const [selected, setSelected] = useState<string[]>(patient.therapists.map((t: any) => t.id));
  const { busy, error, submit } = useSubmit(() => put(`/patients/${patient.id}/therapists`, { memberIds: selected }), () => {
    onSaved();
    onClose();
  });
  return (
    <Dialog title="Terapis yang ditugaskan" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <p className="small muted">Terapis yang dipilih dapat melihat data pasien ini dan menulis catatan terapinya.</p>
        {!therapists ? <Loading /> : null}
        {therapists?.map((t) => (
          <label key={t.id} className="check">
            <input
              type="checkbox"
              checked={selected.includes(t.id)}
              onChange={(e) => setSelected(e.target.checked ? [...selected, t.id] : selected.filter((x) => x !== t.id))}
            />
            <span>
              {t.fullName}
              {t.specialization ? <span className="muted"> · {t.specialization}</span> : null}
            </span>
          </label>
        ))}
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

function AppointmentsTab({ patient }: { patient: any }) {
  const { can } = useAuth();
  const canWrite = useCanWriteNote(patient);
  const { data, error, loading, reload } = useApi<any[]>(`/patients/${patient.id}/appointments`);
  const [creating, setCreating] = useState(false);
  return (
    <section className="card">
      <div className="card-head">
        <h2>Riwayat & jadwal sesi</h2>
        {can('schedule.manage') && patient.status === 'aktif' ? (
          <button className="btn btn-sm" onClick={() => setCreating(true)}>
            <Icon name="plus" /> Buat jadwal
          </button>
        ) : null}
      </div>
      {loading && !data ? <Loading /> : null}
      <ErrorBox error={error} />
      {data?.length === 0 ? <Empty title="Belum ada jadwal" /> : null}
      {data?.length ? (
        <div className="table-wrap">
          <table className="table responsive">
            <thead>
              <tr>
                <th>Waktu</th>
                <th>Layanan</th>
                <th>Terapis</th>
                <th>Tagihan</th>
                <th>Status</th>
                <th>Catatan</th>
              </tr>
            </thead>
            <tbody>
              {data.map((a) => (
                <tr key={a.id}>
                  <td data-label="Waktu">
                    {formatDate(a.localDate)} · {a.localTime}
                  </td>
                  <td data-label="Layanan">{a.serviceName ?? '—'}</td>
                  <td data-label="Terapis">{a.therapistName}</td>
                  <td data-label="Tagihan">
                    {BILLING[a.billing]}
                    {a.billing === 'per_sesi' && a.price ? ` · ${formatRupiah(a.price)}` : ''}
                  </td>
                  <td data-label="Status">
                    <Badge tone={APPT_STATUS[a.status]?.tone}>{APPT_STATUS[a.status]?.label}</Badge>
                    {a.cancelReason ? <div className="small muted">{a.cancelReason}</div> : null}
                  </td>
                  <td data-label="Catatan">
                    {a.noteId ? (
                      <Link to={`/catatan/${a.noteId}`}>{a.noteStatus === 'final' ? 'Lihat' : 'Draf'}</Link>
                    ) : a.status === 'selesai' && canWrite ? (
                      <Link to={`/catatan/baru?patientId=${patient.id}&appointmentId=${a.id}`}>Tulis</Link>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {creating ? <AppointmentDialog presetPatient={patient} onClose={() => setCreating(false)} onSaved={reload} /> : null}
    </section>
  );
}

export function NoteView({ note }: { note: any }) {
  const sections: [string, string][] = [
    ['Tujuan / target sesi', note.objectives],
    ['Aktivitas', note.activities],
    ['Observasi & respons anak', note.observations],
    ['Program di rumah', note.homeProgram],
    ['Rencana berikutnya', note.nextPlan],
  ];
  return (
    <>
      {sections
        .filter(([, v]) => v)
        .map(([label, value]) => (
          <div className="note-section" key={label}>
            <h4>{label}</h4>
            <p>{value}</p>
          </div>
        ))}
    </>
  );
}

// Menulis catatan hanya untuk terapis yang ditugaskan (server juga menegakkan ini).
function useCanWriteNote(patient: any) {
  const { can, me } = useAuth();
  return can('therapy.note.write') && patient.therapists.some((t: any) => t.id === me?.membership?.id);
}

function NotesTab({ patient }: { patient: any }) {
  const { me } = useAuth();
  const canWrite = useCanWriteNote(patient);
  const { data, error, loading } = useApi<any[]>(`/patients/${patient.id}/notes`);
  return (
    <div className="stack">
      <div className="spread">
        <p className="muted small">Catatan klinis bersifat rahasia. Setiap akses tercatat di audit log.</p>
        {canWrite ? (
          <Link className="btn btn-sm" to={`/catatan/baru?patientId=${patient.id}`}>
            <Icon name="plus" /> Tulis catatan
          </Link>
        ) : null}
      </div>
      {loading && !data ? <Loading /> : null}
      <ErrorBox error={error} />
      {data?.length === 0 ? (
        <div className="card">
          <Empty title="Belum ada catatan terapi" />
        </div>
      ) : null}
      {data?.map((n) => (
        <article className="card" key={n.id}>
          <div className="card-head">
            <div>
              <h3>
                {NOTE_TYPE[n.noteType]} {n.sessionAt ? <span className="muted">· sesi {n.sessionAt}</span> : null}
              </h3>
              <div className="small muted">
                {n.authorName} · diperbarui {formatDateTime(n.updatedAt, me?.organization?.timezone)} · revisi {n.revisionNo}
              </div>
            </div>
            <div className="row">
              <Badge tone={n.status === 'final' ? 'ok' : 'warn'}>{n.status === 'final' ? 'Final' : 'Draf'}</Badge>
              <Link className="btn btn-sm btn-secondary" to={`/catatan/${n.id}`}>
                Buka
              </Link>
            </div>
          </div>
          <div className="card-body">
            <NoteView note={n} />
          </div>
        </article>
      ))}
    </div>
  );
}

function PackagesTab({ patient }: { patient: any }) {
  const { can } = useAuth();
  const { data, error, loading, reload } = useApi<any[]>(`/patients/${patient.id}/packages`);
  const [selling, setSelling] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  return (
    <section className="card">
      <div className="card-head">
        <h2>Paket terapi</h2>
        {can('package.sell') && patient.status === 'aktif' ? (
          <button className="btn btn-sm" onClick={() => setSelling(true)}>
            <Icon name="plus" /> Jual paket
          </button>
        ) : null}
      </div>
      {loading && !data ? <Loading /> : null}
      <ErrorBox error={error} />
      {data?.length === 0 ? <Empty title="Belum ada paket" /> : null}
      {data?.length ? (
        <div className="table-wrap">
          <table className="table responsive">
            <thead>
              <tr>
                <th>Paket</th>
                <th>Dibeli</th>
                <th>Berlaku s.d.</th>
                <th className="num">Sisa</th>
                <th className="num">Harga</th>
                {data[0].paidAmount !== null ? <th className="num">Terbayar</th> : null}
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.map((pk) => (
                <tr key={pk.id} className="clickable" onClick={() => setDetail(pk.id)}>
                  <td data-label="Paket">
                    <strong>{pk.name}</strong>
                  </td>
                  <td data-label="Dibeli">{formatDate(pk.purchasedOn)}</td>
                  <td data-label="Berlaku s.d.">
                    {pk.expiresOn ? formatDate(pk.expiresOn) : 'Tanpa batas'}
                    {pk.expired ? <Badge tone="danger">Kedaluwarsa</Badge> : null}
                  </td>
                  <td data-label="Sisa" className="num">
                    <strong>{pk.sessionsRemaining}</strong> / {pk.sessionsTotal}
                  </td>
                  <td data-label="Harga" className="num">
                    {formatRupiah(pk.price)}
                  </td>
                  {pk.paidAmount !== null ? (
                    <td data-label="Terbayar" className="num">
                      {formatRupiah(pk.paidAmount)}
                    </td>
                  ) : null}
                  <td data-label="Status">
                    <Badge tone={PACKAGE_STATUS[pk.status]?.tone}>{PACKAGE_STATUS[pk.status]?.label}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {selling ? <SellPackageDialog patientId={patient.id} onClose={() => setSelling(false)} onSaved={reload} /> : null}
      {detail ? <PackageDetailDialog id={detail} onClose={() => setDetail(null)} onChanged={reload} /> : null}
    </section>
  );
}

function SellPackageDialog({ patientId, onClose, onSaved }: { patientId: string; onClose: () => void; onSaved: () => void }) {
  const { data: types } = useApi<any[]>('/package-types');
  const active = types?.filter((t) => t.active) ?? [];
  const [typeId, setTypeId] = useState('');
  const [purchasedOn, setPurchasedOn] = useState('');
  const toast = useToast();
  const chosen = active.find((t) => t.id === typeId);
  const { busy, error, submit } = useSubmit(() => post(`/patients/${patientId}/packages`, { packageTypeId: typeId, ...(purchasedOn ? { purchasedOn } : {}) }), () => {
    toast('Paket ditambahkan. Catat pembayarannya di tab Pembayaran.');
    onSaved();
    onClose();
  });
  return (
    <Dialog title="Jual paket" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <Field label="Jenis paket">
          {(id) => (
            <select id={id} className="select" value={typeId} onChange={(e) => setTypeId(e.target.value)} required>
              <option value="">Pilih paket…</option>
              {active.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} — {t.sessionsTotal} sesi · {formatRupiah(t.price)}
                </option>
              ))}
            </select>
          )}
        </Field>
        {types && active.length === 0 ? <div className="alert info">Belum ada jenis paket aktif. Owner dapat menambahkannya di Pengaturan.</div> : null}
        {chosen ? <p className="small muted">{chosen.validDays ? `Masa berlaku ${chosen.validDays} hari sejak tanggal beli.` : 'Tanpa masa berlaku.'}</p> : null}
        <Field label="Tanggal beli" hint="Kosongkan untuk hari ini">
          {(id) => <input id={id} className="input" type="date" value={purchasedOn} onChange={(e) => setPurchasedOn(e.target.value)} />}
        </Field>
        <ErrorBox error={error} />
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Batal
          </button>
          <button className="btn" disabled={busy || !typeId}>
            Simpan
          </button>
        </div>
      </form>
    </Dialog>
  );
}

const LEDGER_KIND: Record<string, string> = { pemakaian: 'Pemakaian sesi', pembatalan_pemakaian: 'Pemakaian dibatalkan', penyesuaian: 'Penyesuaian manual' };

function PackageDetailDialog({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { can, me } = useAuth();
  const { data, error, reload } = useApi<any>(`/patient-packages/${id}`);
  const [adjusting, setAdjusting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [delta, setDelta] = useState(1);
  const toast = useToast();
  const refresh = () => {
    reload();
    onChanged();
  };
  return (
    <Dialog title="Detail paket" onClose={onClose} wide>
      <ErrorBox error={error} />
      {!data ? <Loading /> : null}
      {data ? (
        <div className="stack">
          <div className="spread">
            <div>
              <h3>{data.name}</h3>
              <p className="muted small">
                Dibeli {formatDate(data.purchasedOn)} · {data.expiresOn ? `berlaku s.d. ${formatDate(data.expiresOn)}` : 'tanpa masa berlaku'}
              </p>
            </div>
            <Badge tone={PACKAGE_STATUS[data.status]?.tone}>
              {PACKAGE_STATUS[data.status]?.label} · sisa {data.sessionsRemaining}/{data.sessionsTotal}
            </Badge>
          </div>
          <div className="table-wrap card">
            <table className="table">
              <thead>
                <tr>
                  <th>Waktu</th>
                  <th>Jenis</th>
                  <th className="num">Perubahan</th>
                  <th className="num">Terpakai</th>
                  <th>Keterangan</th>
                </tr>
              </thead>
              <tbody>
                {data.ledger.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="muted">
                      Belum ada pemakaian.
                    </td>
                  </tr>
                ) : null}
                {data.ledger.map((l: any) => (
                  <tr key={l.id}>
                    <td>{formatDateTime(l.createdAt, me?.organization?.timezone)}</td>
                    <td>{LEDGER_KIND[l.kind]}</td>
                    <td className="num">{l.sessionsDelta > 0 ? `−${l.sessionsDelta} sisa` : `+${-l.sessionsDelta} sisa`}</td>
                    <td className="num">{l.sessionsUsedAfter}</td>
                    <td className="small">
                      {l.sessionAt ? `Sesi ${l.sessionAt}` : ''} {l.reason ?? ''} <span className="muted">· {l.actorName ?? ''}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {can('package.adjust') && data.status !== 'dibatalkan' ? (
            <div className="row">
              <button className="btn btn-sm btn-secondary" onClick={() => setAdjusting(true)}>
                Penyesuaian saldo
              </button>
              <button className="btn btn-sm btn-ghost" style={{ color: 'var(--c-danger)' }} onClick={() => setCancelling(true)}>
                Batalkan paket
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {adjusting ? (
        <ReasonDialog
          title="Penyesuaian saldo sesi"
          description={
            <span className="row">
              Sisa sesi
              <select className="select" style={{ width: 'auto' }} value={delta} onChange={(e) => setDelta(Number(e.target.value))}>
                {[-3, -2, -1, 1, 2, 3].map((d) => (
                  <option key={d} value={d}>
                    {d > 0 ? `dikurangi ${d}` : `ditambah ${-d}`}
                  </option>
                ))}
              </select>
            </span>
          }
          confirmLabel="Simpan penyesuaian"
          onClose={() => setAdjusting(false)}
          onConfirm={async (reason) => {
            await post(`/patient-packages/${id}/adjust`, { sessionsDelta: delta, reason });
            toast('Saldo paket disesuaikan');
            refresh();
          }}
        />
      ) : null}
      {cancelling ? (
        <ReasonDialog
          title="Batalkan paket"
          danger
          description="Paket yang dibatalkan tidak dapat dipakai lagi. Kebijakan pengembalian dana belum diatur dalam sistem."
          confirmLabel="Batalkan paket"
          onClose={() => setCancelling(false)}
          onConfirm={async (reason) => {
            await post(`/patient-packages/${id}/cancel`, { reason });
            toast('Paket dibatalkan');
            refresh();
          }}
        />
      ) : null}
    </Dialog>
  );
}

function PaymentsTab({ patient }: { patient: any }) {
  const { can } = useAuth();
  const { data, error, loading, reload } = useApi<any[]>(`/patients/${patient.id}/payments`);
  const [recording, setRecording] = useState(false);
  const [invoicing, setInvoicing] = useState(false);
  const toast = useToast();
  return (
    <section className="card">
      <div className="card-head">
        <h2>Pembayaran</h2>
        <div className="row">
          {can('invoice.create') ? (
            <button className="btn btn-sm btn-secondary" onClick={() => setInvoicing(true)}>
              Buat invoice
            </button>
          ) : null}
          {can('payment.record') ? (
            <button className="btn btn-sm" onClick={() => setRecording(true)}>
              <Icon name="plus" /> Catat pembayaran
            </button>
          ) : null}
        </div>
      </div>
      {loading && !data ? <Loading /> : null}
      <ErrorBox error={error} />
      {data?.length === 0 ? <Empty title="Belum ada pembayaran" /> : null}
      {data?.length ? (
        <div className="table-wrap">
          <table className="table responsive">
            <thead>
              <tr>
                <th>Tanggal</th>
                <th>No. kuitansi</th>
                <th>Untuk</th>
                <th>Metode</th>
                <th className="num">Nominal</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.map((pay) => (
                <tr key={pay.id}>
                  <td data-label="Tanggal">{formatDate(pay.paidOn)}</td>
                  <td data-label="No. kuitansi">
                    <Link to={`/kuitansi/${pay.id}`} className="mono">
                      {pay.receiptNo}
                    </Link>
                  </td>
                  <td data-label="Untuk">{pay.packageName ?? (pay.appointmentId ? 'Sesi' : pay.invoiceId ? 'Invoice' : 'Umum')}</td>
                  <td data-label="Metode">{METHOD[pay.method]}</td>
                  <td data-label="Nominal" className="num">
                    {formatRupiah(pay.amount)}
                  </td>
                  <td data-label="Status">
                    <Badge tone={pay.status === 'tercatat' ? 'ok' : 'danger'}>{pay.status === 'tercatat' ? 'Tercatat' : 'Dibatalkan'}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {recording ? <PaymentDialog presetPatient={patient} onClose={() => setRecording(false)} onSaved={reload} /> : null}
      {invoicing ? <InvoiceCreateDialog presetPatient={patient} onClose={() => setInvoicing(false)} onSaved={() => toast('Invoice dibuat. Lihat di menu Pembayaran & Kas → Invoice.')} /> : null}
    </section>
  );
}

function DocumentsTab({ patient }: { patient: any }) {
  const { can } = useAuth();
  const { data, error, loading, reload } = useApi<any[]>(`/patients/${patient.id}/documents`);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('administrasi');
  const [file, setFile] = useState<File | null>(null);
  const toast = useToast();
  const clinicalAllowed = can('therapy.note.read', 'therapy.note.read.assigned');
  const { data: storage } = useApi<{ usedBytes: number; quotaBytes: number; maxUploadBytes: number }>(can('document.upload') ? '/org/storage' : null);
  const { busy, error: upError, submit } = useSubmit(
    async () => {
      const form = new FormData();
      form.set('title', title);
      form.set('category', category);
      if (file) form.set('file', file);
      return api(`/patients/${patient.id}/documents`, { method: 'POST', form });
    },
    () => {
      toast('Dokumen diunggah');
      setTitle('');
      setFile(null);
      reload();
    },
  );
  const archive = async (id: string) => {
    if (!confirm('Arsipkan dokumen ini? Dokumen tidak lagi tampil di daftar.')) return;
    await post(`/documents/${id}/archive`);
    reload();
  };
  return (
    <div className="grid grid-2">
      <section className="card">
        <div className="card-head">
          <h2>Dokumen</h2>
        </div>
        {loading && !data ? <Loading /> : null}
        <ErrorBox error={error} />
        {data?.length === 0 ? <Empty title="Belum ada dokumen" /> : null}
        {data?.map((d) => (
          <div key={d.id} className="card-body spread" style={{ borderBottom: '1px solid var(--c-border)' }}>
            <div>
              <strong>{d.title}</strong> <Badge tone={d.category === 'klinis' ? 'star' : ''}>{d.category === 'klinis' ? 'Klinis' : 'Administrasi'}</Badge>
              <div className="small muted">
                {d.originalName} · {(d.sizeBytes / 1024).toFixed(0)} KB · {formatDate(d.uploadedAt)} · {d.uploadedByName}
              </div>
            </div>
            <div className="row">
              <button className="btn btn-sm btn-secondary" onClick={() => downloadUrl(`/documents/${d.id}/download`)}>
                <Icon name="download" /> Unduh
              </button>
              {can('document.archive') ? (
                <button className="btn btn-sm btn-ghost" onClick={() => archive(d.id)}>
                  Arsipkan
                </button>
              ) : null}
            </div>
          </div>
        ))}
      </section>
      {can('document.upload') ? (
        <section className="card card-pad">
          <h2 style={{ marginBottom: 12 }}>Unggah dokumen</h2>
          <form className="form" onSubmit={submit}>
            <Field label="Judul">{(id) => <input id={id} className="input" value={title} onChange={(e) => setTitle(e.target.value)} required minLength={2} maxLength={150} />}</Field>
            <Field label="Kategori">
              {(id) => (
                <select id={id} className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
                  <option value="administrasi">Administrasi (mis. formulir pendaftaran)</option>
                  {clinicalAllowed ? <option value="klinis">Klinis (mis. hasil asesmen, rujukan dokter)</option> : null}
                </select>
              )}
            </Field>
            <Field label="Berkas" hint={`PDF, JPG, atau PNG. Maksimal ${storage ? formatBytes(storage.maxUploadBytes) : '4 MB'}. Foto sebaiknya dikompres terlebih dahulu.`}>
              {(id) => <input id={id} className="input" type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" onChange={(e) => setFile(e.target.files?.[0] ?? null)} required />}
            </Field>
            <ErrorBox error={upError} />
            <div className="form-actions">
              <button className="btn" disabled={busy || !file}>
                {busy ? 'Mengunggah…' : 'Unggah'}
              </button>
            </div>
          </form>
        </section>
      ) : null}
    </div>
  );
}

export async function searchPatients(q: string): Promise<any[]> {
  const r = await get<{ items: any[] }>(`/patients${qs({ q, status: 'aktif', limit: 20 })}`);
  return r.items;
}
