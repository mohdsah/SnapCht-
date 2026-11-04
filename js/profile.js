// GANTIKAN dengan credential Supabase anda
const SB_URL = 'https://nsoxxhygaklqofrghzwr.supabase.co';
const SB_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5zb3h4aHlnYWtscW9mcmdoendyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM2Njc2NDMsImV4cCI6MjEwOTI0MzY0M30.Prs0kZ8tZdf04iUmKUlbiwkpdFTdfUTxyEnivqD8EaM'; // anon key (selamat di frontend dengan RLS)

const sb = window.supabase.createClient(SB_URL, SB_ANON_KEY);

const state = {
    currentUser: null,
    currentObserver: null,
    allVideos: [],
    currentFeedType: 'foryou',
    likedVideosSet: new Set(),
    savedVideosSet: new Set(),
    followingSet: new Set(),
    videoViewTracked: new Set(),
    pending: new Set(),          // guard klik berganda (like/save)
    loadSeq: 0,
    profile: null,
    profiles: {},
    renderSeq: 0,
    muted: true,                  // elak respons lama menimpa yang baru
    activeChatSubscription: null,
    activeChatUserId: null,
    searchTimeout: null,
    touchStart: 0,
    lastCommentTime: 0
};

const feedContainer = document.getElementById('videoFeed');
const COOLDOWN_COMMENT_MS = 5000;

function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/[&<>"']/g, m => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
}

function showToast(msg, isError = false) {
    document.querySelector('.toast-message')?.remove();
    const toast = document.createElement('div');
    toast.className = 'toast-message' + (isError ? ' error' : '');
    toast.innerText = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

function formatNumber(num) {
    const n = Number(num) || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(n);
}

function extractHashtags(text) {
    if (!text) return '';
    const hashtags = text.match(/#[\w\u0600-\u06FF]+/g);
    if (!hashtags || !hashtags.length) return '';
    return `<div class="hashtags">${hashtags.map(h =>
        `<span data-hashtag="${escapeHtml(h)}">${escapeHtml(h)}</span>`
    ).join(' ')}</div>`;
}

function hideLoading() {
    const el = document.getElementById('loadingScreen');
    if (el) el.style.display = 'none';
}

function isValidVideoUrl(url) {
    try {
        const u = new URL(url);
        return (u.protocol === 'https:' || u.protocol === 'http:') &&
               /\.(mp4|webm|ogg|mov)$/i.test(u.pathname);
    } catch { return false; }
}


function closeModal(modalId) {
    document.getElementById(modalId)?.remove();
}

window.searchHashtag = function (hashtag) {
    const searchInput = document.getElementById('globalSearchInput');
    if (searchInput) searchInput.value = hashtag;
    loadVideos('foryou', hashtag);
};
window.closeModal = closeModal;



function applyThemeUI() {
    const d = document.body.classList.contains('dark-mode');
    const b = document.getElementById('themeBtn'); if (b) b.innerText = d ? '☀️' : '🌙';
    const t = document.getElementById('drawerTheme');
    if (t) t.innerHTML = d ? '<span class="menu-icon">☀️</span> Mod Cerah' : '<span class="menu-icon">🌙</span> Mod Gelap';
}
function toggleTheme() {
    document.body.classList.toggle('dark-mode');
    try { localStorage.setItem('snapcht_theme', document.body.classList.contains('dark-mode') ? 'dark' : 'light'); } catch {}
    applyThemeUI();
}
(function () {
    try { if (localStorage.getItem('snapcht_theme') === 'dark') document.body.classList.add('dark-mode'); } catch {}
    applyThemeUI();
})();

async function removeVideoFile(url) {
    const m = String(url || '').match(/\/storage\/v1\/object\/public\/videos\/(.+)$/);
    if (m) await sb.storage.from('videos').remove([decodeURIComponent(m[1].split('?')[0])]);
}
function displayName(p, fb = 'pengguna') { return p?.display_name || p?.username || fb; }
function avatarHtml(p, cls = '') {
    const url = p?.avatar_url;
    if (url && /^https:\/\//.test(url)) return `<img class="avatar ${cls}" src="${escapeHtml(url)}" alt="" loading="lazy">`;
    return `<span class="avatar ${cls}">${escapeHtml(displayName(p, '?').charAt(0).toUpperCase())}</span>`;
}
function timeAgo(iso) {
    const s = Math.max(1, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 3600) return Math.floor(s / 60) + ' min';
    if (s < 86400) return Math.floor(s / 3600) + ' j';
    return Math.floor(s / 86400) + ' h';
}
async function cacheProfiles(ids) {
    const need = [...new Set(ids)].filter(id => id && !state.profiles[id]);
    if (!need.length) return;
    const { data } = await sb.from('profiles').select('id, username, display_name, avatar_url, bio, location, follower_count').in('id', need);
    (data || []).forEach(p => state.profiles[p.id] = p);
}

// ===== PAUTAN VIDEO LUAR (YouTube / TikTok / Facebook / Instagram) =====
// Hanya URL embed rasmi dibina oleh kod ini; URL pengguna tidak pernah dimasukkan terus ke iframe.
function parseEmbed(raw) {
    let u;
    try { u = new URL(String(raw || '').trim()); } catch { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    const host = u.hostname.toLowerCase().replace(/^(www\.|m\.|mobile\.)/, '');
    const path = u.pathname;
    let m;
    const yt = (id, vertical) => ({ platform: 'youtube', label: 'YouTube', ratio: vertical ? '9/16' : '16/9',
        src: `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&mute=1&playsinline=1&rel=0&loop=1&playlist=${id}` });
    if (host === 'youtu.be') { m = path.match(/^\/([\w-]{11})/); if (m) return yt(m[1], false); }
    if (host === 'youtube.com' || host === 'music.youtube.com') {
        const v = u.searchParams.get('v');
        if (path === '/watch' && /^[\w-]{11}$/.test(v || '')) return yt(v, false);
        m = path.match(/^\/(shorts|embed|live)\/([\w-]{11})/);
        if (m) return yt(m[2], m[1] === 'shorts');
    }
    if (host === 'tiktok.com') {
        m = path.match(/^\/@[\w.-]+\/video\/(\d{8,25})/);
        if (m) return { platform: 'tiktok', label: 'TikTok', ratio: '9/16', src: `https://www.tiktok.com/embed/v2/${m[1]}` };
    }
    if (host === 'facebook.com' || host === 'fb.watch') {
        const ok = host === 'fb.watch' || /\/(videos|reel|reels)\//.test(path) || path === '/watch' || /^\/share\/[vr]\//.test(path);
        if (ok) return { platform: 'facebook', label: 'Facebook', ratio: '16/9',
            src: `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(u.href)}&show_text=false&width=500` };
    }
    if (host === 'instagram.com') {
        m = path.match(/^\/(p|reel|reels|tv)\/([\w-]{5,20})/);
        if (m) return { platform: 'instagram', label: 'Instagram', ratio: '9/16',
            src: `https://www.instagram.com/${m[1] === 'reels' ? 'reel' : m[1]}/${m[2]}/embed` };
    }
    return null;
}
function thumbHtml(v) {
    const em = parseEmbed(v.video_url);
    if (em) return `<div class="pp-embed">▶ ${em.label}</div>`;
    return `<video src="${escapeHtml(v.video_url)}#t=0.5" muted playsinline preload="metadata"></video>`;
}

// ===== LENCANA PENGIKUT (ubah senarai ini untuk tukar tahap) =====
const BADGE_TIERS = [
    { min: 1000000, label: '1M',   icon: '👑', name: 'Mahkota',   color: '#f59e0b' },
    { min: 500000,  label: '500K', icon: '💐', name: 'Jambangan', color: '#ec4899' },
    { min: 100000,  label: '100K', icon: '🌹', name: 'Mawar',     color: '#e5484d' },
    { min: 50000,   label: '50K',  icon: '🌺', name: 'Raya',      color: '#f97316' },
    { min: 10000,   label: '10K',  icon: '🌸', name: 'Sakura',    color: '#f472b6' },
    { min: 5000,    label: '5K',   icon: '🌼', name: 'Kekwa',     color: '#eab308' },
    { min: 1000,    label: '1K',   icon: '🌱', name: 'Tunas',     color: '#22c55e' }
];
function badgeFor(n) { n = Number(n) || 0; return BADGE_TIERS.find(t => n >= t.min) || null; }
function badgeHtml(p) {
    const b = badgeFor(p?.follower_count);
    return b ? `<span class="fbadge" style="--bc:${b.color}" title="${b.name} · ${b.label}+ pengikut">${b.icon}</span>` : '';
}
function tierPill(n) {
    const b = badgeFor(n);
    return b ? `<div><span class="pp-tier" style="--bc:${b.color}">${b.icon} ${b.name} · ${b.label}+ pengikut</span></div>` : '';
}

// Tindakan yang memerlukan akaun sebenar; tetamu dihantar ke halaman log masuk
function requireAccount() {
    if (!state.currentUser || state.currentUser.is_anonymous) {
        showToast('🔐 Sila log masuk atau daftar dahulu', true);
        const here = location.pathname.split('/').pop() || 'index.html';
        setTimeout(() => location.href = 'login.html?next=' + encodeURIComponent(here + location.search), 900);
        return false;
    }
    if (state.profile?.banned) { showToast('⛔ Akaun anda disekat', true); return false; }
    return true;
}

function authErr(e) {
    const m = (e?.message || '').toLowerCase();
    if (m.includes('invalid login')) return 'Email atau kata laluan salah';
    if (m.includes('already') && m.includes('regist')) return 'Email sudah didaftarkan';
    if (m.includes('not confirmed')) return 'Sila sahkan email anda dahulu (semak inbox)';
    if (m.includes('rate limit') || m.includes('too many')) return 'Terlalu banyak percubaan, cuba sebentar lagi';
    if (m.includes('password')) return 'Kata laluan tidak sesuai (min 8 aksara)';
    return e?.message || 'Ralat tidak diketahui';
}

function authMsg(text, ok = false) {
    const el = document.getElementById('authMsg');
    if (el) { el.textContent = text; el.className = 'auth-msg' + (ok ? ' ok' : ''); }
}

async function loadProfile() {
    const u = state.currentUser;
    const { data } = await sb.from('profiles').select('username, role, banned, display_name, bio, location, avatar_url, follower_count').eq('id', u.id).maybeSingle();
    state.profile = data || { username: 'user_' + u.id.slice(0, 6), role: 'user', banned: false };
}

async function logout() {
    await sb.auth.signOut();
    location.reload();
}


async function loadSessionUser() {
    const { data: { session } } = await sb.auth.getSession();
    state.currentUser = session?.user || null;
    if (state.currentUser) await loadProfile();
    return state.currentUser;
}

async function loadFollowing() {
    if (!state.currentUser) return;
    const { data } = await sb.from('followers').select('following_id').eq('follower_id', state.currentUser.id);
    if (data) data.forEach(f => state.followingSet.add(f.following_id));
}

function syncFollowButtons(userId) {
    const label = state.followingSet.has(userId) ? 'Mengikuti' : 'Ikuti';
    document.querySelectorAll(`.follow-btn-small[data-user-id="${userId}"]`).forEach(b => b.innerText = label);
}

async function toggleFollow(userId, btnElement) {
    if (!requireAccount()) return;
    const key = 'follow:' + userId;
    if (state.pending.has(key)) return;
    state.pending.add(key);
    if (btnElement) btnElement.disabled = true;
    try {
        if (state.followingSet.has(userId)) {
            const { error } = await sb.from('followers').delete()
                .eq('follower_id', state.currentUser.id).eq('following_id', userId);
            if (error) { showToast('❌ Gagal', true); return; }
            state.followingSet.delete(userId);
            showToast('✅ Berhenti mengikuti');
        } else {
            const { error } = await sb.from('followers')
                .insert({ follower_id: state.currentUser.id, following_id: userId });
            if (error) { showToast('❌ Gagal', true); return; }
            state.followingSet.add(userId);
            showToast('👥 Mengikuti');
        }
        syncFollowButtons(userId);
    } finally {
        if (btnElement) btnElement.disabled = false;
        state.pending.delete(key);
    }
}

async function idsToVideos(rows) {
    const ids = (rows || []).map(r => r.video_id);
    if (!ids.length) return [];
    const { data } = await sb.from('videos').select('*').in('id', ids).order('created_at', { ascending: false });
    return data || [];
}

async function openProfilePage(userId) {
    if (!userId) return;
    const isMe = userId === state.currentUser?.id;
    if (isMe && !requireAccount()) return;
    await cacheProfiles([userId]);
    const p = isMe ? { ...state.profiles[userId], ...state.profile, id: userId } : state.profiles[userId];
    if (!p) return showToast('Profil tidak dijumpai', true);

    const page = document.getElementById('profileRoot');
    page.innerHTML = '<div class="empty-state">Memuatkan profil...</div>';

    const count = (col) => sb.from('followers').select('id', { count: 'exact', head: true }).eq(col, userId).then(r => r.count || 0);
    const [vids, followers, following] = await Promise.all([
        sb.from('videos').select('*').eq('user_id', userId).order('created_at', { ascending: false }),
        count('following_id'), count('follower_id')
    ]);
    const videos = vids.data || [];
    const likes = videos.reduce((s, v) => s + (v.likes || 0), 0);

    page.innerHTML = `
        <div class="pp-wrap">
            <button class="pp-back" id="ppBack">← Kembali</button>
            <div class="pp-head">
                ${avatarHtml(p, 'lg')}
                <h2>${escapeHtml(displayName(p))} ${badgeHtml({ follower_count: followers })}</h2>
                <p class="pp-user">@${escapeHtml(p.username)} ${p.role === 'admin' ? '🛡️' : ''}</p>
                ${tierPill(followers)}
                ${p.bio ? `<p class="pp-bio">${escapeHtml(p.bio)}</p>` : (isMe ? '<p class="pp-bio" style="color:var(--muted)">Belum ada bio. Tekan Edit Profil.</p>' : '')}
                ${p.location ? `<p class="pp-loc">📍 ${escapeHtml(p.location)}</p>` : ''}
                <div class="pp-stats">
                    <div><b>${videos.length}</b>Video</div>
                    <div><b>${formatNumber(followers)}</b>Pengikut</div>
                    <div><b>${formatNumber(following)}</b>Mengikuti</div>
                    <div><b>${formatNumber(likes)}</b>Suka</div>
                </div>
                <div class="pp-actions">
                    ${isMe ? '<button class="btn-primary" id="ppEdit">✏️ Edit Profil</button>'
                           : `<button class="btn-primary" id="ppFollow">${state.followingSet.has(userId) ? 'Mengikuti' : 'Ikuti'}</button>
                              <button class="btn-secondary" id="ppMsg">💬 Mesej</button>`}
                </div>
            </div>
            <div class="pp-tabs">
                <button class="active" data-pt="videos">🎞️ Video</button>
                ${isMe ? '<button data-pt="saved">🔖 Disimpan</button><button data-pt="liked">❤️ Disukai</button>' : ''}
            </div>
            <div class="pp-grid" id="ppGrid"></div>
        </div>`;
    const $ = id => document.getElementById(id);
    $('ppBack').onclick = () => (history.length > 1 ? history.back() : (location.href = 'index.html'));
    $('ppEdit')?.addEventListener('click', () => (location.href = 'edit-profile.html'));
    $('ppFollow')?.addEventListener('click', async () => { await toggleFollow(userId, $('ppFollow')); openProfilePage(userId); });
    $('ppMsg')?.addEventListener('click', async () => {
        if (!requireAccount()) return;
        location.href = 'chat.html?u=' + userId;
    });

    let current = videos;
    const renderGrid = (list, emptyMsg) => {
        current = list;
        $('ppGrid').innerHTML = list.length ? list.map(v => `
            <div class="pp-item" data-id="${v.id}">
                ${thumbHtml(v)}
                <span>▶ ${formatNumber(v.views || 0)}</span>
            </div>`).join('') : `<div class="empty-state" style="grid-column:1/-1">${emptyMsg}</div>`;
    };
    renderGrid(videos, isMe ? 'Anda belum ada video. Tekan + untuk muat naik!' : 'Belum ada video.');
    $('ppGrid').onclick = (e) => {
        const it = e.target.closest('.pp-item');
        if (it) location.href = 'index.html?video=' + it.getAttribute('data-id');
    };

    const loaders = {
        videos: async () => videos,
        saved: async () => idsToVideos((await sb.from('saved_videos').select('video_id').eq('user_id', userId)).data),
        liked: async () => idsToVideos((await sb.from('liked_videos').select('video_id').eq('user_id', userId)).data)
    };
    const emptyMsgs = { videos: 'Belum ada video.', saved: 'Tiada video disimpan.', liked: 'Belum ada video disukai.' };
    page.querySelectorAll('[data-pt]').forEach(b => b.onclick = async () => {
        page.querySelectorAll('[data-pt]').forEach(x => x.classList.toggle('active', x === b));
        $('ppGrid').innerHTML = '<div class="empty-state" style="grid-column:1/-1">Memuatkan...</div>';
        const t = b.getAttribute('data-pt');
        renderGrid(await loaders[t](), emptyMsgs[t]);
    });
}


(async () => {
    await loadSessionUser();
    if (state.currentUser) await loadFollowing();
    const id = new URLSearchParams(location.search).get('u') || state.currentUser?.id;
    if (!id || (!new URLSearchParams(location.search).get('u') && !requireAccount())) return;
    openProfilePage(id);
})();


document.getElementById('themeBtn')?.addEventListener('click', toggleTheme);
