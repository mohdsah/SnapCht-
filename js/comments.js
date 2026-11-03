async function openCommentModal(videoId) {
    closeModal('commentModal');
    const { data } = await sb.from('comments').select('*')
        .eq('video_id', videoId).order('created_at', { ascending: false }).limit(100);

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'commentModal';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h3>💬 Komen</h3>
                <button class="close-modal" onclick="closeModal('commentModal')">✕</button>
            </div>
            <div class="comment-list">
                ${data?.length ? data.map(c => `
                    <div class="comment-item">
                        <div class="comment-user">@${escapeHtml(c.username)}</div>
                        <div>${escapeHtml(c.comment_text)}</div>
                    </div>`).join('') : '<div class="empty-state">Tiada komen. Jadilah yang pertama!</div>'}
            </div>
            <input type="text" id="newComment" placeholder="Tulis komen..." class="modal-input" maxlength="500">
            <button class="btn-primary" id="submitComment">Hantar Komen</button>
        </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) closeModal('commentModal'); });

    const btn = document.getElementById('submitComment');
    btn.onclick = async () => {
        const now = Date.now();
        if (now - state.lastCommentTime < COOLDOWN_COMMENT_MS) {
            showToast('⏳ Tunggu sebentar sebelum komen lagi', true);
            return;
        }
        const text = document.getElementById('newComment').value.trim();
        if (!text) return;

        btn.disabled = true;
        const username = 'user_' + state.currentUser.id.slice(0, 6);
        const { error } = await sb.from('comments').insert({
            video_id: videoId,
            user_id: state.currentUser.id,
            username,
            comment_text: text.substring(0, 500)
        });
        if (error) { btn.disabled = false; showToast('❌ Gagal hantar komen', true); return; }

        state.lastCommentTime = now;
        closeModal('commentModal');
        showToast('💬 Komen dihantar!');
    };
}
