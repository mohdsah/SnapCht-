-- =====================================================
-- SNAPCHT V3.1 - DATABASE SCHEMA + RLS
-- Jalankan ini di Supabase SQL Editor
-- =====================================================

-- ==================== 1. JADUAL UTAMA ====================

CREATE TABLE IF NOT EXISTS videos (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    title TEXT,
    description TEXT,
    video_url TEXT NOT NULL,
    likes INTEGER DEFAULT 0,
    views BIGINT DEFAULT 0,
    comments_count INTEGER DEFAULT 0,
    user_id UUID,
    username TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS liked_videos (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL,
    video_id UUID NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, video_id)
);

CREATE TABLE IF NOT EXISTS saved_videos (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL,
    video_id UUID NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, video_id)
);

CREATE TABLE IF NOT EXISTS followers (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    follower_id UUID NOT NULL,
    following_id UUID NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(follower_id, following_id)
);

CREATE TABLE IF NOT EXISTS comments (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    video_id UUID NOT NULL,
    user_id UUID,
    username TEXT NOT NULL,
    comment_text TEXT NOT NULL,
    likes INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    from_user UUID NOT NULL,
    to_user UUID NOT NULL,
    message TEXT NOT NULL,
    read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reports (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    video_id UUID NOT NULL,
    user_id UUID NOT NULL,
    reason TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Notifikasi (baru dalam v3.1)
CREATE TABLE IF NOT EXISTS notifications (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL,
    from_user_id UUID,
    from_username TEXT,
    type TEXT NOT NULL,
    video_id UUID,
    message TEXT NOT NULL,
    read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Profil pengguna (baru dalam v3.1)
CREATE TABLE IF NOT EXISTS profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    username TEXT,
    bio TEXT DEFAULT '',
    avatar_emoji TEXT DEFAULT '👤',
    followers_count INTEGER DEFAULT 0,
    following_count INTEGER DEFAULT 0,
    videos_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ==================== 2. ROW LEVEL SECURITY ====================

ALTER TABLE videos       ENABLE ROW LEVEL SECURITY;
ALTER TABLE liked_videos ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_videos ENABLE ROW LEVEL SECURITY;
ALTER TABLE followers    ENABLE ROW LEVEL SECURITY;
ALTER TABLE comments     ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages     ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports      ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles     ENABLE ROW LEVEL SECURITY;

-- Videos: semua boleh baca, hanya owner boleh edit/padam
CREATE POLICY "videos_select_all"  ON videos FOR SELECT USING (true);
CREATE POLICY "videos_insert_auth" ON videos FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "videos_update_auth" ON videos FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "videos_delete_auth" ON videos FOR DELETE USING (auth.uid() = user_id);

-- Like/Save/Follow: hanya user sendiri
CREATE POLICY "liked_videos_all"  ON liked_videos  FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "saved_videos_all"  ON saved_videos  FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "followers_select"  ON followers     FOR SELECT USING (true);
CREATE POLICY "followers_insert"  ON followers     FOR INSERT WITH CHECK (auth.uid() = follower_id);
CREATE POLICY "followers_delete"  ON followers     FOR DELETE USING (auth.uid() = follower_id);

-- Comments: semua boleh baca, hanya auth boleh tulis
CREATE POLICY "comments_select"  ON comments FOR SELECT USING (true);
CREATE POLICY "comments_insert"  ON comments FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "comments_delete"  ON comments FOR DELETE USING (auth.uid() = user_id);

-- Messages: hanya pengirim atau penerima
CREATE POLICY "messages_select"  ON messages FOR SELECT
    USING (auth.uid() = from_user OR auth.uid() = to_user);
CREATE POLICY "messages_insert"  ON messages FOR INSERT WITH CHECK (auth.uid() = from_user);
CREATE POLICY "messages_update"  ON messages FOR UPDATE USING (auth.uid() = to_user);

-- Reports: hanya boleh insert
CREATE POLICY "reports_insert" ON reports FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Notifications: hanya boleh baca notif sendiri
CREATE POLICY "notif_select" ON notifications FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "notif_insert" ON notifications FOR INSERT WITH CHECK (true);
CREATE POLICY "notif_update" ON notifications FOR UPDATE USING (auth.uid() = user_id);

-- Profiles: semua boleh baca, hanya owner boleh edit
CREATE POLICY "profiles_select" ON profiles FOR SELECT USING (true);
CREATE POLICY "profiles_insert" ON profiles FOR INSERT WITH CHECK (auth.uid() = id);
CREATE POLICY "profiles_update" ON profiles FOR UPDATE USING (auth.uid() = id);

-- ==================== 3. INDEX ====================

CREATE INDEX IF NOT EXISTS idx_videos_user_id    ON videos(user_id);
CREATE INDEX IF NOT EXISTS idx_videos_created_at ON videos(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_videos_likes      ON videos(likes DESC);
CREATE INDEX IF NOT EXISTS idx_videos_views      ON videos(views DESC);
CREATE INDEX IF NOT EXISTS idx_liked_user_id     ON liked_videos(user_id);
CREATE INDEX IF NOT EXISTS idx_saved_user_id     ON saved_videos(user_id);
CREATE INDEX IF NOT EXISTS idx_followers_ids     ON followers(follower_id, following_id);
CREATE INDEX IF NOT EXISTS idx_comments_video    ON comments(video_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_users    ON messages(from_user, to_user, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notif_user        ON notifications(user_id, created_at DESC);

-- ==================== 4. TRIGGER: Auto-update comments_count ====================

CREATE OR REPLACE FUNCTION update_comments_count()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE videos SET comments_count = comments_count + 1 WHERE id = NEW.video_id;
    ELSIF TG_OP = 'DELETE' THEN
        UPDATE videos SET comments_count = GREATEST(comments_count - 1, 0) WHERE id = OLD.video_id;
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_comments_count ON comments;
CREATE TRIGGER trg_comments_count
AFTER INSERT OR DELETE ON comments
FOR EACH ROW EXECUTE FUNCTION update_comments_count();

-- ==================== 5. FUNGSI STATISTIK ====================

CREATE OR REPLACE FUNCTION get_user_stats(user_id_param UUID)
RETURNS TABLE(
    total_videos    BIGINT,
    total_likes     BIGINT,
    total_followers BIGINT,
    total_following BIGINT
) LANGUAGE SQL AS $$
    SELECT
        (SELECT COUNT(*)        FROM videos    WHERE videos.user_id  = user_id_param),
        (SELECT COALESCE(SUM(likes),0) FROM videos WHERE videos.user_id  = user_id_param),
        (SELECT COUNT(*)        FROM followers WHERE following_id     = user_id_param),
        (SELECT COUNT(*)        FROM followers WHERE follower_id      = user_id_param);
$$;

-- ==================== 6. DATA CONTOH ====================

DO $$
DECLARE video_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO video_count FROM videos;
    IF video_count = 0 THEN
        INSERT INTO videos (title, description, video_url, likes, views, username) VALUES
            ('SnapCht Beta', 'UI SnapCht beta dah live! #SnapCht #fyp', 'https://assets.mixkit.co/videos/preview/mixkit-girl-in-neon-sign-light-looking-at-phone-42023-large.mp4', 12600, 50000, 'creator_official'),
            ('Alam Semulajadi', 'Keindahan alam #nature #peaceful', 'https://assets.mixkit.co/videos/preview/mixkit-tree-with-yellow-flowers-falling-down-48744-large.mp4', 9500, 32000, 'nature_lover'),
            ('Coding Sprint', 'Coding untuk SnapCht 3.0 #devlife', 'https://assets.mixkit.co/videos/preview/mixkit-man-working-on-laptop-at-the-office-39846-large.mp4', 5200, 18000, 'dev_farhan'),
            ('Sunset Vibes', 'Keindahan senja #travel #sunset', 'https://assets.mixkit.co/videos/preview/mixkit-beautiful-sunset-over-the-ocean-47186-large.mp4', 18700, 75000, 'traveler_mia'),
            ('Music Session', 'New music alert! #music', 'https://assets.mixkit.co/videos/preview/mixkit-young-woman-playing-guitar-on-a-balcony-47416-large.mp4', 34200, 120000, 'music_daily');
    END IF;
END $$;

-- ==================== SELESAI ====================
