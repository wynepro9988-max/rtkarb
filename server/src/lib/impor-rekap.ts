// Impor rekap absensi lama (mis. dari Google Form sebelum memakai aplikasi) sebagai sesi selesai, dalam
// SATU transaksi. Bawaan: uji coba (transaksi dibatalkan di akhir); simpan hanya dengan commit = true.
// Keputusan owner 6 Nov 2026:
// - Sesi impor bertagihan "tanpa biaya": sisa paket per hari ini dicatat terpisah (paket lama), sehingga
//   sesi lama tidak memotong paket dan tidak membuat tagihan per sesi. Honor per sesi & hari hadir tetap
//   terhitung (compute_compensation).
// - Catatan sesi ditulis atas nama terapis yang menangani (author = terapis), status final.
// - Pasien yang belum terdaftar dibuat dengan data minimal (nama, panggilan, program OT/TW).
// Data masukan berisi data pasien nyata: simpan di luar repositori dan hapus setelah dipakai.
import type { AuthContext } from '../authz/context.ts';
import { dataScopes, permissionsForRole } from '../authz/permissions.ts';
import { writeAudit } from '../audit.ts';
import { withTx, type Db, type Pool } from '../db.ts';
import { completeAppointment, linkTherapist, lockAppointment, toTimestamp } from '../routes/appointments.ts';
import { nextCounter } from './counters.ts';

export interface RekapInput {
  orgId: string;
  // Owner yang menjalankan impor (pelaku di audit log).
  actorMemberId: string;
  newPatients?: { key: string; fullName: string; nickname?: string | null; programServiceIds?: string[] }[];
  sessions?: {
    ref: string; // penanda baris sumber (tanpa isi klinis), untuk ringkasan
    patientId?: string;
    patientKey?: string;
    therapistMemberId: string;
    serviceId: string;
    date: string; // YYYY-MM-DD
    time: string; // HH:MM
    objectives?: string | null;
    activities?: string | null;
    observations?: string | null;
    homeProgram?: string | null;
  }[];
  // Tunjangan bernama `name` milik terapis-terapis ini diubah menjadi per hari hadir mulai `month`.
  dailyAllowance?: { memberIds: string[]; name: string; month: string };
}

export interface RekapResult {
  committed: boolean;
  patients: { key: string; patientCode: string; existed: boolean }[];
  sessions: { ref: string; result: 'dimasukkan' | 'sudah ada'; noteWritten: boolean; compensation: number | null }[];
  allowances: { memberId: string; result: 'diubah' | 'sudah harian' | 'tidak ditemukan' }[];
}

class DryRun extends Error {
  readonly result: RekapResult;
  constructor(result: RekapResult) {
    super('uji coba');
    this.result = result;
  }
}

const cut = (s: string | null | undefined, max: number) => {
  const t = (s ?? '').trim();
  return t ? t.slice(0, max) : null;
};

export async function importRekap(pool: Pool, input: RekapInput, opts: { commit: boolean }): Promise<RekapResult> {
  const result: RekapResult = { committed: opts.commit, patients: [], sessions: [], allowances: [] };
  const run = async (db: Db) => {
    const actor = await db.one<{ userId: string; role: string; timezone: string }>(
      `SELECT m.user_id, m.role, o.timezone FROM memberships m JOIN organizations o ON o.id = m.organization_id
        WHERE m.organization_id = $1 AND m.id = $2 AND m.status = 'active'`,
      [input.orgId, input.actorMemberId],
    );
    if (actor.role !== 'owner') throw new Error('Impor hanya dapat dijalankan atas nama owner organisasi');
    const ctx = {
      mode: 'tenant',
      orgId: input.orgId,
      userId: actor.userId,
      memberId: input.actorMemberId,
      timezone: actor.timezone,
    } as AuthContext;
    const asActor = () => db.exec(`SELECT set_config('app.member_id', $1, true), set_config('app.user_id', $2, true)`, [input.actorMemberId, actor.userId]);
    await asActor();
    const auditEntry = (action: string, entityType: string, entityId: string, meta: Record<string, unknown>) =>
      writeAudit(db, null, { orgId: input.orgId, userId: actor.userId, memberId: input.actorMemberId }, { action, entityType, entityId, meta: { ...meta, lewat: 'impor_rekap' } });

    // ---- Pasien baru (data minimal) ----
    const keyToId = new Map<string, string>();
    const prefix = (await db.one<{ patientCodePrefix: string }>(`SELECT patient_code_prefix FROM organizations WHERE id = $1`, [input.orgId])).patientCodePrefix;
    for (const p of input.newPatients ?? []) {
      // Idempoten: nama lengkap yang sama persis dipakai ulang, tidak dibuat ganda bila impor diulang.
      const same = await db.many<{ id: string; patientCode: string }>(
        `SELECT id, patient_code FROM patients WHERE organization_id = $1 AND lower(full_name) = lower($2) AND anonymized_at IS NULL`,
        [input.orgId, p.fullName.trim()],
      );
      if (same.length > 1) throw new Error(`Pasien baru "${p.key}": ada lebih dari satu pasien bernama sama`);
      if (same.length === 1) {
        keyToId.set(p.key, same[0].id);
        result.patients.push({ key: p.key, patientCode: same[0].patientCode, existed: true });
        continue;
      }
      const seq = await nextCounter(db, input.orgId, 'patient');
      const code = `${prefix}-${String(seq).padStart(4, '0')}`;
      const row = await db.one<{ id: string }>(
        `INSERT INTO patients (organization_id, patient_code, full_name, nickname, registered_on, created_by, updated_by)
         VALUES ($1, $2, $3, $4, (now() AT TIME ZONE $6)::date, $5, $5) RETURNING id`,
        [input.orgId, code, p.fullName.trim(), cut(p.nickname, 60), actor.userId, actor.timezone],
      );
      const services = [...new Set(p.programServiceIds ?? [])];
      if (services.length) {
        await db.exec(
          `INSERT INTO patient_intakes (organization_id, patient_id, program_service_ids, created_by, updated_by) VALUES ($1, $2, $3, $4, $4)`,
          [input.orgId, row.id, services, actor.userId],
        );
      }
      await auditEntry('pasien.dibuat', 'patient', row.id, { kode: code, data_awal: services.length > 0 });
      keyToId.set(p.key, row.id);
      result.patients.push({ key: p.key, patientCode: code, existed: false });
    }

    // ---- Sesi selesai + catatan terapis ----
    for (const s of input.sessions ?? []) {
      const patientId = s.patientId ?? (s.patientKey ? keyToId.get(s.patientKey) : undefined);
      if (!patientId) throw new Error(`Baris ${s.ref}: pasien tidak ditemukan`);
      const therapist = await db.maybe<{ userId: string }>(
        `SELECT user_id FROM memberships WHERE organization_id = $1 AND id = $2 AND is_therapist AND status = 'active'`,
        [input.orgId, s.therapistMemberId],
      );
      if (!therapist) throw new Error(`Baris ${s.ref}: terapis tidak valid`);
      const service = await db.maybe<{ defaultDurationMinutes: number }>(
        `SELECT default_duration_minutes FROM therapy_services WHERE organization_id = $1 AND id = $2`,
        [input.orgId, s.serviceId],
      );
      if (!service) throw new Error(`Baris ${s.ref}: layanan tidak valid`);
      // Idempoten: sesi yang sama (pasien, terapis, layanan, tanggal) tidak dimasukkan dua kali.
      const dup = await db.maybe(
        `SELECT 1 FROM appointments
          WHERE organization_id = $1 AND patient_id = $2 AND therapist_member_id = $3 AND service_id = $4 AND status = 'selesai'
            AND starts_at >= ($5::date)::timestamp AT TIME ZONE $6 AND starts_at < ($5::date + 1)::timestamp AT TIME ZONE $6`,
        [input.orgId, patientId, s.therapistMemberId, s.serviceId, s.date, actor.timezone],
      );
      if (dup) {
        result.sessions.push({ ref: s.ref, result: 'sudah ada', noteWritten: false, compensation: null });
        continue;
      }
      const startsAt = await toTimestamp(db, s.date, s.time, actor.timezone);
      const appt = await db.one<{ id: string }>(
        `INSERT INTO appointments (organization_id, patient_id, therapist_member_id, service_id, starts_at, duration_minutes, billing, price, admin_notes, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'tanpa_biaya', 0, 'Impor rekap absensi (sebelum memakai aplikasi)', $7, $7) RETURNING id`,
        [input.orgId, patientId, s.therapistMemberId, s.serviceId, startsAt, service.defaultDurationMinutes, actor.userId],
      );
      const therapistCtx = { ...ctx, userId: therapist.userId } as AuthContext;
      await linkTherapist(db, therapistCtx, patientId, s.therapistMemberId);
      const a = await lockAppointment(db, ctx, appt.id);
      await completeAppointment(db, therapistCtx, a);

      const note = {
        objectives: cut(s.objectives, 5000),
        activities: cut(s.activities, 5000),
        observations: cut(s.observations, 10000),
        homeProgram: cut(s.homeProgram, 5000),
      };
      const writesNote = Object.values(note).some(Boolean);
      if (writesNote) {
        // Kebijakan RLS: penulis catatan = anggota pada konteks transaksi.
        await db.exec(`SELECT set_config('app.member_id', $1, true), set_config('app.user_id', $2, true)`, [s.therapistMemberId, therapist.userId]);
        const n = await db.one<{ id: string }>(
          `INSERT INTO therapy_notes (organization_id, patient_id, appointment_id, author_member_id, note_type, status, objectives, activities, observations, home_program, finalized_at)
           VALUES ($1, $2, $3, $4, 'sesi', 'final', $5, $6, $7, $8, $9) RETURNING id`,
          [input.orgId, patientId, appt.id, s.therapistMemberId, note.objectives, note.activities, note.observations, note.homeProgram, startsAt],
        );
        await asActor();
        await auditEntry('catatan.dibuat', 'therapy_note', n.id, { jenis: 'sesi', status: 'final', pasien_id: patientId, penulis: s.therapistMemberId });
      }
      await auditEntry('sesi.diabsen', 'appointment', appt.id, { tagihan: 'tanpa_biaya', terapis: s.therapistMemberId, kompensasi_dihitung: a.compensated, catatan: writesNote });
      const comp = await db.maybe<{ amount: number }>(
        `SELECT amount FROM therapist_compensations WHERE organization_id = $1 AND appointment_id = $2 AND status <> 'dibatalkan'`,
        [input.orgId, appt.id],
      );
      result.sessions.push({ ref: s.ref, result: 'dimasukkan', noteWritten: writesNote, compensation: comp ? Number(comp.amount) : null });
    }

    // ---- Tunjangan menjadi per hari hadir ----
    const da = input.dailyAllowance;
    if (da) {
      const month = `${da.month}-01`;
      for (const memberId of da.memberIds) {
        const c = await db.maybe<{ id: string; basis: string; amount: number; startMonth: string; notes: string | null; paid: boolean }>(
          `SELECT c.id, c.basis, c.amount, c.start_month::text, c.notes,
                  EXISTS (SELECT 1 FROM compensation_component_payouts po WHERE po.organization_id = c.organization_id AND po.component_id = c.id) AS paid
             FROM compensation_components c
            WHERE c.organization_id = $1 AND c.member_id = $2 AND c.kind = 'tunjangan' AND lower(c.name) = lower($3)
              AND c.start_month <= $4::date AND (c.end_month IS NULL OR c.end_month >= $4::date)
            FOR UPDATE`,
          [input.orgId, memberId, da.name, month],
        );
        if (!c) {
          result.allowances.push({ memberId, result: 'tidak ditemukan' });
          continue;
        }
        if (c.basis === 'harian') {
          result.allowances.push({ memberId, result: 'sudah harian' });
          continue;
        }
        if (c.paid) throw new Error('Tunjangan yang sudah pernah dibayar tidak diubah lewat impor; atur dari Skema honor');
        // Sama dengan menyimpan skema untuk bulan mulai komponen: komponen lama dihapus atau diakhiri, lalu dibuat baru.
        if (c.startMonth < month) {
          await db.exec(`UPDATE compensation_components SET end_month = ($3::date - interval '1 month')::date WHERE organization_id = $1 AND id = $2`, [
            input.orgId,
            c.id,
            month,
          ]);
        } else {
          await db.exec(`DELETE FROM compensation_components WHERE organization_id = $1 AND id = $2`, [input.orgId, c.id]);
        }
        await db.exec(
          `INSERT INTO compensation_components (organization_id, member_id, kind, name, amount, start_month, notes, created_by, basis)
           VALUES ($1, $2, 'tunjangan', $3, $4, $5::date, $6, $7, 'harian')`,
          [input.orgId, memberId, da.name, c.amount, month, c.notes, actor.userId],
        );
        await auditEntry('kompensasi.skema_diatur', 'membership', memberId, { mulai: da.month, tunjangan_harian: da.name });
        result.allowances.push({ memberId, result: 'diubah' });
      }
    }
    if (!opts.commit) throw new DryRun(result);
    return result;
  };

  const scopes = dataScopes(permissionsForRole('owner'));
  try {
    return await withTx(
      pool,
      {
        settings: {
          'app.mode': 'tenant',
          'app.org_id': input.orgId,
          'app.member_id': input.actorMemberId,
          'app.scope_patient': scopes.patient,
          'app.scope_note': scopes.note,
          'app.scope_finance': scopes.finance,
          'app.scope_audit': scopes.audit,
          'app.scope_intake': scopes.intake,
        },
      },
      run,
    );
  } catch (err) {
    if (err instanceof DryRun) return err.result;
    throw err;
  }
}
