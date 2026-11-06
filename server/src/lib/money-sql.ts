// Fragmen SQL bersama untuk nilai pembayaran BERSIH (pembayaran tercatat dikurangi refund
// tercatat). `ownerAlias.id` dicocokkan dengan kolom target pembayaran (invoice_id, dst.).
// Untuk paket lama, nominal yang sudah dibayar sebelum memakai aplikasi (opening_paid) ikut dihitung.
export function netPaidSql(ownerAlias: string, paymentColumn: 'invoice_id' | 'patient_package_id' | 'appointment_id'): string {
  const opening = paymentColumn === 'patient_package_id' ? `${ownerAlias}.opening_paid + ` : '';
  return `(${opening}coalesce((
    SELECT sum(p.amount - coalesce((SELECT sum(r.amount) FROM refunds r
                                     WHERE r.organization_id = p.organization_id AND r.payment_id = p.id AND r.status = 'tercatat'), 0))
      FROM payments p
     WHERE p.organization_id = ${ownerAlias}.organization_id AND p.${paymentColumn} = ${ownerAlias}.id AND p.status = 'tercatat'), 0))`;
}

// Paket/sesi yang sudah ada di invoice aktif ditagih lewat invoice, bukan langsung.
export function invoicedSql(ownerAlias: string, itemColumn: 'patient_package_id' | 'appointment_id'): string {
  return `EXISTS (SELECT 1 FROM invoice_items ii
                   WHERE ii.organization_id = ${ownerAlias}.organization_id AND ii.${itemColumn} = ${ownerAlias}.id AND ii.active)`;
}

// Hari hadir terapis per bulan (untuk tunjangan harian): tanggal di zona waktu organisasi dengan minimal
// satu sesi selesai. Parameter: organisasi, zona waktu, bulan pertama & terakhir (tanggal 1).
export function workdaysCte(org: string, tz: string, firstMonth: string, lastMonth: string) {
  return `workdays AS (
    SELECT a.therapist_member_id AS member_id, date_trunc('month', a.starts_at AT TIME ZONE ${tz})::date AS period,
           count(DISTINCT (a.starts_at AT TIME ZONE ${tz})::date)::int AS days
      FROM appointments a
     WHERE a.organization_id = ${org} AND a.status = 'selesai' AND a.therapist_member_id IS NOT NULL
       AND a.starts_at >= ${firstMonth}::date::timestamp AT TIME ZONE ${tz}
       AND a.starts_at < (${lastMonth}::date + interval '1 month')::timestamp AT TIME ZONE ${tz}
     GROUP BY 1, 2)`;
}
// Nominal komponen pada satu bulan sebelum dibayar; `w` = baris workdays bulan itu.
export const componentAmountSql = `CASE WHEN c.basis = 'harian' THEN c.amount * coalesce(w.days, 0) ELSE c.amount END`;
