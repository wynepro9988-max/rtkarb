// Entry point Vercel Function (Build Output API, lihat scripts/build-vercel.mjs).
// Aplikasi Fastify dibuat sekali per instance lalu dipakai ulang antar-permintaan.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { assertSafeAppRole, createPool } from './db.ts';

let ready: Promise<FastifyInstance> | null = null;

async function init(): Promise<FastifyInstance> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl, { max: config.dbPoolMax });
  await assertSafeAppRole(pool);
  const app = await buildApp(config, pool);
  await app.ready();
  return app;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  ready ??= init().catch((err) => {
    ready = null;
    throw err;
  });
  let app: FastifyInstance;
  try {
    app = await ready;
  } catch (err) {
    // Tanpa detail (bisa berisi info koneksi); detail ada di log fungsi.
    console.error('Gagal memulai aplikasi:', (err as Error).message);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: { code: 'unavailable', message: 'Layanan sedang tidak tersedia. Coba lagi sebentar lagi.' } }));
    return;
  }
  app.server.emit('request', req, res);
}
