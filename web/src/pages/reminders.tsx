import { useState } from 'react';
import { post, qs, useApi } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { formatDateTime, formatWeekday, todayIn } from '../format.ts';
import { Badge, Empty, ErrorBox, Field, Loading, PageHeader, useToast } from '../ui.tsx';
import { leadLabel } from './whatsapp.tsx';

// Status satu pesan (satu anak, satu hari). Sesi yang ditambahkan setelah pesan terkirim
// diingatkan dengan pesan berikutnya.
function GroupStatus({ g, tz }: { g: any; tz?: string }) {
  const sessions: any[] = g.sessions;
  const autos = sessions.map((x) => x.auto).filter(Boolean);
  const failed = autos.find((a) => a.status === 'gagal');
  if (failed) return <Badge tone="danger">Otomatis gagal: {failed.reason}</Badge>;
  if (autos.some((a) => a.status === 'mengirim')) return <Badge tone="info">Sedang dikirim</Badge>;
  if (autos.some((a) => a.status === 'tidak_pasti')) return <Badge tone="warn">Status tidak pasti — cek dashboard Fonnte</Badge>;
  const done = sessions.filter((x) => x.sentAt || x.auto?.status === 'terkirim');
  if (done.length === sessions.length) {
    const last = done.map((x) => x.sentAt ?? x.auto.at).sort().at(-1);
    return <Badge tone="ok">{done.every((x) => x.sentAt) ? 'Terkirim manual' : 'Otomatis terkirim'} {formatDateTime(last, tz)}</Badge>;
  }
  if (done.length) return <Badge tone="warn">Sebagian terkirim: {sessions.filter((x) => !done.includes(x)).map((x) => x.localTime).join(', ')} belum</Badge>;
  if (g.optOut) return <Badge>Wali menolak pengingat otomatis</Badge>;
  if (g.autoDueAt) return <Badge tone="info">Otomatis ± {formatDateTime(g.autoDueAt, tz)}</Badge>;
  return null;
}

const fullySent = (g: any) => g.sessions.every((x: any) => x.sentAt || x.auto?.status === 'terkirim');

export function RemindersPage() {
  const { me } = useAuth();
  const tz = me?.organization?.timezone;
  const toast = useToast();
  const [date, setDate] = useState(() => todayIn(tz, 1));
  const [sending, setSending] = useState(false);
  const { data, error, loading, reload } = useApi<any>(`/reminders${qs({ date })}`);

  const send = async (g: any) => {
    // Buka WhatsApp (di Android otomatis keluar ke aplikasi WhatsApp), lalu catat semua sesi di pesan itu terkirim.
    window.open(g.waUrl, '_blank', 'noopener');
    try {
      await post('/reminders/sent', { appointmentIds: g.sessions.map((x: any) => x.appointmentId) });
      reload();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const sendAllAuto = async () => {
    if (!confirm('Kirim sekarang lewat Fonnte semua pengingat tanggal ini yang belum terkirim?')) return;
    setSending(true);
    try {
      const r = await post<any>('/reminders/auto-send', { date });
      toast(`Terkirim ${r.terkirim}, gagal ${r.gagal}${r.tidak_pasti ? `, tidak pasti ${r.tidak_pasti}` : ''}${r.tertunda ? `, ${r.tertunda} menunggu putaran berikutnya` : ''}`, r.gagal ? 'error' : undefined);
      reload();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setSending(false);
    }
  };
  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    toast('Pesan disalin');
  };

  const items: any[] = data?.items ?? [];
  const wa = data?.whatsapp;
  const sent = items.filter(fullySent).length;

  return (
    <>
      <PageHeader
        title="Pengingat Jadwal"
        subtitle="Satu pesan per anak per hari, memuat semua jam sesinya. Dikirim otomatis (Fonnte) atau sekali klik dari WhatsApp Anda sendiri. Pesan tidak memuat jenis terapi atau informasi klinis."
        actions={
          wa?.configured ? (
            <button className="btn btn-secondary" onClick={sendAllAuto} disabled={sending || items.length === 0}>
              Kirim semua lewat Fonnte
            </button>
          ) : null
        }
      />
      {wa?.configured ? (
        <div className={`alert ${wa.autoEnabled ? 'ok' : 'info'}`} style={{ marginBottom: 14 }}>
          {wa.autoEnabled
            ? `Otomatis aktif: satu pesan per anak dikirim ${leadLabel(wa.leadMinutes)} sebelum sesi pertamanya hari itu, lewat Fonnte.`
            : 'WhatsApp otomatis terhubung, tetapi pengiriman terjadwal sedang nonaktif (owner dapat mengaktifkannya di Pengaturan → WhatsApp otomatis).'}
        </div>
      ) : null}
      <div className="row" style={{ marginBottom: 14 }}>
        <Field label="Tanggal jadwal">{(id) => <input id={id} className="input" type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />}</Field>
      </div>
      <section className="card">
        <div className="card-head">
          <h2>{formatWeekday(date)}</h2>
          {items.length ? <Badge tone={sent === items.length ? 'ok' : 'warn'}>{`${sent}/${items.length} terkirim`}</Badge> : null}
        </div>
        {loading && !data ? <Loading /> : null}
        <ErrorBox error={error} />
        {data && items.length === 0 ? <Empty title="Tidak ada jadwal terjadwal pada tanggal ini" /> : null}
        {items.map((g) => (
          <div key={`${g.patientId}:${g.localDate}`} className="card-body" style={{ borderBottom: '1px solid var(--c-border)' }}>
            <div className="spread">
              <div>
                <strong>
                  {g.patientName}, pukul {g.sessions.map((x: any) => x.localTime).join(', ')}
                </strong>
                <div className="small muted">
                  {[...new Set(g.sessions.map((x: any) => x.therapistName))].join(', ')}. Wali: {g.guardianName ?? '—'}
                  {g.phone ? `, +${g.phone}` : g.phoneInvalid ? ', nomor tidak valid' : ', belum ada nomor'}
                </div>
              </div>
              <div className="row">
                <GroupStatus g={g} tz={tz} />
                {g.waUrl ? (
                  <button className="btn btn-sm" onClick={() => send(g)}>
                    {g.sessions.some((x: any) => x.sentAt) ? 'Kirim ulang' : 'Kirim WhatsApp'}
                  </button>
                ) : null}
                <button className="btn btn-sm btn-ghost" onClick={() => copy(g.message)}>
                  Salin pesan
                </button>
              </div>
            </div>
            <p className="small" style={{ marginTop: 8, background: 'var(--c-surface-2)', padding: '8px 10px', borderRadius: 8 }}>
              {g.message}
            </p>
          </div>
        ))}
      </section>
      <p className="small muted" style={{ marginTop: 12 }}>
        Templat pesan dapat diubah owner di Pengaturan.{' '}
        {wa?.configured ? 'Jadwal yang sudah dikirimi manual tidak dikirimi otomatis lagi.' : 'Pengiriman otomatis dapat diaktifkan owner di Pengaturan → WhatsApp otomatis (Fonnte).'}
      </p>
    </>
  );
}
