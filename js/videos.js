function sanitizeSearch(s) {
    // buang aksara yang merosakkan sintaks .or() PostgREST dan wildcard ilike
    return String(s || '').replace(/[,()%*_\\"]/g, ' ').replace(/\s+/g, ' ').trim();
}

async function loadVideos(type, searchQuery = '') {
    if (type === 'following') return loadFollowingFeed();
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
    if (!requireAccount()) return;
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
            if (iconCircle) iconCircle.textContent = '🤍';
        } else {
            const { error } = await sb.from('liked_videos')
                .insert({ user_id: state.currentUser.id, video_id: videoId });
            if (error) { showToast('❌ Gagal', true); return; }
            state.likedVideosSet.add(videoId);
            iconCircle?.classList.add('liked');
            if (iconCircle) iconCircle.textContent = '❤️';
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
    if (!requireAccount()) return;
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
    const v = state.allVideos.find(x => x.id === videoId);
    let q = sb.from('videos').delete().eq('id', videoId);
    if (state.profile?.role !== 'admin') q = q.eq('user_id', state.currentUser.id);
    const { error } = await q;
    if (error) { showToast('❌ Gagal memadam', true); return; }
    if (v) removeVideoFile(v.video_url).catch(() => {});
    state.allVideos = state.allVideos.filter(x => x.id !== videoId);
    showToast('🗑️ Video dipadam');
    renderFeed();
}

async function renderFeed() {
    const mySeq = ++state.renderSeq;
    if (state.currentObserver) state.currentObserver.disconnect();
    if (feedContainer) feedContainer.scrollTop = 0;

    if (!state.allVideos.length) {
        const msgs = { saved: '🔖 Belum ada video disimpan.', myvideos: '🎞️ Anda belum ada video. Tekan + untuk muat naik!',
            following: '👥 Ikuti kreator untuk lihat video mereka di sini.', user: '🎞️ Kreator ini belum ada video.' };
        feedContainer.innerHTML = `<div class="empty-state">${msgs[state.currentFeedType] || '🎞️ Tiada video lagi. Jadilah yang pertama!'}</div>`;
        return;
    }
    await cacheProfiles(state.allVideos.map(v => v.user_id));
    if (mySeq !== state.renderSeq) return;

    const me = state.currentUser?.id;
    const isAdmin = state.profile?.role === 'admin';
    feedContainer.innerHTML = state.allVideos.map(video => {
        const p = state.profiles[video.user_id] || { username: video.username };
        const isLiked = state.likedVideosSet.has(video.id);
        const isSaved = state.savedVideosSet.has(video.id);
        const isOwner = video.user_id === me;
        return `
        <article class="vcard video-wrapper" data-id="${video.id}" data-user-id="${video.user_id}">
            <header class="vhead">
                <div class="vuser" data-action="profile" data-user-id="${video.user_id}">
                    ${avatarHtml(p)}
                    <div><b>${escapeHtml(displayName(p, video.username))}</b>
                    <small>@${escapeHtml(p.username)} · ${timeAgo(video.created_at)}</small></div>
                </div>
                ${!isOwner ? `<button class="follow-btn-small" data-user-id="${video.user_id}">${state.followingSet.has(video.user_id) ? 'Mengikuti' : 'Ikuti'}</button>` : ''}
            </header>
            <div class="vmedia">
                <video class="main-video-player" src="${escapeHtml(video.video_url)}" loop muted playsinline preload="metadata"></video>
                <button class="mute-btn" data-action="mute">${state.muted ? '🔇' : '🔊'}</button>
                <div class="video-progress"><div class="progress-fill"></div></div>
            </div>
            <div class="act-bar">
                <div class="interact-btn like-btn" data-id="${video.id}">
                    <span class="circle-icon ${isLiked ? 'liked' : ''}">${isLiked ? '❤️' : '🤍'}</span><span class="like-count">${formatNumber(video.likes)}</span></div>
                <div class="interact-btn" data-action="comment" data-id="${video.id}"><span class="circle-icon">💬</span><span>Komen</span></div>
                <div class="interact-btn" data-action="share" data-id="${video.id}"><span class="circle-icon">↗️</span><span>Kongsi</span></div>
                <div class="interact-btn save-btn" data-id="${video.id}"><span class="circle-icon ${isSaved ? 'saved' : ''}">🔖</span><span>Simpan</span></div>
                <div class="interact-btn" data-action="more" data-id="${video.id}" data-can-delete="${isOwner || isAdmin}"><span class="circle-icon">⋯</span></div>
            </div>
            <div class="vbody">
                <p class="description">${escapeHtml(video.description || '')}</p>
                ${extractHashtags(video.description)}
                <div class="video-stats"><span class="view-count">👁️ ${formatNumber(video.views || 0)} tontonan</span></div>
            </div>
        </article>`;
    }).join('');
    initVideoPlayers();
}

async function loadFollowingFeed() {
    const seq = ++state.loadSeq;
    state.currentFeedType = 'following';
    updateActiveNavUI('following');
    const ids = [...state.followingSet];
    if (!ids.length) { state.allVideos = []; renderFeed(); return; }
    const { data } = await sb.from('videos').select('*').in('user_id', ids)
        .order('created_at', { ascending: false }).limit(100);
    if (seq !== state.loadSeq) return;
    state.allVideos = data || [];
    renderFeed();
}

function initVideoPlayers() {
    const videos = document.querySelectorAll('.main-video-player');
    videos.forEach(video => {
        video.muted = state.muted;
        const id = video.closest('.video-wrapper')?.getAttribute('data-id');
        const fill = video.closest('.vmedia')?.querySelector('.progress-fill');
        if (id) trackVideoView(id, video);
        video.ontimeupdate = () => {
            if (video.duration && fill) fill.style.width = (video.currentTime / video.duration) * 100 + '%';
        };
    });
    state.currentObserver = new IntersectionObserver((entries) => {
        entries.forEach(en => en.isIntersecting ? en.target.play().catch(() => {}) : en.target.pause());
    }, { root: feedContainer, threshold: 0.6 });
    videos.forEach(v => state.currentObserver.observe(v));
}

async function loadUserVideos(userId) {
    if (!userId) return;
    const seq = ++state.loadSeq;
    state.currentFeedType = 'user';
    updateActiveNavUI('user');
    const { data } = await sb.from('videos').select('*')
        .eq('user_id', userId).order('created_at', { ascending: false });
    if (seq !== state.loadSeq) return;
    state.allVideos = data || [];
    renderFeed();
}
