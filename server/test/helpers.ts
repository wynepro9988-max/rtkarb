import './env.ts';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync, inflateSync } from 'node:zlib';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { buildApp } from '../src/app.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { createPool, type Pool } from '../src/db.ts';
import { hashPassword } from '../src/security/password.ts';
import { testUrls } from './env.ts';

// Semua data di sini sintetis (berlabel DEMO / domain .invalid), bukan data pasien nyata.
export const ORIGIN = 'http://localhost:5173';
export const PASSWORD = 'KataSandiUji#2026';
const PASSWORD_HASH = await hashPassword(PASSWORD);

export interface TestEnv {
  app: FastifyInstance;
  appPool: Pool;
  adminPool: pg.Pool;
  config: Config;
  close(): Promise<void>;
}

export async function setupEnv(overrides: Partial<Config> = {}): Promise<TestEnv> {
  const { appUrl, adminUrl } = testUrls();
  const uploadDir = path.resolve(import.meta.dirname, '../../.data/test-uploads', randomUUID());
  await mkdir(uploadDir, { recursive: true });
  const config: Config = {
    ...loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: appUrl,
      APP_ORIGINS: ORIGIN,
      PUBLIC_BASE_URL: ORIGIN,
      COOKIE_SECURE: 'false',
      UPLOAD_DIR: uploadDir,
      MAX_UPLOAD_MB: '1',
      LOG_LEVEL: 'silent',
      RATE_LIMIT_PER_MINUTE: '100000',
      AUTH_RATE_LIMIT_PER_MINUTE: '100000',
    }),
    ...overrides,
  };
  const appPool = createPool(appUrl, { max: 20 });
  const app = await buildApp(config, appPool);
  await app.ready();
  const adminPool = new pg.Pool({ connectionString: adminUrl, max: 5 });
  return {
    app,
    appPool,
    adminPool,
    config,
    async close() {
      await app.close();
      await appPool.end();
      await adminPool.end();
    },
  };
}

let counter = 0;
export const uniq = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;

export interface Person {
  userId: string;
  memberId: string;
  email: string;
}

export interface Tenant {
  orgId: string;
  name: string;
  owner: Person;
  admin: Person;
  therapist: Person;
  therapist2: Person;
  finance: Person;
  serviceId: string;
  packageTypeId: string;
  patientId: string; // ditugaskan ke therapist
  patient2Id: string; // tidak ditugaskan ke siapa pun
}

export async function createOrg(admin: pg.Pool, name: string): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(`INSERT INTO organizations (name) VALUES ($1) RETURNING id`, [name]);
  return rows[0].id;
}

export async function createUser(admin: pg.Pool, label: string, platformAdmin = false): Promise<{ userId: string; email: string }> {
  const email = `${label}.${uniq()}@demo.invalid`.toLowerCase();
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO users (email, full_name, password_hash, platform_role) VALUES ($1, $2, $3, $4) RETURNING id`,
    [email, `DEMO ${label}`, PASSWORD_HASH, platformAdmin ? 'platform_admin' : null],
  );
  return { userId: rows[0].id, email };
}

export async function createMember(
  admin: pg.Pool,
  orgId: string,
  role: 'owner' | 'admin' | 'terapis' | 'keuangan',
  label: string,
  isTherapist = role === 'terapis',
): Promise<Person> {
  const u = await createUser(admin, label);
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO memberships (organization_id, user_id, role, is_therapist) VALUES ($1, $2, $3, $4) RETURNING id`,
    [orgId, u.userId, role, isTherapist],
  );
  return { ...u, memberId: rows[0].id };
}

export async function createPatient(admin: pg.Pool, orgId: string, label: string): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO patients (organization_id, patient_code, full_name) VALUES ($1, $2, $3) RETURNING id`,
    [orgId, `T-${uniq()}`, `DEMO Anak ${label}`],
  );
  return rows[0].id;
}

export async function buildTenant(admin: pg.Pool, label: string): Promise<Tenant> {
  const name = `DEMO Organisasi ${label} ${uniq()}`;
  const orgId = await createOrg(admin, name);
  const owner = await createMember(admin, orgId, 'owner', `owner${label}`);
  const adm = await createMember(admin, orgId, 'admin', `admin${label}`);
  const therapist = await createMember(admin, orgId, 'terapis', `terapis${label}`);
  const therapist2 = await createMember(admin, orgId, 'terapis', `terapis2${label}`);
  const finance = await createMember(admin, orgId, 'keuangan', `keuangan${label}`);
  const service = await admin.query<{ id: string }>(
    `INSERT INTO therapy_services (organization_id, name, default_duration_minutes, default_price) VALUES ($1, 'Terapi Wicara', 60, 150000) RETURNING id`,
    [orgId],
  );
  const pkgType = await admin.query<{ id: string }>(
    `INSERT INTO package_types (organization_id, name, service_id, sessions_total, price) VALUES ($1, 'Paket 8 Sesi', $2, 8, 1000000) RETURNING id`,
    [orgId, service.rows[0].id],
  );
  const patientId = await createPatient(admin, orgId, `${label}1`);
  const patient2Id = await createPatient(admin, orgId, `${label}2`);
  await admin.query(`INSERT INTO patient_therapists (organization_id, patient_id, member_id) VALUES ($1, $2, $3)`, [
    orgId,
    patientId,
    therapist.memberId,
  ]);
  await admin.query(
    `INSERT INTO guardians (organization_id, patient_id, full_name, relationship, phone, is_primary) VALUES ($1, $2, $3, 'Ibu', '080000000000', true)`,
    [orgId, patientId, `DEMO Wali ${label}`],
  );
  return {
    orgId,
    name,
    owner,
    admin: adm,
    therapist,
    therapist2,
    finance,
    serviceId: service.rows[0].id,
    packageTypeId: pkgType.rows[0].id,
    patientId,
    patient2Id,
  };
}

export class Agent {
  readonly app: FastifyInstance;
  cookie = '';
  csrf = '';

  constructor(app: FastifyInstance) {
    this.app = app;
  }

  request(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown, headers: Record<string, string> = {}) {
    return this.app.inject({
      method,
      url,
      payload: body as never,
      headers: { cookie: this.cookie, 'x-csrf-token': this.csrf, origin: ORIGIN, ...headers },
    });
  }
  get(url: string) {
    return this.request('GET', url);
  }
  post(url: string, body: unknown = {}) {
    return this.request('POST', url, body);
  }
  put(url: string, body: unknown = {}) {
    return this.request('PUT', url, body);
  }
  patch(url: string, body: unknown = {}) {
    return this.request('PATCH', url, body);
  }
  delete(url: string) {
    return this.request('DELETE', url);
  }
}

export async function login(app: FastifyInstance, email: string, password = PASSWORD): Promise<Agent> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password }, headers: { origin: ORIGIN } });
  if (res.statusCode !== 200) throw new Error(`Login gagal (${res.statusCode}): ${res.body}`);
  const agent = new Agent(app);
  const sid = res.cookies.find((c) => c.name === 'rb_sid');
  agent.cookie = `rb_sid=${sid?.value}`;
  const me = await agent.get('/api/auth/me');
  agent.csrf = me.json().csrfToken;
  return agent;
}

export function json<T = any>(res: LightMyRequestResponse): T {
  return res.json() as T;
}

// Tanggal lokal (Asia/Jakarta) dengan selisih hari.
export function localDate(offsetDays = 0): string {
  const now = new Date(Date.now() + 7 * 3600_000 + offsetDays * 86_400_000);
  return now.toISOString().slice(0, 10);
}

export function multipartBody(fields: Record<string, string>, file: { name: string; content: Buffer; type?: string }) {
  const boundary = `----rtka${randomUUID()}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type ?? 'application/octet-stream'}\r\n\r\n`,
    ),
    file.content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return { payload: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

// Membaca isi semua entri ZIP (untuk memeriksa XLSX tanpa dependensi tambahan).
export function unzipAll(buf: Buffer): string {
  let out = '';
  let i = 0;
  while (i < buf.length - 4 && buf.readUInt32LE(i) === 0x04034b50) {
    const compressed = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const start = i + 30 + nameLen + extraLen;
    out += inflateRawSync(buf.subarray(start, start + compressed)).toString('utf8');
    i = start + compressed;
  }
  return out;
}

// Mengambil seluruh teks dari PDF buatan server/src/lib/pdf.ts (stream FlateDecode, operator Tj).
export function pdfText(buf: Buffer): string {
  const raw = buf.toString('latin1');
  const out: string[] = [];
  let i = 0;
  while ((i = raw.indexOf('>>\nstream\n', i)) !== -1) {
    const start = i + 10;
    const end = raw.indexOf('\nendstream', start);
    if (end === -1) break;
    try {
      const content = inflateSync(buf.subarray(start, end)).toString('latin1');
      for (const m of content.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)) out.push(m[1].replace(/\\([\\()])/g, '$1'));
    } catch {
      // bukan stream teks (mis. gambar JPEG)
    }
    i = end + 10;
  }
  return out.join('\n');
}
