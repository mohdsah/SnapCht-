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
    const { data } = await sb.from('profiles').select('id, username, display_name, avatar_url, bio, location').in('id', need);
    (data || []).forEach(p => state.profiles[p.id] = p);
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
let currentTab = 'stats';

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
        if (error) document.getElementById('admMsg').textContent = 'Email atau kata laluan salah';
        else boot();
    };
}

async function boot() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return showLogin();
    const { data: p } = await sb.from('profiles').select('username, role').eq('id', session.user.id).maybeSingle();
    if (p?.role !== 'admin') {
        await sb.auth.signOut();
        return showLogin('Akaun ini bukan admin.');
    }
    state.currentUser = session.user;
    state.profile = p;
    showApp();
}

function showApp() {
    const tabs = [['stats', '📊 Ringkasan'], ['videos', '🎞️ Video'], ['comments', '💬 Komen'], ['reports', '🚩 Laporan'], ['users', '👥 Pengguna']];
    root.innerHTML = `
        <div class="adm-bar"><h2>🛡️ Panel Admin</h2>
            <span style="color:var(--muted);font-size:.8rem;">@${escapeHtml(state.profile.username)}</span>
            <a class="btn-secondary" href="index.html">Laman Utama</a>
            <button class="btn-danger" id="admOut">Log Keluar</button></div>
        <div class="adm-tabs">${tabs.map(t => `<button data-tab="${t[0]}">${t[1]}</button>`).join('')}</div>
        <div id="adminBody"></div>`;
    document.getElementById('admOut').onclick = async () => { await sb.auth.signOut(); location.reload(); };
    root.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => loadTab(b.dataset.tab));
    document.getElementById('adminBody').addEventListener('click', onAction);
    loadTab('stats');
}

function loadTab(tab, search = '') {
    currentTab = tab;
    root.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    ({ stats: tabStats, videos: tabVideos, comments: tabComments, reports: tabReports, users: tabUsers })[tab](search);
}

const body = () => document.getElementById('adminBody');
const searchBox = (v, ph) => `<input class="modal-input" id="admSearch" placeholder="${ph}" value="${escapeHtml(v)}">`;
function bindSearch(tab) {
    let t; document.getElementById('admSearch').oninput = (e) => { clearTimeout(t); t = setTimeout(() => loadTab(tab, e.target.value), 400); };
}

async function tabStats() {
    const count = async (table, f) => { let q = sb.from(table).select('id', { count: 'exact', head: true }); if (f) q = f(q); const { count: c } = await q; return c ?? 0; };
    const [u, v, c, r, b] = await Promise.all([count('profiles'), count('videos'), count('comments'), count('reports'), count('profiles', q => q.eq('banned', true))]);
    body().innerHTML = `<div class="adm-grid">${[['Pengguna', u], ['Video', v], ['Komen', c], ['Laporan', r], ['Disekat', b]]
        .map(([k, n]) => `<div class="adm-stat"><b>${n}</b>${k}</div>`).join('')}</div>`;
}

async function tabVideos(search = '') {
    const q = sanitizeSearch(search);
    let query = sb.from('videos').select('id, username, description, video_url, likes, views, created_at').order('created_at', { ascending: false }).limit(50);
    if (q) query = query.or(`description.ilike.%${q}%,username.ilike.%${q}%`);
    const { data, error } = await query;
    body().innerHTML = searchBox(q, 'Cari kapsyen atau username...') + (error ? '<div class="empty-state">Gagal memuatkan</div>' :
        data.length ? data.map(v => `<div class="adm-card"><b>@${escapeHtml(v.username)}</b> · ${new Date(v.created_at).toLocaleDateString()}<br>
            ${escapeHtml((v.description || '').slice(0, 120))}<br><small style="color:var(--muted)">❤️ ${v.likes} · 👁️ ${v.views}</small>
            <div class="adm-actions">${isValidVideoUrl(v.video_url) ? `<button onclick="window.open(this.dataset.u,'_blank','noopener')" data-u="${escapeHtml(v.video_url)}">▶ Lihat</button>` : ''}
            <button class="danger" data-act="delvideo" data-id="${v.id}" data-url="${escapeHtml(v.video_url)}">🗑️ Padam</button></div></div>`).join('')
            : '<div class="empty-state">Tiada video</div>');
    bindSearch('videos');
}

async function tabComments(search = '') {
    const q = sanitizeSearch(search);
    let query = sb.from('comments').select('id, username, comment_text, created_at').order('created_at', { ascending: false }).limit(50);
    if (q) query = query.ilike('comment_text', `%${q}%`);
    const { data, error } = await query;
    body().innerHTML = searchBox(q, 'Cari komen...') + (error ? '<div class="empty-state">Gagal memuatkan</div>' :
        data.length ? data.map(c => `<div class="adm-card"><b>@${escapeHtml(c.username)}</b> · ${new Date(c.created_at).toLocaleString()}<br>${escapeHtml(c.comment_text)}
            <div class="adm-actions"><button class="danger" data-act="delcomment" data-id="${c.id}">🗑️ Padam</button></div></div>`).join('')
            : '<div class="empty-state">Tiada komen</div>');
    bindSearch('comments');
}

async function tabReports() {
    const { data, error } = await sb.from('reports').select('id, reason, created_at, videos(id, username, description, video_url)')
        .order('created_at', { ascending: false }).limit(50);
    body().innerHTML = error ? '<div class="empty-state">Gagal memuatkan</div>' : data.length ? data.map(r => {
        const v = r.videos;
        return `<div class="adm-card"><b>${escapeHtml(r.reason)}</b> · ${new Date(r.created_at).toLocaleDateString()}<br>
            ${v ? `@${escapeHtml(v.username)}: ${escapeHtml((v.description || '').slice(0, 100))}` : '<i>Video sudah dipadam</i>'}
            <div class="adm-actions">${v ? `<button class="danger" data-act="delvideo" data-id="${v.id}" data-url="${escapeHtml(v.video_url)}">🗑️ Padam video</button>` : ''}
            <button data-act="ignore" data-id="${r.id}">Abaikan</button></div></div>`;
    }).join('') : '<div class="empty-state">Tiada laporan 🎉</div>';
}

async function tabUsers(search = '') {
    const q = sanitizeSearch(search).toLowerCase();
    let query = sb.from('profiles').select('id, username, display_name, role, banned, location, created_at').order('created_at', { ascending: false }).limit(50);
    if (q) query = query.ilike('username', `%${q}%`);
    const { data, error } = await query;
    body().innerHTML = searchBox(q, 'Cari nama pengguna...') + (error ? '<div class="empty-state">Gagal memuatkan</div>' :
        data.map(u => {
            const self = u.id === state.currentUser.id;
            return `<div class="adm-card"><b>@${escapeHtml(u.username)}</b> ${u.display_name ? `(${escapeHtml(u.display_name)})` : ''}
                ${u.role === 'admin' ? '🛡️' : ''} ${u.banned ? '<span style="color:var(--danger)">· disekat</span>' : ''}<br>
                <small style="color:var(--muted)">${u.location ? '📍 ' + escapeHtml(u.location) + ' · ' : ''}Sertai ${new Date(u.created_at).toLocaleDateString()}</small>
                ${self ? '' : `<div class="adm-actions">
                    <button class="${u.banned ? '' : 'danger'}" data-act="ban" data-id="${u.id}" data-v="${u.banned ? '0' : '1'}">${u.banned ? 'Nyahsekat' : '⛔ Sekat'}</button>
                    <button data-act="role" data-id="${u.id}" data-v="${u.role === 'admin' ? 'user' : 'admin'}">${u.role === 'admin' ? 'Turunkan admin' : '🛡️ Jadikan admin'}</button></div>`}</div>`;
        }).join(''));
    bindSearch('users');
}

async function onAction(e) {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const { act, id, v, url } = b.dataset;
    const sure = (m) => confirm(m);
    b.disabled = true;
    let error = null;
    if (act === 'delvideo') {
        if (!sure('Padam video ini secara kekal?')) return (b.disabled = false);
        ({ error } = await sb.from('videos').delete().eq('id', id));
        if (!error) removeVideoFile(url).catch(() => {});
    } else if (act === 'delcomment') {
        if (!sure('Padam komen ini?')) return (b.disabled = false);
        ({ error } = await sb.from('comments').delete().eq('id', id));
    } else if (act === 'ignore') {
        ({ error } = await sb.from('reports').delete().eq('id', id));
    } else if (act === 'ban') {
        ({ error } = await sb.from('profiles').update({ banned: v === '1' }).eq('id', id));
    } else if (act === 'role') {
        if (!sure(v === 'admin' ? 'Jadikan pengguna ini admin?' : 'Turunkan daripada admin?')) return (b.disabled = false);
        ({ error } = await sb.from('profiles').update({ role: v }).eq('id', id));
    }
    showToast(error ? '❌ Gagal' : '✅ Berjaya', !!error);
    loadTab(currentTab, document.getElementById('admSearch')?.value || '');
}

boot();
