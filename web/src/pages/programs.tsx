import { useState } from 'react';
import { patch, post, useApi } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { formatDate, formatDateTime, todayIn } from '../format.ts';
import { Badge, Dialog, Empty, ErrorBox, Field, Icon, Loading, ReasonDialog, useSubmit, useToast } from '../ui.tsx';

const PROGRAM_STATUS: Record<string, { label: string; tone: string }> = {
  aktif: { label: 'Aktif', tone: 'ok' },
  selesai: { label: 'Selesai', tone: 'info' },
  dihentikan: { label: 'Dihentikan', tone: '' },
};
const GOAL_STATUS: Record<string, { label: string; tone: string }> = {
  berjalan: { label: 'Berjalan', tone: 'info' },
  tercapai: { label: 'Tercapai', tone: 'ok' },
  dihentikan: { label: 'Dihentikan', tone: '' },
};

function ProgressBar({ value }: { value: number | null }) {
  const v = value ?? 0;
  return (
    <div className="row" style={{ gap: 8, minWidth: 160 }}>
      <div style={{ flex: 1, height: 8, background: 'var(--c-surface-2)', border: '1px solid var(--c-border)', borderRadius: 6 }}>
        <div style={{ width: `${v}%`, height: '100%', background: v >= 100 ? 'var(--c-success)' : 'var(--c-primary)', borderRadius: 6 }} />
      </div>
      <span className="small mono" style={{ width: 40, textAlign: 'right' }}>
        {value === null ? '—' : `${v}%`}
      </span>
    </div>
  );
}

export function ProgramsTab({ patient }: { patient: any }) {
  const { can, me } = useAuth();
  const { data, error, loading, reload } = useApi<any[]>(`/patients/${patient.id}/programs`);
  const [creating, setCreating] = useState(false);
  const [progressGoal, setProgressGoal] = useState<any | null>(null);
  const [historyGoal, setHistoryGoal] = useState<any | null>(null);
  const [addingTo, setAddingTo] = useState<string | null>(null);
  const [closing, setClosing] = useState<any | null>(null);
  const toast = useToast();
  // Menulis program hanya untuk terapis yang ditugaskan (server juga menegakkan).
  const canWrite = can('therapy.note.write') && patient.therapists.some((t: any) => t.id === me?.membership?.id);

  const setGoalStatus = async (goal: any, status: string) => {
    try {
      await patch(`/goals/${goal.id}`, { status });
      toast('Status tujuan diperbarui');
      reload();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  return (
    <div className="stack">
      <div className="spread">
        <p className="muted small">Rencana jangka panjang, tujuan, dan capaian anak. Data klinis: hanya terapis yang ditugaskan dan owner yang dapat melihat.</p>
        {canWrite ? (
          <button className="btn btn-sm" onClick={() => setCreating(true)}>
            <Icon name="plus" /> Program baru
          </button>
        ) : null}
      </div>
      {loading && !data ? <Loading /> : null}
      <ErrorBox error={error} />
      {data?.length === 0 ? (
        <div className="card">
          <Empty title="Belum ada program terapi">Buat program untuk mencatat tujuan jangka panjang dan memantau capaiannya.</Empty>
        </div>
      ) : null}
      {data?.map((p) => (
        <article className="card" key={p.id}>
          <div className="card-head">
            <div>
              <h3>
                {p.title} <Badge tone={PROGRAM_STATUS[p.status]?.tone}>{PROGRAM_STATUS[p.status]?.label}</Badge>
              </h3>
              <div className="small muted">
                {p.serviceName ? `${p.serviceName} · ` : ''}mulai {formatDate(p.startDate)}
                {p.targetEndDate ? ` · target ${formatDate(p.targetEndDate)}` : ''} · disusun {p.createdByName}
              </div>
            </div>
            {canWrite && p.status === 'aktif' ? (
              <div className="row">
                <button className="btn btn-sm btn-secondary" onClick={() => setAddingTo(p.id)}>
                  <Icon name="plus" /> Tujuan
                </button>
                <button className="btn btn-sm btn-ghost" onClick={() => setClosing(p)}>
                  Tutup program
                </button>
              </div>
            ) : null}
          </div>
          <div className="card-body">
            {p.summary ? <p style={{ whiteSpace: 'pre-wrap', marginBottom: 12 }}>{p.summary}</p> : null}
            {p.endReason ? <div className="alert info" style={{ marginBottom: 12 }}>Penutupan: {p.endReason}</div> : null}
            {p.goals.length === 0 ? <p className="muted small">Belum ada tujuan.</p> : null}
            {p.goals.map((g: any) => (
              <div key={g.id} className="spread" style={{ padding: '10px 0', borderTop: '1px dashed var(--c-border)', alignItems: 'flex-start' }}>
                <div style={{ flex: '1 1 260px' }}>
                  <strong>{g.description}</strong> <Badge tone={GOAL_STATUS[g.status]?.tone}>{GOAL_STATUS[g.status]?.label}</Badge>
                  {g.successCriteria ? <div className="small muted">Kriteria: {g.successCriteria}</div> : null}
                  {g.latestRecordedAt ? <div className="small muted">Capaian terakhir {formatDateTime(g.latestRecordedAt, me?.organization?.timezone)}</div> : null}
                </div>
                <div className="row">
                  <ProgressBar value={g.latestProgress} />
                  <button className="btn btn-sm btn-ghost" onClick={() => setHistoryGoal(g)}>
                    Riwayat
                  </button>
                  {canWrite && g.status === 'berjalan' && p.status === 'aktif' ? (
                    <>
                      <button className="btn btn-sm btn-secondary" onClick={() => setProgressGoal(g)}>
                        Catat capaian
                      </button>
                      <button className="btn btn-sm btn-ghost" onClick={() => confirm('Tandai tujuan ini tercapai?') && setGoalStatus(g, 'tercapai')}>
                        Tercapai
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </article>
      ))}
      {creating ? <ProgramDialog patientId={patient.id} onClose={() => setCreating(false)} onSaved={reload} /> : null}
      {addingTo ? <GoalDialog programId={addingTo} onClose={() => setAddingTo(null)} onSaved={reload} /> : null}
      {progressGoal ? <ProgressDialog goal={progressGoal} onClose={() => setProgressGoal(null)} onSaved={reload} /> : null}
      {historyGoal ? <HistoryDialog goal={historyGoal} onClose={() => setHistoryGoal(null)} /> : null}
      {closing ? (
        <ReasonDialog
          title={`Tutup program — ${closing.title}`}
          description="Tuliskan ringkasan hasil atau alasan program ditutup."
          confirmLabel="Tutup program"
          onClose={() => setClosing(null)}
          onConfirm={async (reason) => {
            await patch(`/programs/${closing.id}`, { status: 'selesai', endReason: reason });
            toast('Program ditutup');
            reload();
          }}
        />
      ) : null}
    </div>
  );
}

function ProgramDialog({ patientId, onClose, onSaved }: { patientId: string; onClose: () => void; onSaved: () => void }) {
  const { me } = useAuth();
  const { data: services } = useApi<any[]>('/services');
  const [f, setF] = useState({ title: '', serviceId: '', startDate: todayIn(me?.organization?.timezone), targetEndDate: '', summary: '' });
  const [goals, setGoals] = useState([{ description: '', successCriteria: '' }]);
  const toast = useToast();
  const { busy, error, submit } = useSubmit(
    () =>
      post(`/patients/${patientId}/programs`, {
        title: f.title,
        serviceId: f.serviceId || null,
        startDate: f.startDate,
        targetEndDate: f.targetEndDate || null,
        summary: f.summary || null,
        goals: goals.filter((g) => g.description.trim()).map((g) => ({ description: g.description, successCriteria: g.successCriteria || null })),
      }),
    () => {
      toast('Program terapi dibuat');
      onSaved();
      onClose();
    },
  );
  return (
    <Dialog title="Program terapi baru" onClose={onClose} wide>
      <form className="form" onSubmit={submit}>
        <div className="form-grid">
          <Field label="Judul program" full>
            {(id) => <input id={id} className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required minLength={2} maxLength={150} placeholder="Mis. Program komunikasi semester 1" />}
          </Field>
          <Field label="Layanan">
            {(id) => (
              <select id={id} className="select" value={f.serviceId} onChange={(e) => setF({ ...f, serviceId: e.target.value })}>
                <option value="">—</option>
                {services?.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Mulai">{(id) => <input id={id} className="input" type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} required />}</Field>
          <Field label="Target selesai">{(id) => <input id={id} className="input" type="date" value={f.targetEndDate} onChange={(e) => setF({ ...f, targetEndDate: e.target.value })} />}</Field>
          <Field label="Ringkasan / dasar program" full hint="Mis. hasil asesmen yang mendasari program">
            {(id) => <textarea id={id} className="textarea" value={f.summary} onChange={(e) => setF({ ...f, summary: e.target.value })} maxLength={5000} />}
          </Field>
        </div>
        <h3>Tujuan</h3>
        {goals.map((g, i) => (
          <div key={i} className="form-grid">
            <Field label={`Tujuan ${i + 1}`}>
              {(id) => <input id={id} className="input" value={g.description} onChange={(e) => setGoals(goals.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} maxLength={1000} />}
            </Field>
            <Field label="Kriteria keberhasilan">
              {(id) => <input id={id} className="input" value={g.successCriteria} onChange={(e) => setGoals(goals.map((x, j) => (j === i ? { ...x, successCriteria: e.target.value } : x)))} maxLength={1000} />}
            </Field>
          </div>
        ))}
        <div>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setGoals([...goals, { description: '', successCriteria: '' }])}>
            <Icon name="plus" /> Tambah tujuan
          </button>
        </div>
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

function GoalDialog({ programId, onClose, onSaved }: { programId: string; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ description: '', successCriteria: '' });
  const { busy, error, submit } = useSubmit(() => post(`/programs/${programId}/goals`, { description: f.description, successCriteria: f.successCriteria || null }), () => {
    onSaved();
    onClose();
  });
  return (
    <Dialog title="Tambah tujuan" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <Field label="Tujuan">{(id) => <textarea id={id} className="textarea" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} required minLength={2} maxLength={1000} />}</Field>
        <Field label="Kriteria keberhasilan">{(id) => <input id={id} className="input" value={f.successCriteria} onChange={(e) => setF({ ...f, successCriteria: e.target.value })} maxLength={1000} />}</Field>
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

function ProgressDialog({ goal, onClose, onSaved }: { goal: any; onClose: () => void; onSaved: () => void }) {
  const [percent, setPercent] = useState<number>(goal.latestProgress ?? 0);
  const [note, setNote] = useState('');
  const toast = useToast();
  const { busy, error, submit } = useSubmit(() => post(`/goals/${goal.id}/progress`, { progressPercent: percent, note: note || null }), () => {
    toast('Capaian dicatat');
    onSaved();
    onClose();
  });
  return (
    <Dialog title="Catat capaian" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <p>
          <strong>{goal.description}</strong>
        </p>
        <Field label={`Perkiraan capaian: ${percent}%`} hint="Penilaian terapis terhadap kriteria keberhasilan tujuan ini">
          {(id) => <input id={id} type="range" min={0} max={100} step={5} value={percent} onChange={(e) => setPercent(Number(e.target.value))} style={{ width: '100%' }} />}
        </Field>
        <Field label="Catatan">{(id) => <textarea id={id} className="textarea" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />}</Field>
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

function HistoryDialog({ goal, onClose }: { goal: any; onClose: () => void }) {
  const { me } = useAuth();
  const { data: rows } = useApi<any[]>(`/goals/${goal.id}/progress`);
  return (
    <Dialog title="Riwayat capaian" onClose={onClose}>
      <p style={{ marginBottom: 12 }}>
        <strong>{goal.description}</strong>
      </p>
      {!rows ? <Loading /> : null}
      {rows?.length === 0 ? <Empty title="Belum ada capaian tercatat" /> : null}
      {rows?.map((r) => (
        <div key={r.id} className="spread" style={{ padding: '8px 0', borderTop: '1px dashed var(--c-border)' }}>
          <div>
            <div className="small muted">
              {formatDateTime(r.recordedAt, me?.organization?.timezone)} · {r.recordedByName}
              {r.sessionAt ? ` · sesi ${r.sessionAt}` : ''}
            </div>
            {r.note ? <div style={{ whiteSpace: 'pre-wrap' }}>{r.note}</div> : null}
          </div>
          <ProgressBar value={r.progressPercent} />
        </div>
      ))}
    </Dialog>
  );
}
