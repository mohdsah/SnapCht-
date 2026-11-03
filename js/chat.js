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
    const { data } = await sb.from('profiles').select('username, role, banned, display_name, bio, location, avatar_url').eq('id', u.id).maybeSingle();
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

async function openChatConversation(userId, username) {
    state.activeChatUserId = userId;
    document.getElementById('chatUserList').style.display = 'none';
    const convDiv = document.getElementById('chatConversation');
    convDiv.style.display = 'block';
    convDiv.innerHTML = `
        <div style="margin-bottom:12px;">
            <button onclick="backToChatList()" style="background:#333;border:none;padding:8px 16px;border-radius:20px;color:white;cursor:pointer;">← Kembali</button>
            <span style="margin-left:12px;font-weight:bold;">@${escapeHtml(username)}</span>
        </div>
        <div id="chatMessagesList" style="height:300px;overflow-y:auto;margin-bottom:12px;"></div>
        <div style="display:flex;gap:8px;">
            <input type="text" id="chatInput" placeholder="Mesej..." maxlength="1000"
                style="flex:1;padding:12px;background:#2a2a2a;border:none;border-radius:24px;color:white;outline:none;">
            <button id="sendChatBtn" style="background:#fe2c55;border:none;padding:12px 20px;border-radius:24px;color:white;cursor:pointer;">Hantar</button>
        </div>`;

    await loadChatMessages(userId);
    setupRealtimeChat(userId);

    const input = document.getElementById('chatInput');
    const sendBtn = document.getElementById('sendChatBtn');
    const send = async () => {
        const text = input.value.trim();
        if (!text || sendBtn.disabled) return;
        sendBtn.disabled = true;
        const { error } = await sb.from('messages').insert({
            from_user: state.currentUser.id, to_user: userId, message: text.substring(0, 1000)
        });
        sendBtn.disabled = false;
        if (error) { showToast('❌ Gagal hantar', true); return; }
        input.value = '';
        await loadChatMessages(userId);
    };
    sendBtn.onclick = send;
    input.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
}

async function loadChatMessages(userId) {
    const me = state.currentUser.id;
    const { data } = await sb.from('messages').select('*')
        .or(`and(from_user.eq.${me},to_user.eq.${userId}),and(from_user.eq.${userId},to_user.eq.${me})`)
        .order('created_at', { ascending: true }).limit(200);

    const container = document.getElementById('chatMessagesList');
    if (!container) return;
    container.innerHTML = data?.length ? data.map(msg => `
        <div style="text-align:${msg.from_user === me ? 'right' : 'left'};margin:8px 0;">
            <div style="display:inline-block;background:${msg.from_user === me ? '#fe2c55' : '#2a2a2a'};color:#fff;padding:8px 12px;border-radius:18px;max-width:80%;word-break:break-word;">
                ${escapeHtml(msg.message)}
            </div>
            <div style="font-size:0.6rem;opacity:0.6;margin-top:2px;">${new Date(msg.created_at).toLocaleTimeString()}</div>
        </div>`).join('') : '<div class="empty-state">Tiada mesej. Mulakan perbualan!</div>';
    container.scrollTop = container.scrollHeight;
}

function setupRealtimeChat(userId) {
    removeChatSubscription();
    const channelName = `chat_${state.currentUser.id}_${userId}_${Date.now()}`;
    state.activeChatSubscription = sb.channel(channelName)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
            const msg = payload.new;
            const me = state.currentUser.id;
            const involvesMe = msg.from_user === me || msg.to_user === me;
            const involvesThem = msg.from_user === userId || msg.to_user === userId;
            if (involvesMe && involvesThem && state.activeChatUserId === userId) loadChatMessages(userId);
        }).subscribe();
}

function removeChatSubscription() {
    if (state.activeChatSubscription) {
        sb.removeChannel(state.activeChatSubscription);
        state.activeChatSubscription = null;
    }
}

window.backToChatList = function () {
    removeChatSubscription();
    state.activeChatUserId = null;
    document.getElementById('chatConversation').style.display = 'none';
    document.getElementById('chatUserList').style.display = 'block';
};


(async () => {
    await loadSessionUser();
    if (!requireAccount()) return;
    const root = document.getElementById('chatRoot');
    const { data: users } = await sb.from('profiles').select('id, username, display_name, avatar_url')
        .neq('id', state.currentUser.id).order('created_at', { ascending: false }).limit(60);
    root.innerHTML = `<div class="modal-header"><h3>💬 Mesej</h3></div>
        <div id="chatUserList">${users?.length ? users.map(u => `
            <div class="account-item" data-chat-user="${u.id}" data-username="${escapeHtml(u.username)}">
                ${avatarHtml(u)}<div class="account-name">${escapeHtml(displayName(u))} <small style="color:var(--muted)">@${escapeHtml(u.username)}</small></div>
            </div>`).join('') : '<div class="empty-state">Tiada pengguna lain</div>'}</div>
        <div id="chatConversation" style="display:none;"></div>`;
    root.querySelectorAll('[data-chat-user]').forEach(el => el.onclick = () =>
        openChatConversation(el.dataset.chatUser, el.dataset.username));
    const target = new URLSearchParams(location.search).get('u');
    const t = users?.find(u => u.id === target);
    if (t) openChatConversation(t.id, t.username);
})();


document.getElementById('themeBtn')?.addEventListener('click', toggleTheme);
