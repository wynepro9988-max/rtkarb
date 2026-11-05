-- Keputusan 2026-11-05: skema honor seorang terapis diatur sekaligus dari satu formulir.
-- Menyimpan skema mengakhiri komponen/aturan lama di akhir bulan sebelumnya dan memulai yang
-- baru. Komponen atau aturan yang baru dibuat untuk bulan itu (belum dibayar / belum dipakai
-- menghitung honor) boleh dihapus agar koreksi di bulan yang sama tidak menumpuk baris.
-- Yang sudah dibayar atau sudah dipakai tetap terlindungi oleh foreign key dari tabel pembayaran.

CREATE POLICY compensation_components_delete ON compensation_components FOR DELETE
  USING (organization_id = app_org_id() AND app_scope('finance') = 'all');
CREATE POLICY compensation_rules_delete ON compensation_rules FOR DELETE
  USING (organization_id = app_org_id() AND app_scope('finance') = 'all');

GRANT DELETE ON compensation_components, compensation_rules TO rtka_app;
