import { useCallback, useEffect, useRef, useState } from 'react';

let csrfToken = '';
export const setCsrfToken = (token: string) => {
  csrfToken = token;
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: { field: string; message: string }[];

  constructor(status: number, message: string, code: string, details?: { field: string; message: string }[]) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export async function api<T = any>(path: string, opts: { method?: Method; body?: unknown; form?: FormData } = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (method !== 'GET') headers['X-CSRF-Token'] = csrfToken;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    });
  } catch {
    throw new ApiError(0, 'Tidak dapat terhubung ke server. Periksa koneksi internet Anda.', 'network');
  }
  if (res.status === 401 && !path.startsWith('/auth/')) {
    window.dispatchEvent(new Event('rb:unauthorized'));
  }
  const isJson = res.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await res.json() : null;
  if (!res.ok) {
    throw new ApiError(res.status, data?.error?.message ?? 'Terjadi kesalahan', data?.error?.code ?? 'error', data?.error?.details);
  }
  return data as T;
}

export const get = <T = any>(path: string) => api<T>(path);
export const post = <T = any>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body });
export const put = <T = any>(path: string, body: unknown) => api<T>(path, { method: 'PUT', body });
export const patch = <T = any>(path: string, body: unknown) => api<T>(path, { method: 'PATCH', body });
export const del = <T = any>(path: string) => api<T>(path, { method: 'DELETE' });

export function qs(params: Record<string, string | number | undefined | null | false>) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '' && v !== false) s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : '';
}

export function useApi<T = any>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!path) return;
    const id = ++seq.current;
    setLoading(true);
    try {
      const result = await get<T>(path);
      if (id === seq.current) {
        setData(result);
        setError(null);
      }
    } catch (err) {
      if (id === seq.current) setError(err as ApiError);
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void load();
  }, [load]);

  return { data, error, loading, reload: load, setData };
}

// Unduhan berkas (laporan/dokumen) lewat tautan biasa agar cookie sesi ikut terkirim.
export function downloadUrl(path: string) {
  const a = document.createElement('a');
  a.href = `/api${path}`;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
