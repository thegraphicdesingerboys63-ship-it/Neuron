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

const getToken   = ()  => localStorage.getItem('nrn_jwt');
const setToken   = t   => localStorage.setItem('nrn_jwt', t);
const clearToken = ()  => localStorage.removeItem('nrn_jwt');

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

function showApp() {
  showPage('app');
  const cu = _currentUser;
  document.getElementById('header-username').textContent = cu.username;
  document.getElementById('header-owner-badge').classList.toggle('hidden', !amIOwnerOrAbove());
  document.getElementById('admin-panel-btn').classList.toggle('hidden',    !amIOwnerOrAbove());
  document.getElementById('chat-tabs').classList.toggle('hidden',          !amIAdminOrAbove());

  // Reset to general on login
  _channel = 'general';
  document.getElementById('messages-container').classList.remove('staff-channel');
  document.getElementById('message-input').placeholder = 'Send a message…';
  document.querySelectorAll('.chat-tab-btn').forEach(b => b.classList.remove('active'));
  const gTab = document.getElementById('ctab-general');
  if (gTab) gTab.classList.add('active');

  renderAnnouncements();
  renderMessages();
  renderUsers();
  document.getElementById('message-input').focus();

  if (!window._pollInterval) {
    window._pollInterval = setInterval(async () => {
      // Refresh own role silently — picks up mid-session promotions
      const me = await api('GET', '/api/me');
      if (me) _currentUser = me;
      renderAnnouncements();
      renderMessages();
      renderUsers();
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
  input.value = '';

  const isUrl = /^https?:\/\//i.test(text);
  await api('POST', '/api/messages', {
    content: text,
    type:    isUrl ? 'link' : 'text',
    linkUrl: isUrl ? text   : undefined,
    replyTo: _replyToId || undefined,
    channel: _channel,
  });

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

function handleImageUpload(e) {
  const file = e.target.files[0]; if (!file) return;
  if (file.size > 2 * 1024 * 1024) { alert('Image must be under 2 MB.'); e.target.value = ''; return; }
  const r = new FileReader();
  r.onload = ev => sendMediaMessage('image', ev.target.result, file.name);
  r.readAsDataURL(file); e.target.value = '';
}

function handleVideoUpload(e) {
  const file = e.target.files[0]; if (!file) return;
  if (file.size > 10 * 1024 * 1024) { alert('Video must be under 10 MB.'); e.target.value = ''; return; }
  const r = new FileReader();
  r.onload = ev => sendMediaMessage('video', ev.target.result, file.name);
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
    } else {
      contentHtml = `<span>${linkify(msg.content)}</span>`;
    }

    const likes    = msg.reactions.like.length;
    const dislikes = msg.reactions.dislike.length;
    const liked    = msg.reactions.like.includes(cu);
    const disliked = msg.reactions.dislike.includes(cu);
    const canReport = msg.author !== cu && _channel === 'general';

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
  const priLabel = amISupreme() && r.priority
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
      ${isPend ? `
      <div class="report-actions">
        <button class="btn-dismiss" onclick="dismissReport('${r.id}')">Dismiss</button>
        ${msg && !msg.deleted ? `<button class="btn-del-msg" onclick="reportDeleteMsg('${r.msg_id}','${r.id}')">Delete Message</button>` : ''}
        ${msg && !msg.deleted ? `<button class="btn-del-ban" onclick="reportDeleteAndBan('${r.msg_id}','${target}','${r.id}')">Delete + Ban</button>` : ''}
      </div>` : ''}
    </div>`;
}

// ─── Admin panel ──────────────────────────────────────────────────────────────

function openAdminPanel() {
  if (!amIOwnerOrAbove()) return;
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
}

async function renderAdminUsers() {
  const users = await api('GET', '/api/admin/users');
  const el    = document.getElementById('admin-users-list');
  if (!el || users === null) return;

  const cu      = _currentUser?.username;
  const others  = users.filter(u => u.username !== cu);

  if (others.length === 0) {
    el.innerHTML = '<p style="color:var(--gray-30);font-size:13px;padding:8px 0;">No other users yet.</p>';
    return;
  }

  el.innerHTML = `
    <table class="admin-table">
      <thead><tr><th>Username</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>
        ${others.map(u => {
          const banned  = u.banned;
          const banInfo = !banned ? 'Active'
            : !u.bannedUntil ? 'Permanently banned'
            : `Banned until ${new Date(u.bannedUntil).toLocaleString()}`;
          return `
            <tr class="${banned ? 'banned-row' : ''}">
              <td>${escapeHtml(u.username)}</td>
              <td>${escapeHtml(u.displayRole)}</td>
              <td>${banInfo}</td>
              <td class="admin-actions">${_adminActions(u)}</td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

function _adminActions(u) {
  const myRole  = _currentUser?.role;
  const canMgr  = myRole === 'supreme' || (myRole === 'owner' && (u.role === 'user' || u.role === 'admin'));

  if (!canMgr) return '<span class="owner-protected">Owner — Protected</span>';

  const isAdminRole = u.role === 'admin';
  const isOwnerRole = u.role === 'owner';

  return `
    ${!isAdminRole && !isOwnerRole ? `<button class="admin-action-btn promote" onclick="grantAdmin('${u.username}')">Grant Admin</button>` : ''}
    ${isAdminRole                  ? `<button class="admin-action-btn demote"  onclick="revokeAdmin('${u.username}')">Revoke Admin</button>` : ''}
    ${!u.banned  ? `<button class="admin-action-btn ban"   onclick="openBanModal('${u.username}')">Ban</button>` : ''}
    ${u.banned   ? `<button class="admin-action-btn unban" onclick="adminUnban('${u.username}')">Unban</button>` : ''}
    <button class="admin-action-btn delete" onclick="adminDeleteAccount('${u.username}')">Delete</button>
    ${amISupreme() && !isOwnerRole ? `<button class="admin-action-btn owner-promote" onclick="promoteToOwner('${u.username}')">Make Owner</button>` : ''}
  `;
}

function renderDangerZone() {
  const el = document.getElementById('danger-zone');
  if (!el) return;
  if (!amISupreme()) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <div class="danger-zone">
      <h4>Maintenance</h4>
      <button class="btn-danger" onclick="clearAllMessages()">Clear All Chat Messages</button>
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

window.addEventListener('DOMContentLoaded', () => { loadPreferences(); init(); });
