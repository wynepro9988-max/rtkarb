import { useState } from 'react';
import { patch, post, useApi } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { formatDateTime, ROLE_OPTIONS } from '../format.ts';
import { Badge, Dialog, Empty, ErrorBox, Field, Icon, Loading, PageHeader, useSubmit, useToast } from '../ui.tsx';

function LinkResult({ title, url, expiresAt, email, onClose }: { title: string; url: string; expiresAt: string; email?: string; onClose: () => void }) {
  const toast = useToast();
  const { me } = useAuth();
  return (
    <Dialog title={title} onClose={onClose}>
      <div className="stack">
        <div className="alert warn">
          Tautan ini hanya ditampilkan <strong>sekali</strong>. Kirimkan langsung kepada orang yang bersangkutan (mis. lewat WhatsApp pribadi). Jangan bagikan di grup.
        </div>
        <textarea className="textarea mono" readOnly value={url} onFocus={(e) => e.target.select()} style={{ minHeight: 80 }} aria-label="Tautan" />
        <p className="small muted">Berlaku sampai {formatDateTime(expiresAt, me?.organization?.timezone)} dan hanya dapat dipakai sekali.</p>
        <div className="form-actions">
          <a
            className="btn btn-secondary"
            href={`https://wa.me/?text=${encodeURIComponent(`${title} Rumah Bintang (sekali pakai, jangan diteruskan):\n${url}`)}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Kirim lewat WhatsApp
          </a>
          {email ? (
            <a
              className="btn btn-secondary"
              href={`mailto:${email}?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(`Tautan berikut berlaku sekali pakai, jangan diteruskan:\n${url}`)}`}
            >
              Kirim lewat email
            </a>
          ) : null}
          <button
            className="btn btn-secondary"
            onClick={async () => {
              await navigator.clipboard.writeText(url);
              toast('Tautan disalin');
            }}
          >
            Salin tautan
          </button>
          <button className="btn" onClick={onClose}>
            Selesai
          </button>
        </div>
      </div>
    </Dialog>
  );
}

// Hanya untuk peran admin: owner memutuskan per admin apakah ia juga memegang keuangan.
function FinanceCheck({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="field">
      <label className="check">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /> Merangkap keuangan / kasir
      </label>
      <span className="hint">
        Bisa mencatat pembayaran, pengeluaran, invoice, dan rekonsiliasi, serta melihat honor terapis dan laporan keuangan. Batas diskon sama dengan
        kasir. Catatan klinis tetap tertutup.
      </span>
    </div>
  );
}

export function StaffPage() {
  const { can, me } = useAuth();
  const toast = useToast();
  const manage = can('staff.manage');
  const { data, error, loading, reload } = useApi<any[]>('/staff');
  const { data: invitations, reload: reloadInv } = useApi<any[]>(manage ? '/staff/invitations' : null);
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);
  const [link, setLink] = useState<{ title: string; url: string; expiresAt: string; email?: string } | null>(null);

  const action = async (path: string, message: string, confirmText?: string, email?: string) => {
    if (confirmText && !confirm(confirmText)) return;
    try {
      const r = await post<any>(path);
      if (r?.url) setLink({ title: 'Tautan atur ulang kata sandi', url: r.url, expiresAt: r.expiresAt, email });
      else toast(message);
      reload();
      reloadInv();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  const pending = invitations?.filter((i) => i.state === 'menunggu') ?? [];

  return (
    <>
      <PageHeader
        title="Staf"
        subtitle={`Staf ${me?.organization?.name}. Setiap akun hanya terdaftar pada satu organisasi.`}
        actions={
          manage ? (
            <button className="btn" onClick={() => setInviting(true)}>
              <Icon name="plus" /> Undang staf
            </button>
          ) : null
        }
      />
      <section className="card">
        {loading && !data ? <Loading /> : null}
        <ErrorBox error={error} />
        {data?.length === 0 ? <Empty title="Belum ada staf" /> : null}
        {data?.length ? (
          <div className="table-wrap">
            <table className="table responsive">
              <thead>
                <tr>
                  <th>Nama</th>
                  <th>Peran</th>
                  <th>Status</th>
                  <th>Login terakhir</th>
                  {manage ? <th /> : null}
                </tr>
              </thead>
              <tbody>
                {data.map((m) => {
                  const self = m.id === me?.membership?.id;
                  const editable = manage && !self && m.role !== 'owner';
                  return (
                    <tr key={m.id}>
                      <td data-label="Nama">
                        <strong>{m.fullName}</strong> {self ? <Badge tone="info">Anda</Badge> : null}
                        <div className="small muted">{m.email}</div>
                      </td>
                      <td data-label="Peran">
                        {m.roleLabel}
                        {m.isTherapist && m.role !== 'terapis' ? <span className="muted small"> · juga terapis</span> : null}
                        {m.specialization ? <div className="small muted">{m.specialization}</div> : null}
                      </td>
                      <td data-label="Status">
                        <Badge tone={m.status === 'active' ? 'ok' : ''}>{m.status === 'active' ? 'Aktif' : 'Nonaktif'}</Badge>
                      </td>
                      <td data-label="Login terakhir" className="small">
                        {formatDateTime(m.lastLoginAt, me?.organization?.timezone)}
                      </td>
                      {manage ? (
                        <td>
                          {editable ? (
                            <div className="row">
                              <button className="btn btn-sm btn-ghost" onClick={() => setEditing(m)}>
                                Ubah
                              </button>
                              {m.status === 'active' ? (
                                <>
                                  <button className="btn btn-sm btn-ghost" onClick={() => action(`/staff/${m.id}/reset-link`, '', `Buat tautan atur ulang kata sandi untuk ${m.fullName}?`, m.email)}>
                                    Reset sandi
                                  </button>
                                  <button
                                    className="btn btn-sm btn-ghost"
                                    style={{ color: 'var(--c-danger)' }}
                                    onClick={() => action(`/staff/${m.id}/deactivate`, 'Staf dinonaktifkan', `Nonaktifkan ${m.fullName}? Semua sesi loginnya langsung diputus.`)}
                                  >
                                    Nonaktifkan
                                  </button>
                                </>
                              ) : (
                                <button className="btn btn-sm btn-ghost" onClick={() => action(`/staff/${m.id}/reactivate`, 'Staf diaktifkan kembali')}>
                                  Aktifkan
                                </button>
                              )}
                            </div>
                          ) : null}
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      {manage && pending.length ? (
        <section className="card" style={{ marginTop: 16 }}>
          <div className="card-head">
            <h2>Undangan menunggu aktivasi</h2>
          </div>
          {pending.map((i) => (
            <div key={i.id} className="card-body spread" style={{ borderBottom: '1px solid var(--c-border)' }}>
              <div>
                <strong>{i.fullName}</strong> <span className="muted">· {i.email}</span>
                <div className="small muted">
                  {i.role === 'admin' && i.handlesFinance ? 'Admin & Keuangan' : ROLE_OPTIONS.find((r) => r.value === i.role)?.label} · berlaku s.d. {formatDateTime(i.expiresAt, me?.organization?.timezone)}
                </div>
              </div>
              <button className="btn btn-sm btn-ghost" onClick={() => action(`/staff/invitations/${i.id}/revoke`, 'Undangan dibatalkan', 'Batalkan undangan ini?')}>
                Batalkan
              </button>
            </div>
          ))}
        </section>
      ) : null}

      {inviting ? (
        <InviteDialog
          onClose={() => setInviting(false)}
          onDone={(r) => {
            setInviting(false);
            setLink({ title: 'Tautan aktivasi akun', url: r.url, expiresAt: r.expiresAt, email: r.email });
            reloadInv();
          }}
        />
      ) : null}
      {editing ? <EditMemberDialog member={editing} onClose={() => setEditing(null)} onSaved={reload} /> : null}
      {link ? <LinkResult {...link} onClose={() => setLink(null)} /> : null}
    </>
  );
}

function InviteDialog({ onClose, onDone }: { onClose: () => void; onDone: (r: { url: string; expiresAt: string; email: string }) => void }) {
  const [f, setF] = useState({ email: '', fullName: '', role: 'terapis', isTherapist: false, handlesFinance: false, specialization: '' });
  const { busy, error, submit } = useSubmit(
    async () => ({
      ...(await post<{ url: string; expiresAt: string }>('/staff/invitations', {
        ...f,
        handlesFinance: f.role === 'admin' && f.handlesFinance,
        specialization: f.specialization || null,
      })),
      email: f.email,
    }),
    onDone,
  );
  return (
    <Dialog title="Undang staf" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <p className="small muted">Sistem membuat tautan aktivasi sekali pakai (berlaku 72 jam). Staf mengatur kata sandinya sendiri — tidak ada kata sandi default.</p>
        <Field label="Nama lengkap">{(id) => <input id={id} className="input" value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} required minLength={2} />}</Field>
        <Field label="Email">{(id) => <input id={id} className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required />}</Field>
        <Field label="Peran">
          {(id) => (
            <select id={id} className="select" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
              {ROLE_OPTIONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          )}
        </Field>
        {f.role === 'admin' ? <FinanceCheck checked={f.handlesFinance} onChange={(v) => setF({ ...f, handlesFinance: v })} /> : null}
        {f.role !== 'terapis' ? (
          <label className="check">
            <input type="checkbox" checked={f.isTherapist} onChange={(e) => setF({ ...f, isTherapist: e.target.checked })} /> Juga menangani sesi terapi
          </label>
        ) : null}
        {f.role === 'terapis' || f.isTherapist ? (
          <Field label="Spesialisasi" hint="Mis. Terapi Wicara, Okupasi, Sensori Integrasi">
            {(id) => <input id={id} className="input" value={f.specialization} onChange={(e) => setF({ ...f, specialization: e.target.value })} maxLength={120} />}
          </Field>
        ) : null}
        <ErrorBox error={error} />
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Batal
          </button>
          <button className="btn" disabled={busy}>
            Buat undangan
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function EditMemberDialog({ member, onClose, onSaved }: { member: any; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ role: member.role, isTherapist: member.isTherapist, handlesFinance: member.handlesFinance, specialization: member.specialization ?? '' });
  const toast = useToast();
  const save = () => patch(`/staff/${member.id}`, { ...f, handlesFinance: f.role === 'admin' && f.handlesFinance, specialization: f.specialization || null });
  const { busy, error, submit } = useSubmit(save, () => {
    toast('Perubahan disimpan dan langsung berlaku');
    onSaved();
    onClose();
  });
  return (
    <Dialog title={`Ubah akses — ${member.fullName}`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <Field label="Peran">
          {(id) => (
            <select id={id} className="select" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
              {ROLE_OPTIONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          )}
        </Field>
        {f.role === 'admin' ? <FinanceCheck checked={f.handlesFinance} onChange={(v) => setF({ ...f, handlesFinance: v })} /> : null}
        {f.role !== 'terapis' ? (
          <label className="check">
            <input type="checkbox" checked={f.isTherapist} onChange={(e) => setF({ ...f, isTherapist: e.target.checked })} /> Juga menangani sesi terapi
          </label>
        ) : null}
        <Field label="Spesialisasi">{(id) => <input id={id} className="input" value={f.specialization} onChange={(e) => setF({ ...f, specialization: e.target.value })} maxLength={120} />}</Field>
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
