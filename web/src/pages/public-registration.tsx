import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { get, post } from '../api.ts';
import { addDays } from '../format.ts';
import { ErrorBox, Field, Loading, LOGO_ALT, logoUrl, useSubmit } from '../ui.tsx';

// Formulir pendaftaran pasien baru untuk orang tua (tanpa akun), pengganti Google Form.

const empty = {
  childName: '',
  birthPlace: '',
  birthDate: '',
  guardianName: '',
  relationship: 'Ibu',
  phone: '',
  address: '',
  complaint: '',
  assessmentDate: '',
  assessmentTime: '',
  agree: false,
  website: '',
};

export function PublicRegistrationPage() {
  const { token = '' } = useParams();
  const [org, setOrg] = useState<{ organizationName: string; today: string } | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [f, setF] = useState(empty);
  const [sent, setSent] = useState<null | { name: string; phone: string }>(null);
  useEffect(() => {
    get<{ organizationName: string; today: string }>(`/public/registration/${encodeURIComponent(token)}`).then(setOrg, setLoadError);
  }, [token]);
  const set = (k: keyof typeof empty) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });

  const { busy, error, submit } = useSubmit(
    () => post(`/public/registration/${encodeURIComponent(token)}`, f),
    () => {
      setSent({ name: f.guardianName, phone: f.phone });
      setF(empty);
      window.scrollTo(0, 0);
    },
  );

  return (
    <div className="public-page">
      <main className="public-card">
        <header className="public-head">
          <img src={logoUrl} alt={LOGO_ALT} />
          <div>
            <h1>Pendaftaran pasien baru</h1>
            {org ? <p className="muted">{org.organizationName}</p> : null}
          </div>
        </header>
        {!org && !loadError ? <Loading /> : null}
        <ErrorBox error={loadError} />
        {org && sent ? (
          <div className="stack" style={{ gap: 14 }}>
            <div className="alert ok">
              <strong>Pendaftaran terkirim.</strong> Terima kasih, {sent.name}. Admin {org.organizationName} akan menghubungi lewat WhatsApp {sent.phone} untuk
              mengonfirmasi jadwal pemeriksaan asesmen.
            </div>
            <button type="button" className="btn btn-secondary" onClick={() => setSent(null)}>
              Daftarkan anak lain
            </button>
          </div>
        ) : null}
        {org && !sent ? (
          <form className="form" onSubmit={submit}>
            <p className="small muted">Semua isian wajib diisi. Data dipakai hanya untuk pendaftaran dan layanan terapi anak.</p>
            <Field label="Nama lengkap anak">{(id) => <input id={id} className="input" value={f.childName} onChange={set('childName')} required minLength={2} maxLength={150} />}</Field>
            <div className="form-grid">
              <Field label="Tempat lahir anak">{(id) => <input id={id} className="input" value={f.birthPlace} onChange={set('birthPlace')} required minLength={2} maxLength={100} />}</Field>
              <Field label="Tanggal lahir anak">
                {(id) => <input id={id} className="input" type="date" value={f.birthDate} max={org.today} onChange={set('birthDate')} required />}
              </Field>
            </div>
            <Field label="Nama orang tua / wali">{(id) => <input id={id} className="input" value={f.guardianName} onChange={set('guardianName')} required minLength={2} maxLength={150} />}</Field>
            <div className="field">
              <span className="label">Hubungan dengan anak</span>
              <div className="segmented" role="group" aria-label="Hubungan dengan anak">
                {['Ibu', 'Ayah', 'Wali'].map((r) => (
                  <button key={r} type="button" aria-pressed={f.relationship === r} onClick={() => setF({ ...f, relationship: r })}>
                    {r}
                  </button>
                ))}
              </div>
            </div>
            <Field label="Nomor WA aktif" hint="Contoh: 0812xxxxxxx">
              {(id) => <input id={id} className="input" inputMode="tel" autoComplete="tel" value={f.phone} onChange={set('phone')} required maxLength={40} />}
            </Field>
            <Field label="Alamat">{(id) => <textarea id={id} className="textarea" style={{ minHeight: 72 }} value={f.address} onChange={set('address')} required minLength={3} maxLength={500} />}</Field>
            <Field label="Keluhan" hint="Ceritakan singkat kondisi atau kekhawatiran tentang anak.">
              {(id) => <textarea id={id} className="textarea" value={f.complaint} onChange={set('complaint')} required minLength={2} maxLength={2000} />}
            </Field>
            <div className="form-grid">
              <Field label="Hari pemeriksaan asesmen">
                {(id) => <input id={id} className="input" type="date" value={f.assessmentDate} min={org.today} max={addDays(org.today, 180)} onChange={set('assessmentDate')} required />}
              </Field>
              <Field label="Jam pemeriksaan asesmen">{(id) => <input id={id} className="input" type="time" value={f.assessmentTime} onChange={set('assessmentTime')} required />}</Field>
            </div>
            {/* Jebakan bot: tersembunyi dari pengguna dan pembaca layar. */}
            <input className="hp-field" type="text" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" value={f.website} onChange={set('website')} />
            <label className="check">
              <input type="checkbox" checked={f.agree} onChange={(e) => setF({ ...f, agree: e.target.checked })} required />
              <span>Data di atas benar, dan saya menyetujui {org.organizationName} menyimpan serta menggunakannya untuk pendaftaran dan layanan terapi anak saya.</span>
            </label>
            <ErrorBox error={error} />
            <button className="btn" disabled={busy}>
              {busy ? 'Mengirim…' : 'Kirim pendaftaran'}
            </button>
          </form>
        ) : null}
      </main>
    </div>
  );
}
