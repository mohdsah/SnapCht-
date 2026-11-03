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

function applyRoleUI() {}

async function showEditProfile() {
    if (!requireAccount()) return;
    closeModal('profileModal');
    const p = state.profile, uid = state.currentUser.id;
    const { data: mine } = await sb.from('videos').select('likes').eq('user_id', uid);
    const likes = (mine || []).reduce((s, v) => s + (v.likes || 0), 0);

    const modal = document.getElementById('editRoot');
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-header"><h3>Profil Saya</h3><button class="close-modal" id="pfClose">✕</button></div>
            <div class="profile-top">
                <div id="pfAvatar">${avatarHtml(p, 'lg')}</div>
                <button class="btn-secondary" id="pfPick" style="width:auto;padding:6px 16px;font-size:.8rem;">📷 Tukar gambar</button>
                <input type="file" id="pfFile" accept="image/jpeg,image/png,image/webp" style="display:none">
                <p style="color:var(--muted);font-size:.78rem;margin-top:8px;">@${escapeHtml(p.username)} · ${escapeHtml(state.currentUser.email || '')}</p>
                <p style="font-size:.8rem;margin-top:6px;">${(mine || []).length} video · ${formatNumber(likes)} suka · ${state.savedVideosSet.size} disimpan</p>
            </div>
            <div class="field-label">Nama paparan</div>
            <input class="modal-input" id="pfName" maxlength="30" value="${escapeHtml(p.display_name || '')}" placeholder="Nama anda">
            <div class="field-label">Bio</div>
            <textarea class="modal-input" id="pfBio" rows="2" maxlength="160" placeholder="Ceritakan tentang diri anda">${escapeHtml(p.bio || '')}</textarea>
            <div class="field-label">Alamat / Lokasi</div>
            <input class="modal-input" id="pfLoc" maxlength="80" value="${escapeHtml(p.location || '')}" placeholder="cth: Kuala Lumpur, Malaysia">
            <button class="btn-primary" id="pfSave">Simpan Profil</button>
            ${p.role === 'admin' ? '<a href="admin.html" class="btn-secondary" style="display:block;text-align:center;text-decoration:none;margin-top:10px;">🛡️ Panel Admin</a>' : ''}
            <button class="btn-danger" id="pfLogout" style="margin-top:10px;">Log Keluar</button>
        </div>`;
    const $ = id => document.getElementById(id);
    $('pfClose').onclick = () => (location.href = 'profile.html');
    $('pfLogout').onclick = logout;
    $('pfPick').onclick = () => $('pfFile').click();
    $('pfFile').onchange = () => {
        const f = $('pfFile').files[0];
        if (f) $('pfAvatar').innerHTML = `<img class="avatar lg" src="${URL.createObjectURL(f)}" alt="">`;
    };
    $('pfSave').onclick = async () => {
        const btn = $('pfSave'); btn.disabled = true;
        try {
            let avatar_url = p.avatar_url || null;
            const f = $('pfFile').files[0];
            if (f) {
                if (!/^image\/(jpeg|png|webp)$/.test(f.type)) throw new Error('Gambar mesti JPG, PNG atau WebP');
                if (f.size > 2 * 1024 * 1024) throw new Error('Gambar maksimum 2MB');
                const path = `${uid}/avatar_${Date.now()}.${f.type.split('/')[1]}`;
                const { error: ue } = await sb.storage.from('avatars').upload(path, f, { contentType: f.type, cacheControl: '3600' });
                if (ue) throw ue;
                avatar_url = sb.storage.from('avatars').getPublicUrl(path).data.publicUrl;
            }
            const upd = {
                display_name: $('pfName').value.trim().slice(0, 30) || null,
                bio: $('pfBio').value.trim().slice(0, 160) || null,
                location: $('pfLoc').value.trim().slice(0, 80) || null,
                avatar_url
            };
            const { error } = await sb.from('profiles').update(upd).eq('id', uid);
            if (error) throw error;
            Object.assign(state.profile, upd);
            state.profiles[uid] = { ...state.profiles[uid], id: uid, username: p.username, ...upd };
            applyRoleUI();
            showToast('✅ Profil disimpan');
            location.href = 'profile.html';
        } catch (e) {
            showToast('❌ ' + (e.message || 'Gagal menyimpan'), true);
            btn.disabled = false;
        }
    };
}


(async () => {
    await loadSessionUser();
    if (requireAccount()) showEditProfile();
})();


document.getElementById('themeBtn')?.addEventListener('click', toggleTheme);
