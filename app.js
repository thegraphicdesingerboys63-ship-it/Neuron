/* ═══════════════════════════════════════════════════════════════════════════
   Neuron — app.js  (complete frontend, Discord-style)
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
let currentUser      = null;
let currentServerId  = null;
let currentChannelId = null;
let currentChannel   = null;
let currentDmId      = null;
let serverData       = {};   // { [serverId]: { server, channels, categories, members } }
let myServers        = [];
let pollInterval     = null;
let lastMsgTimestamp = null;
let replyTo          = null;
let dmReplyTo        = null;
let reportMsgId      = null;
let pendingPollChannelId = null;

// Voice / call
let ws               = null;
let wsReady          = false;
let localStream      = null;
let peerConnections  = {};
let currentVoiceRoom = null;
let isMuted          = false;
let callState        = null; // { convId, with }
let callMuted        = false;
let incomingCall     = null;

// ─── Constants ────────────────────────────────────────────────────────────────
// Platform role colors: user < mod < manager < admin < owner < supreme
const ROLE_COLORS = { supreme:'#ff4ecd', owner:'#f9a825', admin:'#7c4dff', manager:'#00bcd4', mod:'#57f287', user:'#9e9e9e' };
const SR_COLORS   = { owner:'#f9a825', admin:'#7c4dff', mod:'#00bcd4', member:'#9e9e9e' };
const ROLE_RANK   = { user:0, mod:1, manager:2, admin:3, owner:4, supreme:5 };

// ─── Utilities ────────────────────────────────────────────────────────────────
function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

function linkify(s) {
  if (!s) return '';
  return renderMentions(s).replace(/(https?:\/\/[^\s<"]+)/g,'<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
}

function renderMentions(text) {
  if (!text) return escapeHtml(text || '');
  return escapeHtml(text).replace(/@(\w{3,15})/g, (full, uname) => {
    if (uname === 'everyone' || uname === 'here')
      return `<span class="mention mention-everyone">${full}</span>`;
    const isSelf = uname.toLowerCase() === (currentUser?.username || '').toLowerCase();
    return `<span class="mention${isSelf ? ' mention-self' : ''}" onclick="showUserDetails('${uname}')">${full}</span>`;
  });
}

function fmtTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
}

function fmtDate(ts) {
  if (!ts) return '';
  const d     = new Date(ts); d.setHours(0,0,0,0);
  const today = new Date();   today.setHours(0,0,0,0);
  const yest  = new Date(today); yest.setDate(yest.getDate()-1);
  if (d.getTime()===today.getTime()) return 'Today';
  if (d.getTime()===yest.getTime())  return 'Yesterday';
  return d.toLocaleDateString([], { month:'short', day:'numeric', year:'numeric' });
}

function fmtDateFull(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString([], { month:'short', day:'numeric', year:'numeric', hour:'2-digit', minute:'2-digit' });
}

function el(id) { return document.getElementById(id); }
function show(id) { el(id)?.classList.remove('hidden'); }
function hide(id) { el(id)?.classList.add('hidden'); }
function toggle(id) { el(id)?.classList.toggle('hidden'); }

function toast(msg, type='info') {
  const d = document.createElement('div');
  d.className = `toast toast-${type}`;
  d.textContent = msg;
  document.body.appendChild(d);
  setTimeout(()=>d.remove(), 3200);
}

function safeParseJson(str, fallback) {
  try { return typeof str === 'string' ? JSON.parse(str) : str; }
  catch { return fallback; }
}

// ─── API Helper ───────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const token = localStorage.getItem('neuron_token');
  const opts  = { method, headers: { 'Content-Type':'application/json' } };
  if (token) opts.headers['Authorization'] = 'Bearer ' + token;
  if (body !== undefined) opts.body = JSON.stringify(body);
  try {
    const res  = await fetch(path, opts);
    const data = await res.json().catch(()=>({ error:'Invalid response' }));
    return data;
  } catch { return { error:'Network error' }; }
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────
async function handleLogin() {
  const username = el('username-input').value.trim();
  const password = el('password-input').value;
  const errEl    = el('login-error');
  errEl.classList.add('hidden');
  if (!username || !password) {
    errEl.textContent = 'Enter username and password.';
    errEl.classList.remove('hidden');
    return;
  }
  const data = await api('POST', '/api/auth/login', { username, password });
  if (data.error) {
    errEl.textContent = data.error;
    errEl.classList.remove('hidden');
    return;
  }
  localStorage.setItem('neuron_token', data.token);
  await initApp();
}

async function handleLogout() {
  stopPolling();
  disconnectWs();
  localStorage.removeItem('neuron_token');
  currentUser = null; currentServerId = null; currentChannelId = null; currentDmId = null;
  show('login-page'); hide('app-page');
}

async function acceptTos() {
  const data = await api('POST', '/api/tos/accept');
  if (data.error) { toast(data.error, 'error'); return; }
  currentUser.tos_accepted = 1;
  hide('tos-modal');
  await bootApp();
}

// ─── INIT ─────────────────────────────────────────────────────────────────────
async function initApp() {
  const data = await api('GET', '/api/me');
  if (data.error) { localStorage.removeItem('neuron_token'); return; }
  currentUser = data;

  hide('login-page'); show('app-page');
  applyTheme(localStorage.getItem('neuron_theme') || (localStorage.getItem('neuron_dark') === '1' ? 'dark' : 'light'));
  applyCompact(localStorage.getItem('neuron_compact') === '1');

  if (!currentUser.tos_accepted) { show('tos-modal'); return; }
  await bootApp();
}

async function bootApp() {
  renderUserInfoBar();
  await loadServers();
  renderServerRail();
  switchToHome();
  loadDms();
  loadFriends();
  startPolling();
  connectWs();
}

async function loadServers() {
  const data = await api('GET', '/api/servers');
  myServers = Array.isArray(data) ? data : (data.servers || []);
}

function renderUserInfoBar() {
  const displayName = currentUser.display_name || currentUser.username;
  el('uib-avatar').textContent   = displayName[0].toUpperCase();
  el('uib-username').textContent = displayName;
  const role = currentUser.role;
  el('uib-role').textContent = role.charAt(0).toUpperCase() + role.slice(1);
  el('uib-role').style.color = ROLE_COLORS[role] || '#9e9e9e';
  const isAdmin = (ROLE_RANK[role] ?? 0) >= ROLE_RANK['mod'];
  if (isAdmin) show('global-admin-btn'); else hide('global-admin-btn');
}

// ─── SERVER RAIL ──────────────────────────────────────────────────────────────
function renderServerRail() {
  const list = el('server-icons-list');
  list.innerHTML = '';
  myServers.forEach(srv => {
    const d = document.createElement('div');
    d.className  = 'rail-icon server-icon' + (srv.id === currentServerId ? ' active' : '');
    d.dataset.id = srv.id;
    d.innerHTML  = `${escapeHtml(srv.icon_emoji || '🌐')}<span class="rail-tooltip">${escapeHtml(srv.name)}</span>`;
    d.onclick    = () => switchToServer(srv.id);
    list.appendChild(d);
  });
}

// ─── SERVER SWITCH ────────────────────────────────────────────────────────────
async function switchToServer(serverId) {
  currentServerId  = serverId;
  currentChannelId = null;
  currentDmId      = null;

  document.querySelectorAll('.rail-icon.server-icon').forEach(i => i.classList.toggle('active', i.dataset.id === serverId));
  el('rail-home').classList.remove('active');

  hide('home-panel'); show('server-panel');
  hide('dm-view'); show('chat-empty'); hide('chat-view');

  const srv = myServers.find(s => s.id === serverId);
  el('server-panel-name').textContent = srv?.name || 'Server';

  hide('server-dropdown');
  await loadServerData(serverId);
  renderChannelList();
  renderMemberPanel();
  buildServerDropdown();
  show('member-panel');
}

async function loadServerData(serverId) {
  const data = await api('GET', `/api/servers/${serverId}`);
  serverData[serverId] = {
    server:     myServers.find(s => s.id === serverId) || {},
    categories: data.categories || [],
    channels:   data.channels   || [],
    members:    data.members    || [],
  };
}

// ─── CHANNEL LIST ─────────────────────────────────────────────────────────────
function renderChannelList() {
  const sd = serverData[currentServerId];
  if (!sd) return;
  const list = el('channels-list');
  list.innerHTML = '';

  const me      = sd.members.find(m => m.username === currentUser.username);
  const canEdit = me && (me.display_role === 'owner' || me.display_role === 'admin');

  // build category map
  const byCategory = {};
  sd.categories.forEach(c => { byCategory[c.id] = { cat:c, channels:[] }; });
  const uncategorized = [];
  sd.channels.forEach(ch => {
    if (ch.category_id && byCategory[ch.category_id]) byCategory[ch.category_id].channels.push(ch);
    else uncategorized.push(ch);
  });

  uncategorized.forEach(ch => list.appendChild(makeChannelEl(ch, canEdit)));

  sd.categories.slice().sort((a,b) => a.position - b.position).forEach(cat => {
    const group = byCategory[cat.id];
    if (!group) return;

    const catEl = document.createElement('div');
    catEl.className = 'channel-category';

    const hdr = document.createElement('div');
    hdr.className = 'category-header';
    hdr.innerHTML = `<span class="cat-arrow">▾</span><span class="cat-name">${escapeHtml(cat.name)}</span>`;

    if (canEdit) {
      const addBtn = document.createElement('button');
      addBtn.className   = 'cat-add-btn';
      addBtn.title       = 'Add Channel';
      addBtn.textContent = '+';
      addBtn.onclick     = e => { e.stopPropagation(); openAddChannelModal(cat.id); };
      hdr.appendChild(addBtn);
    }

    hdr.onclick = () => {
      catEl.classList.toggle('collapsed');
      hdr.querySelector('.cat-arrow').textContent = catEl.classList.contains('collapsed') ? '▸' : '▾';
    };
    catEl.appendChild(hdr);

    const chList = document.createElement('div');
    chList.className = 'category-channels';
    group.channels.slice().sort((a,b) => a.position - b.position).forEach(ch => chList.appendChild(makeChannelEl(ch, canEdit)));
    catEl.appendChild(chList);
    list.appendChild(catEl);
  });
}

function makeChannelEl(ch, canEdit) {
  const d = document.createElement('div');
  d.className  = 'channel-item' + (ch.id === currentChannelId ? ' active' : '');
  d.dataset.id = ch.id;
  const icon   = ch.type === 'voice' ? '🔊' : ch.type === 'announcement' ? '📢' : '#';
  d.innerHTML  = `<span class="ch-prefix">${icon}</span><span class="ch-item-name">${escapeHtml(ch.name)}</span>`;
  d.onclick    = ch.type === 'voice' ? () => joinVoiceChannel(ch) : () => openChannel(ch);

  if (canEdit) {
    const gear = document.createElement('span');
    gear.className   = 'ch-edit-btn';
    gear.textContent = '⚙';
    gear.title       = 'Channel settings';
    gear.onclick     = e => { e.stopPropagation(); promptEditChannel(ch); };
    d.appendChild(gear);
  }
  return d;
}

// ─── CHANNEL OPEN ─────────────────────────────────────────────────────────────
async function openChannel(ch) {
  currentChannelId = ch.id;
  currentChannel   = ch;
  currentDmId      = null;
  lastMsgTimestamp = null;
  replyTo          = null;

  document.querySelectorAll('.channel-item').forEach(i => i.classList.toggle('active', i.dataset.id === ch.id));

  hide('chat-empty'); hide('dm-view'); show('chat-view');
  el('ch-icon').textContent  = ch.type === 'announcement' ? '📢' : '#';
  el('ch-name').textContent  = ch.name;
  el('ch-topic').textContent = ch.topic || '';
  el('messages-container').innerHTML = '';
  hide('reply-preview');
  hide('link-input-row');
  initMentionAutocomplete('message-input', 'mention-dropdown');

  await fetchMessages();
  scrollMsgs();
}

async function fetchMessages() {
  if (!currentChannelId) return;
  const data = await api('GET', `/api/channels/${currentChannelId}/messages`);
  if (!data || data.error) return;
  const msgs = data.messages || [];
  renderMessages(msgs);
  lastMsgTimestamp = msgs.length ? msgs[msgs.length - 1].timestamp : null;
}

async function pollNewMessages() {
  if (!currentChannelId || !lastMsgTimestamp) return;
  const data = await api('GET', `/api/channels/${currentChannelId}/messages?after=${encodeURIComponent(lastMsgTimestamp)}`);
  if (!data || data.error) return;
  const msgs = data.messages || [];
  if (!msgs.length) return;
  msgs.forEach(m => appendOneMessage(m));
  lastMsgTimestamp = msgs[msgs.length - 1].timestamp;
  scrollMsgs();
  notifyNewMsg();
}

function renderMessages(msgs) {
  const c = el('messages-container');
  c.innerHTML = '';
  if (!msgs.length) {
    c.innerHTML = '<div class="msgs-empty">No messages yet. Say hello!</div>';
    return;
  }
  let lastAuthor = '', lastDate = '';
  msgs.forEach(m => {
    const d = fmtDate(m.timestamp);
    if (d !== lastDate) {
      const div = document.createElement('div');
      div.className = 'date-divider';
      div.innerHTML = '<span>' + escapeHtml(d) + '</span>';
      c.appendChild(div);
      lastDate = d; lastAuthor = '';
    }
    const grouped = m.author === lastAuthor && m.type !== 'system' && m.type !== 'poll';
    c.appendChild(buildMsgEl(m, grouped));
    lastAuthor = m.author;
  });
  scrollMsgs();
}

function appendOneMessage(m) {
  const c = el('messages-container');
  const last = c.querySelector('.msg-wrap:last-child');
  const lastAuthor = last ? last.dataset.author : '';
  const grouped = m.author === lastAuthor && m.type !== 'system' && m.type !== 'poll';
  c.appendChild(buildMsgEl(m, grouped));
}

function appendMessages(msgs) {
  msgs.forEach(m => appendOneMessage(m));
  scrollMsgs();
}

function buildMsgEl(m, grouped) {
  const wrap = document.createElement('div');
  wrap.className = 'msg-wrap';
  wrap.dataset.id = m.id;
  wrap.dataset.author = m.author || '';

  try {
    if (m.type === 'system') {
      wrap.className += ' msg-system';
      wrap.textContent = m.content || '';
      return wrap;
    }

    const displayName = (m.display_name || m.author || '?');
    const role = m.author_role || '';
    const roleColor = ROLE_COLORS[role] || 'var(--text-secondary)';

    // ping highlight
    const myName = currentUser?.username || '';
    const pingMe = myName && m.content && new RegExp('@' + myName + '(?:\\W|$)', 'i').test(m.content);
    if (pingMe) wrap.classList.add('ping-highlight');

    // body
    let body;
    if (m.deleted) {
      body = '<em style="color:var(--text-muted)">Message deleted</em>';
    } else if (m.type === 'image') {
      body = '<img src="' + escapeHtml(m.media_url || '') + '" class="msg-media" style="max-width:300px;max-height:300px;border-radius:8px;display:block;cursor:pointer" onclick="openImageViewer(this.src)">';
    } else if (m.type === 'link') {
      body = '<a href="' + escapeHtml(m.link_url || '') + '" target="_blank" rel="noopener" style="color:var(--text-link)">' + escapeHtml(m.content || m.link_url || '') + '</a>';
    } else {
      body = linkify(m.content || '');
    }

    if (grouped) {
      wrap.innerHTML =
        '<div style="display:flex;gap:14px;padding:1px 16px 1px 16px;position:relative" class="msg-inner">' +
          '<div style="width:40px;flex-shrink:0;text-align:right;font-size:10px;color:transparent;line-height:20px" class="msg-ts-grouped">' + fmtTime(m.timestamp) + '</div>' +
          '<div style="flex:1;min-width:0;font-size:14px;line-height:1.4;color:var(--text-primary)">' + body + '</div>' +
        '</div>';
    } else {
      wrap.innerHTML =
        '<div style="display:flex;gap:14px;padding:4px 16px;position:relative" class="msg-inner">' +
          '<div style="width:40px;height:40px;border-radius:50%;background:var(--bg-tertiary);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;flex-shrink:0;align-self:flex-start;margin-top:2px">' + escapeHtml(displayName[0].toUpperCase()) + '</div>' +
          '<div style="flex:1;min-width:0">' +
            '<div style="display:flex;align-items:baseline;gap:8px;margin-bottom:2px">' +
              '<span style="font-weight:700;font-size:14px;cursor:pointer;color:' + roleColor + '" class="msg-author-name">' + escapeHtml(displayName) + '</span>' +
              (role ? '<span style="font-size:10px;font-weight:700;padding:1px 6px;border-radius:99px;background:' + roleColor + '22;color:' + roleColor + '">' + escapeHtml(role) + '</span>' : '') +
              '<span style="font-size:11px;color:var(--text-muted)">' + fmtTime(m.timestamp) + '</span>' +
              (m.pinned ? '<span style="font-size:12px">📌</span>' : '') +
            '</div>' +
            '<div style="font-size:14px;line-height:1.4;color:var(--text-primary)">' + body + '</div>' +
          '</div>' +
        '</div>';
    }

    // hover actions
    const inner = wrap.querySelector('.msg-inner');
    if (inner) {
      const actions = document.createElement('div');
      actions.className = 'msg-hover-actions';
      actions.style.cssText = 'display:none;position:absolute;right:12px;top:50%;transform:translateY(-50%);background:var(--bg-modal);border:1px solid var(--border);border-radius:6px;padding:3px;gap:2px;z-index:20';

      const btns = [
        { label: '↩', title: 'Reply', fn: () => setReply(m.id, m.author, (m.content||'').slice(0,40)) },
        { label: '👍', title: 'React', fn: () => reactToMsg(m.id) },
      ];
      const isMe = m.author === currentUser?.username;
      const sd = serverData[currentServerId];
      const myMember = sd?.members?.find(mb => mb.username === currentUser?.username);
      const isMod = myMember && ['owner','admin','mod'].includes(myMember.display_role);
      const isPlatAdmin = ['supreme','owner','admin'].includes(currentUser?.role);
      if (isMe || isMod || isPlatAdmin) btns.push({ label: '🗑', title: 'Delete', fn: () => deleteMsg(m.id) });
      if (isMod || isPlatAdmin) btns.push({ label: '📌', title: 'Pin', fn: () => pinMsg(m.id) });
      if (!isMe) btns.push({ label: '⚑', title: 'Report', fn: () => openReportModal(m.id) });

      btns.forEach(b => {
        const btn = document.createElement('button');
        btn.title = b.title;
        btn.textContent = b.label;
        btn.style.cssText = 'border:none;background:transparent;cursor:pointer;width:28px;height:28px;border-radius:4px;font-size:14px;color:var(--text-muted)';
        btn.onmouseenter = () => btn.style.background = 'var(--bg-hover)';
        btn.onmouseleave = () => btn.style.background = 'transparent';
        btn.onclick = e => { e.stopPropagation(); b.fn(); };
        actions.appendChild(btn);
      });

      inner.style.position = 'relative';
      inner.appendChild(actions);
      inner.onmouseenter = () => { actions.style.display = 'flex'; if (grouped) wrap.querySelector('.msg-ts-grouped') && (wrap.querySelector('.msg-ts-grouped').style.color = 'var(--text-muted)'); };
      inner.onmouseleave = () => { actions.style.display = 'none'; if (grouped) wrap.querySelector('.msg-ts-grouped') && (wrap.querySelector('.msg-ts-grouped').style.color = 'transparent'); };
    }

    // author click
    const authorEl = wrap.querySelector('.msg-author-name');
    if (authorEl) authorEl.onclick = () => showUserDetails(m.author);

  } catch (err) {
    console.error('buildMsgEl error:', err, m);
    wrap.textContent = '[Error rendering message]';
  }

  return wrap;
}

// ─── POLL CARD ────────────────────────────────────────────────────────────────
function makePollCard(m) {
  const p       = m.poll_data || {};
  const options = safeParseJson(p.options, []);
  const votes   = p.votes    || {};
  const total   = Object.values(votes).reduce((a,b) => a + b, 0);
  const ended   = p.ends_at && new Date(p.ends_at) < new Date();
  const myVotes = p.my_votes || [];
  const pollId  = escapeHtml(p.id || m.poll_id || m.id);

  const optsHtml = options.map((opt, i) => {
    const count = votes[i] || 0;
    const pct   = total ? Math.round(count / total * 100) : 0;
    const voted = myVotes.includes(i);
    const clickable = !ended;
    return `
      <div class="poll-option${voted ? ' voted' : ''}" ${clickable ? `onclick="votePoll('${pollId}',${i})"` : ''} style="${clickable ? 'cursor:pointer' : ''}">
        <div class="poll-option-header">
          <span class="poll-opt-text">${escapeHtml(opt)}</span>
          <span class="poll-opt-count">${count} (${pct}%)</span>
        </div>
        <div class="poll-bar-bg"><div class="poll-bar-fill${voted ? ' my-vote' : ''}" style="width:${pct}%"></div></div>
      </div>`;
  }).join('');

  return `
    <div class="msg-avatar">${escapeHtml((m.author || '?')[0].toUpperCase())}</div>
    <div class="msg-content-wrap">
      <div class="msg-header">
        <span class="msg-author">${escapeHtml(m.author)}</span>
        <span class="msg-time">${fmtTime(m.timestamp)}</span>
      </div>
      <div class="poll-card">
        <div class="poll-header">
          <span class="poll-icon">📊</span>
          <span class="poll-question">${escapeHtml(p.question || m.content || 'Poll')}</span>
          ${ended ? '<span class="poll-ended-badge">Ended</span>' : ''}
          ${p.multiple_choice ? '<span class="poll-multi-badge">Multi-choice</span>' : ''}
          ${p.anonymous ? '<span class="poll-anon-badge">Anonymous</span>' : ''}
        </div>
        <div class="poll-options">${optsHtml}</div>
        <div class="poll-footer">
          ${total} total vote${total !== 1 ? 's' : ''}
          ${p.ends_at && !ended ? ' · Ends ' + fmtDateFull(p.ends_at) : ''}
        </div>
      </div>
    </div>`;
}

function scrollMsgs() {
  const c = el('messages-container');
  if (c) c.scrollTop = c.scrollHeight;
}

// ─── @MENTION AUTOCOMPLETE ────────────────────────────────────────────────────
let _mentionIdx = -1;

function initMentionAutocomplete(inputId, dropdownId) {
  const input    = el(inputId);
  const dropdown = el(dropdownId);
  if (!input || !dropdown) return;

  input.addEventListener('input', () => {
    const val   = input.value;
    const cur   = input.selectionStart;
    const at    = val.lastIndexOf('@', cur - 1);
    if (at === -1 || (at > 0 && !/\s/.test(val[at - 1]))) { hide(dropdownId); return; }
    const query = val.slice(at + 1, cur).toLowerCase();
    const sd    = serverData[currentServerId];
    const pool  = sd ? sd.members.map(m => m.username) : [];
    const hits  = pool.filter(u => u.toLowerCase().startsWith(query)).slice(0, 8);
    if (!hits.length) { hide(dropdownId); return; }
    _mentionIdx = -1;
    dropdown.innerHTML = '';
    hits.forEach((u, i) => {
      const d = document.createElement('div');
      d.className = 'mention-option';
      d.textContent = '@' + u;
      d.onclick = () => insertMention(input, dropdownId, u);
      dropdown.appendChild(d);
    });
    show(dropdownId);
  });

  input.addEventListener('keydown', e => {
    if (dropdown.classList.contains('hidden')) return;
    const items = dropdown.querySelectorAll('.mention-option');
    if (e.key === 'ArrowDown') { e.preventDefault(); _mentionIdx = Math.min(_mentionIdx + 1, items.length - 1); items.forEach((d, i) => d.classList.toggle('active', i === _mentionIdx)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); _mentionIdx = Math.max(_mentionIdx - 1, 0); items.forEach((d, i) => d.classList.toggle('active', i === _mentionIdx)); }
    else if (e.key === 'Tab' || e.key === 'Enter') {
      if (_mentionIdx >= 0 && items[_mentionIdx]) {
        e.preventDefault();
        const uname = items[_mentionIdx].textContent.slice(1);
        insertMention(input, dropdownId, uname);
      }
    } else if (e.key === 'Escape') { hide(dropdownId); }
  });

  document.addEventListener('click', e => { if (!dropdown.contains(e.target) && e.target !== input) hide(dropdownId); });
}

function insertMention(input, dropdownId, username) {
  const val = input.value;
  const cur = input.selectionStart;
  const at  = val.lastIndexOf('@', cur - 1);
  if (at === -1) return;
  input.value = val.slice(0, at) + '@' + username + ' ' + val.slice(cur);
  input.selectionStart = input.selectionEnd = at + username.length + 2;
  hide(dropdownId);
  input.focus();
}

// ─── SEND MESSAGE ─────────────────────────────────────────────────────────────
async function sendMessage() {
  const input = el('message-input');
  const text  = input.value.trim();
  if (!text || !currentChannelId) return;
  input.value = '';
  const body = { content: text };
  if (replyTo) body.reply_to = replyTo.id;
  const data = await api('POST', `/api/channels/${currentChannelId}/messages`, body);
  if (data.error) { toast(data.error, 'error'); return; }
  replyTo = null; hide('reply-preview');
  await fetchMessages();
}

async function sendLink() {
  const url   = el('link-url').value.trim();
  const label = el('link-label').value.trim();
  if (!url || !currentChannelId) return;
  const data = await api('POST', `/api/channels/${currentChannelId}/messages`, { content: label || url, type: 'link', link_url: url });
  if (data.error) { toast(data.error, 'error'); return; }
  el('link-url').value = ''; el('link-label').value = '';
  hide('link-input-row');
  await fetchMessages();
}

function toggleLinkInput() {
  toggle('link-input-row');
  hide('image-input-row');
}

function toggleImageInput() {
  toggle('image-input-row');
  hide('link-input-row');
  el('image-url')?.focus();
}

async function sendImageUrl() {
  const url = el('image-url').value.trim();
  if (!url || !currentChannelId) return;
  const data = await api('POST', `/api/channels/${currentChannelId}/messages`, { content: url, type: 'image', media_url: url });
  if (data.error) { toast(data.error, 'error'); return; }
  el('image-url').value = '';
  hide('image-input-row');
  await fetchMessages();
}

// ─── REPLY ────────────────────────────────────────────────────────────────────
function setReply(msgId, author, snippet) {
  replyTo = { id: msgId };
  el('reply-to-author').textContent = author;
  el('reply-to-text').textContent   = snippet;
  show('reply-preview');
  el('message-input').focus();
}
function cancelReply() { replyTo = null; hide('reply-preview'); }

// ─── DELETE / PIN / REACT ─────────────────────────────────────────────────────
async function deleteMsg(msgId) {
  if (!confirm('Delete this message?')) return;
  const data = await api('DELETE', `/api/channels/${currentChannelId}/messages/${msgId}`);
  if (data.error) { toast(data.error, 'error'); return; }
  const row = document.querySelector(`.message[data-id="${msgId}"]`);
  if (row) {
    row.classList.add('deleted');
    const body = row.querySelector('.msg-body');
    if (body) body.innerHTML = '<span class="msg-deleted">Message deleted</span>';
    const actions = row.querySelector('.msg-actions');
    if (actions) actions.innerHTML = '';
  }
}

async function pinMsg(msgId) {
  const data = await api('POST', `/api/channels/${currentChannelId}/messages/${msgId}/pin`);
  if (data.error) { toast(data.error, 'error'); return; }
  toast('Message pinned 📌', 'success');
}

async function reactToMsg(msgId) {
  const data = await api('POST', `/api/channels/${currentChannelId}/messages/${msgId}/react`, { emoji:'like' });
  if (data.error) { toast(data.error, 'error'); }
}

// ─── POLLS ────────────────────────────────────────────────────────────────────
function openPollModal() {
  if (!currentChannelId) return;
  pendingPollChannelId = currentChannelId;
  el('poll-question').value = '';
  el('poll-options-list').innerHTML = `
    <div class="poll-option-row"><input type="text" class="settings-input poll-opt" placeholder="Option 1"><button onclick="removePollOption(this)">✕</button></div>
    <div class="poll-option-row"><input type="text" class="settings-input poll-opt" placeholder="Option 2"><button onclick="removePollOption(this)">✕</button></div>`;
  el('poll-multi').checked    = false;
  el('poll-anon').checked     = false;
  el('poll-duration').value   = 0;
  show('poll-modal');
}
function closePollModal() { hide('poll-modal'); }

function addPollOption() {
  const list = el('poll-options-list');
  const n    = list.children.length + 1;
  const row  = document.createElement('div');
  row.className = 'poll-option-row';
  row.innerHTML = `<input type="text" class="settings-input poll-opt" placeholder="Option ${n}"><button onclick="removePollOption(this)">✕</button>`;
  list.appendChild(row);
}

function removePollOption(btn) {
  if (el('poll-options-list').children.length > 2) btn.closest('.poll-option-row').remove();
}

async function submitPoll() {
  const question = el('poll-question').value.trim();
  const options  = [...el('poll-options-list').querySelectorAll('.poll-opt')].map(i => i.value.trim()).filter(Boolean);
  if (!question || options.length < 2) { toast('Need a question and at least 2 options', 'error'); return; }
  const duration = parseInt(el('poll-duration').value) || 0;
  const body = {
    question, options,
    multiple_choice: el('poll-multi').checked,
    anonymous:       el('poll-anon').checked,
    ends_at: duration > 0 ? new Date(Date.now() + duration * 3600000).toISOString() : null,
  };
  const data = await api('POST', `/api/channels/${pendingPollChannelId}/polls`, body);
  if (data.error) { toast(data.error, 'error'); return; }
  closePollModal();
  await pollNewMessages();
}

async function votePoll(pollId, optionIndex) {
  const data = await api('POST', `/api/polls/${pollId}/vote`, { option_index: optionIndex });
  if (data.error) { toast(data.error, 'error'); return; }
  await fetchMessages(); scrollMsgs();
}

// ─── PINNED MESSAGES ──────────────────────────────────────────────────────────
async function showPinnedMessages() {
  if (!currentChannelId) return;
  show('pinned-modal');
  const data = await api('GET', `/api/channels/${currentChannelId}/messages`);
  const msgs = (data.messages || []).filter(m => m.pinned && !m.deleted);
  const c = el('pinned-content');
  if (!msgs.length) { c.innerHTML = '<p style="color:var(--text-muted);padding:16px">No pinned messages.</p>'; return; }
  c.innerHTML = msgs.map(m => `
    <div class="pinned-msg">
      <div class="pinned-author">${escapeHtml(m.author)} <span class="pinned-time">${fmtDateFull(m.timestamp)}</span></div>
      <div class="pinned-text">${linkify(m.content)}</div>
    </div>`).join('');
}
function closePinnedModal() { hide('pinned-modal'); }

// ─── REPORT ───────────────────────────────────────────────────────────────────
function openReportModal(msgId) {
  reportMsgId = msgId;
  el('report-msg-preview').textContent = 'Message ID: ' + msgId;
  el('report-reason-input').value = '';
  show('report-modal');
}
function closeReportModal() { hide('report-modal'); }

async function submitReport() {
  const reason = el('report-reason-input').value.trim();
  if (!reason) { toast('Enter a reason', 'error'); return; }
  const data = await api('POST', '/api/reports', { msg_id: reportMsgId, channel_id: currentChannelId, server_id: currentServerId, reason });
  if (data.error) { toast(data.error, 'error'); return; }
  toast('Report submitted', 'success');
  closeReportModal();
}

// ─── IMAGE VIEWER ─────────────────────────────────────────────────────────────
function openImageViewer(src) {
  const ov = document.createElement('div');
  ov.className = 'img-overlay';
  ov.innerHTML = `<img src="${escapeHtml(src)}" class="img-viewer"><button class="img-close" onclick="this.parentElement.remove()">✕</button>`;
  ov.onclick   = e => { if (e.target === ov) ov.remove(); };
  document.body.appendChild(ov);
}

// ─── MEMBER PANEL ─────────────────────────────────────────────────────────────
function renderMemberPanel() {
  const sd = serverData[currentServerId];
  if (!sd) { el('member-panel-content').innerHTML = ''; return; }
  const groups = { owner:[], admin:[], mod:[], member:[] };
  sd.members.forEach(m => { (groups[m.display_role] || groups['member']).push(m); });

  let html = '';
  [['owner','Owner'], ['admin','Admin'], ['mod','Mod'], ['member','Members']].forEach(([role, label]) => {
    if (!groups[role]?.length) return;
    html += `<div class="member-group-header" style="color:${SR_COLORS[role]}">${label} — ${groups[role].length}</div>`;
    groups[role].forEach(m => {
      html += `<div class="member-row" onclick="showUserDetails('${escapeHtml(m.username)}')">
        <div class="member-avatar" style="border-color:${SR_COLORS[m.display_role]||'#9e9e9e'}">${escapeHtml(m.username[0].toUpperCase())}</div>
        <div class="member-info">
          <span class="member-name">${escapeHtml(m.nickname || m.username)}</span>
          ${m.muted ? '<span class="member-muted-badge">muted</span>' : ''}
        </div>
      </div>`;
    });
  });
  el('member-panel-content').innerHTML = html || '<div style="padding:16px;color:var(--text-muted)">No members</div>';
}

function toggleMemberPanel() { el('member-panel').classList.toggle('hidden'); }

// ─── USER DETAILS ─────────────────────────────────────────────────────────────
function showUserDetails(username) {
  el('details-modal-title').textContent = username;
  const sd      = serverData[currentServerId];
  const m       = sd?.members.find(mb => mb.username === username);
  const platRole = m?.platform_role || '';
  const srvRole  = m?.display_role  || '';

  let html = `
    <div style="display:flex;flex-direction:column;align-items:center;gap:12px;padding:16px">
      <div class="details-avatar">${escapeHtml(username[0].toUpperCase())}</div>
      <div class="details-username">${escapeHtml(username)}</div>
      ${platRole ? `<span class="msg-role-badge" style="background:${ROLE_COLORS[platRole]||'#9e9e9e'}22;color:${ROLE_COLORS[platRole]||'#9e9e9e'}">${escapeHtml(platRole)}</span>` : ''}
      ${srvRole  ? `<span class="msg-role-badge" style="background:${SR_COLORS[srvRole]||'#9e9e9e'}22;color:${SR_COLORS[srvRole]||'#9e9e9e'}">${escapeHtml(srvRole)}</span>`   : ''}
      ${m?.joined_at ? `<div style="font-size:12px;color:var(--text-muted)">Joined ${fmtDateFull(m.joined_at)}</div>` : ''}
    </div>`;

  const myRole   = sd?.members.find(mb => mb.username === currentUser.username)?.display_role || 'member';
  const rankMap  = { owner:3, admin:2, mod:1, member:0 };
  const canMod   = rankMap[myRole] > rankMap[srvRole || 'member'] && username !== currentUser.username && currentServerId;

  if (canMod) {
    html += `<div class="details-actions">
      <button onclick="serverModAction('kick','${escapeHtml(username)}')">Kick</button>
      <button onclick="serverModAction('ban','${escapeHtml(username)}')">Ban</button>
      <button onclick="serverModAction('mute','${escapeHtml(username)}')">Mute</button>
      <button onclick="serverModAction('unmute','${escapeHtml(username)}')">Unmute</button>
      ${myRole==='owner' ? `<select onchange="setMemberRole('${escapeHtml(username)}',this.value);this.value=''">
        <option value="">Set Role…</option>
        <option value="mod">Mod</option>
        <option value="admin">Admin</option>
        <option value="member">Member</option>
      </select>` : ''}
    </div>`;
  }

  if (username !== currentUser.username) {
    html += `<div style="padding:0 16px 16px">
      <button class="btn-secondary" onclick="openDmWith('${escapeHtml(username)}');closeDetailsModal()">Send DM</button>
    </div>`;
  }

  el('details-content').innerHTML = html;
  show('details-modal');
}

function closeDetailsModal() { hide('details-modal'); }

async function serverModAction(action, username) {
  const data = await api('PATCH', `/api/servers/${currentServerId}/members`, { action, username });
  if (data.error) { toast(data.error, 'error'); return; }
  toast(`${action} applied to ${username}`, 'success');
  closeDetailsModal();
  await loadServerData(currentServerId);
  renderMemberPanel();
}

async function setMemberRole(username, role) {
  if (!role) return;
  const data = await api('PATCH', `/api/servers/${currentServerId}/members`, { action:'set_role', username, role });
  if (data.error) { toast(data.error, 'error'); return; }
  toast(`${username} is now ${role}`, 'success');
  await loadServerData(currentServerId);
  renderMemberPanel();
}

// ─── HOME ─────────────────────────────────────────────────────────────────────
function switchToHome() {
  currentServerId = null; currentChannelId = null; currentChannel = null;
  document.querySelectorAll('.rail-icon.server-icon').forEach(i => i.classList.remove('active'));
  el('rail-home').classList.add('active');
  hide('server-panel'); show('home-panel');
  hide('chat-view'); hide('dm-view'); show('chat-empty');
  hide('member-panel');
}

function showHomeTab(tab, btn) {
  document.querySelectorAll('.home-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  if (tab === 'dms') { show('home-dms-list'); hide('home-friends-list'); }
  else               { hide('home-dms-list'); show('home-friends-list'); }
}

// ─── DMs ──────────────────────────────────────────────────────────────────────
let dmList = [];

async function loadDms() {
  const data = await api('GET', '/api/conversations');
  dmList = data.conversations || [];
  renderDmList();
}

function renderDmList() {
  const c = el('home-dms-list');
  c.innerHTML = '';
  if (!dmList.length) {
    c.innerHTML = '<div style="padding:16px;color:var(--text-muted);font-size:13px">No messages yet.</div>';
    return;
  }
  dmList.forEach(conv => {
    const name = conv.type === 'dm'
      ? (conv.members || []).filter(m => m !== currentUser.username)[0] || conv.members[0]
      : (conv.name || 'Group');
    const d = document.createElement('div');
    d.className  = 'dm-item' + (conv.id === currentDmId ? ' active' : '');
    d.dataset.id = conv.id;
    d.innerHTML  = `
      <div class="dm-item-avatar">${escapeHtml(name[0].toUpperCase())}</div>
      <div class="dm-item-info">
        <span class="dm-item-name">${escapeHtml(name)}</span>
        ${conv.type === 'group' ? '<span class="dm-item-type">Group</span>' : ''}
      </div>`;
    d.onclick = () => openDmConv(conv);
    c.appendChild(d);
  });
}

async function openDmConv(conv) {
  currentDmId      = conv.id;
  currentChannelId = null;
  currentChannel   = null;

  document.querySelectorAll('.dm-item').forEach(i => i.classList.toggle('active', i.dataset.id === conv.id));

  hide('chat-view'); hide('chat-empty'); show('dm-view');
  hide('member-panel');

  const name = conv.type === 'dm'
    ? (conv.members || []).filter(m => m !== currentUser.username)[0] || conv.members[0]
    : (conv.name || 'Group');
  el('dm-header-name').textContent = name;
  el('dm-header-type').textContent = conv.type === 'group' ? 'Group' : '';

  if (conv.type === 'group') show('dm-group-settings-btn'); else hide('dm-group-settings-btn');
  if (conv.type === 'dm')    show('dm-call-btn');           else hide('dm-call-btn');

  dmReplyTo = null; hide('dm-reply-preview');
  el('dm-messages-container').innerHTML = '';

  await fetchDmMessages(conv.id);
}

async function openDmWith(username) {
  const existing = dmList.find(c => c.type === 'dm' && (c.members || []).includes(username));
  if (existing) { await openDmConv(existing); return; }
  const data = await api('POST', '/api/conversations', { type:'dm', username });
  if (data.error) { toast(data.error, 'error'); return; }
  await loadDms();
  const newConv = dmList.find(c => c.id === data.id);
  if (newConv) await openDmConv(newConv);
}

async function fetchDmMessages(convId) {
  const data = await api('GET', `/api/conversations/${convId}/messages`);
  const msgs = data.messages || [];
  const c    = el('dm-messages-container');
  c.innerHTML = '';
  let lastAuthor = '', lastDateStr = '';
  msgs.forEach(m => {
    const dateStr = fmtDate(m.timestamp);
    if (dateStr !== lastDateStr) {
      const div = document.createElement('div');
      div.className = 'date-divider';
      div.innerHTML = `<span>${escapeHtml(dateStr)}</span>`;
      c.appendChild(div);
      lastDateStr = dateStr; lastAuthor = '';
    }
    const grouped = m.author === lastAuthor && m.type !== 'system';
    c.appendChild(makeDmMsgEl(m, grouped));
    lastAuthor = m.author;
  });
  scrollDmMsgs();
}

function makeDmMsgEl(m, grouped) {
  const d = document.createElement('div');
  d.dataset.id     = m.id;
  d.dataset.author = m.author;

  if (m.type === 'system') {
    d.className   = 'msg-system';
    d.textContent = m.content;
    return d;
  }

  d.className = `message${grouped ? ' grouped' : ''}`;
  let body = '';
  if (m.type === 'image')      body = `<img src="${escapeHtml(m.media_url)}" class="msg-media" onclick="openImageViewer(this.src)">`;
  else if (m.type === 'video') body = `<video src="${escapeHtml(m.media_url)}" controls class="msg-media"></video>`;
  else                          body = linkify(m.content);

  const auth = escapeHtml(m.author);
  const id   = escapeHtml(m.id);

  if (grouped) {
    d.innerHTML = `
      <div class="msg-timestamp-inline">${fmtTime(m.timestamp)}</div>
      <div class="msg-body">${body}</div>
      <div class="msg-actions"><button onclick="setDmReply('${id}','${auth}')">↩</button></div>`;
  } else {
    d.innerHTML = `
      <div class="msg-avatar">${auth[0].toUpperCase()}</div>
      <div class="msg-content-wrap">
        <div class="msg-header">
          <span class="msg-author">${auth}</span>
          <span class="msg-time">${fmtTime(m.timestamp)}</span>
        </div>
        <div class="msg-body">${body}</div>
      </div>
      <div class="msg-actions"><button onclick="setDmReply('${id}','${auth}')">↩</button></div>`;
  }
  return d;
}

function closeDmView() { currentDmId = null; hide('dm-view'); show('chat-empty'); }

async function sendDmMessage() {
  const input = el('dm-message-input');
  const text  = input.value.trim();
  if (!text || !currentDmId) return;
  input.value = '';
  const body = { content: text };
  if (dmReplyTo) body.reply_to = dmReplyTo.id;
  const data = await api('POST', `/api/conversations/${currentDmId}/messages`, body);
  if (data.error) { toast(data.error, 'error'); return; }
  dmReplyTo = null; hide('dm-reply-preview');
  await fetchDmMessages(currentDmId);
}

function setDmReply(msgId, author) {
  dmReplyTo = { id: msgId };
  el('dm-reply-author').textContent = author;
  show('dm-reply-preview');
  el('dm-message-input').focus();
}
function cancelDmReply() { dmReplyTo = null; hide('dm-reply-preview'); }
function scrollDmMsgs()  { const c = el('dm-messages-container'); if (c) c.scrollTop = c.scrollHeight; }

// ─── FRIENDS ──────────────────────────────────────────────────────────────────
let friends = [], friendRequests = [];

async function loadFriends() {
  const data     = await api('GET', '/api/friends');
  // server returns friends as array of username strings, incoming as [{ id, username }]
  friends        = (data.friends  || []).map(f => typeof f === 'string' ? f : f.username).filter(Boolean);
  friendRequests = (data.incoming || []).filter(f => f && (f.username || typeof f === 'string'));
  renderFriends();
}

function renderFriends() {
  let html = '';
  if (friendRequests.length) {
    html += '<div class="friends-section-title">Pending Requests</div>';
    friendRequests.forEach(f => {
      const uname = typeof f === 'string' ? f : f.username;
      if (!uname) return;
      html += `<div class="friend-row">
        <div class="friend-avatar">${escapeHtml(uname[0].toUpperCase())}</div>
        <span class="friend-name">${escapeHtml(uname)}</span>
        <div class="friend-actions">
          <button onclick="respondFriend('${escapeHtml(uname)}','accept')">✓</button>
          <button onclick="respondFriend('${escapeHtml(uname)}','reject')">✕</button>
        </div>
      </div>`;
    });
  }
  if (friends.length) {
    html += '<div class="friends-section-title">Friends</div>';
    friends.forEach(uname => {
      if (!uname) return;
      html += `<div class="friend-row">
        <div class="friend-avatar">${escapeHtml(uname[0].toUpperCase())}</div>
        <span class="friend-name">${escapeHtml(uname)}</span>
        <div class="friend-actions">
          <button onclick="openDmWith('${escapeHtml(uname)}')">DM</button>
          <button onclick="removeFriend('${escapeHtml(uname)}')">✕</button>
        </div>
      </div>`;
    });
  }
  if (!html) html = '<div style="padding:16px;color:var(--text-muted);font-size:13px">No friends yet.</div>';
  el('friends-content').innerHTML = html;
}

async function sendFriendRequest() {
  const username = el('add-friend-input').value.trim();
  if (!username) return;
  const data = await api('POST', '/api/friends/request', { username });
  if (data.error) { toast(data.error, 'error'); return; }
  toast('Friend request sent!', 'success');
  el('add-friend-input').value = '';
  await loadFriends();
}

async function respondFriend(username, action) {
  const data = await api('PATCH', `/api/friends/${username}`, { action });
  if (data.error) { toast(data.error, 'error'); return; }
  await loadFriends();
}

async function removeFriend(username) {
  const data = await api('DELETE', `/api/friends/${username}`);
  if (data.error) { toast(data.error, 'error'); return; }
  await loadFriends();
}

// ─── SERVER DROPDOWN ──────────────────────────────────────────────────────────
function toggleServerDropdown() { toggle('server-dropdown'); }

function buildServerDropdown() {
  const sd   = serverData[currentServerId];
  const me   = sd?.members.find(m => m.username === currentUser.username);
  const role = me?.display_role || 'member';

  let html = `<div class="dd-item" onclick="closeServerDropdown();openCreateInvite()">🔗 Create Invite</div>`;
  if (role === 'owner' || role === 'admin') {
    html += `<div class="dd-item" onclick="closeServerDropdown();openServerSettings('overview')">⚙ Server Settings</div>`;
    html += `<div class="dd-item" onclick="closeServerDropdown();openAddChannelModal('')">➕ Add Channel</div>`;
  }
  html += `<div class="dd-item danger-item" onclick="closeServerDropdown();leaveServer()">↪ Leave Server</div>`;
  if (role === 'owner') {
    html += `<div class="dd-item danger-item" onclick="closeServerDropdown();deleteServer()">🗑 Delete Server</div>`;
  }
  el('server-dropdown').innerHTML = html;
}

function closeServerDropdown() { hide('server-dropdown'); }

document.addEventListener('click', e => {
  const dd  = el('server-dropdown');
  const hdr = document.querySelector('.server-panel-header');
  if (dd && !dd.contains(e.target) && hdr && !hdr.contains(e.target)) {
    dd.classList.add('hidden');
  }
});

async function leaveServer() {
  if (!confirm('Leave this server?')) return;
  const data = await api('POST', `/api/servers/${currentServerId}/leave`);
  if (data.error) { toast(data.error, 'error'); return; }
  toast('Left server', 'success');
  delete serverData[currentServerId];
  await loadServers();
  renderServerRail();
  switchToHome();
}

async function deleteServer() {
  if (!confirm('Delete this server? This cannot be undone.')) return;
  const data = await api('DELETE', `/api/servers/${currentServerId}`);
  if (data.error) { toast(data.error, 'error'); return; }
  toast('Server deleted', 'success');
  delete serverData[currentServerId];
  await loadServers();
  renderServerRail();
  switchToHome();
}

// ─── CREATE SERVER / JOIN ─────────────────────────────────────────────────────
function openCreateServerModal() { show('create-server-modal'); }
function closeCreateServerModal() { hide('create-server-modal'); }

async function createServer() {
  const name  = el('cs-name').value.trim();
  const desc  = el('cs-desc').value.trim();
  const emoji = el('cs-emoji').value.trim() || '🌐';
  if (!name) { toast('Enter a server name', 'error'); return; }
  const data = await api('POST', '/api/servers', { name, description:desc, icon_emoji:emoji, is_public: el('cs-public').checked ? 1 : 0 });
  if (data.error) { toast(data.error, 'error'); return; }
  toast('Server created!', 'success');
  await loadServers();
  renderServerRail();
  closeCreateServerModal();
  await switchToServer(data.id);
}

async function joinByCode() {
  const code = el('join-code-input').value.trim().toUpperCase();
  if (!code) return;
  const info = await api('GET', `/api/invites/${code}`);
  if (info.error) { toast(info.error, 'error'); return; }
  const data = await api('POST', `/api/invites/${code}/join`);
  if (data.error) { toast(data.error, 'error'); return; }
  toast('Joined ' + info.server_name + '!', 'success');
  await loadServers();
  renderServerRail();
  closeCreateServerModal();
  await switchToServer(info.server_id);
}

// ─── SERVER SETTINGS MODAL ────────────────────────────────────────────────────
let ssCurrentTab = 'overview';

function openServerSettings(tab) {
  show('server-settings-modal');
  const t = tab || 'overview';
  const btn = document.querySelector(`#server-settings-modal [onclick="switchSsTab('${t}',this)"]`);
  switchSsTab(t, btn);
}
function closeServerSettings() { hide('server-settings-modal'); }

function switchSsTab(tab, btn) {
  ssCurrentTab = tab;
  document.querySelectorAll('#server-settings-modal .tab-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  ['overview','channels','members','bans','invites','audit','danger'].forEach(t => {
    el('ss-tab-' + t)?.classList.toggle('hidden', t !== tab);
  });
  loadSsTab(tab);
}

async function loadSsTab(tab) {
  const sd  = serverData[currentServerId] || {};
  const srv = sd.server || myServers.find(s => s.id === currentServerId) || {};
  el('ss-title').textContent = srv.name || 'Server Settings';

  if (tab === 'overview') renderSsOverview(srv);
  if (tab === 'channels') renderSsChannels(sd);
  if (tab === 'members')  renderSsMembers(sd);
  if (tab === 'bans')     await renderSsBans();
  if (tab === 'invites')  await renderSsInvites();
  if (tab === 'audit')    await renderSsAudit();
  if (tab === 'danger')   renderSsDanger(srv);
}

function renderSsOverview(srv) {
  el('ss-tab-overview').innerHTML = `
    <div class="flex-col">
      <label class="settings-group-title">Server Name</label>
      <input type="text" id="ss-name" class="settings-input" value="${escapeHtml(srv.name||'')}" maxlength="50">
      <label class="settings-group-title">Description</label>
      <input type="text" id="ss-desc" class="settings-input" value="${escapeHtml(srv.description||'')}" maxlength="200">
      <label class="settings-group-title">Icon Emoji</label>
      <input type="text" id="ss-emoji" class="settings-input emoji-input" value="${escapeHtml(srv.icon_emoji||'🌐')}" maxlength="4">
      <div class="settings-row" style="border:none;padding:4px 0">
        <span class="settings-row-label">Public server</span>
        <label class="toggle-switch"><input type="checkbox" id="ss-public" ${srv.is_public ? 'checked' : ''}><span class="toggle-track"></span></label>
      </div>
      <button class="btn-primary" onclick="saveServerOverview()">Save Changes</button>
    </div>`;
}

async function saveServerOverview() {
  const data = await api('PATCH', `/api/servers/${currentServerId}`, {
    name:        el('ss-name').value.trim(),
    description: el('ss-desc').value.trim(),
    icon_emoji:  el('ss-emoji').value.trim() || '🌐',
    is_public:   el('ss-public').checked ? 1 : 0,
  });
  if (data.error) { toast(data.error, 'error'); return; }
  toast('Saved!', 'success');
  await loadServers();
  renderServerRail();
  el('server-panel-name').textContent = el('ss-name').value.trim();
  if (serverData[currentServerId]) serverData[currentServerId].server.name = el('ss-name').value.trim();
}

function renderSsChannels(sd) {
  if (!sd?.categories) return;
  let html = '<div class="flex-col">';
  sd.categories.slice().sort((a,b) => a.position - b.position).forEach(cat => {
    html += `<div class="ss-cat-row">
      <span class="ss-cat-name">${escapeHtml(cat.name)}</span>
      <div class="ss-cat-actions">
        <button onclick="renameCategory('${escapeHtml(cat.id)}','${escapeHtml(cat.name)}')">✏</button>
        <button onclick="deleteCategory('${escapeHtml(cat.id)}')">🗑</button>
      </div>
    </div>`;
    sd.channels.filter(c => c.category_id === cat.id).sort((a,b) => a.position - b.position).forEach(ch => {
      const icon = ch.type === 'voice' ? '🔊' : ch.type === 'announcement' ? '📢' : '#';
      html += `<div class="ss-ch-row">
        <span class="ss-ch-icon">${icon}</span>
        <span class="ss-ch-name">${escapeHtml(ch.name)}</span>
        <div class="ss-ch-actions">
          <button onclick="promptEditChannel(serverData[currentServerId].channels.find(c=>c.id==='${escapeHtml(ch.id)}'))">✏</button>
          <button onclick="deleteChannel('${escapeHtml(ch.id)}')">🗑</button>
        </div>
      </div>`;
    });
  });
  html += `<button class="btn-secondary" style="margin-top:8px" onclick="addCategory()">+ Add Category</button>`;
  html += '</div>';
  el('ss-tab-channels').innerHTML = html;
}

async function addCategory() {
  const name = prompt('Category name:');
  if (!name) return;
  const data = await api('POST', `/api/servers/${currentServerId}/categories`, { name });
  if (data.error) { toast(data.error, 'error'); return; }
  await loadServerData(currentServerId);
  renderSsChannels(serverData[currentServerId]);
  renderChannelList();
}

async function renameCategory(catId, oldName) {
  const name = prompt('New name:', oldName);
  if (!name || name === oldName) return;
  const data = await api('PATCH', `/api/servers/${currentServerId}/categories/${catId}`, { name });
  if (data.error) { toast(data.error, 'error'); return; }
  await loadServerData(currentServerId);
  renderSsChannels(serverData[currentServerId]);
  renderChannelList();
}

async function deleteCategory(catId) {
  if (!confirm('Delete this category?')) return;
  const data = await api('DELETE', `/api/servers/${currentServerId}/categories/${catId}`);
  if (data.error) { toast(data.error, 'error'); return; }
  await loadServerData(currentServerId);
  renderSsChannels(serverData[currentServerId]);
  renderChannelList();
}

async function promptEditChannel(ch) {
  if (!ch) return;
  const name = prompt('Channel name:', ch.name);
  if (!name || name === ch.name) return;
  const data = await api('PATCH', `/api/servers/${currentServerId}/channels/${ch.id}`, { name });
  if (data.error) { toast(data.error, 'error'); return; }
  await loadServerData(currentServerId);
  renderSsChannels(serverData[currentServerId]);
  renderChannelList();
}

async function deleteChannel(chId) {
  if (!confirm('Delete this channel?')) return;
  const data = await api('DELETE', `/api/servers/${currentServerId}/channels/${chId}`);
  if (data.error) { toast(data.error, 'error'); return; }
  if (currentChannelId === chId) { currentChannelId = null; hide('chat-view'); show('chat-empty'); }
  await loadServerData(currentServerId);
  renderSsChannels(serverData[currentServerId]);
  renderChannelList();
}

function renderSsMembers(sd) {
  if (!sd?.members) return;
  let html = '<div class="flex-col">';
  sd.members.forEach(m => {
    const roleColor = SR_COLORS[m.display_role] || '#9e9e9e';
    html += `<div class="ss-member-row">
      <div class="member-avatar" style="border-color:${roleColor}">${escapeHtml(m.username[0].toUpperCase())}</div>
      <div class="ss-member-info">
        <span class="member-name">${escapeHtml(m.nickname || m.username)}</span>
        <span class="member-role" style="color:${roleColor}">${escapeHtml(m.display_role)}</span>
        ${m.muted ? '<span class="member-muted-badge">muted</span>' : ''}
      </div>
      ${m.username !== currentUser.username ? `<div class="ss-member-actions">
        <button onclick="serverModAction('kick','${escapeHtml(m.username)}')">Kick</button>
        <button onclick="serverModAction('ban','${escapeHtml(m.username)}')">Ban</button>
        <button onclick="serverModAction('mute','${escapeHtml(m.username)}')">Mute</button>
      </div>` : ''}
    </div>`;
  });
  html += '</div>';
  el('ss-tab-members').innerHTML = html;
}

async function renderSsBans() {
  const data = await api('GET', `/api/servers/${currentServerId}/bans`);
  const bans = Array.isArray(data) ? data : (data.bans || []);
  if (!bans.length) { el('ss-tab-bans').innerHTML = '<p style="padding:16px;color:var(--text-muted)">No bans.</p>'; return; }
  let html = '<div class="flex-col">';
  bans.forEach(b => {
    html += `<div class="ss-ban-row">
      <span class="ban-username">${escapeHtml(b.username)}</span>
      <span class="ban-reason">${escapeHtml(b.reason || 'No reason')}</span>
      <button onclick="unbanMember('${escapeHtml(b.username)}')">Unban</button>
    </div>`;
  });
  html += '</div>';
  el('ss-tab-bans').innerHTML = html;
}

async function unbanMember(username) {
  const data = await api('PATCH', `/api/servers/${currentServerId}/members`, { action:'unban', username });
  if (data.error) { toast(data.error, 'error'); return; }
  toast(`${username} unbanned`, 'success');
  await renderSsBans();
}

async function renderSsInvites() {
  const data    = await api('GET', `/api/servers/${currentServerId}/invites`);
  const invites = Array.isArray(data) ? data : (data.invites || []);
  let html = `<div class="flex-col">
    <button class="btn-secondary" onclick="openCreateInvite()">+ Create Invite</button>`;
  if (invites.length) {
    html += '<div class="settings-group-title" style="margin-top:12px">Active Invites</div>';
    invites.forEach(inv => {
      html += `<div class="ss-invite-row">
        <span class="inv-code">${escapeHtml(inv.code)}</span>
        <span class="inv-meta">Uses: ${inv.uses}${inv.max_uses ? '/' + inv.max_uses : ''} · By ${escapeHtml(inv.creator)}</span>
        <span class="inv-expires">${inv.expires_at ? 'Exp: ' + fmtDateFull(inv.expires_at) : 'Never expires'}</span>
        <button onclick="deleteInvite('${escapeHtml(inv.code)}')">🗑</button>
      </div>`;
    });
  }
  html += '</div>';
  el('ss-tab-invites').innerHTML = html;
}

async function openCreateInvite() {
  const maxUsesStr = prompt('Max uses (0 = unlimited):', '0');
  if (maxUsesStr === null) return;
  const hoursStr = prompt('Expires in hours (0 = never):', '0');
  if (hoursStr === null) return;
  const maxUses = parseInt(maxUsesStr) || 0;
  const hours   = parseInt(hoursStr) || 0;
  const body = {
    max_uses:   maxUses > 0 ? maxUses : null,
    expires_at: hours   > 0 ? new Date(Date.now() + hours * 3600000).toISOString() : null,
  };
  const data = await api('POST', `/api/servers/${currentServerId}/invites`, body);
  if (data.error) { toast(data.error, 'error'); return; }
  toast('Invite code: ' + data.code, 'success');
  if (ssCurrentTab === 'invites') await renderSsInvites();
}

async function deleteInvite(code) {
  const data = await api('DELETE', `/api/servers/${currentServerId}/invites/${code}`);
  if (data.error) { toast(data.error, 'error'); return; }
  await renderSsInvites();
}

async function renderSsAudit() {
  const data = await api('GET', `/api/servers/${currentServerId}/admin/audit-log`);
  const logs = Array.isArray(data) ? data : (data.log || []);
  if (!logs.length) { el('ss-tab-audit').innerHTML = '<p style="padding:16px;color:var(--text-muted)">No audit log entries.</p>'; return; }
  let html = '<div class="audit-log">';
  logs.forEach(l => {
    html += `<div class="audit-row">
      <span class="audit-time">${fmtDateFull(l.created_at)}</span>
      <span class="audit-actor">${escapeHtml(l.actor)}</span>
      <span class="audit-action">${escapeHtml(l.action)}</span>
      ${l.target ? `<span class="audit-target">→ ${escapeHtml(l.target)}</span>` : ''}
      ${l.detail ? `<span class="audit-detail">${escapeHtml(l.detail)}</span>`   : ''}
    </div>`;
  });
  html += '</div>';
  el('ss-tab-audit').innerHTML = html;
}

function renderSsDanger(srv) {
  el('ss-tab-danger').innerHTML = `
    <div class="flex-col" style="gap:16px;padding:8px 0">
      <div class="danger-card">
        <p class="danger-title">Broadcast Announcement</p>
        <p class="danger-desc">Send a system message to all channels in this server.</p>
        <input type="text" id="ss-broadcast-msg" class="settings-input" placeholder="Announcement text…">
        <button class="btn-primary" onclick="sendBroadcast()">Broadcast</button>
      </div>
      <div class="danger-card">
        <p class="danger-title">Delete Server</p>
        <p class="danger-desc">Permanently delete this server and all its channels. This cannot be undone.</p>
        <button class="btn-danger" onclick="closeServerSettings();deleteServer()">Delete Server</button>
      </div>
    </div>`;
}

async function sendBroadcast() {
  const msg = el('ss-broadcast-msg')?.value.trim();
  if (!msg) return;
  const data = await api('POST', `/api/servers/${currentServerId}/admin/broadcast`, { message: msg });
  if (data.error) { toast(data.error, 'error'); return; }
  toast('Broadcast sent', 'success');
}

// ─── ADD CHANNEL MODAL ────────────────────────────────────────────────────────
function openAddChannelModal(catId) {
  el('new-ch-name').value  = '';
  el('new-ch-type').value  = 'text';
  el('new-ch-topic').value = '';
  el('new-ch-cat-id').value = catId || '';
  show('add-channel-modal');
}
function closeAddChannelModal() { hide('add-channel-modal'); }

async function submitCreateChannel() {
  const name  = el('new-ch-name').value.trim().toLowerCase().replace(/\s+/g, '-');
  const type  = el('new-ch-type').value;
  const topic = el('new-ch-topic').value.trim();
  const catId = el('new-ch-cat-id').value || null;
  if (!name) { toast('Enter channel name', 'error'); return; }
  const data = await api('POST', `/api/servers/${currentServerId}/channels`, { name, type, topic, category_id: catId });
  if (data.error) { toast(data.error, 'error'); return; }
  await loadServerData(currentServerId);
  renderChannelList();
  closeAddChannelModal();
  if (ssCurrentTab === 'channels') renderSsChannels(serverData[currentServerId]);
}

// ─── GROUP CHAT ───────────────────────────────────────────────────────────────
function openGroupModal() {
  const fl = el('group-friends-list');
  fl.innerHTML = '';
  friends.forEach(f => {
    const other = f.requester === currentUser.username ? f.recipient : f.requester;
    const lbl   = document.createElement('label');
    lbl.className = 'friend-check-row';
    lbl.innerHTML = `<input type="checkbox" class="group-friend-chk" value="${escapeHtml(other)}"> ${escapeHtml(other)}`;
    fl.appendChild(lbl);
  });
  show('group-modal');
}
function closeGroupModal() { hide('group-modal'); }

async function createGroup() {
  const name     = el('group-name-input').value.trim();
  const selected = [...document.querySelectorAll('.group-friend-chk:checked')].map(i => i.value);
  if (!name)           { toast('Enter group name', 'error'); return; }
  if (!selected.length){ toast('Select at least one friend', 'error'); return; }
  const data = await api('POST', '/api/conversations', { type:'group', name, members: selected });
  if (data.error) { toast(data.error, 'error'); return; }
  closeGroupModal();
  await loadDms();
}

function openGroupSettings() { toast('Group settings coming soon', 'info'); }

// ─── SETTINGS MODAL ───────────────────────────────────────────────────────────
function openSettings() {
  el('pref-compact').checked = localStorage.getItem('neuron_compact') === '1';
  const theme = localStorage.getItem('neuron_theme') || 'light';
  document.querySelectorAll('.theme-btn').forEach(b => b.classList.toggle('active', b.dataset.theme === theme));
  renderParentalSection();
  renderProfileSection();
  show('settings-modal');
}

function renderProfileSection() {
  // inject profile section if not already present
  let sec = el('settings-profile-section');
  if (!sec) {
    sec = document.createElement('div');
    sec.id = 'settings-profile-section';
    sec.className = 'settings-section';
    // insert before the first section inside settings modal
    const firstSec = document.querySelector('#settings-modal .settings-section');
    if (firstSec) firstSec.parentNode.insertBefore(sec, firstSec);
  }
  sec.innerHTML = `
    <p class="settings-section-title">Profile</p>
    <div class="settings-group">
      <p class="settings-group-title">Display Name <span style="color:var(--text-muted);font-weight:400;font-size:11px">(shown in chat instead of username)</span></p>
      <div class="flex-col">
        <input type="text" id="settings-display-name" class="settings-input" placeholder="Display name (max 32 chars)" maxlength="32" value="${escapeHtml(currentUser.display_name || '')}">
        <button class="settings-btn" onclick="saveDisplayName()">Save Display Name</button>
      </div>
    </div>
    <div class="settings-group">
      <p class="settings-group-title">Change Username</p>
      <div class="flex-col">
        <input type="text" id="settings-new-username" class="settings-input" placeholder="New username (3–15 chars)" maxlength="15" value="${escapeHtml(currentUser.username)}">
        <div id="settings-username-msg" class="settings-msg hidden"></div>
        <button class="settings-btn" onclick="saveUsername()">Change Username</button>
      </div>
    </div>
  `;
}

async function saveDisplayName() {
  const dn   = el('settings-display-name').value.trim();
  const data = await api('PATCH', '/api/me/profile', { display_name: dn });
  if (data.error) { toast(data.error, 'error'); return; }
  currentUser.display_name = dn || null;
  renderUserInfoBar();
  toast('Display name saved!', 'success');
}

async function saveUsername() {
  const nu  = el('settings-new-username').value.trim();
  const msg = el('settings-username-msg');
  msg.className = 'settings-msg'; show('settings-username-msg');
  if (!nu) return;
  const data = await api('PATCH', '/api/me/profile', { username: nu });
  if (data.error) { msg.classList.add('error'); msg.textContent = data.error; return; }
  if (data.new_token) {
    localStorage.setItem('neuron_token', data.new_token);
    currentUser.username = data.username;
    renderUserInfoBar();
    msg.classList.add('success'); msg.textContent = 'Username changed!';
  }
}
function closeSettings() { hide('settings-modal'); }

function applyTheme(theme) {
  document.body.classList.remove('dark-mode', 'darker-mode', 'oled-mode');
  if (theme === 'dark')   document.body.classList.add('dark-mode');
  if (theme === 'darker') document.body.classList.add('darker-mode');
  if (theme === 'oled')   document.body.classList.add('oled-mode');
  localStorage.setItem('neuron_theme', theme);
  document.querySelectorAll('.theme-btn').forEach(b => b.classList.toggle('active', b.dataset.theme === theme));
}
// legacy shim
function applyDarkMode(on) { applyTheme(on ? 'dark' : 'light'); }

function applyCompact(on) {
  document.body.classList.toggle('compact', !!on);
  localStorage.setItem('neuron_compact', on ? '1' : '0');
}

async function changePassword() {
  const curr = el('settings-curr-pass').value;
  const next = el('settings-new-pass').value;
  const conf = el('settings-confirm-pass').value;
  const msg  = el('settings-pass-msg');
  msg.className = 'settings-msg'; show('settings-pass-msg');
  if (next !== conf) { msg.classList.add('error'); msg.textContent = 'Passwords do not match.'; return; }
  const data = await api('POST', '/api/me/password', { current: curr, password: next });
  if (data.error) { msg.classList.add('error'); msg.textContent = data.error; return; }
  msg.classList.add('success'); msg.textContent = 'Password updated!';
  el('settings-curr-pass').value = '';
  el('settings-new-pass').value  = '';
  el('settings-confirm-pass').value = '';
}

async function deleteOwnAccount() {
  const pass = el('settings-delete-pass').value;
  const msg  = el('settings-delete-msg');
  msg.className = 'settings-msg'; show('settings-delete-msg');
  if (!pass) { msg.classList.add('error'); msg.textContent = 'Enter your password.'; return; }
  if (!confirm('Permanently delete your account? This cannot be undone.')) return;
  const data = await api('DELETE', '/api/me', { password: pass });
  if (data.error) { msg.classList.add('error'); msg.textContent = data.error; return; }
  await handleLogout();
}

function renderParentalSection() {
  const badge = el('parental-status-badge');
  const form  = el('parental-form');
  const on    = currentUser.parental_controls;
  badge.textContent  = on ? 'ON' : 'OFF';
  badge.style.color  = on ? 'var(--success)' : 'var(--text-muted)';
  if (on) {
    form.innerHTML = `
      <input type="password" id="parent-pin-input" class="settings-input" placeholder="Enter current PIN">
      <button class="settings-btn" onclick="disableParental()">Disable Parental Controls</button>`;
  } else {
    form.innerHTML = `
      <input type="password" id="parent-pin-input" class="settings-input" placeholder="Set a 4+ digit PIN">
      <button class="settings-btn" onclick="enableParental()">Enable Parental Controls</button>`;
  }
}

async function enableParental() {
  const pin = el('parent-pin-input')?.value.trim();
  if (!pin || pin.length < 4) { toast('PIN must be at least 4 digits', 'error'); return; }
  const data = await api('POST', '/api/me/parental', { enable:true, pin });
  if (data.error) { toast(data.error, 'error'); return; }
  currentUser.parental_controls = 1;
  renderParentalSection();
  toast('Parental controls enabled', 'success');
}

async function disableParental() {
  const pin = el('parent-pin-input')?.value.trim();
  const data = await api('POST', '/api/me/parental', { enable:false, pin });
  if (data.error) { toast(data.error, 'error'); return; }
  currentUser.parental_controls = 0;
  renderParentalSection();
  toast('Parental controls disabled', 'success');
}

// ─── GLOBAL ADMIN PANEL ───────────────────────────────────────────────────────
let gaCurrentTab = 'stats';

function openGlobalAdminPanel() {
  // hide tabs this role can't use
  const rank = ROLE_RANK[currentUser?.role] ?? 0;
  const tabVisibility = {
    stats:        rank >= ROLE_RANK['admin'],
    servers:      rank >= ROLE_RANK['admin'],
    users:        rank >= ROLE_RANK['manager'],
    reports:      rank >= ROLE_RANK['mod'],
    aiflags:      rank >= ROLE_RANK['manager'],
    platsettings: rank >= ROLE_RANK['supreme'],
    deleted:      rank >= ROLE_RANK['owner'],
  };
  document.querySelectorAll('#global-admin-modal .tab-btn').forEach(btn => {
    const m = btn.getAttribute('onclick')?.match(/switchGaTab\('(\w+)'/);
    if (m) btn.style.display = tabVisibility[m[1]] ? '' : 'none';
  });
  const firstVisible = Object.entries(tabVisibility).find(([,v]) => v)?.[0] || 'reports';
  show('global-admin-modal');
  switchGaTab(firstVisible, null);
}
function closeGlobalAdminPanel() { hide('global-admin-modal'); }

function switchGaTab(tab, btn) {
  gaCurrentTab = tab;
  document.querySelectorAll('#global-admin-modal .tab-btn').forEach(b => b.classList.remove('active'));
  if (btn) {
    btn.classList.add('active');
  } else {
    const b = document.querySelector(`#global-admin-modal [onclick="switchGaTab('${tab}',this)"]`);
    if (b) b.classList.add('active');
  }
  ['stats','servers','users','reports','aiflags','platsettings','deleted'].forEach(t => {
    el('ga-tab-' + t)?.classList.toggle('hidden', t !== tab);
  });
  loadGaTab(tab);
}

async function loadGaTab(tab) {
  if (tab === 'stats')        await loadGaStats();
  if (tab === 'servers')      await loadGaServers();
  if (tab === 'users')        await loadGaUsers();
  if (tab === 'reports')      await loadGaReports();
  if (tab === 'aiflags')      await loadGaAiFlags();
  if (tab === 'platsettings') await loadGaPlatSettings();
  if (tab === 'deleted')      await loadGaDeleted();
}

async function loadGaStats() {
  const s = await api('GET', '/api/admin/platform-stats');
  el('ga-tab-stats').innerHTML = `
    <div class="admin-stats-grid">
      <div class="stat-card"><div class="stat-value">${s.totalUsers    || 0}</div><div class="stat-label">Total Users</div></div>
      <div class="stat-card"><div class="stat-value">${s.bannedUsers   || 0}</div><div class="stat-label">Banned</div></div>
      <div class="stat-card"><div class="stat-value">${s.totalServers  || 0}</div><div class="stat-label">Servers</div></div>
      <div class="stat-card"><div class="stat-value">${s.totalMessages || 0}</div><div class="stat-label">Messages</div></div>
      <div class="stat-card"><div class="stat-value">${s.pendingReports|| 0}</div><div class="stat-label">Open Reports</div></div>
      <div class="stat-card"><div class="stat-value">${s.aiFlags       || 0}</div><div class="stat-label">AI Flags</div></div>
    </div>`;
}

async function loadGaServers() {
  const data    = await api('GET', '/api/admin/servers');
  const servers = Array.isArray(data) ? data : (data.servers || []);
  let html = `<div class="admin-table-wrap"><table class="admin-table">
    <thead><tr><th>Server</th><th>Owner</th><th>Members</th><th>Public</th><th>Created</th><th>Actions</th></tr></thead><tbody>`;
  servers.forEach(s => {
    html += `<tr>
      <td>${escapeHtml(s.icon_emoji||'🌐')} ${escapeHtml(s.name)}</td>
      <td>${escapeHtml(s.owner)}</td>
      <td>${s.member_count || 0}</td>
      <td>${s.is_public ? '✓' : ''}</td>
      <td>${fmtDateFull(s.created_at)}</td>
      <td><button class="admin-action-btn danger" onclick="adminDeleteServer('${escapeHtml(s.id)}')">Delete</button></td>
    </tr>`;
  });
  html += `</tbody></table></div>`;
  el('ga-tab-servers').innerHTML = html;
}

async function adminDeleteServer(id) {
  if (!confirm('Delete this server?')) return;
  const data = await api('DELETE', `/api/admin/servers/${id}`);
  if (data.error) { toast(data.error, 'error'); return; }
  toast('Server deleted', 'success');
  await loadGaServers();
}

async function loadGaUsers() {
  const data  = await api('GET', '/api/admin/users');
  const users = Array.isArray(data) ? data : (data.users || []);
  let html = `
    <div class="admin-search-row">
      <input type="text" id="ga-user-search" class="settings-input" placeholder="Search username…" oninput="filterGaUsers(this.value)">
    </div>
    <div class="admin-table-wrap"><table class="admin-table" id="ga-users-table">
    <thead><tr><th>Username</th><th>Role</th><th>Status</th><th>Created</th><th>Actions</th></tr></thead><tbody>`;
  users.forEach(u => {
    const roleColor = ROLE_COLORS[u.role] || '#9e9e9e';
    html += `<tr data-username="${escapeHtml(u.username).toLowerCase()}">
      <td><span class="admin-link" onclick="adminShowUser('${escapeHtml(u.username)}')">${escapeHtml(u.username)}</span></td>
      <td><span style="color:${roleColor}">${escapeHtml(u.role)}</span></td>
      <td>${u.banned ? '<span class="badge-danger">Banned</span>' : ''}${u.muted ? '<span class="badge-warning">Muted</span>' : ''}</td>
      <td>${fmtDateFull(u.createdAt || u.created_at)}</td>
      <td class="admin-action-cell">
        ${!u.banned
          ? `<button class="admin-action-btn danger"  onclick="adminBanUser('${escapeHtml(u.username)}')">Ban</button>`
          : `<button class="admin-action-btn success" onclick="adminUnbanUser('${escapeHtml(u.username)}')">Unban</button>`}
        ${!u.muted
          ? `<button class="admin-action-btn warning" onclick="adminMuteUser('${escapeHtml(u.username)}')">Mute</button>`
          : `<button class="admin-action-btn"         onclick="adminUnmuteUser('${escapeHtml(u.username)}')">Unmute</button>`}
        <button class="admin-action-btn" onclick="adminShowUser('${escapeHtml(u.username)}')">Detail</button>
        <button class="admin-action-btn danger" onclick="adminDeleteUser('${escapeHtml(u.username)}')">Delete</button>
      </td>
    </tr>`;
  });
  html += `</tbody></table></div>`;
  el('ga-tab-users').innerHTML = html;
}

function filterGaUsers(q) {
  document.querySelectorAll('#ga-users-table tbody tr').forEach(r => {
    r.style.display = r.dataset.username.includes(q.toLowerCase()) ? '' : 'none';
  });
}

async function adminBanUser(username) {
  const reason = prompt('Ban reason:');
  if (reason === null) return;
  const until  = prompt('Ban until ISO date (blank = permanent):');
  if (until === null) return;
  const data = await api('PATCH', `/api/admin/users/${username}`, { action: 'ban', bannedUntil: until || null });
  if (data.error) { toast(data.error, 'error'); return; }
  toast(`${username} banned`, 'success'); await loadGaUsers();
}

async function adminUnbanUser(username) {
  const data = await api('PATCH', `/api/admin/users/${username}`, { action: 'unban' });
  if (data.error) { toast(data.error, 'error'); return; }
  toast(`${username} unbanned`, 'success'); await loadGaUsers();
}

async function adminMuteUser(username) {
  const hours = parseInt(prompt('Mute for how many hours? (0 = permanent):') || '0');
  const muteUntil = hours > 0 ? new Date(Date.now() + hours * 3600000).toISOString() : null;
  const data = await api('PATCH', `/api/admin/users/${username}`, { action: 'mute', muteUntil });
  if (data.error) { toast(data.error, 'error'); return; }
  toast(`${username} muted`, 'success'); await loadGaUsers();
}

async function adminUnmuteUser(username) {
  const data = await api('PATCH', `/api/admin/users/${username}`, { action: 'unmute' });
  if (data.error) { toast(data.error, 'error'); return; }
  toast(`${username} unmuted`, 'success'); await loadGaUsers();
}

async function adminSetRole(username, role) {
  if (!role) return;
  const data = await api('PATCH', `/api/admin/users/${username}`, { action: 'set_role', role });
  if (data.error) { toast(data.error, 'error'); return; }
  toast(`${username} is now ${role}`, 'success'); await loadGaUsers();
}

async function adminDeleteUser(username) {
  if (!confirm(`Permanently delete account "${username}"?`)) return;
  const data = await api('DELETE', `/api/admin/users/${username}`);
  if (data.error) { toast(data.error, 'error'); return; }
  toast(`${username} deleted`, 'success'); await loadGaUsers();
}

async function adminShowUser(username) {
  const [uData, msgsData] = await Promise.all([
    api('GET', `/api/users/${username}`),
    api('GET', `/api/admin/users/${username}/messages`),
  ]);
  const u    = uData.user || uData || {};
  const msgs = Array.isArray(msgsData) ? msgsData : (msgsData.messages || []);
  const roleColor = ROLE_COLORS[u.role] || '#9e9e9e';
  const myRank    = ROLE_RANK[currentUser?.role] ?? 0;

  const canBan   = myRank > (ROLE_RANK[u.role] ?? 0) && myRank >= ROLE_RANK['manager'];
  const canMute  = canBan;
  const canRole  = myRank >= ROLE_RANK['admin'];
  const canNote  = myRank >= ROLE_RANK['admin'];
  const canClear = myRank >= ROLE_RANK['owner'];

  const roleOptions = ['user','mod','manager','admin','owner']
    .filter(r => (ROLE_RANK[r] ?? 0) < myRank)
    .map(r => `<option value="${r}"${u.role===r?' selected':''}>${r.charAt(0).toUpperCase()+r.slice(1)}</option>`)
    .join('');

  const recentMsgsHtml = msgs.slice(0, 10).map(m =>
    `<div class="admin-msg-row">
      <div class="admin-msg-content">${escapeHtml((m.content || '').slice(0, 120))}</div>
      <div class="admin-msg-meta">${fmtDateFull(m.timestamp)} · ${escapeHtml(m.channel_id || 'unknown')}</div>
    </div>`
  ).join('') || '<p style="color:var(--text-muted);font-size:13px">No messages found.</p>';

  el('details-modal-title').textContent = `User: ${username}`;
  el('details-content').innerHTML = `
    <div class="admin-user-card">
      <div class="admin-user-avatar" style="background:${roleColor}">${escapeHtml(username[0].toUpperCase())}</div>
      <div class="admin-user-info">
        <div class="admin-user-name">${escapeHtml(u.display_name || username)}</div>
        <div class="admin-user-meta">@${escapeHtml(username)} · Joined ${fmtDateFull(u.created_at || u.createdAt)}</div>
        <div class="admin-badge-row">
          <span class="admin-badge" style="background:${roleColor};color:#fff">${escapeHtml(u.role || 'user')}</span>
          ${u.banned ? '<span class="admin-badge admin-badge-banned">Banned</span>' : ''}
          ${u.muted  ? '<span class="admin-badge admin-badge-muted">Muted</span>'   : ''}
          ${u.messageCount !== undefined ? `<span class="admin-badge" style="background:var(--bg-secondary);color:var(--text-muted)">${u.messageCount} msgs</span>` : ''}
        </div>
      </div>
    </div>
    <div class="admin-detail-actions">
      ${canBan && !u.banned ? `<button class="admin-action-btn danger" onclick="adminBanUser('${escapeHtml(username)}');closeDetailsModal()">Ban</button>` : ''}
      ${canBan && u.banned  ? `<button class="admin-action-btn success" onclick="adminUnbanUser('${escapeHtml(username)}');closeDetailsModal()">Unban</button>` : ''}
      ${canMute && !u.muted ? `<button class="admin-action-btn warning" onclick="adminMuteUser('${escapeHtml(username)}');closeDetailsModal()">Mute</button>` : ''}
      ${canMute && u.muted  ? `<button class="admin-action-btn" onclick="adminUnmuteUser('${escapeHtml(username)}');closeDetailsModal()">Unmute</button>` : ''}
      ${canRole ? `
        <select id="admin-detail-role" onchange="adminSetRole('${escapeHtml(username)}',this.value);this.value=''" style="padding:6px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);font-size:13px;cursor:pointer">
          <option value="">Set role…</option>
          ${roleOptions}
        </select>` : ''}
      ${canClear ? `<button class="admin-action-btn danger" onclick="if(confirm('Wipe all messages?'))adminClearMessages('${escapeHtml(username)}')">Clear Messages</button>` : ''}
    </div>
    ${canNote ? `
    <div class="admin-detail-section">
      <div class="admin-detail-section-title">Staff Notes</div>
      <textarea id="admin-note-input" class="settings-input admin-notes-input" placeholder="Internal notes...">${escapeHtml(u.notes || '')}</textarea>
      <button class="admin-action-btn" style="margin-top:6px" onclick="adminSaveNote('${escapeHtml(username)}')">Save Note</button>
    </div>` : ''}
    <div class="admin-detail-section">
      <div class="admin-detail-section-title">Recent Messages</div>
      ${recentMsgsHtml}
    </div>
  `;
  show('details-modal');
}

async function adminSaveNote(username) {
  const note = el('admin-note-input')?.value || '';
  const data = await api('PATCH', `/api/admin/users/${username}`, { action: 'add_note', note });
  if (data.error) { toast(data.error, 'error'); return; }
  toast('Note saved', 'success');
}

async function adminClearMessages(username) {
  const data = await api('PATCH', `/api/admin/users/${username}`, { action: 'clear_messages' });
  if (data.error) { toast(data.error, 'error'); return; }
  toast('Messages cleared', 'success');
}

async function loadGaReports() {
  const data    = await api('GET', '/api/reports');
  const reports = data.reports || [];
  if (!reports.length) {
    el('ga-tab-reports').innerHTML = '<p style="padding:16px;color:var(--text-muted)">No reports.</p>';
    return;
  }
  let html = `<div class="admin-table-wrap"><table class="admin-table">
    <thead><tr><th>Reporter</th><th>Reason</th><th>Context</th><th>Status</th><th>Time</th><th>Actions</th></tr></thead><tbody>`;
  reports.forEach(r => {
    const statusColor = r.status === 'resolved' ? 'var(--success)' : r.status === 'dismissed' ? 'var(--text-muted)' : 'var(--warning)';
    html += `<tr>
      <td>${escapeHtml(r.reporter)}</td>
      <td>${escapeHtml(r.reason)}</td>
      <td>${escapeHtml(r.channel_id || r.server_id || 'DM')}</td>
      <td><span style="color:${statusColor}">${escapeHtml(r.status)}</span></td>
      <td>${fmtDateFull(r.timestamp)}</td>
      <td>
        <button class="admin-action-btn success" onclick="adminResolveReport('${escapeHtml(r.id)}','resolved')">Resolve</button>
        <button class="admin-action-btn danger"  onclick="adminResolveReport('${escapeHtml(r.id)}','dismissed')">Dismiss</button>
      </td>
    </tr>`;
  });
  html += `</tbody></table></div>`;
  el('ga-tab-reports').innerHTML = html;
}

async function adminResolveReport(id, status) {
  const action = status === 'dismissed' ? 'dismiss' : 'dismiss';
  const data = await api('PATCH', `/api/reports/${id}`, { action });
  if (data.error) { toast(data.error, 'error'); return; }
  toast('Report updated', 'success'); await loadGaReports();
}

async function loadGaAiFlags() {
  const data  = await api('GET', '/api/admin/ai-flags');
  const flags = Array.isArray(data) ? data : (data.flags || []);
  if (!flags.length) {
    el('ga-tab-aiflags').innerHTML = '<p style="padding:16px;color:var(--text-muted)">No AI flags.</p>';
    return;
  }
  let html = `<div class="admin-table-wrap"><table class="admin-table">
    <thead><tr><th>Author</th><th>Severity</th><th>Category</th><th>Reason</th><th>Content</th><th>Action</th><th>Time</th></tr></thead><tbody>`;
  flags.forEach(f => {
    const sevColor = f.severity === 'critical' ? 'var(--danger)' : f.severity === 'high' ? 'var(--warning)' : 'var(--text-muted)';
    const content  = (f.content || '').slice(0, 60);
    html += `<tr>
      <td><span class="admin-link" onclick="adminBanUser('${escapeHtml(f.author)}')">${escapeHtml(f.author)}</span></td>
      <td><span style="color:${sevColor};font-weight:700">${escapeHtml(f.severity)}</span></td>
      <td>${escapeHtml(f.categories)}</td>
      <td>${escapeHtml(f.reason)}</td>
      <td title="${escapeHtml(f.content)}">${escapeHtml(content)}${f.content?.length > 60 ? '…' : ''}</td>
      <td>${escapeHtml(f.auto_action || 'none')}</td>
      <td>${fmtDateFull(f.created_at)}</td>
    </tr>`;
  });
  html += `</tbody></table></div>`;
  el('ga-tab-aiflags').innerHTML = html;
}

async function loadGaPlatSettings() {
  const raw      = await api('GET', '/api/admin/settings');
  const settings = Array.isArray(raw) ? raw : Object.entries(raw || {}).map(([key, value]) => ({ key, value }));
  let html = '<div class="flex-col">';
  settings.forEach(s => {
    html += `<div class="settings-group">
      <p class="settings-group-title">${escapeHtml(s.key)}</p>
      <div class="flex-row-gap">
        <input type="text" id="platsetting-${escapeHtml(s.key)}" class="settings-input" value="${escapeHtml(s.value)}">
        <button onclick="savePlatSetting('${escapeHtml(s.key)}')">Save</button>
      </div>
    </div>`;
  });
  html += `
    <div class="settings-group">
      <p class="settings-group-title">Add New Setting</p>
      <div class="flex-col">
        <input type="text" id="new-plat-key"   class="settings-input" placeholder="key">
        <input type="text" id="new-plat-value" class="settings-input" placeholder="value">
        <button onclick="addPlatSetting()">Add</button>
      </div>
    </div>
  </div>`;
  el('ga-tab-platsettings').innerHTML = html;
}

async function savePlatSetting(key) {
  const val  = el('platsetting-' + key)?.value;
  const data = await api('POST', '/api/admin/settings', { key, value: val });
  if (data.error) { toast(data.error, 'error'); return; }
  toast('Saved', 'success');
}

async function addPlatSetting() {
  const key   = el('new-plat-key').value.trim();
  const value = el('new-plat-value').value.trim();
  if (!key) return;
  const data = await api('POST', '/api/admin/settings', { key, value });
  if (data.error) { toast(data.error, 'error'); return; }
  toast('Setting added', 'success'); await loadGaPlatSettings();
}

async function loadGaDeleted() {
  const data = await api('GET', '/api/admin/deleted');
  const msgs = data.messages || [];
  if (!msgs.length) {
    el('ga-tab-deleted').innerHTML = '<p style="padding:16px;color:var(--text-muted)">No deleted messages.</p>';
    return;
  }
  let html = `<div class="admin-table-wrap"><table class="admin-table">
    <thead><tr><th>Author</th><th>Content</th><th>Channel</th><th>Time</th></tr></thead><tbody>`;
  msgs.forEach(m => {
    const content = (m.content || '').slice(0, 80);
    html += `<tr>
      <td>${escapeHtml(m.author)}</td>
      <td>${escapeHtml(content)}${m.content?.length > 80 ? '…' : ''}</td>
      <td>${escapeHtml(m.channel_id || 'DM')}</td>
      <td>${fmtDateFull(m.timestamp)}</td>
    </tr>`;
  });
  html += `</tbody></table></div>`;
  el('ga-tab-deleted').innerHTML = html;
}

// ─── POLLING ──────────────────────────────────────────────────────────────────
function startPolling() {
  stopPolling();
  pollInterval = setInterval(async () => {
    if (currentChannelId) await pollNewMessages();
    if (currentDmId)      await fetchDmMessages(currentDmId);
  }, 2500);
}

function stopPolling() {
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
}

function notifyNewMsg() {
  if (document.hidden) setFaviconUnread(true);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) setFaviconUnread(false);
});

function setFaviconUnread(on) {
  const fav = el('favicon');
  if (!fav) return;
  fav.href = on
    ? 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="8" fill="%23ed4245"/><text x="4" y="12" font-size="10" fill="white">!</text></svg>'
    : '';
}

// ─── WEBSOCKET ────────────────────────────────────────────────────────────────
function connectWs() {
  if (ws) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.onopen = () => {
    wsReady = true;
    const token = localStorage.getItem('neuron_token');
    if (token) ws.send(JSON.stringify({ type:'auth', token }));
    setInterval(() => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type:'ping' })); }, 25000);
  };

  ws.onmessage = e => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    handleWsMsg(msg);
  };

  ws.onclose = () => { wsReady = false; ws = null; setTimeout(connectWs, 3000); };
  ws.onerror = () => { ws?.close(); };
}

function disconnectWs() { if (ws) { ws.close(); ws = null; wsReady = false; } }
function wsSend(obj) { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }

function handleWsMsg(msg) {
  switch (msg.type) {
    case 'voice-join':    handlePeerJoin(msg);      break;
    case 'voice-leave':   handlePeerLeave(msg.from); break;
    case 'offer':         handleOffer(msg);           break;
    case 'answer':        handleAnswer(msg);          break;
    case 'ice-candidate': handleIce(msg);             break;
    case 'call-invite':   handleIncomingCall(msg);   break;
    case 'call-accept':   handleCallAccepted(msg);   break;
    case 'call-reject':   handleCallRejected();       break;
    case 'call-end':      endCall();                  break;
  }
}

// ─── VOICE CHANNELS ───────────────────────────────────────────────────────────
async function joinVoiceChannel(ch) {
  if (currentVoiceRoom === ch.id) return;
  if (currentVoiceRoom) await leaveVoice();

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio:true, video:false });
  } catch { toast('Microphone access denied', 'error'); return; }

  currentVoiceRoom = ch.id;
  isMuted          = false;

  wsSend({ type:'voice-join', room:ch.id, server:currentServerId });

  show('voice-status-bar');
  el('vsb-room-name').textContent = ch.name;
  el('vsb-mute-btn').textContent  = '🎤';
}

async function leaveVoice() {
  wsSend({ type:'voice-leave', room:currentVoiceRoom });
  Object.values(peerConnections).forEach(pc => pc.close());
  peerConnections = {};
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  currentVoiceRoom = null;
  hide('voice-status-bar');
  document.querySelectorAll('audio.voice-peer').forEach(a => a.remove());
}

function toggleMute() {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
  el('vsb-mute-btn').textContent = isMuted ? '🔇' : '🎤';
}

async function handlePeerJoin(msg) {
  const pc    = createPc(msg.from);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  wsSend({ type:'offer', to:msg.from, sdp:offer });
}

function handlePeerLeave(from) {
  if (peerConnections[from]) { peerConnections[from].close(); delete peerConnections[from]; }
  document.getElementById('audio-' + from)?.remove();
}

async function handleOffer(msg) {
  const pc     = createPc(msg.from);
  await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  wsSend({ type:'answer', to:msg.from, sdp:answer });
}

async function handleAnswer(msg) {
  const pc = peerConnections[msg.from];
  if (pc) await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
}

async function handleIce(msg) {
  const pc = peerConnections[msg.from];
  if (pc && msg.candidate) await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
}

function createPc(peerId) {
  if (peerConnections[peerId]) return peerConnections[peerId];
  const pc = new RTCPeerConnection({ iceServers:[{ urls:'stun:stun.l.google.com:19302' }] });
  peerConnections[peerId] = pc;

  if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  pc.onicecandidate = e => { if (e.candidate) wsSend({ type:'ice-candidate', to:peerId, candidate:e.candidate }); };
  pc.ontrack = e => {
    let audio = document.getElementById('audio-' + peerId);
    if (!audio) {
      audio          = document.createElement('audio');
      audio.id       = 'audio-' + peerId;
      audio.className= 'voice-peer';
      audio.autoplay = true;
      document.body.appendChild(audio);
    }
    audio.srcObject = e.streams[0];
  };
  return pc;
}

// ─── PRIVATE CALLS ────────────────────────────────────────────────────────────
async function startCall() {
  if (!currentDmId) return;
  const conv = dmList.find(c => c.id === currentDmId);
  if (!conv || conv.type !== 'dm') return;
  const target = (conv.members || []).find(m => m !== currentUser.username);
  if (!target) return;

  try { localStream = await navigator.mediaDevices.getUserMedia({ audio:true, video:false }); }
  catch { toast('Microphone access denied', 'error'); return; }

  callState = { convId:currentDmId, with:target };
  wsSend({ type:'call-invite', to:target, from:currentUser.username, convId:currentDmId });

  show('call-status-bar');
  el('csb-name').textContent = target + ' (calling…)';
}

function handleIncomingCall(msg) {
  incomingCall = msg;
  el('call-caller-name').textContent = msg.from;
  show('call-overlay');
}

async function acceptCall() {
  hide('call-overlay');
  if (!incomingCall) return;
  wsSend({ type:'call-accept', to:incomingCall.from });

  try { localStream = await navigator.mediaDevices.getUserMedia({ audio:true, video:false }); }
  catch { toast('Microphone denied', 'error'); return; }

  callState = { convId:incomingCall.convId, with:incomingCall.from };
  createPc(incomingCall.from);
  show('call-status-bar');
  el('csb-name').textContent = incomingCall.from;
  incomingCall = null;
}

function rejectCall() {
  if (incomingCall) wsSend({ type:'call-reject', to:incomingCall.from });
  incomingCall = null; hide('call-overlay');
}

async function handleCallAccepted(msg) {
  if (!callState) return;
  el('csb-name').textContent = msg.from;
  const pc    = createPc(msg.from);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  wsSend({ type:'offer', to:msg.from, sdp:offer });
}

function handleCallRejected() {
  callState = null; hide('call-status-bar');
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  toast('Call rejected', 'info');
}

function endCall() {
  if (callState) wsSend({ type:'call-end', to:callState.with });
  callState  = null;
  hide('call-status-bar');
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  Object.values(peerConnections).forEach(pc => pc.close());
  peerConnections = {};
  document.querySelectorAll('audio.voice-peer').forEach(a => a.remove());
}

function toggleCallMute() {
  callMuted = !callMuted;
  if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = !callMuted);
  el('csb-mute-btn').textContent = callMuted ? '🔇' : '🎤';
}

// ─── MISC ─────────────────────────────────────────────────────────────────────
function closeHistoryModal() { hide('history-modal'); }

// ─── BOOT ─────────────────────────────────────────────────────────────────────
(async () => {
  const token = localStorage.getItem('neuron_token');
  if (token) await initApp();
})();
