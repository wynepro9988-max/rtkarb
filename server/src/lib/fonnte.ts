// Klien minimal API Fonnte (https://docs.fonnte.com/api-send-message/).
// Token dikirim apa adanya di header Authorization (tanpa "Bearer").
// Nomor tujuan dan isi pesan tidak pernah ditulis ke log.

export type SendResult =
  | { outcome: 'terkirim'; providerId: string | null }
  | { outcome: 'gagal'; reason: string }
  // Tidak ada jawaban: pesan mungkin sudah diterima Fonnte, jadi jangan dikirim ulang otomatis.
  | { outcome: 'tidak_pasti'; reason: string };

export interface DeviceInfo {
  ok: boolean;
  reason: string | null;
  connected: boolean;
  device: string | null;
  quota: string | null;
  expired: string | null;
  plan: string | null;
}

export interface FonnteOptions {
  baseUrl: string;
  timeoutMs: number;
}

function reasonText(value: unknown, fallback: string): string {
  return (typeof value === 'string' && value.trim() ? value.trim() : fallback).slice(0, 200);
}

async function call(opts: FonnteOptions, path: string, token: string, form?: FormData): Promise<Record<string, unknown>> {
  const res = await fetch(`${opts.baseUrl}${path}`, {
    method: 'POST',
    headers: { Authorization: token },
    body: form,
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
  const text = await res.text();
  try {
    const body = JSON.parse(text);
    if (body && typeof body === 'object') return body as Record<string, unknown>;
  } catch {
    // jatuh ke bawah
  }
  return { status: false, reason: `jawaban tidak dikenal (HTTP ${res.status})` };
}

// Dokumentasi Fonnte memakai "status" maupun "Status".
const isOk = (body: Record<string, unknown>) => (body.status ?? body.Status) === true;

export async function fonnteSend(
  opts: FonnteOptions,
  token: string,
  msg: { target: string; message: string; schedule?: number },
): Promise<SendResult> {
  const form = new FormData();
  form.set('target', msg.target);
  form.set('message', msg.message);
  form.set('countryCode', '62');
  if (msg.schedule) form.set('schedule', String(msg.schedule));
  let body: Record<string, unknown>;
  try {
    body = await call(opts, '/send', token, form);
  } catch (err) {
    const name = (err as Error).name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      return { outcome: 'tidak_pasti', reason: 'Fonnte tidak menjawab tepat waktu; cek di dashboard Fonnte sebelum mengirim ulang' };
    }
    return { outcome: 'gagal', reason: 'Tidak dapat menghubungi Fonnte' };
  }
  if (!isOk(body)) return { outcome: 'gagal', reason: reasonText(body.reason ?? body.detail, 'ditolak Fonnte') };
  const ids = Array.isArray(body.id) ? body.id : [];
  return { outcome: 'terkirim', providerId: ids.length ? String(ids[0]).slice(0, 100) : null };
}

export async function fonnteDevice(opts: FonnteOptions, token: string): Promise<DeviceInfo> {
  const empty = { connected: false, device: null, quota: null, expired: null, plan: null };
  let body: Record<string, unknown>;
  try {
    body = await call(opts, '/device', token);
  } catch {
    return { ok: false, reason: 'Tidak dapat menghubungi Fonnte', ...empty };
  }
  if (!isOk(body)) return { ok: false, reason: reasonText(body.reason, 'token ditolak Fonnte'), ...empty };
  const str = (v: unknown) => (v === undefined || v === null || v === '' ? null : String(v).slice(0, 60));
  return {
    ok: true,
    reason: null,
    connected: body.device_status === 'connect',
    device: str(body.device),
    quota: str(body.quota),
    expired: str(body.expired),
    plan: str(body.package),
  };
}
