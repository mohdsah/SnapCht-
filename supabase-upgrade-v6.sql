-- ============================================================
-- SnapCht V6 - Admin kawalan penuh. Jalankan SELEPAS v5. Selamat dijalankan berulang kali.
-- ============================================================
ALTER TABLE videos ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS ban_reason TEXT CHECK (char_length(ban_reason) <= 200);

-- Trigger: pengguna biasa tak boleh ubah likes/views/hidden
CREATE OR REPLACE FUNCTION fn_protect_video_counters() RETURNS TRIGGER AS $$
BEGIN
    IF current_user IN ('authenticated','anon') THEN
        IF TG_OP = 'INSERT' THEN
            NEW.likes := 0; NEW.views := 0; NEW.hidden := false;
        ELSIF TG_OP = 'UPDATE' THEN
            NEW.likes := OLD.likes; NEW.views := OLD.views; NEW.user_id := OLD.user_id;
            NEW.username := OLD.username; NEW.created_at := OLD.created_at;
            IF NOT is_admin() THEN NEW.hidden := OLD.hidden; END IF;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Video disembunyikan: hanya pemilik dan admin nampak
DROP POLICY IF EXISTS "videos_read_all" ON videos;
CREATE POLICY "videos_read_all" ON videos FOR SELECT
    USING (NOT hidden OR auth.uid() = user_id OR is_admin());
DROP POLICY IF EXISTS "videos_update_own" ON videos;
CREATE POLICY "videos_update_own" ON videos FOR UPDATE
    USING (auth.uid() = user_id OR is_admin());

-- Pengumuman / tetapan laman
CREATE TABLE IF NOT EXISTS site_settings (
    key TEXT PRIMARY KEY, value TEXT, updated_at TIMESTAMPTZ DEFAULT now());
ALTER TABLE site_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "settings_read" ON site_settings;
CREATE POLICY "settings_read" ON site_settings FOR SELECT USING (true);
DROP POLICY IF EXISTS "settings_admin_write" ON site_settings;
CREATE POLICY "settings_admin_write" ON site_settings FOR ALL USING (is_admin()) WITH CHECK (is_admin());

-- Log tindakan admin
CREATE TABLE IF NOT EXISTS admin_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_id UUID DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
    action TEXT NOT NULL, target TEXT, detail TEXT,
    created_at TIMESTAMPTZ DEFAULT now());
ALTER TABLE admin_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "logs_admin_read" ON admin_logs;
CREATE POLICY "logs_admin_read" ON admin_logs FOR SELECT USING (is_admin());
DROP POLICY IF EXISTS "logs_admin_insert" ON admin_logs;
CREATE POLICY "logs_admin_insert" ON admin_logs FOR INSERT WITH CHECK (is_admin() AND admin_id = auth.uid());

-- Padam akaun pengguna (cascade: profil, video, komen, dll.)
CREATE OR REPLACE FUNCTION admin_delete_user(p_uid UUID) RETURNS VOID AS $$
BEGIN
    IF NOT is_admin() THEN RAISE EXCEPTION 'Bukan admin'; END IF;
    IF p_uid = auth.uid() THEN RAISE EXCEPTION 'Tidak boleh padam akaun sendiri'; END IF;
    IF EXISTS (SELECT 1 FROM public.profiles WHERE id = p_uid AND role = 'admin') THEN
        RAISE EXCEPTION 'Turunkan admin dahulu';
    END IF;
    DELETE FROM auth.users WHERE id = p_uid;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION admin_delete_user(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_delete_user(UUID) TO authenticated;
