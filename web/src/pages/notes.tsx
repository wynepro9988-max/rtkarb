import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { get, post, put, useApi } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { formatDateTime, NOTE_TYPE } from '../format.ts';
import { Badge, ErrorBox, Field, Loading, PageHeader, useSubmit, useToast } from '../ui.tsx';
import { NoteView } from './patients.tsx';

const FIELDS = [
  { key: 'objectives', label: 'Tujuan / target sesi', hint: 'Target yang dituju pada sesi ini' },
  { key: 'activities', label: 'Aktivitas', hint: 'Kegiatan atau metode yang dilakukan' },
  { key: 'observations', label: 'Observasi & respons anak', hint: 'Catat fakta yang diamati' },
  { key: 'homeProgram', label: 'Program di rumah', hint: 'Saran latihan untuk orang tua/wali' },
  { key: 'nextPlan', label: 'Rencana sesi berikutnya', hint: '' },
] as const;
type Content = Record<(typeof FIELDS)[number]['key'], string>;
const emptyContent: Content = { objectives: '', activities: '', observations: '', homeProgram: '', nextPlan: '' };

export function NoteEditorPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { me, can } = useAuth();
  const toast = useToast();
  const isNew = !id;

  const { data: note, error: loadError, reload } = useApi<any>(id ? `/notes/${id}` : null);
  const patientId = note?.patientId ?? params.get('patientId') ?? '';
  const appointmentId = note?.appointmentId ?? params.get('appointmentId') ?? '';
  const { data: patient } = useApi<any>(isNew && patientId ? `/patients/${patientId}` : null);

  const [content, setContent] = useState<Content>(emptyContent);
  const [noteType, setNoteType] = useState(appointmentId ? 'sesi' : 'asesmen');
  const [reason, setReason] = useState('');
  const [showRevisions, setShowRevisions] = useState(false);
  const [revisions, setRevisions] = useState<any[] | null>(null);

  useEffect(() => {
    if (note) setContent(Object.fromEntries(FIELDS.map((f) => [f.key, note[f.key] ?? ''])) as Content);
  }, [note]);

  const isAuthor = isNew ? can('therapy.note.write') : note?.authorMemberId === me?.membership?.id;
  const editable = isAuthor && can('therapy.note.write');
  const isFinal = note?.status === 'final';
  const nullable = (c: Content) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v.trim() ? v : null]));

  const save = (finalize: boolean) => async () => {
    if (isNew) {
      const r = await post<{ id: string }>('/notes', { patientId, appointmentId: appointmentId || null, noteType, finalize, ...nullable(content) });
      return { id: r.id, finalize };
    }
    await put(`/notes/${id}`, { ...nullable(content), finalize, reason: reason || null });
    return { id: id!, finalize };
  };
  const after = (r: { id: string; finalize: boolean }) => {
    toast(r.finalize || isFinal ? 'Catatan disimpan sebagai final' : 'Draf disimpan');
    setReason('');
    if (isNew) navigate(`/catatan/${r.id}`, { replace: true });
    else reload();
    setRevisions(null);
  };
  const draft = useSubmit(save(false), after);
  const final = useSubmit(save(true), after);

  const loadRevisions = async () => {
    setShowRevisions(!showRevisions);
    if (!revisions && id) setRevisions(await get(`/notes/${id}/revisions`));
  };

  if (loadError) return <ErrorBox error={loadError} />;
  if (!isNew && !note) return <Loading />;
  const title = isNew ? 'Catatan terapi baru' : NOTE_TYPE[note.noteType];
  const patientName = note?.patientName ?? patient?.fullName ?? '';

  return (
    <>
      <PageHeader
        back={patientId ? { to: `/pasien/${patientId}`, label: patientName || 'Kembali ke pasien' } : undefined}
        title={
          <span className="row">
            {title} {note ? <Badge tone={isFinal ? 'ok' : 'warn'}>{isFinal ? 'Final' : 'Draf'}</Badge> : null}
          </span>
        }
        subtitle={
          note
            ? `${note.patientName} · ${note.authorName}${note.sessionAt ? ` · sesi ${note.sessionAt}` : ''} · revisi ${note.revisionNo}`
            : patientName
              ? `${patientName}${appointmentId ? ' · catatan untuk sesi terjadwal' : ''}`
              : ''
        }
      />
      <div className="alert info" style={{ marginBottom: 16 }}>
        Catatan klinis bersifat rahasia dan hanya dapat dilihat oleh terapis yang ditugaskan serta owner. Tulis fakta pengamatan, bukan diagnosis otomatis.
      </div>

      {editable ? (
        <form className="card card-pad form" onSubmit={(e) => e.preventDefault()}>
          {isNew ? (
            <Field label="Jenis catatan">
              {(fid) => (
                <select id={fid} className="select" value={noteType} onChange={(e) => setNoteType(e.target.value)}>
                  {Object.entries(NOTE_TYPE).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          ) : null}
          {FIELDS.map((f) => (
            <Field key={f.key} label={f.label} hint={f.hint}>
              {(fid) => (
                <textarea
                  id={fid}
                  className="textarea"
                  value={content[f.key]}
                  onChange={(e) => setContent({ ...content, [f.key]: e.target.value })}
                  maxLength={f.key === 'observations' ? 10000 : 5000}
                />
              )}
            </Field>
          ))}
          {isFinal ? (
            <Field label="Alasan koreksi" hint="Catatan final hanya dapat diubah dengan alasan. Versi sebelumnya tetap tersimpan di riwayat revisi.">
              {(fid) => <input id={fid} className="input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />}
            </Field>
          ) : null}
          <ErrorBox error={draft.error ?? final.error} />
          <div className="form-actions">
            {!isFinal ? (
              <button type="button" className="btn btn-secondary" disabled={draft.busy || final.busy} onClick={() => draft.submit()}>
                Simpan draf
              </button>
            ) : null}
            <button
              type="button"
              className="btn"
              disabled={draft.busy || final.busy || (isFinal && reason.trim().length < 5)}
              onClick={() => {
                if (isFinal || confirm('Simpan sebagai final? Perubahan setelahnya memerlukan alasan koreksi.')) void final.submit();
              }}
            >
              {isFinal ? 'Simpan koreksi' : 'Simpan sebagai final'}
            </button>
          </div>
        </form>
      ) : note ? (
        <section className="card card-pad">
          <NoteView note={note} />
          {!FIELDS.some((f) => note[f.key]) ? <p className="muted">Catatan masih kosong.</p> : null}
          <p className="small muted" style={{ marginTop: 12 }}>
            Hanya penulis catatan yang dapat mengubah isinya.
          </p>
        </section>
      ) : (
        <div className="alert warn">Anda tidak memiliki izin menulis catatan terapi.</div>
      )}

      {!isNew ? (
        <section className="card" style={{ marginTop: 16 }}>
          <div className="card-head">
            <h2>Riwayat revisi</h2>
            <button className="btn btn-sm btn-secondary" onClick={loadRevisions}>
              {showRevisions ? 'Sembunyikan' : 'Tampilkan'}
            </button>
          </div>
          {showRevisions ? (
            <div className="card-body stack">
              {!revisions ? <Loading /> : null}
              {revisions?.map((r) => (
                <div key={r.revisionNo} style={{ borderLeft: '3px solid var(--c-border-strong)', paddingLeft: 12 }}>
                  <div className="small muted">
                    Revisi {r.revisionNo} · {r.editedByName} · {formatDateTime(r.editedAt, me?.organization?.timezone)} · {r.status === 'final' ? 'final' : 'draf'}
                    {r.reason ? ` · alasan: ${r.reason}` : ''}
                  </div>
                  <NoteView note={r.content} />
                </div>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
