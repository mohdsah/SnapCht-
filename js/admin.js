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

function sanitizeSearch(s) {
    // buang aksara yang merosakkan sintaks .or() PostgREST dan wildcard ilike
    return String(s || '').replace(/[,()%*_\\"]/g, ' ').replace(/\s+/g, ' ').trim();
}

const root = document.getElementById('adminRoot');
const PAGE = 30;
let currentTab = 'stats';
const F = { videos: { q: '', sort: 'created_at', hidden: false }, comments: { q: '' }, users: { q: '', f: '' } };
const body = () => document.getElementById('adminBody');
const box = () => document.getElementById('listBox');
const fmt = (d) => new Date(d).toLocaleString();
const logAction = (action, target, detail) =>
    sb.from('admin_logs').insert({ action, target: target || null, detail: detail || null });

function showLogin(msg = '') {
    root.innerHTML = `<div class="auth-card" style="margin:8vh auto;">
        <div class="brand-logo" style="font-size:1.6rem;">Snap<span>Cht</span> Admin</div>
        <form id="admForm" style="margin-top:18px;" novalidate>
            <input class="modal-input" id="admEmail" type="email" placeholder="Email admin" autocomplete="email">
            <input class="modal-input" id="admPass" type="password" placeholder="Kata laluan" autocomplete="current-password">
            <button class="btn-primary" type="submit">Log Masuk</button>
        </form>
        <p class="auth-msg" id="admMsg">${escapeHtml(msg)}</p>
        <div class="auth-links"><a href="index.html">← Laman utama</a></div></div>`;
    document.getElementById('admForm').onsubmit = async (e) => {
        e.preventDefault();
        const { error } = await sb.auth.signInWithPassword({
            email: document.getElementById('admEmail').value.trim(), password: document.getElementById('admPass').value });
        if (error) document.getElementById('admMsg').textContent = 'Email atau kata laluan salah'; else boot();
    };
}

async function boot() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return showLogin();
    const { data: p } = await sb.from('profiles').select('username, role').eq('id', session.user.id).maybeSingle();
    if (p?.role !== 'admin') { await sb.auth.signOut(); return showLogin('Akaun ini bukan admin.'); }
    state.currentUser = session.user; state.profile = p;
    showApp();
}

function showApp() {
    root.innerHTML = `
        <div class="adm-bar"><h2>🛡️ Panel Admin</h2>
            <span style="color:var(--muted);font-size:.8rem;">@${escapeHtml(state.profile.username)}</span>
            <a class="btn-secondary" href="index.html">Laman Utama</a>
            <button class="btn-danger" id="admOut">Log Keluar</button></div>
        <div class="adm-tabs">${Object.entries(TABS).map(([k, t]) => `<button data-tab="${k}">${t.label}</button>`).join('')}</div>
        <div id="adminBody"></div>`;
    document.getElementById('admOut').onclick = async () => { await sb.auth.signOut(); location.reload(); };
    root.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => loadTab(b.dataset.tab));
    body().addEventListener('click', onAction);
    loadTab('stats');
}

function loadTab(tab) {
    currentTab = tab;
    root.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    body().innerHTML = `${TABS[tab].bar()}<div id="listBox"></div>`;
    let t;
    body().querySelectorAll('[data-f]').forEach(el => {
        const ev = (el.type === 'checkbox' || el.tagName === 'SELECT') ? 'change' : 'input';
        el.addEventListener(ev, () => {
            clearTimeout(t);
            t = setTimeout(() => { F[tab][el.dataset.f] = el.type === 'checkbox' ? el.checked : el.value; refresh(); }, ev === 'input' ? 400 : 0);
        });
    });
    refresh();
}
const refresh = () => TABS[currentTab].list();

async function paged(fetchPage, renderItem, empty) {
    const el = box(); el.innerHTML = '';
    const list = document.createElement('div'), more = document.createElement('button');
    more.className = 'btn-secondary'; more.textContent = 'Muat lebih'; more.style.margin = '10px 0';
    el.append(list, more);
    let off = 0;
    const load = async () => {
        more.disabled = true;
        const { data, error } = await fetchPage(off, off + PAGE - 1);
        if (error) { list.insertAdjacentHTML('beforeend', '<div class="empty-state">Gagal memuatkan</div>'); more.style.display = 'none'; return; }
        if (!off && !data.length) list.innerHTML = `<div class="empty-state">${empty}</div>`;
        list.insertAdjacentHTML('beforeend', data.map(renderItem).join(''));
        off += data.length; more.disabled = false; more.style.display = data.length < PAGE ? 'none' : 'block';
    };
    more.onclick = load; await load();
}
const filterIn = (tab, key, ph) => `<input class="modal-input" data-f="${key}" placeholder="${ph}" value="${escapeHtml(F[tab][key])}">`;
const count = async (table, f) => { let q = sb.from(table).select('id', { count: 'exact', head: true }); if (f) q = f(q); return (await q).count ?? 0; };

// ---------- RINGKASAN
async function listStats() {
    box().innerHTML = '<div class="empty-state">Memuatkan...</div>';
    const [u, v, h, c, r, b, a] = await Promise.all([count('profiles'), count('videos'), count('videos', q => q.eq('hidden', true)),
        count('comments'), count('reports'), count('profiles', q => q.eq('banned', true)), count('profiles', q => q.eq('role', 'admin'))]);
    const [top, newest] = await Promise.all([
        sb.from('videos').select('id, username, description, views, likes').order('views', { ascending: false }).limit(5),
        sb.from('profiles').select('username, display_name, created_at').order('created_at', { ascending: false }).limit(5)]);
    box().innerHTML = `<div class="adm-grid">${[['Pengguna', u], ['Video', v], ['Disembunyikan', h], ['Komen', c], ['Laporan', r], ['Disekat', b], ['Admin', a]]
        .map(([k, n]) => `<div class="adm-stat"><b>${n}</b>${k}</div>`).join('')}</div>
        <h3 style="margin:18px 0 8px;">🔥 Video teratas</h3>${(top.data || []).map(x => `<div class="adm-card">@${escapeHtml(x.username)}: ${escapeHtml((x.description || '').slice(0, 70))}<br><small style="color:var(--muted)">👁️ ${x.views} · ❤️ ${x.likes}</small></div>`).join('') || '<div class="empty-state">Tiada data</div>'}
        <h3 style="margin:18px 0 8px;">🆕 Pengguna terbaru</h3>${(newest.data || []).map(x => `<div class="adm-card">@${escapeHtml(x.username)} ${x.display_name ? '(' + escapeHtml(x.display_name) + ')' : ''} · ${fmt(x.created_at)}</div>`).join('')}`;
}

// ---------- VIDEO
const barVideos = () => `<div class="adm-filter">${filterIn('videos', 'q', 'Cari kapsyen / username')}
    <select class="modal-input" data-f="sort"><option value="created_at">Terbaru</option><option value="views" ${F.videos.sort === 'views' ? 'selected' : ''}>Tontonan</option><option value="likes" ${F.videos.sort === 'likes' ? 'selected' : ''}>Suka</option></select>
    <label><input type="checkbox" data-f="hidden" ${F.videos.hidden ? 'checked' : ''}> Disembunyikan sahaja</label></div>`;
function listVideos() {
    const f = F.videos, s = sanitizeSearch(f.q);
    return paged((a, b) => {
        let q = sb.from('videos').select('id, user_id, username, description, video_url, likes, views, hidden, created_at').order(f.sort, { ascending: false }).range(a, b);
        if (s) q = q.or(`description.ilike.%${s}%,username.ilike.%${s}%`);
        if (f.hidden) q = q.eq('hidden', true);
        return q;
    }, v => `<div class="adm-card"><b>@${escapeHtml(v.username)}</b> · ${fmt(v.created_at)} ${v.hidden ? '<span class="badge bad">disembunyikan</span>' : ''}<br>
        ${escapeHtml((v.description || '').slice(0, 140))}<br><small style="color:var(--muted)">❤️ ${v.likes} · 👁️ ${v.views}</small>
        <div class="adm-actions">${(isValidVideoUrl(v.video_url) || parseEmbed(v.video_url)) ? `<button data-act="view" data-url="${escapeHtml(v.video_url)}">▶ Lihat</button>` : ''}
        <button data-act="editcap" data-id="${v.id}" data-cap="${escapeHtml(v.description || '')}">✏️ Kapsyen</button>
        <button data-act="hide" data-id="${v.id}" data-v="${v.hidden ? '0' : '1'}">${v.hidden ? '👁️ Paparkan' : '🙈 Sembunyi'}</button>
        <button class="danger" data-act="delvideo" data-id="${v.id}" data-url="${escapeHtml(v.video_url)}">🗑️ Padam</button></div></div>`, 'Tiada video');
}

// ---------- KOMEN
const barComments = () => `<div class="adm-filter">${filterIn('comments', 'q', 'Cari komen...')}</div>`;
function listComments() {
    const s = sanitizeSearch(F.comments.q);
    return paged((a, b) => { let q = sb.from('comments').select('id, username, comment_text, created_at').order('created_at', { ascending: false }).range(a, b); if (s) q = q.ilike('comment_text', `%${s}%`); return q; },
        c => `<div class="adm-card"><b>@${escapeHtml(c.username)}</b> · ${fmt(c.created_at)}<br>${escapeHtml(c.comment_text)}
        <div class="adm-actions"><button class="danger" data-act="delcomment" data-id="${c.id}">🗑️ Padam</button></div></div>`, 'Tiada komen');
}

// ---------- LAPORAN
function listReports() {
    return paged((a, b) => sb.from('reports').select('id, reason, created_at, videos(id, username, description, video_url, hidden)').order('created_at', { ascending: false }).range(a, b),
        r => { const v = r.videos; return `<div class="adm-card"><b>${escapeHtml(r.reason)}</b> · ${fmt(r.created_at)}<br>
            ${v ? `@${escapeHtml(v.username)}: ${escapeHtml((v.description || '').slice(0, 100))}` : '<i>Video sudah dipadam</i>'}
            <div class="adm-actions">${v && (isValidVideoUrl(v.video_url) || parseEmbed(v.video_url)) ? `<button data-act="view" data-url="${escapeHtml(v.video_url)}">▶ Lihat</button>` : ''}
            ${v ? `<button data-act="hide" data-id="${v.id}" data-v="${v.hidden ? '0' : '1'}">${v.hidden ? '👁️ Paparkan' : '🙈 Sembunyi'}</button>
            <button class="danger" data-act="delvideo" data-id="${v.id}" data-url="${escapeHtml(v.video_url)}">🗑️ Padam</button>` : ''}
            <button data-act="ignore" data-id="${r.id}">Abaikan</button></div></div>`; }, 'Tiada laporan 🎉');
}

// ---------- PENGGUNA
const barUsers = () => `<div class="adm-filter">${filterIn('users', 'q', 'Cari username...')}
    <select class="modal-input" data-f="f"><option value="">Semua</option><option value="banned" ${F.users.f === 'banned' ? 'selected' : ''}>Disekat</option><option value="admin" ${F.users.f === 'admin' ? 'selected' : ''}>Admin</option></select></div>`;
function listUsers() {
    const f = F.users, s = sanitizeSearch(f.q).toLowerCase();
    return paged((a, b) => {
        let q = sb.from('profiles').select('id, username, display_name, bio, location, avatar_url, role, banned, ban_reason, created_at').order('created_at', { ascending: false }).range(a, b);
        if (s) q = q.ilike('username', `%${s}%`);
        if (f.f === 'banned') q = q.eq('banned', true); if (f.f === 'admin') q = q.eq('role', 'admin');
        return q;
    }, u => {
        const self = u.id === state.currentUser.id, adm = u.role === 'admin';
        return `<div class="adm-card adm-user">${avatarHtml(u)}<div class="adm-info"><b>${escapeHtml(displayName(u))}</b> <small>@${escapeHtml(u.username)}</small>
            ${adm ? '<span class="badge">admin</span>' : ''}${u.banned ? '<span class="badge bad">disekat</span>' : ''}<br>
            <small style="color:var(--muted)">${u.location ? '📍 ' + escapeHtml(u.location) + ' · ' : ''}Sertai ${fmt(u.created_at)}${u.ban_reason ? '<br>Sebab: ' + escapeHtml(u.ban_reason) : ''}</small>
            <div class="adm-actions"><button data-act="edituser" data-u="${escapeHtml(JSON.stringify({ id: u.id, username: u.username, display_name: u.display_name, bio: u.bio, location: u.location, avatar_url: u.avatar_url }))}">✏️ Edit</button>
            ${self ? '' : `<button class="${u.banned ? '' : 'danger'}" data-act="ban" data-id="${u.id}" data-v="${u.banned ? '0' : '1'}">${u.banned ? 'Nyahsekat' : '⛔ Sekat'}</button>
            <button data-act="role" data-id="${u.id}" data-v="${adm ? 'user' : 'admin'}" data-name="${escapeHtml(u.username)}">${adm ? 'Turunkan admin' : '🛡️ Jadikan admin'}</button>
            ${adm ? '' : `<button class="danger" data-act="deluser" data-id="${u.id}" data-name="${escapeHtml(u.username)}">🗑️ Padam akaun</button>`}`}</div></div></div>`;
    }, 'Tiada pengguna');
}

// ---------- PENGUMUMAN
async function listAnnounce() {
    const { data } = await sb.from('site_settings').select('value').eq('key', 'announcement').maybeSingle();
    box().innerHTML = `<div class="adm-card"><p style="margin-bottom:8px;">Mesej ini dipaparkan sebagai sepanduk di laman utama (kosongkan untuk padam).</p>
        <textarea class="modal-input" id="annText" rows="3" maxlength="200" placeholder="cth: Selamat datang ke SnapCht!">${escapeHtml(data?.value || '')}</textarea>
        <button class="btn-primary" data-act="saveann">Simpan Pengumuman</button></div>`;
}

// ---------- LOG
function listLogs() {
    return paged((a, b) => sb.from('admin_logs').select('action, target, detail, created_at').order('created_at', { ascending: false }).range(a, b),
        l => `<div class="adm-card"><b>${escapeHtml(l.action)}</b> · ${fmt(l.created_at)}<br><small style="color:var(--muted)">${escapeHtml(l.target || '')} ${escapeHtml(l.detail || '')}</small></div>`, 'Tiada log');
}

const TABS = {
    stats: { label: '📊 Ringkasan', bar: () => '', list: listStats },
    videos: { label: '🎞️ Video', bar: barVideos, list: listVideos },
    comments: { label: '💬 Komen', bar: barComments, list: listComments },
    reports: { label: '🚩 Laporan', bar: () => '', list: listReports },
    users: { label: '👥 Pengguna', bar: barUsers, list: listUsers },
    announce: { label: '📢 Pengumuman', bar: () => '', list: listAnnounce },
    logs: { label: '📜 Log', bar: () => '', list: listLogs }
};

async function purgeUserFiles(uid) {
    for (const bucket of ['videos', 'avatars']) {
        const { data } = await sb.storage.from(bucket).list(uid, { limit: 1000 });
        if (data?.length) await sb.storage.from(bucket).remove(data.map(f => `${uid}/${f.name}`));
    }
}

function editUserModal(u) {
    const m = document.createElement('div'); m.className = 'modal-overlay'; m.id = 'editUser';
    m.innerHTML = `<div class="modal-content"><div class="modal-header"><h3>Edit @${escapeHtml(u.username)}</h3><button class="close-modal" id="euX">✕</button></div>
        <div class="field-label">Username</div><input class="modal-input" id="euUser" maxlength="20" value="${escapeHtml(u.username)}">
        <div class="field-label">Nama paparan</div><input class="modal-input" id="euName" maxlength="30" value="${escapeHtml(u.display_name || '')}">
        <div class="field-label">Bio</div><textarea class="modal-input" id="euBio" rows="2" maxlength="160">${escapeHtml(u.bio || '')}</textarea>
        <div class="field-label">Lokasi</div><input class="modal-input" id="euLoc" maxlength="80" value="${escapeHtml(u.location || '')}">
        ${u.avatar_url ? '<label style="display:block;margin-bottom:12px;"><input type="checkbox" id="euAv"> Buang gambar profil</label>' : ''}
        <button class="btn-primary" id="euSave">Simpan</button></div>`;
    document.body.appendChild(m);
    const close = () => m.remove();
    m.onclick = (e) => { if (e.target === m) close(); }; document.getElementById('euX').onclick = close;
    document.getElementById('euSave').onclick = async () => {
        const username = document.getElementById('euUser').value.trim().toLowerCase();
        if (!/^[a-z0-9_]{3,20}$/.test(username)) return showToast('Username: 3-20 aksara (a-z, 0-9, _)', true);
        const upd = { username, display_name: document.getElementById('euName').value.trim() || null,
            bio: document.getElementById('euBio').value.trim() || null, location: document.getElementById('euLoc').value.trim() || null };
        if (document.getElementById('euAv')?.checked) upd.avatar_url = null;
        const { error } = await sb.from('profiles').update(upd).eq('id', u.id);
        if (error) return showToast('❌ ' + (error.code === '23505' ? 'Username sudah digunakan' : 'Gagal'), true);
        logAction('edit_user', '@' + u.username, JSON.stringify(upd)); showToast('✅ Disimpan'); close(); refresh();
    };
}

async function onAction(e) {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const { act, id, v, url, name } = b.dataset;
    if (act === 'view') return window.open(url, '_blank', 'noopener');
    if (act === 'edituser') return editUserModal(JSON.parse(b.dataset.u));
    b.disabled = true;
    let error = null, ok = true;
    if (act === 'delvideo') {
        if (!confirm('Padam video ini secara kekal?')) ok = false;
        else { ({ error } = await sb.from('videos').delete().eq('id', id)); if (!error) { removeVideoFile(url).catch(() => {}); logAction('padam_video', id); } }
    } else if (act === 'hide') {
        ({ error } = await sb.from('videos').update({ hidden: v === '1' }).eq('id', id)); if (!error) logAction(v === '1' ? 'sembunyi_video' : 'paparkan_video', id);
    } else if (act === 'editcap') {
        const t = prompt('Kapsyen baharu:', b.dataset.cap);
        if (t === null) ok = false; else { ({ error } = await sb.from('videos').update({ description: t.slice(0, 500), title: t.slice(0, 100) }).eq('id', id)); if (!error) logAction('edit_kapsyen', id); }
    } else if (act === 'delcomment') {
        if (!confirm('Padam komen ini?')) ok = false; else { ({ error } = await sb.from('comments').delete().eq('id', id)); if (!error) logAction('padam_komen', id); }
    } else if (act === 'ignore') {
        ({ error } = await sb.from('reports').delete().eq('id', id));
    } else if (act === 'ban') {
        const reason = v === '1' ? prompt('Sebab sekatan (pilihan):', '') : '';
        if (reason === null) ok = false; else { ({ error } = await sb.from('profiles').update({ banned: v === '1', ban_reason: reason ? reason.slice(0, 200) : null }).eq('id', id)); if (!error) logAction(v === '1' ? 'sekat' : 'nyahsekat', id, reason || ''); }
    } else if (act === 'role') {
        if (!confirm(v === 'admin' ? `Jadikan @${name} admin?` : `Turunkan @${name} daripada admin?`)) ok = false;
        else { ({ error } = await sb.from('profiles').update({ role: v }).eq('id', id)); if (!error) logAction('tukar_peranan', '@' + name, v); }
    } else if (act === 'deluser') {
        if (prompt(`Padam akaun SECARA KEKAL beserta semua video & komen.\nTaip "${name}" untuk sahkan:`) !== name) ok = false;
        else { await purgeUserFiles(id).catch(() => {}); ({ error } = await sb.rpc('admin_delete_user', { p_uid: id })); if (!error) logAction('padam_akaun', '@' + name); }
    } else if (act === 'saveann') {
        const val = document.getElementById('annText').value.trim();
        ({ error } = await sb.from('site_settings').upsert({ key: 'announcement', value: val, updated_at: new Date().toISOString() }));
        if (!error) logAction('pengumuman', '', val);
    }
    b.disabled = false;
    if (!ok) return;
    showToast(error ? '❌ ' + (error.message || 'Gagal') : '✅ Berjaya', !!error);
    if (!error && act !== 'saveann') refresh();
}

boot();
