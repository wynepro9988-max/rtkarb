import { useState } from 'react';
import { Link } from 'react-router';
import { downloadUrl, patch, post, useApi } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { formatDate, todayIn } from '../format.ts';
import { Badge, Dialog, Empty, ErrorBox, Field, Icon, Loading, PageHeader, useSubmit, useToast } from '../ui.tsx';
import { PatientPicker } from './schedule.tsx';

const KIND: Record<string, string> = { akses: 'Akses / salinan data', koreksi: 'Koreksi data', hapus: 'Penghapusan data' };
const STATUS: Record<string, { label: string; tone: string }> = {
  diterima: { label: 'Diterima', tone: 'warn' },
  diproses: { label: 'Diproses', tone: 'info' },
  selesai: { label: 'Selesai', tone: 'ok' },
  ditolak: { label: 'Ditolak', tone: '' },
};

export function PrivacyPage() {
  const toast = useToast();
  const { data, error, loading, reload } = useApi<any[]>('/privacy/requests');
  const { data: retention } = useApi<any>('/privacy/retention');
  const [creating, setCreating] = useState(false);
  const [updating, setUpdating] = useState<any | null>(null);
  return (
    <>
      <PageHeader
        title="Privasi Data"
        subtitle="Pencatatan permintaan wali atas data anak (akses, koreksi, penghapusan) dan peninjauan masa simpan data. Tidak ada penghapusan otomatis."
        actions={
          <button className="btn" onClick={() => setCreating(true)}>
            <Icon name="plus" /> Catat permintaan
          </button>
        }
      />
      <div className="alert info" style={{ marginBottom: 16 }}>
        Ekspor data (PDF) dan anonimisasi dilakukan dari halaman pasien, bagian <strong>Data &amp; privasi</strong>. Kewajiban simpan catatan (mis. rekam medis, pembukuan) perlu dikonfirmasi sebelum menghapus.
      </div>
      <section className="card">
        <div className="card-head">
          <h2>Permintaan wali</h2>
        </div>
        {loading && !data ? <Loading /> : null}
        <ErrorBox error={error} />
        {data?.length === 0 ? <Empty title="Belum ada permintaan" /> : null}
        {data?.map((r) => (
          <div key={r.id} className="card-body spread" style={{ borderBottom: '1px solid var(--c-border)' }}>
            <div>
              <strong>{KIND[r.kind]}</strong> <Badge tone={STATUS[r.status]?.tone}>{STATUS[r.status]?.label}</Badge>
              <div className="small muted">
                <Link to={`/pasien/${r.patientId}`}>{r.patientName}</Link> · {r.requesterName}
                {r.requesterRelation ? ` (${r.requesterRelation})` : ''} · diterima {formatDate(r.receivedOn)}
              </div>
              {r.details ? <div className="small">{r.details}</div> : null}
              {r.resolution ? <div className="small muted">Hasil: {r.resolution}</div> : null}
            </div>
            {r.status === 'diterima' || r.status === 'diproses' ? (
              <button className="btn btn-sm btn-secondary" onClick={() => setUpdating(r)}>
                Perbarui
              </button>
            ) : null}
          </div>
        ))}
      </section>
      <section className="card" style={{ marginTop: 16 }}>
        <div className="card-head">
          <h2>Kandidat retensi</h2>
        </div>
        <div className="card-body">
          {!retention ? <Loading /> : null}
          {retention && !retention.configured ? (
            <p className="muted">Masa retensi belum ditetapkan. Owner dapat menetapkannya di Pengaturan → Organisasi.</p>
          ) : null}
          {retention?.configured ? (
            <>
              <p className="small muted" style={{ marginBottom: 8 }}>
                Pasien tidak aktif dengan aktivitas terakhir lebih dari {retention.retentionYears} tahun lalu. Tinjau satu per satu sebelum mengambil tindakan.
              </p>
              {retention.items.length === 0 ? <p className="muted">Tidak ada kandidat.</p> : null}
              {retention.items.map((i: any) => (
                <div key={i.id} className="spread small" style={{ padding: '6px 0', borderTop: '1px dashed var(--c-border)' }}>
                  <Link to={`/pasien/${i.id}`}>
                    {i.fullName} <span className="mono muted">{i.patientCode}</span>
                  </Link>
                  <span>aktivitas terakhir {formatDate(i.lastActivity)}</span>
                </div>
              ))}
            </>
          ) : null}
        </div>
      </section>
      {creating ? <RequestDialog onClose={() => setCreating(false)} onSaved={reload} /> : null}
      {updating ? (
        <UpdateDialog
          request={updating}
          onClose={() => setUpdating(null)}
          onSaved={() => {
            toast('Permintaan diperbarui');
            reload();
          }}
        />
      ) : null}
    </>
  );
}

function RequestDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { me } = useAuth();
  const [patient, setPatient] = useState<any | null>(null);
  const [f, setF] = useState({ kind: 'akses', requesterName: '', requesterRelation: '', receivedOn: todayIn(me?.organization?.timezone), details: '' });
  const { busy, error, submit } = useSubmit(
    () => post('/privacy/requests', { ...f, patientId: patient?.id, requesterRelation: f.requesterRelation || null, details: f.details || null }),
    () => {
      onSaved();
      onClose();
    },
  );
  return (
    <Dialog title="Catat permintaan wali" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="field">
          <span className="label">Pasien</span>
          <PatientPicker value={patient} onChange={setPatient} />
        </div>
        <div className="form-grid">
          <Field label="Jenis permintaan">
            {(id) => (
              <select id={id} className="select" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
                {Object.entries(KIND).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Tanggal diterima">{(id) => <input id={id} className="input" type="date" value={f.receivedOn} onChange={(e) => setF({ ...f, receivedOn: e.target.value })} required />}</Field>
          <Field label="Nama peminta">{(id) => <input id={id} className="input" value={f.requesterName} onChange={(e) => setF({ ...f, requesterName: e.target.value })} required minLength={2} />}</Field>
          <Field label="Hubungan dengan anak">{(id) => <input id={id} className="input" value={f.requesterRelation} onChange={(e) => setF({ ...f, requesterRelation: e.target.value })} maxLength={60} />}</Field>
          <Field label="Rincian" full hint="Verifikasi identitas peminta sebelum menindaklanjuti">
            {(id) => <textarea id={id} className="textarea" value={f.details} onChange={(e) => setF({ ...f, details: e.target.value })} maxLength={2000} />}
          </Field>
        </div>
        <ErrorBox error={error} />
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Batal
          </button>
          <button className="btn" disabled={busy || !patient}>
            Simpan
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function UpdateDialog({ request, onClose, onSaved }: { request: any; onClose: () => void; onSaved: () => void }) {
  const [status, setStatus] = useState(request.status === 'diterima' ? 'diproses' : 'selesai');
  const [resolution, setResolution] = useState('');
  const { busy, error, submit } = useSubmit(() => patch(`/privacy/requests/${request.id}`, { status, resolution: resolution || null }), () => {
    onSaved();
    onClose();
  });
  return (
    <Dialog title="Perbarui permintaan" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <Field label="Status">
          {(id) => (
            <select id={id} className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="diproses">Diproses</option>
              <option value="selesai">Selesai</option>
              <option value="ditolak">Ditolak</option>
            </select>
          )}
        </Field>
        <Field label="Hasil / alasan" hint="Wajib untuk status selesai atau ditolak">
          {(id) => <textarea id={id} className="textarea" value={resolution} onChange={(e) => setResolution(e.target.value)} maxLength={2000} required={status !== 'diproses'} />}
        </Field>
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

// Panel di halaman pasien (owner): ekspor data & anonimisasi.
export function PatientPrivacyPanel({ patient, onChanged }: { patient: any; onChanged: () => void }) {
  const { data: requests } = useApi<any[]>('/privacy/requests');
  const [open, setOpen] = useState(false);
  const pending = (requests ?? []).filter((r) => r.patientId === patient.id && r.kind === 'hapus' && r.status !== 'selesai' && r.status !== 'ditolak');
  return (
    <section className="card card-pad">
      <h2 style={{ marginBottom: 8 }}>Data &amp; privasi</h2>
      {patient.anonymizedAt ? <div className="alert info">Data pasien ini sudah dianonimkan.</div> : null}
      <div className="row">
        <button className="btn btn-sm btn-secondary" onClick={() => downloadUrl(`/patients/${patient.id}/export.pdf`)}>
          <Icon name="download" /> Ekspor data (PDF)
        </button>
        {!patient.anonymizedAt ? (
          <button className="btn btn-sm btn-ghost" style={{ color: 'var(--c-danger)' }} onClick={() => setOpen(true)}>
            Anonimkan data…
          </button>
        ) : null}
      </div>
      <p className="small muted" style={{ marginTop: 8 }}>Ekspor berisi seluruh data pasien termasuk catatan klinis. Serahkan hanya kepada wali yang identitasnya sudah diverifikasi.</p>
      {open ? <AnonymizeDialog patient={patient} requests={pending} onClose={() => setOpen(false)} onDone={onChanged} /> : null}
    </section>
  );
}

function AnonymizeDialog({ patient, requests, onClose, onDone }: { patient: any; requests: any[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [mode, setMode] = useState('identitas');
  const [confirmCode, setConfirmCode] = useState('');
  const [reason, setReason] = useState('');
  const [requestId, setRequestId] = useState(requests[0]?.id ?? '');
  const { busy, error, submit } = useSubmit(
    () => post<{ filesRemoved: number; filesFailed: number }>(`/patients/${patient.id}/anonymize`, { mode, confirmCode, reason, requestId: requestId || null }),
    (r) => {
      toast(`Data dianonimkan. ${r.filesRemoved} berkas dihapus${r.filesFailed ? `, ${r.filesFailed} gagal (lihat log)` : ''}.`);
      onDone();
      onClose();
    },
  );
  return (
    <Dialog title="Anonimkan data pasien" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="alert warn">Tindakan ini <strong>tidak dapat dibatalkan</strong>. Buat backup dan ekspor data terlebih dahulu bila diperlukan.</div>
        <label className="check">
          <input type="radio" name="mode" checked={mode === 'identitas'} onChange={() => setMode('identitas')} />
          <span>
            <strong>Identitas saja</strong> — nama, tanggal lahir, alamat, data wali, dan berkas dihapus. Catatan klinis & transaksi keuangan tetap disimpan tanpa identitas (untuk kewajiban pencatatan).
          </span>
        </label>
        <label className="check">
          <input type="radio" name="mode" checked={mode === 'penuh'} onChange={() => setMode('penuh')} />
          <span>
            <strong>Penuh</strong> — juga mengosongkan isi catatan terapi, riwayat revisi, dan program. Transaksi keuangan tetap (nominal & tanggal).
          </span>
        </label>
        {requests.length ? (
          <Field label="Terkait permintaan">
            {(id) => (
              <select id={id} className="select" value={requestId} onChange={(e) => setRequestId(e.target.value)}>
                <option value="">—</option>
                {requests.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.requesterName} · {formatDate(r.receivedOn)}
                  </option>
                ))}
              </select>
            )}
          </Field>
        ) : null}
        <Field label="Alasan" hint="Minimal 10 karakter, tercatat di audit log">
          {(id) => <textarea id={id} className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} required minLength={10} maxLength={500} />}
        </Field>
        <Field label={`Ketik kode pasien "${patient.patientCode}" untuk konfirmasi`}>
          {(id) => <input id={id} className="input mono" value={confirmCode} onChange={(e) => setConfirmCode(e.target.value)} autoComplete="off" required />}
        </Field>
        <ErrorBox error={error} />
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Batal
          </button>
          <button className="btn btn-danger" disabled={busy || confirmCode !== patient.patientCode || reason.trim().length < 10}>
            Anonimkan
          </button>
        </div>
      </form>
    </Dialog>
  );
}
