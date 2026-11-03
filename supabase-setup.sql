-- ============================================================
-- SnapCht V3.3 - Setup Lengkap
-- Jalankan SEKALI di Supabase SQL Editor
-- 0. Dashboard -> Authentication -> Providers -> Anonymous sign-ins -> Enable
-- ============================================================

CREATE TABLE IF NOT EXISTS videos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    username TEXT NOT NULL,
    title TEXT,
    description TEXT,
    video_url TEXT NOT NULL,
    likes INTEGER DEFAULT 0 CHECK (likes >= 0),
    views INTEGER DEFAULT 0 CHECK (views >= 0),
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS liked_videos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    video_id UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(user_id, video_id)
);
CREATE TABLE IF NOT EXISTS saved_videos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    video_id UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(user_id, video_id)
);
CREATE TABLE IF NOT EXISTS followers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    follower_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    following_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(follower_id, following_id),
    CHECK (follower_id <> following_id)
);
CREATE TABLE IF NOT EXISTS comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    video_id UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    username TEXT NOT NULL,
    comment_text TEXT NOT NULL CHECK (char_length(comment_text) <= 500),
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    from_user UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    to_user UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    message TEXT NOT NULL CHECK (char_length(message) <= 1000),
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    video_id UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(video_id, user_id)
);
CREATE TABLE IF NOT EXISTS video_views (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    video_id UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    view_date DATE DEFAULT CURRENT_DATE,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(video_id, user_id, view_date)
);

-- INDEXES
CREATE INDEX IF NOT EXISTS idx_videos_created ON videos(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_videos_views ON videos(views DESC);
CREATE INDEX IF NOT EXISTS idx_videos_user ON videos(user_id);
CREATE INDEX IF NOT EXISTS idx_liked_user ON liked_videos(user_id);
CREATE INDEX IF NOT EXISTS idx_saved_user ON saved_videos(user_id);
CREATE INDEX IF NOT EXISTS idx_followers_follower ON followers(follower_id);
CREATE INDEX IF NOT EXISTS idx_comments_video ON comments(video_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(from_user, to_user, created_at);
CREATE INDEX IF NOT EXISTS idx_views_video ON video_views(video_id);

-- TRIGGER: like count atomik
CREATE OR REPLACE FUNCTION fn_update_like_count()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE videos SET likes = likes + 1 WHERE id = NEW.video_id;
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        UPDATE videos SET likes = GREATEST(likes - 1, 0) WHERE id = OLD.video_id;
        RETURN OLD;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_like_insert ON liked_videos;
CREATE TRIGGER trg_like_insert AFTER INSERT ON liked_videos
    FOR EACH ROW EXECUTE FUNCTION fn_update_like_count();
DROP TRIGGER IF EXISTS trg_like_delete ON liked_videos;
CREATE TRIGGER trg_like_delete AFTER DELETE ON liked_videos
    FOR EACH ROW EXECUTE FUNCTION fn_update_like_count();

-- TRIGGER: lindungi likes/views daripada diubah terus oleh klien
-- (fungsi SECURITY DEFINER berjalan sebagai owner, jadi tidak terkesan)
CREATE OR REPLACE FUNCTION fn_protect_video_counters()
RETURNS TRIGGER AS $$
BEGIN
    IF current_user IN ('authenticated', 'anon') THEN
        IF TG_OP = 'INSERT' THEN
            NEW.likes := 0;
            NEW.views := 0;
        ELSIF TG_OP = 'UPDATE' THEN
            NEW.likes := OLD.likes;
            NEW.views := OLD.views;
            NEW.user_id := OLD.user_id;
            NEW.username := OLD.username;
            NEW.created_at := OLD.created_at;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_protect_video_counters ON videos;
CREATE TRIGGER trg_protect_video_counters BEFORE INSERT OR UPDATE ON videos
    FOR EACH ROW EXECUTE FUNCTION fn_protect_video_counters();

-- FUNGSI: track view (unik per user/video/hari)
CREATE OR REPLACE FUNCTION fn_track_view(p_video_id UUID, p_user_id UUID)
RETURNS INTEGER AS $$
DECLARE v_rows INTEGER := 0; new_count INTEGER;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF p_user_id <> auth.uid() THEN RAISE EXCEPTION 'Invalid user'; END IF;

    INSERT INTO video_views (video_id, user_id)
    VALUES (p_video_id, p_user_id)
    ON CONFLICT (video_id, user_id, view_date) DO NOTHING;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows > 0 THEN
        UPDATE videos SET views = views + 1 WHERE id = p_video_id
        RETURNING views INTO new_count;
    ELSE
        SELECT views INTO new_count FROM videos WHERE id = p_video_id;
    END IF;
    RETURN COALESCE(new_count, 0);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION fn_track_view(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_track_view(UUID, UUID) TO authenticated;

-- RLS
ALTER TABLE videos ENABLE ROW LEVEL SECURITY;
ALTER TABLE liked_videos ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_videos ENABLE ROW LEVEL SECURITY;
ALTER TABLE followers ENABLE ROW LEVEL SECURITY;
ALTER TABLE comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE video_views ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "videos_read_all" ON videos;
CREATE POLICY "videos_read_all" ON videos FOR SELECT USING (true);
DROP POLICY IF EXISTS "videos_insert_own" ON videos;
CREATE POLICY "videos_insert_own" ON videos FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "videos_update_own" ON videos;
CREATE POLICY "videos_update_own" ON videos FOR UPDATE USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "videos_delete_own" ON videos;
CREATE POLICY "videos_delete_own" ON videos FOR DELETE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "liked_select_own" ON liked_videos;
CREATE POLICY "liked_select_own" ON liked_videos FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "liked_insert_own" ON liked_videos;
CREATE POLICY "liked_insert_own" ON liked_videos FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "liked_delete_own" ON liked_videos;
CREATE POLICY "liked_delete_own" ON liked_videos FOR DELETE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "saved_select_own" ON saved_videos;
CREATE POLICY "saved_select_own" ON saved_videos FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "saved_insert_own" ON saved_videos;
CREATE POLICY "saved_insert_own" ON saved_videos FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "saved_delete_own" ON saved_videos;
CREATE POLICY "saved_delete_own" ON saved_videos FOR DELETE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "followers_read_all" ON followers;
CREATE POLICY "followers_read_all" ON followers FOR SELECT USING (true);
DROP POLICY IF EXISTS "followers_insert_own" ON followers;
CREATE POLICY "followers_insert_own" ON followers FOR INSERT WITH CHECK (auth.uid() = follower_id);
DROP POLICY IF EXISTS "followers_delete_own" ON followers;
CREATE POLICY "followers_delete_own" ON followers FOR DELETE USING (auth.uid() = follower_id);

DROP POLICY IF EXISTS "comments_read_all" ON comments;
CREATE POLICY "comments_read_all" ON comments FOR SELECT USING (true);
DROP POLICY IF EXISTS "comments_insert_auth" ON comments;
CREATE POLICY "comments_insert_auth" ON comments FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "comments_delete_own" ON comments;
CREATE POLICY "comments_delete_own" ON comments FOR DELETE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "messages_select_own" ON messages;
CREATE POLICY "messages_select_own" ON messages FOR SELECT
    USING (auth.uid() = from_user OR auth.uid() = to_user);
DROP POLICY IF EXISTS "messages_insert_auth" ON messages;
CREATE POLICY "messages_insert_auth" ON messages FOR INSERT WITH CHECK (auth.uid() = from_user);

DROP POLICY IF EXISTS "reports_select_own" ON reports;
CREATE POLICY "reports_select_own" ON reports FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "reports_insert_auth" ON reports;
CREATE POLICY "reports_insert_auth" ON reports FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "views_select_own" ON video_views;
CREATE POLICY "views_select_own" ON video_views FOR SELECT USING (auth.uid() = user_id);

-- REALTIME
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND tablename = 'messages'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE messages;
    END IF;
END $$;

-- STORAGE (had 50MB + jenis video sahaja; upload hanya ke folder sendiri)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('videos', 'videos', true, 52428800, ARRAY['video/mp4','video/webm','video/quicktime'])
ON CONFLICT (id) DO UPDATE
    SET file_size_limit = EXCLUDED.file_size_limit,
        allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "videos_storage_read" ON storage.objects;
CREATE POLICY "videos_storage_read" ON storage.objects
    FOR SELECT USING (bucket_id = 'videos');
DROP POLICY IF EXISTS "videos_storage_insert" ON storage.objects;
CREATE POLICY "videos_storage_insert" ON storage.objects
    FOR INSERT WITH CHECK (bucket_id = 'videos' AND auth.uid()::text = (storage.foldername(name))[1]);
DROP POLICY IF EXISTS "videos_storage_delete" ON storage.objects;
CREATE POLICY "videos_storage_delete" ON storage.objects
    FOR DELETE USING (bucket_id = 'videos' AND auth.uid()::text = (storage.foldername(name))[1]);
-- SELESAI
