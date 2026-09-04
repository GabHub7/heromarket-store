-- Hero Market — Supabase Schema
-- Jalankan ini di: Supabase Dashboard → SQL Editor → New Query → Run

-- 1. Buat tabel
CREATE TABLE IF NOT EXISTS keyvalue_store (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Auto-update updated_at
CREATE OR REPLACE FUNCTION _set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_updated_at ON keyvalue_store;
CREATE TRIGGER trg_set_updated_at
  BEFORE UPDATE ON keyvalue_store
  FOR EACH ROW EXECUTE FUNCTION _set_updated_at();

-- 3. Seed semua collections agar tidak null
INSERT INTO keyvalue_store (key, value) VALUES
  ('products.json',     '[]'::jsonb),
  ('users.json',        '[]'::jsonb),
  ('transactions.json', '[]'::jsonb),
  ('testimonials.json', '[]'::jsonb),
  ('notifications.json','[]'::jsonb),
  ('keyspool.json',     '[]'::jsonb),
  ('vouchers.json',     '[]'::jsonb),
  ('settings.json',     '{}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- 4. Row Level Security — izinkan service role akses penuh
ALTER TABLE keyvalue_store ENABLE ROW LEVEL SECURITY;

-- Policy: izinkan semua operasi pakai anon/service key
-- (App kita pakai anon key dari server — aman karena request dari Vercel, bukan browser)
DROP POLICY IF EXISTS "allow_all" ON keyvalue_store;
CREATE POLICY "allow_all" ON keyvalue_store
  FOR ALL USING (true) WITH CHECK (true);

-- ============================================================
-- SUPABASE STORAGE — untuk upload gambar produk
-- ============================================================

-- 5. Buat bucket untuk gambar produk (public)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'product-images',
  'product-images',
  true,
  5242880, -- 5MB
  ARRAY['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']::text[]
)
ON CONFLICT (id) DO NOTHING;

-- 6. Policy: izinkan anon key upload & read gambar
DROP POLICY IF EXISTS "allow_public_select" ON storage.objects;
CREATE POLICY "allow_public_select" ON storage.objects
  FOR SELECT USING (bucket_id = 'product-images');

DROP POLICY IF EXISTS "allow_public_insert" ON storage.objects;
CREATE POLICY "allow_public_insert" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'product-images' AND auth.role() = 'anon');

-- Verifikasi
SELECT key, updated_at FROM keyvalue_store ORDER BY key;
