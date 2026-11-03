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

function showAuthScreen(mode = 'login') {
    document.getElementById('authScreen')?.remove();
    const hasSession = !!state.currentUser;
    const titles = { login: 'Log Masuk', register: 'Daftar Akaun', forgot: 'Lupa Kata Laluan' };
    const btnText = { login: 'Log Masuk', register: 'Daftar', forgot: 'Hantar Pautan Reset' };
    const el = document.createElement('div');
    el.className = 'auth-screen';
    el.id = 'authScreen';
    el.innerHTML = `
        <div class="auth-card">
            <div class="brand-logo" style="font-size:2rem;">Snap<span>Cht</span></div>
            <h3 style="margin:14px 0 18px;">${titles[mode]}</h3>
            <form id="authForm" novalidate>
                ${mode === 'register' ? '<input class="modal-input" id="authUsername" placeholder="Nama pengguna (3-20: a-z, 0-9, _)" maxlength="20" autocomplete="username">' : ''}
                <input class="modal-input" id="authEmail" type="email" placeholder="Email" autocomplete="email">
                ${mode !== 'forgot' ? `<input class="modal-input" id="authPass" type="password" placeholder="Kata laluan (min 8 aksara)" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}">` : ''}
                ${mode === 'register' ? '<input class="modal-input" id="authPass2" type="password" placeholder="Sahkan kata laluan" autocomplete="new-password">' : ''}
                <button class="btn-primary" id="authSubmit" type="submit">${btnText[mode]}</button>
            </form>
            <p id="authMsg" class="auth-msg"></p>
            <div class="auth-links">
                ${mode === 'login' ? '<a data-go="forgot">Lupa kata laluan?</a><a data-go="register">Belum ada akaun? Daftar</a>' : ''}
                ${mode !== 'login' ? '<a data-go="login">← Kembali ke Log Masuk</a>' : ''}
                <a data-close="1" style="color:var(--muted);">✕ Tutup (terus menonton)</a>
            </div>
        </div>`;
    document.body.appendChild(el);

    el.querySelectorAll('[data-go]').forEach(a => a.onclick = () => showAuthScreen(a.getAttribute('data-go')));
    el.querySelector('[data-close]')?.addEventListener('click', () => el.remove());
    el.querySelector('[data-guest]')?.addEventListener('click', async () => {
        const { error } = await sb.auth.signInAnonymously();
        if (error) authMsg(authErr(error)); else location.reload();
    });
    document.getElementById('authForm').addEventListener('submit', (e) => {
        e.preventDefault();
        submitAuth(mode);
    });
}

async function submitAuth(mode) {
    const btn = document.getElementById('authSubmit');
    const email = document.getElementById('authEmail').value.trim();
    const pass = document.getElementById('authPass')?.value || '';
    if (!/^\S+@\S+\.\S+$/.test(email)) return authMsg('Masukkan email yang sah');
    btn.disabled = true;
    authMsg('');
    try {
        if (mode === 'login') {
            if (!pass) return authMsg('Masukkan kata laluan');
            const { error } = await sb.auth.signInWithPassword({ email, password: pass });
            if (error) return authMsg(authErr(error));
            location.reload();
        } else if (mode === 'register') {
            const username = document.getElementById('authUsername').value.trim().toLowerCase();
            if (!/^[a-z0-9_]{3,20}$/.test(username)) return authMsg('Nama pengguna: 3-20 aksara (a-z, 0-9, _)');
            if (pass.length < 8) return authMsg('Kata laluan minimum 8 aksara');
            if (pass !== document.getElementById('authPass2').value) return authMsg('Kata laluan tidak sepadan');
            const { data: taken } = await sb.from('profiles').select('id').eq('username', username).maybeSingle();
            if (taken) return authMsg('Nama pengguna sudah digunakan');
            if (state.currentUser?.is_anonymous) await sb.auth.signOut();
            const { data, error } = await sb.auth.signUp({
                email, password: pass, options: { data: { username } }
            });
            if (error) return authMsg(authErr(error));
            if (data.session) location.reload();
            else authMsg('✅ Berjaya! Semak email anda untuk pengesahan, kemudian log masuk.', true);
        } else {
            const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
            if (error) return authMsg(authErr(error));
            authMsg('✅ Jika email itu berdaftar, pautan reset telah dihantar.', true);
        }
    } finally {
        btn.disabled = false;
    }
}

function showResetPassword() {
    document.getElementById('authScreen')?.remove();
    const el = document.createElement('div');
    el.className = 'auth-screen';
    el.id = 'authScreen';
    el.innerHTML = `
        <div class="auth-card">
            <h3 style="margin-bottom:18px;">🔑 Kata Laluan Baharu</h3>
            <form id="resetForm" novalidate>
                <input class="modal-input" id="newPass" type="password" placeholder="Kata laluan baharu (min 8)" autocomplete="new-password">
                <input class="modal-input" id="newPass2" type="password" placeholder="Sahkan kata laluan" autocomplete="new-password">
                <button class="btn-primary" id="resetBtn" type="submit">Simpan</button>
            </form>
            <p id="authMsg" class="auth-msg"></p>
        </div>`;
    document.body.appendChild(el);
    document.getElementById('resetForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const p1 = document.getElementById('newPass').value;
        if (p1.length < 8) return authMsg('Minimum 8 aksara');
        if (p1 !== document.getElementById('newPass2').value) return authMsg('Kata laluan tidak sepadan');
        const { error } = await sb.auth.updateUser({ password: p1 });
        if (error) return authMsg(authErr(error));
        history.replaceState(null, '', window.location.pathname);
        authMsg('✅ Kata laluan dikemas kini', true);
        setTimeout(() => el.remove(), 1200);
    });
}

async function loadProfile() {
    const u = state.currentUser;
    const { data } = await sb.from('profiles').select('username, role, banned, display_name, bio, location, avatar_url').eq('id', u.id).maybeSingle();
    state.profile = data || { username: 'user_' + u.id.slice(0, 6), role: 'user', banned: false };
}

function applyRoleUI() {
    const u = state.currentUser, real = u && !u.is_anonymous, p = state.profile;
    const m = document.getElementById('adminMenuItem');
    if (m) m.style.display = p?.role === 'admin' ? 'flex' : 'none';
    const a = document.getElementById('accountBtn');
    if (a) a.innerHTML = real ? avatarHtml(p) : '🔑';
    const h = document.getElementById('drawerUser');
    if (h) h.innerHTML = real
        ? `${avatarHtml(p)}<div><b>${escapeHtml(displayName(p))}</b><br><small style="color:var(--muted)">@${escapeHtml(p?.username || '')}</small></div>`
        : '<div><b>Selamat datang 👋</b><br><small style="color:var(--muted)">Daftar untuk muat naik &amp; komen</small></div>';
    const d = document.getElementById('drawerAuth');
    if (d) d.innerHTML = real ? '<span class="menu-icon">🚪</span> Log Keluar' : '<span class="menu-icon">🔑</span> Log Masuk / Daftar';
}

async function logout() {
    await sb.auth.signOut();
    location.reload();
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

async function startApp(user) {
    state.currentUser = user;
    if (user) await loadProfile();
    if (state.profile?.banned) showToast('⛔ Akaun anda disekat', true);
    await Promise.all([
        loadFollowing(), loadLikedVideos(), loadSavedVideos(),
        loadSuggestedAccounts(), loadVideos('foryou')
    ]);
    hideLoading();
    initEventListeners();
    initPullToRefresh();
    applyRoleUI();
    handleSharedVideo();
}

async function initAuth() {
    try {
        // Pautan reset kata laluan daripada email
        sb.auth.onAuthStateChange((event) => {
            if (event === 'PASSWORD_RECOVERY') showResetPassword();
        });
        const { data: { session } } = await sb.auth.getSession();
        if (!session) { await startApp(null); return; }
        await startApp(session.user);
    } catch (err) {
        console.error('Init error:', err);
        showToast('❌ Ralat memuatkan app', true);
        hideLoading();
    }
}
