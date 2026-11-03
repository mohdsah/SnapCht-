async function initAuth() {
    try {
        const { data: { session } } = await sb.auth.getSession();

        if (session) {
            state.currentUser = session.user;
        } else {
            const { data, error } = await sb.auth.signInAnonymously();
            if (error) {
                console.error('Anon auth error:', error);
                showToast('❌ Gagal log masuk: ' + error.message, true);
                hideLoading();
                return;
            }
            state.currentUser = data.user;
        }

        await Promise.all([
            loadFollowing(),
            loadLikedVideos(),
            loadSavedVideos(),
            loadSuggestedAccounts(),
            loadVideos('foryou')
        ]);

        hideLoading();
        initEventListeners();
        initPullToRefresh();
    } catch (err) {
        console.error('Init error:', err);
        showToast('❌ Ralat memuatkan app', true);
        hideLoading();
    }
}
