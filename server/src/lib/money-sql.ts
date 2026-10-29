// Fragmen SQL bersama untuk nilai pembayaran BERSIH (pembayaran tercatat dikurangi refund
// tercatat). `ownerAlias.id` dicocokkan dengan kolom target pembayaran (invoice_id, dst.).
export function netPaidSql(ownerAlias: string, paymentColumn: 'invoice_id' | 'patient_package_id' | 'appointment_id'): string {
  return `coalesce((
    SELECT sum(p.amount - coalesce((SELECT sum(r.amount) FROM refunds r
                                     WHERE r.organization_id = p.organization_id AND r.payment_id = p.id AND r.status = 'tercatat'), 0))
      FROM payments p
     WHERE p.organization_id = ${ownerAlias}.organization_id AND p.${paymentColumn} = ${ownerAlias}.id AND p.status = 'tercatat'), 0)`;
}

// Paket/sesi yang sudah ada di invoice aktif ditagih lewat invoice, bukan langsung.
export function invoicedSql(ownerAlias: string, itemColumn: 'patient_package_id' | 'appointment_id'): string {
  return `EXISTS (SELECT 1 FROM invoice_items ii
                   WHERE ii.organization_id = ${ownerAlias}.organization_id AND ii.${itemColumn} = ${ownerAlias}.id AND ii.active)`;
}
