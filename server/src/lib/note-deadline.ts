// Kewajiban catatan sesi (keputusan owner 29 Okt 2026): setiap sesi berstatus selesai wajib
// memiliki catatan FINAL paling lambat akhir bulan kalender sesi tersebut, menurut zona waktu
// organisasi. Tidak memblokir penandaan "selesai"; hanya menandai keterlambatan.
//
// Fragmen SQL ini mengandaikan alias `a` = appointments dan `n` = therapy_notes (LEFT JOIN per sesi),
// serta `tz` = placeholder parameter zona waktu (mis. '$2').

const sessionMonth = (tz: string) => `to_char(a.starts_at AT TIME ZONE ${tz}, 'YYYY-MM')`;

/** Tanggal terakhir yang masih tepat waktu (YYYY-MM-DD). */
export const noteDeadlineSql = (tz: string) =>
  `to_char(date_trunc('month', a.starts_at AT TIME ZONE ${tz}) + interval '1 month - 1 day', 'YYYY-MM-DD')`;

/** Catatan belum final (tidak ada atau masih draf). */
export const noteNotFinalSql = `(n.id IS NULL OR n.status <> 'final')`;

/** Belum final dan bulan sesi sudah lewat. */
export const noteOverdueSql = (tz: string) => `(${noteNotFinalSql} AND ${sessionMonth(tz)} < to_char(now() AT TIME ZONE ${tz}, 'YYYY-MM'))`;

/** Sudah final, tetapi difinalkan setelah batas. */
export const noteFinalLateSql = (tz: string) =>
  `(n.status = 'final' AND to_char(n.finalized_at AT TIME ZONE ${tz}, 'YYYY-MM') > ${sessionMonth(tz)})`;
