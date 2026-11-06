-- Permintaan owner 6 Nov 2026: pembayaran langsung untuk paket atau "sekali datang" dari formulir
-- Catat pembayaran, tanpa membuat paket lebih dulu. Sekali datang yang dibayar sebelum sesinya ada
-- dicatat sebagai kunjungan prabayar: paket 1 sesi untuk satu layanan dengan tarif layanan, yang
-- terpakai otomatis saat anak diabsen untuk layanan itu (pemilihan paket saat absen sudah ada).

ALTER TABLE patient_packages
  ADD COLUMN is_visit boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT patient_packages_visit CHECK (NOT is_visit OR (sessions_total = 1 AND service_id IS NOT NULL AND package_type_id IS NULL));
