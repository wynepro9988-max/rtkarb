import type { Db } from '../db.ts';

// Nomor berurutan per organisasi (aman terhadap permintaan bersamaan karena
// baris counter terkunci selama transaksi).
export async function nextCounter(db: Db, orgId: string, name: string): Promise<number> {
  const row = await db.one<{ value: number }>(
    `INSERT INTO org_counters (organization_id, name, value) VALUES ($1, $2, 1)
     ON CONFLICT (organization_id, name) DO UPDATE SET value = org_counters.value + 1
     RETURNING value`,
    [orgId, name],
  );
  return row.value;
}
