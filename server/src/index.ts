import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { assertSafeAppRole, createPool } from './db.ts';

const config = loadConfig();
const pool = createPool(config.databaseUrl, { max: config.dbPoolMax });
await assertSafeAppRole(pool);

const app = await buildApp(config, pool);
await app.listen({ host: config.host, port: config.port });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    app.log.info({ signal }, 'menghentikan server');
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
