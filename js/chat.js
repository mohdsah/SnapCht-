async function openChatModal() {
    closeModal('chatModal');
    const { data: users } = await sb.from('videos')
        .select('username, user_id').neq('user_id', state.currentUser.id).limit(50);

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'chatModal';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h3>💬 Chat</h3>
                <button class="close-modal" id="closeChatBtn">✕</button>
            </div>
            <div id="chatUserList">
                ${users?.length ? [...new Map(users.map(u => [u.user_id, u])).values()].map(u => `
                    <div class="account-item" data-chat-user="${u.user_id}" data-username="${escapeHtml(u.username)}">
                        <div class="avatar-box">👤</div>
                        <div class="account-name">@${escapeHtml(u.username)}</div>
                    </div>`).join('') : '<div class="empty-state">Tiada pengguna lain</div>'}
            </div>
            <div id="chatConversation" style="display:none;"></div>
        </div>`;
    document.body.appendChild(modal);

    document.getElementById('closeChatBtn').onclick = () => {
        removeChatSubscription();
        state.activeChatUserId = null;
        closeModal('chatModal');
    };

    modal.querySelectorAll('[data-chat-user]').forEach(el => {
        el.addEventListener('click', () => {
            openChatConversation(el.getAttribute('data-chat-user'), el.getAttribute('data-username'));
        });
    });
}

async function openChatConversation(userId, username) {
    state.activeChatUserId = userId;
    document.getElementById('chatUserList').style.display = 'none';
    const convDiv = document.getElementById('chatConversation');
    convDiv.style.display = 'block';
    convDiv.innerHTML = `
        <div style="margin-bottom:12px;">
            <button onclick="backToChatList()" style="background:#333;border:none;padding:8px 16px;border-radius:20px;color:white;cursor:pointer;">← Kembali</button>
            <span style="margin-left:12px;font-weight:bold;">@${escapeHtml(username)}</span>
        </div>
        <div id="chatMessagesList" style="height:300px;overflow-y:auto;margin-bottom:12px;"></div>
        <div style="display:flex;gap:8px;">
            <input type="text" id="chatInput" placeholder="Mesej..." maxlength="1000"
                style="flex:1;padding:12px;background:#2a2a2a;border:none;border-radius:24px;color:white;outline:none;">
            <button id="sendChatBtn" style="background:#fe2c55;border:none;padding:12px 20px;border-radius:24px;color:white;cursor:pointer;">Hantar</button>
        </div>`;

    await loadChatMessages(userId);
    setupRealtimeChat(userId);

    const input = document.getElementById('chatInput');
    const sendBtn = document.getElementById('sendChatBtn');
    const send = async () => {
        const text = input.value.trim();
        if (!text || sendBtn.disabled) return;
        sendBtn.disabled = true;
        const { error } = await sb.from('messages').insert({
            from_user: state.currentUser.id, to_user: userId, message: text.substring(0, 1000)
        });
        sendBtn.disabled = false;
        if (error) { showToast('❌ Gagal hantar', true); return; }
        input.value = '';
        await loadChatMessages(userId);
    };
    sendBtn.onclick = send;
    input.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
}

window.backToChatList = function () {
    removeChatSubscription();
    state.activeChatUserId = null;
    document.getElementById('chatConversation').style.display = 'none';
    document.getElementById('chatUserList').style.display = 'block';
};

async function loadChatMessages(userId) {
    const me = state.currentUser.id;
    const { data } = await sb.from('messages').select('*')
        .or(`and(from_user.eq.${me},to_user.eq.${userId}),and(from_user.eq.${userId},to_user.eq.${me})`)
        .order('created_at', { ascending: true }).limit(200);

    const container = document.getElementById('chatMessagesList');
    if (!container) return;
    container.innerHTML = data?.length ? data.map(msg => `
        <div style="text-align:${msg.from_user === me ? 'right' : 'left'};margin:8px 0;">
            <div style="display:inline-block;background:${msg.from_user === me ? '#fe2c55' : '#2a2a2a'};color:#fff;padding:8px 12px;border-radius:18px;max-width:80%;word-break:break-word;">
                ${escapeHtml(msg.message)}
            </div>
            <div style="font-size:0.6rem;opacity:0.6;margin-top:2px;">${new Date(msg.created_at).toLocaleTimeString()}</div>
        </div>`).join('') : '<div class="empty-state">Tiada mesej. Mulakan perbualan!</div>';
    container.scrollTop = container.scrollHeight;
}

function setupRealtimeChat(userId) {
    removeChatSubscription();
    const channelName = `chat_${state.currentUser.id}_${userId}_${Date.now()}`;
    state.activeChatSubscription = sb.channel(channelName)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
            const msg = payload.new;
            const me = state.currentUser.id;
            const involvesMe = msg.from_user === me || msg.to_user === me;
            const involvesThem = msg.from_user === userId || msg.to_user === userId;
            if (involvesMe && involvesThem && state.activeChatUserId === userId) loadChatMessages(userId);
        }).subscribe();
}

function removeChatSubscription() {
    if (state.activeChatSubscription) {
        sb.removeChannel(state.activeChatSubscription);
        state.activeChatSubscription = null;
    }
}
