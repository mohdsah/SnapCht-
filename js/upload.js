function showUploadModal() {
    closeModal('uploadModal');

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'uploadModal';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h3>🎥 Muat Naik Video</h3>
                <button class="close-modal" onclick="closeModal('uploadModal')">✕</button>
            </div>
            <div class="tab-switch">
                <button class="active" data-upload-tab="url">🔗 URL Video</button>
                <button data-upload-tab="file">📁 Fail Video</button>
            </div>
            <div id="tab-url">
                <input type="text" id="videoUrlInput" placeholder="https://.../video.mp4" class="modal-input">
                <p style="color:#ff9a3c;font-size:0.75rem;margin-bottom:12px;">URL mesti berakhir dengan .mp4 / .webm / .mov</p>
            </div>
            <div id="tab-file" style="display:none;">
                <input type="file" id="videoFileInput" accept="video/mp4,video/webm,video/quicktime" class="modal-input">
                <p style="color:#ff9a3c;font-size:0.75rem;margin-bottom:12px;">Maks 50MB. Disimpan ke Supabase Storage.</p>
            </div>
            <input type="text" id="videoCaption" placeholder="Kapsyen (contoh: #fyp #viral)" class="modal-input" maxlength="500">
            <div id="uploadProgressContainer" style="display:none;">
                <div class="upload-progress"><div class="upload-progress-bar" id="uploadProgressBar"></div></div>
                <p id="uploadStatus" style="font-size:0.8rem;margin-top:8px;text-align:center;">Memproses...</p>
            </div>
            <button class="btn-primary" id="uploadBtn">Terbitkan Video</button>
            <p id="uploadErrorMsg" style="color:#dc2626;font-size:0.75rem;margin-top:8px;display:none;"></p>
        </div>`;
    document.body.appendChild(modal);

    let uploadMode = 'url';
    modal.querySelectorAll('[data-upload-tab]').forEach(btn => {
        btn.addEventListener('click', () => {
            uploadMode = btn.getAttribute('data-upload-tab');
            modal.querySelectorAll('[data-upload-tab]').forEach(b => b.classList.toggle('active', b === btn));
            document.getElementById('tab-url').style.display = uploadMode === 'url' ? 'block' : 'none';
            document.getElementById('tab-file').style.display = uploadMode === 'file' ? 'block' : 'none';
        });
    });

    const uploadBtn = document.getElementById('uploadBtn');
    const progressContainer = document.getElementById('uploadProgressContainer');
    const progressBar = document.getElementById('uploadProgressBar');
    const uploadStatus = document.getElementById('uploadStatus');
    const errorMsg = document.getElementById('uploadErrorMsg');

    uploadBtn.onclick = async () => {
        errorMsg.style.display = 'none';
        const caption = document.getElementById('videoCaption').value.trim() || 'Tiada kapsyen';
        const username = 'user_' + state.currentUser.id.slice(0, 6);

        uploadBtn.disabled = true;
        progressContainer.style.display = 'block';
        progressBar.style.width = '20%';
        uploadStatus.innerText = 'Memproses...';

        try {
            let videoUrl = '';
            if (uploadMode === 'url') {
                videoUrl = document.getElementById('videoUrlInput').value.trim();
                if (!isValidVideoUrl(videoUrl)) throw new Error('URL tidak sah. Pastikan berakhir .mp4/.webm/.mov');
                progressBar.style.width = '70%';
            } else {
                const file = document.getElementById('videoFileInput').files[0];
                if (!file) throw new Error('Sila pilih fail video');
                if (file.size > 50 * 1024 * 1024) throw new Error('Saiz melebihi 50MB');

                uploadStatus.innerText = 'Memuat naik...';
                const ext = (file.name.split('.').pop() || 'mp4').toLowerCase().replace(/[^a-z0-9]/g, '');
                const path = `${state.currentUser.id}/${Date.now()}.${ext}`;

                const { error: upErr } = await sb.storage.from('videos')
                    .upload(path, file, { cacheControl: '3600', upsert: false, contentType: file.type });
                if (upErr) throw upErr;

                const { data: { publicUrl } } = sb.storage.from('videos').getPublicUrl(path);
                videoUrl = publicUrl;
                progressBar.style.width = '80%';
            }

            uploadStatus.innerText = 'Menyimpan...';
            const { error: insErr } = await sb.from('videos').insert({
                description: caption,
                title: caption.substring(0, 100),
                video_url: videoUrl,
                user_id: state.currentUser.id,
                username
            });
            if (insErr) throw insErr;

            progressBar.style.width = '100%';
            uploadStatus.innerText = 'Selesai!';
            showToast('✅ Video diterbitkan!');
            setTimeout(() => { closeModal('uploadModal'); loadVideos('foryou'); }, 800);
        } catch (err) {
            console.error(err);
            errorMsg.innerText = '❌ ' + (err.message || 'Gagal');
            errorMsg.style.display = 'block';
            uploadBtn.disabled = false;
            progressContainer.style.display = 'none';
        }
    };
}
