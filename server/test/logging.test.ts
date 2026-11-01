import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { buildTenant, json, login, ORIGIN, setupEnv, type Tenant, type TestEnv } from './helpers.ts';

let env: TestEnv;
let A: Tenant;
let app: FastifyInstance;
const lines: string[] = [];

beforeAll(async () => {
  env = await setupEnv();
  A = await buildTenant(env.adminPool, 'A');
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  app = await buildApp({ ...env.config, logLevel: 'info' }, env.appPool, { logStream: stream });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await env.close();
});

describe('Log aplikasi tidak memuat data sensitif', () => {
  it('pencarian pasien, isi catatan, kata sandi, cookie, dan nilai error database tidak tercatat', async () => {
    // Kata sandi pada login gagal.
    await app.inject({ method: 'POST', url: '/api/auth/login', payload: { identifier: A.owner.email, password: 'SandiRahasiaLogUji' }, headers: { origin: ORIGIN } });

    const owner = await login(app, A.owner.email);
    const therapist = await login(app, A.therapist.email);

    // Query pencarian berisi nama anak.
    await owner.get(`/api/patients?q=${encodeURIComponent('NamaAnakRahasia')}`);
    // Isi catatan klinis.
    const note = await therapist.post('/api/notes', { patientId: A.patientId, observations: 'IsiKlinisRahasiaUji' });
    expect(note.statusCode).toBe(201);
    // Error database (unique violation) dengan nilai yang tidak boleh tercatat.
    await owner.post('/api/services', { name: 'NamaLayananRahasia' });
    const dup = await owner.post('/api/services', { name: 'NamaLayananRahasia' });
    expect(dup.statusCode).toBe(409);
    expect(json(dup).error.message).not.toContain('NamaLayananRahasia');

    const log = lines.join('');
    expect(log.length).toBeGreaterThan(0);
    for (const secret of ['SandiRahasiaLogUji', 'NamaAnakRahasia', 'IsiKlinisRahasiaUji', 'NamaLayananRahasia', owner.cookie.split('=')[1], owner.csrf]) {
      expect(log, `log memuat "${secret}"`).not.toContain(secret);
    }
    // Yang tercatat: pola rute & kode constraint (cukup untuk debugging).
    expect(log).toContain('"/api/patients"');
    expect(log).toContain('therapy_services_org_name_key');
  });
});
