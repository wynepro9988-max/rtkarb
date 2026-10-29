import { useEffect, useState } from 'react';
import { del, post, put, useApi } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { formatDateTime } from '../format.ts';
import { Badge, ErrorBox, Field, Loading, useSubmit, useToast } from '../ui.tsx';

export function leadLabel(minutes: number): string {
  if (minutes === 1440) return '24 jam (sehari sebelumnya)';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h ? `${h} jam` : '', m ? `${m} menit` : ''].filter(Boolean).join(' ');
}

// Pengaturan WhatsApp otomatis (Fonnte) — hanya owner.
export function WhatsAppSettings() {
  const { me } = useAuth();
  const tz = me?.organization?.timezone;
  const toast = useToast();
  const { data, error, loading, setData } = useApi<any>('/org/whatsapp');
  const [f, setF] = useState<{ token: string; autoEnabled: boolean; hours: string } | null>(null);
  const [testPhone, setTestPhone] = useState('');
  const [check, setCheck] = useState<any>(null);
  const [actionError, setActionError] = useState<unknown>(null);

  useEffect(() => {
    if (data) setF({ token: '', autoEnabled: data.autoEnabled, hours: String(data.leadMinutes / 60) });
  }, [data]);

  const { busy, error: saveError, submit } = useSubmit(
    () =>
      put('/org/whatsapp', {
        ...(f!.token.trim() ? { token: f!.token.trim() } : {}),
        autoEnabled: f!.autoEnabled,
        leadMinutes: Math.round(Number(f!.hours) * 60),
      }),
    (r) => {
      setData(r);
      setCheck(null);
      toast('Pengaturan WhatsApp disimpan');
    },
  );

  const run = async (fn: () => Promise<void>) => {
    setActionError(null);
    try {
      await fn();
    } catch (err) {
      setActionError(err);
    }
  };

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!f) return null;
  const minutes = Math.round(Number(f.hours) * 60);

  return (
    <div className="stack" style={{ maxWidth: 720 }}>
      <div className="alert warn">
        Fonnte memakai <strong>nomor WhatsApp biasa yang ditautkan</strong> (seperti WhatsApp Web), bukan API resmi WhatsApp. Gunakan nomor khusus
        pusat terapi, bukan nomor pribadi. Nomor dapat diblokir WhatsApp bila banyak pesan dilaporkan sebagai spam.
      </div>
      {!data.serverReady ? (
        <div className="alert error">Server belum disiapkan untuk fitur ini (APP_ENCRYPTION_KEY belum diisi). Hubungi admin teknis.</div>
      ) : null}
      {data.serverReady && !data.cronReady ? (
        <div className="alert info">
          Penjadwal otomatis belum aktif di server (CRON_SECRET). Tombol <em>Kirim semua lewat Fonnte</em> di halaman Pengingat tetap dapat dipakai.
        </div>
      ) : null}

      <section className="card card-pad stack">
        <div className="spread">
          <h2 style={{ margin: 0 }}>Koneksi Fonnte</h2>
          {data.configured ? <Badge tone={data.deviceStatus === 'connect' ? 'ok' : 'warn'}>{data.deviceStatus === 'connect' ? 'Terhubung' : 'Perangkat terputus'}</Badge> : <Badge>Belum dihubungkan</Badge>}
        </div>
        {data.configured ? (
          <>
            <dl className="kv">
              <dt>Token</dt>
              <dd className="mono">{data.tokenHint}</dd>
              <dt>Nomor pengirim</dt>
              <dd>{data.deviceNumber ? `+${data.deviceNumber}` : '—'}</dd>
              <dt>Diperiksa</dt>
              <dd>{formatDateTime(data.checkedAt, tz)}</dd>
              {check?.ok ? (
                <>
                  <dt>Paket Fonnte</dt>
                  <dd>
                    {check.plan ?? '—'} · sisa kuota {check.quota ?? '—'} pesan · aktif s.d. {check.expired ?? '—'}
                  </dd>
                </>
              ) : null}
            </dl>
            {check && !check.ok ? <div className="alert error">Fonnte menolak: {check.reason}</div> : null}
            <div className="row">
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                onClick={() =>
                  run(async () => {
                    const r = await post<any>('/org/whatsapp/check');
                    setData(r);
                    setCheck(r.check);
                  })
                }
              >
                Cek koneksi & kuota
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                style={{ color: 'var(--c-danger)' }}
                onClick={() =>
                  run(async () => {
                    if (!confirm('Putuskan WhatsApp otomatis? Token dihapus dari sistem dan pengiriman otomatis berhenti.')) return;
                    setData(await del('/org/whatsapp'));
                    toast('WhatsApp otomatis diputus');
                  })
                }
              >
                Putuskan
              </button>
            </div>
          </>
        ) : (
          <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>
            <li>Daftar di fonnte.com, lalu tambah perangkat dengan nomor WhatsApp pusat terapi.</li>
            <li>Tautkan nomor: di HP buka WhatsApp → Perangkat tertaut → pindai QR dari dashboard Fonnte.</li>
            <li>Salin token perangkat dari dashboard Fonnte dan tempel di bawah.</li>
          </ol>
        )}
      </section>

      <form className="card card-pad form" onSubmit={submit}>
        <h2 style={{ margin: 0 }}>Kebijakan pengingat otomatis</h2>
        <div className="form-grid">
          <Field label="Token perangkat Fonnte" full hint={data.configured ? 'Kosongkan untuk tetap memakai token saat ini.' : 'Disimpan terenkripsi dan tidak pernah ditampilkan lagi.'}>
            {(id) => (
              <input
                id={id}
                className="input mono"
                type="password"
                autoComplete="off"
                value={f.token}
                onChange={(e) => setF({ ...f, token: e.target.value })}
                required={!data.configured}
                maxLength={200}
                disabled={!data.serverReady}
              />
            )}
          </Field>
          <Field label="Kirim berapa jam sebelum sesi pertama" hint="Mis. 3 = tiga jam sebelum sesi pertama anak hari itu; 24 = sehari sebelumnya. Minimal 0,5 jam, maksimal 48 jam.">
            {(id) => <input id={id} className="input" type="number" min={0.5} max={48} step={0.5} value={f.hours} onChange={(e) => setF({ ...f, hours: e.target.value })} required />}
          </Field>
        </div>
        <label className="check">
          <input type="checkbox" checked={f.autoEnabled} onChange={(e) => setF({ ...f, autoEnabled: e.target.checked })} disabled={!data.serverReady} /> Kirim pengingat otomatis{' '}
          {minutes >= 30 ? <strong>{leadLabel(minutes)}</strong> : null} sebelum sesi pertama anak setiap hari
        </label>
        <p className="small muted" style={{ margin: 0 }}>
          Satu pesan per anak per hari, memuat semua jam sesinya (mis. "pukul 09:00 dan 10:00"). Pesan memakai templat di tab Organisasi (tanpa
          jenis terapi), dikirim ke wali utama yang nomornya valid, tidak menolak pengingat otomatis, dan belum dikirimi manual. Sesi yang
          ditambahkan setelah pesan terkirim diingatkan dengan pesan tersendiri. Waktu kirim mengikuti putaran penjadwal (±10 menit).
        </p>
        <div className="alert info small">
          Data yang melewati Fonnte: nama panggilan anak, nama & nomor wali, tanggal & jam jadwal. Beri tahu wali tentang pengingat ini; wali yang menolak
          dapat ditandai di data wali pasien.
        </div>
        <ErrorBox error={saveError} />
        <div className="form-actions">
          <button className="btn" disabled={busy || !data.serverReady}>
            Simpan
          </button>
        </div>
      </form>

      {data.configured ? (
        <section className="card card-pad stack">
          <h2 style={{ margin: 0 }}>Kirim pesan uji</h2>
          <div className="row">
            <input className="input" style={{ maxWidth: 240 }} inputMode="tel" placeholder="08xx…" value={testPhone} onChange={(e) => setTestPhone(e.target.value)} aria-label="Nomor uji" />
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!testPhone}
              onClick={() =>
                run(async () => {
                  const r = await post<any>('/org/whatsapp/test', { phone: testPhone });
                  if (r.outcome === 'terkirim') toast('Pesan uji diterima Fonnte');
                  else toast(`Pesan uji tidak terkirim: ${r.reason}`, 'error');
                })
              }
            >
              Kirim pesan uji
            </button>
          </div>
        </section>
      ) : null}
      <ErrorBox error={actionError} />
    </div>
  );
}
