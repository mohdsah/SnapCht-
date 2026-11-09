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

// ===== LIVE (tonton sahaja) - SDK Agora Web dimuat dalam <head> =====
const AGORA_FN = SB_URL + '/functions/v1/agora-token';
let rtc = null, cur = null;
const timers = {};
const $ = (id) => document.getElementById(id);

async function fnToken(liveId, uid) {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) throw new Error('Sesi tamat. Sila log masuk semula.');
    const r = await fetch(AGORA_FN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.access_token, 'apikey': SB_ANON_KEY },
        body: JSON.stringify({ resource_type: 'live', resource_id: liveId, uid })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ('Ralat ' + r.status));
    return j;
}

async function loadList() {
    $('lvList').innerHTML = '<div class="empty-state">Memuatkan...</div>';
    const { data, error } = await sb.from('live_sessions_active')
        .select('id, title, host_username, host_user_id, channel_name, created_at')
        .order('created_at', { ascending: false }).limit(50);
    if (error) { $('lvList').innerHTML = '<div class="empty-state">Gagal memuatkan senarai. Pastikan SQL LIVE sudah dijalankan.</div>'; return; }
    $('lvList').innerHTML = data.length ? data.map(l => `
        <div class="lv-card">
            <div class="lv-dot">▶</div>
            <div class="lv-info"><b>${escapeHtml(l.title)}</b><small>@${escapeHtml(l.host_username)} · ${timeAgo(l.created_at)}</small></div>
            <button class="btn-primary lv-watch" data-id="${l.id}" data-ch="${escapeHtml(l.channel_name)}" data-title="${escapeHtml(l.title)}" style="width:auto;padding:10px 18px;">Tonton</button>
        </div>`).join('') : '<div class="empty-state">Belum ada siaran LIVE sekarang.<br><small>Siaran dimulakan dari app Android SnapCht.</small></div>';
}

function stopWatching(msg) {
    Object.values(timers).forEach(clearInterval);
    for (const k in timers) delete timers[k];
    if (cur) { sb.rpc('fn_live_leave', { p_live_id: cur.id }).then(() => {}, () => {}); }
    if (rtc) { rtc.leave().catch(() => {}); rtc = null; }
    cur = null;
    $('stage').innerHTML = '<div class="lv-wait">Menyambung...</div>';
    $('lvViewer').style.display = 'none';
    $('lvList').style.display = 'block'; $('lvHead').style.display = 'flex';
    if (msg) showToast(msg);
    loadList();
}

async function refreshStats() {
    if (!cur) return;
    const { data } = await sb.rpc('fn_live_stats', { p_live_id: cur.id });
    const r = Array.isArray(data) ? data[0] : data;
    if (!r) return;
    $('lvStats').textContent = '👁 ' + r.viewer_count + ' · ❤️ ' + r.like_count;
    $('lvLike').textContent = (r.liked_by_me ? '❤️ ' : '🤍 ') + 'Like';
}

async function refreshChat() {
    if (!cur) return;
    const { data } = await sb.from('live_chat_messages').select('id, username, message').eq('live_id', cur.id)
        .order('created_at', { ascending: false }).limit(60);
    const box = $('lvChat');
    const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
    box.innerHTML = (data || []).slice().reverse().map(m => `<div><b>${escapeHtml(m.username)}</b> ${escapeHtml(m.message)}</div>`).join('')
        || '<div class="empty-state" style="padding:16px">Belum ada komen.</div>';
    if (atBottom) box.scrollTop = box.scrollHeight;
}

async function watch(live) {
    $('lvErr').textContent = '';
    cur = live;
    $('lvList').style.display = 'none'; $('lvHead').style.display = 'none'; $('lvViewer').style.display = 'block';
    $('lvTitle').textContent = live.title;
    try {
        if (typeof AgoraRTC === 'undefined') throw new Error('Pemain LIVE tidak dapat dimuatkan. Semak sambungan internet.');
        const uid = Math.floor(Math.random() * 2147483646) + 1;
        const info = await fnToken(live.id, uid);
        rtc = AgoraRTC.createClient({ mode: 'live', codec: 'vp8' });
        await rtc.setClientRole('audience');
        rtc.on('user-published', async (user, type) => {
            await rtc.subscribe(user, type);
            if (type === 'video') { $('stage').innerHTML = ''; user.videoTrack.play('stage'); }
            if (type === 'audio') user.audioTrack.play();
        });
        rtc.on('user-unpublished', (user, type) => { if (type === 'video') $('stage').innerHTML = '<div class="lv-wait">Hos menjeda video...</div>'; });
        rtc.on('token-privilege-will-expire', async () => {
            try { const n = await fnToken(live.id, uid); await rtc.renewToken(n.token); } catch (e) { $('lvErr').textContent = 'Token gagal diperbaharui'; }
        });
        await rtc.join(info.app_id, live.channel_name, info.token, uid);
        sb.rpc('fn_live_heartbeat', { p_live_id: live.id }).then(() => {}, () => {});
        refreshStats(); refreshChat();
        timers.beat = setInterval(() => sb.rpc('fn_live_heartbeat', { p_live_id: live.id }).then(() => {}, () => {}), 15000);
        timers.stats = setInterval(refreshStats, 5000);
        timers.chat = setInterval(refreshChat, 3500);
        timers.end = setInterval(async () => {
            const { data } = await sb.from('live_sessions').select('status').eq('id', live.id).maybeSingle();
            if (!data || data.status !== 'live') stopWatching('Siaran telah tamat.');
        }, 10000);
    } catch (e) {
        $('lvErr').textContent = '❌ ' + (e.message || 'Gagal menyertai siaran');
        $('stage').innerHTML = '<div class="lv-wait">Tidak dapat menyambung.</div>';
        if (rtc) { rtc.leave().catch(() => {}); rtc = null; }
    }
}

(async () => {
    await loadSessionUser();
    if (!requireAccount()) return;
    $('lvRefresh').onclick = loadList;
    $('lvBack').onclick = () => stopWatching();
    $('lvList').addEventListener('click', (e) => {
        const b = e.target.closest('.lv-watch'); if (!b) return;
        watch({ id: b.dataset.id, channel_name: b.dataset.ch, title: b.dataset.title });
    });
    $('lvLike').onclick = async () => {
        if (!cur) return;
        const { error } = await sb.rpc('fn_toggle_live_like', { p_live_id: cur.id });
        if (error) showToast('❌ ' + error.message, true); else refreshStats();
    };
    $('lvChatForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const text = $('lvMsg').value.trim();
        if (!text || !cur) return;
        const { error } = await sb.from('live_chat_messages').insert({
            live_id: cur.id, user_id: state.currentUser.id, username: state.profile?.username || 'pengguna', message: text.slice(0, 300) });
        if (error) return showToast('❌ ' + error.message, true);
        $('lvMsg').value = ''; refreshChat();
    });
    window.addEventListener('pagehide', () => { if (cur) { sb.rpc('fn_live_leave', { p_live_id: cur.id }); } });
    loadList();
})();


document.getElementById('themeBtn')?.addEventListener('click', toggleTheme);
