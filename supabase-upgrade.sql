-- ============================================================
-- SnapCht V4 - Upgrade (Auth + Profil + Admin)
-- Jalankan SELEPAS supabase-setup.sql. Selamat dijalankan berulang kali.
-- ============================================================

CREATE TABLE IF NOT EXISTS profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    username TEXT NOT NULL CHECK (username ~ '^[a-z0-9_]{3,20}$'),
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
    banned BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_username ON profiles(lower(username));
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION is_admin() RETURNS BOOLEAN AS $$
    SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin');
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public;

CREATE OR REPLACE FUNCTION is_banned() RETURNS BOOLEAN AS $$
    SELECT COALESCE((SELECT banned FROM public.profiles WHERE id = auth.uid()), false);
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public;

-- Profil automatik bila pengguna baharu (daftar / tetamu)
CREATE OR REPLACE FUNCTION fn_handle_new_user() RETURNS TRIGGER AS $$
DECLARE uname TEXT; suffix TEXT;
BEGIN
    suffix := substr(replace(NEW.id::text, '-', ''), 1, 6);
    uname := lower(coalesce(NEW.raw_user_meta_data->>'username', ''));
    IF uname !~ '^[a-z0-9_]{3,20}$' THEN uname := 'user_' || suffix; END IF;
    IF EXISTS (SELECT 1 FROM public.profiles WHERE lower(username) = uname) THEN
        uname := left(uname, 13) || '_' || suffix;
    END IF;
    INSERT INTO public.profiles (id, username) VALUES (NEW.id, uname) ON CONFLICT DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION fn_handle_new_user();

-- Backfill pengguna sedia ada
INSERT INTO profiles (id, username)
SELECT id, 'user_' || substr(replace(id::text, '-', ''), 1, 6) FROM auth.users
ON CONFLICT DO NOTHING;

-- Lindungi role/banned/username daripada diubah oleh bukan admin
CREATE OR REPLACE FUNCTION fn_protect_profile() RETURNS TRIGGER AS $$
BEGIN
    IF current_user IN ('authenticated','anon') AND NOT is_admin() THEN
        NEW.role := OLD.role; NEW.banned := OLD.banned; NEW.username := OLD.username;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_protect_profile ON profiles;
CREATE TRIGGER trg_protect_profile BEFORE UPDATE ON profiles
    FOR EACH ROW EXECUTE FUNCTION fn_protect_profile();

-- Paksa username video/komen = username profil (elak menyamar)
CREATE OR REPLACE FUNCTION fn_force_username() RETURNS TRIGGER AS $$
BEGIN
    IF current_user IN ('authenticated','anon') THEN
        SELECT username INTO NEW.username FROM public.profiles WHERE id = auth.uid();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
DROP TRIGGER IF EXISTS trg_force_username_comments ON comments;
CREATE TRIGGER trg_force_username_comments BEFORE INSERT ON comments
    FOR EACH ROW EXECUTE FUNCTION fn_force_username();
DROP TRIGGER IF EXISTS trg_force_username_videos ON videos;
CREATE TRIGGER trg_force_username_videos BEFORE INSERT ON videos
    FOR EACH ROW EXECUTE FUNCTION fn_force_username();

-- RLS profiles
DROP POLICY IF EXISTS "profiles_read_all" ON profiles;
CREATE POLICY "profiles_read_all" ON profiles FOR SELECT USING (true);
DROP POLICY IF EXISTS "profiles_admin_update" ON profiles;
CREATE POLICY "profiles_admin_update" ON profiles FOR UPDATE USING (is_admin());

-- Pengguna disekat (banned) tidak boleh tulis
DROP POLICY IF EXISTS "videos_insert_own" ON videos;
CREATE POLICY "videos_insert_own" ON videos FOR INSERT
    WITH CHECK (auth.uid() = user_id AND NOT is_banned());
DROP POLICY IF EXISTS "comments_insert_auth" ON comments;
CREATE POLICY "comments_insert_auth" ON comments FOR INSERT
    WITH CHECK (auth.uid() = user_id AND NOT is_banned());
DROP POLICY IF EXISTS "messages_insert_auth" ON messages;
CREATE POLICY "messages_insert_auth" ON messages FOR INSERT
    WITH CHECK (auth.uid() = from_user AND NOT is_banned());

-- Kuasa admin
DROP POLICY IF EXISTS "videos_delete_own" ON videos;
CREATE POLICY "videos_delete_own" ON videos FOR DELETE USING (auth.uid() = user_id OR is_admin());
DROP POLICY IF EXISTS "comments_delete_own" ON comments;
CREATE POLICY "comments_delete_own" ON comments FOR DELETE USING (auth.uid() = user_id OR is_admin());
DROP POLICY IF EXISTS "reports_select_own" ON reports;
CREATE POLICY "reports_select_own" ON reports FOR SELECT USING (auth.uid() = user_id OR is_admin());
DROP POLICY IF EXISTS "reports_admin_delete" ON reports;
CREATE POLICY "reports_admin_delete" ON reports FOR DELETE USING (is_admin());
DROP POLICY IF EXISTS "videos_storage_delete" ON storage.objects;
CREATE POLICY "videos_storage_delete" ON storage.objects FOR DELETE
    USING (bucket_id = 'videos' AND (auth.uid()::text = (storage.foldername(name))[1] OR is_admin()));

-- ============================================================
-- JADIKAN ANDA ADMIN: daftar akaun biasa dahulu di app, kemudian
-- tukar EMAIL di bawah dan jalankan SATU baris ini:
--
-- UPDATE profiles SET role = 'admin'
-- WHERE id = (SELECT id FROM auth.users WHERE email = 'EMAIL_ANDA@contoh.com');
-- ============================================================
