import { useAuth } from '../auth.tsx';
import { formatDateTime } from '../format.ts';
import { Dialog, useToast } from '../ui.tsx';

// Tautan aktivasi/reset sekali pakai. `phone` berformat wa.me (62...): chat langsung ke orangnya.
export function LinkResult({ title, url, expiresAt, phone, onClose }: { title: string; url: string; expiresAt: string; phone?: string | null; onClose: () => void }) {
  const toast = useToast();
  const { me } = useAuth();
  const message = `${title} ${me?.organization?.name ?? 'Rumah Bintang'} (sekali pakai, jangan diteruskan):\n${url}`;
  return (
    <Dialog title={title} onClose={onClose}>
      <div className="stack">
        <div className="alert warn">
          Tautan ini hanya ditampilkan <strong>sekali</strong>. Kirimkan langsung kepada orang yang bersangkutan. Jangan bagikan di grup.
        </div>
        <textarea className="textarea mono" readOnly value={url} onFocus={(e) => e.target.select()} style={{ minHeight: 80 }} aria-label="Tautan" />
        <p className="small muted">Berlaku sampai {formatDateTime(expiresAt, me?.organization?.timezone)} dan hanya dapat dipakai sekali.</p>
        <div className="form-actions">
          <button
            className="btn btn-secondary"
            onClick={async () => {
              await navigator.clipboard.writeText(url);
              toast('Tautan disalin');
            }}
          >
            Salin tautan
          </button>
          <a className="btn btn-secondary" href={`https://wa.me/${phone ?? ''}?text=${encodeURIComponent(message)}`} target="_blank" rel="noopener noreferrer">
            Kirim lewat WhatsApp
          </a>
          <button className="btn" onClick={onClose}>
            Selesai
          </button>
        </div>
      </div>
    </Dialog>
  );
}
