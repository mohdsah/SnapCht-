function initPullToRefresh() {
    const ptr = document.getElementById('pullToRefresh');
    feedContainer.addEventListener('touchstart', (e) => {
        state.touchStart = feedContainer.scrollTop === 0 ? e.touches[0].clientY : 0;
    }, { passive: true });
    feedContainer.addEventListener('touchmove', (e) => {
        if (feedContainer.scrollTop === 0 && state.touchStart && e.touches[0].clientY - state.touchStart > 80) ptr?.classList.add('active');
    }, { passive: true });
    feedContainer.addEventListener('touchend', () => {
        if (ptr?.classList.contains('active')) { ptr.classList.remove('active'); loadVideos(state.currentFeedType === 'user' ? 'foryou' : state.currentFeedType); }
        state.touchStart = 0;
    });
}

function updateActiveNavUI(type) {
    document.querySelectorAll('.top-tab').forEach(t => t.classList.toggle('active', t.getAttribute('data-tab') === type));
    document.querySelectorAll('.menu-item[data-nav]').forEach(i => {
        const nav = i.getAttribute('data-nav');
        i.classList.toggle('active', nav === type || (type === 'foryou' && nav === 'home'));
    });
    document.querySelectorAll('.nav-item-box[data-mnav]').forEach(n => {
        const nav = n.getAttribute('data-mnav');
        n.classList.toggle('active', nav === type || (type === 'foryou' && nav === 'home'));
    });
}

function closeDrawer() {
    document.getElementById('drawer')?.classList.remove('open');
    document.getElementById('drawerOverlay')?.classList.remove('open');
}

function navigate(nav) {
    closeDrawer();
    if (['myvideos', 'saved', 'chat', 'following'].includes(nav) && !requireAccount()) return;
    switch (nav) {
        case 'myvideos': return loadMyVideos();
        case 'saved': return loadSavedVideosList();
        case 'chat': return openChatModal();
        case 'following': return loadVideos('following');
        case 'trending': return loadVideos('trending');
        case 'create': return showUploadModal();
        case 'profile': return showProfile();
        case 'admin': location.href = 'admin.html'; return;
        case 'theme': return toggleTheme();
        case 'auth': return (state.currentUser && !state.currentUser.is_anonymous) ? logout() : showAuthScreen('login');
        default: return loadVideos('foryou');
    }
}

function showMoreModal(videoId, canDelete) {
    closeModal('moreModal');
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'moreModal';
    modal.innerHTML = `<div class="modal-content" style="max-width:340px;">
        <div class="report-option" id="mmReport">🚩 Laporkan video</div>
        ${canDelete ? '<div class="report-option" id="mmDelete" style="color:var(--danger);">🗑️ Padam video</div>' : ''}
        <div class="report-option" id="mmCancel">Batal</div></div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) closeModal('moreModal'); });
    document.getElementById('mmCancel').onclick = () => closeModal('moreModal');
    document.getElementById('mmReport').onclick = () => { closeModal('moreModal'); if (requireAccount()) showReportModal(videoId); };
    document.getElementById('mmDelete')?.addEventListener('click', () => { closeModal('moreModal'); deleteVideo(videoId); });
}

function initEventListeners() {
    feedContainer.addEventListener('click', async (e) => {
        const tag = e.target.closest('[data-hashtag]');
        if (tag) return window.searchHashtag(tag.getAttribute('data-hashtag'));

        if (e.target.classList.contains('main-video-player')) {
            e.target.paused ? e.target.play().catch(() => {}) : e.target.pause();
            return;
        }
        const mute = e.target.closest('[data-action="mute"]');
        if (mute) {
            state.muted = !state.muted;
            document.querySelectorAll('.main-video-player').forEach(v => v.muted = state.muted);
            document.querySelectorAll('.mute-btn').forEach(b => b.textContent = state.muted ? '🔇' : '🔊');
            return;
        }
        const followBtn = e.target.closest('.follow-btn-small');
        if (followBtn) return toggleFollow(followBtn.getAttribute('data-user-id'), followBtn);
        const likeBtn = e.target.closest('.like-btn');
        if (likeBtn) return toggleLikeVideo(likeBtn.getAttribute('data-id'), likeBtn);
        const saveBtn = e.target.closest('.save-btn');
        if (saveBtn) return toggleSaveVideo(saveBtn.getAttribute('data-id'), saveBtn);
        const act = e.target.closest('[data-action]');
        if (!act) return;
        const id = act.getAttribute('data-id');
        switch (act.getAttribute('data-action')) {
            case 'comment': return openCommentModal(id);
            case 'share': return shareVideoLink(id);
            case 'more': return showMoreModal(id, act.getAttribute('data-can-delete') === 'true');
            case 'profile': return showUserProfile(act.getAttribute('data-user-id'));
        }
    });

    // Double-tap / double-click hanya "suka"
    const likeFromVideo = (videoEl) => {
        const likeBtn = videoEl.closest('.video-wrapper')?.querySelector('.like-btn');
        const id = likeBtn?.getAttribute('data-id');
        if (id && !state.likedVideosSet.has(id)) toggleLikeVideo(id, likeBtn);
    };
    let lastTap = 0;
    feedContainer.addEventListener('touchend', (e) => {
        if (!e.target.classList.contains('main-video-player')) return;
        const now = Date.now();
        if (now - lastTap < 300) likeFromVideo(e.target);
        lastTap = now;
    });
    feedContainer.addEventListener('dblclick', (e) => {
        if (e.target.classList.contains('main-video-player')) likeFromVideo(e.target);
    });

    document.getElementById('menuBtn')?.addEventListener('click', () => {
        document.getElementById('drawer').classList.add('open');
        document.getElementById('drawerOverlay').classList.add('open');
    });
    document.getElementById('drawerOverlay')?.addEventListener('click', closeDrawer);
    document.getElementById('themeBtn')?.addEventListener('click', toggleTheme);
    document.getElementById('accountBtn')?.addEventListener('click', () => navigate('profile'));
    applyThemeUI();

    document.querySelectorAll('.top-tab').forEach(tab => tab.addEventListener('click', () => {
        const t = tab.getAttribute('data-tab');
        navigate(t === 'foryou' ? 'home' : t);
    }));
    document.querySelectorAll('.menu-item[data-nav]').forEach(i => i.addEventListener('click', () => navigate(i.getAttribute('data-nav'))));
    document.querySelectorAll('[data-mnav]').forEach(n => n.addEventListener('click', () => navigate(n.getAttribute('data-mnav'))));

    document.querySelector('.brand-logo')?.addEventListener('click', (e) => {
        e.preventDefault();
        const si = document.getElementById('globalSearchInput'); if (si) si.value = '';
        loadVideos('foryou');
    });
    document.getElementById('globalSearchInput')?.addEventListener('input', (e) => {
        clearTimeout(state.searchTimeout);
        state.searchTimeout = setTimeout(() => loadVideos('foryou', e.target.value), 500);
    });
}

initAuth();
