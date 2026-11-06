-- Permintaan owner 6 Nov 2026: admin dapat diberi akses mengubah layanan & tarif sekali datang serta jenis
-- & harga paket. Ditetapkan owner per admin (seperti merangkap keuangan, migrasi 008), sehingga kebijakan
-- organisasi lain tidak ikut berubah. Pengaturan lain (profil organisasi, batas diskon, honor) tetap owner.
-- Hanya untuk admin yang sudah aktif (diatur dari Staf → Ubah), bukan dari undangan.

ALTER TABLE memberships
  ADD COLUMN manages_catalog boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT memberships_manages_catalog_admin CHECK (role = 'admin' OR NOT manages_catalog);

GRANT UPDATE (manages_catalog) ON memberships TO rtka_app;
