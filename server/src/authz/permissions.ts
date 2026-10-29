// Matriks permission. Role tenant bersifat tetap; perubahan matriks ini adalah
// keputusan kebijakan dan harus dicatat di docs/02-desain-teknis.md.

export const ROLES = ['owner', 'admin', 'terapis', 'keuangan'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin / Koordinator',
  terapis: 'Terapis',
  keuangan: 'Keuangan / Kasir',
};

export const PERMISSIONS = [
  'org.read',
  'org.settings.manage',
  'staff.read',
  'staff.manage',
  'patient.read',
  'patient.read.assigned',
  'patient.manage',
  'patient.assign',
  'schedule.read',
  'schedule.read.own',
  'schedule.manage',
  'session.complete',
  'session.complete.own',
  'session.reopen',
  'therapy.note.read',
  'therapy.note.read.assigned',
  'therapy.note.write',
  'catalog.manage',
  'package.read',
  'package.sell',
  'package.adjust',
  'payment.read',
  'payment.record',
  'payment.void',
  'expense.read',
  'expense.record',
  'expense.void',
  'compensation.read',
  'compensation.read.own',
  'compensation.manage',
  'report.operational',
  'report.finance',
  'report.export',
  'document.read',
  'document.upload',
  'document.archive',
  'audit.read',
  'support.approve',
  'invoice.read',
  'invoice.create',
  'invoice.void',
  'invoice.discount',
  'refund.record',
  'refund.void',
  'finance.reconcile',
  'finance.reconcile.finalize',
  'reminder.send',
  'privacy.manage',
  // Menghubungkan nomor WhatsApp/token Fonnte & kebijakan pengingat otomatis (hanya owner).
  'whatsapp.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const OWNER: Permission[] = PERMISSIONS.filter(
  (p) =>
    !p.endsWith('.assigned') &&
    !p.endsWith('.own') &&
    p !== 'session.complete.own',
);

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: OWNER,
  // Operasional harian; tanpa catatan klinis dan tanpa keuangan.
  admin: [
    'org.read',
    'staff.read',
    'patient.read',
    'patient.manage',
    'patient.assign',
    'schedule.read',
    'schedule.manage',
    'session.complete',
    'package.read',
    'package.sell',
    'report.operational',
    'report.export',
    'document.read',
    'document.upload',
    'reminder.send',
  ],
  // Hanya pasien yang ditugaskan; tidak ada akses keuangan.
  terapis: [
    'org.read',
    'patient.read.assigned',
    'schedule.read.own',
    'session.complete.own',
    'therapy.note.read.assigned',
    'therapy.note.write',
    'package.read',
    'compensation.read.own',
    'document.read',
    'document.upload',
  ],
  // Keuangan; data pasien administratif saja, tanpa catatan klinis.
  keuangan: [
    'org.read',
    'patient.read',
    'schedule.read',
    'package.read',
    'package.sell',
    'payment.read',
    'payment.record',
    'expense.read',
    'expense.record',
    'compensation.read',
    'report.finance',
    'report.export',
    'document.read',
    'invoice.read',
    'invoice.create',
    'finance.reconcile',
  ],
};

// Cakupan yang boleh diminta untuk akses dukungan teknis. Semuanya baca-saja;
// transaksi mode dukungan juga dijalankan READ ONLY di database.
export const SUPPORT_SCOPES = [
  'staff.read',
  'patient.read',
  'schedule.read',
  'package.read',
  'payment.read',
  'expense.read',
  'compensation.read',
  'report.operational',
  'report.finance',
  'audit.read',
  'document.read',
  'therapy.note.read',
] as const satisfies readonly Permission[];
export type SupportScope = (typeof SUPPORT_SCOPES)[number];

export type ScopeLevel = 'all' | 'assigned' | 'none';

export interface DataScopes {
  patient: ScopeLevel;
  note: ScopeLevel;
  finance: ScopeLevel;
  audit: ScopeLevel;
}

export function dataScopes(perms: ReadonlySet<Permission>): DataScopes {
  return {
    patient: perms.has('patient.read') ? 'all' : perms.has('patient.read.assigned') ? 'assigned' : 'none',
    note: perms.has('therapy.note.read') ? 'all' : perms.has('therapy.note.read.assigned') ? 'assigned' : 'none',
    finance: perms.has('payment.read') || perms.has('expense.read') || perms.has('compensation.read') || perms.has('invoice.read') ? 'all' : 'none',
    audit: perms.has('audit.read') ? 'all' : 'none',
  };
}

export function permissionsForRole(role: Role): Set<Permission> {
  return new Set(ROLE_PERMISSIONS[role]);
}

// Admin yang oleh owner ditandai merangkap keuangan (memberships.handles_finance) mendapat
// seluruh hak peran keuangan. Catatan klinis, pengaturan, dan audit log tetap tidak termasuk.
export function permissionsForMember(role: Role, handlesFinance: boolean): Set<Permission> {
  const perms = permissionsForRole(role);
  if (role === 'admin' && handlesFinance) for (const p of ROLE_PERMISSIONS.keuangan) perms.add(p);
  return perms;
}

export function roleLabel(role: Role, handlesFinance = false): string {
  return role === 'admin' && handlesFinance ? 'Admin & Keuangan' : ROLE_LABELS[role];
}

export function permissionsForSupport(scopes: readonly string[]): Set<Permission> {
  const allowed = new Set<string>(SUPPORT_SCOPES);
  const perms = new Set<Permission>(['org.read']);
  for (const s of scopes) if (allowed.has(s)) perms.add(s as Permission);
  return perms;
}
