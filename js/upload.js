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

function showUploadModal() {
    if (!requireAccount()) return;
    closeModal('uploadModal');

    const modal = document.getElementById('uploadRoot');
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h3>🎥 Muat Naik Video</h3>
                <button class="close-modal" onclick="location.href='index.html'">✕</button>
            </div>
            <div class="tab-switch">
                <button class="active" data-upload-tab="url">🔗 URL Video</button>
                <button data-upload-tab="file">📁 Fail Video</button>
            </div>
            <div id="tab-url">
                <input type="text" id="videoUrlInput" placeholder="https://.../video.mp4" class="modal-input">
                <p style="color:#ff9a3c;font-size:0.75rem;margin-bottom:12px;">URL mesti berakhir dengan .mp4 / .webm / .mov</p>
            </div>
            <div id="tab-file" style="display:none;">
                <input type="file" id="videoFileInput" accept="video/mp4,video/webm,video/quicktime" class="modal-input">
                <p style="color:#ff9a3c;font-size:0.75rem;margin-bottom:12px;">Maks 50MB. Disimpan ke Supabase Storage.</p>
            </div>
            <input type="text" id="videoCaption" placeholder="Kapsyen (contoh: #fyp #viral)" class="modal-input" maxlength="500">
            <div id="uploadProgressContainer" style="display:none;">
                <div class="upload-progress"><div class="upload-progress-bar" id="uploadProgressBar"></div></div>
                <p id="uploadStatus" style="font-size:0.8rem;margin-top:8px;text-align:center;">Memproses...</p>
            </div>
            <button class="btn-primary" id="uploadBtn">Terbitkan Video</button>
            <p id="uploadErrorMsg" style="color:#dc2626;font-size:0.75rem;margin-top:8px;display:none;"></p>
        </div>`;

    let uploadMode = 'url';
    modal.querySelectorAll('[data-upload-tab]').forEach(btn => {
        btn.addEventListener('click', () => {
            uploadMode = btn.getAttribute('data-upload-tab');
            modal.querySelectorAll('[data-upload-tab]').forEach(b => b.classList.toggle('active', b === btn));
            document.getElementById('tab-url').style.display = uploadMode === 'url' ? 'block' : 'none';
            document.getElementById('tab-file').style.display = uploadMode === 'file' ? 'block' : 'none';
        });
    });

    const uploadBtn = document.getElementById('uploadBtn');
    const progressContainer = document.getElementById('uploadProgressContainer');
    const progressBar = document.getElementById('uploadProgressBar');
    const uploadStatus = document.getElementById('uploadStatus');
    const errorMsg = document.getElementById('uploadErrorMsg');

    uploadBtn.onclick = async () => {
        errorMsg.style.display = 'none';
        const caption = document.getElementById('videoCaption').value.trim() || 'Tiada kapsyen';
        const username = state.profile?.username || 'user_' + state.currentUser.id.slice(0, 6);

        uploadBtn.disabled = true;
        progressContainer.style.display = 'block';
        progressBar.style.width = '20%';
        uploadStatus.innerText = 'Memproses...';

        try {
            let videoUrl = '';
            if (uploadMode === 'url') {
                videoUrl = document.getElementById('videoUrlInput').value.trim();
                if (!isValidVideoUrl(videoUrl)) throw new Error('URL tidak sah. Pastikan berakhir .mp4/.webm/.mov');
                progressBar.style.width = '70%';
            } else {
                const file = document.getElementById('videoFileInput').files[0];
                if (!file) throw new Error('Sila pilih fail video');
                if (file.size > 50 * 1024 * 1024) throw new Error('Saiz melebihi 50MB');

                uploadStatus.innerText = 'Memuat naik...';
                const ext = (file.name.split('.').pop() || 'mp4').toLowerCase().replace(/[^a-z0-9]/g, '');
                const path = `${state.currentUser.id}/${Date.now()}.${ext}`;

                const { error: upErr } = await sb.storage.from('videos')
                    .upload(path, file, { cacheControl: '3600', upsert: false, contentType: file.type });
                if (upErr) throw upErr;

                const { data: { publicUrl } } = sb.storage.from('videos').getPublicUrl(path);
                videoUrl = publicUrl;
                progressBar.style.width = '80%';
            }

            uploadStatus.innerText = 'Menyimpan...';
            const { error: insErr } = await sb.from('videos').insert({
                description: caption,
                title: caption.substring(0, 100),
                video_url: videoUrl,
                user_id: state.currentUser.id,
                username
            });
            if (insErr) throw insErr;

            progressBar.style.width = '100%';
            uploadStatus.innerText = 'Selesai!';
            showToast('✅ Video diterbitkan!');
            setTimeout(() => { location.href = 'index.html'; }, 800);
        } catch (err) {
            console.error(err);
            errorMsg.innerText = '❌ ' + (err.message || 'Gagal');
            errorMsg.style.display = 'block';
            uploadBtn.disabled = false;
            progressContainer.style.display = 'none';
        }
    };
}


(async () => {
    await loadSessionUser();
    if (requireAccount()) showUploadModal();
})();


document.getElementById('themeBtn')?.addEventListener('click', toggleTheme);
