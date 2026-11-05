import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { api, del, post, put, useApi } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { formatBytes, formatDate, formatDateTime, formatPhone } from '../format.ts';
import { Badge, ErrorBox, Field, PageHeader, ReasonDialog, useSubmit, useToast } from '../ui.tsx';
import { AppointmentDialog } from './schedule.tsx';

// Pendaftaran pasien baru: identitas, orang tua, pemeriksaan awal, program terapi, dan berkas.
// No. RM dibuat otomatis saat disimpan (awalan diatur owner di Pengaturan).

// Informed consent wajib (keputusan owner 5 Nov 2026); berkas lain opsional.
const FILES = [
  { key: 'informed_consent', title: 'Foto informed consent', required: true },
  { key: 'ktp_ortu', title: 'Foto KTP orang tua', required: false },
  { key: 'kia', title: 'Foto KIA anak', required: false },
  { key: 'foto_anak', title: 'Foto anak', required: false },
] as const;

type OnlineRequest = {
  id: string;
  childName: string;
  birthPlace: string;
  birthDate: string;
  guardianName: string;
  guardianRelationship: 'Ibu' | 'Ayah' | 'Wali';
  phone: string;
  address: string;
  complaint: string;
  assessmentDate: string;
  assessmentTime: string;
  createdAt: string;
  existingPatientCode: string | null;
  duplicateRequests: number;
};

// Pesan konfirmasi jadwal asesmen untuk orang tua (dibuka lewat wa.me, dikirim manual oleh admin).
function confirmationMessage(r: OnlineRequest, orgName: string) {
  const salam = r.guardianRelationship === 'Ibu' ? 'Ibu' : r.guardianRelationship === 'Ayah' ? 'Bapak' : 'Bapak/Ibu';
  return `Halo ${salam} ${r.guardianName}, pendaftaran ${r.childName} di ${orgName} sudah kami terima. Jadwal pemeriksaan asesmen: ${formatDate(r.assessmentDate)} pukul ${r.assessmentTime}. Mohon balas pesan ini untuk konfirmasi. Terima kasih.`;
}

export function RegistrationPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const intakeAllowed = can('patient.intake');
  const formRef = useRef<HTMLFormElement>(null);
  // Pendaftaran online yang sedang diproses menjadi pasien (consent boleh menyusul saat kunjungan).
  const [online, setOnline] = useState<OnlineRequest | null>(null);
  const [wali, setWali] = useState({ fullName: '', phone: '' });
  const [assessment, setAssessment] = useState<null | { patient: any; date: string; time: string }>(null);
  const { data: services } = useApi<any[]>('/services');
  const { data: storage } = useApi<{ maxUploadBytes: number }>(can('document.upload') ? '/org/storage' : null);
  const [f, setF] = useState({ fullName: '', nickname: '', birthPlace: '', birthDate: '', sex: '', address: '' });
  const [father, setFather] = useState({ fullName: '', phone: '' });
  const [mother, setMother] = useState({ fullName: '', phone: '' });
  const [primary, setPrimary] = useState<'ibu' | 'ayah' | 'wali'>('ibu');
  const [intake, setIntake] = useState({ complaint: '', findings: '', programNotes: '' });
  const [program, setProgram] = useState<string[]>([]);
  const [files, setFiles] = useState<Record<string, File | null>>({});
  const [failedUploads, setFailedUploads] = useState<string[]>([]);
  const activeServices = services?.filter((s) => s.active) ?? [];
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });

  const { busy, error, submit } = useSubmit(
    async () => {
      const guardians = [
        mother.fullName.trim() || mother.phone.trim()
          ? { fullName: mother.fullName.trim() || `Ibu ${f.fullName.trim()}`, relationship: 'Ibu', phone: mother.phone || null, isPrimary: primary === 'ibu' }
          : null,
        father.fullName.trim() || father.phone.trim()
          ? { fullName: father.fullName.trim() || `Ayah ${f.fullName.trim()}`, relationship: 'Ayah', phone: father.phone || null, isPrimary: primary === 'ayah' }
          : null,
        wali.fullName.trim() ? { fullName: wali.fullName.trim(), relationship: 'Wali', phone: wali.phone || null, isPrimary: primary === 'wali' } : null,
      ].filter(Boolean) as { isPrimary: boolean }[];
      if (guardians.length && !guardians.some((g) => g.isPrimary)) guardians[0].isPrimary = true;
      const created = await post<{ id: string; patientCode: string }>('/patients', {
        fullName: f.fullName,
        nickname: f.nickname || null,
        birthPlace: f.birthPlace || null,
        birthDate: f.birthDate || null,
        sex: f.sex || null,
        address: f.address || null,
        guardians,
        ...(intakeAllowed ? { intake: { ...intake, programServiceIds: program } } : {}),
        ...(online ? { registrationRequestId: online.id } : {}),
      });
      // Berkas diunggah setelah pasien tersimpan; kegagalan unggah tidak membatalkan pendaftaran.
      const failed: string[] = [];
      for (const d of FILES) {
        const file = files[d.key];
        if (!file) continue;
        const form = new FormData();
        form.set('title', d.title);
        form.set('category', 'administrasi');
        form.set('docType', d.key);
        form.set('file', file);
        try {
          await api(`/patients/${created.id}/documents`, { method: 'POST', form });
        } catch {
          failed.push(d.title);
        }
      }
      setFailedUploads(failed);
      return { ...created, failed };
    },
    (r) => {
      toast(r.failed.length ? `Pasien terdaftar (${r.patientCode}). ${r.failed.join(', ')} gagal diunggah; unggah ulang di tab Dokumen.` : `Pasien terdaftar dengan No. RM ${r.patientCode}`);
      // Dari pendaftaran online: lanjut membuat jadwal asesmen sesuai pilihan orang tua.
      if (online) setAssessment({ patient: { id: r.id, fullName: f.fullName, patientCode: r.patientCode }, date: online.assessmentDate, time: online.assessmentTime });
      else navigate(`/pasien/${r.id}`);
    },
  );

  function processOnline(r: OnlineRequest) {
    setOnline(r);
    setF({ fullName: r.childName, nickname: '', birthPlace: r.birthPlace, birthDate: r.birthDate, sex: '', address: r.address });
    const contact = { fullName: r.guardianName, phone: formatPhone(r.phone) };
    setMother(r.guardianRelationship === 'Ibu' ? contact : { fullName: '', phone: '' });
    setFather(r.guardianRelationship === 'Ayah' ? contact : { fullName: '', phone: '' });
    setWali(r.guardianRelationship === 'Wali' ? contact : { fullName: '', phone: '' });
    setPrimary(r.guardianRelationship === 'Ayah' ? 'ayah' : r.guardianRelationship === 'Wali' ? 'wali' : 'ibu');
    setIntake({ complaint: r.complaint, findings: '', programNotes: '' });
    setTimeout(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
  }

  return (
    <>
      <PageHeader title="Pasien baru" subtitle="Isi data anak dan orang tua. No. RM dibuat otomatis saat disimpan." back={{ to: '/pasien', label: 'Daftar pasien' }} />
      {intakeAllowed ? <OnlineRegistrations active={online?.id ?? null} onProcess={processOnline} /> : null}
      <form ref={formRef} className="card card-pad form registration" onSubmit={submit}>
        {online ? (
          <div className="alert info spread">
            <span>
              Memproses pendaftaran online <strong>{online.childName}</strong>. Setelah disimpan, jadwal asesmen {formatDate(online.assessmentDate)} pukul {online.assessmentTime}{' '}
              langsung dibuat.
            </span>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOnline(null)}>
              Batal proses
            </button>
          </div>
        ) : null}
        <section className="reg-section">
          <h2>Data anak</h2>
          <div className="form-grid">
            <Field label="No. RM" hint="Dibuat otomatis, tidak dapat kembar.">
              {(id) => <input id={id} className="input mono" value="Otomatis" disabled />}
            </Field>
            <Field label="Nama lengkap anak">{(id) => <input id={id} className="input" value={f.fullName} onChange={set('fullName')} required minLength={2} maxLength={150} />}</Field>
            <Field label="Nama panggilan">{(id) => <input id={id} className="input" value={f.nickname} onChange={set('nickname')} maxLength={60} />}</Field>
            <Field label="Jenis kelamin">
              {(id) => (
                <select id={id} className="select" value={f.sex} onChange={set('sex')}>
                  <option value="">—</option>
                  <option value="L">Laki-laki</option>
                  <option value="P">Perempuan</option>
                </select>
              )}
            </Field>
            <Field label="Tempat lahir">{(id) => <input id={id} className="input" value={f.birthPlace} onChange={set('birthPlace')} maxLength={100} />}</Field>
            <Field label="Tanggal lahir">{(id) => <input id={id} className="input" type="date" value={f.birthDate} onChange={set('birthDate')} />}</Field>
            <Field label="Alamat" full>
              {(id) => <textarea id={id} className="textarea" style={{ minHeight: 64 }} value={f.address} onChange={set('address')} maxLength={500} />}
            </Field>
          </div>
        </section>

        <section className="reg-section">
          <h2>Orang tua</h2>
          <div className="form-grid">
            <Field label="Nama ayah">{(id) => <input id={id} className="input" value={father.fullName} onChange={(e) => setFather({ ...father, fullName: e.target.value })} maxLength={150} />}</Field>
            <Field label="No. WA aktif ayah">
              {(id) => <input id={id} className="input" inputMode="tel" placeholder="08…" value={father.phone} onChange={(e) => setFather({ ...father, phone: e.target.value })} maxLength={40} />}
            </Field>
            <Field label="Nama ibu">{(id) => <input id={id} className="input" value={mother.fullName} onChange={(e) => setMother({ ...mother, fullName: e.target.value })} maxLength={150} />}</Field>
            <Field label="No. WA aktif ibu">
              {(id) => <input id={id} className="input" inputMode="tel" placeholder="08…" value={mother.phone} onChange={(e) => setMother({ ...mother, phone: e.target.value })} maxLength={40} />}
            </Field>
          </div>
          {wali.fullName || primary === 'wali' ? (
            <div className="form-grid">
              <Field label="Nama wali">{(id) => <input id={id} className="input" value={wali.fullName} onChange={(e) => setWali({ ...wali, fullName: e.target.value })} maxLength={150} />}</Field>
              <Field label="No. WA aktif wali">
                {(id) => <input id={id} className="input" inputMode="tel" value={wali.phone} onChange={(e) => setWali({ ...wali, phone: e.target.value })} maxLength={40} />}
              </Field>
            </div>
          ) : null}
          <div className="field">
            <span className="label">Kontak utama (pengingat jadwal & dasbor orang tua)</span>
            <div className="segmented" role="group" aria-label="Kontak utama">
              <button type="button" aria-pressed={primary === 'ibu'} onClick={() => setPrimary('ibu')}>
                Ibu
              </button>
              <button type="button" aria-pressed={primary === 'ayah'} onClick={() => setPrimary('ayah')}>
                Ayah
              </button>
              {wali.fullName ? (
                <button type="button" aria-pressed={primary === 'wali'} onClick={() => setPrimary('wali')}>
                  Wali
                </button>
              ) : null}
            </div>
          </div>
        </section>

        {intakeAllowed ? (
          <section className="reg-section">
            <h2>Pemeriksaan awal & program terapi</h2>
            <p className="small muted">Terlihat oleh owner, admin, dan terapis yang menangani. Tidak terlihat oleh keuangan maupun orang tua.</p>
            <Field label="Keluhan awal">
              {(id) => <textarea id={id} className="textarea" style={{ minHeight: 72 }} value={intake.complaint} onChange={(e) => setIntake({ ...intake, complaint: e.target.value })} maxLength={5000} />}
            </Field>
            <Field label="Hasil pemeriksaan">
              {(id) => <textarea id={id} className="textarea" value={intake.findings} onChange={(e) => setIntake({ ...intake, findings: e.target.value })} maxLength={10000} />}
            </Field>
            <div className="field">
              <span className="label">Program terapi</span>
              <div className="chips" role="group" aria-label="Program terapi">
                {activeServices.map((s) => {
                  const on = program.includes(s.id);
                  return (
                    <button
                      key={s.id}
                      type="button"
                      className={`chip${on ? ' on' : ''}`}
                      aria-pressed={on}
                      onClick={() => setProgram(on ? program.filter((x) => x !== s.id) : [...program, s.id])}
                    >
                      {s.name}
                    </button>
                  );
                })}
              </div>
              <span className="hint">Pilih satu atau lebih, mis. OT dan TW sekaligus.</span>
            </div>
            <Field label="Uraian program">
              {(id) => (
                <textarea id={id} className="textarea" style={{ minHeight: 72 }} value={intake.programNotes} onChange={(e) => setIntake({ ...intake, programNotes: e.target.value })} maxLength={5000} />
              )}
            </Field>
          </section>
        ) : null}

        {can('document.upload') ? (
          <section className="reg-section">
            <h2>Berkas</h2>
            <div className="form-grid">
              {FILES.map((d) => (
                <Field
                  key={d.key}
                  label={d.required && !online ? `${d.title} (wajib)` : `${d.title} (opsional)`}
                  hint={`${d.required ? (online ? 'Boleh menyusul saat kunjungan asesmen; pasien ditandai sampai diunggah. ' : 'Foto lembar persetujuan yang sudah ditandatangani orang tua. ') : ''}JPG, PNG, atau PDF${storage ? `, maks. ${formatBytes(storage.maxUploadBytes)}` : ''}`}
                >
                  {(id) => (
                    <input
                      id={id}
                      className="input"
                      type="file"
                      accept=".jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf"
                      required={d.required && !online}
                      onChange={(e) => setFiles({ ...files, [d.key]: e.target.files?.[0] ?? null })}
                    />
                  )}
                </Field>
              ))}
            </div>
          </section>
        ) : null}

        {failedUploads.length ? <div className="alert warn">Gagal diunggah: {failedUploads.join(', ')}.</div> : null}
        <ErrorBox error={error} />
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={() => navigate('/pasien')}>
            Batal
          </button>
          <button className="btn" disabled={busy}>
            {busy ? 'Menyimpan…' : 'Daftarkan pasien'}
          </button>
        </div>
      </form>
      {assessment ? (
        <AppointmentDialog
          presetPatient={assessment.patient}
          presetDate={assessment.date}
          presetTime={assessment.time}
          title="Jadwal asesmen"
          onClose={() => navigate(`/pasien/${assessment.patient.id}`)}
          onSaved={() => undefined}
        />
      ) : null}
    </>
  );
}

// Pendaftaran online dari orang tua (halaman publik /daftar/<token>), pengganti Google Form.
function OnlineRegistrations({ active, onProcess }: { active: string | null; onProcess: (r: OnlineRequest) => void }) {
  const { can, me } = useAuth();
  const toast = useToast();
  const { data: link, reload: reloadLink } = useApi<{ open: boolean; token: string | null; hasFlyer: boolean }>('/org/registration-link');
  const [flyerBusy, setFlyerBusy] = useState(false);
  const [flyerVersion, setFlyerVersion] = useState(() => Date.now());
  const { data, reload } = useApi<OnlineRequest[]>('/registrations');
  const [rejecting, setRejecting] = useState<OnlineRequest | null>(null);
  const url = link?.token ? `${window.location.origin}/daftar/${link.token}` : null;
  const owner = can('org.settings.manage');

  const configure = async (open: boolean, regenerate = false) => {
    if (regenerate && !confirm('Tautan lama tidak akan berlaku lagi. Lanjutkan?')) return;
    try {
      await put('/org/registration-link', { open, regenerate });
      toast(regenerate ? 'Tautan pendaftaran baru dibuat' : open ? 'Pendaftaran online dibuka' : 'Pendaftaran online ditutup');
      void reloadLink();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  const uploadFlyer = async (file: File | undefined) => {
    if (!file) return;
    const form = new FormData();
    form.set('file', file);
    setFlyerBusy(true);
    try {
      await api('/org/registration-flyer', { method: 'PUT', form });
      toast('Brosur pendaftaran disimpan');
      setFlyerVersion(Date.now());
      void reloadLink();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setFlyerBusy(false);
    }
  };
  const removeFlyer = async () => {
    if (!confirm('Hapus brosur dari halaman pendaftaran?')) return;
    try {
      await del('/org/registration-flyer');
      toast('Brosur dihapus');
      void reloadLink();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  return (
    <section className="card online-reg">
      <div className="card-head">
        <h2>Pendaftaran online</h2>
        {link ? <Badge tone={link.open ? 'ok' : ''}>{link.open ? 'Dibuka' : 'Ditutup'}</Badge> : null}
      </div>
      <div className="card-body stack" style={{ gap: 12 }}>
        {link?.open && url ? (
          <div className="online-link">
            <input className="input mono" value={url} readOnly aria-label="Tautan pendaftaran untuk orang tua" onFocus={(e) => e.target.select()} />
            <div className="row">
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                onClick={() => navigator.clipboard?.writeText(url).then(() => toast('Tautan disalin'), () => toast('Salin manual dari kotak tautan', 'error'))}
              >
                Salin tautan
              </button>
              <a className="btn btn-sm btn-ghost" href={`https://wa.me/?text=${encodeURIComponent(`Formulir pendaftaran pasien baru: ${url}`)}`} target="_blank" rel="noopener">
                Bagikan lewat WhatsApp
              </a>
            </div>
          </div>
        ) : (
          <p className="small muted">
            {owner ? 'Buka pendaftaran online agar orang tua dapat mendaftar sendiri lewat tautan, menggantikan Google Form.' : 'Pendaftaran online sedang ditutup. Owner dapat membukanya di halaman ini.'}
          </p>
        )}
        {owner && link ? (
          <div className="flyer-admin">
            {link.hasFlyer && link.open && link.token ? (
              <img src={`/api/public/registration/${link.token}/flyer?v=${flyerVersion}`} alt="Brosur yang tampil di halaman pendaftaran" />
            ) : null}
            <div className="stack" style={{ gap: 6 }}>
              <strong className="small">Brosur paket & harga</strong>
              <span className="small muted">
                {link.hasFlyer ? 'Tampil di atas formulir pendaftaran.' : 'Belum ada. Gambar JPG/PNG (maks. 5 MB) akan tampil di atas formulir pendaftaran.'}
              </span>
              <div className="row">
                <label className="btn btn-sm btn-secondary">
                  {flyerBusy ? 'Mengunggah…' : link.hasFlyer ? 'Ganti brosur' : 'Unggah brosur'}
                  <input className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" disabled={flyerBusy} onChange={(e) => void uploadFlyer(e.target.files?.[0])} />
                </label>
                {link.hasFlyer ? (
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => void removeFlyer()}>
                    Hapus
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}
        {owner && link ? (
          <div className="row">
            <button type="button" className={`btn btn-sm${link.open ? ' btn-secondary' : ''}`} onClick={() => void configure(!link.open)}>
              {link.open ? 'Tutup pendaftaran' : 'Buka pendaftaran online'}
            </button>
            {link.open ? (
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => void configure(true, true)}>
                Ganti tautan
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {data?.length ? (
        <div className="online-list">
          {data.map((r) => (
            <article key={r.id} className={`online-item${active === r.id ? ' active' : ''}`}>
              <div className="online-main">
                <strong>{r.childName}</strong>
                <span className="small muted">
                  {r.birthPlace}, {formatDate(r.birthDate)}. {r.guardianRelationship}: {r.guardianName}, {formatPhone(r.phone)}
                </span>
                <span className="small">Keluhan: {r.complaint.length > 140 ? `${r.complaint.slice(0, 140)}…` : r.complaint}</span>
                <span className="row" style={{ gap: 6 }}>
                  <Badge tone="info">
                    Asesmen {formatDate(r.assessmentDate)}, {r.assessmentTime}
                  </Badge>
                  {r.existingPatientCode ? <Badge tone="warn">Mungkin sudah terdaftar: {r.existingPatientCode}</Badge> : null}
                  {r.duplicateRequests > 0 ? <Badge tone="warn">Dikirim {r.duplicateRequests + 1}x</Badge> : null}
                  <span className="small muted">Masuk {formatDateTime(r.createdAt)}</span>
                </span>
              </div>
              <div className="row">
                <button type="button" className="btn btn-sm" onClick={() => onProcess(r)}>
                  Proses
                </button>
                <a
                  className="btn btn-sm btn-secondary"
                  href={`https://wa.me/${r.phone}?text=${encodeURIComponent(confirmationMessage(r, me?.organization?.name ?? 'klinik kami'))}`}
                  target="_blank"
                  rel="noopener"
                >
                  Hubungi lewat WA
                </a>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRejecting(r)}>
                  Tolak
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : data ? (
        <p className="small muted card-body" style={{ paddingTop: 0 }}>
          Belum ada pendaftaran online yang menunggu.
        </p>
      ) : null}
      {rejecting ? (
        <ReasonDialog
          title={`Tolak pendaftaran ${rejecting.childName}`}
          description="Mis. pendaftaran ganda, data tidak lengkap, atau bukan pendaftaran sungguhan."
          confirmLabel="Tolak pendaftaran"
          minLength={3}
          danger
          onClose={() => setRejecting(null)}
          onConfirm={async (reason) => {
            await post(`/registrations/${rejecting.id}/reject`, { reason });
            toast('Pendaftaran ditolak');
            void reload();
          }}
        />
      ) : null}
    </section>
  );
}
