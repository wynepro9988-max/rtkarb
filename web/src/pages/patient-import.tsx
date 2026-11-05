import { useRef, useState } from 'react';
import { api } from '../api.ts';
import { formatDate, PATIENT_STATUS } from '../format.ts';
import { Badge, Dialog, ErrorBox, Icon, Loading, useToast } from '../ui.tsx';

// Impor pasien dari Excel/CSV berformat bebas. Server membaca berkas dan menebak kolomnya;
// di sini pengguna memeriksa/mengoreksi pemetaan kolom dan memilih baris sebelum menyimpan.

type ImportField = { key: string; label: string; multi: boolean };
type Column = { index: number; letter: string; label: string; samples: string[]; field: string | null };
type Guardian = { fullName: string; relationship: string; phone: string | null; email: string | null; isPrimary: boolean };
type RowStatus = 'siap' | 'duplikat' | 'dilewati';
type Row = {
  row: number;
  status: RowStatus;
  issues: string[];
  patient: { fullName: string; nickname: string | null; birthDate: string | null; sex: 'L' | 'P' | null; status: string; guardians: Guardian[] };
};
type Preview = {
  fields: ImportField[];
  sheets: { index: number; name: string }[];
  sheetIndex: number;
  headerRows: number[];
  columns: Column[];
  hasName: boolean;
  notices: string[];
  summary: Record<RowStatus | 'total', number>;
  rows: Row[];
};

const FILTERS: Record<RowStatus, { label: string; hint: string }> = {
  siap: { label: 'Siap diimpor', hint: 'Hapus centang pada baris yang tidak ingin diimpor.' },
  duplikat: { label: 'Sudah terdaftar', hint: 'Nama yang sama sudah ada di sistem atau di baris sebelumnya. Centang hanya bila memang anak yang berbeda.' },
  dilewati: { label: 'Tidak dapat diimpor', hint: 'Baris ini dilewati. Perbaiki di berkas lalu unggah ulang bila perlu.' },
};
const PAGE = 100;
const isGuardianField = (key: string) => /^(guardian|mother|father)/.test(key);

export function PatientImportDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [dragging, setDragging] = useState(false);
  const [filter, setFilter] = useState<RowStatus>('siap');
  const [limit, setLimit] = useState(PAGE);
  // Baris "siap" yang tidak diimpor, dan baris "duplikat" yang tetap diimpor.
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [included, setIncluded] = useState<Set<number>>(new Set());
  const seq = useRef(0);

  const formData = (f: File, fields: Record<string, string>) => {
    const fd = new FormData();
    // Isian dikirim sebelum berkas agar terbaca server bersama berkasnya.
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    fd.set('file', f);
    return fd;
  };
  const mappingOf = (p: Preview) => Object.fromEntries(p.columns.map((c) => [c.index, c.field ?? '']));

  async function load(f: File, opts: { sheet?: number; mapping?: Record<number, string> } = {}) {
    const id = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const fields: Record<string, string> = {};
      if (opts.sheet !== undefined) fields.sheet = String(opts.sheet);
      if (opts.mapping) fields.mapping = JSON.stringify(opts.mapping);
      const p = await api<Preview>('/patients/import/preview', { method: 'POST', form: formData(f, fields) });
      if (id !== seq.current) return;
      setPreview(p);
      if (!opts.mapping) {
        setExcluded(new Set());
        setIncluded(new Set());
        setFilter(p.summary.siap || !p.summary.duplikat ? 'siap' : 'duplikat');
        setLimit(PAGE);
      }
    } catch (err) {
      if (id === seq.current) setError(err);
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }

  function choose(f: File | null | undefined) {
    if (!f) return;
    setFile(f);
    setPreview(null);
    void load(f);
  }

  function remap(col: Column, field: string) {
    if (!file || !preview) return;
    const next = mappingOf(preview);
    // Isian tunggal yang dipilih untuk kolom ini dilepas dari kolom lain.
    if (field && !preview.fields.find((f) => f.key === field)?.multi) {
      for (const c of preview.columns) if (next[c.index] === field) next[c.index] = '';
    }
    next[col.index] = field;
    setPreview({ ...preview, columns: preview.columns.map((c) => ({ ...c, field: next[c.index] || null })) });
    void load(file, { sheet: preview.sheetIndex, mapping: next });
  }

  const picked = (r: Row) => (r.status === 'siap' ? !excluded.has(r.row) : r.status === 'duplikat' && included.has(r.row));
  const total = preview ? preview.rows.filter(picked).length : 0;
  const toggle = (r: Row, on: boolean) => {
    const [set, update] = r.status === 'siap' ? [excluded, setExcluded] : [included, setIncluded];
    const next = new Set(set);
    if ((r.status === 'siap') !== on) next.add(r.row);
    else next.delete(r.row);
    update(next);
  };

  async function runImport() {
    if (!file || !preview) return;
    setImporting(true);
    setError(null);
    try {
      const skip = preview.rows.filter((r) => r.status !== 'dilewati' && !picked(r)).map((r) => r.row);
      const res = await api<{ created: number; firstCode: string; lastCode: string }>('/patients/import', {
        method: 'POST',
        form: formData(file, {
          sheet: String(preview.sheetIndex),
          mapping: JSON.stringify(mappingOf(preview)),
          skip: JSON.stringify(skip),
          includeDuplicates: String(included.size > 0),
        }),
      });
      toast(`${res.created} pasien diimpor (${res.created > 1 ? `${res.firstCode} s.d. ${res.lastCode}` : res.firstCode})`);
      onDone();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setImporting(false);
    }
  }

  const rows = preview ? preview.rows.filter((r) => r.status === filter) : [];
  const childFields = preview?.fields.filter((f) => !isGuardianField(f.key)) ?? [];
  const guardianFields = preview?.fields.filter((f) => isGuardianField(f.key)) ?? [];

  return (
    <Dialog title="Impor data pasien" onClose={onClose} wide="xl">
      <div className="form">
        {!file ? (
          <>
            <label
              className={`dropzone${dragging ? ' over' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                choose(e.dataTransfer.files[0]);
              }}
            >
              <Icon name="upload" />
              <strong>Pilih berkas Excel atau CSV</strong>
              <span className="small muted">atau seret berkasnya ke sini. Maksimal 2.000 baris sekali impor.</span>
              <input
                className="sr-only"
                type="file"
                accept=".xlsx,.csv,.tsv,.txt,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
                onChange={(e) => choose(e.target.files?.[0])}
              />
            </label>
            <p className="small muted">
              Susunan kolom bebas. Judul kolom seperti Nama, Tgl Lahir, L/P, Nama Ibu, atau No HP dikenali otomatis, dan pilihan kolom dapat dikoreksi sebelum
              data disimpan. Belum ada data yang disimpan sampai Anda menekan Impor.
            </p>
          </>
        ) : (
          <div className="import-file">
            <Icon name="file" />
            <span className="name">{file.name}</span>
            {preview && preview.sheets.length > 1 ? (
              <select className="select" style={{ width: 'auto' }} aria-label="Lembar kerja" value={preview.sheetIndex} onChange={(e) => void load(file, { sheet: Number(e.target.value) })}>
                {preview.sheets.map((s) => (
                  <option key={s.index} value={s.index}>
                    {s.name}
                  </option>
                ))}
              </select>
            ) : null}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                seq.current++;
                setFile(null);
                setPreview(null);
                setError(null);
                setLoading(false);
              }}
            >
              Ganti berkas
            </button>
          </div>
        )}

        <ErrorBox error={error} />
        {file && !preview && loading ? <Loading /> : null}

        {preview ? (
          <>
            {preview.notices.length ? (
              <div className="alert info">
                {preview.notices.map((n) => (
                  <p key={n}>{n}</p>
                ))}
              </div>
            ) : null}

            <section className="import-section">
              <div className="spread">
                <h3>Kolom di berkas</h3>
                <span className="small muted">
                  {preview.headerRows.length ? `Judul kolom dibaca dari baris ${preview.headerRows.join(' dan ')}` : 'Berkas tanpa judul kolom'}
                </span>
              </div>
              <div className="map-list">
                {preview.columns.map((c) => (
                  <div key={c.index} className={`map-row${c.field ? ' on' : ''}`}>
                    <div className="map-col">
                      <div className="col-name">
                        <span className="col-letter">{c.letter}</span>
                        {c.label || <span className="muted">Tanpa judul</span>}
                      </div>
                      <div className="samples">{c.samples.length ? c.samples.join(', ') : 'Kosong'}</div>
                    </div>
                    <select
                      className="select"
                      value={c.field ?? ''}
                      onChange={(e) => remap(c, e.target.value)}
                      aria-label={`Kolom ${c.letter}${c.label ? ` (${c.label})` : ''} diimpor sebagai`}
                    >
                      <option value="">Tidak diimpor</option>
                      <optgroup label="Data anak">
                        {childFields.map((f) => (
                          <option key={f.key} value={f.key}>
                            {f.label}
                          </option>
                        ))}
                      </optgroup>
                      <optgroup label="Orang tua / wali">
                        {guardianFields.map((f) => (
                          <option key={f.key} value={f.key}>
                            {f.label}
                          </option>
                        ))}
                      </optgroup>
                    </select>
                  </div>
                ))}
              </div>
            </section>

            <section className="import-section">
              <h3>Pratinjau</h3>
              {preview.hasName ? (
                <>
                  <div className="segmented" role="group" aria-label="Saring baris">
                    {(Object.keys(FILTERS) as RowStatus[]).map((s) => (
                      <button
                        key={s}
                        type="button"
                        aria-pressed={filter === s}
                        onClick={() => {
                          setFilter(s);
                          setLimit(PAGE);
                        }}
                      >
                        {FILTERS[s].label} ({preview.summary[s]})
                      </button>
                    ))}
                  </div>
                  <p className="small muted">{FILTERS[filter].hint}</p>
                  {rows.length ? (
                    <div className="table-wrap">
                      <table className="table responsive import-table">
                        <thead>
                          <tr>
                            {filter !== 'dilewati' ? (
                              <th>
                                <input
                                  type="checkbox"
                                  aria-label="Pilih semua baris"
                                  checked={rows.every(picked)}
                                  onChange={(e) => {
                                    const on = e.target.checked;
                                    const ids = rows.map((r) => r.row);
                                    if (filter === 'siap') setExcluded(on ? new Set([...excluded].filter((n) => !ids.includes(n))) : new Set([...excluded, ...ids]));
                                    else setIncluded(on ? new Set([...included, ...ids]) : new Set([...included].filter((n) => !ids.includes(n))));
                                  }}
                                />
                              </th>
                            ) : null}
                            <th>Baris</th>
                            <th>Anak</th>
                            <th>Lahir</th>
                            <th>Orang tua / wali</th>
                            <th>Keterangan</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.slice(0, limit).map((r) => (
                            <ImportRow key={r.row} r={r} selectable={filter !== 'dilewati'} checked={picked(r)} onToggle={(on) => toggle(r, on)} />
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="muted">Tidak ada baris di bagian ini.</p>
                  )}
                  {rows.length > limit ? (
                    <div className="row">
                      <span className="small muted">
                        Menampilkan {limit} dari {rows.length} baris.
                      </span>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setLimit(rows.length)}>
                        Tampilkan semua
                      </button>
                    </div>
                  ) : null}
                </>
              ) : (
                <p className="muted">Pilih kolom yang berisi nama lengkap anak agar pratinjau dapat ditampilkan.</p>
              )}
            </section>
          </>
        ) : null}

        <div className="import-foot">
          <span className="small muted">{loading && preview ? 'Memperbarui pratinjau…' : preview ? `${total} pasien akan diimpor` : ''}</span>
          <div className="row">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Batal
            </button>
            <button type="button" className="btn" disabled={!preview || loading || importing || total === 0} onClick={() => void runImport()}>
              {importing ? 'Mengimpor…' : `Impor ${total} pasien`}
            </button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

function ImportRow({ r, selectable, checked, onToggle }: { r: Row; selectable: boolean; checked: boolean; onToggle: (on: boolean) => void }) {
  const p = r.patient;
  const [reason, ...notes] = r.status === 'siap' ? [null, ...r.issues] : r.issues;
  return (
    <tr>
      {selectable ? (
        <td data-label="Impor">
          <input type="checkbox" checked={checked} onChange={(e) => onToggle(e.target.checked)} aria-label={`Impor baris ${r.row}`} />
        </td>
      ) : null}
      <td data-label="Baris" className="mono">
        {r.row}
      </td>
      <td data-label="Anak">
        <strong>{p.fullName || '—'}</strong>
        {p.nickname ? <span className="muted"> ({p.nickname})</span> : null}
        {p.status !== 'aktif' ? (
          <div>
            <Badge tone={PATIENT_STATUS[p.status]?.tone}>{PATIENT_STATUS[p.status]?.label}</Badge>
          </div>
        ) : null}
      </td>
      <td data-label="Lahir">
        {p.birthDate ? formatDate(p.birthDate) : '—'}
        {p.sex ? <div className="small muted">{p.sex === 'L' ? 'Laki-laki' : 'Perempuan'}</div> : null}
      </td>
      <td data-label="Orang tua / wali">
        {p.guardians.length
          ? p.guardians.map((g, i) => (
              <div key={i}>
                <span className="muted">{g.relationship}:</span> {g.fullName}
                {g.phone ? <div className="small mono">{g.phone}</div> : null}
              </div>
            ))
          : '—'}
      </td>
      <td data-label="Keterangan">
        {reason ? <div className={r.status === 'dilewati' ? 'import-reason danger' : 'import-reason'}>{reason}</div> : null}
        {notes.length ? (
          <ul className="import-issues">
            {notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        ) : null}
        {!reason && !notes.length ? <span className="muted">—</span> : null}
      </td>
    </tr>
  );
}
