function initPullToRefresh() {
    const ptr = document.getElementById('pullToRefresh');
    feedContainer.addEventListener('touchstart', (e) => {
        state.touchStart = feedContainer.scrollTop === 0 ? e.touches[0].clientY : 0;
    }, { passive: true });
    feedContainer.addEventListener('touchmove', (e) => {
        if (feedContainer.scrollTop === 0 && state.touchStart &&
            e.touches[0].clientY - state.touchStart > 80) ptr?.classList.add('active');
    }, { passive: true });
    feedContainer.addEventListener('touchend', () => {
        if (ptr?.classList.contains('active')) {
            ptr.classList.remove('active');
            loadVideos(state.currentFeedType);
            showToast('🔄 Feed direfresh');
        }
        state.touchStart = 0;
    });
}

function updateActiveNavUI(type) {
    document.querySelectorAll('.top-tab').forEach(t =>
        t.classList.toggle('active', t.getAttribute('data-tab') === type));
    document.querySelectorAll('.menu-item').forEach(i => {
        const nav = i.getAttribute('data-nav');
        i.classList.toggle('active', nav === type || (type === 'foryou' && nav === 'home'));
    });
    document.querySelectorAll('[data-mnav]').forEach(n => {
        const nav = n.getAttribute('data-mnav');
        n.classList.toggle('active', nav === type || (type === 'foryou' && nav === 'home'));
    });
}

function initEventListeners() {
    feedContainer.addEventListener('click', async (e) => {
        const tag = e.target.closest('[data-hashtag]');
        if (tag) { e.stopPropagation(); window.searchHashtag(tag.getAttribute('data-hashtag')); return; }

        if (e.target.classList.contains('main-video-player')) {
            if (e.target.paused) e.target.play().catch(() => {});
            else e.target.pause();
            return;
        }
        const followBtn = e.target.closest('.follow-btn-small');
        if (followBtn) { await toggleFollow(followBtn.getAttribute('data-user-id'), followBtn); return; }

        const likeBtn = e.target.closest('.like-btn');
        if (likeBtn) { await toggleLikeVideo(likeBtn.getAttribute('data-id'), likeBtn); return; }

        const saveBtn = e.target.closest('.save-btn');
        if (saveBtn) { await toggleSaveVideo(saveBtn.getAttribute('data-id'), saveBtn); return; }

        const commentBtn = e.target.closest('[data-action="comment"]');
        if (commentBtn) { openCommentModal(commentBtn.getAttribute('data-id')); return; }

        const shareBtn = e.target.closest('[data-action="share"]');
        if (shareBtn) { shareVideoLink(shareBtn.getAttribute('data-id')); return; }

        const reportBtn = e.target.closest('[data-action="report"]');
        if (reportBtn) { showReportModal(reportBtn.getAttribute('data-id')); return; }

        const deleteBtn = e.target.closest('[data-action="delete"]');
        if (deleteBtn) { await deleteVideo(deleteBtn.getAttribute('data-id')); return; }

        if (e.target.closest('[data-action="profile"]') || e.target.closest('.username')) {
            showToast('✨ Profil kreator');
        }
    });

    // Double-tap / double-click: HANYA suka (tidak pernah nyahsuka) supaya tak bertindih
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

    document.getElementById('themeBtn')?.addEventListener('click', toggleTheme);
    document.getElementById('sidebarThemeToggle')?.addEventListener('click', toggleTheme);
    applyThemeUI();

    document.querySelectorAll('.top-tab').forEach(tab => {
        tab.addEventListener('click', () => loadVideos(tab.getAttribute('data-tab')));
    });

    document.querySelectorAll('.menu-item').forEach(item => {
        item.addEventListener('click', () => {
            const nav = item.getAttribute('data-nav');
            if (nav === 'myvideos') loadMyVideos();
            else if (nav === 'trending') loadVideos('trending');
            else if (nav === 'saved') loadSavedVideosList();
            else if (nav === 'chat') openChatModal();
            else loadVideos('foryou');
        });
    });

    document.querySelectorAll('[data-mnav]').forEach(nav => {
        nav.addEventListener('click', () => {
            const a = nav.getAttribute('data-mnav');
            if (a === 'create') showUploadModal();
            else if (a === 'profile') showProfile();
            else if (a === 'trending') loadVideos('trending');
            else if (a === 'chat') openChatModal();
            else loadVideos('foryou');
        });
    });

    document.querySelector('.brand-logo')?.addEventListener('click', (e) => {
        e.preventDefault();
        const si = document.getElementById('globalSearchInput');
        if (si) si.value = '';
        loadVideos('foryou');
    });

    const searchInput = document.getElementById('globalSearchInput');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            clearTimeout(state.searchTimeout);
            state.searchTimeout = setTimeout(() => loadVideos('foryou', e.target.value), 500);
        });
    }

    document.getElementById('notifBtn')?.addEventListener('click', () => showToast('🔔 Tiada notifikasi'));
}

initAuth();
