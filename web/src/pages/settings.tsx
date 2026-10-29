import { useEffect, useState } from 'react';
import { patch, post, useApi } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { formatBytes, formatRupiah } from '../format.ts';
import { WhatsAppSettings } from './whatsapp.tsx';
import { Badge, Dialog, Empty, ErrorBox, Field, Icon, Loading, MoneyInput, PageHeader, Tabs, useSubmit, useToast } from '../ui.tsx';

export function SettingsPage() {
  const { can } = useAuth();
  const tabs = [
    ...(can('org.settings.manage') ? [{ value: 'org' as const, label: 'Organisasi' }] : []),
    ...(can('catalog.manage') ? [{ value: 'layanan' as const, label: 'Layanan terapi' }, { value: 'paket' as const, label: 'Jenis paket' }] : []),
    ...(can('whatsapp.manage') ? [{ value: 'whatsapp' as const, label: 'WhatsApp otomatis' }] : []),
  ];
  const [tab, setTab] = useState(tabs[0]?.value ?? 'org');
  return (
    <>
      <PageHeader title="Pengaturan" />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'org' ? <OrgSettings /> : null}
      {tab === 'layanan' ? <Services /> : null}
      {tab === 'paket' ? <PackageTypes /> : null}
      {tab === 'whatsapp' ? <WhatsAppSettings /> : null}
    </>
  );
}

function OrgSettings() {
  const { reload: reloadMe } = useAuth();
  const { data, error, loading, setData } = useApi<any>('/org');
  const { data: storage } = useApi<{ usedBytes: number; quotaBytes: number }>('/org/storage');
  const [f, setF] = useState<any>(null);
  const toast = useToast();
  useEffect(() => {
    if (data)
      setF({
        name: data.name,
        address: data.address ?? '',
        phone: data.phone ?? '',
        timezone: data.timezone,
        patientCodePrefix: data.patientCodePrefix,
        receiptPrefix: data.receiptPrefix,
        invoicePrefix: data.invoicePrefix,
        financeDiscountMaxPercent: data.financeDiscountMaxPercent,
        reminderTemplate: data.reminderTemplate ?? '',
        retentionYears: data.retentionYears ?? '',
      });
  }, [data]);
  const { busy, error: saveError, submit } = useSubmit(
    () =>
      patch('/org', {
        ...f,
        address: f.address || null,
        phone: f.phone || null,
        financeDiscountMaxPercent: Number(f.financeDiscountMaxPercent) || 0,
        reminderTemplate: f.reminderTemplate || null,
        retentionYears: f.retentionYears ? Number(f.retentionYears) : null,
      }),
    (r) => {
    setData(r);
    toast('Pengaturan organisasi disimpan');
    void reloadMe();
    },
  );
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!f) return null;
  return (
    <form className="card card-pad form" onSubmit={submit} style={{ maxWidth: 720 }}>
      <div className="small muted">
        ID organisasi (permanen): <span className="mono">{data.id}</span>
      </div>
      {storage ? (
        <div className={`alert ${storage.usedBytes > storage.quotaBytes * 0.8 ? 'warn' : 'info'}`}>
          Penyimpanan dokumen: <strong>{formatBytes(storage.usedBytes)}</strong> dari kuota {formatBytes(storage.quotaBytes)} (
          {((storage.usedBytes / storage.quotaBytes) * 100).toFixed(1)}%). Dokumen yang diarsipkan tetap memakai kuota.
        </div>
      ) : null}
      <div className="form-grid">
        <Field label="Nama resmi" full>
          {(id) => <input id={id} className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required minLength={2} />}
        </Field>
        <Field label="Alamat" hint="Tampil di kuitansi" full>
          {(id) => <input id={id} className="input" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} maxLength={500} />}
        </Field>
        <Field label="Telepon">{(id) => <input id={id} className="input" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} maxLength={40} />}</Field>
        <Field label="Zona waktu">
          {(id) => (
            <select id={id} className="select" value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })}>
              <option value="Asia/Jakarta">WIB (Asia/Jakarta)</option>
              <option value="Asia/Makassar">WITA (Asia/Makassar)</option>
              <option value="Asia/Jayapura">WIT (Asia/Jayapura)</option>
            </select>
          )}
        </Field>
        <Field label="Awalan kode pasien" hint="Contoh: RB → RB-0001">
          {(id) => <input id={id} className="input mono" value={f.patientCodePrefix} onChange={(e) => setF({ ...f, patientCodePrefix: e.target.value.toUpperCase() })} maxLength={8} required />}
        </Field>
        <Field label="Awalan nomor kuitansi" hint="Contoh: KW → KW/2026/00001">
          {(id) => <input id={id} className="input mono" value={f.receiptPrefix} onChange={(e) => setF({ ...f, receiptPrefix: e.target.value.toUpperCase() })} maxLength={8} required />}
        </Field>
        <Field label="Awalan nomor invoice" hint="Contoh: INV → INV/2026/00001">
          {(id) => <input id={id} className="input mono" value={f.invoicePrefix} onChange={(e) => setF({ ...f, invoicePrefix: e.target.value.toUpperCase() })} maxLength={8} required />}
        </Field>
        <Field label="Batas diskon kasir (%)" hint="0 = hanya owner yang boleh memberi diskon. Diskon selalu wajib beralasan.">
          {(id) => <input id={id} className="input" type="number" min={0} max={100} step={0.5} value={f.financeDiscountMaxPercent} onChange={(e) => setF({ ...f, financeDiscountMaxPercent: e.target.value })} />}
        </Field>
        <Field label="Masa retensi pasien tidak aktif (tahun)" hint="Kosongkan bila belum ditetapkan. Hanya menandai kandidat; tidak menghapus otomatis.">
          {(id) => <input id={id} className="input" type="number" min={1} max={50} value={f.retentionYears} onChange={(e) => setF({ ...f, retentionYears: e.target.value })} />}
        </Field>
        <Field label="Templat pengingat WhatsApp" full hint="Penanda: {wali} {anak} {organisasi} {hari} {tanggal} {jam} {terapis}. {jam} berisi semua jam sesi anak hari itu (satu pesan per anak per hari). Kosongkan untuk templat bawaan. Jangan memasukkan informasi klinis.">
          {(id) => <textarea id={id} className="textarea" value={f.reminderTemplate} onChange={(e) => setF({ ...f, reminderTemplate: e.target.value })} maxLength={600} />}
        </Field>
      </div>
      <ErrorBox error={saveError} />
      <div className="form-actions">
        <button className="btn" disabled={busy}>
          Simpan
        </button>
      </div>
    </form>
  );
}

function Services() {
  const { data, error, loading, reload } = useApi<any[]>('/services');
  const [editing, setEditing] = useState<any | null>(null);
  return (
    <section className="card">
      <div className="card-head">
        <h2>Layanan terapi</h2>
        <button className="btn btn-sm" onClick={() => setEditing({})}>
          <Icon name="plus" /> Layanan baru
        </button>
      </div>
      {loading && !data ? <Loading /> : null}
      <ErrorBox error={error} />
      {data?.length === 0 ? <Empty title="Belum ada layanan">Contoh: Terapi Wicara, Terapi Okupasi, Sensori Integrasi.</Empty> : null}
      {data?.length ? (
        <div className="table-wrap">
          <table className="table responsive">
            <thead>
              <tr>
                <th>Nama</th>
                <th className="num">Durasi</th>
                <th className="num">Tarif per sesi</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((s) => (
                <tr key={s.id}>
                  <td data-label="Nama">{s.name}</td>
                  <td data-label="Durasi" className="num">
                    {s.defaultDurationMinutes} mnt
                  </td>
                  <td data-label="Tarif" className="num">
                    {formatRupiah(s.defaultPrice)}
                  </td>
                  <td data-label="Status">
                    <Badge tone={s.active ? 'ok' : ''}>{s.active ? 'Aktif' : 'Nonaktif'}</Badge>
                  </td>
                  <td>
                    <button className="btn btn-sm btn-ghost" onClick={() => setEditing(s)}>
                      Ubah
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {editing ? <ServiceDialog service={editing} onClose={() => setEditing(null)} onSaved={reload} /> : null}
    </section>
  );
}

function ServiceDialog({ service, onClose, onSaved }: { service: any; onClose: () => void; onSaved: () => void }) {
  const editing = Boolean(service.id);
  const [f, setF] = useState({ name: service.name ?? '', defaultDurationMinutes: service.defaultDurationMinutes ?? 60, defaultPrice: (service.defaultPrice ?? '') as number | '', active: service.active ?? true });
  const { busy, error, submit } = useSubmit(
    () => {
      const body = { name: f.name, defaultDurationMinutes: Number(f.defaultDurationMinutes), defaultPrice: f.defaultPrice || 0 };
      return editing ? patch(`/services/${service.id}`, { ...body, active: f.active }) : post('/services', body);
    },
    () => {
      onSaved();
      onClose();
    },
  );
  return (
    <Dialog title={editing ? 'Ubah layanan' : 'Layanan baru'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <Field label="Nama layanan">{(id) => <input id={id} className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required minLength={2} />}</Field>
        <div className="form-grid">
          <Field label="Durasi default (menit)">
            {(id) => <input id={id} className="input" type="number" min={5} max={480} step={5} value={f.defaultDurationMinutes} onChange={(e) => setF({ ...f, defaultDurationMinutes: Number(e.target.value) })} />}
          </Field>
          <Field label="Tarif per sesi (Rp)" hint="Dipakai untuk tagihan per sesi">
            {(id) => <MoneyInput id={id} value={f.defaultPrice} onChange={(v) => setF({ ...f, defaultPrice: v })} />}
          </Field>
        </div>
        {editing ? (
          <label className="check">
            <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Aktif (dapat dipilih saat membuat jadwal)
          </label>
        ) : null}
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

function PackageTypes() {
  const { data, error, loading, reload } = useApi<any[]>('/package-types');
  const { data: services } = useApi<any[]>('/services');
  const [editing, setEditing] = useState<any | null>(null);
  return (
    <section className="card">
      <div className="card-head">
        <h2>Jenis paket</h2>
        <button className="btn btn-sm" onClick={() => setEditing({})}>
          <Icon name="plus" /> Jenis paket baru
        </button>
      </div>
      <p className="card-body small muted" style={{ paddingBottom: 0 }}>
        Perubahan harga tidak mengubah paket yang sudah dijual (harga tersimpan saat penjualan).
      </p>
      {loading && !data ? <Loading /> : null}
      <ErrorBox error={error} />
      {data?.length === 0 ? <Empty title="Belum ada jenis paket" /> : null}
      {data?.length ? (
        <div className="table-wrap">
          <table className="table responsive">
            <thead>
              <tr>
                <th>Nama</th>
                <th>Layanan</th>
                <th className="num">Sesi</th>
                <th className="num">Harga</th>
                <th>Masa berlaku</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((p) => (
                <tr key={p.id}>
                  <td data-label="Nama">{p.name}</td>
                  <td data-label="Layanan">{p.serviceName ?? 'Semua'}</td>
                  <td data-label="Sesi" className="num">
                    {p.sessionsTotal}
                  </td>
                  <td data-label="Harga" className="num">
                    {formatRupiah(p.price)}
                  </td>
                  <td data-label="Masa berlaku">{p.validDays ? `${p.validDays} hari` : 'Tanpa batas'}</td>
                  <td data-label="Status">
                    <Badge tone={p.active ? 'ok' : ''}>{p.active ? 'Aktif' : 'Nonaktif'}</Badge>
                  </td>
                  <td>
                    <button className="btn btn-sm btn-ghost" onClick={() => setEditing(p)}>
                      Ubah
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {editing ? <PackageTypeDialog pt={editing} services={services ?? []} onClose={() => setEditing(null)} onSaved={reload} /> : null}
    </section>
  );
}

function PackageTypeDialog({ pt, services, onClose, onSaved }: { pt: any; services: any[]; onClose: () => void; onSaved: () => void }) {
  const editing = Boolean(pt.id);
  const [f, setF] = useState({
    name: pt.name ?? '',
    serviceId: pt.serviceId ?? '',
    sessionsTotal: pt.sessionsTotal ?? 8,
    price: (pt.price ?? '') as number | '',
    validDays: pt.validDays ?? '',
    active: pt.active ?? true,
  });
  const { busy, error, submit } = useSubmit(
    () =>
      editing
        ? patch(`/package-types/${pt.id}`, { name: f.name, price: f.price || 0, validDays: f.validDays ? Number(f.validDays) : null, active: f.active })
        : post('/package-types', {
            name: f.name,
            serviceId: f.serviceId || null,
            sessionsTotal: Number(f.sessionsTotal),
            price: f.price || 0,
            validDays: f.validDays ? Number(f.validDays) : null,
          }),
    () => {
      onSaved();
      onClose();
    },
  );
  return (
    <Dialog title={editing ? 'Ubah jenis paket' : 'Jenis paket baru'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <Field label="Nama paket">{(id) => <input id={id} className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required minLength={2} />}</Field>
        <div className="form-grid">
          <Field label="Layanan">
            {(id) => (
              <select id={id} className="select" value={f.serviceId} onChange={(e) => setF({ ...f, serviceId: e.target.value })} disabled={editing}>
                <option value="">Semua layanan</option>
                {services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Jumlah sesi">
            {(id) => <input id={id} className="input" type="number" min={1} max={500} value={f.sessionsTotal} onChange={(e) => setF({ ...f, sessionsTotal: Number(e.target.value) })} disabled={editing} required />}
          </Field>
          <Field label="Harga (Rp)">{(id) => <MoneyInput id={id} value={f.price} onChange={(v) => setF({ ...f, price: v })} required />}</Field>
          <Field label="Masa berlaku (hari)" hint="Kosongkan bila tanpa batas">
            {(id) => <input id={id} className="input" type="number" min={1} max={3650} value={f.validDays} onChange={(e) => setF({ ...f, validDays: e.target.value })} />}
          </Field>
        </div>
        {editing ? (
          <label className="check">
            <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Aktif (dapat dijual)
          </label>
        ) : null}
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
