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

async function loadSuggestedAccounts() {
    if (!state.currentUser) return;
    const { data } = await sb.from('videos').select('username, user_id')
        .neq('user_id', state.currentUser.id).limit(20);

    const container = document.getElementById('suggestedAccounts');
    if (!container || !data) return;
    const unique = [...new Map(data.map(u => [u.user_id, u])).values()].slice(0, 5);
    container.innerHTML = unique.map(user => `
        <div class="account-item">
            <div class="avatar-box">👤</div>
            <div class="account-name">${escapeHtml(user.username)}</div>
            <button class="follow-btn-small" data-user-id="${user.user_id}">
                ${state.followingSet.has(user.user_id) ? 'Mengikuti' : 'Ikuti'}
            </button>
        </div>`).join('');

    container.querySelectorAll('.follow-btn-small').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await toggleFollow(btn.getAttribute('data-user-id'), btn);
        });
    });
}

async function showProfile() {
    if (!requireAccount()) return;
    closeModal('profileModal');
    const p = state.profile, uid = state.currentUser.id;
    const { data: mine } = await sb.from('videos').select('likes').eq('user_id', uid);
    const likes = (mine || []).reduce((s, v) => s + (v.likes || 0), 0);

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'profileModal';
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
    document.body.appendChild(modal);
    const $ = id => document.getElementById(id);
    modal.addEventListener('click', e => { if (e.target === modal) closeModal('profileModal'); });
    $('pfClose').onclick = () => closeModal('profileModal');
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
            closeModal('profileModal');
        } catch (e) {
            showToast('❌ ' + (e.message || 'Gagal menyimpan'), true);
            btn.disabled = false;
        }
    };
}

async function showUserProfile(userId) {
    if (!userId) return;
    if (userId === state.currentUser?.id) return showProfile();
    await cacheProfiles([userId]);
    const p = state.profiles[userId];
    if (!p) return showToast('Profil tidak dijumpai', true);
    closeModal('userModal');
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'userModal';
    modal.innerHTML = `
        <div class="modal-content" style="text-align:center;">
            <div class="modal-header"><span></span><button class="close-modal" id="umClose">✕</button></div>
            ${avatarHtml(p, 'lg')}
            <h3 style="margin-top:10px;">${escapeHtml(displayName(p))}</h3>
            <p style="color:var(--muted);font-size:.85rem;">@${escapeHtml(p.username)}</p>
            ${p.bio ? `<p style="margin-top:10px;">${escapeHtml(p.bio)}</p>` : ''}
            ${p.location ? `<p style="margin-top:8px;color:var(--muted);font-size:.85rem;">📍 ${escapeHtml(p.location)}</p>` : ''}
            <button class="btn-primary follow-btn-small" data-user-id="${userId}" style="margin-top:16px;padding:12px;">${state.followingSet.has(userId) ? 'Mengikuti' : 'Ikuti'}</button>
            <button class="btn-secondary" id="umVideos" style="margin-top:10px;">🎞️ Lihat video</button>
        </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) closeModal('userModal'); });
    document.getElementById('umClose').onclick = () => closeModal('userModal');
    document.getElementById('umVideos').onclick = () => { closeModal('userModal'); loadUserVideos(userId); };
    modal.querySelector('.follow-btn-small').onclick = (e) => toggleFollow(userId, e.currentTarget);
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
