import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import logoUrl from '../../brand/logo-rumah-bintang.jpg';
import { ApiError } from './api.ts';

export { logoUrl };
export const LOGO_ALT = 'Logo Rumah Bintang — Pusat Kemandirian dan Tumbuh Kembang Anak';

// ---------- Ikon (garis sederhana, 24x24) ----------
const paths: Record<string, string> = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  users: 'M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7m13 9v-1a4 4 0 0 0-3-3.87M16 3.13a3.5 3.5 0 0 1 0 6.75',
  calendar: 'M8 2v4m8-4v4M3 9h18M5 4h14a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2',
  note: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zm0 0v5h5M9 13h6m-6 4h4',
  wallet: 'M20 7H5a2 2 0 0 1 0-4h13v4m2 0v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5m14 9h.01',
  coins: 'M12 8c4.4 0 8-1.3 8-3s-3.6-3-8-3-8 1.3-8 3 3.6 3 8 3m-8-3v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  chart: 'M3 3v18h18M8 17V11m5 6V7m5 10v-4',
  staff: 'M15 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1m6-9a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7m10 2v6m3-3h-6',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6m7.4-3a7.4 7.4 0 0 0-.1-1.3l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2.2-1.3L14.4 3h-4l-.4 2.5a7 7 0 0 0-2.2 1.3l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.6l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2.2 1.3l.4 2.5h4l.4-2.5a7 7 0 0 0 2.2-1.3l2.4 1 2-3.4-2-1.6c.1-.4.1-.9.1-1.3',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10',
  support: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20m0-6a4 4 0 1 0 0-8 4 4 0 0 0 0 8M4.9 4.9l4.3 4.3m5.6 5.6 4.3 4.3m0-14.2-4.3 4.3m-5.6 5.6-4.3 4.3',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4m7 14 5-5-5-5m5 5H9',
  menu: 'M3 6h18M3 12h18M3 18h18',
  x: 'M18 6 6 18M6 6l12 12',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16m10 2-4.35-4.35',
  plus: 'M12 5v14m-7-7h14',
  back: 'M15 18l-6-6 6-6',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4m4-5 5 5 5-5m-5 5V3',
  print: 'M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6z',
  check: 'M20 6 9 17l-5-5',
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2m8-10a4 4 0 1 0 0-8 4 4 0 0 0 0 8',
  file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zm0 0v5h5',
  bell: 'M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9m4.3 13a1.94 1.94 0 0 0 3.4 0',
  lock: 'M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2m2 0V7a5 5 0 0 1 10 0v4',
};

export function Icon({ name, title }: { name: keyof typeof paths | string; title?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title ? <title>{title}</title> : null}
      <path d={paths[name] ?? ''} />
    </svg>
  );
}

// ---------- Dasar ----------
export function PageHeader({ title, subtitle, actions, back }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: { to: string; label: string } }) {
  return (
    <>
      {back ? (
        <Link className="back-link" to={back.to}>
          <Icon name="back" /> {back.label}
        </Link>
      ) : null}
      <div className="page-head">
        <div>
          <h1>{title}</h1>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        {actions ? <div className="page-actions">{actions}</div> : null}
      </div>
    </>
  );
}

export function Loading() {
  return (
    <div className="loading" role="status" aria-live="polite">
      <div className="spinner" />
      <span className="sr-only">Memuat…</span>
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const err = error as ApiError;
  return (
    <div className="alert error" role="alert">
      {err.message || 'Terjadi kesalahan'}
      {err.details?.length ? (
        <ul>
          {err.details.map((d, i) => (
            <li key={i}>{d.message}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children}
    </div>
  );
}

export function Badge({ tone = '', children }: { tone?: string; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

// Deretan angka ringkasan dalam satu panel bersekat.
export function StatStrip({ children }: { children: ReactNode }) {
  return <div className="card stat-strip">{children}</div>;
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.value} role="tab" type="button" aria-selected={t.value === value} onClick={() => onChange(t.value)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ---------- Formulir ----------
export function Field({ label, hint, error, children, full }: { label: string; hint?: string; error?: string; children: (id: string) => ReactNode; full?: boolean }) {
  const id = useId();
  return (
    <div className={`field${full ? ' full' : ''}`}>
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {hint ? <span className="hint">{hint}</span> : null}
      {error ? <span className="err">{error}</span> : null}
    </div>
  );
}

export function Dialog({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('input, select, textarea, button:not(.icon-btn)')?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`dialog${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="dialog-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Tutup">
            <Icon name="x" />
          </button>
        </div>
        <div className="dialog-body">{children}</div>
      </div>
    </div>
  );
}

// Formulir dengan status kirim & error terpadu.
export function useSubmit<T>(fn: () => Promise<T>, onDone?: (r: T) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      setBusy(true);
      setError(null);
      try {
        const r = await fn();
        onDone?.(r);
      } catch (err) {
        setError(err);
      } finally {
        setBusy(false);
      }
    },
    [fn, onDone],
  );
  return { busy, error, submit, setError };
}

export function ReasonDialog({ title, description, confirmLabel, danger, onClose, onConfirm, minLength = 5 }: {
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  minLength?: number;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<unknown>;
}) {
  const [reason, setReason] = useState('');
  const { busy, error, submit } = useSubmit(() => onConfirm(reason.trim()), onClose);
  return (
    <Dialog title={title} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        {description ? <p className="muted">{description}</p> : null}
        <Field label="Alasan" hint={`Wajib diisi, minimal ${minLength} karakter. Tercatat di audit log.`}>
          {(id) => <textarea id={id} className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} required minLength={minLength} maxLength={500} />}
        </Field>
        <ErrorBox error={error} />
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Batal
          </button>
          <button className={`btn${danger ? ' btn-danger' : ''}`} disabled={busy || reason.trim().length < minLength}>
            {busy ? 'Menyimpan…' : confirmLabel}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// Input nominal rupiah: menampilkan pemisah ribuan, menyimpan angka bulat.
export function MoneyInput({ id, value, onChange, required }: { id: string; value: number | ''; onChange: (v: number | '') => void; required?: boolean }) {
  const display = value === '' ? '' : new Intl.NumberFormat('id-ID').format(value);
  return (
    <input
      id={id}
      className="input mono"
      inputMode="numeric"
      autoComplete="off"
      placeholder="0"
      value={display}
      required={required}
      onChange={(e) => {
        const digits = e.target.value.replace(/\D/g, '').slice(0, 13);
        onChange(digits === '' ? '' : Number(digits));
      }}
    />
  );
}

// ---------- Toast ----------
interface Toast {
  id: number;
  text: string;
  tone: 'ok' | 'error';
}
const ToastContext = createContext<(text: string, tone?: 'ok' | 'error') => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: 'ok' | 'error' = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.tone === 'error' ? ' error' : ''}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
export const useToast = () => useContext(ToastContext);
