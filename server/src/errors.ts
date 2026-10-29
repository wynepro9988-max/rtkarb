export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, message: string, code = 'error', details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// Permintaan ke data organisasi lain selalu dijawab 404 (sama dengan data yang
// memang tidak ada), agar keberadaan data tenant lain tidak terungkap.
export const notFound = (what = 'Data') => new HttpError(404, `${what} tidak ditemukan`, 'not_found');

export const forbidden = (message = 'Anda tidak memiliki izin untuk tindakan ini') =>
  new HttpError(403, message, 'forbidden');

export const unauthorized = () =>
  new HttpError(401, 'Sesi tidak valid atau telah berakhir. Silakan masuk kembali.', 'unauthorized');

export const conflict = (message: string) => new HttpError(409, message, 'conflict');

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, message, 'bad_request', details);
