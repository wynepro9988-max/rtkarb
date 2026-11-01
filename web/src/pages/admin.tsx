import { useState } from 'react';
import { useNavigate } from 'react-router';
import { post, qs, useApi } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { addDays, formatBytes, formatDateTime, formatNumber, todayIn } from '../format.ts';
import { Badge, Dialog, Empty, ErrorBox, Field, Loading, PageHeader, useSubmit, useToast } from '../ui.tsx';

// ---------------------------------------------------------------------------
// Audit log (owner)
// ---------------------------------------------------------------------------
export function AuditPage() {
  const { me } = useAuth();
  const tz = me?.organization?.timezone;
  const [range, setRange] = useState(() => ({ from: addDays(todayIn(tz), -7), to: todayIn(tz) }));
  const [action, setAction] = useState('');
  const [offset, setOffset] = useState(0);
  const { data, error, loading } = useApi<{ total: number; items: any[] }>(`/audit${qs({ ...range, action, limit: 100, offset })}`);
  return (
    <>
      <PageHeader title="Audit Log" subtitle="Jejak tindakan di organisasi Anda. Catatan tidak dapat diubah atau dihapus. Isi klinis tidak pernah dicatat di sini." />
      <div className="row" style={{ marginBottom: 14 }}>
        <Field label="Dari">{(id) => <input id={id} className="input" type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />}</Field>
        <Field label="Sampai">{(id) => <input id={id} className="input" type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />}</Field>
        <Field label="Jenis tindakan">
          {(id) => (
            <select id={id} className="select" value={action} onChange={(e) => (setAction(e.target.value), setOffset(0))}>
              <option value="">Semua</option>
              <option value="auth">Login / keamanan akun</option>
              <option value="staf">Staf</option>
              <option value="pasien">Pasien</option>
              <option value="catatan">Catatan terapi</option>
              <option value="sesi">Sesi</option>
              <option value="jadwal">Jadwal</option>
              <option value="pembayaran">Pembayaran</option>
              <option value="paket">Paket</option>
              <option value="laporan">Ekspor laporan</option>
              <option value="dokumen">Dokumen</option>
              <option value="dukungan">Akses dukungan teknis</option>
            </select>
          )}
        </Field>
      </div>
      <section className="card">
        {loading && !data ? <Loading /> : null}
        <ErrorBox error={error} />
        {data?.items.length === 0 ? <Empty title="Tidak ada aktivitas pada rentang ini" /> : null}
        {data?.items.length ? (
          <div className="table-wrap">
            <table className="table responsive">
              <thead>
                <tr>
                  <th>Waktu</th>
                  <th>Pelaku</th>
                  <th>Tindakan</th>
                  <th>Objek</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((l) => (
                  <tr key={l.id}>
                    <td data-label="Waktu" className="small">
                      {formatDateTime(l.createdAt, me?.organization?.timezone)}
                    </td>
                    <td data-label="Pelaku">
                      {l.actorName ?? <span className="muted">Sistem</span>} {l.viaSupport ? <Badge tone="star">Dukungan</Badge> : null}
                    </td>
                    <td data-label="Tindakan" className="mono small">
                      {l.action}
                    </td>
                    <td data-label="Objek" className="small">
                      {l.entityType ? `${l.entityType} ${String(l.entityId ?? '').slice(0, 8)}` : '—'}
                    </td>
                    <td data-label="Detail" className="small mono" style={{ maxWidth: 360, overflowWrap: 'anywhere' }}>
                      {Object.keys(l.meta ?? {}).length ? JSON.stringify(l.meta) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {data && data.total > 100 ? (
          <div className="card-body spread">
            <span className="small muted">
              {offset + 1}–{Math.min(offset + 100, data.total)} dari {data.total}
            </span>
            <div className="row">
              <button className="btn btn-sm btn-secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 100))}>
                Sebelumnya
              </button>
              <button className="btn btn-sm btn-secondary" disabled={offset + 100 >= data.total} onClick={() => setOffset(offset + 100)}>
                Berikutnya
              </button>
            </div>
          </div>
        ) : null}
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Akses dukungan teknis — sisi owner
// ---------------------------------------------------------------------------
const SCOPE_LABELS: Record<string, string> = {
  'staff.read': 'Daftar staf',
  'patient.read': 'Data administratif pasien',
  'schedule.read': 'Jadwal',
  'package.read': 'Paket',
  'payment.read': 'Pembayaran',
  'expense.read': 'Pengeluaran',
  'compensation.read': 'Honor terapis',
  'report.operational': 'Laporan operasional',
  'report.finance': 'Laporan keuangan',
  'audit.read': 'Audit log',
  'document.read': 'Dokumen pasien',
  'therapy.note.read': 'CATATAN KLINIS',
};

const STATE: Record<string, { label: string; tone: string }> = {
  menunggu: { label: 'Menunggu keputusan', tone: 'warn' },
  aktif: { label: 'Aktif', tone: 'star' },
  kedaluwarsa: { label: 'Kedaluwarsa', tone: '' },
  ditolak: { label: 'Ditolak', tone: '' },
  dicabut: { label: 'Dicabut', tone: 'danger' },
  disetujui: { label: 'Disetujui', tone: 'info' },
};

function Scopes({ scopes }: { scopes: string[] }) {
  return (
    <div className="row" style={{ gap: 6 }}>
      {scopes.map((s) => (
        <Badge key={s} tone={s === 'therapy.note.read' ? 'danger' : ''}>
          {SCOPE_LABELS[s] ?? s}
        </Badge>
      ))}
    </div>
  );
}

export function SupportApprovalPage() {
  const { me } = useAuth();
  const toast = useToast();
  const { data, error, loading, reload } = useApi<any[]>('/support/requests');
  const decide = async (id: string, path: 'approve' | 'reject' | 'revoke', text: string) => {
    if (!confirm(text)) return;
    try {
      await post(`/support/requests/${id}/${path}`, {});
      toast('Keputusan disimpan');
      reload();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  return (
    <>
      <PageHeader
        title="Akses Dukungan Teknis"
        subtitle="Admin teknis platform tidak dapat melihat data organisasi Anda tanpa persetujuan. Akses bersifat baca-saja, berbatas waktu, dapat dicabut, dan seluruh aktivitasnya tercatat di audit log."
      />
      <section className="card">
        {loading && !data ? <Loading /> : null}
        <ErrorBox error={error} />
        {data?.length === 0 ? <Empty title="Belum ada permintaan akses" /> : null}
        {data?.map((g) => (
          <div key={g.id} className="card-body" style={{ borderBottom: '1px solid var(--c-border)' }}>
            <div className="spread">
              <div>
                <strong>{g.requestedByName}</strong> <Badge tone={STATE[g.state]?.tone}>{STATE[g.state]?.label ?? g.state}</Badge>
                <div className="small muted">
                  Diajukan {formatDateTime(g.createdAt, me?.organization?.timezone)} · durasi {g.durationMinutes} menit
                  {g.expiresAt ? ` · berakhir ${formatDateTime(g.expiresAt, me?.organization?.timezone)}` : ''}
                </div>
              </div>
              <div className="row">
                {g.state === 'menunggu' ? (
                  <>
                    <button className="btn btn-sm" onClick={() => decide(g.id, 'approve', `Setujui akses baca-saja selama ${g.durationMinutes} menit?`)}>
                      Setujui
                    </button>
                    <button className="btn btn-sm btn-secondary" onClick={() => decide(g.id, 'reject', 'Tolak permintaan ini?')}>
                      Tolak
                    </button>
                  </>
                ) : null}
                {g.state === 'aktif' ? (
                  <button className="btn btn-sm btn-danger" onClick={() => decide(g.id, 'revoke', 'Cabut akses sekarang? Admin teknis langsung keluar dari data Anda.')}>
                    Cabut sekarang
                  </button>
                ) : null}
              </div>
            </div>
            <p style={{ margin: '8px 0' }}>
              <span className="muted">Alasan:</span> {g.reason}
            </p>
            <Scopes scopes={g.scopes} />
            {g.scopes.includes('therapy.note.read') && g.state === 'menunggu' ? (
              <div className="alert warn" style={{ marginTop: 8 }}>
                Permintaan ini mencakup <strong>catatan klinis anak</strong>. Setujui hanya bila benar-benar diperlukan.
              </div>
            ) : null}
          </div>
        ))}
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Sisi admin teknis platform
// ---------------------------------------------------------------------------
export function PlatformPage() {
  const { me, reload: reloadMe } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const { data: orgs } = useApi<any[]>('/platform/organizations');
  const { data: requests, error, loading, reload } = useApi<any[]>('/platform/support-requests');
  const [requesting, setRequesting] = useState(false);

  const enter = async (id: string) => {
    try {
      await post(`/platform/support-requests/${id}/enter`);
      await reloadMe();
      toast('Masuk mode dukungan (baca-saja)');
      navigate('/dasbor');
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  return (
    <>
      <PageHeader
        title="Dukungan Teknis"
        subtitle="Akun admin teknis tidak memiliki akses data organisasi. Ajukan akses terbatas; owner organisasi yang memutuskan."
        actions={
          <button className="btn" onClick={() => setRequesting(true)}>
            Ajukan akses
          </button>
        }
      />
      <div className="alert info" style={{ marginBottom: 16 }}>
        Utamakan debugging dengan metadata teknis dan data sintetis. Jangan menyalin data pasien ke tiket, chat, atau log.
      </div>
      <UsagePanel />
      <section className="card">
        <div className="card-head">
          <h2>Permintaan saya</h2>
        </div>
        {loading && !requests ? <Loading /> : null}
        <ErrorBox error={error} />
        {requests?.length === 0 ? <Empty title="Belum ada permintaan" /> : null}
        {requests?.map((g) => (
          <div key={g.id} className="card-body spread" style={{ borderBottom: '1px solid var(--c-border)' }}>
            <div>
              <strong>{g.organizationName}</strong> <Badge tone={STATE[g.state]?.tone}>{STATE[g.state]?.label ?? g.state}</Badge>
              <div className="small muted">
                {g.reason} · {g.durationMinutes} menit{g.expiresAt ? ` · berakhir ${formatDateTime(g.expiresAt)}` : ''}
              </div>
              <div style={{ marginTop: 6 }}>
                <Scopes scopes={g.scopes} />
              </div>
            </div>
            {g.state === 'aktif' && me?.mode === 'platform' ? (
              <button className="btn btn-sm" onClick={() => enter(g.id)}>
                Masuk (baca-saja)
              </button>
            ) : null}
          </div>
        ))}
      </section>
      {requesting ? (
        <RequestDialog
          orgs={orgs ?? []}
          onClose={() => setRequesting(false)}
          onSaved={() => {
            toast('Permintaan dikirim ke owner organisasi');
            reload();
          }}
        />
      ) : null}
    </>
  );
}

function UsageBar({ label, used, limit }: { label: string; used: number; limit: number }) {
  const pct = Math.min(100, (used / limit) * 100);
  const tone = pct >= 90 ? 'var(--c-danger)' : pct >= 80 ? 'var(--c-warning)' : 'var(--c-primary)';
  return (
    <div style={{ marginBottom: 12 }}>
      <div className="spread small">
        <strong>{label}</strong>
        <span className="mono">
          {formatBytes(used)} / {formatBytes(limit)} ({pct.toFixed(1)}%)
        </span>
      </div>
      <div style={{ height: 10, background: 'var(--c-surface-2)', border: '1px solid var(--c-border)', borderRadius: 6, marginTop: 4 }}>
        <div style={{ width: `${pct}%`, height: '100%', background: tone, borderRadius: 6 }} />
      </div>
    </div>
  );
}

// Kapasitas dibanding batas paket database & penyimpanan (angka agregat saja).
function UsagePanel() {
  const { data, error } = useApi<any>('/platform/usage');
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;
  const warn = data.database.usedBytes > data.database.limitBytes * 0.8 || data.storage.usedBytes > data.storage.limitBytes * 0.8;
  return (
    <section className="card card-pad" style={{ marginBottom: 16 }}>
      <h2 style={{ marginBottom: 12 }}>Kapasitas</h2>
      {warn ? <div className="alert warn" style={{ marginBottom: 12 }}>Pemakaian di atas 80% batas paket. Arsipkan audit lama atau tingkatkan paket sebelum penuh.</div> : null}
      <UsageBar label="Database" used={data.database.usedBytes} limit={data.database.limitBytes} />
      <UsageBar label="Penyimpanan dokumen" used={data.storage.usedBytes} limit={data.storage.limitBytes} />
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Organisasi</th>
              <th className="num">Dokumen</th>
              <th className="num">Pasien</th>
              <th className="num">Catatan</th>
              <th className="num">Baris audit</th>
            </tr>
          </thead>
          <tbody>
            {data.organizations.map((o: any) => (
              <tr key={o.orgId}>
                <td>{o.orgName}</td>
                <td className="num">
                  {formatBytes(o.storageBytes)} / {formatBytes(data.storage.orgQuotaBytes)}
                </td>
                <td className="num">{formatNumber(o.patientCount)}</td>
                <td className="num">{formatNumber(o.noteCount)}</td>
                <td className="num">{formatNumber(o.auditRows)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RequestDialog({ orgs, onClose, onSaved }: { orgs: any[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ organizationId: '', reason: '', durationMinutes: 60, scopes: ['patient.read', 'schedule.read'] as string[] });
  const { busy, error, submit } = useSubmit(() => post('/platform/support-requests', f), () => {
    onSaved();
    onClose();
  });
  const toggle = (s: string) => setF({ ...f, scopes: f.scopes.includes(s) ? f.scopes.filter((x) => x !== s) : [...f.scopes, s] });
  return (
    <Dialog title="Ajukan akses dukungan" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <Field label="Organisasi">
          {(id) => (
            <select id={id} className="select" value={f.organizationId} onChange={(e) => setF({ ...f, organizationId: e.target.value })} required>
              <option value="">Pilih…</option>
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Alasan" hint="Jelaskan masalah yang diselidiki (minimal 10 karakter). Owner membaca alasan ini.">
          {(id) => <textarea id={id} className="textarea" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} required minLength={10} maxLength={1000} />}
        </Field>
        <Field label="Durasi">
          {(id) => (
            <select id={id} className="select" value={f.durationMinutes} onChange={(e) => setF({ ...f, durationMinutes: Number(e.target.value) })}>
              {[15, 30, 60, 120, 240, 480].map((m) => (
                <option key={m} value={m}>
                  {m < 60 ? `${m} menit` : `${m / 60} jam`}
                </option>
              ))}
            </select>
          )}
        </Field>
        <div className="field">
          <span className="label">Cakupan (baca-saja)</span>
          {Object.entries(SCOPE_LABELS).map(([s, label]) => (
            <label key={s} className="check">
              <input type="checkbox" checked={f.scopes.includes(s)} onChange={() => toggle(s)} /> {label}
            </label>
          ))}
          <span className="hint">Pilih seminimal mungkin. Sebagian besar cakupan memerlukan "Data administratif pasien".</span>
        </div>
        <ErrorBox error={error} />
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Batal
          </button>
          <button className="btn" disabled={busy || f.scopes.length === 0}>
            Kirim permintaan
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Profil & keamanan akun
// ---------------------------------------------------------------------------
export function ProfilePage() {
  const { me, reload } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [f, setF] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [u, setU] = useState({ username: me?.user.username ?? '', currentPassword: '' });
  const usernameForm = useSubmit(() => post('/auth/username', u), () => {
    toast('Username disimpan. Gunakan username ini saat masuk berikutnya.');
    setU({ ...u, currentPassword: '' });
    reload();
  });
  const { busy, error, submit } = useSubmit(() => post('/auth/change-password', { currentPassword: f.currentPassword, newPassword: f.newPassword }), () => {
    toast('Kata sandi diganti. Sesi di perangkat lain telah ditutup.');
    setF({ currentPassword: '', newPassword: '', confirm: '' });
  });
  const logoutAll = async () => {
    if (!confirm('Keluar dari semua perangkat, termasuk perangkat ini?')) return;
    await post('/auth/logout-all');
    navigate('/masuk', { replace: true });
    window.location.reload();
  };
  if (!me) return null;
  return (
    <>
      <PageHeader title="Profil & Keamanan" />
      <div className="grid grid-2">
        <section className="card card-pad">
          <h2 style={{ marginBottom: 12 }}>Akun</h2>
          <dl className="kv">
            <dt>Nama</dt>
            <dd>{me.user.fullName}</dd>
            <dt>Username</dt>
            <dd>{me.user.username ?? 'Belum diatur'}</dd>
            {me.user.email ? (
              <>
                <dt>Email</dt>
                <dd>{me.user.email}</dd>
              </>
            ) : null}
            <dt>Organisasi</dt>
            <dd>{me.organization?.name ?? 'Platform'}</dd>
            <dt>Peran</dt>
            <dd>{me.membership?.roleLabel ?? (me.mode === 'platform' ? 'Admin teknis platform' : 'Mode dukungan')}</dd>
          </dl>
          <button className="btn btn-secondary" style={{ marginTop: 16 }} onClick={logoutAll}>
            Keluar dari semua perangkat
          </button>
        </section>
        <section className="card card-pad">
          <h2 style={{ marginBottom: 12 }}>{me.user.username ? 'Ganti username' : 'Atur username'}</h2>
          <form className="form" onSubmit={usernameForm.submit}>
            <Field label="Username" hint="3–32 karakter: huruf kecil, angka, titik, garis bawah, atau tanda hubung.">
              {(id) => (
                <input id={id} className="input" autoComplete="username" autoCapitalize="none" spellCheck={false} value={u.username} onChange={(e) => setU({ ...u, username: e.target.value.toLowerCase() })} required minLength={3} maxLength={32} />
              )}
            </Field>
            <Field label="Kata sandi saat ini">
              {(id) => <input id={id} className="input" type="password" autoComplete="current-password" value={u.currentPassword} onChange={(e) => setU({ ...u, currentPassword: e.target.value })} required />}
            </Field>
            <ErrorBox error={usernameForm.error} />
            <div className="form-actions">
              <button className="btn" disabled={usernameForm.busy}>
                Simpan username
              </button>
            </div>
          </form>
        </section>
        <section className="card card-pad">
          <h2 style={{ marginBottom: 12 }}>Ganti kata sandi</h2>
          <form className="form" onSubmit={submit}>
            <Field label="Kata sandi saat ini">
              {(id) => <input id={id} className="input" type="password" autoComplete="current-password" value={f.currentPassword} onChange={(e) => setF({ ...f, currentPassword: e.target.value })} required />}
            </Field>
            <Field label="Kata sandi baru" hint="Minimal 10 karakter">
              {(id) => <input id={id} className="input" type="password" autoComplete="new-password" value={f.newPassword} onChange={(e) => setF({ ...f, newPassword: e.target.value })} minLength={10} required />}
            </Field>
            <Field label="Ulangi kata sandi baru" error={f.confirm && f.confirm !== f.newPassword ? 'Belum sama' : undefined}>
              {(id) => <input id={id} className="input" type="password" autoComplete="new-password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} required />}
            </Field>
            <ErrorBox error={error} />
            <div className="form-actions">
              <button className="btn" disabled={busy || f.confirm !== f.newPassword}>
                Simpan
              </button>
            </div>
          </form>
        </section>
      </div>
    </>
  );
}
