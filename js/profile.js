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
    closeModal('profileModal');
    const username = 'user_' + (state.currentUser?.id?.slice(0, 6) || 'xxxxx');

    // Statistik sebenar daripada DB (bukan hanya feed semasa)
    const { data: mine } = await sb.from('videos').select('likes').eq('user_id', state.currentUser.id);
    const videoCount = mine?.length || 0;
    const totalLikes = (mine || []).reduce((s, v) => s + (v.likes || 0), 0);

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'profileModal';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h3>👤 Profil Saya</h3>
                <button class="close-modal" onclick="closeModal('profileModal')">✕</button>
            </div>
            <div style="text-align:center;">
                <div style="font-size:64px;">👤</div>
                <p><strong>@${escapeHtml(username)}</strong></p>
                <p style="font-size:0.7rem;color:#ff9a3c;margin-top:6px;">Akaun tetamu: data hilang jika data pelayar dipadam</p>
                <div style="display:flex;justify-content:space-around;margin:20px 0;padding:16px;background:#0a0a0a;border-radius:16px;">
                    <div><div style="font-size:24px;font-weight:bold;">${videoCount}</div><div style="color:#777;">Video</div></div>
                    <div><div style="font-size:24px;font-weight:bold;">${formatNumber(totalLikes)}</div><div style="color:#777;">Likes</div></div>
                    <div><div style="font-size:24px;font-weight:bold;">${state.savedVideosSet.size}</div><div style="color:#777;">Disimpan</div></div>
                </div>
                <button class="btn-primary" onclick="closeModal('profileModal'); loadMyVideos();">📹 Video Saya</button>
                <button class="btn-secondary" onclick="closeModal('profileModal'); loadSavedVideosList();" style="margin-top:12px;">📌 Video Disimpan</button>
            </div>
        </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) closeModal('profileModal'); });
}

async function reportVideo(videoId, reason) {
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
    try {
        await navigator.clipboard.writeText(url);
        showToast('🔗 Pautan disalin!');
    } catch {
        showToast('🔗 ' + url);
    }
}
