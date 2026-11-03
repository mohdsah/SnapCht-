function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/[&<>"']/g, m => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
}

function showToast(msg, isError = false) {
    document.querySelector('.toast-message')?.remove();
    const toast = document.createElement('div');
    toast.className = 'toast-message' + (isError ? ' error' : '');
    toast.innerText = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

function formatNumber(num) {
    const n = Number(num) || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(n);
}

function extractHashtags(text) {
    if (!text) return '';
    const hashtags = text.match(/#[\w\u0600-\u06FF]+/g);
    if (!hashtags || !hashtags.length) return '';
    return `<div class="hashtags">${hashtags.map(h =>
        `<span data-hashtag="${escapeHtml(h)}">${escapeHtml(h)}</span>`
    ).join(' ')}</div>`;
}

function hideLoading() {
    const el = document.getElementById('loadingScreen');
    if (el) el.style.display = 'none';
}

function isValidVideoUrl(url) {
    try {
        const u = new URL(url);
        return (u.protocol === 'https:' || u.protocol === 'http:') &&
               /\.(mp4|webm|ogg|mov)$/i.test(u.pathname);
    } catch { return false; }
}

function applyThemeUI() {
    const isLight = document.body.classList.contains('light-mode');
    const themeBtn = document.getElementById('themeBtn');
    if (themeBtn) themeBtn.innerText = isLight ? '☀️' : '🌙';
    const sidebarToggle = document.getElementById('sidebarThemeToggle');
    if (sidebarToggle) sidebarToggle.innerHTML = isLight
        ? '<span>🌙 Tukar ke Dark Mode</span>'
        : '<span>☀️ Tukar ke Light Mode</span>';
}

function toggleTheme() {
    document.body.classList.toggle('light-mode');
    try {
        localStorage.setItem('snapcht_theme',
            document.body.classList.contains('light-mode') ? 'light' : 'dark');
    } catch {}
    applyThemeUI();
}

function closeModal(modalId) {
    document.getElementById(modalId)?.remove();
}

window.searchHashtag = function (hashtag) {
    const searchInput = document.getElementById('globalSearchInput');
    if (searchInput) searchInput.value = hashtag;
    loadVideos('foryou', hashtag);
};
window.closeModal = closeModal;

// Tema awal (disegerakkan dengan ikon)
(function () {
    try {
        if (localStorage.getItem('snapcht_theme') === 'light') document.body.classList.add('light-mode');
    } catch {}
    applyThemeUI();
})();
