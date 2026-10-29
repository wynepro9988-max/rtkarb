import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Enkripsi rahasia pihak ketiga (mis. token Fonnte) sebelum disimpan di database.
// AES-256-GCM; `context` (ID organisasi) dipakai sebagai AAD sehingga ciphertext
// milik satu organisasi tidak dapat dipindahkan ke baris organisasi lain.
// Format: v1.<iv>.<tag>.<ciphertext> (base64url).
export function sealSecret(key: Buffer, plaintext: string, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), ct].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
}

export function openSecret(key: Buffer, sealed: string, context: string): string {
  const [version, iv, tag, ct] = sealed.split('.');
  if (version !== 'v1' || !iv || !tag || ct === undefined) throw new Error('format rahasia tidak dikenal');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}
