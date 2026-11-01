import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// scrypt dengan parameter setara rekomendasi OWASP (N=2^15, r=8, p=3).
const N = 2 ** 15;
const R = 8;
const P = 3;
const KEYLEN = 32;
const MAXMEM = 128 * N * R * 2 * P;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, KEYLEN, { N: n, r, p, maxmem: Math.max(MAXMEM, 128 * n * r * 2 * p) }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64url');
  const actual = await derive(password, Buffer.from(salt, 'base64url'), Number(n), Number(r), Number(p));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// Dipakai saat akun tidak ditemukan agar waktu respons login setara.
let dummyHash: Promise<string> | null = null;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword(randomBytes(12).toString('hex'));
  await verifyPassword(password, await dummyHash);
}

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

// `identities`: email dan/atau username akun; kata sandi tidak boleh memuat bagian namanya.
export function passwordProblem(password: string, ...identities: (string | null | undefined)[]): string | null {
  if (password.length < PASSWORD_MIN) return `Kata sandi minimal ${PASSWORD_MIN} karakter`;
  if (password.length > PASSWORD_MAX) return `Kata sandi maksimal ${PASSWORD_MAX} karakter`;
  for (const identity of identities) {
    if (identity && password.toLowerCase().includes(identity.split('@')[0].toLowerCase())) {
      return 'Kata sandi tidak boleh memuat username atau nama email';
    }
  }
  if (/^(.)\1+$/.test(password)) return 'Kata sandi terlalu mudah ditebak';
  return null;
}
