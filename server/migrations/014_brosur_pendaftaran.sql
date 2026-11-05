-- Permintaan owner 5 Nov 2026: brosur paket layanan & harga tampil di halaman pendaftaran online.
-- Gambar diunggah owner per organisasi (bukan ditanam di kode), sehingga tiap organisasi
-- menampilkan brosurnya sendiri dan dapat menggantinya saat harga berubah.

ALTER TABLE organizations
  ADD COLUMN registration_flyer_key text,
  ADD COLUMN registration_flyer_mime text CHECK (registration_flyer_mime IN ('image/jpeg', 'image/png', 'image/webp')),
  ADD COLUMN registration_flyer_updated_at timestamptz,
  ADD CONSTRAINT organizations_registration_flyer_complete CHECK ((registration_flyer_key IS NULL) = (registration_flyer_mime IS NULL));
GRANT UPDATE (registration_flyer_key, registration_flyer_mime, registration_flyer_updated_at) ON organizations TO rtka_app;

-- Info halaman publik kini juga memberi tahu ada/tidaknya brosur (tanpa membuka kunci penyimpanan),
-- serta telepon & alamat klinik dari Pengaturan untuk orang tua yang ingin bertanya/mencari lokasi.
DROP FUNCTION public_registration_info(text);
CREATE FUNCTION public_registration_info(p_token text)
RETURNS TABLE (
  organization_name text, is_open boolean, today date, flyer_key text, flyer_mime text, flyer_version bigint,
  organization_phone text, organization_address text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT o.name, o.registration_open AND o.status = 'active', (now() AT TIME ZONE o.timezone)::date,
         o.registration_flyer_key, o.registration_flyer_mime, floor(extract(epoch FROM o.registration_flyer_updated_at))::bigint,
         o.phone, o.address
    FROM organizations o
   WHERE o.registration_token IS NOT NULL AND o.registration_token = p_token
$$;
REVOKE ALL ON FUNCTION public_registration_info(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_registration_info(text) TO rtka_app;
