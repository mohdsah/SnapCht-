-- ============================================================
-- SnapCht V8 - Kiraan pengikut (lencana) + perlindungan profil + semak URL video
-- Jalankan SELEPAS v7. Selamat dijalankan berulang kali. Tidak memadam data.
-- ============================================================
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS follower_count INTEGER NOT NULL DEFAULT 0 CHECK (follower_count >= 0);

-- Kiraan pengikut dikemas kini automatik oleh pangkalan data (tidak boleh diubah oleh klien)
CREATE OR REPLACE FUNCTION fn_update_follower_count() RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE public.profiles SET follower_count = follower_count + 1 WHERE id = NEW.following_id;
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        UPDATE public.profiles SET follower_count = GREATEST(follower_count - 1, 0) WHERE id = OLD.following_id;
        RETURN OLD;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_follow_insert ON followers;
CREATE TRIGGER trg_follow_insert AFTER INSERT ON followers FOR EACH ROW EXECUTE FUNCTION fn_update_follower_count();
DROP TRIGGER IF EXISTS trg_follow_delete ON followers;
CREATE TRIGGER trg_follow_delete AFTER DELETE ON followers FOR EACH ROW EXECUTE FUNCTION fn_update_follower_count();

-- Isi kiraan sedia ada
UPDATE profiles p SET follower_count = (SELECT count(*) FROM followers f WHERE f.following_id = p.id);

-- Lindungi follower_count; ban_reason kini turut dilindungi daripada pengguna biasa
CREATE OR REPLACE FUNCTION fn_protect_profile() RETURNS TRIGGER AS $$
BEGIN
    IF current_user IN ('authenticated','anon') THEN
        NEW.follower_count := OLD.follower_count;
        IF NOT is_admin() THEN
            NEW.role := OLD.role; NEW.banned := OLD.banned;
            NEW.ban_reason := OLD.ban_reason; NEW.username := OLD.username;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Pautan video mesti http(s) (rekod lama tidak disemak semula)
ALTER TABLE videos DROP CONSTRAINT IF EXISTS videos_url_chk;
ALTER TABLE videos ADD CONSTRAINT videos_url_chk CHECK (video_url ~* '^https?://') NOT VALID;
