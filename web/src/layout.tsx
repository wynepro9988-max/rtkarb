import { useEffect, useState } from 'react';
import { Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { post } from './api.ts';
import { useAuth } from './auth.tsx';
import { formatDateTime } from './format.ts';
import { Icon, Loading, LOGO_ALT, logoUrl, useToast } from './ui.tsx';

interface NavItem {
  to: string;
  label: string;
  icon: string;
  perms: string[];
}

const SECTIONS: { title: string; items: NavItem[] }[] = [
  { title: 'Orang tua', items: [{ to: '/orang-tua', label: 'Dasbor Anak', icon: 'home', perms: ['portal.view'] }] },
  {
    title: 'Layanan',
    items: [
      { to: '/dasbor', label: 'Dasbor', icon: 'home', perms: ['org.read'] },
      { to: '/jadwal', label: 'Jadwal & Sesi', icon: 'calendar', perms: ['schedule.read', 'schedule.read.own'] },
      { to: '/pasien', label: 'Pasien', icon: 'users', perms: ['patient.read', 'patient.read.assigned'] },
      { to: '/pengingat', label: 'Pengingat', icon: 'bell', perms: ['reminder.send'] },
    ],
  },
  {
    title: 'Keuangan',
    items: [
      { to: '/keuangan', label: 'Pembayaran & Kas', icon: 'wallet', perms: ['payment.read', 'expense.read'] },
      { to: '/honor', label: 'Honor Terapis', icon: 'coins', perms: ['compensation.read', 'compensation.read.own'] },
    ],
  },
  {
    title: 'Pengelolaan',
    items: [
      { to: '/laporan', label: 'Laporan', icon: 'chart', perms: ['report.operational', 'report.finance'] },
      { to: '/staf', label: 'Staf', icon: 'staff', perms: ['staff.read'] },
      { to: '/pengaturan', label: 'Pengaturan', icon: 'settings', perms: ['org.settings.manage', 'catalog.manage'] },
      { to: '/audit', label: 'Audit Log', icon: 'shield', perms: ['audit.read'] },
      { to: '/privasi', label: 'Privasi Data', icon: 'lock', perms: ['privacy.manage'] },
      { to: '/dukungan', label: 'Akses Dukungan', icon: 'support', perms: ['support.approve'] },
    ],
  },
];

const PLATFORM_NAV: NavItem[] = [{ to: '/platform', label: 'Dukungan Teknis', icon: 'support', perms: [] }];

function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '')).toUpperCase();
}

const PORTAL_PATHS = ['/orang-tua', '/profil'];

export const homePath = (mode: string | undefined) => (mode === 'platform' ? '/platform' : mode === 'portal' ? '/orang-tua' : '/dasbor');

export function RequireAuth() {
  const { me, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Loading />;
  if (!me) return <Navigate to="/masuk" replace state={{ from: location.pathname }} />;
  if (me.mode === 'portal' && !PORTAL_PATHS.includes(location.pathname)) return <Navigate to="/orang-tua" replace />;
  return <AppShell />;
}

function AppShell() {
  const { me, can, logout, reload } = useAuth();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();

  useEffect(() => setOpen(false), [location.pathname]);
  if (!me) return null;

  const sections =
    me.mode === 'platform'
      ? [{ title: 'Platform', items: PLATFORM_NAV }]
      : SECTIONS.map((s) => ({ ...s, items: s.items.filter((i) => can(...i.perms) && !(i.to === '/dukungan' && me.mode === 'support')) })).filter(
          (s) => s.items.length,
        );

  const exitSupport = async () => {
    await post('/platform/support/exit');
    await reload();
    navigate('/platform');
    toast('Keluar dari mode dukungan');
  };

  return (
    <div className="shell">
      {open ? <div className="scrim" onClick={() => setOpen(false)} /> : null}
      <aside className={`sidebar${open ? ' open' : ''}`} aria-label="Navigasi utama">
        <div className="brand">
          <span className="brand-logo">
            <img src={logoUrl} alt={LOGO_ALT} />
          </span>
          {me.organization ? (
            <div className="org">
              {me.organization.name}
              <small>{me.membership?.roleLabel ?? (me.mode === 'support' ? 'Mode dukungan teknis' : '')}</small>
            </div>
          ) : (
            <div className="org">
              Admin teknis platform
              <small>Tanpa akses data organisasi</small>
            </div>
          )}
        </div>
        <nav className="nav">
          {sections.map((s) => (
            <div key={s.title}>
              <div className="nav-section">{s.title}</div>
              {s.items.map((i) => (
                <NavLink key={i.to} to={i.to}>
                  <Icon name={i.icon} /> {i.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="who">
            <span className="avatar" aria-hidden="true">
              {initials(me.user.fullName)}
            </span>
            <div>
              <strong>{me.user.fullName}</strong>
              <span>{me.user.username ?? me.user.email}</span>
            </div>
          </div>
          <div className="nav">
            <NavLink to="/profil">
              <Icon name="user" /> Profil & Keamanan
            </NavLink>
            <a
              href="/masuk"
              onClick={async (e) => {
                e.preventDefault();
                await logout();
                navigate('/masuk', { replace: true });
              }}
            >
              <Icon name="logout" /> Keluar
            </a>
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <button className="icon-btn" type="button" onClick={() => setOpen(true)} aria-label="Buka menu">
            <Icon name="menu" />
          </button>
          <img src={logoUrl} alt={LOGO_ALT} />
          <span className="org">{me.organization?.name ?? 'Platform'}</span>
        </header>
        {me.mode === 'support' && me.support ? (
          <div className="support-banner" role="status">
            <span>
              <strong>Mode dukungan teknis (baca-saja)</strong> — {me.organization?.name}. Semua aktivitas tercatat. Berakhir{' '}
              {formatDateTime(me.support.expiresAt, me.organization?.timezone)}.
            </span>
            <button className="btn btn-sm btn-secondary" type="button" onClick={exitSupport}>
              Keluar dari mode dukungan
            </button>
          </div>
        ) : null}
        <main className="content" id="konten">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export function HomeRedirect() {
  const { me } = useAuth();
  return <Navigate to={homePath(me?.mode)} replace />;
}

export function NotFound() {
  return (
    <div className="card card-pad">
      <h2>Halaman tidak ditemukan</h2>
      <p className="muted" style={{ marginTop: 6 }}>
        Halaman yang Anda cari tidak ada atau Anda tidak memiliki akses.
      </p>
    </div>
  );
}
