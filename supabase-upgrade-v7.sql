-- ============================================================
-- SnapCht V7 - Segerakkan username (profil -> video & komen). Jalankan SELEPAS v6.
-- Selamat dijalankan berulang kali.
-- ============================================================
CREATE OR REPLACE FUNCTION fn_sync_username() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.username IS DISTINCT FROM OLD.username THEN
        UPDATE public.videos   SET username = NEW.username WHERE user_id = NEW.id;
        UPDATE public.comments SET username = NEW.username WHERE user_id = NEW.id;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_sync_username ON profiles;
CREATE TRIGGER trg_sync_username AFTER UPDATE OF username ON profiles
    FOR EACH ROW EXECUTE FUNCTION fn_sync_username();

-- Betulkan data lama yang sudah tidak sepadan
UPDATE videos v   SET username = p.username FROM profiles p WHERE p.id = v.user_id AND v.username <> p.username;
UPDATE comments c SET username = p.username FROM profiles p WHERE p.id = c.user_id AND c.username <> p.username;
