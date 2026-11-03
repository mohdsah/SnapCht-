function sanitizeSearch(s) {
    // buang aksara yang merosakkan sintaks .or() PostgREST dan wildcard ilike
    return String(s || '').replace(/[,()%*_\\"]/g, ' ').replace(/\s+/g, ' ').trim();
}

async function loadVideos(type, searchQuery = '') {
    const seq = ++state.loadSeq;
    state.currentFeedType = type;
    updateActiveNavUI(type);

    let query = sb.from('videos').select('*');
    const q = sanitizeSearch(searchQuery);

    if (q) {
        query = query.or(`description.ilike.%${q}%,title.ilike.%${q}%`)
            .order('created_at', { ascending: false }).limit(100);
    } else if (type === 'trending') {
        query = query.order('views', { ascending: false }).limit(50);
    } else {
        query = query.order('created_at', { ascending: false }).limit(100);
    }

    const { data, error } = await query;
    if (seq !== state.loadSeq) return; // ada permintaan lebih baharu
    if (error) {
        console.error('Load videos error:', error);
        showToast('❌ Gagal memuatkan video', true);
        return;
    }
    state.allVideos = data || [];
    renderFeed();
}

async function loadLikedVideos() {
    if (!state.currentUser) return;
    const { data } = await sb.from('liked_videos').select('video_id').eq('user_id', state.currentUser.id);
    if (data) data.forEach(i => state.likedVideosSet.add(i.video_id));
}

async function loadSavedVideos() {
    if (!state.currentUser) return;
    const { data } = await sb.from('saved_videos').select('video_id').eq('user_id', state.currentUser.id);
    if (data) data.forEach(i => state.savedVideosSet.add(i.video_id));
}

async function loadSavedVideosList() {
    if (!state.currentUser) return;
    const seq = ++state.loadSeq;
    state.currentFeedType = 'saved';
    updateActiveNavUI('saved');

    const { data } = await sb.from('saved_videos').select('video_id').eq('user_id', state.currentUser.id);
    const ids = data?.map(i => i.video_id) || [];
    if (seq !== state.loadSeq) return;
    if (!ids.length) { state.allVideos = []; renderFeed(); return; }
    const { data: videos } = await sb.from('videos').select('*').in('id', ids);
    if (seq !== state.loadSeq) return;
    state.allVideos = videos || [];
    renderFeed();
}

async function loadMyVideos() {
    if (!state.currentUser) return;
    const seq = ++state.loadSeq;
    state.currentFeedType = 'myvideos';
    updateActiveNavUI('myvideos');
    const { data } = await sb.from('videos').select('*')
        .eq('user_id', state.currentUser.id).order('created_at', { ascending: false });
    if (seq !== state.loadSeq) return;
    state.allVideos = data || [];
    renderFeed();
}

async function toggleLikeVideo(videoId, btnElement) {
    const key = 'like:' + videoId;
    if (state.pending.has(key)) return;
    state.pending.add(key);
    try {
        const isLiked = state.likedVideosSet.has(videoId);
        const iconCircle = btnElement.querySelector('.circle-icon');
        const countSpan = btnElement.querySelector('.like-count');
        const statSpan = btnElement.closest('.video-card')?.querySelector('.stat-like-count');

        if (isLiked) {
            const { error } = await sb.from('liked_videos').delete()
                .eq('user_id', state.currentUser.id).eq('video_id', videoId);
            if (error) { showToast('❌ Gagal', true); return; }
            state.likedVideosSet.delete(videoId);
            iconCircle?.classList.remove('liked');
        } else {
            const { error } = await sb.from('liked_videos')
                .insert({ user_id: state.currentUser.id, video_id: videoId });
            if (error) { showToast('❌ Gagal', true); return; }
            state.likedVideosSet.add(videoId);
            iconCircle?.classList.add('liked');
        }

        const { data: v } = await sb.from('videos').select('likes').eq('id', videoId).single();
        const newCount = v?.likes ?? 0;
        if (countSpan) countSpan.innerText = formatNumber(newCount);
        if (statSpan) statSpan.innerText = formatNumber(newCount);
    } finally {
        state.pending.delete(key);
    }
}

async function toggleSaveVideo(videoId, btnElement) {
    const key = 'save:' + videoId;
    if (state.pending.has(key)) return;
    state.pending.add(key);
    try {
        const isSaved = state.savedVideosSet.has(videoId);
        if (isSaved) {
            const { error } = await sb.from('saved_videos').delete()
                .eq('user_id', state.currentUser.id).eq('video_id', videoId);
            if (error) { showToast('❌ Gagal', true); return; }
            state.savedVideosSet.delete(videoId);
            btnElement.querySelector('.circle-icon')?.classList.remove('saved');
            showToast('📌 Dikeluarkan');
        } else {
            const { error } = await sb.from('saved_videos')
                .insert({ user_id: state.currentUser.id, video_id: videoId });
            if (error) { showToast('❌ Gagal', true); return; }
            state.savedVideosSet.add(videoId);
            btnElement.querySelector('.circle-icon')?.classList.add('saved');
            showToast('📌 Disimpan');
        }
    } finally {
        state.pending.delete(key);
    }
}

// Kira view bila video benar-benar dimainkan >= 3 saat (guna timeupdate, tiada timer yang boleh terlepas)
function trackVideoView(videoId, videoElement) {
    if (!state.currentUser || state.videoViewTracked.has(videoId)) return;
    const handler = async () => {
        if (videoElement.currentTime < 3 || state.videoViewTracked.has(videoId)) return;
        state.videoViewTracked.add(videoId);
        videoElement.removeEventListener('timeupdate', handler);
        const { data, error } = await sb.rpc('fn_track_view', {
            p_video_id: videoId, p_user_id: state.currentUser.id
        });
        if (error) {
            state.videoViewTracked.delete(videoId);
            console.error('View error:', error);
            return;
        }
        if (typeof data === 'number') {
            const viewSpan = videoElement.closest('.video-wrapper')?.querySelector('.view-count');
            if (viewSpan) viewSpan.innerText = '👁️ ' + formatNumber(data);
        }
    };
    videoElement.addEventListener('timeupdate', handler);
}

async function deleteVideo(videoId) {
    if (!confirm('Padam video ini? Tidak boleh dibatalkan.')) return;
    const { error } = await sb.from('videos').delete()
        .eq('id', videoId).eq('user_id', state.currentUser.id);
    if (error) { showToast('❌ Gagal memadam', true); return; }
    showToast('🗑️ Video dipadam');
    await loadMyVideos();
}

function renderFeed() {
    if (state.currentObserver) state.currentObserver.disconnect();
    if (feedContainer) feedContainer.scrollTop = 0;

    if (!state.allVideos.length) {
        let msg = '📹 Tiada video. Klik + untuk muat naik!';
        if (state.currentFeedType === 'saved') msg = '📌 Tiada video disimpan.';
        if (state.currentFeedType === 'myvideos') msg = '📹 Anda belum ada video.';
        feedContainer.innerHTML = `<div class="empty-state">${msg}</div>`;
        return;
    }

    feedContainer.innerHTML = state.allVideos.map(video => {
        const isLiked = state.likedVideosSet.has(video.id);
        const isSaved = state.savedVideosSet.has(video.id);
        const isOwner = video.user_id === state.currentUser?.id;
        return `
        <div class="video-wrapper" data-id="${video.id}" data-user-id="${video.user_id}">
            <div class="video-card">
                <video class="main-video-player" src="${escapeHtml(video.video_url)}" loop muted playsinline preload="metadata"></video>
                <div class="video-progress"><div class="progress-fill"></div></div>
                <div class="interaction-bar">
                    <div class="interact-btn" data-action="profile" data-user-id="${video.user_id}">
                        <div class="circle-icon">👤</div>
                    </div>
                    <div class="interact-btn like-btn" data-id="${video.id}">
                        <div class="circle-icon ${isLiked ? 'liked' : ''}">❤️</div>
                        <span class="like-count">${formatNumber(video.likes)}</span>
                    </div>
                    <div class="interact-btn save-btn" data-id="${video.id}">
                        <div class="circle-icon ${isSaved ? 'saved' : ''}">📌</div>
                        <span>Simpan</span>
                    </div>
                    <div class="interact-btn" data-action="comment" data-id="${video.id}">
                        <div class="circle-icon">💬</div><span>Komen</span>
                    </div>
                    <div class="interact-btn" data-action="share" data-id="${video.id}">
                        <div class="circle-icon">🔗</div><span>Kongsi</span>
                    </div>
                    <div class="interact-btn" data-action="report" data-id="${video.id}">
                        <div class="circle-icon">🚩</div><span>Lapor</span>
                    </div>
                    ${isOwner ? `
                    <div class="interact-btn" data-action="delete" data-id="${video.id}">
                        <div class="circle-icon" style="background:#dc2626;">🗑️</div><span>Padam</span>
                    </div>` : ''}
                </div>
                <div class="video-details-box">
                    <div class="username" data-user-id="${video.user_id}">
                        @${escapeHtml(video.username)}
                        ${!isOwner ? `<button class="follow-btn-small" data-user-id="${video.user_id}">${state.followingSet.has(video.user_id) ? 'Mengikuti' : 'Ikuti'}</button>` : ''}
                    </div>
                    <p class="description">${escapeHtml(video.description || 'Tiada kapsyen')}</p>
                    ${extractHashtags(video.description)}
                    <div class="video-stats">
                        <span>❤️ <span class="stat-like-count">${formatNumber(video.likes)}</span></span>
                        <span class="view-count">👁️ ${formatNumber(video.views || 0)}</span>
                    </div>
                    <div class="music-track">🎵 ${escapeHtml(video.username)}</div>
                </div>
            </div>
        </div>`;
    }).join('');

    initVideoPlayers();
}

function initVideoPlayers() {
    const videos = document.querySelectorAll('.main-video-player');
    videos.forEach(video => {
        const wrapper = video.closest('.video-wrapper');
        const videoId = wrapper?.getAttribute('data-id');
        const progressFill = video.closest('.video-card')?.querySelector('.progress-fill');
        if (videoId) trackVideoView(videoId, video);

        video.ontimeupdate = () => {
            if (video.duration && progressFill)
                progressFill.style.width = (video.currentTime / video.duration) * 100 + '%';
        };
    });

    state.currentObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            const vid = entry.target;
            if (entry.isIntersecting) vid.play().catch(() => {});
            else vid.pause();
        });
    }, { root: feedContainer, threshold: 0.6 });

    videos.forEach(v => state.currentObserver.observe(v));
}
