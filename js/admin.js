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
