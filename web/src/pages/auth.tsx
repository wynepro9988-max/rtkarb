import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { post } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { formatDateTime } from '../format.ts';
import { ErrorBox, Field, Loading, LOGO_ALT, logoUrl, useSubmit } from '../ui.tsx';

// Busur bintang dari logo, digambar ulang sebagai latar dekoratif (bukan pengganti logo).
function StarArc() {
  const stars = Array.from({ length: 9 }, (_, i) => {
    const angle = Math.PI * (1 + (i + 1) / 10);
    const size = 13 + 11 * (1 - Math.abs(i - 4) / 4);
    return { x: 300 + 250 * Math.cos(angle), y: 290 + 250 * Math.sin(angle), r: size, center: i === 4 };
  });
  const star = (cx: number, cy: number, r: number) =>
    Array.from({ length: 10 }, (_, k) => {
      const a = -Math.PI / 2 + (k * Math.PI) / 5;
      const rr = k % 2 ? r * 0.45 : r;
      return `${(cx + rr * Math.cos(a)).toFixed(1)},${(cy + rr * Math.sin(a)).toFixed(1)}`;
    }).join(' ');
  return (
    <svg className="auth-arc" viewBox="30 10 540 240" aria-hidden="true">
      {stars.map((s, i) => (
        <polygon key={i} points={star(s.x, s.y, s.r)} fill={s.center ? '#4a8fd9' : '#ef8a19'} />
      ))}
    </svg>
  );
}

function AuthCard({ title, lead, children }: { title: string; lead?: string; children: React.ReactNode }) {
  return (
    <div className="auth-page">
      <aside className="auth-aside">
        <StarArc />
        <p className="auth-aside-name">Rumah Bintang</p>
        <p className="auth-aside-tag">Pusat Kemandirian dan Tumbuh Kembang Anak</p>
        <p className="auth-aside-foot">Data anak hanya dapat dibuka oleh staf organisasinya sendiri, dan setiap akses tercatat.</p>
      </aside>
      <main className="auth-main">
        <div className="auth-card">
          <div className="brand">
            <img src={logoUrl} alt={LOGO_ALT} />
          </div>
          <h1>{title}</h1>
          {lead ? <p className="lead">{lead}</p> : null}
          {children}
          <p className="auth-foot">Data anak dilindungi. Setiap akses tercatat.</p>
        </div>
      </main>
    </div>
  );
}

export function LoginPage() {
  const { me, reload } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { busy, error, submit } = useSubmit(
    async () => {
      await post('/auth/login', { email, password });
      return reload();
    },
    (m) => navigate(m?.mode === 'platform' ? '/platform' : ((location.state as { from?: string } | null)?.from ?? '/dasbor'), { replace: true }),
  );
  if (me) return <Navigate to="/" replace />;

  return (
    <AuthCard title="Masuk" lead="Gunakan akun yang diberikan oleh pengelola organisasi Anda.">
      <form className="form" onSubmit={submit}>
        <Field label="Email">
          {(id) => <input id={id} className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />}
        </Field>
        <Field label="Kata sandi">
          {(id) => (
            <input id={id} className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          )}
        </Field>
        <ErrorBox error={error} />
        <button className="btn" disabled={busy}>
          {busy ? 'Memproses…' : 'Masuk'}
        </button>
        <p className="small muted">
          Lupa kata sandi? Minta tautan reset kepada owner organisasi Anda.
        </p>
      </form>
    </AuthCard>
  );
}

// Token dibaca dari fragmen URL (#token=...) lalu dihapus dari address bar.
function useFragmentToken() {
  const [token] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '');
  useEffect(() => {
    if (window.location.hash) history.replaceState(null, '', window.location.pathname);
  }, []);
  return token;
}

interface TokenInfo {
  purpose: string;
  email: string;
  fullName: string | null;
  role: string | null;
  organizationName: string;
  expiresAt: string;
}

function useTokenInfo(token: string) {
  const [info, setInfo] = useState<TokenInfo | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (!token) {
      setError(new Error('Tautan tidak lengkap. Buka kembali tautan yang Anda terima.'));
      return;
    }
    post<TokenInfo>('/auth/token-info', { token }).then(setInfo, setError);
  }, [token]);
  return { info, error };
}

function PasswordFields({ password, setPassword, confirm, setConfirm }: { password: string; setPassword: (v: string) => void; confirm: string; setConfirm: (v: string) => void }) {
  return (
    <>
      <Field label="Kata sandi baru" hint="Minimal 10 karakter. Gunakan kombinasi kata yang mudah Anda ingat namun sulit ditebak orang lain.">
        {(id) => <input id={id} className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={10} required />}
      </Field>
      <Field label="Ulangi kata sandi" error={confirm && confirm !== password ? 'Kata sandi belum sama' : undefined}>
        {(id) => <input id={id} className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />}
      </Field>
    </>
  );
}

export function ActivatePage() {
  const token = useFragmentToken();
  const { info, error: infoError } = useTokenInfo(token);
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  useEffect(() => setFullName(info?.fullName ?? ''), [info]);
  const { busy, error, submit } = useSubmit(() => post('/auth/accept-invitation', { token, password, fullName }), () => setDone(true));

  if (done) {
    return (
      <AuthCard title="Akun aktif" lead="Akun Anda sudah aktif. Silakan masuk dengan email dan kata sandi baru Anda.">
        <Link className="btn" to="/masuk">
          Masuk
        </Link>
      </AuthCard>
    );
  }
  if (infoError) {
    return (
      <AuthCard title="Tautan tidak dapat dipakai">
        <ErrorBox error={infoError} />
      </AuthCard>
    );
  }
  if (!info) return <Loading />;
  return (
    <AuthCard title="Aktivasi akun" lead={`Anda diundang bergabung dengan ${info.organizationName}.`}>
      <form className="form" onSubmit={submit}>
        <Field label="Email">{(id) => <input id={id} className="input" value={info.email} disabled />}</Field>
        <Field label="Nama lengkap">{(id) => <input id={id} className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} required minLength={2} />}</Field>
        <PasswordFields password={password} setPassword={setPassword} confirm={confirm} setConfirm={setConfirm} />
        <p className="small muted">Tautan berlaku sampai {formatDateTime(info.expiresAt)} dan hanya dapat dipakai sekali.</p>
        <ErrorBox error={error} />
        <button className="btn" disabled={busy || password !== confirm}>
          {busy ? 'Memproses…' : 'Aktifkan akun'}
        </button>
      </form>
    </AuthCard>
  );
}

export function ResetPasswordPage() {
  const token = useFragmentToken();
  const { info, error: infoError } = useTokenInfo(token);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const { busy, error, submit } = useSubmit(() => post('/auth/reset-password', { token, password }), () => setDone(true));

  if (done) {
    return (
      <AuthCard title="Kata sandi diperbarui" lead="Semua sesi lama telah ditutup. Silakan masuk dengan kata sandi baru.">
        <Link className="btn" to="/masuk">
          Masuk
        </Link>
      </AuthCard>
    );
  }
  if (infoError) {
    return (
      <AuthCard title="Tautan tidak dapat dipakai">
        <ErrorBox error={infoError} />
      </AuthCard>
    );
  }
  if (!info) return <Loading />;
  return (
    <AuthCard title="Atur ulang kata sandi" lead={info.email}>
      <form className="form" onSubmit={submit}>
        <PasswordFields password={password} setPassword={setPassword} confirm={confirm} setConfirm={setConfirm} />
        <ErrorBox error={error} />
        <button className="btn" disabled={busy || password !== confirm}>
          {busy ? 'Menyimpan…' : 'Simpan kata sandi'}
        </button>
      </form>
    </AuthCard>
  );
}
