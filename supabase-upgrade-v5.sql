-- ============================================================
-- SnapCht V5 - Profil lengkap + Avatar. Jalankan SELEPAS setup & upgrade.sql
-- ============================================================
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS display_name TEXT CHECK (char_length(display_name) <= 30);
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS bio TEXT CHECK (char_length(bio) <= 160);
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS location TEXT CHECK (char_length(location) <= 80);
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS avatar_url TEXT;
-- avatar hanya dibenarkan dari bucket 'avatars' projek ini (tukar URL jika guna projek lain)
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_avatar_chk;
ALTER TABLE profiles ADD CONSTRAINT profiles_avatar_chk CHECK (
    avatar_url IS NULL OR avatar_url LIKE 'https://nsoxxhygaklqofrghzwr.supabase.co/storage/v1/object/public/avatars/%');

-- Pengguna boleh kemas kini profil sendiri (role/banned/username dilindungi oleh trigger)
DROP POLICY IF EXISTS "profiles_update_own" ON profiles;
CREATE POLICY "profiles_update_own" ON profiles FOR UPDATE
    USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

-- Bucket avatar (maks 2MB, gambar sahaja)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('avatars', 'avatars', true, 2097152, ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT (id) DO UPDATE SET file_size_limit = EXCLUDED.file_size_limit,
                               allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "avatars_read" ON storage.objects;
CREATE POLICY "avatars_read" ON storage.objects FOR SELECT USING (bucket_id = 'avatars');
DROP POLICY IF EXISTS "avatars_insert" ON storage.objects;
CREATE POLICY "avatars_insert" ON storage.objects FOR INSERT
    WITH CHECK (bucket_id = 'avatars' AND auth.uid()::text = (storage.foldername(name))[1]);
DROP POLICY IF EXISTS "avatars_delete" ON storage.objects;
CREATE POLICY "avatars_delete" ON storage.objects FOR DELETE
    USING (bucket_id = 'avatars' AND (auth.uid()::text = (storage.foldername(name))[1] OR is_admin()));
