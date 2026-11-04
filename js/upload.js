// ============================================================
// TETAPAN MUAT NAIK - ubah di sini sahaja
// Untuk aktifkan Cloudinary, isi cloudName dan uploadPreset (bukan rahsia).
// ============================================================
const UPLOAD_CONFIG = {
    maxMB: 50,                // had saiz fail
    maxSeconds: 90,           // had tempoh video
    allowed: ['video/mp4', 'video/webm', 'video/quicktime'],
    defaultProvider: 'cloudinary',  // 'supabase' | 'cloudinary' | 'url'
    cloudinary: { cloudName: 'dqzcejjon', uploadPreset: 'snapcht_video', folder: '' }  // folder dalam preset (Asset folder)
};

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

// ===== PENYEDIA MUAT NAIK (Supabase / Cloudinary / URL) =====
// Untuk tambah penyedia baharu: tambah satu entri dalam PROVIDERS dengan enabled() dan upload().
// upload() mesti memulangkan { url, cleanup? }. cleanup() dipanggil jika penyimpanan rekod gagal.
// Semak pautan: fail video terus ATAU pautan awam YouTube / TikTok / Facebook / Instagram
function urlProblem(raw) {
    const url = String(raw || '').trim();
    if (!url) return 'Masukkan pautan video.';
    if (parseEmbed(url) || isValidVideoUrl(url)) return '';
    try {
        const u = new URL(url), h = u.hostname.toLowerCase();
        if (/(^|\.)(vm|vt)\.tiktok\.com$/.test(h) || (/tiktok\.com$/.test(h) && u.pathname.startsWith('/t/')))
            return 'Pautan pendek TikTok tak disokong. Buka video di pelayar dan salin pautan penuh (tiktok.com/@nama/video/...).';
        if (/instagram\.com$/.test(h)) return 'Pautan Instagram mesti ke siaran atau reel awam (instagram.com/reel/... atau /p/...).';
        if (/facebook\.com$/.test(h)) return 'Pautan Facebook mesti ke video atau reel awam.';
        if (/(^|\.)youtube\.com$/.test(h)) return 'Pautan YouTube mesti ke video (watch?v=..., /shorts/...).';
    } catch {}
    return 'Pautan tidak disokong. Guna .mp4/.webm/.mov atau pautan awam YouTube, TikTok, Facebook, Instagram.';
}

function parseXhrError(xhr) {
    try { const j = JSON.parse(xhr.responseText); return j.message || j.error?.message || xhr.statusText; }
    catch { return xhr.statusText || 'Muat naik gagal'; }
}

const PROVIDERS = {
    supabase: {
        label: '☁️ Supabase',
        enabled: () => true,
        needsFile: true,
        async upload(file, { onProgress, ctl }) {
            const { data: { session } } = await sb.auth.getSession();
            if (!session) throw new Error('Sesi tamat. Sila log masuk semula.');
            const ext = (file.name.split('.').pop() || 'mp4').toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp4';
            const path = `${state.currentUser.id}/${Date.now()}.${ext}`;
            return new Promise((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                xhr.open('POST', `${SB_URL}/storage/v1/object/videos/${path}`);
                xhr.setRequestHeader('Authorization', 'Bearer ' + session.access_token);
                xhr.setRequestHeader('apikey', SB_ANON_KEY);
                xhr.setRequestHeader('Content-Type', file.type);
                xhr.setRequestHeader('x-upsert', 'false');
                xhr.setRequestHeader('cache-control', 'max-age=3600');
                xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
                xhr.onload = () => xhr.status < 300
                    ? resolve({ url: sb.storage.from('videos').getPublicUrl(path).data.publicUrl,
                                cleanup: () => sb.storage.from('videos').remove([path]) })
                    : reject(new Error(parseXhrError(xhr)));
                xhr.onerror = () => reject(new Error('Rangkaian terputus'));
                xhr.onabort = () => reject(new Error('Dibatalkan'));
                ctl.abort = () => xhr.abort();
                xhr.send(file);
            });
        }
    },
    cloudinary: {
        label: '🌩️ Cloudinary',
        enabled: () => !!(UPLOAD_CONFIG.cloudinary.cloudName && UPLOAD_CONFIG.cloudinary.uploadPreset),
        needsFile: true,
        upload(file, { onProgress, ctl }) {
            const c = UPLOAD_CONFIG.cloudinary;
            return new Promise((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                xhr.open('POST', `https://api.cloudinary.com/v1_1/${encodeURIComponent(c.cloudName)}/video/upload`);
                const fd = new FormData();
                fd.append('file', file);
                fd.append('upload_preset', c.uploadPreset);
                if (c.folder) fd.append('folder', c.folder);
                xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
                xhr.onload = () => {
                    let r = {};
                    try { r = JSON.parse(xhr.responseText); } catch {}
                    if (xhr.status < 300 && r.secure_url) {
                        let url = r.secure_url;
                        // Tukar MOV dan format lain kepada MP4 supaya boleh dimainkan di semua pelayar
                        if (!/\.(mp4|webm)$/i.test(url.split('?')[0])) url = url.replace(/\.\w+$/, '.mp4');
                        resolve({ url, cleanup: async () => {} }); // pemadaman fail memerlukan pelayan (lihat nota)
                    } else reject(new Error(r.error?.message || 'Cloudinary: muat naik gagal'));
                };
                xhr.onerror = () => reject(new Error('Rangkaian terputus'));
                xhr.onabort = () => reject(new Error('Dibatalkan'));
                ctl.abort = () => xhr.abort();
                xhr.send(fd);
            });
        }
    },
    url: {
        label: '🔗 Pautan',
        enabled: () => true,
        needsFile: false,
        async upload(url) {
            const hint = urlProblem(url);
            if (hint) throw new Error(hint);
            return { url, cleanup: async () => {} };
        }
    }
};

(async function initUploadPage() {
    await loadSessionUser();
    if (!requireAccount()) return;
    const C = UPLOAD_CONFIG, root = document.getElementById('uploadRoot');
    const $ = (id) => document.getElementById(id);
    let provider = PROVIDERS[C.defaultProvider]?.enabled() ? C.defaultProvider : 'supabase';
    let file = null, busy = false;
    const ctl = { abort: null };

    root.innerHTML = `
    <div class="modal-content">
        <div class="modal-header"><h3>🎥 Muat Naik Video</h3><a href="index.html" class="close-modal" style="text-decoration:none">✕</a></div>
        <div class="seg" id="seg">${Object.entries(PROVIDERS).map(([k, p]) =>
            `<button type="button" data-p="${k}" ${p.enabled() ? '' : 'disabled'}>${p.label}${p.enabled() ? '' : '<br><small>belum aktif</small>'}</button>`).join('')}</div>
        <div id="fileBox">
            <label class="drop" id="drop">
                <input type="file" id="file" accept="${C.allowed.join(',')}" hidden>
                <div id="dropText">📁 Tekan atau seret video ke sini<br><small>MP4 / WebM / MOV · maks ${C.maxMB}MB · maks ${C.maxSeconds} saat</small></div>
            </label>
            <video id="prev" class="prev" controls muted playsinline style="display:none"></video>
        </div>
        <div id="urlBox" style="display:none">
            <input class="modal-input" id="urlIn" placeholder="Tampal pautan YouTube / TikTok / Facebook / Instagram / .mp4">
            <p id="urlHint" style="color:var(--muted);font-size:.78rem;margin:-6px 0 12px;">Video mesti awam. Hanya pautan disimpan, video kekal di platform asal dan dimainkan melalui pemain rasmi mereka.</p>
        </div>
        <textarea class="modal-input" id="cap" rows="3" maxlength="500" placeholder="Kapsyen dan #hashtag"></textarea>
        <div class="counter" id="cnt">0/500</div>
        <div id="prog" style="display:none">
            <div class="upload-progress"><div class="upload-progress-bar" id="bar"></div></div>
            <div class="prog-row"><span id="pct">0%</span><button type="button" class="link-btn" id="cancel">Batal</button></div>
        </div>
        <p class="auth-msg" id="err"></p>
        <button class="btn-primary" id="go">Terbitkan Video</button>
    </div>`;

    const setErr = (m) => { $('err').textContent = m || ''; };
    const setProvider = (p) => {
        provider = p;
        document.querySelectorAll('#seg [data-p]').forEach(b => b.classList.toggle('active', b.dataset.p === p));
        const needsFile = PROVIDERS[p].needsFile;
        $('fileBox').style.display = needsFile ? 'block' : 'none';
        $('urlBox').style.display = needsFile ? 'none' : 'block';
        setErr('');
    };
    document.querySelectorAll('#seg [data-p]').forEach(b => b.onclick = () => { if (!busy) setProvider(b.dataset.p); });
    setProvider(provider);
    $('urlIn').addEventListener('input', () => {
        const v = $('urlIn').value.trim(), em = parseEmbed(v), h = $('urlHint');
        if (!v) { h.style.color = 'var(--muted)'; h.textContent = 'Video mesti awam. Hanya pautan disimpan, video kekal di platform asal.'; return; }
        const p = urlProblem(v);
        h.style.color = p ? 'var(--danger)' : '#16a34a';
        h.textContent = p ? p : (em ? '✅ Dikesan: ' + em.label : '✅ Pautan fail video');
    });

    $('cap').addEventListener('input', () => { $('cnt').textContent = $('cap').value.length + '/500'; });

    function pickFile(f) {
        setErr(''); file = null; $('prev').style.display = 'none';
        if (!f) return;
        if (!C.allowed.includes(f.type)) return setErr('Jenis fail tidak disokong. Guna MP4, WebM atau MOV.');
        if (f.size > C.maxMB * 1024 * 1024) return setErr(`Fail terlalu besar (${(f.size / 1048576).toFixed(1)}MB). Maks ${C.maxMB}MB.`);
        const url = URL.createObjectURL(f), prev = $('prev');
        prev.onloadedmetadata = () => {
            if (prev.duration > C.maxSeconds) { setErr(`Video terlalu panjang (${Math.round(prev.duration)} saat). Maks ${C.maxSeconds} saat.`); file = null; prev.style.display = 'none'; return; }
            file = f; prev.style.display = 'block';
            $('dropText').innerHTML = `✅ ${escapeHtml(f.name)}<br><small>${(f.size / 1048576).toFixed(1)}MB · ${Math.round(prev.duration)} saat · tekan untuk tukar</small>`;
        };
        prev.onerror = () => { file = f; prev.style.display = 'none'; setErr('Pratonton tidak tersedia, tetapi fail boleh dimuat naik.'); };
        prev.src = url;
    }
    $('file').addEventListener('change', (e) => pickFile(e.target.files[0]));
    const drop = $('drop');
    ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', (e) => pickFile(e.dataTransfer.files[0]));

    $('cancel').onclick = () => ctl.abort?.();

    $('go').onclick = async () => {
        if (busy) return;
        setErr('');
        const p = PROVIDERS[provider];
        const input = p.needsFile ? file : $('urlIn').value.trim();
        if (!input) return setErr(p.needsFile ? 'Sila pilih fail video.' : 'Masukkan URL video.');
        busy = true; $('go').disabled = true; $('prog').style.display = 'block'; $('bar').style.width = '0%'; $('pct').textContent = '0%';
        let res = null;
        try {
            res = await p.upload(input, { ctl, onProgress: (r) => { const v = Math.round(r * 100); $('bar').style.width = v + '%'; $('pct').textContent = v + '%'; } });
            $('bar').style.width = '100%'; $('pct').textContent = 'Menyimpan...';
            const caption = $('cap').value.trim() || 'Tiada kapsyen';
            const { error } = await sb.from('videos').insert({
                description: caption, title: caption.substring(0, 100), video_url: res.url,
                user_id: state.currentUser.id,
                username: state.profile?.username || 'user_' + state.currentUser.id.slice(0, 6)
            });
            if (error) { await res.cleanup?.().catch(() => {}); throw error; }
            showToast('✅ Video diterbitkan!');
            setTimeout(() => { location.href = 'index.html'; }, 700);
        } catch (e) {
            if (e.message !== 'Dibatalkan') setErr('❌ ' + (e.message || 'Gagal'));
            busy = false; $('go').disabled = false; $('prog').style.display = 'none';
        }
    };
})();


document.getElementById('themeBtn')?.addEventListener('click', toggleTheme);
