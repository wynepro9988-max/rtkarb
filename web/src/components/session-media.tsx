import { useState } from 'react';
import { post, uploadWithProgress, useApi } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { formatBytes, formatDateTime } from '../format.ts';
import { Dialog, ErrorBox, Icon, Loading, useToast } from '../ui.tsx';

// Video/foto sesi: dilihat owner dan terapis yang menangani anak (tidak tampil untuk orang tua).
const MIN_VIDEO_SECONDS = 30;

type Item = { name: string; progress: number; error?: string; done?: boolean };

function videoSeconds(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(v.duration) ? v.duration : null);
    };
    v.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    v.src = url;
  });
}

export function SessionMedia({ appointmentId, canUpload }: { appointmentId: string; canUpload: boolean }) {
  const { me, can } = useAuth();
  const toast = useToast();
  const { data, error, loading, reload } = useApi<any[]>(`/appointments/${appointmentId}/media`);
  const { data: storage } = useApi<{ maxUploadBytes: number }>(canUpload ? '/org/storage' : null);
  const [items, setItems] = useState<Item[]>([]);
  const busy = items.some((i) => !i.done && !i.error);

  async function addFiles(files: FileList | null) {
    if (!files?.length) return;
    const list = [...files];
    const next: Item[] = list.map((f) => ({ name: f.name, progress: 0 }));
    setItems(next);
    const set = (i: number, patch: Partial<Item>) => {
      next[i] = { ...next[i], ...patch };
      setItems([...next]);
    };
    for (const [i, file] of list.entries()) {
      if (storage && file.size > storage.maxUploadBytes) {
        set(i, { error: `Lebih dari ${formatBytes(storage.maxUploadBytes)}` });
        continue;
      }
      if (file.type.startsWith('video/')) {
        const sec = await videoSeconds(file);
        if (sec !== null && sec < MIN_VIDEO_SECONDS) {
          set(i, { error: `Video ${Math.floor(sec)} detik; minimal ${MIN_VIDEO_SECONDS} detik` });
          continue;
        }
      }
      const form = new FormData();
      form.set('file', file);
      try {
        await uploadWithProgress(`/appointments/${appointmentId}/media`, form, (p) => set(i, { progress: p }));
        set(i, { done: true, progress: 1 });
      } catch (err) {
        set(i, { error: (err as Error).message });
      }
    }
    void reload();
  }

  async function remove(id: string) {
    if (!confirm('Hapus video/foto ini dari sesi?')) return;
    try {
      await post(`/media/${id}/archive`);
      toast('Video/foto dihapus');
      void reload();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }

  return (
    <div className="stack" style={{ gap: 12 }}>
      {canUpload ? (
        <label className={`media-drop${busy ? ' busy' : ''}`}>
          <Icon name="upload" />
          <span>
            <strong>Tambah video/foto</strong>
            <span className="small muted">Video minimal 30 detik. Maksimal {storage ? formatBytes(storage.maxUploadBytes) : '30 MB'} per berkas; boleh lebih dari satu.</span>
          </span>
          <input className="sr-only" type="file" multiple accept="video/mp4,video/quicktime,video/3gpp,video/*,image/jpeg,image/png,image/webp" disabled={busy} onChange={(e) => void addFiles(e.target.files)} />
        </label>
      ) : null}
      {items.length ? (
        <ul className="upload-list">
          {items.map((it, i) => (
            <li key={i} className={it.error ? 'err' : it.done ? 'ok' : ''}>
              <span className="name">{it.name}</span>
              <span className="small">{it.error ?? (it.done ? 'Terunggah' : `${Math.round(it.progress * 100)}%`)}</span>
              {!it.error && !it.done ? <progress max={1} value={it.progress} aria-label={`Mengunggah ${it.name}`} /> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <ErrorBox error={error} />
      {loading && !data ? <Loading /> : null}
      {data && !data.length ? <p className="small muted">Belum ada video/foto untuk sesi ini.</p> : null}
      {data?.length ? (
        <div className="media-grid">
          {data.map((m) => (
            <figure key={m.id} className="media-item">
              {m.kind === 'video' ? (
                <video src={`/api/media/${m.id}`} controls preload="metadata" playsInline />
              ) : (
                <a href={`/api/media/${m.id}`} target="_blank" rel="noopener">
                  <img src={`/api/media/${m.id}`} alt={`Foto sesi oleh ${m.uploaderName ?? 'terapis'}`} loading="lazy" />
                </a>
              )}
              <figcaption>
                <span className="small muted">
                  {m.kind === 'video' ? `${Math.round(m.durationSeconds)} detik` : 'Foto'}, {formatBytes(m.sizeBytes)}
                  <br />
                  {m.uploaderName ?? '—'}, {formatDateTime(m.uploadedAt, me?.organization?.timezone)}
                </span>
                {m.uploaderMemberId === me?.membership?.id || can('therapy.note.read') ? (
                  <button type="button" className="icon-btn" aria-label="Hapus" onClick={() => void remove(m.id)}>
                    <Icon name="x" />
                  </button>
                ) : null}
              </figcaption>
            </figure>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function SessionMediaDialog({ appointmentId, title, canUpload, onClose }: { appointmentId: string; title: string; canUpload: boolean; onClose: () => void }) {
  return (
    <Dialog title={title} onClose={onClose} wide>
      <SessionMedia appointmentId={appointmentId} canUpload={canUpload} />
      <div className="form-actions">
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Tutup
        </button>
      </div>
    </Dialog>
  );
}
