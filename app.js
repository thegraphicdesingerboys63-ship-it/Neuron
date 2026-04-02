// ============================================================
// NEURON Chat App — app.js  (backend edition)
// All data comes from the Express/Turso API.
// Auth token lives in localStorage; user state in memory.
// ============================================================

// ─── Auth state ───────────────────────────────────────────────────────────────

let _currentUser = null;   // { username, role }  — refreshed from /api/me each poll
let _usersCache  = {};     // username → { role, banned, bannedUntil }
let _lastMsgs    = [];     // messages from last successful render (for lightbox / reply preview)
let _channel     = 'general';
let _replyToId   = null;
let _banTarget   = null;
let _reportTargetId = null;
let _muteTarget     = null;
let _slowmodeTimers = {};  // channel → last sent timestamp
let _activeDmId     = null;
let _dmMessages     = [];
let _friendsCache   = { friends: [], incoming: [], outgoing: [] };
let _conversations  = [];
let _sidebarTab     = 'members';

const getToken   = ()  => localStorage.getItem('nrn_jwt');
const setToken   = t   => localStorage.setItem('nrn_jwt', t);
const clearToken = ()  => localStorage.removeItem('nrn_jwt');

// ─── Favicon badge ────────────────────────────────────────────────────────────

let _unreadCount   = 0;
let _lastSeenMsgId = null;

function _drawFavicon(count) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 32;
  const ctx = canvas.getContext('2d');

  // Base: black circle with white "N"
  ctx.fillStyle = '#111111';
  ctx.beginPath();
  ctx.arc(16, 16, 16, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 19px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('N', 16, 17);

  // Red badge
  if (count > 0) {
    const label = count > 99 ? '99+' : String(count);
    const bx = 24, by = 8;
    const br = label.length > 2 ? 10 : label.length > 1 ? 8 : 7;
    ctx.fillStyle = '#ed4245';
    ctx.beginPath();
    ctx.arc(bx, by, br, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${label.length > 2 ? 7 : 9}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, bx, by);
  }

  document.getElementById('favicon').href = canvas.toDataURL('image/png');
}

function _clearBadge() {
  _unreadCount = 0;
  _lastSeenMsgId = null;
  _drawFavicon(0);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) _clearBadge();
});

// ─── Role helpers (own role only — server enforces everything) ────────────────

const amISupreme      = () => _currentUser?.role === 'supreme';
const amIOwnerOrAbove = () => ['owner','supreme'].includes(_currentUser?.role);
const amIAdminOrAbove = () => ['admin','owner','supreme'].includes(_currentUser?.role);
const amIAdmin        = () => _currentUser?.role === 'admin';

function canDeleteMsg(msg) {
  const cu = _currentUser?.username;
  const mr = _currentUser?.role;
  if (msg.author === cu) return true;
  if (mr === 'supreme')  return true;
  const ar = msg.authorRole;
  if (mr === 'owner') return ar !== 'owner' && ar !== 'supreme';
  if (mr === 'admin') return ar === 'user' || !ar;
  return false;
}

function canViewDetails(targetUsername) {
  if (targetUsername === _currentUser?.username) return false;
  const mr = _currentUser?.role;
  const tr = _usersCache[targetUsername]?.role || 'user';
  if (mr === 'supreme') return true;
  if (mr === 'owner')   return tr === 'user' || tr === 'admin';
  if (mr === 'admin')   return tr === 'user';
  return false;
}

// ─── Central API helper ───────────────────────────────────────────────────────

async function api(method, path, body) {
  const opts = {
    method,
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${getToken()}`,
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);

  try {
    const res = await fetch(path, opts);
    if (res.status === 401) {
      clearToken(); _currentUser = null;
      showPage('login'); return null;
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) return null;
    return data;
  } catch {
    return null; // network error — keep existing DOM, try again next poll
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function linkify(text) {
  return escapeHtml(text).replace(
    /(https?:\/\/[^\s<>"]+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer" class="inline-link">$1</a>'
  );
}

function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
}

function fmtDate(iso) {
  const d = new Date(iso), today = new Date();
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString())     return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { month:'long', day:'numeric', year:'numeric' });
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  if (getToken()) {
    const me = await api('GET', '/api/me');
    if (me) { _currentUser = me; showApp(); return; }
    clearToken();
  }
  showPage('login');
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function handleLogin() {
  const username = document.getElementById('username-input').value.trim();
  const password = document.getElementById('password-input').value;

  if (!/^[a-zA-Z0-9_]{3,15}$/.test(username)) {
    setLoginError('Username must be 3–15 characters (letters, numbers, underscores).');
    return;
  }
  if (!password) { setLoginError('Please enter a password.'); return; }

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { setLoginError(data.error || 'Login failed.'); return; }
    setToken(data.token);
    _currentUser = { username: data.username, role: data.role };
    showApp();
  } catch {
    setLoginError('Could not connect to server.');
  }
}

function handleLogout() {
  clearToken(); _currentUser = null;
  if (window._pollInterval) { clearInterval(window._pollInterval); window._pollInterval = null; }
  _clearBadge();
  if (_activeCallConvId) endCall();
  if (_voiceRoom) leaveVoice();
  if (_voiceWs) { _voiceWs.onclose = null; _voiceWs.close(); _voiceWs = null; }
  showPage('login');
}

function setLoginError(msg) {
  const el = document.getElementById('login-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

// ─── Pages ────────────────────────────────────────────────────────────────────

function showPage(name) {
  document.getElementById('login-page').classList.toggle('hidden', name !== 'login');
  document.getElementById('app-page').classList.toggle('hidden',   name !== 'app');
  if (name === 'login') {
    document.getElementById('login-error').classList.add('hidden');
    document.getElementById('username-input').value = '';
    document.getElementById('password-input').value = '';
  }
}

async function showApp() {
  // TOS check — must accept before entering
  const tosStatus = await api('GET', '/api/tos/status');
  if (tosStatus && !tosStatus.accepted) {
    showTosModal();
    return;
  }

  showPage('app');
  const cu = _currentUser;
  document.getElementById('header-username').textContent = cu.username;
  document.getElementById('header-owner-badge').classList.toggle('hidden', !amIOwnerOrAbove());
  document.getElementById('admin-panel-btn').classList.toggle('hidden',    !amIOwnerOrAbove());
  document.getElementById('chat-tabs').classList.toggle('hidden',          !amIAdminOrAbove());

  // Safe mode header badge
  const existingBadge = document.getElementById('safe-mode-indicator');
  if (cu.parentalControls) {
    if (!existingBadge) {
      const badge = document.createElement('span');
      badge.id = 'safe-mode-indicator';
      badge.className = 'safe-mode-badge header-safe-mode';
      badge.textContent = 'SAFE MODE';
      document.querySelector('.header-right')?.prepend(badge);
    }
  } else {
    existingBadge?.remove();
  }

  // Reset to general on login
  _channel = 'general';
  _activeDmId = null;
  document.getElementById('dm-header').classList.add('hidden');
  document.getElementById('messages-container').classList.remove('staff-channel');
  document.getElementById('message-input').placeholder = 'Send a message…';
  document.getElementById('message-input').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } };
  document.querySelector('.btn-send').onclick = sendMessage;
  document.querySelectorAll('.chat-tab-btn').forEach(b => b.classList.remove('active'));
  const gTab = document.getElementById('ctab-general');
  if (gTab) gTab.classList.add('active');

  _unreadCount = 0;
  _lastSeenMsgId = null;
  _drawFavicon(0);

  renderAnnouncements();
  renderMessages();
  renderUsers();
  renderSidebarFriends();
  renderSidebarDms();
  renderAllVoiceRooms();
  connectVoiceSocket();
  document.getElementById('message-input').focus();

  if (!window._pollInterval) {
    window._pollInterval = setInterval(async () => {
      const me = await api('GET', '/api/me');
      if (me) _currentUser = me;
      renderAnnouncements();
      if (_activeDmId) {
        pollDmMessages();
      } else {
        renderMessages();
      }
      renderUsers();
      renderSidebarDms();
    }, 2500);
  }
}

// ─── Channel switching ────────────────────────────────────────────────────────

function switchChatChannel(name, btn) {
  _channel = name;
  document.querySelectorAll('.chat-tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('messages-container').classList.toggle('staff-channel', name === 'staff');
  document.getElementById('message-input').placeholder = name === 'staff' ? 'Staff only…' : 'Send a message…';
  cancelReply();
  renderMessages();
}

// ─── Sending messages ─────────────────────────────────────────────────────────

async function sendMessage() {
  const input = document.getElementById('message-input');
  const text  = input.value.trim();
  if (!text) return;

  // Client-side slowmode check
  const smKey  = `slowmode_${_channel}`;
  const smLast = _slowmodeTimers[_channel] || 0;
  const smSecs = parseInt(localStorage.getItem(smKey) || '0');
  if (smSecs > 0) {
    const elapsed = (Date.now() - smLast) / 1000;
    if (elapsed < smSecs) {
      const wait = Math.ceil(smSecs - elapsed);
      alert(`Slowmode is on. Please wait ${wait} more second${wait !== 1 ? 's' : ''}.`);
      return;
    }
  }

  input.value = '';

  const isUrl = /^https?:\/\//i.test(text);
  await api('POST', '/api/messages', {
    content: text,
    type:    isUrl ? 'link' : 'text',
    linkUrl: isUrl ? text   : undefined,
    replyTo: _replyToId || undefined,
    channel: _channel,
  });

  _slowmodeTimers[_channel] = Date.now();
  cancelReply();
  await renderMessages();
  scrollBottom();
}

async function sendMediaMessage(type, mediaUrl, filename) {
  await api('POST', '/api/messages', {
    content:  filename || (type === 'image' ? 'Image' : 'Video'),
    type,
    mediaUrl,
    replyTo:  _replyToId || undefined,
    channel:  _channel,
  });
  cancelReply();
  await renderMessages();
  scrollBottom();
}

async function sendLink() {
  const url   = document.getElementById('link-url').value.trim();
  const label = document.getElementById('link-label').value.trim();
  if (!url) { alert('Please paste a URL.'); return; }

  await api('POST', '/api/messages', {
    content: label || url,
    type:    'link',
    linkUrl: url,
    replyTo: _replyToId || undefined,
    channel: _channel,
  });

  document.getElementById('link-url').value   = '';
  document.getElementById('link-label').value = '';
  toggleLinkInput();
  cancelReply();
  await renderMessages();
  scrollBottom();
}

function toggleLinkInput() {
  document.getElementById('link-input-row').classList.toggle('hidden');
}

// ─── File uploads ─────────────────────────────────────────────────────────────

async function _uploadToCloudinary(dataUri, type) {
  const res = await api('POST', '/api/upload', { data: dataUri, type });
  if (!res?.url) throw new Error('Upload failed.');
  return res.url;
}

function handleImageUpload(e) {
  const file = e.target.files[0]; if (!file) return;
  if (file.size > 10 * 1024 * 1024) { alert('Image must be under 10 MB.'); e.target.value = ''; return; }
  const r = new FileReader();
  r.onload = async ev => {
    try {
      const url = await _uploadToCloudinary(ev.target.result, 'image');
      sendMediaMessage('image', url, file.name);
    } catch { alert('Image upload failed. Please try again.'); }
  };
  r.readAsDataURL(file); e.target.value = '';
}

function handleVideoUpload(e) {
  const file = e.target.files[0]; if (!file) return;
  if (file.size > 100 * 1024 * 1024) { alert('Video must be under 100 MB.'); e.target.value = ''; return; }
  const r = new FileReader();
  r.onload = async ev => {
    try {
      const url = await _uploadToCloudinary(ev.target.result, 'video');
      sendMediaMessage('video', url, file.name);
    } catch { alert('Video upload failed. Please try again.'); }
  };
  r.readAsDataURL(file); e.target.value = '';
}

// ─── Reply ────────────────────────────────────────────────────────────────────

function replyTo(msgId) {
  const msg = _lastMsgs.find(m => m.id === msgId);
  if (!msg) return;
  _replyToId = msgId;
  document.getElementById('reply-preview').classList.remove('hidden');
  document.getElementById('reply-to-author').textContent = msg.author;
  document.getElementById('reply-to-text').textContent   =
    msg.content.length > 60 ? msg.content.slice(0, 60) + '…' : msg.content;
  document.getElementById('message-input').focus();
}

function cancelReply() {
  _replyToId = null;
  document.getElementById('reply-preview').classList.add('hidden');
}

// ─── React / delete / pin ─────────────────────────────────────────────────────

async function reactToMessage(msgId, type) {
  await api('POST', `/api/messages/${msgId}/react`, { type });
  await renderMessages();
}

async function deleteMessage(msgId) {
  await api('DELETE', `/api/messages/${msgId}`);
  await renderMessages();
}

async function pinMessage(msgId) {
  if (!amISupreme()) return;
  await api('POST', `/api/messages/${msgId}/pin`);
  await renderMessages();
}

// ─── Render messages ──────────────────────────────────────────────────────────

async function renderMessages() {
  const msgs = await api('GET', `/api/messages?channel=${_channel}`);
  if (msgs === null) return; // keep existing content on error

  _lastMsgs = msgs;

  // Unread badge: count messages that arrived while tab was hidden
  if (msgs.length > 0) {
    const newestId = msgs[msgs.length - 1].id;
    if (_lastSeenMsgId === null) {
      _lastSeenMsgId = newestId;
    } else if (newestId !== _lastSeenMsgId) {
      if (document.hidden) {
        const lastIdx = msgs.findIndex(m => m.id === _lastSeenMsgId);
        const newCount = lastIdx === -1 ? 1 : msgs.length - 1 - lastIdx;
        if (newCount > 0) {
          _unreadCount += newCount;
          _drawFavicon(_unreadCount);
        }
      }
      _lastSeenMsgId = newestId;
    }
  }

  const container = document.getElementById('messages-container');
  const cu        = _currentUser?.username;

  if (msgs.length === 0) {
    container.innerHTML = _channel === 'staff'
      ? '<div class="no-messages">Staff channel — admin eyes only.</div>'
      : '<div class="no-messages">No messages yet. Say hello! 👋</div>';
    return;
  }

  const atBottom = isAtBottom(container);
  let html = '', lastDate = '';

  for (const msg of msgs) {
    const dateStr = fmtDate(msg.timestamp);
    if (dateStr !== lastDate) {
      html += `<div class="date-divider"><span>${dateStr}</span></div>`;
      lastDate = dateStr;
    }

    const isOwn    = msg.author === cu;
    const canDel   = canDeleteMsg(msg);
    const canPin   = amISupreme() && _channel === 'general';
    const isPinned = !!msg.pinned && _channel === 'general';

    // Role tag (both 'owner' and 'supreme' surface as OWNER)
    const ar = msg.authorRole;
    const roleTag = (ar === 'owner' || ar === 'supreme')
      ? `<span class="msg-owner-tag">OWNER</span>`
      : ar === 'admin' ? `<span class="msg-admin-tag">Admin</span>` : '';

    // Clickable author name
    const clickable   = canViewDetails(msg.author) ? 'clickable' : '';
    const clickAction = canViewDetails(msg.author) ? `onclick="showAccountDetails('${msg.author}')"` : '';

    // Reply reference (look up in _lastMsgs)
    let replyHtml = '';
    if (msg.replyTo) {
      const ref  = msgs.find(m => m.id === msg.replyTo);
      if (ref) {
        const snip = ref.content.length > 55 ? ref.content.slice(0, 55) + '…' : ref.content;
        replyHtml = `<div class="reply-ref">
          <span class="reply-ref-author">${escapeHtml(ref.author)}</span>
          <span class="reply-ref-text">${escapeHtml(snip)}</span>
        </div>`;
      }
    }

    // Content
    let contentHtml = '';
    if (msg.type === 'image' && msg.mediaUrl) {
      contentHtml = `<img src="${msg.mediaUrl}" class="msg-image" alt="image" onclick="openLightbox('${msg.id}')">`;
    } else if (msg.type === 'video' && msg.mediaUrl) {
      contentHtml = `<video src="${msg.mediaUrl}" class="msg-video" controls></video>`;
    } else if (msg.type === 'link' && msg.linkUrl) {
      contentHtml = `<a href="${escapeHtml(msg.linkUrl)}" target="_blank" rel="noopener noreferrer" class="msg-link-card">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
        ${escapeHtml(msg.content)}
      </a>`;
    } else if (msg.type === 'system') {
      contentHtml = `<div class="system-msg-content">${escapeHtml(msg.content)}</div>`;
    } else {
      contentHtml = `<span>${linkify(msg.content)}</span>`;
    }

    const likes    = msg.reactions.like.length;
    const dislikes = msg.reactions.dislike.length;
    const liked    = msg.reactions.like.includes(cu);
    const disliked = msg.reactions.dislike.includes(cu);
    const canReport = msg.author !== cu && _channel === 'general';

    if (msg.type === 'system') {
      html += `<div class="system-message" id="msg-${msg.id}"><span class="system-icon">📢</span>${escapeHtml(msg.content)}</div>`;
      continue;
    }
    html += `
      <div class="message ${isOwn ? 'own' : 'other'} ${isPinned ? 'pinned' : ''}" id="msg-${msg.id}">
        <div class="message-bubble">
          <div class="message-meta">
            ${!isOwn ? `<span class="msg-author ${clickable}" ${clickAction}>${escapeHtml(msg.author)}${roleTag}</span>` : ''}
            <span class="msg-time">${fmtTime(msg.timestamp)}${isPinned ? '<span class="pin-dot" title="Pinned">📌</span>' : ''}</span>
            ${isOwn  ? `<span class="msg-author ${clickable}" ${clickAction}>${escapeHtml(msg.author)}${roleTag}</span>` : ''}
          </div>
          ${replyHtml}
          <div class="msg-content-wrap">${contentHtml}</div>
          <div class="message-actions">
            <button class="react-btn ${liked    ? 'liked'    : ''}" onclick="reactToMessage('${msg.id}','like')">👍${likes    > 0 ? ' '+likes    : ''}</button>
            <button class="react-btn ${disliked ? 'disliked' : ''}" onclick="reactToMessage('${msg.id}','dislike')">👎${dislikes > 0 ? ' '+dislikes : ''}</button>
            <button class="action-btn" onclick="replyTo('${msg.id}')">Reply</button>
            ${canReport ? `<button class="action-btn" onclick="openReportModal('${msg.id}')">Report</button>` : ''}
            ${canPin    ? `<button class="action-btn" onclick="pinMessage('${msg.id}')">${isPinned ? 'Unpin' : 'Pin'}</button>` : ''}
            ${canDel    ? `<button class="action-btn danger" onclick="deleteMessage('${msg.id}')">Delete</button>` : ''}
          </div>
        </div>
      </div>`;
  }

  container.innerHTML = html;
  if (atBottom) scrollBottom();
}

function isAtBottom(el) { return el.scrollHeight - el.scrollTop - el.clientHeight < 80; }
function scrollBottom()  { const c = document.getElementById('messages-container'); c.scrollTop = c.scrollHeight; }

function openLightbox(msgId) {
  const msg = _lastMsgs.find(m => m.id === msgId);
  if (!msg?.mediaUrl) return;
  const w = window.open();
  w.document.write(`<!DOCTYPE html><html><body style="margin:0;background:#000;display:flex;align-items:center;justify-content:center;min-height:100vh;">
    <img src="${msg.mediaUrl}" style="max-width:100vw;max-height:100vh;object-fit:contain;"></body></html>`);
}

// ─── Announcements ────────────────────────────────────────────────────────────

async function renderAnnouncements() {
  const anns = await api('GET', '/api/announcements');
  if (anns === null) return;

  const bar  = document.getElementById('announcements-bar');
  const list = document.getElementById('announcements-list');

  if (anns.length === 0) { bar.style.display = 'none'; list.innerHTML = ''; return; }
  bar.style.display = 'block';
  list.innerHTML = anns.map(a => `
    <div class="announcement">
      <span class="ann-icon">📢</span>
      <span class="ann-text">${escapeHtml(a.text)}</span>
      <span class="ann-meta">— ${escapeHtml(a.author)}, ${fmtTime(a.timestamp)}</span>
      ${amIOwnerOrAbove() ? `<button class="ann-delete" onclick="deleteAnnouncement('${a.id}')">✕</button>` : ''}
    </div>`).join('');
}

async function makeAnnouncement() {
  const text = document.getElementById('announcement-text').value.trim();
  if (!text) { alert('Please write an announcement.'); return; }
  await api('POST', '/api/announcements', { text });
  document.getElementById('announcement-text').value = '';
  await renderAnnouncements();
  await renderAdminAnnouncements();
}

async function deleteAnnouncement(id) {
  await api('DELETE', `/api/announcements/${id}`);
  await renderAnnouncements();
  if (!document.getElementById('admin-modal').classList.contains('hidden')) {
    await renderAdminAnnouncements();
  }
}

async function renderAdminAnnouncements() {
  const anns = await api('GET', '/api/announcements');
  const el   = document.getElementById('admin-ann-list');
  if (!el || anns === null) return;
  el.innerHTML = anns.length === 0
    ? '<p style="color:var(--gray-30);font-size:13px;">No active announcements.</p>'
    : anns.map(a => `
        <div class="admin-ann-item">
          <span>${escapeHtml(a.text)}</span>
          <button onclick="deleteAnnouncement('${a.id}')">Remove</button>
        </div>`).join('');
}

// ─── Users sidebar ────────────────────────────────────────────────────────────

async function renderUsers() {
  const users = await api('GET', '/api/users');
  if (users === null) return;

  // Rebuild cache for role lookups used in canDeleteMsg / canViewDetails
  _usersCache = {};
  for (const u of users) _usersCache[u.username] = u;

  const el = document.getElementById('users-list');
  const cu = _currentUser?.username;

  const tier = u => (u.role === 'supreme' || u.role === 'owner') ? 0 : u.role === 'admin' ? 1 : 2;
  users.sort((a, b) => tier(a) - tier(b) || a.username.localeCompare(b.username));

  document.getElementById('member-count').textContent = users.filter(u => !u.banned).length;

  el.innerHTML = users.map(u => {
    const mark        = (u.role === 'owner' || u.role === 'supreme') ? ' 👑' : u.role === 'admin' ? ' 🛡️' : '';
    const you         = u.username === cu ? ' (you)' : '';
    const banMark     = u.banned ? ' 🚫' : '';
    const clickable   = canViewDetails(u.username) ? 'clickable' : '';
    const clickAction = canViewDetails(u.username) ? `onclick="showAccountDetails('${u.username}')"` : '';
    return `
      <div class="user-item ${u.banned ? 'banned' : ''} ${u.username === cu ? 'current' : ''}">
        <span class="user-dot ${u.banned ? 'offline' : 'online'}"></span>
        <span class="user-name ${clickable}" ${clickAction}>${escapeHtml(u.username)}${mark}${you}${banMark}</span>
      </div>`;
  }).join('');
}

// ─── Account details modal ────────────────────────────────────────────────────

async function showAccountDetails(username) {
  if (!canViewDetails(username)) return;
  const data = await api('GET', `/api/users/${username}`);
  if (!data) return;

  const banStatus = !data.banned
    ? '<span style="color:#16a34a;font-weight:600;">Active</span>'
    : !data.bannedUntil
    ? '<span class="details-banned">Permanently banned</span>'
    : `<span class="details-banned">Banned until ${new Date(data.bannedUntil).toLocaleString()}</span>`;

  const joinDate = data.createdAt
    ? new Date(data.createdAt).toLocaleDateString([], { month:'long', day:'numeric', year:'numeric' })
    : 'Unknown';

  document.getElementById('details-modal-title').textContent = username;
  document.getElementById('details-content').innerHTML = `
    <div class="details-row"><span class="details-label">Role</span><span class="details-value">${escapeHtml(data.role)}</span></div>
    <div class="details-row"><span class="details-label">Joined</span><span class="details-value">${joinDate}</span></div>
    <div class="details-row"><span class="details-label">Messages</span><span class="details-value">${data.messageCount ?? 0}</span></div>
    <div class="details-row"><span class="details-label">Status</span><span class="details-value">${banStatus}</span></div>
  `;
  document.getElementById('details-modal').classList.remove('hidden');
}

function closeDetailsModal() {
  document.getElementById('details-modal').classList.add('hidden');
}

// ─── Report system ────────────────────────────────────────────────────────────

function openReportModal(msgId) {
  const msg = _lastMsgs.find(m => m.id === msgId);
  if (!msg) return;
  _reportTargetId = msgId;

  document.getElementById('report-msg-preview').innerHTML = `
    <span class="report-preview-author">${escapeHtml(msg.author)}</span>
    <span class="report-preview-text">${escapeHtml(msg.content.slice(0, 120))}</span>`;
  document.getElementById('report-reason-input').value = '';
  document.getElementById('report-modal').classList.remove('hidden');
}

function closeReportModal() {
  document.getElementById('report-modal').classList.add('hidden');
  _reportTargetId = null;
}

async function submitReport() {
  if (!_reportTargetId) return;
  const reason = document.getElementById('report-reason-input').value.trim();
  if (!reason) { alert('Please describe the reason for reporting.'); return; }
  await api('POST', '/api/reports', { msgId: _reportTargetId, reason });
  closeReportModal();
  alert('Report submitted.');
}

async function dismissReport(id) {
  await api('PATCH', `/api/reports/${id}`, { action: 'dismiss' });
  await renderReports();
}

async function reportDeleteMsg(msgId, reportId) {
  await api('PATCH', `/api/reports/${reportId}`, { action: 'delete_msg' });
  await renderMessages();
  await renderReports();
}

async function reportDeleteAndBan(msgId, target, reportId) {
  await api('PATCH', `/api/reports/${reportId}`, { action: 'delete_ban' });
  await renderMessages();
  await renderUsers();
  await renderReports();
}

async function renderReports() {
  const el = document.getElementById('admin-reports-list');
  if (!el) return;
  const reports = await api('GET', '/api/reports');
  if (reports === null) return;

  const pending   = reports.filter(r => r.status === 'pending');
  const dismissed = reports.filter(r => r.status === 'dismissed');

  let html = '';

  if (pending.length === 0) {
    html += '<p style="color:var(--gray-30);font-size:13px;margin-bottom:12px;">No pending reports.</p>';
  } else {
    html += pending.map(r => _reportCard(r)).join('');
  }

  if (amISupreme() && dismissed.length > 0) {
    html += `<h3 class="section-label" style="margin-top:20px;">History</h3>`;
    html += dismissed.map(r => _reportCard(r)).join('');
  }

  el.innerHTML = html || '<p style="color:var(--gray-30);font-size:13px;">No reports.</p>';
}

function _reportCard(r) {
  const msg     = _lastMsgs.find(m => m.id === r.msg_id);
  const preview = msg
    ? escapeHtml(msg.content.slice(0, 90)) + (msg.content.length > 90 ? '…' : '')
    : '[Message deleted]';
  const target  = msg ? escapeHtml(msg.author) : '[unknown]';
  const isPend  = r.status === 'pending';
  const priLabel = r.priority
    ? `<span class="report-priority">Priority</span>` : '';

  return `
    <div class="report-card ${isPend ? '' : 'dismissed'}">
      <div class="report-header">
        <span class="report-target">Reported: <strong>${target}</strong></span>
        ${priLabel}
        <span class="report-time">${fmtTime(r.timestamp)}</span>
      </div>
      <div class="report-msg-preview">"${preview}"</div>
      <div class="report-reason">Reason: ${escapeHtml(r.reason)}</div>
      <div class="report-reporter">Submitted by: ${escapeHtml(r.reporter)}</div>
      <div class="report-actions">
        <button class="btn-ctx" onclick="openContextModal('${r.id}','${r.msg_id}')">View Context</button>
        ${isPend ? `
        <button class="btn-dismiss" onclick="dismissReport('${r.id}')">Dismiss</button>
        ${msg && !msg.deleted ? `<button class="btn-del-msg" onclick="reportDeleteMsg('${r.msg_id}','${r.id}')">Delete Message</button>` : ''}
        ${msg && !msg.deleted ? `<button class="btn-del-ban" onclick="reportDeleteAndBan('${r.msg_id}','${target}','${r.id}')">Delete + Ban</button>` : ''}
        ` : ''}
      </div>
    </div>`;
}

// ─── Report context modal ─────────────────────────────────────────────────────

let _ctxChannel = null;

async function openContextModal(reportId, msgId) {
  const data = await api('GET', `/api/reports/${reportId}/context`);
  if (!data) return;

  _ctxChannel = data.channel;

  const channelLabel = document.getElementById('ctx-channel-label');
  channelLabel.textContent = data.channel ? `#${data.channel}` : '';

  const cu = _currentUser?.username;
  const container = document.getElementById('ctx-messages');

  if (!data.messages || data.messages.length === 0) {
    container.innerHTML = '<p class="ctx-empty">No surrounding messages found — the channel may have been cleared.</p>';
  } else {
    let html = '', lastDate = '';
    for (const msg of data.messages) {
      const dateStr = fmtDate(msg.timestamp);
      if (dateStr !== lastDate) {
        html += `<div class="date-divider"><span>${dateStr}</span></div>`;
        lastDate = dateStr;
      }
      const isOwn      = msg.author === cu;
      const isReported = msg.isReported;
      const ar         = msg.authorRole;
      const roleTag    = (ar === 'owner' || ar === 'supreme')
        ? `<span class="msg-owner-tag">OWNER</span>`
        : ar === 'admin' ? `<span class="msg-admin-tag">Admin</span>` : '';

      html += `
        <div class="message ${isOwn ? 'own' : 'other'} ${isReported ? 'ctx-reported-msg' : ''}" id="ctxmsg-${msg.id}">
          ${isReported ? '<div class="ctx-reported-label">⚠ Reported message</div>' : ''}
          <div class="message-bubble">
            <div class="message-meta">
              ${!isOwn ? `<span class="msg-author">${escapeHtml(msg.author)}${roleTag}</span>` : ''}
              <span class="msg-time">${fmtTime(msg.timestamp)}</span>
              ${isOwn  ? `<span class="msg-author">${escapeHtml(msg.author)}${roleTag}</span>` : ''}
            </div>
            <div class="msg-content-wrap"><span>${linkify(msg.content)}</span></div>
          </div>
        </div>`;
    }
    container.innerHTML = html;
    // Scroll to reported message
    setTimeout(() => {
      const el = document.getElementById(`ctxmsg-${data.reportedMsgId}`);
      if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 60);
  }

  // Show send bar only if channel exists
  const inputBar = document.getElementById('ctx-input-bar');
  inputBar.classList.toggle('hidden', !data.channel);
  document.getElementById('ctx-message-input').value = '';

  document.getElementById('ctx-modal').classList.remove('hidden');
}

function closeContextModal() {
  document.getElementById('ctx-modal').classList.add('hidden');
  _ctxChannel = null;
}

async function sendContextMessage() {
  if (!_ctxChannel) return;
  const input = document.getElementById('ctx-message-input');
  const text  = input.value.trim();
  if (!text) return;
  input.value = '';

  // Post to the actual channel
  const prevChannel = _channel;
  _channel = _ctxChannel;
  await api('POST', '/api/messages', { content: text, channel: _ctxChannel });
  _channel = prevChannel;

  // Refresh the context view — fetch the active report id from the DOM
  const reportId = document.querySelector('.btn-ctx[onclick*="openContextModal"]')
    ?.getAttribute('onclick')?.match(/'([^']+)'/)?.[1];

  // Re-fetch context by re-querying the same report — easier: just append msg locally
  const cu = _currentUser?.username;
  const container = document.getElementById('ctx-messages');
  const now = new Date().toISOString();
  container.insertAdjacentHTML('beforeend', `
    <div class="message own">
      <div class="message-bubble">
        <div class="message-meta">
          <span class="msg-time">${fmtTime(now)}</span>
          <span class="msg-author">${escapeHtml(cu)}</span>
        </div>
        <div class="msg-content-wrap"><span>${linkify(text)}</span></div>
      </div>
    </div>`);
  container.scrollTop = container.scrollHeight;

  // Also refresh the main chat if it's the same channel
  if (prevChannel === _ctxChannel) renderMessages();
}

// ─── Admin panel ──────────────────────────────────────────────────────────────

function openAdminPanel() {
  if (!amIOwnerOrAbove() && !amIAdminOrAbove()) return;
  document.querySelectorAll('.supreme-tab').forEach(el => el.classList.toggle('hidden', !amISupreme()));
  const aiFlagsTabBtn = document.getElementById('tab-btn-aiflags');
  if (aiFlagsTabBtn) aiFlagsTabBtn.classList.toggle('hidden', !amIAdminOrAbove());
  renderAdminAnnouncements();
  renderAdminUsers();
  renderDangerZone();
  document.getElementById('admin-modal').classList.remove('hidden');
}

function closeAdminPanel() {
  document.getElementById('admin-modal').classList.add('hidden');
}

function switchTab(name, btn) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.add('hidden'));
  btn.classList.add('active');
  document.getElementById('tab-' + name).classList.remove('hidden');
  if (name === 'users')    { renderAdminUsers(); renderDangerZone(); }
  if (name === 'announce') renderAdminAnnouncements();
  if (name === 'reports')  renderReports();
  if (name === 'stats')    renderStatsTab();
  if (name === 'server')   renderServerTab();
  if (name === 'logs')     renderLogsTab();
  if (name === 'aiflags')  renderAiFlagsTab();
}

async function renderAdminUsers() {
  const users = await api('GET', '/api/admin/users');
  const el    = document.getElementById('admin-users-list');
  if (!el || users === null) return;

  const cu     = _currentUser?.username;
  const others = users.filter(u => u.username !== cu);

  if (others.length === 0) {
    el.innerHTML = '<p style="color:var(--gray-30);font-size:13px;padding:8px 0;">No other users yet.</p>';
    return;
  }

  const sup = amISupreme();

  el.innerHTML = `
    <table class="admin-table">
      <thead><tr>
        <th>Username</th><th>Role</th><th>Status</th>
        ${sup ? '<th>Muted</th>' : ''}
        <th>Actions</th>
      </tr></thead>
      <tbody>
        ${others.map(u => {
          const banned  = u.banned;
          const banInfo = !banned ? 'Active'
            : !u.bannedUntil ? 'Permanently banned'
            : `Banned until ${new Date(u.bannedUntil).toLocaleString()}`;
          const muteInfo = !sup ? '' : !u.muted ? '<td>—</td>'
            : !u.mutedUntil ? '<td><span class="muted-badge">Perm</span></td>'
            : `<td><span class="muted-badge">Until ${new Date(u.mutedUntil).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</span></td>`;
          return `
            <tr class="${banned ? 'banned-row' : ''}">
              <td>${escapeHtml(u.username)}${u.notes ? ' <span class="has-note" title="Has note">📝</span>' : ''}</td>
              <td>${escapeHtml(u.displayRole)}</td>
              <td>${banInfo}</td>
              ${muteInfo}
              <td class="admin-actions">${_adminActions(u)}</td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

function _adminActions(u) {
  const myRole  = _currentUser?.role;
  const canMgr  = myRole === 'supreme' || (myRole === 'owner' && (u.role === 'user' || u.role === 'admin'));

  if (!canMgr && u.role !== 'owner') return '<span class="owner-protected">Protected</span>';
  if (!canMgr && u.role === 'owner') return '<span class="owner-protected">Owner — Protected</span>';

  const isAdmin  = u.role === 'admin';
  const isOwner  = u.role === 'owner';

  const basicBtns = `
    ${!isAdmin && !isOwner ? `<button class="admin-action-btn promote" onclick="grantAdmin('${u.username}')">Grant Admin</button>` : ''}
    ${isAdmin              ? `<button class="admin-action-btn demote"  onclick="revokeAdmin('${u.username}')">Revoke Admin</button>` : ''}
    ${!u.banned  ? `<button class="admin-action-btn ban"   onclick="openBanModal('${u.username}')">Ban</button>` : ''}
    ${u.banned   ? `<button class="admin-action-btn unban" onclick="adminUnban('${u.username}')">Unban</button>` : ''}
    <button class="admin-action-btn delete" onclick="adminDeleteAccount('${u.username}')">Delete</button>
    ${amISupreme() && !isOwner ? `<button class="admin-action-btn owner-promote" onclick="promoteToOwner('${u.username}')">Make Owner</button>` : ''}
  `;

  if (!amISupreme()) return basicBtns;

  const muteLbl = u.muted ? 'Unmute' : 'Mute';
  const noteIndicator = u.notes ? ' 📝' : '';

  return basicBtns + `
    <button class="admin-action-btn mute" onclick="openMuteModal('${u.username}')">${muteLbl}</button>
    <button class="admin-action-btn clear-msgs" onclick="clearUserMsgs('${u.username}')">Clear Msgs</button>
    <button class="admin-action-btn view-hist"  onclick="viewUserHistory('${u.username}')">History</button>
    <button class="admin-action-btn note-btn"   onclick="editUserNote('${u.username}', ${JSON.stringify(u.notes || '')})">${noteIndicator}Note</button>
    ${isOwner ? `<button class="admin-action-btn demote" onclick="demoteOwner('${u.username}','admin')">→ Admin</button>` : ''}
    ${isOwner ? `<button class="admin-action-btn demote" onclick="demoteOwner('${u.username}','user')">→ User</button>` : ''}
  `;
}

function renderDangerZone() {
  const el = document.getElementById('danger-zone');
  if (!el) return;
  if (!amISupreme()) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <div class="danger-zone">
      <h4>Chat</h4>
      <div class="dz-row">
        <button class="btn-danger" onclick="clearAllMessages()">Clear General Chat</button>
        <button class="btn-danger" onclick="clearStaffChat()">Clear Staff Chat</button>
      </div>

      <h4 style="margin-top:16px;">Broadcast</h4>
      <textarea id="broadcast-text" class="dz-textarea" placeholder="System announcement text..."></textarea>
      <div class="dz-row">
        <select id="broadcast-channel" class="dz-select">
          <option value="general">General</option>
          <option value="staff">Staff</option>
        </select>
        <button class="btn-danger" onclick="broadcastMsg()">Send Broadcast</button>
      </div>

      <h4 style="margin-top:16px;">Bulk Actions</h4>
      <div class="dz-row">
        <button class="btn-danger" onclick="massUnban()">Mass Unban All</button>
        <button class="btn-danger" onclick="massUnmute()">Mass Unmute All</button>
      </div>
      <div class="dz-row" style="margin-top:8px;">
        <button class="btn-danger" onclick="dismissAllReports()">Dismiss All Reports</button>
        <button class="btn-danger" onclick="clearDismissedReports()">Clear Report History</button>
      </div>
      <div class="dz-row" style="margin-top:8px;">
        <button class="btn-danger" onclick="clearAllAnnouncements()">Clear All Announcements</button>
      </div>

      <h4 style="margin-top:16px;">Purge Messages</h4>
      <div class="dz-row">
        <input type="number" id="purge-days" class="ban-hours-input" placeholder="Days old" min="1" style="max-width:100px;">
        <select id="purge-channel" class="dz-select">
          <option value="general">General</option>
          <option value="staff">Staff</option>
        </select>
        <button class="btn-danger" onclick="purgeMessages()">Purge</button>
      </div>

      <h4 style="margin-top:16px;">Export Chat</h4>
      <div class="dz-row">
        <button class="btn-danger" onclick="exportChat('general')">Export General</button>
        <button class="btn-danger" onclick="exportChat('staff')">Export Staff</button>
      </div>
    </div>`;
}

// ─── Admin actions ────────────────────────────────────────────────────────────

async function grantAdmin(username) {
  await api('PATCH', `/api/admin/users/${username}`, { action: 'grant_admin' });
  await renderAdminUsers(); await renderUsers();
}

async function revokeAdmin(username) {
  await api('PATCH', `/api/admin/users/${username}`, { action: 'revoke_admin' });
  await renderAdminUsers(); await renderUsers();
}

async function promoteToOwner(username) {
  if (!amISupreme()) return;
  if (!confirm(`Promote "${username}" to Owner? They will gain full owner access.`)) return;
  await api('PATCH', `/api/admin/users/${username}`, { action: 'promote_owner' });
  await renderAdminUsers(); await renderUsers();
}

async function adminUnban(username) {
  await api('PATCH', `/api/admin/users/${username}`, { action: 'unban' });
  await renderAdminUsers(); await renderUsers();
}

async function adminDeleteAccount(username) {
  if (!confirm(`Delete account "${username}"? This cannot be undone.`)) return;
  await api('DELETE', `/api/admin/users/${username}`);
  await renderAdminUsers(); await renderUsers(); await renderMessages();
}

async function clearAllMessages() {
  if (!amISupreme()) return;
  if (!confirm('Clear ALL general chat messages? This is irreversible.')) return;
  if (!confirm('Are you absolutely sure? All messages will be permanently deleted.')) return;
  await api('POST', '/api/admin/clear');
  closeAdminPanel();
  await renderMessages();
}

async function clearStaffChat() {
  if (!amISupreme()) return;
  if (!confirm('Clear ALL staff channel messages?')) return;
  await api('POST', '/api/admin/clear-staff');
  closeAdminPanel();
  await renderMessages();
}

// ─── Mute modal ───────────────────────────────────────────────────────────────

function openMuteModal(username) {
  _muteTarget = username;
  document.getElementById('mute-target-label').textContent = `Muting: ${username}`;
  document.getElementById('mute-hours').value = '';
  document.getElementById('mute-modal').classList.remove('hidden');
}

function closeMuteModal() {
  document.getElementById('mute-modal').classList.add('hidden');
  _muteTarget = null;
}

async function executeMute(durationHours) {
  if (!_muteTarget) return;
  const muteUntil = durationHours === null
    ? null
    : new Date(Date.now() + durationHours * 3_600_000).toISOString();
  await api('PATCH', `/api/admin/users/${_muteTarget}`, { action: 'mute', muteUntil });
  closeMuteModal();
  await renderAdminUsers();
}

async function executeTempMute() {
  const h = parseInt(document.getElementById('mute-hours').value);
  if (!h || h < 1) { alert('Enter valid hours (minimum 1).'); return; }
  await executeMute(h);
}

async function executeUnmute() {
  if (!_muteTarget) return;
  await api('PATCH', `/api/admin/users/${_muteTarget}`, { action: 'unmute' });
  closeMuteModal();
  await renderAdminUsers();
}

// ─── User history modal ───────────────────────────────────────────────────────

async function viewUserHistory(username) {
  if (!amISupreme()) return;
  const msgs = await api('GET', `/api/admin/users/${username}/messages`);
  if (!msgs) return;

  document.getElementById('history-modal-title').textContent = `${username} — Last 50 Messages`;
  document.getElementById('history-content').innerHTML = msgs.length === 0
    ? '<p style="color:var(--gray-30)">No messages found.</p>'
    : msgs.map(m => `
        <div class="log-entry ${m.deleted ? 'log-deleted' : ''}">
          <span class="log-channel">#${m.channel}</span>
          <span class="log-time">${fmtTime(m.timestamp)}, ${fmtDate(m.timestamp)}</span>
          <span class="log-content">${escapeHtml(m.content.slice(0, 120))}${m.deleted ? ' <em>[deleted]</em>' : ''}</span>
        </div>`).join('');
  document.getElementById('history-modal').classList.remove('hidden');
}

function closeHistoryModal() {
  document.getElementById('history-modal').classList.add('hidden');
}

// ─── User notes ───────────────────────────────────────────────────────────────

async function editUserNote(username, currentNote) {
  if (!amISupreme()) return;
  const note = prompt(`Internal note for ${username}:`, currentNote);
  if (note === null) return;
  if (note.trim() === '') {
    await api('PATCH', `/api/admin/users/${username}`, { action: 'clear_note' });
  } else {
    await api('PATCH', `/api/admin/users/${username}`, { action: 'add_note', note: note.trim() });
  }
  await renderAdminUsers();
}

// ─── Owner demotion ───────────────────────────────────────────────────────────

async function demoteOwner(username, toRole) {
  if (!amISupreme()) return;
  const action = toRole === 'admin' ? 'demote_owner_to_admin' : 'demote_owner';
  if (!confirm(`Demote "${username}" to ${toRole}?`)) return;
  await api('PATCH', `/api/admin/users/${username}`, { action });
  await renderAdminUsers(); await renderUsers();
}

// ─── Bulk actions ─────────────────────────────────────────────────────────────

async function massUnban() {
  if (!amISupreme()) return;
  if (!confirm('Unban ALL users?')) return;
  await api('POST', '/api/admin/mass-unban');
  await renderAdminUsers(); await renderUsers();
}

async function massUnmute() {
  if (!amISupreme()) return;
  if (!confirm('Unmute ALL muted users?')) return;
  await api('POST', '/api/admin/mass-unmute');
  await renderAdminUsers();
}

async function broadcastMsg() {
  if (!amISupreme()) return;
  const text = document.getElementById('broadcast-text').value.trim();
  if (!text) { alert('Enter broadcast text.'); return; }
  const ch = document.getElementById('broadcast-channel').value;
  await api('POST', '/api/admin/broadcast', { text, channel: ch });
  document.getElementById('broadcast-text').value = '';
  await renderMessages();
  alert('Broadcast sent.');
}

async function dismissAllReports() {
  if (!amISupreme()) return;
  if (!confirm('Dismiss all pending reports?')) return;
  await api('POST', '/api/admin/reports/dismiss-all');
  await renderReports();
}

async function clearDismissedReports() {
  if (!amISupreme()) return;
  if (!confirm('Permanently delete all dismissed report history?')) return;
  await api('DELETE', '/api/admin/reports');
  await renderReports();
}

async function clearAllAnnouncements() {
  if (!amISupreme()) return;
  if (!confirm('Clear all announcements?')) return;
  await api('DELETE', '/api/admin/announcements');
  await renderAnnouncements();
  await renderAdminAnnouncements();
}

async function clearUserMsgs(username) {
  if (!amISupreme()) return;
  if (!confirm(`Delete ALL messages from "${username}"? This cannot be undone.`)) return;
  await api('PATCH', `/api/admin/users/${username}`, { action: 'clear_messages' });
  await renderMessages();
  alert(`All messages from ${username} deleted.`);
}

async function purgeMessages() {
  if (!amISupreme()) return;
  const days = parseInt(document.getElementById('purge-days').value);
  const ch   = document.getElementById('purge-channel').value;
  if (!days || days < 1) { alert('Enter valid number of days.'); return; }
  if (!confirm(`Delete all ${ch} messages older than ${days} days? This cannot be undone.`)) return;
  await api('POST', '/api/admin/purge', { days, channel: ch });
  await renderMessages();
  alert(`Purged ${ch} messages older than ${days} days.`);
}

async function exportChat(channel) {
  if (!amISupreme()) return;
  const msgs = await api('GET', `/api/messages?channel=${channel}`);
  if (!msgs) return;
  const blob = new Blob([JSON.stringify(msgs, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `neuron-${channel}-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Stats tab ────────────────────────────────────────────────────────────────

async function renderStatsTab() {
  if (!amISupreme()) return;
  const el = document.getElementById('tab-stats');
  el.innerHTML = '<p style="color:var(--gray-30);font-size:13px;">Loading...</p>';

  const stats = await api('GET', '/api/admin/stats');
  if (!stats) { el.innerHTML = '<p style="color:var(--gray-30)">Failed to load stats.</p>'; return; }

  el.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-num">${stats.totalUsers}</div><div class="stat-label">Total Users</div></div>
      <div class="stat-card"><div class="stat-num">${stats.totalMessages}</div><div class="stat-label">Messages</div></div>
      <div class="stat-card"><div class="stat-num">${stats.pendingReports}</div><div class="stat-label">Pending Reports</div></div>
      <div class="stat-card"><div class="stat-num">${stats.bannedUsers}</div><div class="stat-label">Banned</div></div>
      <div class="stat-card"><div class="stat-num">${stats.mutedUsers}</div><div class="stat-label">Muted</div></div>
      <div class="stat-card"><div class="stat-num">${stats.totalReactions}</div><div class="stat-label">Reactions</div></div>
    </div>

    <h3 class="section-label" style="margin-top:24px;">Top Message Senders</h3>
    ${stats.topUsers.length === 0
      ? '<p style="color:var(--gray-30);font-size:13px;">No data.</p>'
      : `<div class="leaderboard">
          ${stats.topUsers.map((u,i) => `
            <div class="lb-row">
              <span class="lb-rank">#${i+1}</span>
              <span class="lb-user">${escapeHtml(u.username)}</span>
              <span class="lb-count">${u.count} msgs</span>
            </div>`).join('')}
        </div>`}
    <button class="settings-btn" style="margin-top:16px;" onclick="renderStatsTab()">Refresh</button>
  `;
}

// ─── Server settings tab ──────────────────────────────────────────────────────

async function renderServerTab() {
  if (!amISupreme()) return;
  const el = document.getElementById('tab-server');
  el.innerHTML = '<p style="color:var(--gray-30);font-size:13px;">Loading...</p>';

  const s = await api('GET', '/api/admin/settings');
  if (!s) { el.innerHTML = '<p style="color:var(--gray-30)">Failed to load settings.</p>'; return; }

  const wfWords = s.word_filter ? (() => { try { return JSON.parse(s.word_filter); } catch { return []; } })() : [];

  el.innerHTML = `
    <div class="server-section">
      <p class="settings-section-title">Channels</p>

      <div class="settings-row">
        <div><span class="settings-row-label">Lock General Channel</span>
          <span class="settings-row-desc">Prevent regular users from posting</span></div>
        <label class="toggle-switch">
          <input type="checkbox" id="sv-general-locked" ${s.general_locked === '1' ? 'checked' : ''}
            onchange="toggleSvSetting('general_locked', this.checked)">
          <span class="toggle-track"></span>
        </label>
      </div>

      <div class="settings-row">
        <div><span class="settings-row-label">Lock Staff Channel</span>
          <span class="settings-row-desc">Prevent admins from posting in staff</span></div>
        <label class="toggle-switch">
          <input type="checkbox" id="sv-staff-locked" ${s.staff_locked === '1' ? 'checked' : ''}
            onchange="toggleSvSetting('staff_locked', this.checked)">
          <span class="toggle-track"></span>
        </label>
      </div>

      <div class="settings-row">
        <div><span class="settings-row-label">General Slowmode</span>
          <span class="settings-row-desc">Seconds between messages (0 = off)</span></div>
        <div class="sv-inline">
          <input type="number" id="sv-gen-slow" class="sv-num-input" value="${s.general_slowmode || '0'}" min="0" max="3600">
          <button class="settings-btn sm" onclick="saveSvNum('general_slowmode','sv-gen-slow')">Save</button>
        </div>
      </div>

      <div class="settings-row">
        <div><span class="settings-row-label">Staff Slowmode</span>
          <span class="settings-row-desc">Seconds between messages (0 = off)</span></div>
        <div class="sv-inline">
          <input type="number" id="sv-staff-slow" class="sv-num-input" value="${s.staff_slowmode || '0'}" min="0" max="3600">
          <button class="settings-btn sm" onclick="saveSvNum('staff_slowmode','sv-staff-slow')">Save</button>
        </div>
      </div>
    </div>

    <div class="server-section">
      <p class="settings-section-title">Access</p>

      <div class="settings-row">
        <div><span class="settings-row-label">Maintenance Mode</span>
          <span class="settings-row-desc">Block all non-owner logins</span></div>
        <label class="toggle-switch">
          <input type="checkbox" id="sv-maintenance" ${s.maintenance_mode === '1' ? 'checked' : ''}
            onchange="toggleSvSetting('maintenance_mode', this.checked)">
          <span class="toggle-track"></span>
        </label>
      </div>
    </div>

    <div class="server-section">
      <p class="settings-section-title">Messages</p>

      <div class="settings-row">
        <div><span class="settings-row-label">Max Message Length</span>
          <span class="settings-row-desc">Characters (default: 2000)</span></div>
        <div class="sv-inline">
          <input type="number" id="sv-maxlen" class="sv-num-input" value="${s.max_msg_length || '2000'}" min="10" max="5000">
          <button class="settings-btn sm" onclick="saveSvNum('max_msg_length','sv-maxlen')">Save</button>
        </div>
      </div>

      <div class="settings-row" style="align-items:flex-start;flex-direction:column;gap:10px;">
        <span class="settings-row-label">Word Filter</span>
        <div class="wf-tags" id="wf-tags">
          ${wfWords.map(w => `<span class="wf-tag">${escapeHtml(w)} <button onclick="removeFilterWord('${escapeHtml(w)}')">✕</button></span>`).join('')}
          ${wfWords.length === 0 ? '<span style="color:var(--gray-30);font-size:13px;">No words filtered.</span>' : ''}
        </div>
        <div class="sv-inline">
          <input type="text" id="sv-new-word" class="sv-text-input" placeholder="Add word...">
          <button class="settings-btn sm" onclick="addFilterWord()">Add</button>
        </div>
      </div>
    </div>

    <div class="server-section">
      <p class="settings-section-title">MOTD</p>
      <div style="display:flex;flex-direction:column;gap:8px;">
        <textarea id="sv-motd" class="sv-textarea" placeholder="Message shown on the login page (leave blank to hide)">${escapeHtml(s.motd || '')}</textarea>
        <button class="settings-btn" onclick="saveSvText('motd','sv-motd')">Save MOTD</button>
      </div>
    </div>
  `;
}

async function toggleSvSetting(key, val) {
  await api('PATCH', '/api/admin/settings', { key, value: val ? '1' : '0' });
}

async function saveSvNum(key, inputId) {
  const val = document.getElementById(inputId).value;
  await api('PATCH', '/api/admin/settings', { key, value: val });
  alert('Saved.');
}

async function saveSvText(key, inputId) {
  const val = document.getElementById(inputId).value;
  await api('PATCH', '/api/admin/settings', { key, value: val });
  alert('Saved.');
}

async function addFilterWord() {
  const input = document.getElementById('sv-new-word');
  const word  = input.value.trim().toLowerCase();
  if (!word) return;
  const s = await api('GET', '/api/admin/settings');
  if (!s) return;
  const words = s.word_filter ? (() => { try { return JSON.parse(s.word_filter); } catch { return []; } })() : [];
  if (!words.includes(word)) words.push(word);
  await api('PATCH', '/api/admin/settings', { key: 'word_filter', value: JSON.stringify(words) });
  input.value = '';
  await renderServerTab();
}

async function removeFilterWord(word) {
  const s = await api('GET', '/api/admin/settings');
  if (!s) return;
  const words = (s.word_filter ? (() => { try { return JSON.parse(s.word_filter); } catch { return []; } })() : []).filter(w => w !== word);
  await api('PATCH', '/api/admin/settings', { key: 'word_filter', value: JSON.stringify(words) });
  await renderServerTab();
}

// ─── Logs tab (deleted messages) ─────────────────────────────────────────────

async function renderLogsTab() {
  if (!amISupreme()) return;
  const el = document.getElementById('tab-logs');
  el.innerHTML = '<p style="color:var(--gray-30);font-size:13px;">Loading...</p>';

  const deleted = await api('GET', '/api/admin/deleted');
  if (!deleted) { el.innerHTML = '<p style="color:var(--gray-30)">Failed to load.</p>'; return; }

  el.innerHTML = deleted.length === 0
    ? '<p style="color:var(--gray-30);font-size:13px;">No deleted messages.</p>'
    : `<div style="display:flex;flex-direction:column;gap:6px;">
        ${deleted.map(m => `
          <div class="log-entry log-deleted">
            <div class="log-meta">
              <span class="log-author">${escapeHtml(m.author)}</span>
              <span class="log-channel">#${m.channel}</span>
              <span class="log-time">${fmtTime(m.timestamp)}, ${fmtDate(m.timestamp)}</span>
              <button class="admin-action-btn promote" style="padding:2px 8px;font-size:11px;" onclick="restoreMessage('${m.id}')">Restore</button>
            </div>
            <div class="log-content">${escapeHtml(m.content.slice(0, 150))}</div>
          </div>`).join('')}
      </div>
      <button class="settings-btn" style="margin-top:16px;" onclick="renderLogsTab()">Refresh</button>
    `;
}

async function restoreMessage(id) {
  if (!amISupreme()) return;
  await api('POST', `/api/messages/${id}/restore`);
  await renderLogsTab();
  await renderMessages();
}

// ─── Ban modal ────────────────────────────────────────────────────────────────

function openBanModal(username) {
  _banTarget = username;
  document.getElementById('ban-target-label').textContent = `Banning: ${username}`;
  document.getElementById('ban-hours').value = '';
  document.getElementById('ban-modal').classList.remove('hidden');
}

function closeBanModal() {
  document.getElementById('ban-modal').classList.add('hidden');
  _banTarget = null;
}

async function executeBan(durationHours) {
  if (!_banTarget) return;
  const bannedUntil = durationHours === null
    ? null
    : new Date(Date.now() + durationHours * 3_600_000).toISOString();
  await api('PATCH', `/api/admin/users/${_banTarget}`, { action: 'ban', bannedUntil });
  closeBanModal();
  await renderAdminUsers(); await renderUsers();
}

async function executeTempBan() {
  const h = parseInt(document.getElementById('ban-hours').value);
  if (!h || h < 1) { alert('Enter valid hours (minimum 1).'); return; }
  await executeBan(h);
}

// ─── Settings modal ───────────────────────────────────────────────────────────

function openSettings() {
  // Sync toggles to current prefs before showing
  document.getElementById('pref-dark-mode').checked = document.body.classList.contains('dark');
  document.getElementById('pref-compact').checked    = document.body.classList.contains('compact');
  // Clear all fields and messages
  ['settings-curr-pass','settings-new-pass','settings-confirm-pass','settings-delete-pass']
    .forEach(id => { document.getElementById(id).value = ''; });
  _setSettingsMsg('pass',   '', '');
  _setSettingsMsg('delete', '', '');
  renderParentalControlsSection();
  document.getElementById('settings-modal').classList.remove('hidden');
}

function closeSettings() {
  document.getElementById('settings-modal').classList.add('hidden');
}

function _setSettingsMsg(which, text, type) {
  const el = document.getElementById(`settings-${which}-msg`);
  el.textContent = text;
  el.className   = `settings-msg${type ? ' ' + type : ''}${text ? '' : ' hidden'}`;
}

async function changePassword() {
  const curr    = document.getElementById('settings-curr-pass').value;
  const next    = document.getElementById('settings-new-pass').value;
  const confirm = document.getElementById('settings-confirm-pass').value;

  if (!curr || !next || !confirm) {
    _setSettingsMsg('pass', 'All three fields are required.', 'error'); return;
  }
  if (next.length < 6) {
    _setSettingsMsg('pass', 'New password must be at least 6 characters.', 'error'); return;
  }
  if (next !== confirm) {
    _setSettingsMsg('pass', 'New passwords do not match.', 'error'); return;
  }

  const res = await api('PATCH', '/api/me/password', { currentPassword: curr, newPassword: next });
  if (res?.ok) {
    _setSettingsMsg('pass', 'Password updated successfully.', 'success');
    ['settings-curr-pass','settings-new-pass','settings-confirm-pass']
      .forEach(id => { document.getElementById(id).value = ''; });
  } else {
    _setSettingsMsg('pass', 'Failed to update password. Check your current password.', 'error');
  }
}

async function deleteOwnAccount() {
  const password = document.getElementById('settings-delete-pass').value;
  if (!password) { _setSettingsMsg('delete', 'Enter your password to confirm.', 'error'); return; }

  if (!confirm('Delete your account? All your messages will be removed. This cannot be undone.')) return;

  const res = await api('DELETE', '/api/me', { password });
  if (res?.ok) {
    closeSettings();
    handleLogout();
  } else {
    _setSettingsMsg('delete', 'Incorrect password or account cannot be deleted.', 'error');
  }
}

// ═══════════════════════════════════════════════════════════════
// TOS
// ═══════════════════════════════════════════════════════════════

function showTosModal() {
  document.getElementById('tos-modal').classList.remove('hidden');
  const cb  = document.getElementById('tos-checkbox');
  const btn = document.getElementById('tos-accept-btn');
  cb.checked = false;
  btn.disabled = true;
  cb.onchange = () => { btn.disabled = !cb.checked; };
}

async function acceptTos() {
  const res = await api('POST', '/api/tos/accept');
  if (res?.ok) {
    document.getElementById('tos-modal').classList.add('hidden');
    showApp();
  }
}

// ═══════════════════════════════════════════════════════════════
// SIDEBAR TABS
// ═══════════════════════════════════════════════════════════════

function switchSidebarTab(tab, btn) {
  _sidebarTab = tab;
  document.querySelectorAll('.sidebar-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('sidebar-members').classList.toggle('hidden', tab !== 'members');
  document.getElementById('sidebar-friends').classList.toggle('hidden', tab !== 'friends');
  document.getElementById('sidebar-dms').classList.toggle('hidden',     tab !== 'dms');
  if (tab === 'friends') renderSidebarFriends();
  if (tab === 'dms')     renderSidebarDms();
}

// ═══════════════════════════════════════════════════════════════
// FRIENDS
// ═══════════════════════════════════════════════════════════════

async function renderSidebarFriends() {
  const el = document.getElementById('friends-list-pane');
  if (!el) return;
  const data = await api('GET', '/api/friends');
  if (!data) return;
  _friendsCache = data;

  const tabBtn = document.getElementById('friends-tab-btn');
  if (tabBtn) tabBtn.setAttribute('data-badge', data.incoming.length > 0 ? data.incoming.length : '');

  let html = '';
  if (data.incoming.length > 0) {
    html += `<p class="sidebar-section-label">Requests (${data.incoming.length})</p>`;
    html += data.incoming.map(r => `
      <div class="friend-request-item">
        <span class="friend-name">${escapeHtml(r.username)}</span>
        <div class="friend-req-btns">
          <button class="fr-accept" onclick="respondFriendReq('${r.username}','accept')" title="Accept">✓</button>
          <button class="fr-reject" onclick="respondFriendReq('${r.username}','reject')" title="Decline">✕</button>
        </div>
      </div>`).join('');
  }

  if (data.friends.length > 0) {
    html += `<p class="sidebar-section-label">Friends (${data.friends.length})</p>`;
    html += data.friends.map(u => `
      <div class="friend-item">
        <span class="user-dot online"></span>
        <span class="friend-name">${escapeHtml(u)}</span>
        <div class="friend-item-btns">
          <button class="fr-dm" title="Message" onclick="openDmWith('${u}')">💬</button>
          <button class="fr-unfriend" title="Unfriend" onclick="unfriend('${u}')">✕</button>
        </div>
      </div>`).join('');
  }

  if (data.outgoing.length > 0) {
    html += `<p class="sidebar-section-label">Sent</p>`;
    html += data.outgoing.map(r => `
      <div class="friend-item" style="opacity:0.6;">
        <span class="friend-name">${escapeHtml(r.username)}</span>
        <span style="font-size:11px;color:var(--gray-30);">Pending</span>
      </div>`).join('');
  }

  if (!html) html = '<p class="no-friends-msg">No friends yet.<br>Click + to add someone.</p>';
  el.innerHTML = html;
}

function openAddFriendModal() {
  document.getElementById('add-friend-input').value = '';
  const msgEl = document.getElementById('add-friend-msg');
  msgEl.textContent = '';
  msgEl.className = 'settings-msg hidden';
  document.getElementById('add-friend-modal').classList.remove('hidden');
}

function closeAddFriendModal() {
  document.getElementById('add-friend-modal').classList.add('hidden');
}

async function sendFriendRequest() {
  const username = document.getElementById('add-friend-input').value.trim();
  if (!username) return;
  const msgEl = document.getElementById('add-friend-msg');
  const res = await api('POST', '/api/friends/request', { username });
  if (res?.id) {
    msgEl.textContent = `Request sent to ${username}!`;
    msgEl.className = 'settings-msg success';
    document.getElementById('add-friend-input').value = '';
    renderSidebarFriends();
  } else {
    msgEl.textContent = 'Could not send request. User may not exist or a request already exists.';
    msgEl.className = 'settings-msg error';
  }
}

async function respondFriendReq(username, action) {
  await api('PATCH', `/api/friends/${username}`, { action });
  renderSidebarFriends();
}

async function unfriend(username) {
  if (!confirm(`Remove ${username} from friends?`)) return;
  await api('DELETE', `/api/friends/${username}`);
  renderSidebarFriends();
}

// ═══════════════════════════════════════════════════════════════
// CONVERSATIONS / DMs
// ═══════════════════════════════════════════════════════════════

async function renderSidebarDms() {
  const el = document.getElementById('dm-list-pane');
  if (!el) return;
  const convs = await api('GET', '/api/conversations');
  if (!convs) return;
  _conversations = convs;

  const totalUnread = convs.reduce((s, c) => s + (c.unread || 0), 0);
  const dmsTabBtn = document.getElementById('dms-tab-btn');
  if (dmsTabBtn) dmsTabBtn.setAttribute('data-badge', totalUnread > 0 ? totalUnread : '');

  if (convs.length === 0) {
    el.innerHTML = '<p class="no-friends-msg">No conversations yet.<br>Message a friend to start.</p>';
    return;
  }

  el.innerHTML = convs.map(c => `
    <div class="dm-item ${_activeDmId === c.id ? 'active' : ''}" onclick="openConversation('${c.id}')">
      <div class="dm-item-icon">${c.type === 'group' ? '👥' : '💬'}</div>
      <div class="dm-item-info">
        <div class="dm-item-name">${escapeHtml(c.name)}</div>
        ${c.lastMsg ? `<div class="dm-item-preview">${escapeHtml(c.lastMsg)}</div>` : ''}
      </div>
      ${c.unread > 0 ? `<span class="dm-unread-badge">${c.unread > 99 ? '99+' : c.unread}</span>` : ''}
    </div>`).join('');
}

async function openDmWith(username) {
  const res = await api('POST', '/api/conversations', { type: 'dm', username });
  if (res?.id) openConversation(res.id);
}

async function openConversation(convId) {
  _activeDmId = convId;
  const conv = await api('GET', `/api/conversations/${convId}`);
  if (!conv) return;

  const me = _currentUser?.username;
  const name = conv.type === 'dm'
    ? conv.members.find(m => m.username !== me)?.username || 'DM'
    : conv.name;

  document.getElementById('dm-header').classList.remove('hidden');
  document.getElementById('dm-header-name').textContent = name;
  document.getElementById('dm-header-type').textContent = conv.type === 'group' ? `· ${conv.members.length} members` : '';
  const grpBtn = document.getElementById('dm-group-settings-btn');
  if (grpBtn) {
    const isOwner = conv.members.find(m => m.username === me)?.role === 'owner';
    grpBtn.classList.toggle('hidden', conv.type !== 'group' || !isOwner);
  }

  // Hide channel tabs while in DM view
  document.getElementById('chat-tabs').classList.add('hidden');
  document.getElementById('message-input').placeholder = `Message ${name}…`;
  document.getElementById('message-input').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendDmMessage(); } };
  document.querySelector('.btn-send').onclick = sendDmMessage;

  await pollDmMessages();
  scrollBottom();
  renderSidebarDms();
  _updateCallUI();
}

async function pollDmMessages() {
  if (!_activeDmId) return;
  const msgs = await api('GET', `/api/conversations/${_activeDmId}/messages`);
  if (!msgs) return;

  const container = document.getElementById('messages-container');
  const atBottom  = isAtBottom(container);
  const prevLen   = _dmMessages.length;
  _dmMessages     = msgs;
  const cu        = _currentUser?.username;

  if (msgs.length === 0) {
    container.innerHTML = '<div class="no-messages">No messages yet. Say hello! 👋</div>';
    return;
  }

  let html = '', lastDate = '';
  for (const msg of msgs) {
    const dateStr = fmtDate(msg.timestamp);
    if (dateStr !== lastDate) {
      html += `<div class="date-divider"><span>${dateStr}</span></div>`;
      lastDate = dateStr;
    }
    const isOwn = msg.author === cu;
    html += `
      <div class="message ${isOwn ? 'own' : 'other'}" id="dmsg-${msg.id}">
        <div class="message-bubble">
          <div class="message-meta">
            ${!isOwn ? `<span class="msg-author">${escapeHtml(msg.author)}</span>` : ''}
            <span class="msg-time">${fmtTime(msg.timestamp)}</span>
            ${isOwn  ? `<span class="msg-author">${escapeHtml(msg.author)}</span>` : ''}
          </div>
          <div class="msg-content-wrap"><span>${linkify(msg.content)}</span></div>
        </div>
      </div>`;
  }
  container.innerHTML = html;
  if (atBottom || msgs.length > prevLen) scrollBottom();
}

async function sendDmMessage() {
  if (!_activeDmId) return;
  const input = document.getElementById('message-input');
  const text  = input.value.trim();
  if (!text) return;
  input.value = '';
  await api('POST', `/api/conversations/${_activeDmId}/messages`, { content: text, type: 'text' });
  await pollDmMessages();
  scrollBottom();
}

function closeDmView() {
  if (_activeCallConvId) endCall();
  _activeDmId = null;
  _dmMessages = [];
  document.getElementById('dm-header').classList.add('hidden');
  document.getElementById('chat-tabs').classList.toggle('hidden', !amIAdminOrAbove());
  document.getElementById('message-input').placeholder = 'Send a message…';
  document.getElementById('message-input').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } };
  document.querySelector('.btn-send').onclick = sendMessage;
  renderMessages();
  renderSidebarDms();
}

// ═══════════════════════════════════════════════════════════════
// GROUPS
// ═══════════════════════════════════════════════════════════════

function openGroupModal() {
  const el = document.getElementById('group-friends-list');
  const friends = _friendsCache.friends || [];
  if (friends.length === 0) {
    el.innerHTML = '<p style="color:var(--gray-30);font-size:13px;">Add friends first to create a group with them.</p>';
  } else {
    el.innerHTML = friends.map(u => `
      <label class="group-member-row">
        <input type="checkbox" class="group-member-cb" value="${escapeHtml(u)}">
        <span>${escapeHtml(u)}</span>
      </label>`).join('');
  }
  document.getElementById('group-name-input').value = '';
  document.getElementById('group-modal').classList.remove('hidden');
}

function closeGroupModal() {
  document.getElementById('group-modal').classList.add('hidden');
}

async function createGroup() {
  const name = document.getElementById('group-name-input').value.trim();
  if (!name) { alert('Enter a group name.'); return; }
  const members = [...document.querySelectorAll('.group-member-cb:checked')].map(cb => cb.value);
  const res = await api('POST', '/api/conversations', { type: 'group', name, members });
  if (res?.id) {
    closeGroupModal();
    await renderSidebarDms();
    openConversation(res.id);
  }
}

async function openGroupSettings() {
  if (!_activeDmId) return;
  const username = prompt('Enter username to add to group:');
  if (!username?.trim()) return;
  const res = await api('POST', `/api/conversations/${_activeDmId}/members`, { username: username.trim() });
  if (res?.ok) { alert(`${username} added to group.`); openConversation(_activeDmId); }
  else alert('Could not add member. They may not exist or already be in the group.');
}

// ═══════════════════════════════════════════════════════════════
// PARENTAL CONTROLS
// ═══════════════════════════════════════════════════════════════

function renderParentalControlsSection() {
  const statusBadge = document.getElementById('parental-status-badge');
  const formEl      = document.getElementById('parental-form');
  if (!statusBadge || !formEl) return;

  const isOn = !!_currentUser?.parentalControls;
  if (isOn) {
    statusBadge.innerHTML = '<span class="safe-mode-badge">SAFE MODE ON</span>';
    formEl.innerHTML = `
      <p class="settings-desc">Safe Mode is active. DMs restricted to friends only.</p>
      <input type="password" id="parental-disable-pin" class="settings-input" placeholder="Enter PIN to disable">
      <div id="parental-msg" class="settings-msg hidden"></div>
      <button class="settings-btn danger" onclick="disableParentalControls()">Disable Safe Mode</button>`;
  } else {
    statusBadge.innerHTML = '<span style="font-size:13px;color:var(--gray-30);">OFF</span>';
    formEl.innerHTML = `
      <p class="settings-desc">Enable Safe Mode to restrict DMs to friends only and enable content filtering. Set a PIN to prevent changes.</p>
      <input type="password" id="parental-new-pin" class="settings-input" placeholder="Create PIN (min 4 digits)">
      <div id="parental-msg" class="settings-msg hidden"></div>
      <button class="settings-btn" onclick="enableParentalControls()">Enable Safe Mode</button>`;
  }
}

async function enableParentalControls() {
  const pin = document.getElementById('parental-new-pin')?.value;
  if (!pin || pin.length < 4) { _setParentalMsg('PIN must be at least 4 digits.', 'error'); return; }
  const res = await api('PATCH', '/api/me/parental', { action: 'enable', pin });
  if (res?.ok) {
    _currentUser.parentalControls = true;
    renderParentalControlsSection();
    _setParentalMsg('Safe Mode enabled.', 'success');
    document.getElementById('safe-mode-indicator')?.remove();
    const badge = document.createElement('span');
    badge.id = 'safe-mode-indicator';
    badge.className = 'safe-mode-badge header-safe-mode';
    badge.textContent = 'SAFE MODE';
    document.querySelector('.header-right')?.prepend(badge);
  } else {
    _setParentalMsg('Failed to enable Safe Mode.', 'error');
  }
}

async function disableParentalControls() {
  const pin = document.getElementById('parental-disable-pin')?.value;
  if (!pin) { _setParentalMsg('Enter your PIN.', 'error'); return; }
  const res = await api('PATCH', '/api/me/parental', { action: 'disable', currentPin: pin });
  if (res?.ok) {
    _currentUser.parentalControls = false;
    renderParentalControlsSection();
    _setParentalMsg('Safe Mode disabled.', 'success');
    document.getElementById('safe-mode-indicator')?.remove();
  } else {
    _setParentalMsg('Incorrect PIN.', 'error');
  }
}

function _setParentalMsg(text, type) {
  const el = document.getElementById('parental-msg');
  if (!el) return;
  el.textContent = text;
  el.className = `settings-msg ${type}`;
}

// ═══════════════════════════════════════════════════════════════
// AI FLAGS ADMIN TAB
// ═══════════════════════════════════════════════════════════════

async function renderAiFlagsTab() {
  const el = document.getElementById('tab-aiflags');
  if (!el) return;
  el.innerHTML = '<p style="color:var(--gray-30);font-size:13px;">Loading...</p>';
  const flags = await api('GET', '/api/admin/ai-flags');
  if (!flags) { el.innerHTML = '<p style="color:var(--gray-30)">Failed to load.</p>'; return; }

  if (flags.length === 0) {
    el.innerHTML = '<p style="color:var(--gray-30);font-size:13px;">No AI flags. 🛡️</p>';
    return;
  }

  el.innerHTML = `<div style="display:flex;flex-direction:column;gap:8px;">
    ${flags.map(f => {
      const cats = f.categories ? (() => { try { return JSON.parse(f.categories); } catch { return []; } })() : [];
      const sevColor = { critical: '#dc2626', high: '#ea580c', medium: '#d97706' }[f.severity] || '#6b7280';
      return `
        <div class="ai-flag-card">
          <div class="ai-flag-header">
            <span class="ai-flag-author">${escapeHtml(f.author)}</span>
            <span class="ai-flag-src">#${f.message_src}</span>
            <span class="ai-flag-sev" style="color:${sevColor};font-weight:700;">${(f.severity || 'unknown').toUpperCase()}</span>
            <span class="ai-flag-time">${fmtTime(f.created_at)}, ${fmtDate(f.created_at)}</span>
            ${f.auto_action ? `<span class="ai-flag-action">${f.auto_action}</span>` : ''}
            <button class="admin-action-btn demote" style="padding:2px 8px;font-size:11px;margin-left:auto;" onclick="dismissAiFlag('${f.id}')">Dismiss</button>
          </div>
          <div class="ai-flag-content">"${escapeHtml((f.content || '').slice(0, 150))}"</div>
          ${cats.length > 0 ? `<div class="ai-flag-cats">${cats.map(c => `<span class="ai-flag-cat">${c}</span>`).join('')}</div>` : ''}
          ${f.reason ? `<div class="ai-flag-reason">${escapeHtml(f.reason)}</div>` : ''}
        </div>`;
    }).join('')}
  </div>
  <button class="settings-btn" style="margin-top:16px;" onclick="renderAiFlagsTab()">Refresh</button>`;
}

async function dismissAiFlag(id) {
  await api('DELETE', `/api/admin/ai-flags/${id}`);
  renderAiFlagsTab();
}

// ═══════════════════════════════════════════════════════════════
// VOICE CHAT  (WebRTC + WebSocket signaling)
// ═══════════════════════════════════════════════════════════════

let _voiceWs         = null;   // WebSocket connection to signaling server
let _voiceRoom       = null;   // current room id
let _voicePeers      = {};     // username → RTCPeerConnection
let _localStream     = null;   // our microphone stream
let _isMuted         = false;
let _speakingTimers  = {};     // username → timeout for speaking indicator

let _activeCallConvId = null;  // convId when in a private call
let _callPeers        = {};    // username → RTCPeerConnection (private calls)
let _callParticipants = [];    // usernames currently in the call with us
let _incomingCallInfo = null;  // { from, convId, convName }

const STUN_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

// ─── WebSocket connection ─────────────────────────────────────────────────────

function connectVoiceSocket() {
  if (_voiceWs && _voiceWs.readyState < 2) return; // already open/connecting
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  _voiceWs = new WebSocket(`${proto}://${location.host}`);

  _voiceWs.onopen = () => {
    _voiceWs.send(JSON.stringify({ type: 'auth', token: getToken() }));
  };

  _voiceWs.onmessage = e => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handleVoiceMessage(msg);
  };

  _voiceWs.onclose = () => {
    // If we were in a room, clean up
    if (_voiceRoom) _cleanupVoice();
    // Reconnect after a short delay
    setTimeout(connectVoiceSocket, 3000);
  };
}

function handleVoiceMessage(msg) {
  switch (msg.type) {

    case 'voice-room-state':
      renderVoiceRoom(msg.roomId, msg.members);
      break;

    // Server confirmed we joined — msg.members = existing members we must call
    case 'voice-joined':
      _voiceRoom = msg.roomId;
      _updateVoiceStatusBar();
      // Initiate offers to all existing members in the room
      for (const username of msg.members) {
        _createOffer(username);
      }
      break;

    case 'voice-left':
      _cleanupVoice();
      break;

    // Someone else joined — they will send us an offer, we just update UI
    case 'voice-user-joined':
      renderVoiceRoom(msg.roomId, null); // will re-fetch via room-state broadcast
      break;

    case 'voice-user-left':
      _closePeer(msg.username);
      renderVoiceRoom(msg.roomId, null);
      break;

    case 'voice-offer':
      _handleOffer(msg.from, msg.sdp);
      break;

    case 'voice-answer':
      _handleAnswer(msg.from, msg.sdp);
      break;

    case 'voice-ice':
      _handleIce(msg.from, msg.candidate);
      break;

    case 'voice-speaking':
      _updateSpeakingIndicator(msg.username, msg.speaking);
      break;

    // ── Private call signaling ────────────────────────────────────────────────
    case 'call-invite':
      _incomingCallInfo = { from: msg.from, convId: msg.convId, convName: msg.convName };
      _showIncomingCall(msg.from, msg.convName || msg.from);
      break;

    case 'call-accept':
      if (_activeCallConvId === msg.convId) {
        if (!_callParticipants.includes(msg.from)) _callParticipants.push(msg.from);
        _callCreateOffer(msg.from);
        _updateCallUI();
      }
      break;

    case 'call-reject':
      _showCallToast(`${msg.from} declined the call`);
      break;

    case 'call-end':
      if (_activeCallConvId === msg.convId) _cleanupCall();
      break;

    case 'call-offer':
      _callHandleOffer(msg.from, msg.sdp);
      break;

    case 'call-answer':
      _callHandleAnswer(msg.from, msg.sdp);
      break;

    case 'call-ice':
      _callHandleIce(msg.from, msg.candidate);
      break;
  }
}

// ─── WebRTC helpers ───────────────────────────────────────────────────────────

function _newPeerConnection(username) {
  if (_voicePeers[username]) _closePeer(username);
  const pc = new RTCPeerConnection(STUN_SERVERS);
  _voicePeers[username] = pc;

  // Add local tracks
  if (_localStream) {
    for (const track of _localStream.getTracks()) pc.addTrack(track, _localStream);
  }

  // Play incoming audio
  pc.ontrack = e => {
    let audio = document.getElementById(`voice-audio-${username}`);
    if (!audio) {
      audio = document.createElement('audio');
      audio.id = `voice-audio-${username}`;
      audio.autoplay = true;
      document.body.appendChild(audio);
    }
    audio.srcObject = e.streams[0];
  };

  pc.onicecandidate = e => {
    if (e.candidate && _voiceWs?.readyState === 1) {
      _voiceWs.send(JSON.stringify({ type: 'voice-ice', to: username, candidate: e.candidate }));
    }
  };

  pc.onconnectionstatechange = () => {
    if (['failed','disconnected','closed'].includes(pc.connectionState)) {
      _closePeer(username);
    }
  };

  return pc;
}

async function _createOffer(username) {
  const pc = _newPeerConnection(username);
  const offer = await pc.createOffer({ offerToReceiveAudio: true });
  await pc.setLocalDescription(offer);
  _voiceWs.send(JSON.stringify({ type: 'voice-offer', to: username, sdp: pc.localDescription }));
}

async function _handleOffer(from, sdp) {
  const pc = _newPeerConnection(from);
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  _voiceWs.send(JSON.stringify({ type: 'voice-answer', to: from, sdp: pc.localDescription }));
}

async function _handleAnswer(from, sdp) {
  const pc = _voicePeers[from];
  if (!pc) return;
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
}

async function _handleIce(from, candidate) {
  const pc = _voicePeers[from];
  if (!pc) return;
  try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
}

function _closePeer(username) {
  if (_voicePeers[username]) {
    _voicePeers[username].close();
    delete _voicePeers[username];
  }
  const audio = document.getElementById(`voice-audio-${username}`);
  if (audio) audio.remove();
}

function _cleanupVoice() {
  for (const username of Object.keys(_voicePeers)) _closePeer(username);
  if (_localStream) { _localStream.getTracks().forEach(t => t.stop()); _localStream = null; }
  _voiceRoom = null;
  _isMuted   = false;
  _updateVoiceStatusBar();
  renderAllVoiceRooms();
}

// ═══════════════════════════════════════════════════════════════
// PRIVATE VOICE CALLS  (DM / Group)
// ═══════════════════════════════════════════════════════════════

async function startCall() {
  if (!_activeDmId) return;

  // If already in a call on this conversation, hang up
  if (_activeCallConvId === _activeDmId) { endCall(); return; }

  // If in a different call, refuse — must end that one first
  if (_activeCallConvId) {
    alert('You are already in a call. End it before starting a new one.');
    return;
  }

  const conv = await api('GET', `/api/conversations/${_activeDmId}`);
  if (!conv) return;

  try {
    if (!_localStream) {
      _localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    }
  } catch {
    alert('Could not access your microphone. Please allow microphone access and try again.');
    return;
  }

  _activeCallConvId = _activeDmId;
  _callParticipants = [];

  const me = _currentUser?.username;
  const others = conv.members.filter(m => m.username !== me).map(m => m.username);
  const convName = conv.type === 'dm' ? me : conv.name;

  for (const username of others) {
    if (_voiceWs?.readyState === 1) {
      _voiceWs.send(JSON.stringify({
        type: 'call-invite',
        to: username,
        convId: conv.id,
        convName,
      }));
    }
  }

  _updateCallUI();
}

function acceptCall() {
  if (!_incomingCallInfo) return;
  const { from, convId } = _incomingCallInfo;
  _incomingCallInfo = null;
  _hideIncomingCall();

  (async () => {
    try {
      if (!_localStream) {
        _localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      }
    } catch {
      alert('Could not access your microphone.');
      return;
    }

    _activeCallConvId = convId;
    _callParticipants = [from];

    if (_voiceWs?.readyState === 1) {
      _voiceWs.send(JSON.stringify({ type: 'call-accept', to: from, convId }));
    }

    // Navigate to the conversation if not already viewing it
    if (_activeDmId !== convId) await openConversation(convId);

    _updateCallUI();
  })();
}

function rejectCall() {
  if (!_incomingCallInfo) return;
  const { from, convId } = _incomingCallInfo;
  _incomingCallInfo = null;
  _hideIncomingCall();
  if (_voiceWs?.readyState === 1) {
    _voiceWs.send(JSON.stringify({ type: 'call-reject', to: from, convId }));
  }
}

function endCall() {
  if (!_activeCallConvId) return;
  const convId = _activeCallConvId;
  for (const username of _callParticipants) {
    _voiceWs?.readyState === 1 &&
      _voiceWs.send(JSON.stringify({ type: 'call-end', to: username, convId }));
  }
  _cleanupCall();
}

function _cleanupCall() {
  for (const username of Object.keys(_callPeers)) _callClosePeer(username);
  _activeCallConvId = null;
  _callParticipants = [];
  // Only stop the local stream if not also in a voice room
  if (!_voiceRoom && _localStream) {
    _localStream.getTracks().forEach(t => t.stop());
    _localStream = null;
  }
  _updateCallUI();
}

function _showIncomingCall(from, label) {
  const overlay = document.getElementById('call-overlay');
  const nameEl  = document.getElementById('call-caller-name');
  if (!overlay) return;
  if (nameEl) nameEl.textContent = label || from;
  overlay.classList.remove('hidden');
}

function _hideIncomingCall() {
  document.getElementById('call-overlay')?.classList.add('hidden');
}

function _showCallToast(text) {
  let toast = document.getElementById('call-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'call-toast';
    toast.className = 'call-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = text;
  toast.classList.add('visible');
  clearTimeout(toast._timeout);
  toast._timeout = setTimeout(() => toast.classList.remove('visible'), 3000);
}

function _updateCallUI() {
  const callBtn   = document.getElementById('dm-call-btn');
  const indicator = document.getElementById('dm-call-indicator');
  if (!callBtn || !indicator) return;
  const inThisConv = _activeCallConvId === _activeDmId;
  indicator.classList.toggle('hidden', !inThisConv);
  callBtn.classList.toggle('active-call', !!_activeCallConvId);
  callBtn.title = _activeCallConvId ? 'End Call' : 'Voice Call';
}

// ─── Call WebRTC helpers ──────────────────────────────────────────────────────

function _callNewPeerConnection(username) {
  if (_callPeers[username]) _callClosePeer(username);
  const pc = new RTCPeerConnection(STUN_SERVERS);
  _callPeers[username] = pc;

  if (_localStream) {
    for (const track of _localStream.getTracks()) pc.addTrack(track, _localStream);
  }

  pc.ontrack = e => {
    let audio = document.getElementById(`call-audio-${username}`);
    if (!audio) {
      audio = document.createElement('audio');
      audio.id = `call-audio-${username}`;
      audio.autoplay = true;
      document.body.appendChild(audio);
    }
    audio.srcObject = e.streams[0];
  };

  pc.onicecandidate = e => {
    if (e.candidate && _voiceWs?.readyState === 1) {
      _voiceWs.send(JSON.stringify({
        type: 'call-ice', to: username,
        candidate: e.candidate, convId: _activeCallConvId,
      }));
    }
  };

  pc.onconnectionstatechange = () => {
    if (['failed','disconnected','closed'].includes(pc.connectionState)) _callClosePeer(username);
  };

  return pc;
}

async function _callCreateOffer(username) {
  const pc = _callNewPeerConnection(username);
  const offer = await pc.createOffer({ offerToReceiveAudio: true });
  await pc.setLocalDescription(offer);
  _voiceWs.send(JSON.stringify({
    type: 'call-offer', to: username,
    sdp: pc.localDescription, convId: _activeCallConvId,
  }));
}

async function _callHandleOffer(from, sdp) {
  if (!_activeCallConvId) return;
  if (!_callParticipants.includes(from)) _callParticipants.push(from);
  const pc = _callNewPeerConnection(from);
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  _voiceWs.send(JSON.stringify({
    type: 'call-answer', to: from,
    sdp: pc.localDescription, convId: _activeCallConvId,
  }));
}

async function _callHandleAnswer(from, sdp) {
  const pc = _callPeers[from];
  if (!pc) return;
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
}

async function _callHandleIce(from, candidate) {
  const pc = _callPeers[from];
  if (!pc) return;
  try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
}

function _callClosePeer(username) {
  if (_callPeers[username]) {
    _callPeers[username].close();
    delete _callPeers[username];
  }
  document.getElementById(`call-audio-${username}`)?.remove();
}

// ─── Speaking detection ───────────────────────────────────────────────────────

function _startSpeakingDetection(stream) {
  try {
    const ctx    = new AudioContext();
    const src    = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    const buf = new Uint8Array(analyser.frequencyBinCount);
    let wasSpeaking = false;

    setInterval(() => {
      if (!_voiceRoom) return;
      analyser.getByteFrequencyData(buf);
      const vol = buf.reduce((a, b) => a + b, 0) / buf.length;
      const speaking = vol > 10 && !_isMuted;
      if (speaking !== wasSpeaking) {
        wasSpeaking = speaking;
        if (_voiceWs?.readyState === 1) {
          _voiceWs.send(JSON.stringify({ type: 'voice-speaking', speaking }));
        }
        _updateSpeakingIndicator(_currentUser?.username, speaking);
      }
    }, 150);
  } catch {}
}

function _updateSpeakingIndicator(username, speaking) {
  const el = document.getElementById(`vuser-${username}`);
  if (!el) return;
  el.classList.toggle('speaking', speaking);
  clearTimeout(_speakingTimers[username]);
  if (speaking) {
    _speakingTimers[username] = setTimeout(() => {
      el?.classList.remove('speaking');
    }, 800);
  }
}

// ─── UI ───────────────────────────────────────────────────────────────────────

async function joinVoice(roomId) {
  if (_voiceRoom === roomId) return; // already in this room
  if (!_voiceWs || _voiceWs.readyState !== 1) {
    alert('Voice not connected yet. Try again in a moment.'); return;
  }

  // Request microphone
  try {
    _localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    _startSpeakingDetection(_localStream);
  } catch {
    alert('Could not access your microphone. Please allow microphone access and try again.');
    return;
  }

  _voiceWs.send(JSON.stringify({ type: 'join-voice', roomId }));
}

function leaveVoice() {
  if (_voiceWs?.readyState === 1) _voiceWs.send(JSON.stringify({ type: 'leave-voice' }));
  _cleanupVoice();
}

function toggleMute() {
  _isMuted = !_isMuted;
  if (_localStream) {
    for (const track of _localStream.getAudioTracks()) track.enabled = !_isMuted;
  }
  const btn = document.getElementById('vsb-mute-btn');
  if (btn) {
    btn.textContent = _isMuted ? '🔇' : '🎤';
    btn.classList.toggle('muted', _isMuted);
  }
}

function _updateVoiceStatusBar() {
  const bar = document.getElementById('voice-status-bar');
  if (!bar) return;
  if (_voiceRoom) {
    const rooms = document.querySelectorAll('.voice-room-item');
    let name = _voiceRoom;
    rooms.forEach(el => { if (el.dataset.roomId === _voiceRoom) name = el.dataset.roomName; });
    document.getElementById('vsb-room-name').textContent = name;
    bar.classList.remove('hidden');
  } else {
    bar.classList.add('hidden');
  }
}

function renderVoiceRoom(roomId, members) {
  const el = document.getElementById(`vroom-${roomId}`);
  if (!el) { renderAllVoiceRooms(); return; }
  if (members !== null) {
    const memberList = el.querySelector('.voice-member-list');
    if (memberList) {
      memberList.innerHTML = members.map(u => `
        <div class="voice-member" id="vuser-${u}">
          <span class="voice-member-dot ${_voiceRoom === roomId && u === _currentUser?.username ? 'self' : ''}"></span>
          <span class="voice-member-name">${escapeHtml(u)}</span>
          ${_voiceRoom === roomId && u === _currentUser?.username && _isMuted ? '<span class="voice-muted-icon">🔇</span>' : ''}
        </div>`).join('');
    }
    const countEl = el.querySelector('.voice-room-count');
    if (countEl) countEl.textContent = members.length > 0 ? members.length : '';
  }
  // Highlight active room
  el.classList.toggle('active', _voiceRoom === roomId);
}

async function renderAllVoiceRooms() {
  const el = document.getElementById('voice-rooms-list');
  if (!el) return;
  const rooms = await api('GET', '/api/voice/rooms');
  if (!rooms) return;

  el.innerHTML = rooms.map(r => `
    <div class="voice-room-item ${_voiceRoom === r.id ? 'active' : ''}"
         id="vroom-${r.id}" data-room-id="${r.id}" data-room-name="${escapeHtml(r.name)}"
         onclick="joinVoice('${r.id}')">
      <span class="voice-room-emoji">${r.emoji}</span>
      <span class="voice-room-name">${escapeHtml(r.name)}</span>
      ${r.members.length > 0 ? `<span class="voice-room-count">${r.members.length}</span>` : ''}
      ${_voiceRoom === r.id ? '<span class="voice-in-room">●</span>' : ''}
      <div class="voice-member-list">
        ${r.members.map(u => `
          <div class="voice-member" id="vuser-${u}">
            <span class="voice-member-dot ${u === _currentUser?.username ? 'self' : ''}"></span>
            <span class="voice-member-name">${escapeHtml(u)}</span>
          </div>`).join('')}
      </div>
    </div>`).join('');
}

// ─── Appearance preferences ───────────────────────────────────────────────────

function loadPreferences() {
  applyDarkMode(localStorage.getItem('nrn_dark')    === '1');
  applyCompact( localStorage.getItem('nrn_compact') === '1');
}

function applyDarkMode(on) {
  document.body.classList.toggle('dark', on);
  localStorage.setItem('nrn_dark', on ? '1' : '0');
  const cb = document.getElementById('pref-dark-mode');
  if (cb) cb.checked = on;
}

function applyCompact(on) {
  document.body.classList.toggle('compact', on);
  localStorage.setItem('nrn_compact', on ? '1' : '0');
  const cb = document.getElementById('pref-compact');
  if (cb) cb.checked = on;
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

// Fetch and display MOTD on login page
(async function loadMotd() {
  try {
    const data = await fetch('/api/motd').then(r => r.json()).catch(() => null);
    if (data?.motd) {
      const el = document.createElement('p');
      el.className = 'motd-text';
      el.textContent = data.motd;
      document.querySelector('.login-card')?.insertBefore(el, document.querySelector('.form-group'));
    }
  } catch {}
})();

window.addEventListener('DOMContentLoaded', () => { loadPreferences(); init(); });
