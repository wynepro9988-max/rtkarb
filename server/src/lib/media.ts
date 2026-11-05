// Pengenalan video/foto sesi dari isi berkas (magic bytes), bukan dari nama/Content-Type kiriman klien.

export interface MediaType {
  kind: 'video' | 'foto';
  mime: string;
  ext: string;
}

const VIDEO_BRANDS: Record<string, MediaType> = {
  'qt  ': { kind: 'video', mime: 'video/quicktime', ext: '.mov' },
  '3gp4': { kind: 'video', mime: 'video/3gpp', ext: '.3gp' },
  '3gp5': { kind: 'video', mime: 'video/3gpp', ext: '.3gp' },
  '3gp6': { kind: 'video', mime: 'video/3gpp', ext: '.3gp' },
  '3g2a': { kind: 'video', mime: 'video/3gpp', ext: '.3gp' },
};
const MP4_BRANDS = new Set(['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'mmp4', 'MSNV', 'dash', 'f4v ']);
export const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'mif1', 'msf1', 'avif']);

export function sniffMedia(buf: Buffer): MediaType | 'heic' | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { kind: 'foto', mime: 'image/jpeg', ext: '.jpg' };
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { kind: 'foto', mime: 'image/png', ext: '.png' };
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return { kind: 'foto', mime: 'image/webp', ext: '.webp' };
  if (buf.length >= 12 && buf.toString('latin1', 4, 8) === 'ftyp') {
    const brand = buf.toString('latin1', 8, 12);
    if (HEIC_BRANDS.has(brand)) return 'heic';
    if (VIDEO_BRANDS[brand]) return VIDEO_BRANDS[brand];
    if (MP4_BRANDS.has(brand)) return { kind: 'video', mime: 'video/mp4', ext: '.mp4' };
  }
  return null;
}

// Durasi video MP4/MOV/3GP (detik) dari kotak moov/mvhd; null bila tidak terbaca.
export function mp4Duration(buf: Buffer): number | null {
  const find = (start: number, end: number, type: string): [number, number] | null => {
    let p = start;
    while (p + 8 <= end) {
      let size = buf.readUInt32BE(p);
      let header = 8;
      if (size === 1) {
        if (p + 16 > end) return null;
        size = Number(buf.readBigUInt64BE(p + 8));
        header = 16;
      } else if (size === 0) size = end - p;
      if (size < header || p + size > end) return null;
      if (buf.toString('latin1', p + 4, p + 8) === type) return [p + header, p + size];
      p += size;
    }
    return null;
  };
  const moov = find(0, buf.length, 'moov');
  const mvhd = moov && find(moov[0], moov[1], 'mvhd');
  if (!mvhd) return null;
  const s = mvhd[0];
  const v1 = buf[s] === 1;
  if (s + (v1 ? 32 : 20) > mvhd[1]) return null;
  const timescale = buf.readUInt32BE(s + (v1 ? 20 : 12));
  const duration = v1 ? Number(buf.readBigUInt64BE(s + 24)) : buf.readUInt32BE(s + 16);
  return timescale ? duration / timescale : null;
}
