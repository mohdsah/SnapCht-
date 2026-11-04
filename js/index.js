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

async function startApp(user) {
    state.currentUser = user;
    if (user) await loadProfile();
    if (state.profile?.banned) showToast('⛔ Akaun anda disekat', true);
    await Promise.all([
        loadFollowing(), loadLikedVideos(), loadSavedVideos(),
        loadVideos('foryou')
    ]);
    hideLoading();
    initEventListeners();
    initPullToRefresh();
    applyRoleUI();
    handleSharedVideo();
}

async function handleSharedVideo() {
    const sv = new URLSearchParams(location.search).get('video');
    if (!sv || !/^[0-9a-f-]{36}$/i.test(sv)) return;
    const { data } = await sb.from('videos').select('*').eq('id', sv).maybeSingle();
    if (data) {
        state.allVideos = [data, ...state.allVideos.filter(v => v.id !== data.id)];
        renderFeed();
    }
}

function applyRoleUI() {
    const u = state.currentUser, real = u && !u.is_anonymous, p = state.profile;
    const m = document.getElementById('adminMenuItem');
    if (m) m.style.display = p?.role === 'admin' ? 'flex' : 'none';
    const a = document.getElementById('accountBtn');
    if (a) a.innerHTML = real ? avatarHtml(p) : '🔑';
    const h = document.getElementById('drawerUser');
    if (h) h.innerHTML = real
        ? `${avatarHtml(p)}<div><b>${escapeHtml(displayName(p))}</b>${badgeHtml(p)}<br><small style="color:var(--muted)">@${escapeHtml(p?.username || '')}</small></div>`
        : '<div><b>Selamat datang 👋</b><br><small style="color:var(--muted)">Daftar untuk muat naik &amp; komen</small></div>';
    const d = document.getElementById('drawerAuth');
    if (d) d.innerHTML = real ? '<span class="menu-icon">🚪</span> Log Keluar' : '<span class="menu-icon">🔑</span> Log Masuk / Daftar';
}

async function initAuth() {
    try {
        const { data: { session } } = await sb.auth.getSession();
        await startApp(session ? session.user : null);
    } catch (err) {
        console.error('Init error:', err);
        showToast('❌ Ralat memuatkan app', true);
        hideLoading();
    }
}

function sanitizeSearch(s) {
    // buang aksara yang merosakkan sintaks .or() PostgREST dan wildcard ilike
    return String(s || '').replace(/[,()%*_\\"]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Cuba tapis video disembunyikan; jika lajur 'hidden' belum wujud (SQL v6 belum dijalankan), ulang tanpa tapisan
async function runFeedQuery(build) {
    let res = await build(true);
    if (res.error && /hidden/i.test(res.error.message || '')) res = await build(false);
    return res;
}

async function loadVideos(type, searchQuery = '') {
    if (type === 'following') return loadFollowingFeed();
    const seq = ++state.loadSeq;
    state.currentFeedType = type;
    updateActiveNavUI(type);

    const make = (hide) => {
        let query = sb.from('videos').select('*');
        if (hide) query = query.eq('hidden', false);
    const q = sanitizeSearch(searchQuery);

    if (q) {
        query = query.or(`description.ilike.%${q}%,title.ilike.%${q}%`)
            .order('created_at', { ascending: false }).limit(100);
    } else if (type === 'trending') {
        query = query.order('views', { ascending: false }).limit(50);
    } else {
        query = query.order('created_at', { ascending: false }).limit(100);
    }

        return query;
    };
    const { data, error } = await runFeedQuery(make);
    if (seq !== state.loadSeq) return; // ada permintaan lebih baharu
    if (error) {
        console.error('Load videos error:', error);
        showToast('❌ Gagal memuatkan video', true);
        return;
    }
    state.allVideos = data || [];
    renderFeed();
}

async function loadLikedVideos() {
    if (!state.currentUser) return;
    const { data } = await sb.from('liked_videos').select('video_id').eq('user_id', state.currentUser.id);
    if (data) data.forEach(i => state.likedVideosSet.add(i.video_id));
}

async function loadSavedVideos() {
    if (!state.currentUser) return;
    const { data } = await sb.from('saved_videos').select('video_id').eq('user_id', state.currentUser.id);
    if (data) data.forEach(i => state.savedVideosSet.add(i.video_id));
}

async function loadSavedVideosList() {
    if (!state.currentUser) return;
    const seq = ++state.loadSeq;
    state.currentFeedType = 'saved';
    updateActiveNavUI('saved');

    const { data } = await sb.from('saved_videos').select('video_id').eq('user_id', state.currentUser.id);
    const ids = data?.map(i => i.video_id) || [];
    if (seq !== state.loadSeq) return;
    if (!ids.length) { state.allVideos = []; renderFeed(); return; }
    const { data: videos } = await sb.from('videos').select('*').in('id', ids);
    if (seq !== state.loadSeq) return;
    state.allVideos = videos || [];
    renderFeed();
}

async function loadMyVideos() {
    if (!state.currentUser) return;
    const seq = ++state.loadSeq;
    state.currentFeedType = 'myvideos';
    updateActiveNavUI('myvideos');
    const { data } = await sb.from('videos').select('*')
        .eq('user_id', state.currentUser.id).order('created_at', { ascending: false });
    if (seq !== state.loadSeq) return;
    state.allVideos = data || [];
    renderFeed();
}

async function toggleLikeVideo(videoId, btnElement) {
    if (!requireAccount()) return;
    const key = 'like:' + videoId;
    if (state.pending.has(key)) return;
    state.pending.add(key);
    try {
        const isLiked = state.likedVideosSet.has(videoId);
        const iconCircle = btnElement.querySelector('.circle-icon');
        const countSpan = btnElement.querySelector('.like-count');
        const statSpan = btnElement.closest('.video-card')?.querySelector('.stat-like-count');

        if (isLiked) {
            const { error } = await sb.from('liked_videos').delete()
                .eq('user_id', state.currentUser.id).eq('video_id', videoId);
            if (error) { showToast('❌ Gagal', true); return; }
            state.likedVideosSet.delete(videoId);
            iconCircle?.classList.remove('liked');
            if (iconCircle) iconCircle.textContent = '🤍';
        } else {
            const { error } = await sb.from('liked_videos')
                .insert({ user_id: state.currentUser.id, video_id: videoId });
            if (error) { showToast('❌ Gagal', true); return; }
            state.likedVideosSet.add(videoId);
            iconCircle?.classList.add('liked');
            if (iconCircle) iconCircle.textContent = '❤️';
        }

        const { data: v } = await sb.from('videos').select('likes').eq('id', videoId).single();
        const newCount = v?.likes ?? 0;
        if (countSpan) countSpan.innerText = formatNumber(newCount);
        if (statSpan) statSpan.innerText = formatNumber(newCount);
    } finally {
        state.pending.delete(key);
    }
}

async function toggleSaveVideo(videoId, btnElement) {
    if (!requireAccount()) return;
    const key = 'save:' + videoId;
    if (state.pending.has(key)) return;
    state.pending.add(key);
    try {
        const isSaved = state.savedVideosSet.has(videoId);
        if (isSaved) {
            const { error } = await sb.from('saved_videos').delete()
                .eq('user_id', state.currentUser.id).eq('video_id', videoId);
            if (error) { showToast('❌ Gagal', true); return; }
            state.savedVideosSet.delete(videoId);
            btnElement.querySelector('.circle-icon')?.classList.remove('saved');
            showToast('📌 Dikeluarkan');
        } else {
            const { error } = await sb.from('saved_videos')
                .insert({ user_id: state.currentUser.id, video_id: videoId });
            if (error) { showToast('❌ Gagal', true); return; }
            state.savedVideosSet.add(videoId);
            btnElement.querySelector('.circle-icon')?.classList.add('saved');
            showToast('📌 Disimpan');
        }
    } finally {
        state.pending.delete(key);
    }
}

// Kira view bila video benar-benar dimainkan >= 3 saat (guna timeupdate, tiada timer yang boleh terlepas)
function trackVideoView(videoId, videoElement) {
    if (!state.currentUser || state.videoViewTracked.has(videoId)) return;
    const handler = async () => {
        if (videoElement.currentTime < 3 || state.videoViewTracked.has(videoId)) return;
        state.videoViewTracked.add(videoId);
        videoElement.removeEventListener('timeupdate', handler);
        const { data, error } = await sb.rpc('fn_track_view', {
            p_video_id: videoId, p_user_id: state.currentUser.id
        });
        if (error) {
            state.videoViewTracked.delete(videoId);
            console.error('View error:', error);
            return;
        }
        if (typeof data === 'number') {
            const viewSpan = videoElement.closest('.video-wrapper')?.querySelector('.view-count');
            if (viewSpan) viewSpan.innerText = '👁️ ' + formatNumber(data);
        }
    };
    videoElement.addEventListener('timeupdate', handler);
}

async function deleteVideo(videoId) {
    if (!confirm('Padam video ini? Tidak boleh dibatalkan.')) return;
    const v = state.allVideos.find(x => x.id === videoId);
    let q = sb.from('videos').delete().eq('id', videoId);
    if (state.profile?.role !== 'admin') q = q.eq('user_id', state.currentUser.id);
    const { error } = await q;
    if (error) { showToast('❌ Gagal memadam', true); return; }
    if (v) removeVideoFile(v.video_url).catch(() => {});
    state.allVideos = state.allVideos.filter(x => x.id !== videoId);
    showToast('🗑️ Video dipadam');
    renderFeed();
}

async function renderFeed() {
    const mySeq = ++state.renderSeq;
    if (state.currentObserver) state.currentObserver.disconnect();
    state.embedObserver?.disconnect();
    if (feedContainer) feedContainer.scrollTop = 0;

    if (!state.allVideos.length) {
        const msgs = { saved: '🔖 Belum ada video disimpan.', myvideos: '🎞️ Anda belum ada video. Tekan + untuk muat naik!',
            following: '👥 Ikuti kreator untuk lihat video mereka di sini.', user: '🎞️ Kreator ini belum ada video.' };
        feedContainer.innerHTML = `<div class="empty-state">${msgs[state.currentFeedType] || '🎞️ Tiada video lagi. Jadilah yang pertama!'}</div>`;
        return;
    }
    await cacheProfiles(state.allVideos.map(v => v.user_id));
    if (mySeq !== state.renderSeq) return;

    const me = state.currentUser?.id;
    const isAdmin = state.profile?.role === 'admin';
    feedContainer.innerHTML = state.allVideos.map(video => {
        const p = state.profiles[video.user_id] || { username: video.username };
        const isLiked = state.likedVideosSet.has(video.id);
        const isSaved = state.savedVideosSet.has(video.id);
        const isOwner = video.user_id === me;
        return `
        <article class="vcard video-wrapper" data-id="${video.id}" data-user-id="${video.user_id}">
            <header class="vhead">
                <div class="vuser" data-action="profile" data-user-id="${video.user_id}">
                    ${avatarHtml(p)}
                    <div><b>${escapeHtml(displayName(p, video.username))}</b>${badgeHtml(p)}
                    <small>@${escapeHtml(p.username)} · ${timeAgo(video.created_at)}</small></div>
                </div>
                ${!isOwner ? `<button class="follow-btn-small" data-user-id="${video.user_id}">${state.followingSet.has(video.user_id) ? 'Mengikuti' : 'Ikuti'}</button>` : ''}
            </header>
            ${mediaHtml(video)}
            <div class="act-bar">
                <div class="interact-btn like-btn" data-id="${video.id}">
                    <span class="circle-icon ${isLiked ? 'liked' : ''}">${isLiked ? '❤️' : '🤍'}</span><span class="like-count">${formatNumber(video.likes)}</span></div>
                <div class="interact-btn" data-action="comment" data-id="${video.id}"><span class="circle-icon">💬</span><span>Komen</span></div>
                <div class="interact-btn" data-action="share" data-id="${video.id}"><span class="circle-icon">↗️</span><span>Kongsi</span></div>
                <div class="interact-btn save-btn" data-id="${video.id}"><span class="circle-icon ${isSaved ? 'saved' : ''}">🔖</span><span>Simpan</span></div>
                <div class="interact-btn" data-action="more" data-id="${video.id}" data-can-delete="${isOwner || isAdmin}"><span class="circle-icon">⋯</span></div>
            </div>
            <div class="vbody">
                <p class="description">${escapeHtml(video.description || '')}</p>
                ${extractHashtags(video.description)}
                <div class="video-stats"><span class="view-count">👁️ ${formatNumber(video.views || 0)} tontonan</span></div>
            </div>
        </article>`;
    }).join('');
    initVideoPlayers();
}

async function loadFollowingFeed() {
    const seq = ++state.loadSeq;
    state.currentFeedType = 'following';
    updateActiveNavUI('following');
    const ids = [...state.followingSet];
    if (!ids.length) { state.allVideos = []; renderFeed(); return; }
    const { data } = await runFeedQuery((hide) => {
        const q = sb.from('videos').select('*').in('user_id', ids)
            .order('created_at', { ascending: false }).limit(100);
        return hide ? q.eq('hidden', false) : q;
    });
    if (seq !== state.loadSeq) return;
    state.allVideos = data || [];
    renderFeed();
}

function initVideoPlayers() {
    const videos = document.querySelectorAll('.main-video-player');
    videos.forEach(video => {
        video.muted = state.muted;
        const id = video.closest('.video-wrapper')?.getAttribute('data-id');
        const fill = video.closest('.vmedia')?.querySelector('.progress-fill');
        if (id) trackVideoView(id, video);
        video.ontimeupdate = () => {
            if (video.duration && fill) fill.style.width = (video.currentTime / video.duration) * 100 + '%';
        };
    });
    state.currentObserver = new IntersectionObserver((entries) => {
        entries.forEach(en => en.isIntersecting ? en.target.play().catch(() => {}) : en.target.pause());
    }, { root: feedContainer, threshold: 0.6 });
    videos.forEach(v => state.currentObserver.observe(v));
    initEmbeds();
}

async function loadUserVideos(userId) {
    if (!userId) return;
    const seq = ++state.loadSeq;
    state.currentFeedType = 'user';
    updateActiveNavUI('user');
    const { data } = await sb.from('videos').select('*')
        .eq('user_id', userId).order('created_at', { ascending: false });
    if (seq !== state.loadSeq) return;
    state.allVideos = data || [];
    renderFeed();
}

function mediaHtml(video) {
    const em = parseEmbed(video.video_url);
    if (em) return `
            <div class="vmedia embed" style="aspect-ratio:${em.ratio}">
                <iframe class="embed-frame" data-src="${escapeHtml(em.src)}" title="${em.label}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-popups allow-presentation allow-forms"></iframe>
                <a class="embed-badge" href="${escapeHtml(video.video_url)}" target="_blank" rel="noopener noreferrer">▶ ${em.label} ↗</a>
            </div>`;
    return `
            <div class="vmedia">
                <video class="main-video-player" src="${escapeHtml(video.video_url)}" loop muted playsinline preload="metadata"></video>
                <button class="mute-btn" data-action="mute">${state.muted ? '🔇' : '🔊'}</button>
                <div class="video-progress"><div class="progress-fill"></div></div>
            </div>`;
}

// Iframe dimuat hanya bila kelihatan dan dikosongkan bila keluar skrin (menghentikan bunyi)
async function trackEmbedView(videoId, frame) {
    if (state.videoViewTracked.has(videoId)) return;
    state.videoViewTracked.add(videoId);
    const { data, error } = await sb.rpc('fn_track_view', { p_video_id: videoId, p_user_id: state.currentUser.id });
    if (error) { state.videoViewTracked.delete(videoId); return; }
    const span = frame.closest('.video-wrapper')?.querySelector('.view-count');
    if (span && typeof data === 'number') span.innerText = '👁️ ' + formatNumber(data) + ' tontonan';
}
function initEmbeds() {
    const frames = document.querySelectorAll('.embed-frame');
    if (!frames.length) return;
    const timers = new Map();
    state.embedObserver = new IntersectionObserver((entries) => {
        entries.forEach(en => {
            const f = en.target, id = f.closest('.video-wrapper')?.getAttribute('data-id');
            if (en.isIntersecting) {
                if (f.getAttribute('src') !== f.dataset.src) f.setAttribute('src', f.dataset.src);
                if (id && state.currentUser && !state.videoViewTracked.has(id))
                    timers.set(f, setTimeout(() => trackEmbedView(id, f), 3000));
            } else {
                clearTimeout(timers.get(f));
                if (f.getAttribute('src') === f.dataset.src) f.setAttribute('src', 'about:blank');
            }
        });
    }, { root: feedContainer, threshold: 0.5 });
    frames.forEach(f => state.embedObserver.observe(f));
}

async function openCommentModal(videoId) {
    closeModal('commentModal');
    const { data } = await sb.from('comments').select('*')
        .eq('video_id', videoId).order('created_at', { ascending: false }).limit(100);

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'commentModal';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h3>💬 Komen</h3>
                <button class="close-modal" onclick="closeModal('commentModal')">✕</button>
            </div>
            <div class="comment-list">
                ${data?.length ? data.map(c => `
                    <div class="comment-item">
                        <div class="comment-user">@${escapeHtml(c.username)}</div>
                        <div>${escapeHtml(c.comment_text)}</div>
                    </div>`).join('') : '<div class="empty-state">Tiada komen. Jadilah yang pertama!</div>'}
            </div>
            <input type="text" id="newComment" placeholder="Tulis komen..." class="modal-input" maxlength="500">
            <button class="btn-primary" id="submitComment">Hantar Komen</button>
        </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) closeModal('commentModal'); });

    const btn = document.getElementById('submitComment');
    btn.onclick = async () => {
        if (!requireAccount()) return;
        const now = Date.now();
        if (now - state.lastCommentTime < COOLDOWN_COMMENT_MS) {
            showToast('⏳ Tunggu sebentar sebelum komen lagi', true);
            return;
        }
        const text = document.getElementById('newComment').value.trim();
        if (!text) return;

        btn.disabled = true;
        const username = state.profile?.username || 'user_' + state.currentUser.id.slice(0, 6);
        const { error } = await sb.from('comments').insert({
            video_id: videoId,
            user_id: state.currentUser.id,
            username,
            comment_text: text.substring(0, 500)
        });
        if (error) { btn.disabled = false; showToast('❌ Gagal hantar komen', true); return; }

        state.lastCommentTime = now;
        closeModal('commentModal');
        showToast('💬 Komen dihantar!');
    };
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

async function reportVideo(videoId, reason) {
    if (!requireAccount()) { closeModal('reportModal'); return; }
    const { error } = await sb.from('reports')
        .insert({ video_id: videoId, user_id: state.currentUser.id, reason });
    if (error) {
        if (error.code === '23505') showToast('ℹ️ Anda sudah melaporkan video ini');
        else showToast('❌ Gagal melapor', true);
    } else showToast('✅ Laporan dihantar');
    closeModal('reportModal');
}

function showReportModal(videoId) {
    closeModal('reportModal');
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'reportModal';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h3>🚩 Laporkan Video</h3>
                <button class="close-modal" onclick="closeModal('reportModal')">✕</button>
            </div>
            <div class="report-option" data-reason="Spam">🚫 Spam</div>
            <div class="report-option" data-reason="Kandungan Tidak Sesuai">🔞 Tidak Sesuai</div>
            <div class="report-option" data-reason="Keganasan">⚔️ Keganasan</div>
            <div class="report-option" data-reason="Penipuan">💰 Penipuan</div>
            <div class="report-option" data-reason="Hak Cipta">©️ Hak Cipta</div>
        </div>`;
    document.body.appendChild(modal);
    modal.querySelectorAll('.report-option').forEach(opt => {
        opt.addEventListener('click', () => reportVideo(videoId, opt.getAttribute('data-reason')));
    });
}

async function shareVideoLink(videoId) {
    const url = `${window.location.origin}?video=${videoId}`;
    if (navigator.share) { try { await navigator.share({ title: 'SnapCht', url }); return; } catch {} }
    try { await navigator.clipboard.writeText(url); showToast('🔗 Pautan disalin!'); }
    catch { showToast('🔗 ' + url); }
}

function initPullToRefresh() {
    const ptr = document.getElementById('pullToRefresh');
    feedContainer.addEventListener('touchstart', (e) => {
        state.touchStart = feedContainer.scrollTop === 0 ? e.touches[0].clientY : 0;
    }, { passive: true });
    feedContainer.addEventListener('touchmove', (e) => {
        if (feedContainer.scrollTop === 0 && state.touchStart && e.touches[0].clientY - state.touchStart > 80) ptr?.classList.add('active');
    }, { passive: true });
    feedContainer.addEventListener('touchend', () => {
        if (ptr?.classList.contains('active')) { ptr.classList.remove('active'); loadVideos(state.currentFeedType === 'user' ? 'foryou' : state.currentFeedType); }
        state.touchStart = 0;
    });
}

function updateActiveNavUI(type) {
    document.querySelectorAll('.top-tab').forEach(t => t.classList.toggle('active', t.getAttribute('data-tab') === type));
    document.querySelectorAll('.menu-item[data-nav]').forEach(i => {
        const nav = i.getAttribute('data-nav');
        i.classList.toggle('active', nav === type || (type === 'foryou' && nav === 'home'));
    });
    document.querySelectorAll('.nav-item-box[data-mnav]').forEach(n => {
        const nav = n.getAttribute('data-mnav');
        n.classList.toggle('active', nav === type || (type === 'foryou' && nav === 'home'));
    });
}

function closeDrawer() {
    document.getElementById('drawer')?.classList.remove('open');
    document.getElementById('drawerOverlay')?.classList.remove('open');
}

function navigate(nav) {
    closeDrawer();
    if (['myvideos', 'saved', 'chat', 'following', 'profile', 'create'].includes(nav) && !requireAccount()) return;
    switch (nav) {
        case 'myvideos': return loadMyVideos();
        case 'saved': return loadSavedVideosList();
        case 'chat': location.href = 'chat.html'; return;
        case 'following': return loadVideos('following');
        case 'trending': return loadVideos('trending');
        case 'create': location.href = 'upload.html'; return;
        case 'profile': location.href = 'profile.html'; return;
        case 'admin': location.href = 'admin.html'; return;
        case 'theme': return toggleTheme();
        case 'auth': return (state.currentUser && !state.currentUser.is_anonymous) ? logout() : (location.href = 'login.html');
        default: return loadVideos('foryou');
    }
}

function showMoreModal(videoId, canDelete) {
    closeModal('moreModal');
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'moreModal';
    modal.innerHTML = `<div class="modal-content" style="max-width:340px;">
        <div class="report-option" id="mmReport">🚩 Laporkan video</div>
        ${canDelete ? '<div class="report-option" id="mmDelete" style="color:var(--danger);">🗑️ Padam video</div>' : ''}
        <div class="report-option" id="mmCancel">Batal</div></div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) closeModal('moreModal'); });
    document.getElementById('mmCancel').onclick = () => closeModal('moreModal');
    document.getElementById('mmReport').onclick = () => { closeModal('moreModal'); if (requireAccount()) showReportModal(videoId); };
    document.getElementById('mmDelete')?.addEventListener('click', () => { closeModal('moreModal'); deleteVideo(videoId); });
}

function initEventListeners() {
    feedContainer.addEventListener('click', async (e) => {
        const tag = e.target.closest('[data-hashtag]');
        if (tag) return window.searchHashtag(tag.getAttribute('data-hashtag'));

        if (e.target.classList.contains('main-video-player')) {
            e.target.paused ? e.target.play().catch(() => {}) : e.target.pause();
            return;
        }
        const mute = e.target.closest('[data-action="mute"]');
        if (mute) {
            state.muted = !state.muted;
            document.querySelectorAll('.main-video-player').forEach(v => v.muted = state.muted);
            document.querySelectorAll('.mute-btn').forEach(b => b.textContent = state.muted ? '🔇' : '🔊');
            return;
        }
        const followBtn = e.target.closest('.follow-btn-small');
        if (followBtn) return toggleFollow(followBtn.getAttribute('data-user-id'), followBtn);
        const likeBtn = e.target.closest('.like-btn');
        if (likeBtn) return toggleLikeVideo(likeBtn.getAttribute('data-id'), likeBtn);
        const saveBtn = e.target.closest('.save-btn');
        if (saveBtn) return toggleSaveVideo(saveBtn.getAttribute('data-id'), saveBtn);
        const act = e.target.closest('[data-action]');
        if (!act) return;
        const id = act.getAttribute('data-id');
        switch (act.getAttribute('data-action')) {
            case 'comment': return openCommentModal(id);
            case 'share': return shareVideoLink(id);
            case 'more': return showMoreModal(id, act.getAttribute('data-can-delete') === 'true');
            case 'profile': location.href = 'profile.html?u=' + act.getAttribute('data-user-id'); return;
        }
    });

    // Double-tap / double-click hanya "suka"
    const likeFromVideo = (videoEl) => {
        const likeBtn = videoEl.closest('.video-wrapper')?.querySelector('.like-btn');
        const id = likeBtn?.getAttribute('data-id');
        if (id && !state.likedVideosSet.has(id)) toggleLikeVideo(id, likeBtn);
    };
    let lastTap = 0;
    feedContainer.addEventListener('touchend', (e) => {
        if (!e.target.classList.contains('main-video-player')) return;
        const now = Date.now();
        if (now - lastTap < 300) likeFromVideo(e.target);
        lastTap = now;
    });
    feedContainer.addEventListener('dblclick', (e) => {
        if (e.target.classList.contains('main-video-player')) likeFromVideo(e.target);
    });

    document.getElementById('menuBtn')?.addEventListener('click', () => {
        document.getElementById('drawer').classList.add('open');
        document.getElementById('drawerOverlay').classList.add('open');
    });
    document.getElementById('drawerOverlay')?.addEventListener('click', closeDrawer);
    document.getElementById('themeBtn')?.addEventListener('click', toggleTheme);
    document.getElementById('accountBtn')?.addEventListener('click', () => navigate('profile'));
    applyThemeUI();

    document.querySelectorAll('.top-tab').forEach(tab => tab.addEventListener('click', () => {
        const t = tab.getAttribute('data-tab');
        navigate(t === 'foryou' ? 'home' : t);
    }));
    document.querySelectorAll('.menu-item[data-nav]').forEach(i => i.addEventListener('click', () => navigate(i.getAttribute('data-nav'))));
    document.querySelectorAll('[data-mnav]').forEach(n => n.addEventListener('click', () => navigate(n.getAttribute('data-mnav'))));

    document.querySelector('.brand-logo')?.addEventListener('click', (e) => {
        e.preventDefault();
        const si = document.getElementById('globalSearchInput'); if (si) si.value = '';
        loadVideos('foryou');
    });
    document.getElementById('globalSearchInput')?.addEventListener('input', (e) => {
        clearTimeout(state.searchTimeout);
        state.searchTimeout = setTimeout(() => loadVideos('foryou', e.target.value), 500);
    });
}

initAuth();

(async function loadAnnouncement() {
    try {
        const { data } = await sb.from('site_settings').select('value').eq('key', 'announcement').maybeSingle();
        const msg = (data?.value || '').trim();
        if (!msg) return;
        try { if (sessionStorage.getItem('ann_dismissed') === msg) return; } catch {}
        const el = document.createElement('div');
        el.className = 'announce';
        el.innerHTML = `<span>📢 ${escapeHtml(msg)}</span><button aria-label="Tutup">✕</button>`;
        el.querySelector('button').onclick = () => { try { sessionStorage.setItem('ann_dismissed', msg); } catch {} el.remove(); };
        document.body.appendChild(el);
    } catch {}
})();
