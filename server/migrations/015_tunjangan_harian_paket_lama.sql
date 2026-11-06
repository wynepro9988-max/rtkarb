-- Keputusan owner 6 Nov 2026:
-- 1) Tunjangan boleh dihitung per hari hadir (mis. tunjangan operasional), selain per bulan (mis. BPJS).
--    Satu hari hadir = satu tanggal (zona waktu organisasi) ketika terapis punya minimal satu sesi
--    berstatus selesai. Banyak sesi di tanggal yang sama tetap dihitung satu hari. Gaji pokok tetap bulanan.
-- 2) Paket lama (dibeli sebelum memakai aplikasi) dicatat dengan sisa sesi dan nominal yang sudah dibayar
--    di luar aplikasi. Nominal itu bukan pembayaran baru (tidak masuk pemasukan), hanya mengurangi piutang.
--    Harga boleh berbeda dari katalog (harga saat paket dulu dibeli).

ALTER TABLE compensation_components
  ADD COLUMN basis text NOT NULL DEFAULT 'bulanan' CHECK (basis IN ('bulanan', 'harian')),
  ADD CONSTRAINT compensation_components_basis_kind CHECK (kind = 'tunjangan' OR basis = 'bulanan');

-- Untuk tunjangan harian: jumlah hari hadir saat ditandai dibayar (nominal = tarif x hari, dibekukan).
ALTER TABLE compensation_component_payouts
  ADD COLUMN days integer CHECK (days BETWEEN 1 AND 31);

ALTER TABLE patient_packages
  ADD COLUMN carried_over boolean NOT NULL DEFAULT false,
  ADD COLUMN opening_paid bigint NOT NULL DEFAULT 0,
  ADD CONSTRAINT patient_packages_opening_paid CHECK (opening_paid >= 0 AND opening_paid <= price AND (carried_over OR opening_paid = 0));

-- 3) Pembayaran "umum" (tanpa tujuan) dapat ditautkan SEKALI ke paket, mis. pembayaran paket yang dicatat
--    sebelum paketnya dibuat. Nomor kuitansi, tanggal, dan nominal tidak berubah. Tautan yang sudah ada,
--    pembayaran untuk sesi/invoice, dan pembayaran yang dibatalkan tidak dapat diubah.
GRANT UPDATE (patient_package_id) ON payments TO rtka_app;

CREATE FUNCTION payments_link_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.patient_package_id IS DISTINCT FROM OLD.patient_package_id
     AND (OLD.patient_package_id IS NOT NULL OR OLD.appointment_id IS NOT NULL OR OLD.invoice_id IS NOT NULL OR OLD.status <> 'tercatat') THEN
    RAISE EXCEPTION 'Hanya pembayaran umum yang masih tercatat yang dapat ditautkan ke paket' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payments_link_guard BEFORE UPDATE OF patient_package_id ON payments
  FOR EACH ROW EXECUTE FUNCTION payments_link_guard();
