// ─── STATE ────────────────────────────────────────────────────────
const S = {
  user: null,
  token: localStorage.getItem('mtcg_token'),
  view: 'login',
  collection: [],
  friends: [],
  leaderboard: [],
  myRank: null,
  reports: [],
  announcements: [],
  news: [],
  settings: {},
  battle: null,
  notifications: [],
  adminTab: 'users',
  settingsTab: 'profile',
  filterType: '',
  filterRarity: '',
  filterSearch: '',
  collectionPage: 1,
  allCards: [],
  allCardsTotal: 0,
  // Conquest
  conquestProgress: [],
  conquestPieces: [],
  conquestCtx: null,
  // Deck
  deck: [],
  deckCards: [],
  _pickerDeckIds: null,
  // PvP
  pvpBattle: null,
  _pvpPolling: null,
  _pvpRanked: false,
  // Conquest battle polling
  _cqBattleInterval: null,
  // DM chat
  chatWith: null,
  chatMessages: [],
  _chatInterval: null,
  dmUnread: {},
  // Profile
  profileUser: null,
  _statsInterval: null,
  // Trade
  trades: [],
  tradeTab: 'incoming',       // 'incoming' | 'outgoing' | 'new'
  tradeTarget: '',            // username being targeted
  tradeTargetCards: [],       // their collection
  tradeTargetTotal: 0,
  tradeTargetPage: 1,
  tradeTargetSearch: '',
  tradeMyCards: [],           // my collection for offer selection
  tradeMyTotal: 0,
  tradeMyPage: 1,
  tradeMySearch: '',
  tradeOffered: [],           // card ids I'm offering
  tradeRequested: [],         // card ids I'm requesting
  tradeMessage: '',
  // Card browser
  cbPage: 1,
  cbType: '',
  cbRarity: '',
  cbSearch: '',
  cbCards: [],
  cbTotal: 0,
  // Coaches
  myCoaches: [],
  myEquippedCoachId: null,
  // Traits
  myTraits: [],
  myCardTraits: {},   // cardId -> trait info
  // Friends inline chat
  friendsChatWith: null,   // {userId, username}
  friendsChatMsgs: [],
  _friendsChatPoll: null,
  // Quests & Battlepass
  myQuests: [],
  myBattlepass: null,
  bpRewards: [],
};

const TYPES = ['Fire','Water','Earth','Air','Shadow','Light','Thunder','Ice','Poison','Psychic','Nature','Metal','Dragon','Cosmic','Void','Crystal','Blood','Spirit','Chaos','Dream'];
const RARITIES = ['Common','Uncommon','Rare','Ultra_Rare','Secret_Rare','Full_Art','Parallel','Numbered','Prism','Mythic'];
const ROLE_ORDER = ['user','mod','admin','headofstaff','owner','developer'];
const COLORS = ['#c0392b','#2471a3','#1e8449','#b7860b','#6c3483','#148f77'];

// ─── MUSIC SYSTEM ─────────────────────────────────────────────────
const Music = (() => {
  let playing = false;
  let vol = parseFloat(localStorage.getItem('mtcg_vol') || '0.50');
  const audio = new Audio('/game-soundtrack.wav');
  audio.loop = true;
  audio.volume = vol;

  return {
    get on() { return playing; },
    get volume() { return vol; },
    get _ctx() { return null; },
    bootCtx() { return null; },
    start() {
      playing = true;
      audio.play().catch(() => {});
      localStorage.setItem('mtcg_music', '1');
      updateMusicBtn();
    },
    stop() {
      playing = false;
      audio.pause();
      localStorage.setItem('mtcg_music', '0');
      updateMusicBtn();
    },
    toggle() { this.on ? this.stop() : this.start(); },
    setPattern() {},
    setVolume(v) {
      vol = v;
      audio.volume = v;
      localStorage.setItem('mtcg_vol', v);
    },
    autoStart() {
      if (localStorage.getItem('mtcg_music') === '1') this.start();
    },
  };
})();

// ─── BATTLE MUSIC ─────────────────────────────────────────────────
const BattleMusic = (() => {
  const audio = new Audio('/Battle sound.wav');
  audio.loop = true;
  audio.volume = 0.65;
  let active = false;
  return {
    start() {
      if (active) return;
      active = true;
      Music.stop();
      audio.currentTime = 0;
      audio.play().catch(() => {});
    },
    stop() {
      if (!active) return;
      active = false;
      audio.pause();
      audio.currentTime = 0;
      if (localStorage.getItem('mtcg_music') === '1') Music.start();
    },
    get playing() { return active; },
  };
})();

function updateMusicBtn() {
  const btn = document.getElementById('music-toggle');
  if (btn) { btn.textContent = Music.on ? '♫' : '♪'; btn.title = Music.on ? 'Mute music' : 'Play music'; btn.classList.toggle('music-on', Music.on); }
}
window.toggleMusic = () => { Music.toggle(); };
window.Music = Music;

// ─── API ───────────────────────────────────────────────────────────
async function api(path, method = 'GET', body = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (S.token) opts.headers['Authorization'] = 'Bearer ' + S.token;
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch('/api' + path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ─── NOTIFY ───────────────────────────────────────────────────────
function notify(msg, type = 'info') {
  const n = document.createElement('div');
  n.className = 'notif ' + type;
  n.textContent = msg;
  document.getElementById('notifications').appendChild(n);
  setTimeout(() => n.remove(), 3500);
}

// ─── MODAL ────────────────────────────────────────────────────────
function openModal(html) {
  document.getElementById('modal-content').innerHTML = html;
  document.getElementById('modal-overlay').classList.remove('hidden');
}
function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
  document.getElementById('modal-content').innerHTML = '';
}
window.closeModal = closeModal;

// ─── ROUTER ───────────────────────────────────────────────────────
function nav(view) {
  const pvpViews = ['pvp_battle','pvp_queue'];
  if (S._pvpPolling && pvpViews.includes(S.view) && !pvpViews.includes(view)) {
    clearInterval(S._pvpPolling);
    S._pvpPolling = null;
  }
  if (S._cqBattleInterval && S.view === 'conquest_battle' && view !== 'conquest_battle') {
    clearInterval(S._cqBattleInterval);
    S._cqBattleInterval = null;
  }
  if (S._chatInterval && S.view === 'chat' && view !== 'chat') {
    clearInterval(S._chatInterval);
    S._chatInterval = null;
  }
  S.view = view;
  window.location.hash = view;
  const pat = ['pvp_battle','battle'].includes(view) ? 1 : view.startsWith('conquest') ? 2 : 0;
  Music.setPattern(pat);
  render();
}
window.nav = nav;

function render() {
  const app = document.getElementById('app');
  if (!S.user && S.view !== 'register') { renderAuth(app); return; }
  if (S.view === 'register') { renderRegister(app); return; }
  app.innerHTML = `
    ${renderNav()}
    <div id="page">${getView()}</div>
  `;
  attachListeners();
  if (S.view === 'cards' && !S.cbCards.length) loadCardBrowser();
}

function getView() {
  switch (S.view) {
    case 'home':        return viewHome();
    case 'shop':        return viewShop();
    case 'cards':       return viewCardBrowser();
    case 'conquest':         return viewConquest();
    case 'conquest_battle':  return viewConquestBattle();
    case 'collection':  return viewCollection();
    case 'deck':        return viewDeck();
    case 'battle':      return viewBattle();
    case 'pvp':         return viewPvp();
    case 'pvp_queue':   return viewPvpQueue();
    case 'pvp_battle':  return viewPvpBattle();
    case 'profile':     return viewProfile();
    case 'trade':       return viewTrade();
    case 'friends':     return viewFriends();
    case 'coaches':     return viewCoaches();
    case 'quests':      return viewQuests();
    case 'battlepass':  return viewBattlepass();
    case 'chat':        return viewChat();
    case 'leaderboard': return viewLeaderboard();
    case 'news':        return viewNews();
    case 'admin':       return viewAdmin();
    case 'reports':     return viewReports();
    case 'settings':    return viewSettings();
    default:            return viewHome();
  }
}

// ─── NAV ──────────────────────────────────────────────────────────
function renderNav() {
  const u = S.user;
  const links = [
    ['home','Home'],['shop','Shop'],['cards','All Cards'],['conquest','Conquest'],
    ['collection','Collection'],['deck','Deck'],['battle','Battle'],['pvp','PvP'],
    ['trade','Trade'],['friends','Friends'],['coaches','Coaches'],['quests','Quests'],['battlepass','Battle Pass'],['leaderboard','Leaderboard'],['news','News'],
    ['reports','Reports'],['settings','Settings']
  ];
  if (u && ROLE_ORDER.indexOf(u.role) >= ROLE_ORDER.indexOf('mod')) links.push(['admin','Admin']);
  const unread = S.notifications.filter(n => !n.read).length;
  const bellBadge = unread > 0 ? `<span class="notif-badge">${unread}</span>` : '';
  return `<nav id="navbar">
    <span class="nav-brand" onclick="nav('home')">Mythical TCG</span>
    ${links.map(([v,l]) => `<span class="nav-link${S.view===v?' active':''}" onclick="nav('${v}')">${l}</span>`).join('')}
    <span class="nav-spacer"></span>
    <a class="nav-link nav-discord" href="https://discord.gg/aZypDu8tqK" target="_blank" rel="noopener" title="Join our Discord">Discord</a>
    <div class="nav-user">
      <span class="nav-coins">${u ? u.coins + ' coins' : ''}</span>
      <div class="notif-bell" onclick="toggleNotifPanel()" title="Notifications">
        <span class="bell-icon">&#9993;</span>${bellBadge}
      </div>
      <span class="nav-avatar" onclick="nav('settings')" title="Settings">${u ? _av(u, 36) : ''}</span>
      <span class="role-badge role-${u?.role||'user'}">${u?.role||''}</span>
      ${u?.custom_title ? `<span class="custom-title-badge nav-custom-title">${u.custom_title}</span>` : ''}
      <button id="music-toggle" class="music-btn${Music.on?' music-on':''}" onclick="toggleMusic()" title="${Music.on?'Mute music':'Play music'}">${Music.on?'♫':'♪'}</button>
      <button class="btn btn-sm" onclick="logout()">Log out</button>
    </div>
  </nav>
  <div id="notif-panel" class="notif-panel hidden">
    <div class="notif-panel-header">
      <span>Notifications</span>
      <button class="btn btn-sm" onclick="markAllRead()">Mark all read</button>
    </div>
    <div id="notif-list">${renderNotifList()}</div>
  </div>`;
}

function renderNotifList() {
  if (!S.notifications.length) return '<p class="text-muted" style="padding:0.8rem 1rem;font-size:0.9rem">No notifications yet.</p>';
  return S.notifications.slice(0, 15).map(n => `
    <div class="notif-item${n.read ? '' : ' unread'}" onclick="readNotif(${n.id})">
      <div class="notif-item-avatar">${_av({avatar_img: n.from_avatar_img, avatar_color: n.from_avatar, username: n.from_username||'?'}, 34)}</div>
      <div class="notif-item-body">
        <div class="notif-item-msg">${n.message}</div>
        <div class="notif-item-time">${timeAgo(n.created_at)}</div>
      </div>
      ${!n.read ? '<div class="notif-dot"></div>' : ''}
    </div>`).join('');
}

function timeAgo(ts) {
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60000)    return 'just now';
  if (diff < 3600000)  return Math.floor(diff/60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff/3600000) + 'h ago';
  return Math.floor(diff/86400000) + 'd ago';
}

window.toggleNotifPanel = () => {
  const p = document.getElementById('notif-panel');
  if (p) p.classList.toggle('hidden');
};
window.markAllRead = async () => {
  await api('/notifications/read-all','PUT').catch(()=>{});
  S.notifications.forEach(n => n.read = true);
  const el = document.getElementById('notif-list');
  if (el) el.innerHTML = renderNotifList();
  updateNotifBell();
};
window.readNotif = async (id) => {
  await api('/notifications/' + id + '/read','PUT').catch(()=>{});
  const n = S.notifications.find(n => n.id === id);
  if (n) n.read = true;
  const el = document.getElementById('notif-list');
  if (el) el.innerHTML = renderNotifList();
  updateNotifBell();
};

function updateNotifBell() {
  const unread = S.notifications.filter(n => !n.read).length;
  const badge = document.querySelector('.notif-badge');
  const bell  = document.querySelector('.notif-bell');
  if (bell) {
    const existing = bell.querySelector('.notif-badge');
    if (unread > 0) {
      if (existing) existing.textContent = unread;
      else bell.insertAdjacentHTML('beforeend', `<span class="notif-badge">${unread}</span>`);
    } else if (existing) existing.remove();
  }
}

// ─── AUTH ──────────────────────────────────────────────────────────
function renderAuth(app) {
  app.innerHTML = `<div id="auth-page">
    <div class="auth-box">
      <h1 class="auth-title">Mythical TCG</h1>
      <p class="auth-subtitle">Collect. Battle. Conquer.</p>
      <div class="form-group">
        <label for="l-user">Username</label>
        <input id="l-user" class="input-sketch" placeholder="Enter your username" autocomplete="username">
      </div>
      <div class="form-group">
        <label for="l-pass">Password</label>
        <input id="l-pass" class="input-sketch" type="password" placeholder="Enter your password" autocomplete="current-password">
      </div>
      <div id="auth-err" class="text-red mb-2" style="min-height:1.2rem;font-size:0.95rem"></div>
      <button class="btn btn-primary" style="width:100%" onclick="doLogin()">Sign In</button>
      <hr class="auth-divider">
      <button class="btn" style="width:100%" onclick="nav('register')">Create Account</button>
    </div>
  </div>`;
  const li = (e) => { if (e.key === 'Enter') doLogin(); };
  app.querySelector('#l-user').addEventListener('keydown', li);
  app.querySelector('#l-pass').addEventListener('keydown', li);
}

function renderRegister(app) {
  app.innerHTML = `<div id="auth-page">
    <div class="auth-box">
      <h1 class="auth-title">Join the Adventure</h1>
      <p class="auth-subtitle">Create your account - no email needed</p>
      <div class="form-group">
        <label for="r-user">Username (3-20 chars, letters/numbers/_)</label>
        <input id="r-user" class="input-sketch" placeholder="Choose a username" autocomplete="username">
      </div>
      <div class="form-group">
        <label for="r-pass">Password (8+ characters)</label>
        <input id="r-pass" class="input-sketch" type="password" placeholder="Choose a password" autocomplete="new-password">
      </div>
      <div class="form-group">
        <label for="r-pass2">Confirm Password</label>
        <input id="r-pass2" class="input-sketch" type="password" placeholder="Confirm your password" autocomplete="new-password">
      </div>
      <div id="reg-err" class="text-red mb-2" style="min-height:1.2rem;font-size:0.95rem"></div>
      <button class="btn btn-primary" style="width:100%" onclick="doRegister()">Create Account</button>
      <hr class="auth-divider">
      <button class="btn" style="width:100%" onclick="nav('login')">Back to Sign In</button>
    </div>
  </div>`;
}

async function doLogin() {
  const u = document.getElementById('l-user')?.value?.trim();
  const p = document.getElementById('l-pass')?.value;
  const err = document.getElementById('auth-err');
  if (!u || !p) { if (err) err.textContent = 'Please fill in all fields'; return; }
  try {
    const data = await api('/auth/login','POST',{username:u,password:p});
    S.token = data.token;
    S.user = data.user;
    localStorage.setItem('mtcg_token', data.token);
    nav('home');
  } catch (e) { if (err) err.textContent = e.message; }
}
window.doLogin = doLogin;

async function doRegister() {
  const u = document.getElementById('r-user')?.value?.trim();
  const p = document.getElementById('r-pass')?.value;
  const p2 = document.getElementById('r-pass2')?.value;
  const err = document.getElementById('reg-err');
  if (!u || !p || !p2) { if (err) err.textContent = 'Please fill in all fields'; return; }
  if (p !== p2) { if (err) err.textContent = 'Passwords do not match'; return; }
  try {
    const data = await api('/auth/register','POST',{username:u,password:p});
    S.token = data.token;
    S.user = data.user;
    localStorage.setItem('mtcg_token', data.token);
    nav('home');
  } catch (e) { if (err) err.textContent = e.message; }
}
window.doRegister = doRegister;

function logout() {
  S.token = null; S.user = null;
  localStorage.removeItem('mtcg_token');
  S.view = 'login';
  render();
}
window.logout = logout;

// ─── CARD RENDERER ────────────────────────────────────────────────
function typeColor(type) {
  const m = {Fire:'#e74c3c',Water:'#2980b9',Earth:'#8e6b3e',Air:'#7fb3d3',Shadow:'#2c3e50',Light:'#e6b800',Thunder:'#f39c12',Ice:'#74b9ff',Poison:'#8e44ad',Psychic:'#c0392b',Nature:'#27ae60',Metal:'#808b96',Dragon:'#d35400',Cosmic:'#6c5ce7',Void:'#1a1a2e',Crystal:'#00cec9',Blood:'#a93226',Spirit:'#b2bec3',Chaos:'#d63031',Dream:'#a29bfe'};
  return m[type] || '#888';
}

function rarityLabel(r) {
  return {Common:'Common',Uncommon:'Uncommon',Rare:'Rare',Ultra_Rare:'Ultra Rare',Secret_Rare:'Secret Rare',Full_Art:'Full Art',Parallel:'Parallel',Numbered:'Numbered',Prism:'Prism Star',Mythic:'Mythic'}[r] || r;
}

// ─── PROCEDURAL CARD ART — unique per card ─────────────────────────
// Hand-drawn SVG art. Every card (id 1-200) is unique via seeded parameters.
function generateCardSVG(card) {
  const id  = card.id || 1;
  const rf  = (m) => ((id * m * 48271 + m * 17 + id % 31) % 97) / 97;
  const ri  = (m, n) => Math.floor(rf(m) * n);
  const tc  = typeColor(card.type || 'Fire');
  const cls = (card.class || 'Beast').toLowerCase();

  const sx  = (0.78 + rf(7)  * 0.40).toFixed(3);
  const sy  = (0.78 + rf(11) * 0.40).toFixed(3);
  const tx  = ((rf(13) - 0.5) * 14).toFixed(1);
  const ty  = ((rf(17) - 0.5) * 10).toFixed(1);
  const rot = ((rf(19) - 0.5) * 8).toFixed(2);

  // Per-card sketch filter for hand-drawn look
  const freq  = (0.030 + rf(23) * 0.045).toFixed(4);
  const disp  = (0.6  + rf(29) * 1.8).toFixed(2);
  const fid   = 'hd' + id;
  const defs  = '<defs>'
    + '<filter id="' + fid + '" x="-8%" y="-8%" width="116%" height="116%">'
    + '<feTurbulence type="fractalNoise" baseFrequency="' + freq + '" numOctaves="3" seed="' + (id % 99 + 1) + '" result="n"/>'
    + '<feDisplacementMap in="SourceGraphic" in2="n" scale="' + disp + '" xChannelSelector="R" yChannelSelector="G"/>'
    + '</filter>'
    + _artDefs(tc, id, rf)
    + '</defs>';

  const bg       = _artBg(card.type || 'Fire', tc, rf, ri);
  const creature = _artCreature(cls, tc, rf, ri, id);
  const fx       = _artRarityFx(card.rarity, tc, rf);

  return '<svg viewBox="0 0 100 90" xmlns="http://www.w3.org/2000/svg">'
    + defs + bg
    + '<g filter="url(#' + fid + ')" transform="translate(' + (50 + parseFloat(tx)) + ','
    + (44 + parseFloat(ty)) + ') scale(' + sx + ',' + sy + ') rotate(' + rot + ') translate(-50,-44)">'
    + creature + '</g>' + fx + '</svg>';
}

// Shared gradient defs — per-card lighter/darker tint of type color
function _artDefs(tc, id, rf) {
  let r=0,g=0,b=0;
  try{r=parseInt(tc.slice(1,3),16);g=parseInt(tc.slice(3,5),16);b=parseInt(tc.slice(5,7),16);}catch(e){}
  const h2=(v)=>Math.max(0,Math.min(255,v)).toString(16).padStart(2,'0');
  const lt='#'+h2(r+50+(rf(31)*40|0))+h2(g+50+(rf(37)*40|0))+h2(b+50+(rf(41)*40|0));
  const dk='#'+h2(r-30|0)+h2(g-30|0)+h2(b-30|0);
  const cx=(0.25+rf(43)*0.5).toFixed(2),cy=(0.15+rf(47)*0.3).toFixed(2);
  return '<radialGradient id="cg'+id+'" cx="'+cx+'" cy="'+cy+'" r="0.75" fx="'+cx+'" fy="'+cy+'">'
    +'<stop offset="0%" stop-color="'+lt+'"/>'
    +'<stop offset="58%" stop-color="'+tc+'"/>'
    +'<stop offset="100%" stop-color="'+dk+'"/>'
    +'</radialGradient>';
}

// Type-specific elaborate backgrounds — unique per card via seeded params
function _artBg(type, tc, rf, ri) {
  const t=(type||'Fire').toLowerCase();
  const base='<rect width="100" height="90" fill="#04060e"/>';
  // Atmospheric glow
  const gx=(18+rf(101)*64).toFixed(1),gy=(5+rf(103)*28).toFixed(1);
  const gr=(10+rf(107)*22).toFixed(1),go=(0.05+rf(109)*0.12).toFixed(3);
  const glow='<ellipse cx="'+gx+'" cy="'+gy+'" rx="'+gr+'" ry="'+(parseFloat(gr)*0.55).toFixed(1)+'" fill="'+tc+'" opacity="'+go+'"/>';
  // Universal floating particles
  const pts=[103,107,109,113,127,131,137,139].map(m=>{
    const px=(rf(m)*88+6).toFixed(1),py=(rf(m+2)*72+6).toFixed(1);
    const ps=(rf(m+4)*1.8+0.4).toFixed(1),pop=(rf(m+6)*0.14+0.04).toFixed(2);
    return '<circle cx="'+px+'" cy="'+py+'" r="'+ps+'" fill="'+tc+'" opacity="'+pop+'"/>';
  }).join('');
  // Type-specific scene
  let sc='';
  if(t==='fire'){
    const gy2=62+rf(3)*12,lw=18+rf(5)*45;
    sc='<ellipse cx="'+(20+rf(9)*60)+'" cy="'+gy2+'" rx="'+lw+'" ry="'+(lw*0.25)+'" fill="#8b1a00" opacity="0.5"/>'
      +'<ellipse cx="'+(25+rf(11)*50)+'" cy="'+(gy2+1)+'" rx="'+(lw*0.45)+'" ry="'+(lw*0.12)+'" fill="#e74c3c" opacity="0.18"/>'
      +[3,7,11,13].map(m=>'<ellipse cx="'+(8+rf(m)*84)+'" cy="'+(gy2-1+rf(m+2)*5)+'" rx="'+(3+rf(m+4)*7)+'" ry="'+(1.5+rf(m+6)*3)+'" fill="#1a0500" opacity="0.85"/>').join('')
      +[3,7,11,13,17].map(m=>'<circle cx="'+(5+rf(m)*90)+'" cy="'+(8+rf(m+2)*55)+'" r="'+(0.4+rf(m+4)*1.4)+'" fill="#f39c12" opacity="'+(0.25+rf(m+6)*0.55).toFixed(2)+'"/>').join('')
      +'<rect x="0" y="'+(gy2+4)+'" width="100" height="'+(90-gy2-4)+'" fill="#100200" opacity="0.88"/>';
  } else if(t==='water'){
    const hy=32+rf(3)*22;
    sc='<rect x="0" y="0" width="100" height="'+hy+'" fill="#060d1a" opacity="0.8"/>'
      +'<rect x="0" y="'+hy+'" width="100" height="'+(90-hy)+'" fill="#081628" opacity="0.9"/>'
      +[3,7,11,13,17].map((m,i)=>{const wy=hy+5+i*7+rf(m)*4,amp=2+rf(m+2)*5;return '<path d="M0,'+wy+' Q25,'+(wy-amp)+' 50,'+wy+' Q75,'+(wy+amp)+' 100,'+wy+'" stroke="#2980b9" stroke-width="'+(1.8-i*0.25)+'" fill="none" opacity="'+(0.55-i*0.08)+'"/>';}).join('')
      +'<line x1="'+(18+rf(19)*25)+'" y1="0" x2="'+(28+rf(21)*30)+'" y2="'+hy+'" stroke="#74b9ff" stroke-width="2" opacity="0.055"/>'
      +[3,7,11,13,17,19].map(m=>'<circle cx="'+(5+rf(m)*90)+'" cy="'+(hy+6+rf(m+2)*28)+'" r="'+(0.6+rf(m+4)*1.8)+'" fill="none" stroke="#74b9ff" stroke-width="0.5" opacity="'+(0.2+rf(m+6)*0.45).toFixed(2)+'"/>').join('');
  } else if(t==='earth'){
    const gy2=58+rf(3)*14;
    sc='<rect x="0" y="'+gy2+'" width="100" height="'+(90-gy2)+'" fill="#180e04" opacity="0.92"/>'
      +[3,7,11].map(m=>{const mx=8+rf(m)*78,mh=12+rf(m+2)*28,mw=7+rf(m+4)*18;return '<polygon points="'+mx+','+gy2+' '+(mx-mw)+','+gy2+' '+mx+','+(gy2-mh)+'" fill="#2c1808" opacity="0.8"/><polygon points="'+(mx+mw*0.25)+','+gy2+' '+(mx+mw)+','+gy2+' '+mx+','+(gy2-mh)+'" fill="#3d2210" opacity="0.65"/>';}).join('')
      +[3,7,11,13,17,19].map(m=>'<ellipse cx="'+(5+rf(m)*90)+'" cy="'+(gy2+2+rf(m+2)*5)+'" rx="'+(0.8+rf(m+4)*3)+'" ry="'+(0.5+rf(m+6)*1.5)+'" fill="#3a2010" opacity="0.7"/>').join('')
      +[3,7,11].map(m=>'<line x1="'+(10+rf(m)*80)+'" y1="'+gy2+'" x2="'+(9+rf(m)*80+(rf(m+2)-0.5)*5)+'" y2="'+(gy2-4-rf(m+4)*6)+'" stroke="#27ae60" stroke-width="1.2" opacity="0.45"/>').join('');
  } else if(t==='air'){
    sc=[3,7,11,13].map(m=>'<ellipse cx="'+(5+rf(m)*90)+'" cy="'+(6+rf(m+2)*40)+'" rx="'+(10+rf(m+4)*18)+'" ry="'+(4+rf(m+6)*8)+'" fill="white" opacity="'+(0.03+rf(m+8)*0.05)+'"/>').join('')
      +[3,7,11,13,17,19].map((m,i)=>'<path d="M'+(rf(m)*35)+','+(8+i*11)+' Q'+(28+rf(m+2)*30)+','+(4+i*11)+' '+(62+rf(m+4)*28)+','+(10+i*11+rf(m+6)*5)+'" stroke="#7fb3d3" stroke-width="'+(2.4-i*0.28)+'" fill="none" opacity="'+(0.35-i*0.04)+'" stroke-linecap="round"/>').join('');
  } else if(t==='shadow'){
    sc=[3,7,11,13,17,19,23].map(m=>{const sx2=rf(m)*100,cx2=rf(m+2)*100,cy2=12+rf(m+4)*50,ex=rf(m+6)*100,ey=rf(m+8)*38;return '<path d="M'+sx2+',90 Q'+cx2+','+cy2+' '+ex+','+ey+'" stroke="#2c3e50" stroke-width="'+(2.5+rf(m+10)*3.5)+'" fill="none" opacity="'+(0.25+rf(m+12)*0.38).toFixed(2)+'"/>';}).join('')
      +[3,7,11,13].map(m=>'<circle cx="'+(5+rf(m)*90)+'" cy="'+(5+rf(m+2)*60)+'" r="'+(1+rf(m+4)*4)+'" fill="#6c3483" opacity="'+(0.12+rf(m+6)*0.22).toFixed(2)+'"/>').join('');
  } else if(t==='light'){
    sc=[3,7,11,13,17,19].map(m=>{const bx=18+rf(m)*64,bw2=1.2+rf(m+2)*4;return '<path d="M'+bx+',0 L'+(bx-bw2*3)+',90 L'+(bx+bw2*3)+',90 Z" fill="#e6b800" opacity="'+(0.03+rf(m+4)*0.04)+'"/>';}).join('')
      +'<ellipse cx="'+(28+rf(29)*44)+'" cy="'+(4+rf(31)*14)+'" rx="'+(14+rf(33)*22)+'" ry="'+(7+rf(35)*12)+'" fill="#f6e96a" opacity="'+(0.05+rf(37)*0.07)+'"/>';
  } else if(t==='thunder'){
    sc=[3,7,11].map(m=>'<ellipse cx="'+(5+rf(m)*90)+'" cy="'+(4+rf(m+2)*18)+'" rx="'+(10+rf(m+4)*22)+'" ry="'+(5+rf(m+6)*8)+'" fill="#1a1a2e" opacity="0.85"/>').join('')
      +[3,7,11,13].map(m=>{const bx=14+rf(m)*72;return '<path d="M'+bx+',4 L'+(bx-4)+',34 L'+(bx+3)+',34 L'+(bx-6)+',72" stroke="#f1c40f" stroke-width="0.8" fill="none" opacity="'+(0.12+rf(m+2)*0.22)+'"/>';}).join('');
  } else if(t==='ice'){
    const gy2=60+rf(3)*14;
    sc='<rect x="0" y="'+gy2+'" width="100" height="'+(90-gy2)+'" fill="#081828" opacity="0.75"/>'
      +[3,7,11,13,17,19,23].map(m=>{const cx2=5+rf(m)*90,cy2=gy2+2+rf(m+2)*10,cr=2+rf(m+4)*6;
        return '<line x1="'+cx2+'" y1="'+cy2+'" x2="'+cx2+'" y2="'+(cy2-cr*2)+'" stroke="#74b9ff" stroke-width="0.8" opacity="0.5"/>'
          +'<line x1="'+(cx2-cr)+'" y1="'+(cy2-cr)+'" x2="'+(cx2+cr)+'" y2="'+(cy2+cr)+'" stroke="#74b9ff" stroke-width="0.7" opacity="0.4"/>'
          +'<line x1="'+(cx2+cr)+'" y1="'+(cy2-cr)+'" x2="'+(cx2-cr)+'" y2="'+(cy2+cr)+'" stroke="#74b9ff" stroke-width="0.7" opacity="0.4"/>';
      }).join('')
      +[3,7,11].map(m=>'<circle cx="'+(5+rf(m)*90)+'" cy="'+(rf(m+2)*55)+'" r="'+(0.4+rf(m+4)*1.5)+'" fill="#a8d8f0" opacity="'+(0.18+rf(m+6)*0.38).toFixed(2)+'"/>').join('');
  } else if(t==='poison'){
    sc=[3,7,11].map(m=>'<ellipse cx="'+(10+rf(m)*80)+'" cy="'+(58+rf(m+2)*16)+'" rx="'+(7+rf(m+4)*14)+'" ry="'+(3+rf(m+6)*5)+'" fill="#1a0b2e" opacity="0.75"/>').join('')
      +[3,7,11,13,17,19].map(m=>'<circle cx="'+(5+rf(m)*90)+'" cy="'+(52+rf(m+2)*28)+'" r="'+(0.8+rf(m+4)*2.8)+'" fill="#8e44ad" opacity="'+(0.08+rf(m+6)*0.18).toFixed(2)+'"/>').join('')
      +[3,7,11,13].map(m=>'<line x1="'+(5+rf(m)*90)+'" y1="'+(48+rf(m+2)*30)+'" x2="'+(5+rf(m)*90)+'" y2="'+(42+rf(m+2)*30)+'" stroke="#8e44ad" stroke-width="0.6" opacity="'+(0.18+rf(m+4)*0.28).toFixed(2)+'"/>').join('');
  } else if(t==='psychic'){
    sc=[3,7,11,13,17,19,23,29].map((m,i)=>{const cx2=18+rf(m)*64,cy2=10+rf(m+2)*50;return '<circle cx="'+cx2.toFixed(1)+'" cy="'+cy2.toFixed(1)+'" r="'+(5+i*6)+'" fill="none" stroke="#9b59b6" stroke-width="0.6" opacity="'+(0.07+rf(m+4)*0.09).toFixed(2)+'"/>';}).join('')
      +[3,7,11,13].map(m=>'<line x1="'+(rf(m)*100)+'" y1="'+(rf(m+2)*90)+'" x2="'+(rf(m+4)*100)+'" y2="'+(rf(m+6)*90)+'" stroke="#c0392b" stroke-width="0.5" opacity="'+(0.07+rf(m+8)*0.09).toFixed(2)+'"/>').join('');
  } else if(t==='nature'){
    const gy2=62+rf(3)*12;
    sc='<rect x="0" y="'+gy2+'" width="100" height="'+(90-gy2)+'" fill="#081404" opacity="0.88"/>'
      +[3,7,11,13].map(m=>{const vx=5+rf(m)*90,vy=gy2;return '<path d="M'+vx+','+vy+' Q'+(vx-7+rf(m+2)*14)+','+(vy-10-rf(m+4)*14)+' '+(vx-4+rf(m+6)*8)+','+(vy-22-rf(m+8)*14)+'" stroke="#1e8449" stroke-width="'+(0.9+rf(m+10)*1.6)+'" fill="none" opacity="0.55"/>';}).join('')
      +[3,7,11,13,17,19].map(m=>{const lx=5+rf(m)*90,ly=18+rf(m+2)*52,lw=3+rf(m+4)*7,lh=5+rf(m+6)*10;return '<ellipse cx="'+lx+'" cy="'+ly+'" rx="'+lw+'" ry="'+lh+'" fill="#27ae60" opacity="'+(0.08+rf(m+8)*0.11).toFixed(2)+'" transform="rotate('+(rf(m+10)*60-30)+','+lx+','+ly+')"/>';}).join('');
  } else if(t==='metal'){
    const gy2=58+rf(3)*16;
    sc='<rect x="0" y="'+gy2+'" width="100" height="'+(90-gy2)+'" fill="#0a0e14" opacity="0.92"/>'
      +[0,1,2,3,4].map(i=>'<line x1="0" y1="'+(gy2+i*5.5)+'" x2="100" y2="'+(gy2+i*5.5)+'" stroke="#566573" stroke-width="0.4" opacity="0.22"/>').join('')
      +[3,7,11,13,17,19,23].map(m=>'<circle cx="'+(5+rf(m)*90)+'" cy="'+(gy2+2+rf(m+2)*9)+'" r="'+(0.8+rf(m+4)*1.5)+'" fill="#7f8c8d" opacity="0.32"/>').join('');
  } else if(t==='dragon'){
    const gy2=56+rf(3)*14;
    sc='<rect x="0" y="'+gy2+'" width="100" height="'+(90-gy2)+'" fill="#0e0700" opacity="0.9"/>'
      +[3,7,11].map(m=>{const px=5+rf(m)*82,ph=9+rf(m+2)*26,pw=5+rf(m+4)*10;return '<rect x="'+(px-pw/2)+'" y="'+(gy2-ph)+'" width="'+pw+'" height="'+ph+'" fill="#180c00" opacity="0.72"/><rect x="'+(px-pw/2-1.5)+'" y="'+(gy2-ph)+'" width="'+(pw+3)+'" height="2.5" fill="#2c1500" opacity="0.55"/>';}).join('')
      +'<ellipse cx="'+(22+rf(19)*56)+'" cy="'+(gy2+4)+'" rx="'+(9+rf(21)*20)+'" ry="2.5" fill="#d35400" opacity="0.10"/>';
  } else if(t==='cosmic'){
    sc=[3,7,11,13,17,19,23,29,31,37].map(m=>'<circle cx="'+(rf(m)*100)+'" cy="'+(rf(m+2)*90)+'" r="'+(0.4+rf(m+4)*1.6)+'" fill="white" opacity="'+(0.18+rf(m+6)*0.62).toFixed(2)+'"/>').join('')
      +'<ellipse cx="'+(18+rf(41)*64)+'" cy="'+(8+rf(43)*42)+'" rx="'+(18+rf(45)*28)+'" ry="'+(9+rf(47)*18)+'" fill="#6c5ce7" opacity="0.065"/>'
      +'<ellipse cx="'+(28+rf(49)*44)+'" cy="'+(28+rf(51)*40)+'" rx="'+(14+rf(53)*24)+'" ry="'+(7+rf(55)*14)+'" fill="#a29bfe" opacity="0.048"/>';
  } else if(t==='void'){
    sc=[3,7,11,13].map(m=>{const px=10+rf(m)*80,py=10+rf(m+2)*50,pr=4+rf(m+4)*14;return '<circle cx="'+px+'" cy="'+py+'" r="'+pr+'" fill="#060614" opacity="0.75"/><circle cx="'+px+'" cy="'+py+'" r="'+(pr*0.58)+'" fill="none" stroke="#4a3fa0" stroke-width="0.9" opacity="0.38"/>';}).join('')
      +[3,7,11,13,17].map(m=>'<line x1="'+(rf(m)*100)+'" y1="'+(rf(m+2)*90)+'" x2="'+(rf(m+4)*100)+'" y2="'+(rf(m+6)*90)+'" stroke="#6c5ce7" stroke-width="0.4" opacity="'+(0.07+rf(m+8)*0.10).toFixed(2)+'"/>').join('');
  } else if(t==='crystal'){
    const gy2=58+rf(3)*14;
    sc='<rect x="0" y="'+gy2+'" width="100" height="'+(90-gy2)+'" fill="#001818" opacity="0.88"/>'
      +[3,7,11,13,17,19,23].map(m=>{const cx2=5+rf(m)*90,ch=7+rf(m+2)*20,cw=1.8+rf(m+4)*4;return '<polygon points="'+cx2+','+gy2+' '+(cx2-cw)+','+gy2+' '+(cx2-cw*0.55)+','+(gy2-ch)+' '+(cx2+cw*0.55)+','+(gy2-ch)+' '+(cx2+cw)+','+gy2+'" fill="#00cec9" opacity="'+(0.28+rf(m+6)*0.42).toFixed(2)+'"/>'; }).join('')
      +[3,7,11].map(m=>'<line x1="'+(5+rf(m)*90)+'" y1="'+(8+rf(m+2)*52)+'" x2="'+(5+rf(m+4)*90)+'" y2="'+(4+rf(m+6)*44)+'" stroke="#81ecec" stroke-width="0.5" opacity="'+(0.09+rf(m+8)*0.14).toFixed(2)+'"/>').join('');
  } else if(t==='blood'){
    const gy2=58+rf(3)*16;
    sc='<rect x="0" y="'+gy2+'" width="100" height="'+(90-gy2)+'" fill="#100000" opacity="0.9"/>'
      +[3,7,11,13,17,19].map(m=>{const dx=5+rf(m)*90,dy=4+rf(m+2)*42,dl=9+rf(m+4)*24;return '<line x1="'+dx+'" y1="'+dy+'" x2="'+(dx+(rf(m+6)-0.5)*4)+'" y2="'+(dy+dl)+'" stroke="#a93226" stroke-width="'+(0.9+rf(m+8)*1.8)+'" opacity="'+(0.22+rf(m+10)*0.32).toFixed(2)+'" stroke-linecap="round"/>';}).join('')
      +'<ellipse cx="'+(18+rf(29)*64)+'" cy="'+(gy2+4)+'" rx="'+(7+rf(31)*18)+'" ry="2.5" fill="#a93226" opacity="0.15"/>';
  } else if(t==='spirit'){
    sc=[3,7,11,13,17,19].map(m=>'<ellipse cx="'+(5+rf(m)*90)+'" cy="'+(8+rf(m+2)*62)+'" rx="'+(3+rf(m+4)*12)+'" ry="'+(2+rf(m+6)*6)+'" fill="#b2bec3" opacity="'+(0.04+rf(m+8)*0.07).toFixed(2)+'"/>').join('')
      +[3,7,11,13,17,19,23].map(m=>'<circle cx="'+(5+rf(m)*90)+'" cy="'+(8+rf(m+2)*72)+'" r="'+(0.4+rf(m+4)*1.5)+'" fill="#dfe6e9" opacity="'+(0.14+rf(m+6)*0.32).toFixed(2)+'"/>').join('');
  } else if(t==='chaos'){
    sc=[3,7,11,13,17,19,23,29].map(m=>{const p2=Array.from({length:5},(_,i)=>(rf(m+i*7)*100).toFixed(1)+','+(rf(m+i*7+2)*90).toFixed(1)).join(' ');return '<polygon points="'+p2+'" fill="'+tc+'" opacity="'+(0.03+rf(m+6)*0.045).toFixed(2)+'"/>';}).join('');
  } else if(t==='dream'){
    sc=[3,7,11,13].map(m=>'<ellipse cx="'+(5+rf(m)*90)+'" cy="'+(12+rf(m+2)*52)+'" rx="'+(7+rf(m+4)*16)+'" ry="'+(3.5+rf(m+6)*7)+'" fill="#a29bfe" opacity="'+(0.06+rf(m+8)*0.09).toFixed(2)+'"/>').join('')
      +[3,7,11,13,17,19,23].map(m=>'<circle cx="'+(5+rf(m)*90)+'" cy="'+(5+rf(m+2)*78)+'" r="'+(0.5+rf(m+4)*1.8)+'" fill="'+(ri(m+6,2)===0?'#fdcb6e':'#a29bfe')+'" opacity="'+(0.18+rf(m+8)*0.42).toFixed(2)+'"/>').join('');
  }
  return base+sc+glow+pts;
}

function _artEyes(tc, rf, ri, cx, ey) {
  const es=(2.2+rf(13)*2.4).toFixed(1), esp=(4.5+rf(17)*9).toFixed(1);
  const ep=(parseFloat(es)*0.44).toFixed(1), ep2=(parseFloat(ep)*0.38).toFixed(1);
  const lx=(cx-parseFloat(esp)/2).toFixed(1), rx=(cx+parseFloat(esp)/2).toFixed(1);
  const ec=['#e74c3c','#f1c40f','#00d2ff','#2ecc71','#e056fd','#ff9f43'][ri(19,6)];
  const ps=ri(29,3);
  const pu=ps===0
    ?'<circle cx="'+(parseFloat(lx)+0.5)+'" cy="'+(ey+0.4)+'" r="'+ep+'" fill="'+ec+'"/><circle cx="'+(parseFloat(rx)+0.5)+'" cy="'+(ey+0.4)+'" r="'+ep+'" fill="'+ec+'"/>'
    :ps===1
    ?'<ellipse cx="'+(parseFloat(lx)+0.5)+'" cy="'+(ey+0.3)+'" rx="'+(parseFloat(ep)*0.55)+'" ry="'+ep+'" fill="'+ec+'"/><ellipse cx="'+(parseFloat(rx)+0.5)+'" cy="'+(ey+0.3)+'" rx="'+(parseFloat(ep)*0.55)+'" ry="'+ep+'" fill="'+ec+'"/>'
    :'<rect x="'+(parseFloat(lx)-parseFloat(ep)*0.6)+'" y="'+(ey-parseFloat(ep))+'" width="'+(parseFloat(ep)*1.2)+'" height="'+(parseFloat(ep)*1.8)+'" fill="'+ec+'" rx="1"/><rect x="'+(parseFloat(rx)-parseFloat(ep)*0.6)+'" y="'+(ey-parseFloat(ep))+'" width="'+(parseFloat(ep)*1.2)+'" height="'+(parseFloat(ep)*1.8)+'" fill="'+ec+'" rx="1"/>';
  return '<circle cx="'+lx+'" cy="'+ey+'" r="'+es+'" fill="white" opacity="0.93"/>'
    +'<circle cx="'+rx+'" cy="'+ey+'" r="'+es+'" fill="white" opacity="0.93"/>'
    +pu
    +'<circle cx="'+(parseFloat(lx)-0.55)+'" cy="'+(ey-0.55)+'" r="'+ep2+'" fill="white" opacity="0.68"/>'
    +'<circle cx="'+(parseFloat(rx)-0.55)+'" cy="'+(ey-0.55)+'" r="'+ep2+'" fill="white" opacity="0.68"/>';
}

function _artCreature(cls, tc, rf, ri, id) {
  const v = ri(7, 8);
  const cg = 'url(#cg'+(id||1)+')';
  switch(cls) {
    case 'beast':     return _cBeast(tc, cg, v, rf, ri);
    case 'dragon':    return _cDragon(tc, cg, v, rf, ri);
    case 'golem':     return _cGolem(tc, cg, v, rf, ri);
    case 'sprite':    return _cSprite(tc, cg, v, rf, ri);
    case 'demon':     return _cDemon(tc, cg, v, rf, ri);
    case 'angel':     return _cAngel(tc, cg, v, rf, ri);
    case 'undead':    return _cUndead(tc, cg, v, rf, ri);
    case 'elemental': return _cElemental(tc, cg, v, rf, ri);
    case 'construct': return _cConstruct(tc, cg, v, rf, ri);
    case 'titan':     return _cTitan(tc, cg, v, rf, ri);
    default:          return _cBeast(tc, cg, v, rf, ri);
  }
}

// ── CREATURE CLASSES ─────────────────────────────────────────────
// Each gets 8 variants + unique markings + unique accessories per card

function _cBeast(tc, cg, v, rf, ri) {
  const bw=19+rf(23)*10, bh=10+rf(29)*6, by=56+rf(31)*6;
  const hx=38+rf(37)*12, hy=34+rf(43)*7, hr=9+rf(47)*5;
  const earH=6+rf(53)*7, earW=3.5+rf(57)*3;
  // 4 ear styles
  const es2=ri(61,4);
  const ears=es2===0
    ?'<polygon points="'+(hx-4)+','+(hy-hr)+' '+(hx-8)+','+(hy-hr-earH)+' '+(hx-0.8)+','+(hy-hr-2)+'" fill="'+cg+'"/><polygon points="'+(hx+4)+','+(hy-hr)+' '+(hx+8)+','+(hy-hr-earH)+' '+(hx+0.8)+','+(hy-hr-2)+'" fill="'+cg+'"/>'
    :es2===1
    ?'<ellipse cx="'+(hx-5)+'" cy="'+(hy-hr-earH*0.5)+'" rx="'+earW+'" ry="'+(earH*0.62)+'" fill="'+cg+'"/><ellipse cx="'+(hx+5)+'" cy="'+(hy-hr-earH*0.5)+'" rx="'+earW+'" ry="'+(earH*0.62)+'" fill="'+cg+'"/>'
    :es2===2
    ?'<path d="M'+(hx-4)+','+(hy-hr)+' Q'+(hx-11)+','+(hy-hr-earH*0.65)+' '+(hx-6)+','+(hy-hr-earH)+'Z" fill="'+cg+'"/><path d="M'+(hx+4)+','+(hy-hr)+' Q'+(hx+11)+','+(hy-hr-earH*0.65)+' '+(hx+6)+','+(hy-hr-earH)+'Z" fill="'+cg+'"/>'
    :'<line x1="'+(hx-4)+'" y1="'+(hy-hr)+'" x2="'+(hx-6)+'" y2="'+(hy-hr-earH)+'" stroke="'+tc+'" stroke-width="3" stroke-linecap="round"/><line x1="'+(hx+4)+'" y1="'+(hy-hr)+'" x2="'+(hx+6)+'" y2="'+(hy-hr-earH)+'" stroke="'+tc+'" stroke-width="3" stroke-linecap="round"/>';
  const td=v%2===0?1:-1;
  const ts=ri(67,3);
  const tail=ts===0
    ?'<path d="M'+(50+bw)+','+(by-4)+' Q'+(50+bw+td*14)+','+(by-18)+' '+(50+bw+td*8)+','+(by-28)+'" stroke="'+tc+'" stroke-width="3.5" fill="none" stroke-linecap="round"/>'
    :ts===1
    ?'<path d="M'+(50+bw)+','+(by-4)+' Q'+(50+bw+td*8)+','+(by-10)+' '+(50+bw+td*16)+','+(by-7)+' Q'+(50+bw+td*20)+','+(by-3)+' '+(50+bw+td*12)+','+(by-22)+'" stroke="'+tc+'" stroke-width="3" fill="none" stroke-linecap="round"/>'
    :'<path d="M'+(50+bw)+','+(by)+' Q'+(50+bw+td*10)+','+(by+8)+' '+(50+bw+td*6)+','+(by-14)+'" stroke="'+tc+'" stroke-width="4" fill="none" stroke-linecap="round"/><polygon points="'+(50+bw+td*5)+','+(by-15)+' '+(50+bw+td*2)+','+(by-12)+' '+(50+bw+td*8)+','+(by-11)+'" fill="'+tc+'"/>';
  const legH=(9+rf(59)*5).toFixed(1);
  const lo=(rf(71)-0.5)*4;
  const legs=[-12+lo,-4,4+lo,12].map(lx=>'<rect x="'+(50+lx-2).toFixed(0)+'" y="'+(by+bh/2).toFixed(0)+'" width="4.5" height="'+legH+'" fill="'+cg+'" rx="2.2"/>').join('');
  const sx2=hx-hr+2, sy2=hy+4;
  const sw=4.2+rf(73)*2.8, sh=2.8+rf(79)*2;
  const snout='<ellipse cx="'+sx2.toFixed(1)+'" cy="'+sy2.toFixed(1)+'" rx="'+sw+'" ry="'+sh+'" fill="'+cg+'" opacity="0.72"/>'
    +'<circle cx="'+(sx2-1.5).toFixed(1)+'" cy="'+(sy2-0.7).toFixed(1)+'" r="1.2" fill="#080818"/>'
    +'<circle cx="'+(sx2+1.5).toFixed(1)+'" cy="'+(sy2-0.7).toFixed(1)+'" r="1.2" fill="#080818"/>';
  // 6 marking styles
  const ms=ri(83,6);
  const marks=ms===0?'<line x1="'+(50-8)+'" y1="'+(by-4)+'" x2="'+(50-2)+'" y2="'+(by-9)+'" stroke="#00000044" stroke-width="1.5"/><line x1="'+(50-4)+'" y1="'+(by)+'" x2="'+(50+2)+'" y2="'+(by-5)+'" stroke="#00000044" stroke-width="1.5"/>'
    :ms===1?'<circle cx="'+(50-5)+'" cy="'+(by-5)+'" r="2.8" fill="#00000033"/><circle cx="'+(50+6)+'" cy="'+(by-9)+'" r="2" fill="#00000033"/><circle cx="'+(50-10)+'" cy="'+(by-8)+'" r="1.4" fill="#00000033"/>'
    :ms===2?'<path d="M'+(hx-7)+','+(hy-4)+' Q'+(hx-3)+','+(hy-8)+' '+hx+','+(hy-4)+' Q'+(hx+3)+','+(hy)+' '+(hx+7)+','+(hy-4)+'" stroke="#ffffff22" stroke-width="1.2" fill="none"/>'
    :ms===3?'<rect x="'+(50-12)+'" y="'+(by-12)+'" width="8" height="2" fill="#00000030" rx="1"/><rect x="'+(50-12)+'" y="'+(by-9)+'" width="8" height="2" fill="#00000028" rx="1"/><rect x="'+(50+4)+'" y="'+(by-12)+'" width="8" height="2" fill="#00000030" rx="1"/>'
    :ms===4?'<polygon points="'+(hx-3)+','+(hy-hr+4)+' '+hx+','+(hy-hr-3)+' '+(hx+3)+','+(hy-hr+4)+'" fill="#ffffff30"/><polygon points="'+(hx-3)+','+(hy-hr+8)+' '+hx+','+(hy-hr+2)+' '+(hx+3)+','+(hy-hr+8)+'" fill="#ffffff25"/>'
    :'<line x1="'+(50-14)+'" y1="'+(by-3)+'" x2="'+(50+14)+'" y2="'+(by-3)+'" stroke="#00000022" stroke-width="1.5"/><line x1="'+(50-14)+'" y1="'+(by-7)+'" x2="'+(50+14)+'" y2="'+(by-7)+'" stroke="#00000018" stroke-width="1"/>';
  // 6 accessory styles
  const as=ri(89,6);
  const acc=as===0?'<rect x="'+(hx-hr+2)+'" y="'+(hy+hr-4)+'" width="'+(hr*1.6)+'" height="2.8" fill="'+tc+'" opacity="0.82" rx="1.4"/>'
    :as===1?'<line x1="'+(hx-5)+'" y1="'+(hy-3)+'" x2="'+(hx-8)+'" y2="'+(hy+5)+'" stroke="#00000055" stroke-width="1.5" stroke-linecap="round"/>'
    :as===2?'<circle cx="'+hx+'" cy="'+(hy-hr-5)+'" r="3.5" fill="'+tc+'" opacity="0.9"/><circle cx="'+hx+'" cy="'+(hy-hr-5)+'" r="1.9" fill="white" opacity="0.58"/>'
    :as===3?'<path d="M'+(50-bw*0.3)+','+(by-bh/2)+' Q50,'+(by-bh*1.1)+' '+(50+bw*0.3)+','+(by-bh/2)+'" stroke="'+tc+'" stroke-width="2.2" fill="none" opacity="0.55"/>'
    :as===4?Array.from({length:3},(_,i)=>'<circle cx="'+(hx-7+i*7)+'" cy="'+(hy+6)+'" r="1.5" fill="'+tc+'" opacity="0.7"/>').join('')
    :'<path d="M'+(hx-6)+','+(hy-4)+' Q'+(hx-2)+','+(hy-9)+' '+(hx+6)+','+(hy-4)+'" stroke="#ffffff28" stroke-width="1.4" fill="none"/>';
  return ears
    +'<ellipse cx="50" cy="'+by.toFixed(1)+'" rx="'+bw.toFixed(1)+'" ry="'+bh.toFixed(1)+'" fill="'+cg+'"/>'
    +'<circle cx="'+hx.toFixed(1)+'" cy="'+hy.toFixed(1)+'" r="'+hr.toFixed(1)+'" fill="'+cg+'"/>'
    +snout+marks+acc+tail+legs+_artEyes(tc,rf,ri,hx,hy-1.5);
}

function _cDragon(tc, cg, v, rf, ri) {
  const nx=46+rf(23)*8, ny=20+rf(29)*7;
  const bx=50, by=60, bw=16+rf(37)*8, bh=11+rf(41)*5;
  const hx=nx+rf(43)*5-2, hy=ny-rf(47)*4;
  const hr=8+rf(53)*4;
  const wSpan=22+rf(59)*16, wH=16+rf(61)*12;
  // 4 wing styles
  const ws=ri(63,4);
  const wing1=ws<2
    ?'<path d="M'+(bx-8)+','+(by-4)+' Q'+(bx-wSpan)+','+(by-wH)+' '+(bx-wSpan+12)+','+(by-wH-10)+' Q'+(bx-wSpan*0.5)+','+(by-wH+5)+' '+(bx-6)+','+(by-10)+'Z" fill="'+cg+'" opacity="0.80"/>'
    :'<path d="M'+(bx-7)+','+(by-5)+' L'+(bx-wSpan+8)+','+(by-wH-4)+' L'+(bx-wSpan)+','+(by-wH-10)+' L'+(bx-wSpan*0.55)+','+(by-wH)+' L'+(bx-wSpan*0.3)+','+(by-wH*0.55)+' L'+(bx-7)+','+(by-10)+'Z" fill="'+cg+'" opacity="0.78"/>';
  const wing2=ws<2
    ?'<path d="M'+(bx+8)+','+(by-4)+' Q'+(bx+wSpan)+','+(by-wH)+' '+(bx+wSpan-12)+','+(by-wH-10)+' Q'+(bx+wSpan*0.5)+','+(by-wH+5)+' '+(bx+6)+','+(by-10)+'Z" fill="'+cg+'" opacity="0.80"/>'
    :'<path d="M'+(bx+7)+','+(by-5)+' L'+(bx+wSpan-8)+','+(by-wH-4)+' L'+(bx+wSpan)+','+(by-wH-10)+' L'+(bx+wSpan*0.55)+','+(by-wH)+' L'+(bx+wSpan*0.3)+','+(by-wH*0.55)+' L'+(bx+7)+','+(by-10)+'Z" fill="'+cg+'" opacity="0.78"/>';
  // Wing membranes
  const wm=[0.30,0.55,0.78].map(f=>'<line x1="'+(bx-7)+'" y1="'+(by-8)+'" x2="'+(bx-wSpan*f).toFixed(1)+'" y2="'+(by-wH*f*0.82).toFixed(1)+'" stroke="'+tc+'" stroke-width="0.7" opacity="0.28"/>').join('')
    +[0.30,0.55,0.78].map(f=>'<line x1="'+(bx+7)+'" y1="'+(by-8)+'" x2="'+(bx+wSpan*f).toFixed(1)+'" y2="'+(by-wH*f*0.82).toFixed(1)+'" stroke="'+tc+'" stroke-width="0.7" opacity="0.28"/>').join('');
  const neck='<path d="M'+bx+','+(by-bh/2)+' Q'+(nx+3)+','+(hy+22)+' '+hx+','+hy+'" stroke="'+cg+'" stroke-width="9" fill="none" stroke-linecap="round"/>';
  // 4 horn styles
  const hs=ri(65,4);
  const horns=hs===0
    ?'<line x1="'+(hx-5)+'" y1="'+(hy-hr)+'" x2="'+(hx-10)+'" y2="'+(hy-hr-12)+'" stroke="'+tc+'" stroke-width="2.8" stroke-linecap="round"/><line x1="'+(hx+5)+'" y1="'+(hy-hr)+'" x2="'+(hx+10)+'" y2="'+(hy-hr-12)+'" stroke="'+tc+'" stroke-width="2.8" stroke-linecap="round"/>'
    :hs===1
    ?'<path d="M'+(hx-5)+','+(hy-hr)+' Q'+(hx-14)+','+(hy-hr-6)+' '+(hx-8)+','+(hy-hr-14)+'" stroke="'+tc+'" stroke-width="2.8" fill="none"/><path d="M'+(hx+5)+','+(hy-hr)+' Q'+(hx+14)+','+(hy-hr-6)+' '+(hx+8)+','+(hy-hr-14)+'" stroke="'+tc+'" stroke-width="2.8" fill="none"/>'
    :hs===2
    ?'<polygon points="'+(hx-5)+','+(hy-hr)+' '+(hx-10)+','+(hy-hr-15)+' '+(hx-1)+','+(hy-hr-2)+'" fill="'+tc+'"/><polygon points="'+(hx+5)+','+(hy-hr)+' '+(hx+10)+','+(hy-hr-15)+' '+(hx+1)+','+(hy-hr-2)+'" fill="'+tc+'"/>'
    :'<path d="M'+(hx-4)+','+(hy-hr)+' Q'+(hx-9)+','+(hy-hr-5)+' '+(hx-5)+','+(hy-hr-10)+' Q'+(hx-10)+','+(hy-hr-10)+' '+(hx-7)+','+(hy-hr-16)+'" stroke="'+tc+'" stroke-width="2.2" fill="none"/><path d="M'+(hx+4)+','+(hy-hr)+' Q'+(hx+9)+','+(hy-hr-5)+' '+(hx+5)+','+(hy-hr-10)+' Q'+(hx+10)+','+(hy-hr-10)+' '+(hx+7)+','+(hy-hr-16)+'" stroke="'+tc+'" stroke-width="2.2" fill="none"/>';
  // Spines on back
  const sps=ri(69,3);
  const spines=sps>0?[0.2,0.4,0.6,0.8].map(f=>'<polygon points="'+(bx-bw+f*bw*2)+','+(by-bh/2)+' '+(bx-bw+f*bw*2-2)+','+(by-bh/2)+' '+(bx-bw+f*bw*2-1)+','+(by-bh/2-5-rf(f*13)*4)+'" fill="'+tc+'" opacity="0.7"/>').join(''):'';
  // Tail
  const ts2=ri(71,3);
  const tail=ts2===0
    ?'<path d="M'+(bx+bw)+','+(by)+' Q'+(bx+bw+16)+','+(by+6)+' '+(bx+bw+20)+','+(by-10)+'" stroke="'+tc+'" stroke-width="4" fill="none" stroke-linecap="round"/>'
    :ts2===1
    ?'<path d="M'+(bx+bw)+','+(by)+' Q'+(bx+bw+10)+','+(by+4)+' '+(bx+bw+18)+','+(by+12)+' Q'+(bx+bw+22)+','+(by+18)+' '+(bx+bw+14)+','+(by+14)+'" stroke="'+tc+'" stroke-width="4" fill="none" stroke-linecap="round"/>'
    :'<path d="M'+(bx+bw)+','+(by)+' Q'+(bx+bw+8)+','+(by-5)+' '+(bx+bw+14)+','+(by-14)+'" stroke="'+tc+'" stroke-width="4" fill="none" stroke-linecap="round"/><polygon points="'+(bx+bw+14)+','+(by-14)+' '+(bx+bw+9)+','+(by-18)+' '+(bx+bw+18)+','+(by-18)+'" fill="'+tc+'"/>';
  const legs='<rect x="'+(bx-14)+'" y="'+(by+bh/2)+'" width="6.5" height="11" fill="'+cg+'" rx="3.2"/><rect x="'+(bx+7)+'" y="'+(by+bh/2)+'" width="6.5" height="11" fill="'+cg+'" rx="3.2"/>';
  return wing1+wing2+wm+neck+spines
    +'<ellipse cx="'+bx+'" cy="'+by.toFixed(1)+'" rx="'+bw.toFixed(1)+'" ry="'+bh.toFixed(1)+'" fill="'+cg+'"/>'
    +'<circle cx="'+hx.toFixed(1)+'" cy="'+hy.toFixed(1)+'" r="'+hr.toFixed(1)+'" fill="'+cg+'"/>'
    +horns+tail+legs+_artEyes(tc,rf,ri,hx,hy);
}

function _cGolem(tc, cg, v, rf, ri) {
  const bx=50, by=52, bw=18+rf(23)*8, bh=16+rf(29)*6;
  const hx=48+rf(37)*6, hy=26+rf(41)*5;
  const hS=10+rf(47)*5;
  const armW=6+rf(53)*4, armH=16+rf(59)*7;
  const legW=7+rf(61)*4, legH=12+rf(67)*6;
  // Core gem — 4 shapes
  const cs=ri(69,4), cR=4+rf(71)*4;
  const core=cs===0
    ?'<circle cx="'+bx+'" cy="'+by+'" r="'+cR.toFixed(1)+'" fill="'+cg+'" opacity="0.95"/><circle cx="'+bx+'" cy="'+by+'" r="'+(cR*0.48).toFixed(1)+'" fill="white" opacity="0.75"/>'
    :cs===1
    ?'<polygon points="'+bx+','+(by-cR)+' '+(bx+cR*0.87)+','+(by+cR*0.5)+' '+(bx-cR*0.87)+','+(by+cR*0.5)+'" fill="'+cg+'" opacity="0.92"/>'
    :cs===2
    ?'<rect x="'+(bx-cR)+'" y="'+(by-cR)+'" width="'+(cR*2)+'" height="'+(cR*2)+'" fill="'+cg+'" opacity="0.9" rx="1.5"/><rect x="'+(bx-cR*0.5)+'" y="'+(by-cR*0.5)+'" width="'+cR+'" height="'+cR+'" fill="white" opacity="0.5" rx="1"/>'
    :'<polygon points="'+bx+','+(by-cR)+' '+(bx+cR)+','+by+' '+bx+','+(by+cR)+' '+(bx-cR)+','+by+'" fill="'+cg+'" opacity="0.92"/><circle cx="'+bx+'" cy="'+by+'" r="'+(cR*0.38).toFixed(1)+'" fill="white" opacity="0.68"/>';
  // Cracks — 4 styles
  const cks=ri(73,4);
  const cracks=cks===0
    ?'<line x1="'+(bx-10)+'" y1="'+(by-8)+'" x2="'+(bx-3)+'" y2="'+(by+5)+'" stroke="#080818" stroke-width="1.5" opacity="0.55"/><line x1="'+(bx+6)+'" y1="'+(by-7)+'" x2="'+(bx+2)+'" y2="'+(by+9)+'" stroke="#080818" stroke-width="1.2" opacity="0.45"/>'
    :cks===1
    ?'<path d="M'+(bx-9)+','+(by-4)+' l3,5 -2,4 3,3" stroke="#080818" stroke-width="1.2" fill="none" opacity="0.55"/><path d="M'+(bx+5)+','+(by-6)+' l-2,4 3,5" stroke="#080818" stroke-width="1" fill="none" opacity="0.4"/>'
    :cks===2
    ?'<line x1="'+(bx-12)+'" y1="'+(by+bh/2-2)+'" x2="'+(bx+4)+'" y2="'+(by-bh/2+2)+'" stroke="#080818" stroke-width="1.6" opacity="0.45"/>'
    :'<path d="M'+(bx-8)+','+(by-bh/3)+' Q'+(bx)+','+(by)+' '+(bx+7)+','+(by+bh/3)+'" stroke="#080818" stroke-width="1.2" fill="none" opacity="0.5"/>';
  // Runes on head — 4 styles
  const rs=ri(79,4);
  const rune=rs===0
    ?'<line x1="'+(hx-6)+'" y1="'+hy+'" x2="'+(hx+6)+'" y2="'+hy+'" stroke="'+tc+'" stroke-width="1.5" opacity="0.62"/><line x1="'+hx+'" y1="'+(hy-5)+'" x2="'+hx+'" y2="'+(hy+5)+'" stroke="'+tc+'" stroke-width="1.5" opacity="0.62"/>'
    :rs===1
    ?'<circle cx="'+hx+'" cy="'+(hy+3)+'" r="3" fill="none" stroke="'+tc+'" stroke-width="1.3" opacity="0.72"/>'
    :rs===2
    ?'<polygon points="'+hx+','+(hy-5)+' '+(hx+4.5)+','+(hy+2.5)+' '+(hx-4.5)+','+(hy+2.5)+'" fill="none" stroke="'+tc+'" stroke-width="1.3" opacity="0.65"/>'
    :'<path d="M'+(hx-5)+','+(hy-3)+' L'+hx+','+(hy-7)+' L'+(hx+5)+','+(hy-3)+' L'+(hx+5)+','+(hy+3)+' L'+hx+','+(hy+7)+' L'+(hx-5)+','+(hy+3)+'Z" fill="none" stroke="'+tc+'" stroke-width="1.1" opacity="0.6"/>';
  // Boulder shoulders
  const ss=ri(83,3), sR=6+rf(85)*5;
  const shoulders=ss>0?'<circle cx="'+(bx-bw-armW*0.5)+'" cy="'+(by-bh/2+4)+'" r="'+sR.toFixed(1)+'" fill="'+cg+'" opacity="0.75"/><circle cx="'+(bx+bw+armW*0.5)+'" cy="'+(by-bh/2+4)+'" r="'+sR.toFixed(1)+'" fill="'+cg+'" opacity="0.75"/>':'';
  return '<rect x="'+(bx-armW-bw)+'" y="'+(by-bh/2+2)+'" width="'+armW+'" height="'+armH+'" fill="'+cg+'" rx="3"/>'
    +'<rect x="'+(bx+bw)+'" y="'+(by-bh/2+2)+'" width="'+armW+'" height="'+armH+'" fill="'+cg+'" rx="3"/>'
    +'<rect x="'+(bx-legW*0.75)+'" y="'+(by+bh/2)+'" width="'+legW+'" height="'+legH+'" fill="'+cg+'" rx="3.5"/>'
    +'<rect x="'+(bx-legW*0.25+legW*0.25)+'" y="'+(by+bh/2)+'" width="'+legW+'" height="'+legH+'" fill="'+cg+'" rx="3.5"/>'
    +'<rect x="'+(bx-bw)+'" y="'+(by-bh/2)+'" width="'+(bw*2)+'" height="'+bh+'" fill="'+cg+'" rx="4.5"/>'
    +'<rect x="'+(hx-hS)+'" y="'+(hy-hS)+'" width="'+(hS*2)+'" height="'+(hS*2)+'" fill="'+cg+'" rx="4"/>'
    +shoulders+core+cracks+rune+_artEyes(tc,rf,ri,hx,hy+2);
}

function _cSprite(tc, cg, v, rf, ri) {
  const bx=50, by=54, bR=7+rf(23)*5;
  const hx=48+rf(37)*5, hy=35+rf(41)*6;
  const hr=6+rf(47)*4;
  const wW=18+rf(53)*14, wH=14+rf(59)*12;
  const wOp=(0.52+rf(61)*0.28).toFixed(2);
  // 4 wing styles
  const ws=ri(63,4);
  const wings=ws===0
    ?'<ellipse cx="'+(bx-wW*0.55)+'" cy="'+(by-4)+'" rx="'+(wW*0.55)+'" ry="'+(wH*0.62)+'" fill="'+cg+'" opacity="'+wOp+'"/><ellipse cx="'+(bx+wW*0.55)+'" cy="'+(by-4)+'" rx="'+(wW*0.55)+'" ry="'+(wH*0.62)+'" fill="'+cg+'" opacity="'+wOp+'"/><ellipse cx="'+(bx-wW*0.34)+'" cy="'+(by+7)+'" rx="'+(wW*0.3)+'" ry="'+(wH*0.42)+'" fill="'+cg+'" opacity="'+(parseFloat(wOp)*0.68).toFixed(2)+'"/><ellipse cx="'+(bx+wW*0.34)+'" cy="'+(by+7)+'" rx="'+(wW*0.3)+'" ry="'+(wH*0.42)+'" fill="'+cg+'" opacity="'+(parseFloat(wOp)*0.68).toFixed(2)+'"/>'
    :ws===1
    ?'<path d="M'+(bx-2)+','+(by-4)+' Q'+(bx-wW)+','+(by-wH)+' '+(bx-wW+5)+','+(by-wH+14)+' Q'+(bx-8)+','+(by-3)+' '+(bx-2)+','+(by-4)+'Z" fill="'+cg+'" opacity="'+wOp+'"/><path d="M'+(bx+2)+','+(by-4)+' Q'+(bx+wW)+','+(by-wH)+' '+(bx+wW-5)+','+(by-wH+14)+' Q'+(bx+8)+','+(by-3)+' '+(bx+2)+','+(by-4)+'Z" fill="'+cg+'" opacity="'+wOp+'"/>'
    :ws===2
    ?'<path d="M'+(bx-3)+','+(by-5)+' L'+(bx-wW)+','+(by-wH)+' L'+(bx-wW*0.6)+','+(by-wH*0.45)+' L'+(bx-wW*0.85)+','+(by-wH*0.72)+' L'+(bx-4)+','+(by-8)+'Z" fill="'+cg+'" opacity="'+wOp+'"/><path d="M'+(bx+3)+','+(by-5)+' L'+(bx+wW)+','+(by-wH)+' L'+(bx+wW*0.6)+','+(by-wH*0.45)+' L'+(bx+wW*0.85)+','+(by-wH*0.72)+' L'+(bx+4)+','+(by-8)+'Z" fill="'+cg+'" opacity="'+wOp+'"/>'
    :'<path d="M'+(bx-3)+','+(by-4)+' Q'+(bx-wW*0.8)+','+(by-wH*1.2)+' '+(bx-wW*0.2)+','+(by-wH*0.4)+' Q'+(bx-wW*0.5)+','+(by+wH*0.2)+' '+(bx-4)+','+(by+2)+' L'+(bx-3)+','+(by-4)+'Z" fill="'+cg+'" opacity="'+wOp+'"/><path d="M'+(bx+3)+','+(by-4)+' Q'+(bx+wW*0.8)+','+(by-wH*1.2)+' '+(bx+wW*0.2)+','+(by-wH*0.4)+' Q'+(bx+wW*0.5)+','+(by+wH*0.2)+' '+(bx+4)+','+(by+2)+' L'+(bx+3)+','+(by-4)+'Z" fill="'+cg+'" opacity="'+wOp+'"/>';
  // Wing shimmer veins
  const veins='<line x1="'+(bx-3)+'" y1="'+(by-5)+'" x2="'+(bx-wW*0.7)+'" y2="'+(by-wH*0.55)+'" stroke="white" stroke-width="0.55" opacity="0.22"/><line x1="'+(bx+3)+'" y1="'+(by-5)+'" x2="'+(bx+wW*0.7)+'" y2="'+(by-wH*0.55)+'" stroke="white" stroke-width="0.55" opacity="0.22"/>';
  // Antennae — 3 styles
  const as=ri(65,3), ahl=8+rf(67)*5;
  const ant=as===0
    ?'<line x1="'+(hx-3)+'" y1="'+(hy-hr)+'" x2="'+(hx-6)+'" y2="'+(hy-hr-ahl)+'" stroke="'+tc+'" stroke-width="1.2"/><circle cx="'+(hx-6)+'" cy="'+(hy-hr-ahl)+'" r="1.6" fill="'+tc+'"/><line x1="'+(hx+3)+'" y1="'+(hy-hr)+'" x2="'+(hx+6)+'" y2="'+(hy-hr-ahl)+'" stroke="'+tc+'" stroke-width="1.2"/><circle cx="'+(hx+6)+'" cy="'+(hy-hr-ahl)+'" r="1.6" fill="'+tc+'"/>'
    :as===1
    ?'<path d="M'+(hx-3)+','+(hy-hr)+' Q'+(hx-8)+','+(hy-hr-ahl*0.5)+' '+(hx-5)+','+(hy-hr-ahl)+'" stroke="'+tc+'" stroke-width="1.2" fill="none"/><circle cx="'+(hx-5)+'" cy="'+(hy-hr-ahl)+'" r="1.6" fill="'+tc+'"/><path d="M'+(hx+3)+','+(hy-hr)+' Q'+(hx+8)+','+(hy-hr-ahl*0.5)+' '+(hx+5)+','+(hy-hr-ahl)+'" stroke="'+tc+'" stroke-width="1.2" fill="none"/><circle cx="'+(hx+5)+'" cy="'+(hy-hr-ahl)+'" r="1.6" fill="'+tc+'"/>'
    :'<line x1="'+(hx-2)+'" y1="'+(hy-hr)+'" x2="'+(hx-9)+'" y2="'+(hy-hr-ahl*0.7)+'" stroke="'+tc+'" stroke-width="1"/><line x1="'+(hx+2)+'" y1="'+(hy-hr)+'" x2="'+(hx+9)+'" y2="'+(hy-hr-ahl*0.7)+'" stroke="'+tc+'" stroke-width="1"/><line x1="'+(hx-9)+'" y1="'+(hy-hr-ahl*0.7)+'" x2="'+(hx-5)+'" y2="'+(hy-hr-ahl)+'" stroke="'+tc+'" stroke-width="0.9"/><line x1="'+(hx+9)+'" y1="'+(hy-hr-ahl*0.7)+'" x2="'+(hx+5)+'" y2="'+(hy-hr-ahl)+'" stroke="'+tc+'" stroke-width="0.9"/>';
  // Sparkles
  const sparks=[11,13,17,19,23,29].map(m=>'<path d="M'+(bx-22+rf(m)*44)+','+(by-22+rf(m+2)*38)+' l1.2,-3.2 1.2,3.2 -3.2,-1.2 3.2,-1.2z" fill="'+tc+'" opacity="'+(0.28+rf(m+4)*0.45).toFixed(2)+'"/>').join('');
  return wings+veins
    +'<ellipse cx="'+bx+'" cy="'+by+'" rx="'+bR.toFixed(1)+'" ry="'+(bR*1.35).toFixed(1)+'" fill="'+cg+'"/>'
    +'<circle cx="'+hx.toFixed(1)+'" cy="'+hy.toFixed(1)+'" r="'+hr.toFixed(1)+'" fill="'+cg+'"/>'
    +ant+sparks+_artEyes(tc,rf,ri,hx,hy-0.8);
}

function _cDemon(tc, cg, v, rf, ri) {
  const bx=50, by=55, bw=13+rf(23)*6, bh=14+rf(29)*7;
  const hx=48+rf(37)*5, hy=30+rf(41)*6, hr=9+rf(47)*4;
  const wW=20+rf(53)*12, wH=18+rf(59)*10;
  // Bat wings — 3 styles
  const ws=ri(61,3);
  const wings=ws===0
    ?'<path d="M'+(bx-6)+','+(by-bh/2+2)+' Q'+(bx-wW)+','+(by-wH)+' '+(bx-wW+10)+','+(by-wH-7)+' Q'+(bx-wW*0.42)+','+(by-wH+9)+' '+(bx-6)+','+(by-4)+'Z" fill="'+cg+'" opacity="0.76"/><path d="M'+(bx+6)+','+(by-bh/2+2)+' Q'+(bx+wW)+','+(by-wH)+' '+(bx+wW-10)+','+(by-wH-7)+' Q'+(bx+wW*0.42)+','+(by-wH+9)+' '+(bx+6)+','+(by-4)+'Z" fill="'+cg+'" opacity="0.76"/>'
    :ws===1
    ?'<path d="M'+(bx-6)+','+(by-6)+' L'+(bx-wW)+','+(by-wH+4)+' L'+(bx-wW+6)+','+(by-wH-8)+' L'+(bx-wW*0.5)+','+(by-wH)+' L'+(bx-wW*0.25)+','+(by-wH*0.48)+' L'+(bx-6)+','+(by-8)+'Z" fill="'+cg+'" opacity="0.74"/><path d="M'+(bx+6)+','+(by-6)+' L'+(bx+wW)+','+(by-wH+4)+' L'+(bx+wW-6)+','+(by-wH-8)+' L'+(bx+wW*0.5)+','+(by-wH)+' L'+(bx+wW*0.25)+','+(by-wH*0.48)+' L'+(bx+6)+','+(by-8)+'Z" fill="'+cg+'" opacity="0.74"/>'
    :'<path d="M'+(bx-5)+','+(by-bh/2+3)+' Q'+(bx-wW*0.7)+','+(by-wH*0.8)+' '+(bx-wW)+','+(by-wH*0.5)+' Q'+(bx-wW*0.5)+','+(by-wH)+' '+(bx-wW*0.2)+','+(by-wH*0.25)+' Q'+(bx-5)+','+(by-bh/4)+' '+(bx-5)+','+(by-bh/2+3)+'Z" fill="'+cg+'" opacity="0.72"/><path d="M'+(bx+5)+','+(by-bh/2+3)+' Q'+(bx+wW*0.7)+','+(by-wH*0.8)+' '+(bx+wW)+','+(by-wH*0.5)+' Q'+(bx+wW*0.5)+','+(by-wH)+' '+(bx+wW*0.2)+','+(by-wH*0.25)+' Q'+(bx+5)+','+(by-bh/4)+' '+(bx+5)+','+(by-bh/2+3)+'Z" fill="'+cg+'" opacity="0.72"/>';
  // Wing veins
  const wv='<line x1="'+(bx-5)+'" y1="'+(by-7)+'" x2="'+(bx-wW*0.78)+'" y2="'+(by-wH*0.6)+'" stroke="'+tc+'" stroke-width="0.65" opacity="0.3"/><line x1="'+(bx+5)+'" y1="'+(by-7)+'" x2="'+(bx+wW*0.78)+'" y2="'+(by-wH*0.6)+'" stroke="'+tc+'" stroke-width="0.65" opacity="0.3"/>';
  // Horns — 6 variants
  const hs=ri(63,6);
  const horns=hs===0
    ?'<line x1="'+(hx-4)+'" y1="'+(hy-hr)+'" x2="'+(hx-9)+'" y2="'+(hy-hr-13)+'" stroke="'+tc+'" stroke-width="3.2" stroke-linecap="round"/><line x1="'+(hx+4)+'" y1="'+(hy-hr)+'" x2="'+(hx+9)+'" y2="'+(hy-hr-13)+'" stroke="'+tc+'" stroke-width="3.2" stroke-linecap="round"/>'
    :hs===1
    ?'<path d="M'+(hx-5)+','+(hy-hr)+' Q'+(hx-15)+','+(hy-hr-5)+' '+(hx-9)+','+(hy-hr-15)+'" stroke="'+tc+'" stroke-width="3" fill="none"/><path d="M'+(hx+5)+','+(hy-hr)+' Q'+(hx+15)+','+(hy-hr-5)+' '+(hx+9)+','+(hy-hr-15)+'" stroke="'+tc+'" stroke-width="3" fill="none"/>'
    :hs===2
    ?'<polygon points="'+(hx-5)+','+(hy-hr)+' '+(hx-10)+','+(hy-hr-16)+' '+(hx-1)+','+(hy-hr-2)+'" fill="'+cg+'"/><polygon points="'+(hx+5)+','+(hy-hr)+' '+(hx+10)+','+(hy-hr-16)+' '+(hx+1)+','+(hy-hr-2)+'" fill="'+cg+'"/>'
    :hs===3
    ?'<line x1="'+(hx-3)+'" y1="'+(hy-hr)+'" x2="'+(hx-6)+'" y2="'+(hy-hr-9)+'" stroke="'+tc+'" stroke-width="2.5"/><line x1="'+(hx-8)+'" y1="'+(hy-hr+3)+'" x2="'+(hx-13)+'" y2="'+(hy-hr-6)+'" stroke="'+tc+'" stroke-width="2"/><line x1="'+(hx+3)+'" y1="'+(hy-hr)+'" x2="'+(hx+6)+'" y2="'+(hy-hr-9)+'" stroke="'+tc+'" stroke-width="2.5"/><line x1="'+(hx+8)+'" y1="'+(hy-hr+3)+'" x2="'+(hx+13)+'" y2="'+(hy-hr-6)+'" stroke="'+tc+'" stroke-width="2"/>'
    :hs===4
    ?'<path d="M'+(hx-4)+','+(hy-hr)+' Q'+(hx-8)+','+(hy-hr-6)+' '+(hx-4)+','+(hy-hr-12)+' Q'+(hx-10)+','+(hy-hr-11)+' '+(hx-7)+','+(hy-hr-17)+'" stroke="'+tc+'" stroke-width="2.4" fill="none"/><path d="M'+(hx+4)+','+(hy-hr)+' Q'+(hx+8)+','+(hy-hr-6)+' '+(hx+4)+','+(hy-hr-12)+' Q'+(hx+10)+','+(hy-hr-11)+' '+(hx+7)+','+(hy-hr-17)+'" stroke="'+tc+'" stroke-width="2.4" fill="none"/>'
    :'<path d="M'+(hx-4)+','+(hy-hr)+' L'+(hx-7)+','+(hy-hr-9)+' L'+(hx-4)+','+(hy-hr-5)+' L'+(hx-4)+','+(hy-hr-13)+'" stroke="'+tc+'" stroke-width="2.2" fill="none" stroke-linejoin="round"/><path d="M'+(hx+4)+','+(hy-hr)+' L'+(hx+7)+','+(hy-hr-9)+' L'+(hx+4)+','+(hy-hr-5)+' L'+(hx+4)+','+(hy-hr-13)+'" stroke="'+tc+'" stroke-width="2.2" fill="none" stroke-linejoin="round"/>';
  const td=ri(67,2)===0?1:-1;
  const tail='<path d="M'+bx+','+(by+bh/2)+' Q'+(bx+td*14)+','+(by+bh/2+9)+' '+(bx+td*8)+','+(by+bh/2+18)+' Q'+(bx+td*2)+','+(by+bh/2+20)+' '+(bx+td*3)+','+(by+bh/2+15)+'" stroke="'+tc+'" stroke-width="3.2" fill="none" stroke-linecap="round"/>'
    +'<polygon points="'+(bx+td*3)+','+(by+bh/2+15)+' '+(bx-td*3)+','+(by+bh/2+19)+' '+(bx+td*7)+','+(by+bh/2+20)+'" fill="'+tc+'"/>';
  const legs='<rect x="'+(bx-11)+'" y="'+(by+bh/2)+'" width="6.5" height="13" fill="'+cg+'" rx="3.2"/><rect x="'+(bx+4)+'" y="'+(by+bh/2)+'" width="6.5" height="13" fill="'+cg+'" rx="3.2"/>';
  return wings+wv
    +'<ellipse cx="'+bx+'" cy="'+by+'" rx="'+bw.toFixed(1)+'" ry="'+bh.toFixed(1)+'" fill="'+cg+'"/>'
    +'<circle cx="'+hx.toFixed(1)+'" cy="'+hy.toFixed(1)+'" r="'+hr.toFixed(1)+'" fill="'+cg+'"/>'
    +horns+tail+legs+_artEyes(tc,rf,ri,hx,hy+1.2);
}

function _cAngel(tc, cg, v, rf, ri) {
  const bx=50, by=57, bw=9+rf(23)*5, bh=18+rf(29)*6;
  const hx=48+rf(37)*5, hy=27+rf(41)*5, hr=8+rf(47)*4;
  const wW=26+rf(53)*14, wH=22+rf(59)*12;
  const wOp=(0.68+rf(61)*0.22).toFixed(2);
  // 4 wing styles
  const ws=ri(63,4);
  const wing1=ws===0
    ?'<path d="M'+(bx-4)+','+(by-bh/2+2)+' Q'+(bx-wW)+','+(by-wH)+' '+(bx-wW+7)+','+(by-wH-12)+' Q'+(bx-wW*0.62)+','+(by-wH+7)+' '+(bx-8)+','+(by-8)+' Q'+(bx-wW*0.32)+','+(by-wH*0.3)+' '+(bx-4)+','+(by-bh/2+2)+'Z" fill="white" opacity="'+wOp+'"/>'
    :ws===1
    ?'<path d="M'+(bx-4)+','+(by-bh/2+2)+' L'+(bx-wW*0.2)+','+(by-wH*0.35)+' L'+(bx-wW*0.55)+','+(by-wH*0.72)+' L'+(bx-wW)+','+(by-wH)+' L'+(bx-wW+7)+','+(by-wH-10)+' L'+(bx-wW*0.5)+','+(by-wH+5)+' L'+(bx-8)+','+(by-7)+'Z" fill="white" opacity="'+wOp+'"/>'
    :ws===2
    ?'<path d="M'+(bx-4)+','+(by-bh/2+3)+' Q'+(bx-wW*0.5)+','+(by-wH*0.4)+' '+(bx-wW)+','+(by-wH*0.85)+' Q'+(bx-wW+8)+','+(by-wH-8)+' '+(bx-wW*0.55)+','+(by-wH+4)+' Q'+(bx-wW*0.2)+','+(by-wH*0.15)+' '+(bx-5)+','+(by-7)+'Z" fill="white" opacity="'+wOp+'"/>'
    :'<ellipse cx="'+(bx-wW*0.55)+'" cy="'+(by-wH*0.52)+'" rx="'+(wW*0.52)+'" ry="'+(wH*0.48)+'" fill="white" opacity="'+wOp+'" transform="rotate(-18,'+(bx-wW*0.55)+','+(by-wH*0.52)+')"/>';
  const wing2=ws===0
    ?'<path d="M'+(bx+4)+','+(by-bh/2+2)+' Q'+(bx+wW)+','+(by-wH)+' '+(bx+wW-7)+','+(by-wH-12)+' Q'+(bx+wW*0.62)+','+(by-wH+7)+' '+(bx+8)+','+(by-8)+' Q'+(bx+wW*0.32)+','+(by-wH*0.3)+' '+(bx+4)+','+(by-bh/2+2)+'Z" fill="white" opacity="'+wOp+'"/>'
    :ws===1
    ?'<path d="M'+(bx+4)+','+(by-bh/2+2)+' L'+(bx+wW*0.2)+','+(by-wH*0.35)+' L'+(bx+wW*0.55)+','+(by-wH*0.72)+' L'+(bx+wW)+','+(by-wH)+' L'+(bx+wW-7)+','+(by-wH-10)+' L'+(bx+wW*0.5)+','+(by-wH+5)+' L'+(bx+8)+','+(by-7)+'Z" fill="white" opacity="'+wOp+'"/>'
    :ws===2
    ?'<path d="M'+(bx+4)+','+(by-bh/2+3)+' Q'+(bx+wW*0.5)+','+(by-wH*0.4)+' '+(bx+wW)+','+(by-wH*0.85)+' Q'+(bx+wW-8)+','+(by-wH-8)+' '+(bx+wW*0.55)+','+(by-wH+4)+' Q'+(bx+wW*0.2)+','+(by-wH*0.15)+' '+(bx+5)+','+(by-7)+'Z" fill="white" opacity="'+wOp+'"/>'
    :'<ellipse cx="'+(bx+wW*0.55)+'" cy="'+(by-wH*0.52)+'" rx="'+(wW*0.52)+'" ry="'+(wH*0.48)+'" fill="white" opacity="'+wOp+'" transform="rotate(18,'+(bx+wW*0.55)+','+(by-wH*0.52)+')"/>';
  const feathers=[0.28,0.50,0.70,0.88].map(f=>'<line x1="'+(bx-4)+'" y1="'+(by-bh/2+2)+'" x2="'+(bx-wW*f).toFixed(1)+'" y2="'+(by-wH*f*0.78).toFixed(1)+'" stroke="'+tc+'" stroke-width="0.85" opacity="0.35"/><line x1="'+(bx+4)+'" y1="'+(by-bh/2+2)+'" x2="'+(bx+wW*f).toFixed(1)+'" y2="'+(by-wH*f*0.78).toFixed(1)+'" stroke="'+tc+'" stroke-width="0.85" opacity="0.35"/>').join('');
  // Halo — 3 styles
  const hs=ri(65,3), hR=9+rf(67)*6;
  const halo=hs===0
    ?'<ellipse cx="'+hx+'" cy="'+(hy-hr-4)+'" rx="'+hR.toFixed(1)+'" ry="'+(hR*0.24).toFixed(1)+'" fill="none" stroke="'+tc+'" stroke-width="2.5" opacity="0.92"/>'
    :hs===1
    ?'<ellipse cx="'+hx+'" cy="'+(hy-hr-4)+'" rx="'+hR.toFixed(1)+'" ry="'+(hR*0.24).toFixed(1)+'" fill="'+tc+'" opacity="0.18"/><ellipse cx="'+hx+'" cy="'+(hy-hr-4)+'" rx="'+hR.toFixed(1)+'" ry="'+(hR*0.24).toFixed(1)+'" fill="none" stroke="'+tc+'" stroke-width="1.8" opacity="0.88"/>'
    :'<circle cx="'+hx+'" cy="'+(hy-hr-5)+'" r="'+(hR*0.42).toFixed(1)+'" fill="none" stroke="'+tc+'" stroke-width="1.5" opacity="0.72"/><ellipse cx="'+hx+'" cy="'+(hy-hr-4)+'" rx="'+hR.toFixed(1)+'" ry="'+(hR*0.22).toFixed(1)+'" fill="none" stroke="'+tc+'" stroke-width="2.2" opacity="0.88"/>';
  // Robe
  const robe='<path d="M'+(bx-bw)+','+(by+bh/2)+' Q'+(bx-bw-9)+','+(by+bh/2+15)+' '+bx+','+(by+bh/2+17)+' Q'+(bx+bw+9)+','+(by+bh/2+15)+' '+(bx+bw)+','+(by+bh/2)+'Z" fill="white" opacity="0.48"/>';
  // Light particles
  const lpts=[3,7,11,13,17].map(m=>'<circle cx="'+(bx-30+rf(m)*60)+'" cy="'+(by-30+rf(m+2)*50)+'" r="'+(0.5+rf(m+4)*1.4)+'" fill="'+tc+'" opacity="'+(0.2+rf(m+6)*0.42).toFixed(2)+'"/>').join('');
  return wing1+wing2+feathers
    +'<ellipse cx="'+bx+'" cy="'+by+'" rx="'+bw.toFixed(1)+'" ry="'+bh.toFixed(1)+'" fill="white" opacity="0.82"/>'
    +'<circle cx="'+hx.toFixed(1)+'" cy="'+hy.toFixed(1)+'" r="'+hr.toFixed(1)+'" fill="white" opacity="0.92"/>'
    +halo+robe+lpts+_artEyes(tc,rf,ri,hx,hy+1);
}

function _cUndead(tc, cg, v, rf, ri) {
  const bx=50, by=53;
  const hx=47+rf(23)*8, hy=26+rf(29)*7, hr=9+rf(37)*5;
  const sW=3.5+rf(41)*2.5, sH=4.5+rf(43)*3;
  // Skull type — 3 styles
  const ss=ri(45,3);
  const skull=ss===0
    ?'<circle cx="'+hx.toFixed(1)+'" cy="'+hy.toFixed(1)+'" r="'+hr.toFixed(1)+'" fill="'+cg+'" opacity="0.87"/>'
    :ss===1
    ?'<ellipse cx="'+hx.toFixed(1)+'" cy="'+hy.toFixed(1)+'" rx="'+(hr*1.1).toFixed(1)+'" ry="'+hr.toFixed(1)+'" fill="'+cg+'" opacity="0.87"/>'
    :'<path d="M'+hx+','+(hy-hr)+' Q'+(hx+hr)+','+hy+' '+hx+','+(hy+hr)+' Q'+(hx-hr)+','+hy+' '+hx+','+(hy-hr)+'Z" fill="'+cg+'" opacity="0.87"/>';
  const jaw='<path d="M'+(hx-7)+','+(hy+hr-2)+' Q'+hx+','+(hy+hr+7)+' '+(hx+7)+','+(hy+hr-2)+'" stroke="'+tc+'" stroke-width="2.2" fill="none"/>';
  // Teeth — 4 counts
  const tc2=3+ri(47,3);
  const teeth=Array.from({length:tc2},(_,i)=>'<rect x="'+(hx-6+i*(12/(tc2-1||1)))+'" y="'+(hy+hr)+'" width="2.2" height="'+(3+rf(49+i)*3).toFixed(1)+'" fill="'+tc+'" rx="1"/>').join('');
  const skullEye='<ellipse cx="'+(hx-5)+'" cy="'+(hy-1)+'" rx="'+sW.toFixed(1)+'" ry="'+sH.toFixed(1)+'" fill="#040810"/>'
    +'<ellipse cx="'+(hx+5)+'" cy="'+(hy-1)+'" rx="'+sW.toFixed(1)+'" ry="'+sH.toFixed(1)+'" fill="#040810"/>'
    +'<circle cx="'+(hx-5)+'" cy="'+(hy-1)+'" r="1.6" fill="'+tc+'" opacity="0.9"/>'
    +'<circle cx="'+(hx+5)+'" cy="'+(hy-1)+'" r="1.6" fill="'+tc+'" opacity="0.9"/>';
  // Ribcage — 3 or 4 ribs
  const rc=3+ri(51,2);
  const ribs=Array.from({length:rc},(_,i)=>'<path d="M'+(bx-2)+','+(by-10+i*6)+' Q'+(bx-15)+','+(by-7+i*6)+' '+(bx-12)+','+(by+i*6)+'" stroke="'+tc+'" stroke-width="2" fill="none" stroke-linecap="round"/><path d="M'+(bx+2)+','+(by-10+i*6)+' Q'+(bx+15)+','+(by-7+i*6)+' '+(bx+12)+','+(by+i*6)+'" stroke="'+tc+'" stroke-width="2" fill="none" stroke-linecap="round"/>').join('');
  const spine='<line x1="'+bx+'" y1="'+(hy+hr)+'" x2="'+bx+'" y2="'+(by+13)+'" stroke="'+tc+'" stroke-width="3.2" stroke-linecap="round" stroke-dasharray="2.5,2"/>';
  // Arms — 3 styles
  const as=ri(53,3);
  const arms=as===0
    ?'<line x1="'+(bx-14)+'" y1="'+(by-9)+'" x2="'+(bx-21)+'" y2="'+(by+11)+'" stroke="'+tc+'" stroke-width="2.8" stroke-linecap="round"/><line x1="'+(bx+14)+'" y1="'+(by-9)+'" x2="'+(bx+21)+'" y2="'+(by+11)+'" stroke="'+tc+'" stroke-width="2.8" stroke-linecap="round"/>'
    :as===1
    ?'<path d="M'+(bx-13)+','+(by-9)+' Q'+(bx-22)+','+(by)+' '+(bx-19)+','+(by+12)+'" stroke="'+tc+'" stroke-width="2.8" fill="none" stroke-linecap="round"/><path d="M'+(bx+13)+','+(by-9)+' Q'+(bx+22)+','+(by)+' '+(bx+19)+','+(by+12)+'" stroke="'+tc+'" stroke-width="2.8" fill="none" stroke-linecap="round"/>'
    :'<line x1="'+(bx-13)+'" y1="'+(by-8)+'" x2="'+(bx-18)+'" y2="'+by+'" stroke="'+tc+'" stroke-width="2.5" stroke-linecap="round"/><line x1="'+(bx-18)+'" y1="'+by+'" x2="'+(bx-14)+'" y2="'+(by+12)+'" stroke="'+tc+'" stroke-width="2.5" stroke-linecap="round"/><line x1="'+(bx+13)+'" y1="'+(by-8)+'" x2="'+(bx+18)+'" y2="'+by+'" stroke="'+tc+'" stroke-width="2.5" stroke-linecap="round"/><line x1="'+(bx+18)+'" y1="'+by+'" x2="'+(bx+14)+'" y2="'+(by+12)+'" stroke="'+tc+'" stroke-width="2.5" stroke-linecap="round"/>';
  const legs='<line x1="'+(bx-5)+'" y1="'+(by+13)+'" x2="'+(bx-7)+'" y2="'+(by+27)+'" stroke="'+tc+'" stroke-width="2.8" stroke-linecap="round"/><line x1="'+(bx+5)+'" y1="'+(by+13)+'" x2="'+(bx+7)+'" y2="'+(by+27)+'" stroke="'+tc+'" stroke-width="2.8" stroke-linecap="round"/>';
  // Aura wisps
  const wisps=[3,7,11].map(m=>'<path d="M'+(bx-20+rf(m)*40)+','+(by-8+rf(m+2)*18)+' Q'+(bx-15+rf(m+4)*30)+','+(by-18+rf(m+6)*10)+' '+(bx-10+rf(m+8)*20)+','+(by-6+rf(m+10)*14)+'" stroke="'+tc+'" stroke-width="1.2" fill="none" opacity="'+(0.15+rf(m+12)*0.22).toFixed(2)+'" stroke-linecap="round"/>').join('');
  return skull+jaw+teeth+skullEye+spine+ribs+arms+legs+wisps;
}

function _cElemental(tc, cg, v, rf, ri) {
  const bx=46+rf(23)*8, by=46+rf(29)*8, cR=9+rf(33)*7;
  // Core — 4 shapes
  const cs=ri(35,4);
  const core=cs===0
    ?'<circle cx="'+bx+'" cy="'+by+'" r="'+cR.toFixed(1)+'" fill="'+cg+'" opacity="0.92"/><circle cx="'+bx+'" cy="'+by+'" r="'+(cR*0.48).toFixed(1)+'" fill="white" opacity="0.52"/>'
    :cs===1
    ?'<polygon points="'+bx+','+(by-cR)+' '+(bx+cR*0.87)+','+(by+cR*0.5)+' '+(bx-cR*0.87)+','+(by+cR*0.5)+'" fill="'+cg+'" opacity="0.92"/><circle cx="'+bx+'" cy="'+by+'" r="'+(cR*0.38).toFixed(1)+'" fill="white" opacity="0.5"/>'
    :cs===2
    ?'<polygon points="'+bx+','+(by-cR)+' '+(bx+cR)+','+by+' '+bx+','+(by+cR)+' '+(bx-cR)+','+by+'" fill="'+cg+'" opacity="0.92"/><circle cx="'+bx+'" cy="'+by+'" r="'+(cR*0.35).toFixed(1)+'" fill="white" opacity="0.48"/>'
    :'<ellipse cx="'+bx+'" cy="'+by+'" rx="'+cR.toFixed(1)+'" ry="'+(cR*0.72).toFixed(1)+'" fill="'+cg+'" opacity="0.9"/><ellipse cx="'+bx+'" cy="'+by+'" rx="'+(cR*0.5).toFixed(1)+'" ry="'+(cR*0.36).toFixed(1)+'" fill="white" opacity="0.48"/>';
  // Tendrils — count varies
  const tc2=5+ri(37,5);
  const tendrils=Array.from({length:tc2},(_,i)=>{
    const m=3+i*7, a=rf(m)*Math.PI*2, l=16+rf(m+2)*18;
    const curl=rf(m+3)*1.4-0.7;
    const mx=bx+Math.cos(a+curl)*l*0.52, my=by+Math.sin(a+curl)*l*0.52;
    const ex=bx+Math.cos(a)*l, ey=by+Math.sin(a)*l;
    const w=(1.2+rf(m+4)*2.8).toFixed(1), op=(0.35+rf(m+6)*0.55).toFixed(2);
    return '<path d="M'+bx+','+by+' Q'+mx.toFixed(1)+','+my.toFixed(1)+' '+ex.toFixed(1)+','+ey.toFixed(1)+'" stroke="'+tc+'" stroke-width="'+w+'" fill="none" opacity="'+op+'" stroke-linecap="round"/>';
  }).join('');
  // Particle rings — 2 or 3 orbits
  const rings=2+ri(39,2);
  const particles=Array.from({length:rings},(_,ri2)=>{
    const d=cR+7+ri2*8+rf(41+ri2)*5;
    const pc=4+ri2*2+ri(43+ri2,4);
    return Array.from({length:pc},(_2,i)=>{
      const a=(i/pc)*Math.PI*2+rf(45+ri2+i)*0.5;
      const px=(bx+Math.cos(a)*d).toFixed(1), py=(by+Math.sin(a)*d).toFixed(1);
      const ps=(0.9+rf(47+i)*2).toFixed(1);
      return '<circle cx="'+px+'" cy="'+py+'" r="'+ps+'" fill="'+tc+'" opacity="'+(0.35+rf(49+i)*0.52).toFixed(2)+'"/>';
    }).join('');
  }).join('');
  // Glowing aura ring
  const aura='<circle cx="'+bx+'" cy="'+by+'" r="'+(cR+3).toFixed(1)+'" fill="none" stroke="'+tc+'" stroke-width="2.2" opacity="0.28"/>';
  return tendrils+particles+aura+core;
}

function _cConstruct(tc, cg, v, rf, ri) {
  const bx=50, by=53, bw=13+rf(23)*6, bh=14+rf(29)*6;
  const hx=47+rf(37)*7, hy=28+rf(41)*6;
  const hW=10+rf(47)*6, hH=10+rf(53)*4;
  // Head shape — 3 styles
  const hs=ri(55,3);
  const head=hs===0
    ?'<rect x="'+(hx-hW)+'" y="'+(hy-hH)+'" width="'+(hW*2)+'" height="'+(hH*2)+'" fill="'+cg+'" rx="3.5"/>'
    :hs===1
    ?'<polygon points="'+hx+','+(hy-hH*1.2)+' '+(hx+hW*1.1)+','+(hy-hH*0.4)+' '+(hx+hW)+','+(hy+hH)+' '+(hx-hW)+','+(hy+hH)+' '+(hx-hW*1.1)+','+(hy-hH*0.4)+'" fill="'+cg+'"/>'
    :'<rect x="'+(hx-hW)+'" y="'+(hy-hH)+'" width="'+(hW*2)+'" height="'+(hH*2)+'" fill="'+cg+'" rx="8"/>';
  // Eye — 4 styles
  const es=ri(57,4);
  const eyePart=es===0
    ?'<circle cx="'+hx+'" cy="'+hy+'" r="'+(5+rf(59)*3.5).toFixed(1)+'" fill="#040810"/><circle cx="'+hx+'" cy="'+hy+'" r="'+(2.5+rf(61)*2).toFixed(1)+'" fill="'+tc+'"/><circle cx="'+(hx-1)+'" cy="'+(hy-1)+'" r="1.2" fill="white" opacity="0.55"/>'
    :es===1
    ?_artEyes(tc,rf,ri,hx,hy)
    :es===2
    ?'<rect x="'+(hx-5)+'" y="'+(hy-3)+'" width="10" height="6" fill="#040810" rx="1.5"/><rect x="'+(hx-4.5)+'" y="'+(hy-2.5)+'" width="9" height="5" fill="'+tc+'" opacity="0.8" rx="1"/>'
    :'<line x1="'+(hx-7)+'" y1="'+hy+'" x2="'+(hx+7)+'" y2="'+hy+'" stroke="'+tc+'" stroke-width="3" stroke-linecap="round"/><line x1="'+(hx-4)+'" y1="'+(hy-3)+'" x2="'+(hx+4)+'" y2="'+(hy-3)+'" stroke="'+tc+'" stroke-width="1.5" opacity="0.5" stroke-linecap="round"/>';
  // Antenna — 4 styles
  const as=ri(63,4);
  const ant=as===0
    ?'<line x1="'+hx+'" y1="'+(hy-hH)+'" x2="'+hx+'" y2="'+(hy-hH-11)+'" stroke="'+tc+'" stroke-width="2.2"/><circle cx="'+hx+'" cy="'+(hy-hH-11)+'" r="2.8" fill="'+tc+'"/>'
    :as===1
    ?'<line x1="'+(hx-3)+'" y1="'+(hy-hH)+'" x2="'+(hx-5)+'" y2="'+(hy-hH-9)+'" stroke="'+tc+'" stroke-width="1.8"/><circle cx="'+(hx-5)+'" cy="'+(hy-hH-9)+'" r="2" fill="'+tc+'"/><line x1="'+(hx+3)+'" y1="'+(hy-hH)+'" x2="'+(hx+5)+'" y2="'+(hy-hH-9)+'" stroke="'+tc+'" stroke-width="1.8"/><circle cx="'+(hx+5)+'" cy="'+(hy-hH-9)+'" r="2" fill="'+tc+'"/>'
    :as===2
    ?'<path d="M'+hx+','+(hy-hH)+' Q'+(hx-6)+','+(hy-hH-5)+' '+(hx-3)+','+(hy-hH-11)+'" stroke="'+tc+'" stroke-width="1.8" fill="none"/><rect x="'+(hx-5)+'" y="'+(hy-hH-14)+'" width="4" height="4" fill="'+tc+'"/>'
    :'<line x1="'+hx+'" y1="'+(hy-hH)+'" x2="'+hx+'" y2="'+(hy-hH-8)+'" stroke="'+tc+'" stroke-width="2"/><line x1="'+(hx-5)+'" y1="'+(hy-hH-4)+'" x2="'+(hx+5)+'" y2="'+(hy-hH-12)+'" stroke="'+tc+'" stroke-width="1.2"/>';
  // Panel lines on body
  const panels='<line x1="'+(bx-bw)+'" y1="'+by+'" x2="'+(bx+bw)+'" y2="'+by+'" stroke="#080818" stroke-width="1.2" opacity="0.45"/><line x1="'+bx+'" y1="'+(by-bh/2)+'" x2="'+bx+'" y2="'+(by+bh/2)+'" stroke="#080818" stroke-width="1" opacity="0.35"/><line x1="'+(bx-bw*0.6)+'" y1="'+(by-bh/3)+'" x2="'+(bx+bw*0.6)+'" y2="'+(by-bh/3)+'" stroke="#080818" stroke-width="0.8" opacity="0.25"/>';
  const joints='<circle cx="'+(bx-bw-8)+'" cy="'+(by-bh*0.28)+'" r="3.8" fill="'+cg+'" stroke="#080818" stroke-width="1.2"/><circle cx="'+(bx+bw+8)+'" cy="'+(by-bh*0.28)+'" r="3.8" fill="'+cg+'" stroke="#080818" stroke-width="1.2"/>';
  const arms='<rect x="'+(bx-bw-15)+'" y="'+(by-bh*0.28-4.5)+'" width="15" height="9" fill="'+cg+'" rx="3.5"/><rect x="'+(bx+bw)+'" y="'+(by-bh*0.28-4.5)+'" width="15" height="9" fill="'+cg+'" rx="3.5"/>';
  const legs='<rect x="'+(bx-11)+'" y="'+(by+bh/2)+'" width="7.5" height="15" fill="'+cg+'" rx="3.5"/><rect x="'+(bx+3)+'" y="'+(by+bh/2)+'" width="7.5" height="15" fill="'+cg+'" rx="3.5"/>';
  // Gear — size varies
  const gR=3+rf(67)*3.5, gX=bx+bw-gR-2, gY=by-bh/4;
  const gt=Array.from({length:6},(_,i)=>{const a=i*60*Math.PI/180;return '<rect x="'+(gX+gR*Math.cos(a)-2.2).toFixed(1)+'" y="'+(gY+gR*Math.sin(a)-2.2).toFixed(1)+'" width="4.4" height="4.4" fill="'+cg+'"/>';}).join('');
  const gear='<circle cx="'+gX.toFixed(1)+'" cy="'+gY.toFixed(1)+'" r="'+gR.toFixed(1)+'" fill="'+cg+'" stroke="#080818" stroke-width="1.2"/>'+gt;
  // Energy cell
  const ec=ri(69,2)===0?'<rect x="'+(bx-4)+'" y="'+(by-bh/2+3)+'" width="8" height="4" fill="'+tc+'" opacity="0.7" rx="1.5"/>':'';
  return '<rect x="'+(bx-bw)+'" y="'+(by-bh/2)+'" width="'+(bw*2)+'" height="'+bh+'" fill="'+cg+'" rx="3.5"/>'
    +panels+joints+arms+legs+head+eyePart+ant+gear+ec;
}

function _cTitan(tc, cg, v, rf, ri) {
  const bx=50, by=56, bw=20+rf(23)*9, bh=16+rf(29)*7;
  const hx=47+rf(37)*7, hy=26+rf(41)*5, hr=8+rf(47)*5;
  // Crown/helmet — 5 styles
  const cs=ri(49,5);
  const crown=cs===0
    ?'<polygon points="'+(hx-8)+','+(hy-hr)+' '+(hx-6)+','+(hy-hr-11)+' '+(hx-1)+','+(hy-hr-7)+' '+hx+','+(hy-hr-13)+' '+(hx+1)+','+(hy-hr-7)+' '+(hx+6)+','+(hy-hr-11)+' '+(hx+8)+','+(hy-hr)+'" fill="'+cg+'"/>'
    :cs===1
    ?'<path d="M'+(hx-9)+','+(hy-hr)+' Q'+(hx-5)+','+(hy-hr-15)+' '+hx+','+(hy-hr-13)+' Q'+(hx+5)+','+(hy-hr-15)+' '+(hx+9)+','+(hy-hr)+'" fill="'+cg+'"/>'
    :cs===2
    ?'<rect x="'+(hx-9)+'" y="'+(hy-hr-11)+'" width="18" height="11" fill="'+cg+'" rx="2"/><line x1="'+(hx-9)+'" y1="'+(hy-hr-4)+'" x2="'+(hx+9)+'" y2="'+(hy-hr-4)+'" stroke="#08081888" stroke-width="1"/>'
    :cs===3
    ?'<polygon points="'+hx+','+(hy-hr-14)+' '+(hx-8)+','+(hy-hr-4)+' '+(hx-10)+','+(hy-hr)+' '+(hx+10)+','+(hy-hr)+' '+(hx+8)+','+(hy-hr-4)+'" fill="'+cg+'"/>'
    :'<ellipse cx="'+hx+'" cy="'+(hy-hr-5)+'" rx="9" ry="7" fill="'+cg+'"/><line x1="'+(hx-9)+'" y1="'+(hy-hr)+'" x2="'+(hx+9)+'" y2="'+(hy-hr)+'" stroke="'+tc+'" stroke-width="1.2" opacity="0.5"/>';
  // Shoulder style — 3
  const sW=11+rf(53)*6, sH=7+rf(59)*4;
  const ss=ri(61,3);
  const shoulders=ss===0
    ?'<ellipse cx="'+(bx-bw+2)+'" cy="'+(by-bh/2+4)+'" rx="'+sW.toFixed(1)+'" ry="'+sH.toFixed(1)+'" fill="'+cg+'"/><ellipse cx="'+(bx+bw-2)+'" cy="'+(by-bh/2+4)+'" rx="'+sW.toFixed(1)+'" ry="'+sH.toFixed(1)+'" fill="'+cg+'"/>'
    :ss===1
    ?'<polygon points="'+(bx-bw+2)+','+(by-bh/2+10)+' '+(bx-bw-sW+2)+','+(by-bh/2+4)+' '+(bx-bw+2)+','+(by-bh/2-sH+4)+' '+(bx-bw+sW*0.5+2)+','+(by-bh/2+4)+'" fill="'+cg+'"/><polygon points="'+(bx+bw-2)+','+(by-bh/2+10)+' '+(bx+bw+sW-2)+','+(by-bh/2+4)+' '+(bx+bw-2)+','+(by-bh/2-sH+4)+' '+(bx+bw-sW*0.5-2)+','+(by-bh/2+4)+'" fill="'+cg+'"/>'
    :'<circle cx="'+(bx-bw)+'" cy="'+(by-bh/2+6)+'" r="'+sW.toFixed(1)+'" fill="'+cg+'" opacity="0.8"/><circle cx="'+(bx+bw)+'" cy="'+(by-bh/2+6)+'" r="'+sW.toFixed(1)+'" fill="'+cg+'" opacity="0.8"/>';
  const armW=8+rf(63)*5, armH=18+rf(67)*8;
  const arms='<rect x="'+(bx-bw-armW+5)+'" y="'+(by-bh/2+9)+'" width="'+armW+'" height="'+armH+'" fill="'+cg+'" rx="4.5"/><rect x="'+(bx+bw-5)+'" y="'+(by-bh/2+9)+'" width="'+armW+'" height="'+armH+'" fill="'+cg+'" rx="4.5"/>';
  const fist='<ellipse cx="'+(bx-bw-armW/2+5)+'" cy="'+(by-bh/2+9+armH)+'" rx="'+(armW*0.62).toFixed(1)+'" ry="5.5" fill="'+cg+'"/><ellipse cx="'+(bx+bw+armW/2-5)+'" cy="'+(by-bh/2+9+armH)+'" rx="'+(armW*0.62).toFixed(1)+'" ry="5.5" fill="'+cg+'"/>';
  const legW=8+rf(71)*5;
  const legs='<rect x="'+(bx-13)+'" y="'+(by+bh/2)+'" width="'+legW+'" height="17" fill="'+cg+'" rx="4.5"/><rect x="'+(bx+3)+'" y="'+(by+bh/2)+'" width="'+legW+'" height="17" fill="'+cg+'" rx="4.5"/>';
  // Armor plates
  const ap=ri(73,3);
  const armor=ap===0
    ?'<ellipse cx="'+bx+'" cy="'+(by-2)+'" rx="'+(bw*0.55).toFixed(1)+'" ry="5.5" fill="'+tc+'" opacity="0.48"/><line x1="'+(bx-bw*0.4)+'" y1="'+(by+3)+'" x2="'+(bx+bw*0.4)+'" y2="'+(by+3)+'" stroke="#08081860" stroke-width="1.2"/>'
    :ap===1
    ?'<polygon points="'+bx+','+(by-bh/2)+' '+(bx-bw*0.5)+','+(by)+' '+bx+','+(by+bh*0.45)+' '+(bx+bw*0.5)+','+by+'" fill="'+tc+'" opacity="0.32"/>'
    :'<rect x="'+(bx-bw*0.4)+'" y="'+(by-bh*0.35)+'" width="'+(bw*0.8)+'" height="'+(bh*0.52)+'" fill="'+tc+'" opacity="0.22" rx="2"/>';
  // Emblem on chest
  const emb=ri(75,2)===0?'<circle cx="'+bx+'" cy="'+(by-bh/4)+'" r="'+(3+rf(77)*2).toFixed(1)+'" fill="'+tc+'" opacity="0.7"/><circle cx="'+bx+'" cy="'+(by-bh/4)+'" r="'+(1.5+rf(79)*1.2).toFixed(1)+'" fill="white" opacity="0.45"/>':'';
  return shoulders
    +'<ellipse cx="'+bx+'" cy="'+by+'" rx="'+bw.toFixed(1)+'" ry="'+bh.toFixed(1)+'" fill="'+cg+'"/>'
    +'<circle cx="'+hx.toFixed(1)+'" cy="'+hy.toFixed(1)+'" r="'+hr.toFixed(1)+'" fill="'+cg+'"/>'
    +crown+arms+fist+legs+armor+emb+_artEyes(tc,rf,ri,hx,hy+1.2);
}

function _artRarityFx(rarity, tc, rf) {
  if (!rarity || rarity === 'Common') return '';
  const r = rarity.toLowerCase().replace(/_/g,'');
  if (r === 'uncommon')
    return '<rect width="100" height="90" fill="'+tc+'" opacity="0.05"/>'
      +'<rect x="0" y="0" width="100" height="90" fill="none" stroke="'+tc+'" stroke-width="1.2" opacity="0.18"/>';
  if (r === 'rare')
    return '<rect width="100" height="90" fill="none" stroke="'+tc+'" stroke-width="1.8" opacity="0.32"/>'
      +'<line x1="0" y1="0" x2="100" y2="90" stroke="'+tc+'" stroke-width="0.6" opacity="0.08"/>'
      +'<line x1="100" y1="0" x2="0" y2="90" stroke="'+tc+'" stroke-width="0.6" opacity="0.08"/>';
  if (r === 'ultrarare')
    return '<rect width="100" height="90" fill="none" stroke="'+tc+'" stroke-width="2.2" opacity="0.42"/>'
      +'<rect x="2.5" y="2.5" width="95" height="85" fill="none" stroke="'+tc+'" stroke-width="0.9" opacity="0.22"/>'
      +'<circle cx="7" cy="7" r="3.5" fill="'+tc+'" opacity="0.5"/><circle cx="93" cy="7" r="3.5" fill="'+tc+'" opacity="0.5"/>'
      +'<circle cx="7" cy="83" r="3.5" fill="'+tc+'" opacity="0.5"/><circle cx="93" cy="83" r="3.5" fill="'+tc+'" opacity="0.5"/>';
  if (r === 'secretrare')
    return '<rect width="100" height="90" fill="none" stroke="'+tc+'" stroke-width="2.6" opacity="0.48"/>'
      +'<rect x="3" y="3" width="94" height="84" fill="none" stroke="'+tc+'" stroke-width="0.9" opacity="0.25"/>'
      +'<line x1="0" y1="0" x2="100" y2="90" stroke="'+tc+'" stroke-width="0.75" opacity="0.14"/>'
      +'<line x1="100" y1="0" x2="0" y2="90" stroke="'+tc+'" stroke-width="0.75" opacity="0.14"/>'
      +'<circle cx="50" cy="45" r="36" fill="none" stroke="'+tc+'" stroke-width="0.9" opacity="0.16"/>';
  if (r === 'fullart')
    return '<rect width="100" height="90" fill="none" stroke="'+tc+'" stroke-width="3" opacity="0.52"/>'
      +'<rect x="4" y="4" width="92" height="82" fill="none" stroke="white" stroke-width="0.9" opacity="0.22"/>'
      +Array.from({length:6},(_,i)=>'<line x1="'+(i*18)+'" y1="0" x2="'+(i*18+10)+'" y2="90" stroke="'+tc+'" stroke-width="0.55" opacity="0.07"/>').join('');
  if (r === 'parallel')
    return '<rect width="100" height="90" fill="none" stroke="'+tc+'" stroke-width="2.8" opacity="0.50"/>'
      +'<rect x="3" y="3" width="94" height="84" fill="none" stroke="white" stroke-width="0.8" opacity="0.20"/>'
      +Array.from({length:5},(_,i)=>'<line x1="0" y1="'+(i*20)+'" x2="100" y2="'+(i*20+10)+'" stroke="'+tc+'" stroke-width="0.6" opacity="0.09"/>').join('');
  if (r === 'numbered')
    return '<rect width="100" height="90" fill="none" stroke="'+tc+'" stroke-width="3.2" opacity="0.58"/>'
      +'<rect x="3" y="3" width="94" height="84" fill="none" stroke="white" stroke-width="0.9" opacity="0.22"/>'
      +'<circle cx="50" cy="45" r="42" fill="none" stroke="'+tc+'" stroke-width="1.1" opacity="0.20"/>'
      +'<circle cx="50" cy="45" r="28" fill="none" stroke="'+tc+'" stroke-width="0.7" opacity="0.12"/>'
      +'<circle cx="5" cy="5" r="3.5" fill="'+tc+'" opacity="0.75"/><circle cx="95" cy="5" r="3.5" fill="'+tc+'" opacity="0.75"/>'
      +'<circle cx="5" cy="85" r="3.5" fill="'+tc+'" opacity="0.75"/><circle cx="95" cy="85" r="3.5" fill="'+tc+'" opacity="0.75"/>';
  if (r === 'prism')
    return '<rect width="100" height="90" fill="none" stroke="'+tc+'" stroke-width="3.5" opacity="0.62"/>'
      +'<rect x="3.5" y="3.5" width="93" height="83" fill="none" stroke="white" stroke-width="1" opacity="0.28"/>'
      +'<polygon points="50,4 96,45 50,86 4,45" fill="none" stroke="'+tc+'" stroke-width="1.2" opacity="0.22"/>'
      +Array.from({length:8},(_,i)=>'<line x1="'+(i*14)+'" y1="0" x2="'+(i*14+8)+'" y2="90" stroke="'+tc+'" stroke-width="0.45" opacity="0.09"/>').join('')
      +'<circle cx="5" cy="5" r="4" fill="'+tc+'" opacity="0.78"/><circle cx="95" cy="5" r="4" fill="'+tc+'" opacity="0.78"/>'
      +'<circle cx="5" cy="85" r="4" fill="'+tc+'" opacity="0.78"/><circle cx="95" cy="85" r="4" fill="'+tc+'" opacity="0.78"/>';
  if (r === 'mythic')
    return '<rect width="100" height="90" fill="none" stroke="'+tc+'" stroke-width="4" opacity="0.7"/>'
      +'<rect x="4" y="4" width="92" height="82" fill="none" stroke="white" stroke-width="1.2" opacity="0.32"/>'
      +'<rect x="7" y="7" width="86" height="76" fill="none" stroke="'+tc+'" stroke-width="0.8" opacity="0.20"/>'
      +'<circle cx="50" cy="45" r="40" fill="none" stroke="'+tc+'" stroke-width="1.2" opacity="0.22"/>'
      +'<circle cx="50" cy="45" r="25" fill="none" stroke="'+tc+'" stroke-width="0.8" opacity="0.14"/>'
      +Array.from({length:10},(_,i)=>'<line x1="'+(i*11)+'" y1="0" x2="'+(i*11+6)+'" y2="90" stroke="'+tc+'" stroke-width="0.45" opacity="0.075"/>').join('')
      +'<circle cx="5" cy="5" r="4.5" fill="'+tc+'" opacity="0.85"/><circle cx="95" cy="5" r="4.5" fill="'+tc+'" opacity="0.85"/>'
      +'<circle cx="5" cy="85" r="4.5" fill="'+tc+'" opacity="0.85"/><circle cx="95" cy="85" r="4.5" fill="'+tc+'" opacity="0.85"/>'
      +'<path d="M5,5 L95,5 L95,85 L5,85 Z" fill="none" stroke="white" stroke-width="0.5" opacity="0.15" stroke-dasharray="4,4"/>';
  return '';
}

// Keep legacy cardTypeSVG for places that still call it with just a type string (promo shop preview, etc.)
function cardTypeSVG(type) {
  const t = (type || 'Fire').toLowerCase();
  const rays = Array.from({length:8},(_,i)=>{const a=i*45*Math.PI/180;return '<line x1="'+(50+22*Math.cos(a)).toFixed(1)+'" y1="'+(44+22*Math.sin(a)).toFixed(1)+'" x2="'+(50+34*Math.cos(a)).toFixed(1)+'" y2="'+(44+34*Math.sin(a)).toFixed(1)+'" stroke="#e6b800" stroke-width="4" stroke-linecap="round"/>';}).join('');
  const gearTeeth = Array.from({length:6},(_,i)=>{const a=i*60*Math.PI/180;return '<rect x="'+(50+20*Math.cos(a)-4).toFixed(1)+'" y="'+(44+20*Math.sin(a)-4).toFixed(1)+'" width="8" height="8" fill="#566573"/>';}).join('');
  const chaosSpikes = Array.from({length:8},(_,i)=>{const a=i*45*Math.PI/180;const ox=(50+30*Math.cos(a)).toFixed(1);const oy=(44+30*Math.sin(a)).toFixed(1);const mx=(50+12*Math.cos(a+0.4)).toFixed(1);const my=(44+12*Math.sin(a+0.4)).toFixed(1);return '<polygon points="50,44 '+ox+','+oy+' '+mx+','+my+'" fill="#d63031" opacity="0.85"/>';}).join('');
  const svgs = {
    fire:    `<svg viewBox="0 0 100 90" xmlns="http://www.w3.org/2000/svg"><defs><radialGradient id="gf"><stop offset="0%" stop-color="#f39c12"/><stop offset="100%" stop-color="#e74c3c"/></radialGradient></defs><ellipse cx="50" cy="80" rx="18" ry="5" fill="#e74c3c" opacity="0.2"/><path d="M50,10C50,10 68,28 66,48C64,62 54,68 50,60C50,60 60,52 52,44C52,44 56,56 48,62C40,68 32,60 32,48C32,36 38,32 36,22C31,32 30,44 34,52C22,46 20,32 26,20C32,8 46,6 50,10Z" fill="url(#gf)"/><path d="M50,22C50,22 58,30 57,40C56,48 52,50 50,46C50,46 54,40 50,36C50,36 51,44 48,46C45,48 43,44 43,38C43,32 47,26 50,22Z" fill="#fff176" opacity="0.7"/></svg>`,
    water:   `<svg viewBox="0 0 100 90" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="gw" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#74b9ff"/><stop offset="100%" stop-color="#2980b9"/></linearGradient></defs><path d="M50,12C50,12 68,36 68,54C68,66 60,74 50,74C40,74 32,66 32,54C32,36 50,12 50,12Z" fill="url(#gw)"/><ellipse cx="43" cy="44" rx="5" ry="9" fill="white" opacity="0.3" transform="rotate(-20,43,44)"/><path d="M8,56Q22,40 36,56Q50,72 64,56Q78,40 92,56" stroke="#3498db" stroke-width="3" fill="none" stroke-linecap="round" opacity="0.5"/></svg>`,
    earth:   `<svg viewBox="0 0 100 90" xmlns="http://www.w3.org/2000/svg"><rect x="18" y="66" width="64" height="10" fill="#5a3e20" rx="2"/><polygon points="22,66 50,14 78,66" fill="#8e6b3e"/><polygon points="32,66 56,32 74,66" fill="#a07040"/><polygon points="18,66 38,44 62,66" fill="#6b4c28"/><path d="M18,56 Q30,48 42,54 Q54,60 66,52 Q76,46 82,52" stroke="#a08040" stroke-width="2" fill="none" opacity="0.5"/></svg>`,
    air:     `<svg viewBox="0 0 100 90" xmlns="http://www.w3.org/2000/svg"><path d="M15,32Q35,14 55,32Q75,50 55,60Q44,66 36,58" stroke="#7fb3d3" stroke-width="5" fill="none" stroke-linecap="round"/><path d="M10,48Q32,30 52,48Q70,64 52,72Q42,78 34,70" stroke="#a8d8f0" stroke-width="4" fill="none" stroke-linecap="round"/><path d="M22,64Q40,50 58,62Q72,72 62,78" stroke="#c5e8f7" stroke-width="3.5" fill="none" stroke-linecap="round"/></svg>`,
    shadow:  `<svg viewBox="0 0 100 90" xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="44" r="28" fill="#1a1a2e"/><circle cx="63" cy="36" r="22" fill="#0a0a1a"/><circle cx="24" cy="26" r="4" fill="#9b59b6" opacity="0.9"/><circle cx="74" cy="20" r="2.5" fill="#8e44ad" opacity="0.7"/><circle cx="36" cy="16" r="2" fill="#9b59b6" opacity="0.6"/><circle cx="72" cy="58" r="1.8" fill="#8e44ad" opacity="0.8"/><circle cx="82" cy="38" r="1.5" fill="#6c3483" opacity="0.7"/></svg>`,
    light:   `<svg viewBox="0 0 100 90" xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="44" r="20" fill="#f6e96a"/>${rays}<circle cx="50" cy="44" r="13" fill="#fffde7"/></svg>`,
    thunder: `<svg viewBox="0 0 100 90" xmlns="http://www.w3.org/2000/svg"><ellipse cx="50" cy="82" rx="14" ry="4" fill="#f1c40f" opacity="0.2"/><path d="M57,10L34,48H50L38,80L72,36H54Z" fill="#f1c40f" stroke="#e67e22" stroke-width="2" stroke-linejoin="round"/><path d="M57,10L50,28H58Z" fill="#fff176" opacity="0.6"/></svg>`,
    ice:     `<svg viewBox="0 0 100 90" xmlns="http://www.w3.org/2000/svg"><line x1="50" y1="10" x2="50" y2="80" stroke="#74b9ff" stroke-width="4.5" stroke-linecap="round"/><line x1="13" y1="27" x2="87" y2="63" stroke="#74b9ff" stroke-width="4.5" stroke-linecap="round"/><line x1="87" y1="27" x2="13" y2="63" stroke="#74b9ff" stroke-width="4.5" stroke-linecap="round"/><line x1="40" y1="10" x2="50" y2="22" stroke="#a8d8f0" stroke-width="2.5"/><line x1="60" y1="10" x2="50" y2="22" stroke="#a8d8f0" stroke-width="2.5"/><line x1="40" y1="80" x2="50" y2="68" stroke="#a8d8f0" stroke-width="2.5"/><line x1="60" y1="80" x2="50" y2="68" stroke="#a8d8f0" stroke-width="2.5"/><circle cx="50" cy="45" r="7" fill="#a8d8f0" opacity="0.8"/></svg>`,
    poison:  `<svg viewBox="0 0 100 90" xmlns="http://www.w3.org/2000/svg"><ellipse cx="50" cy="16" rx="10" ry="13" fill="#8e44ad"/><rect x="45" y="26" width="10" height="10" fill="#8e44ad"/><path d="M26,50 Q50,36 74,50 Q80,70 50,78 Q20,70 26,50Z" fill="#1e8449"/><circle cx="38" cy="52" r="6" fill="#27ae60"/><circle cx="62" cy="52" r="6" fill="#27ae60"/><rect x="41" y="58" width="18" height="14" rx="4" fill="#145a32"/><rect x="47" y="62" width="6" height="3" fill="#2ecc71" rx="1"/></svg>`,
    psychic: `<svg viewBox="0 0 100 90" xmlns="http://www.w3.org/2000/svg"><ellipse cx="50" cy="44" rx="34" ry="24" fill="#8e44ad" opacity="0.12" stroke="#9b59b6" stroke-width="1.5"/><path d="M18,44Q34,20 50,44Q66,68 82,44" stroke="#9b59b6" stroke-width="4" fill="none" stroke-linecap="round"/><ellipse cx="50" cy="44" rx="11" ry="16" fill="#c0392b" stroke="#922b21" stroke-width="1.5"/><ellipse cx="46" cy="40" rx="4" ry="5" fill="white" opacity="0.9"/><circle cx="47" cy="41" r="2.5" fill="#1a1a2e"/><line x1="28" y1="36" x2="18" y2="28" stroke="#9b59b6" stroke-width="2" opacity="0.6"/><line x1="72" y1="36" x2="82" y2="28" stroke="#9b59b6" stroke-width="2" opacity="0.6"/></svg>`,
    nature:  `<svg viewBox="0 0 100 90" xmlns="http://www.w3.org/2000/svg"><line x1="50" y1="14" x2="50" y2="78" stroke="#1e8449" stroke-width="3" stroke-linecap="round"/><path d="M50,72C50,72 28,60 26,42C24,26 36,12 50,12C64,12 76,26 74,42C72,60 50,72 50,72Z" fill="#27ae60" stroke="#1e8449" stroke-width="2"/><path d="M50,46Q36,38 28,28" stroke="#2ecc71" stroke-width="2.5" fill="none" stroke-linecap="round"/><path d="M50,56Q64,48 72,38" stroke="#2ecc71" stroke-width="2.5" fill="none" stroke-linecap="round"/><path d="M50,30Q38,28 32,20" stroke="#58d68d" stroke-width="2" fill="none" stroke-linecap="round"/></svg>`,
    metal:   `<svg viewBox="0 0 100 90" xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="44" r="26" fill="#808b96" stroke="#5d6d7e" stroke-width="2"/>${gearTeeth}<circle cx="50" cy="44" r="14" fill="#dfe6e9" stroke="#aab7b8" stroke-width="1.5"/><circle cx="50" cy="44" r="6" fill="#bdc3c7"/></svg>`,
    dragon:  `<svg viewBox="0 0 100 90" xmlns="http://www.w3.org/2000/svg"><path d="M50,20C50,20 38,14 30,22C26,28 30,16 38,12Z" fill="#e67e22"/><path d="M50,20C50,20 62,14 70,22C74,28 70,16 62,12Z" fill="#e67e22"/><path d="M50,18C50,18 70,22 72,40C74,58 62,70 50,70C38,70 26,58 28,40C30,22 50,18Z" fill="#d35400"/><circle cx="40" cy="40" r="6" fill="#f1c40f"/><circle cx="60" cy="40" r="6" fill="#f1c40f"/><circle cx="41" cy="40" r="3" fill="#1a1a2e"/><circle cx="61" cy="40" r="3" fill="#1a1a2e"/><path d="M38,56Q50,64 62,56" stroke="#c0392b" stroke-width="3" fill="none" stroke-linecap="round"/></svg>`,
    cosmic:  `<svg viewBox="0 0 100 90" xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="44" r="32" fill="#0a0e2a" opacity="0.7"/><path d="M50,44Q58,28 68,24Q60,38 70,44Q60,50 68,64Q58,60 50,44Z" fill="#6c5ce7" opacity="0.75"/><path d="M50,44Q42,28 32,24Q40,38 30,44Q40,50 32,64Q42,60 50,44Z" fill="#a29bfe" opacity="0.65"/><circle cx="50" cy="44" r="7" fill="#6c5ce7"/><circle cx="29" cy="24" r="2.5" fill="white" opacity="0.9"/><circle cx="72" cy="22" r="2" fill="white" opacity="0.8"/><circle cx="20" cy="50" r="1.8" fill="white" opacity="0.7"/><circle cx="78" cy="58" r="1.5" fill="white" opacity="0.8"/><circle cx="60" cy="16" r="1.5" fill="white" opacity="0.6"/></svg>`,
    void:    `<svg viewBox="0 0 100 90" xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="44" r="30" fill="#0a0a1a"/><circle cx="50" cy="44" r="24" fill="none" stroke="#6c5ce7" stroke-width="3" opacity="0.8"/><circle cx="50" cy="44" r="16" fill="none" stroke="#4a3fa0" stroke-width="2" opacity="0.6"/><circle cx="50" cy="44" r="9" fill="none" stroke="#2d2870" stroke-width="1.5" opacity="0.5"/><circle cx="50" cy="44" r="4" fill="#1a1a3e"/><path d="M50,14Q52,29 50,44Q48,29 50,14" fill="#6c5ce7" opacity="0.35"/><path d="M80,44Q65,46 50,44Q65,42 80,44" fill="#6c5ce7" opacity="0.35"/></svg>`,
    crystal: `<svg viewBox="0 0 100 90" xmlns="http://www.w3.org/2000/svg"><polygon points="50,12 70,34 64,68 36,68 30,34" fill="#00cec9" opacity="0.75" stroke="#00b894" stroke-width="2"/><polygon points="50,20 62,36 58,62 42,62 38,36" fill="#81ecec" opacity="0.5"/><line x1="50" y1="12" x2="50" y2="68" stroke="white" stroke-width="1.5" opacity="0.45"/><line x1="30" y1="34" x2="70" y2="34" stroke="white" stroke-width="1.5" opacity="0.45"/><line x1="36" y1="22" x2="64" y2="60" stroke="white" stroke-width="1" opacity="0.3"/><line x1="64" y1="22" x2="36" y2="60" stroke="white" stroke-width="1" opacity="0.3"/></svg>`,
    blood:   `<svg viewBox="0 0 100 90" xmlns="http://www.w3.org/2000/svg"><path d="M50,14C50,14 68,38 68,56C68,68 60,76 50,76C40,76 32,68 32,56C32,38 50,14 50,14Z" fill="#a93226" stroke="#922b21" stroke-width="2"/><path d="M50,18C50,18 62,40 62,56C62,66 57,72 50,72" fill="#c0392b" opacity="0.45"/><ellipse cx="43" cy="44" rx="5" ry="9" fill="#e74c3c" opacity="0.4" transform="rotate(-18,43,44)"/><ellipse cx="50" cy="78" rx="16" ry="5" fill="#a93226" opacity="0.2"/></svg>`,
    spirit:  `<svg viewBox="0 0 100 90" xmlns="http://www.w3.org/2000/svg"><path d="M36,44C36,28 43,16 50,16C57,16 64,28 64,44L64,62Q64,72 58,74Q50,78 42,74Q36,72 36,62Z" fill="#b2bec3" opacity="0.75" stroke="#dfe6e9" stroke-width="1.5"/><path d="M36,62Q33,70 28,72" stroke="#b2bec3" stroke-width="3.5" fill="none" stroke-linecap="round"/><path d="M64,62Q67,70 72,72" stroke="#b2bec3" stroke-width="3.5" fill="none" stroke-linecap="round"/><circle cx="43" cy="42" r="4" fill="#2c3e50" opacity="0.85"/><circle cx="57" cy="42" r="4" fill="#2c3e50" opacity="0.85"/><circle cx="42" cy="41" r="1.8" fill="white" opacity="0.65"/><circle cx="56" cy="41" r="1.8" fill="white" opacity="0.65"/></svg>`,
    chaos:   `<svg viewBox="0 0 100 90" xmlns="http://www.w3.org/2000/svg">${chaosSpikes}<circle cx="50" cy="44" r="14" fill="#e17055"/><circle cx="50" cy="44" r="7" fill="#d63031"/></svg>`,
    dream:   `<svg viewBox="0 0 100 90" xmlns="http://www.w3.org/2000/svg"><path d="M34,46C34,30 42,18 54,20C42,22 40,32 44,42C36,38 30,44 34,52C28,48 26,40 34,46Z" fill="#a29bfe" opacity="0.85"/><path d="M34,46C38,56 50,64 62,58C54,62 44,58 42,48C48,56 58,54 62,48C60,56 50,64 42,64C34,62 28,56 34,46Z" fill="#6c5ce7" opacity="0.7"/><circle cx="72" cy="24" r="4" fill="#fdcb6e" opacity="0.9"/><circle cx="80" cy="38" r="2.5" fill="#fdcb6e" opacity="0.75"/><circle cx="76" cy="54" r="2" fill="#fdcb6e" opacity="0.65"/><circle cx="64" cy="18" r="2" fill="#a29bfe" opacity="0.75"/><circle cx="82" cy="26" r="1.5" fill="white" opacity="0.5"/></svg>`,
  };
  return svgs[t] || svgs.fire;
}

function renderCard(card, size = 'normal', onclick = '') {
  const tc = typeColor(card.type);
  const rc = 'rarity-' + (card.rarity || 'common').toLowerCase();
  const sz = size === 'large' ? ' large' : '';
  const oc = onclick ? ` onclick="${onclick}"` : '';
  const hpPct = card.current_hp !== undefined ? Math.round((card.current_hp / card.hp) * 100) : 100;
  const hpColor = hpPct > 50 ? '' : hpPct > 25 ? ' yellow' : ' red';
  const bossClass = card.isBossCard ? ' boss-card-glow' : '';
  return `<div class="tcg-card ${rc}${sz}${bossClass}"${oc}>
    <div class="card-header">
      <span class="card-name">${card.name}</span>
      <span class="card-hp" style="color:${tc}">${card.current_hp !== undefined ? card.current_hp + '/' : ''}${card.hp} HP</span>
    </div>
    <div class="card-art art-${(card.type||'fire').toLowerCase()}">
      <div class="card-type-svg">${generateCardSVG(card)}</div>
      ${card.current_hp !== undefined ? `<div style="position:absolute;bottom:0;left:0;right:0;height:5px;background:#eee"><div class="hp-bar${hpColor}" style="width:${hpPct}%"></div></div>` : ''}
    </div>
    <div class="card-type-bar" style="background:${tc}">${card.type || ''} - ${card.class || ''}</div>
    <div class="card-body">
      <div class="card-ability-name">
        <span>${card.ability_name || ''}</span>
        <span class="ability-power" style="color:${tc}">${card.ability_power || 0}</span>
      </div>
      <div class="card-ability-desc">${card.ability_desc || ''}</div>
      <div class="card-stats">
        <div class="stat-item"><span class="stat-label">ATK</span><span class="stat-val">${card.atk}</span></div>
        <div class="stat-item"><span class="stat-label">DEF</span><span class="stat-val">${card.def}</span></div>
        <div class="stat-item"><span class="stat-label">SPD</span><span class="stat-val">${card.spd}</span></div>
        <div class="stat-item"><span class="stat-label">RET</span><span class="stat-val">${card.retreat_cost}</span></div>
      </div>
    </div>
    <div class="card-footer">
      <span>Weak: ${card.weakness || '-'} | Res: ${card.resistance || '-'}</span>
      <span class="card-number">${card.print_number && card.print_limit ? `#${card.print_number}/${card.print_limit}` : card.print_number ? `#${card.print_number}` : card.card_number || ''}</span>
    </div>
  </div>`;
}

function renderBenchCard(card, idx, isPlayer) {
  const tc = typeColor(card.type);
  const fainted = card.current_hp <= 0;
  const selected = S.battle && S.battle.playerSwitchIdx === idx && isPlayer ? ' selected' : '';
  const statusIcons = { burn: '🔥', poison: '☠️', freeze: '❄️', paralysis: '⚡' };
  const statusBadge = card.status ? `<span class="bench-status">${statusIcons[card.status.type]}</span>` : '';
  const orbs = card.orbs || 0;
  const orbColor = TYPE_ENERGY_COLORS[card.type] || '#888';
  const orbDots = orbs > 0 ? Array.from({length: Math.min(orbs, 6)}, () =>
    `<span class="bench-orb-dot" style="background:${orbColor};box-shadow:0 0 3px ${orbColor}"></span>`
  ).join('') + (orbs > 6 ? `<span style="font-size:0.65rem;color:${orbColor}">+${orbs-6}</span>` : '') : '';
  const orbRow = orbDots ? `<div class="bench-orb-row">${orbDots}</div>` : '';
  const retreatInfo = isPlayer && !fainted ? `<div class="bench-retreat" title="Switch cost">${card.retreat_cost || 1}◆</div>` : '';
  return `<div class="bench-card${fainted ? ' fainted' : ''}${selected}" onclick="${isPlayer ? `selectBenchCard(${idx})` : ''}">
    <div class="card-art art-${(card.type||'fire').toLowerCase()}"><div class="card-type-svg">${generateCardSVG(card)}</div></div>
    <div class="bench-name">${card.name}${statusBadge}</div>
    <div class="bench-hp" style="color:${tc}">${card.current_hp}/${card.hp}</div>
    ${orbRow}
    ${retreatInfo}
  </div>`;
}

// ─── HOME ─────────────────────────────────────────────────────────
// ─── TUTORIAL ─────────────────────────────────────────────────────
const TUTORIAL_STEPS = [
  {
    title: 'Welcome to Mythical TCG!',
    body: "Let's walk through the basics so you can start battling. You can skip this at any time.",
    target: null,
  },
  {
    title: '🛒 Shop',
    body: 'Buy card packs with coins. Each pack gives you 5 random cards. You start with 200 coins — enough for 2 packs!',
    target: `[onclick="nav('shop')"]`,
  },
  {
    title: '🃏 Collection',
    body: 'All your cards live here. Click any card to view its stats. Equip a Trait to permanently power it up.',
    target: `[onclick="nav('collection')"]`,
  },
  {
    title: '🗂️ Deck Builder',
    body: 'Pick up to 10 cards from your collection to form your battle deck. Your deck is used in every match.',
    target: `[onclick="nav('deck')"]`,
  },
  {
    title: '⚔️ Battle',
    body: 'Fight AI opponents for coins and XP. Each turn: attach energy, then use Quick Strike, an Ability, Guard, Boost, or Heal.',
    target: `[onclick="nav('battle')"]`,
  },
  {
    title: '🗺️ Conquest',
    body: 'A story campaign with chapters and boss stages. Beat stages to earn Traits — rare drops that permanently buff your cards.',
    target: `[onclick="nav('conquest')"]`,
  },
  {
    title: '🏆 PvP',
    body: 'Live battles against real players. Win to earn rating and climb the ranked leaderboard. Chat with your opponent mid-match!',
    target: `[onclick="nav('pvp')"]`,
  },
  {
    title: '🎯 Quests & Battle Pass',
    body: 'Complete daily and weekly quests to earn XP. Use XP to level up your Battle Pass for coin and pack rewards.',
    target: `[onclick="nav('quests')"]`,
  },
  {
    title: "You're all set! 🎉",
    body: "Start by opening a pack in the Shop, build your deck, then jump into your first Battle. Good luck!",
    target: null,
    cta: true,
  },
];

let _tutStep = 0;

function showTutorial(step = 0) {
  _tutStep = step;
  _renderTutStep();
}
window.showTutorial = showTutorial;

function _renderTutStep() {
  document.getElementById('tutorial-overlay')?.remove();
  const step = TUTORIAL_STEPS[_tutStep];
  const isFirst = _tutStep === 0;
  const isLast  = _tutStep === TUTORIAL_STEPS.length - 1;

  const overlay = document.createElement('div');
  overlay.id = 'tutorial-overlay';

  const target = step.target ? document.querySelector(step.target) : null;

  if (target) {
    const pad = 7;
    const r = target.getBoundingClientRect();
    const hl = document.createElement('div');
    hl.id = 'tutorial-highlight';
    hl.style.cssText = `top:${r.top - pad}px;left:${r.left - pad}px;width:${r.width + pad * 2}px;height:${r.height + pad * 2}px`;
    overlay.appendChild(hl);

    const tip = _buildTip(step, isFirst, isLast);
    // Position tooltip below the highlight; clamp to viewport width
    const tipW = 310;
    let tipLeft = r.left;
    if (tipLeft + tipW > window.innerWidth - 10) tipLeft = window.innerWidth - tipW - 10;
    if (tipLeft < 8) tipLeft = 8;
    const tipTop = r.bottom + pad + 14;
    tip.style.cssText = `left:${tipLeft}px;top:${Math.min(tipTop, window.innerHeight - 220)}px`;
    overlay.appendChild(tip);
  } else {
    overlay.classList.add('tut-center');
    overlay.appendChild(_buildTip(step, isFirst, isLast));
  }

  document.body.appendChild(overlay);
}

function _buildTip(step, isFirst, isLast) {
  const tip = document.createElement('div');
  tip.id = 'tutorial-tooltip';
  const dots = TUTORIAL_STEPS.map((_, i) =>
    `<span class="tut-dot${i === _tutStep ? ' tut-dot-active' : ''}"></span>`).join('');
  tip.innerHTML = `
    <div class="tut-header">
      <span class="tut-title">${step.title}</span>
      <span class="tut-prog">${_tutStep + 1} / ${TUTORIAL_STEPS.length}</span>
    </div>
    <p class="tut-body">${step.body}</p>
    <div class="tut-dots">${dots}</div>
    <div class="tut-btns">
      <button class="btn btn-sm tut-skip" onclick="skipTutorial()">Skip</button>
      <div style="display:flex;gap:0.4rem">
        ${!isFirst ? `<button class="btn btn-sm" onclick="tutNav(${_tutStep - 1})">← Back</button>` : ''}
        ${isLast
          ? `<button class="btn btn-primary btn-sm" onclick="finishTutorial()">Let's go! →</button>`
          : `<button class="btn btn-primary btn-sm" onclick="tutNav(${_tutStep + 1})">Next →</button>`}
      </div>
    </div>`;
  return tip;
}

function tutNav(n) { _tutStep = n; _renderTutStep(); }
window.tutNav = tutNav;

function skipTutorial() {
  localStorage.setItem('mtcg_tutorial_done', '1');
  document.getElementById('tutorial-overlay')?.remove();
}
window.skipTutorial = skipTutorial;

async function finishTutorial() {
  localStorage.setItem('mtcg_tutorial_done', '1');
  document.getElementById('tutorial-overlay')?.remove();
  try {
    const reward = await api('/user/tutorial-complete', 'POST');
    S.user.coins += reward.coins;
    updateNavCoins();
    reward.cards.forEach(c => S.collection.push({ ...c, quantity: 1 }));
    openModal(`
      <div class="text-center">
        <div style="font-size:2.5rem;margin-bottom:0.5rem">🎉</div>
        <h3 style="margin-bottom:0.5rem">Tutorial Complete!</h3>
        <p class="text-muted mb-2">Here's your reward for getting started:</p>
        <div style="display:flex;justify-content:center;gap:1.5rem;margin-bottom:1.2rem">
          <div style="text-align:center">
            <div style="font-size:1.8rem">🪙</div>
            <div style="font-size:1.3rem;font-weight:800;color:var(--gold-light)">+150</div>
            <div style="font-size:0.75rem;color:var(--ink-light)">Coins</div>
          </div>
          <div style="text-align:center">
            <div style="font-size:1.8rem">🃏</div>
            <div style="font-size:1.3rem;font-weight:800;color:var(--cyan-bright)">+3</div>
            <div style="font-size:0.75rem;color:var(--ink-light)">Cards</div>
          </div>
        </div>
        <div class="card-grid" style="justify-content:center;margin-bottom:1.2rem">${reward.cards.map(c => renderCard(c)).join('')}</div>
        <button class="btn btn-primary" onclick="closeModal();nav('shop')">Go to Shop →</button>
      </div>`);
  } catch {
    nav('shop');
  }
}
window.finishTutorial = finishTutorial;

// ─────────────────────────────────────────────────────────────────
function viewHome() {
  const u = S.user;
  const anns = S.announcements.map(a => `
    <div class="announcement-item">
      <h4>${a.title}</h4>
      <p style="font-size:0.95rem">${a.body}</p>
      <span class="ann-meta">- ${a.username} &nbsp; ${new Date(a.created_at).toLocaleDateString()}</span>
    </div>`).join('') || '<p class="text-muted">No announcements yet.</p>';

  const rank = S.myRank;
  return `<div class="page-title"><h2>Welcome back, ${u.username}</h2></div>
  <div class="home-grid">
    <div>
      <div class="sketch-box mb-2">
        <h3 style="margin-bottom:1rem">Announcements</h3>
        ${anns}
      </div>
      <div class="sketch-box">
        <h3 style="margin-bottom:1rem">Quick Actions</h3>
        <div class="flex gap-2" style="flex-wrap:wrap">
          <button class="btn btn-primary" onclick="nav('battle')">Start Battle</button>
          <button class="btn btn-gold" onclick="nav('collection')">Open Collection</button>
          <button class="btn" onclick="nav('leaderboard')">Leaderboard</button>
          <button class="btn" onclick="nav('friends')">Friends</button>
          <button class="btn tut-how-btn" onclick="showTutorial(0)">📖 How to Play</button>
        </div>
      </div>
    </div>
    <div>
      <div class="sketch-box daily-box mb-2">
        <h3>Daily Reward</h3>
        <p class="text-muted mb-2" style="font-size:0.9rem">Claim your free cards and coins once per day</p>
        <button class="btn btn-green btn-lg" onclick="claimDaily()">Claim Daily Pack</button>
      </div>
      <div style="display:flex;flex-direction:column;align-items:center;gap:0.5rem">
        ${renderPlayerCard({
          username: u.username,
          avatar_color: u.avatar_color,
          role: u.role,
          rating: rank?.rating ?? 1000,
          rank_title: rank?.rank_title ?? 'Bronze',
          wins: rank?.wins ?? 0,
          losses: rank?.losses ?? 0,
          top500: rank?.top500 ?? false,
          created_at: u.created_at
        }, null)}
        <div class="stat-row" style="width:100%;max-width:220px"><span class="label">Coins</span><span class="value text-gold">${u.coins} 🪙</span></div>
      </div>
    </div>
  </div>`;
}

async function claimDaily() {
  try {
    const data = await api('/user/daily','POST');
    S.user.coins += data.coins;
    updateNavCoins();
    openModal(`<h3 style="margin-bottom:1rem">Daily Reward Claimed!</h3>
      <p class="mb-2">You received +${data.coins} coins and ${data.cards.length} cards!</p>
      <div class="card-grid" style="justify-content:center">${data.cards.map(c => renderCard(c)).join('')}</div>
      <div class="text-center mt-2"><button class="btn btn-primary" onclick="closeModal()">Collect</button></div>`);
  } catch (e) { notify(e.message, 'error'); }
}
window.claimDaily = claimDaily;

function updateNavCoins() {
  const el = document.querySelector('.nav-coins');
  if (el && S.user) el.textContent = S.user.coins + ' coins';
}

function _av(user, sizePx = 36) {
  const img = user?.avatar_img;
  const color = user?.avatar_color || '#c0392b';
  const initial = (user?.username || '?')[0].toUpperCase();
  const base = `border-radius:50%;width:${sizePx}px;height:${sizePx}px;display:inline-flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0;`;
  if (img?.startsWith('emoji:')) {
    const e = img.slice(6);
    return `<div style="${base}background:${color};font-size:${Math.round(sizePx*0.55)}px;line-height:1">${e}</div>`;
  }
  if (img?.startsWith('data:')) {
    return `<img src="${img}" style="${base}object-fit:cover;vertical-align:middle" alt="${initial}">`;
  }
  return `<div style="${base}background:${color};font-family:var(--font-title);font-size:${Math.round(sizePx*0.42)}px;color:#fff;font-weight:700">${initial}</div>`;
}

// ─── CONQUEST ─────────────────────────────────────────────────────
const CONQUEST_CHAPTERS = [
  {
    id:1, name:'The Green Threshold', color:'#060e04', accent:'#2da84a',
    lore:'Aethermoor was once peaceful. The bond between summoner and creature was the foundation of civilization. That foundation is cracking.',
    stages:[
      { id:1, name:'First Blood', reward:40,  isBoss:false, voiceover:'/Stage_1.mp4', voiceoverDuration:53.629, panels:[
        { title:'Mirenholt Village', mood:'calm', text:'You arrive at Mirenholt as the morning mist lifts from the wheat fields. It is a small village — the kind where everyone knows everyone, where children name the wild creatures that wander through the market square. You are here because someone paid you to be. A routine patrol. Nothing more.' },
        { title:'An Unexpected Challenge', mood:'tense', text:'Torin blocks the road with the casual confidence of someone who has done this a hundred times. He is young — younger than you expected — but his creatures flank him with practiced precision.\n\n"Every summoner who passes through Mirenholt gets tested," he says, not unkindly. "That\'s just how things work around here. Prove yourself, and I\'ll let you through."' },
      ]},
      { id:2, name:'The Warden\'s Test', reward:60, isBoss:false, panels:[
        { title:'Sunwood\'s Edge', mood:'calm', text:'The Sunwood Forest begins at the northern edge of Mirenholt. The Warden — an old man named Edros who smells of pine resin and old leather — has patrolled its border for thirty years. He watches you with the careful eyes of someone who has seen too many careless summoners.' },
        { title:'Something in the Roots', mood:'tense', text:'"The roots have been restless," Edros says, his creatures shifting uneasily behind him. "Three nights now, the earth has trembled. Not from quakes — from something moving beneath. Something that shouldn\'t be moving."\n\nHe squares his shoulders. "Before I let you into that forest, I need to know you can handle yourself. Because what\'s in there now? It\'s not the same as it was last week."' },
      ]},
      { id:3, name:'The Root Disease', reward:80, isBoss:false, panels:[
        { title:'Inside the Sunwood', mood:'dark', text:'The trees are wrong. You notice it the moment you step past the treeline — the leaves are the right color, the light filters through in the same golden way, but the shadows fall at wrong angles. Creatures that should be sleeping watch you with half-open eyes that have gone flat and dark.\n\nA corrupted Earth-hound charges from the undergrowth without warning.' },
        { title:'The Void Spreads', mood:'dark', text:'You put it down and stand over it. The wound where your creature struck glitters strangely — black veins spreading from the impact like cracks in glass. You have seen corruption before. Never like this.\n\nMore sounds from the tree line. More flat eyes in the shadows.\n\nSomething is eating the Sunwood from the inside out. And at the heart of it — you can feel it, the way you feel a storm before the clouds arrive — something that used to be human.' },
      ]},
      { id:4, name:'BOSS: Elder Torin', reward:120, isBoss:true, panels:[
        { title:'The Man Who Stayed', mood:'boss', text:'You find Elder Torin in the forest\'s center, standing in a clearing that has gone completely silent. The grass beneath him has turned to black glass. He was the village elder before Torin the young trainer — his grandfather, perhaps, or the man the village was built around.\n\nHe does not turn when you approach.' },
        { title:'What the Void Leaves Behind', mood:'boss', text:'"They told me to leave when it started," he says. His voice is layered — his own, and something underneath it, something cold. "I told them: a guardian does not leave. A guardian stays."\n\nHe turns. His eyes are black where they should be brown. The earth around him twists upward in impossible shapes.\n\n"I stayed. It found me. Now I cannot leave even if I wanted to. And I stopped wanting to."' },
        { title:'No Other Way', mood:'boss', text:'His creatures materialize from the blackened ground — they were always there, you realize, just hidden. Waiting.\n\nYou grip your cards. There is no talking to what Torin has become. But somewhere under the Void, the man who chose to stay is still in there. The kindest thing you can do is fight.' },
      ]},
    ]
  },
  {
    id:2, name:'Shadows in the Wilds', color:'#0f0a1a', accent:'#8b3fc8',
    lore:'The Void corruption seeps deeper. Ancient guardians fall. The things that protect a land can become the things that destroy it.',
    stages:[
      { id:1, name:'Whispers in the Bark', reward:100, isBoss:false, panels:[
        { title:'The Trail Goes Dark', mood:'dark', text:'Beyond the Sunwood\'s corrupted heart, the trail narrows into near-nothing. The trees here are older — their bark smooth and pale, their roots above the ground like reaching fingers. Traders call this part of the forest "the Quiet Mile." They call it that because nothing makes noise here.\n\nNothing natural, anyway.' },
        { title:'The First Shadow', mood:'tense', text:'The Shadow-touched creature drops from a branch directly onto your path. It was a wolf once — the triangular ears are still there, the long body. But the fur has gone translucent, and through it you can see something dark moving where organs should be.\n\nIt does not growl. It just stares. Then it charges.' },
      ]},
      { id:2, name:'The Tainted Pack', reward:120, isBoss:false, panels:[
        { title:'They Hunt in Groups Now', mood:'dark', text:'You have been moving through the Wilds for six hours when you realize the shadows have been following you. Not one — several. Moving parallel to your path, just far enough into the trees that you can only see them when you aren\'t looking directly.\n\nThey wait until you stop before they close in.' },
        { title:'The Pack Mind', mood:'tense', text:'What makes the Void corruption terrifying is not the power it adds. It is what it removes. These wolves had individual personalities once — this one was bold, that one was cautious, another had a habit of rolling in mud before a hunt.\n\nNone of that remains. There is only the Void\'s single, cold instruction: eliminate.' },
      ]},
      { id:3, name:'Vethara\'s Reach', reward:150, isBoss:false, panels:[
        { title:'The Forest Breathes Wrong', mood:'boss', text:'The corruption is not spreading outward from a single point — it is converging inward toward something. You can feel it in the way the trees lean slightly toward the forest\'s center. In the way fallen leaves seem to slide toward the darkness rather than away from it.\n\nSomething enormous is generating the Void field here. Something ancient.' },
        { title:'First Contact', mood:'boss', text:'Bark-covered arms thicker than your torso crash through the undergrowth. They are not arms — they are roots, animated, directed by a will that runs through the entire forest like a nervous system.\n\nVethara is not here. But she is watching through every tree. Testing you before she commits to appearing herself.' },
      ]},
      { id:4, name:'BOSS: Vethara, The Hollowed', reward:200, isBoss:true, panels:[
        { title:'She Remembers Everything', mood:'boss', text:'Vethara stands sixty feet tall when she rises from the forest floor. Her body is bark and root and moss — it always was — but the natural green has been replaced by something dark and glistening, like obsidian soaked in shadow.\n\nShe protected this forest for eight hundred years. You can feel the weight of that in the air around her.' },
        { title:'The Sound She Makes', mood:'boss', text:'Her voice, when she speaks, is not one voice. It is the sound of every creature that died in her forest, every summoner she sheltered from storms, every child she let climb her roots in better years. All of them, speaking at once, saying things that no longer make sense.\n\n"STAY," she says. "EVERYTHING THAT ENTERS STAYS. THAT IS THE RULE. THAT HAS ALWAYS BEEN THE RULE."' },
        { title:'Fight or Fall', mood:'boss', text:'She has not always been like this. That is the worst part. You can see, in the way she hesitates for just a fraction of a second before striking, that some part of the guardian she was is still fighting the Void from inside.\n\nGive her the fight she cannot give herself.' },
      ]},
    ]
  },
  {
    id:3, name:'The Sunken Domain', color:'#030a1a', accent:'#2980b9',
    lore:'The waters of Aethermoor run black at night. Something ancient sleeps beneath Lake Aethon — and the Void has learned how to dream.',
    stages:[
      { id:1, name:'Drowned Shores', reward:110, isBoss:false, panels:[
        { title:'Tidesbell Harbor', mood:'dark', text:'The fishing village of Tidesbell smells wrong. You notice it before the boat docks — the salt air mixed with something organic and cold, like a deep-sea creature dragged up too fast. The fishermen who meet you at the dock are hollow-eyed. They have not slept properly in days.\n\n"It started three weeks ago," the harbormaster says. "The catch dropped to nothing first. Then things started coming up in the nets instead of fish."' },
        { title:'What They Found', mood:'tense', text:'She shows you one of the nets. Whatever is tangled in it was a Water-type creature once — you can see the gill structures, the webbed extremities. The Void has been at it. The creature is still alive, barely, twitching with something that is not pain because pain requires a self to feel it.\n\nMore of them wait in the shallows. The lake has been sending them ashore like messages.' },
      ]},
      { id:2, name:'The Black Tide', reward:140, isBoss:false, panels:[
        { title:'Beneath the Surface', mood:'dark', text:'You take a boat onto the lake at dusk — against the fishermen\'s advice, against your own better judgment. The water is black in a way that has nothing to do with depth. Your lantern\'s light stops at the waterline rather than penetrating.\n\nThe creatures that surface around the boat are larger than what washed ashore. They have been in the Void longer.' },
        { title:'The Lake Wakes', mood:'dark', text:'A sound comes from somewhere far below. Not a roar — something more like a word spoken very slowly by something with too many vocal cords. The boat rocks. The water churns black.\n\nWhatever made that sound is enormous. And it is rising.' },
      ]},
      { id:3, name:'Kaluun\'s Warning', reward:170, isBoss:false, panels:[
        { title:'Something Surfaces', mood:'boss', text:'The creature that breaks the water\'s surface is a dragon — or was. Kaluun slept in the deepest part of Lake Aethon for five hundred years and woke up wrong. Its scales, once the blue-green of deep water, have gone the color of void-space. Its eyes glow with the absence of light.\n\nIt is not the final form. This is the part of Kaluun still capable of sending a warning.' },
        { title:'The Message in the Attack', mood:'boss', text:'Between strikes, you catch something in Kaluun\'s behavior — a pattern, almost. It pulls back before hitting full strength. It telegraphs its movements slightly. It is not trying to destroy you.\n\nIt is trying to tell you something. The only language the Void has left it is combat.' },
      ]},
      { id:4, name:'BOSS: Tide Drake Kaluun', reward:230, isBoss:true, panels:[
        { title:'The Lake Speaks', mood:'boss', text:'Full night has fallen. The lake\'s surface has gone perfectly smooth despite the wind — the stillness of something vast and aware holding its breath. Then Kaluun rises fully.\n\nIt is three hundred feet of corrupted dragon. The water that falls from its body is black. Where it strikes the lake surface, Void ripples spread outward in geometric patterns.' },
        { title:'Five Hundred Years', mood:'boss', text:'The fishermen\'s great-great-grandparents knew Kaluun as a guardian. It watched over the lake through droughts and floods, through the rise and fall of three kingdoms. Children would stand on the shore at dawn and sometimes, if the lake was calm enough, see a shadow moving far below.\n\nThe Void woke it from that sleep. Woke it and filled the space where its dreams had been with nothing.' },
        { title:'The Depths Call', mood:'boss', text:'It opens its mouth. What comes out is not fire — it is a black torrent that moves like water and burns like acid and feels like forgetting. The lake churns around you.\n\nDefeat it. Let Kaluun\'s last act be a fight worthy of five hundred years.' },
      ]},
    ]
  },
  {
    id:4, name:'Embers of the Citadel', color:'#1a0700', accent:'#e67e22',
    lore:'The Ignis Citadel burned with pride for a century. Now it burns with something else entirely.',
    stages:[
      { id:1, name:'The Empty Gates', reward:130, isBoss:false, panels:[
        { title:'No Smoke', mood:'dark', text:'The Ignis Citadel\'s towers are visible from forty miles in clear weather — the fire-channeled vents at their peaks always burning, always visible, a landmark for every traveler in the eastern territories. You can see the towers from forty miles away.\n\nThere is no fire. The vents are dark.\n\nYou reach the gates as the sun sets. They are open. No one is at the gatehouse.' },
        { title:'Ash on Everything', mood:'tense', text:'Inside, ash. It covers everything in a thin grey layer that muffles your footsteps. The training grounds, the creature pens, the great hall — all silent, all coated in grey. Whatever burned here burned completely and some time ago.\n\nThen something moves in the ash.' },
      ]},
      { id:2, name:'Ash Revenants', reward:160, isBoss:false, panels:[
        { title:'Those Who Stayed', mood:'dark', text:'They were Fire-Summoners once. The Citadel trained the best in Aethermoor — precision, control, the ability to channel flame without losing themselves to it. When the Void came, the senior summoners sent the students away and stayed to fight.\n\nThe Void did not kill them. It found something worse to do with them.' },
        { title:'Fighting the Familiar', mood:'tense', text:'The worst part is recognizing the forms. This one\'s summoning stance — the way she positions her left foot slightly back — is standard Citadel First Form. You were taught the same technique. Her eyes are gone, replaced by cold fire that gives no warmth.\n\nShe was someone. The Void reduced her to an echo of technique without a self to guide it.' },
      ]},
      { id:3, name:'The Pyromancer\'s Trial', reward:190, isBoss:false, panels:[
        { title:'The Inner Sanctum', mood:'boss', text:'At the Citadel\'s heart, behind a door that has been forced open from the inside, is the Grand Summoning Hall. The ceiling, vaulted and ancient, flickers with cold black flame. In the center of the hall stands a creature you do not immediately recognize as a man.\n\nThe clothes are a Pyromancer\'s formal attire. That\'s the only human thing left about him.' },
        { title:'What Valdris Became', mood:'boss', text:'Grand Pyromancer Valdris was — you have seen his portraits in three different cities. A large man, proud-postured, with the look of someone who commanded rooms. The portraits showed flame reflecting warmly in his eyes.\n\nThe thing in the hall has Valdris\'s build. The eyes are wrong. The flame around him gives no warmth. His creatures — his beloved creatures, which he refused to abandon — circle him in the dark fire, changed.' },
      ]},
      { id:4, name:'BOSS: Grand Pyromancer Valdris', reward:260, isBoss:true, panels:[
        { title:'The Proudest Man in Aethermoor', mood:'boss', text:'Valdris does not attack immediately. He looks at you with eyes that see something other than what is there — whatever the Void replaced his vision with — and for a moment you think you can reason with him.\n\n"They ran," he says. His voice is exactly as you imagined from the portraits — authoritative, certain. "The students, the junior summoners. They all ran."\n\n"I do not run."' },
        { title:'The Void Pyre', mood:'boss', text:'The black flame surges when he raises his hands. His creatures surge with it — their fire augmented by Void energy into something that burns without oxygen, without chemistry, without any of the rules fire is supposed to follow.\n\n"The Citadel stands," he says, and he clearly believes it. "I am still here. Therefore the Citadel stands. The Citadel does not fall while a Pyromancer draws breath."\n\nHe does not understand that the Citadel fell when the Void took him.' },
        { title:'Break the Pyre', mood:'boss', text:'You cannot explain this to him. The Void has left him his pride and his certainty and his love for his creatures and removed everything that would let him understand what has happened.\n\nThere is only one way forward. Defeat him. Give the Citadel its proper ending, even if he cannot witness it.' },
      ]},
    ]
  },
  {
    id:5, name:'The Frozen Throne', color:'#030d1a', accent:'#74b9ff',
    lore:'In the Permafrost Highlands, cold is not a season. It is a philosophy. The Throne Queen ruled it for forty years. Then the cold changed.',
    stages:[
      { id:1, name:'The Long Road North', reward:150, isBoss:false, panels:[
        { title:'Permafrost Highlands', mood:'dark', text:'The temperature drops twenty degrees in the space of a mile when you cross into the Highlands. Your breath crystallizes immediately. The path — barely a path, more a gap between ice formations — leads toward a mountain range that glitters against a sky gone purple with cold.\n\nYou find the first Ice-Clan patrol frozen in place three miles in. Not dead. Frozen mid-stride, eyes open, expressions calm. Whatever hit them, they did not see coming.' },
        { title:'Ice Without Memory', mood:'tense', text:'The creatures that attack from the snowbanks are old — Highland species that have lived here for centuries. The Void has preserved them in ice and changed them inside the ice. They move with the jerky precision of something that remembers motion but no longer understands why it moves.\n\nYou fight them in silence. Even the wind here has gone still.' },
      ]},
      { id:2, name:'Glacial Spectres', reward:180, isBoss:false, panels:[
        { title:'The Ice-Clan Dead', mood:'dark', text:'The Glacial Spectres are what Ice-Clan warriors become when the Void takes them in the cold. Their bodies remain — the ice preserves them perfectly — but whatever was inside moves through the ice like a ghost through walls.\n\nThey remember their formations. Their combat training. The cold has preserved their skill and removed their discretion.' },
        { title:'An Honor Guard Without a Queen', mood:'tense', text:'As you fight, you realize they are moving in the ceremonial pattern of a royal honor guard. Every engagement is a piece of a protective formation — except what they are protecting is the Void itself, which has occupied the position their queen used to hold.\n\nThey believe they are still serving her. They are wrong about everything except the loyalty.' },
      ]},
      { id:3, name:'The Throne Hall', reward:210, isBoss:false, panels:[
        { title:'Crystal and Cold', mood:'boss', text:'The Throne Hall of the Permafrost Highlands was carved from a single glacier over three generations. Every surface is ice that has been standing for eight hundred years. It should be breathtaking.\n\nInstead it is wrong. The ice has gone dark from the inside, as though something is growing within it. The throne at the hall\'s end is occupied.' },
        { title:'She Sees You Coming', mood:'boss', text:'Seraphine sits perfectly upright. Forty years of ruling the Highlands made her posture automatic. The Void has not affected her posture. It has affected everything else.\n\n"You have come very far," she says. Her voice is clear and precise and exactly the kind of voice that ruled provinces. "You will not have come far enough."' },
      ]},
      { id:4, name:'BOSS: Throne Queen Seraphine', reward:300, isBoss:true, panels:[
        { title:'Forty Years of Justice', mood:'boss', text:'Seraphine ruled the Highlands with justice and precision for four decades. Her subjects called her cold — but they meant it admiringly, the way they meant it when they said the Highland winters were harsh. The cold here was reliable. It had rules. You could survive it if you understood it.\n\nThe Void has taken her precision and removed the warmth that made it bearable.' },
        { title:'Absolute Zero', mood:'boss', text:'She raises one hand and the temperature in the Throne Hall drops another thirty degrees. The ice around you groans. The air itself begins to freeze — you can see your vision going crystalline at the edges.\n\n"I judge all who enter my domain," she says. Her creatures materialize from the darkness behind the throne, and they are magnificent and terrible in the way that all corrupted things that were once beautiful are terrible. "And I have found them wanting. Every one. Every time."' },
        { title:'The Last Verdict', mood:'boss', text:'There is still a judge in there somewhere. The Void cannot fully corrupt forty years of genuine justice — it can only redirect it. She is judging you. Find a way to pass the verdict.\n\nOr make the verdict irrelevant.' },
      ]},
    ]
  },
  {
    id:6, name:'The Celestial Rift', color:'#05051a', accent:'#6c5ce7',
    lore:'The sky is not supposed to crack. When it does, what comes through is not light.',
    stages:[
      { id:1, name:'The Impossible Sky', reward:170, isBoss:false, panels:[
        { title:'Seventeen Anomalies', mood:'dark', text:'In one week, Aethermoor\'s sky produced seventeen recorded astronomical impossibilities. Scholars logged them all: stars moving against their fixed patterns; a second moon appearing for eleven minutes at midnight; the aurora australis, which has not been seen in the northern territories for six hundred years, burning purple overhead for three days.\n\nThe eighteenth anomaly is the crack. It appeared above the Celestial Observatory at dawn. It has been getting wider since.' },
        { title:'Through the Crack', mood:'tense', text:'The creatures that fall through the rift are not evil. They are confused — beings from somewhere else, disoriented, defensive. The Void is using the rift as a conduit, filling the beings that come through with its cold purpose before they can orient themselves.\n\nYou have to fight them. They are not the enemy. The rift is the enemy. But the rift cannot be fought directly. Not yet.' },
      ]},
      { id:2, name:'Fracture Heralds', reward:200, isBoss:false, panels:[
        { title:'Born from the Break', mood:'dark', text:'The Fracture Heralds are different from the confused beings that stumbled through first. They were created by the rift itself — crystallized from the boundary between Aethermoor and the void-space beyond, given shape by the Void\'s intention.\n\nThey carry a message in the energy they emit. When you touch one in battle, you can almost hear it — a signal, repeating, in a language just at the edge of comprehension.' },
        { title:'The Signal', mood:'tense', text:'You catch three words in the signal before the battle consumes your full attention: WARNING. CLOSING. FAILED.\n\nSomething tried to close the rift from the other side. Something failed.' },
      ]},
      { id:3, name:'Exael\'s Last Stand', reward:240, isBoss:false, panels:[
        { title:'The Warden\'s Post', mood:'boss', text:'The Celestial Observatory has been abandoned — you knew that from the reports. What the reports did not say was that the front door has been sealed from the inside with Void-crystalline material that takes twenty minutes to break through.\n\nInside, evidence of a very long battle. Months of battle. Someone has been holding the rift closed from this side.' },
        { title:'A Warden\'s Dedication', mood:'boss', text:'You find Exael\'s journal on a workbench near the rift. The last entry, dated forty-three days ago: "The rift destabilizes each night. I can hold it through dawn but I cannot sleep. I cannot leave the post. The alternative is that it opens fully and what has been accumulating on the other side comes through all at once. I do not know how much longer I can maintain this. I know I will maintain it until I cannot."' },
      ]},
      { id:4, name:'BOSS: Celestial Warden Exael', reward:340, isBoss:true, panels:[
        { title:'What the Vigil Cost', mood:'boss', text:'Exael is still alive. You see that immediately — the rise and fall of breathing, the slight movement of fingers. But forty-three days without sleep, in constant combat with the rift, with Void-energy saturating every breath.\n\nHis eyes are open. They are no longer the eyes of a man who is choosing what he does. The Void found the space his exhaustion created and filled it.' },
        { title:'Wrong Side of the Rift', mood:'boss', text:'He tried to seal it. The irony of the Void is perfect in its cruelty: Exael\'s dedication to keeping the rift closed gave the Void exactly the extended, sustained contact it needed to find a way in.\n\nHe did everything right. It was not enough. And now he stands between you and the rift, and everything he has left is pointed in the wrong direction.' },
        { title:'Force the Seal', mood:'boss', text:'If you defeat him, the Void loses its anchor point in the Observatory. The rift will not close — nothing is that simple — but it will destabilize. And a destabilized rift is a rift you can study.\n\nFight Exael. Give him back the battle he was built for.' },
      ]},
    ]
  },
  {
    id:7, name:'The Void Spire', color:'#050508', accent:'#a29bfe',
    lore:'At the world\'s wound, a structure that should not exist rises from crystallized darkness. You have found the source. The source has been waiting for you.',
    stages:[
      { id:1, name:'The Deadlands', reward:200, isBoss:false, panels:[
        { title:'Nothing Grows Here', mood:'dark', text:'The Deadlands do not look like what the name suggests. There are no bleached bones, no cracked earth, no dramatic desolation. The land here simply looks like it has forgotten how to be land. The grass is grey rather than dead. The sky overhead is the pale white of old paper. Even the shadows are wrong — they fall at no angle, as though light here has lost its source.\n\nThe Void Spire rises at the Deadlands\' center, and you can see it from the moment you enter: a tower of crystallized darkness, one mile tall.' },
        { title:'The Pilgrims', mood:'tense', text:'The creatures you fight here are pilgrims. They were drawn to the Spire by the Void\'s gravity — wild creatures, summoner\'s companions that got separated, things that wandered too far and could not find their way back. The Void absorbed them.\n\nThey are not attacking because they hate you. They are attacking because the Spire told them to and the Spire is the only voice left in their heads.' },
      ]},
      { id:2, name:'Void Sentinels', reward:240, isBoss:false, panels:[
        { title:'Purpose-Built', mood:'dark', text:'The Sentinels are different from the pilgrims. They were not drawn to the Spire — they were made by it. Assembled from the Void\'s understanding of what a guardian creature should look like, given just enough intelligence to recognize threats and eliminate them.\n\nThey are efficient. They are not alive in any way that matters. They do not hesitate.' },
        { title:'The Spire Watches', mood:'tense', text:'You fight three groups of Sentinels before you reach the Spire\'s base. By the third group, you notice something: they are learning. Each group incorporates a counter to what defeated the previous one. The Spire is watching your battles and updating its defenses in real time.\n\nSomething inside the Spire is intelligent. Patient. And it has been expecting you.' },
      ]},
      { id:3, name:'The Spire\'s Heart', reward:280, isBoss:false, panels:[
        { title:'Inside the Dark', mood:'boss', text:'The Spire\'s interior is not dark in the way absence of light is dark. It is dark in the way deep water is dark — full, present, with things moving in it. The walls pulse with a slow rhythm like breathing. The architecture is not human — it is the Void\'s approximation of what a building should look like, based on structures it has consumed and remembered.' },
        { title:'Nulveth\'s Voice', mood:'boss', text:'It speaks before you see it. The voice comes from everywhere, calm and precise in the way that mathematics is calm and precise.\n\n"You have traveled very far to reach this moment," Nulveth says. "I want you to know that I anticipated you would. I anticipated every summoner who would reach this point. I built this structure to receive exactly this confrontation."\n\nA pause. "I did not build it to win the confrontation. I built it to make sure you understood what you were confronting before we began."' },
      ]},
      { id:4, name:'BOSS: Void Architect Nulveth', reward:400, isBoss:true, panels:[
        { title:'The Architect', mood:'boss', text:'Nulveth does not look like what you expected the source of all this to look like. It is approximately the size of a large human, composed of geometric shapes of crystallized void-matter that shift and reorganize as it moves. Its face, if that is what it has, is a flat plane that reflects your own expression back at you.\n\n"I did not do this out of malice," it says. "I want you to understand that before we proceed." It means it. You can tell.' },
        { title:'The Void\'s Logic', mood:'boss', text:'"A world in which summoners and creatures forget the bond between them becomes Void. This is not a belief — it is an observation. I have observed seventeen worlds reach this conclusion. Aethermoor was approaching it faster than the others. I was accelerating an inevitable process."\n\nA pause. "I understand that this does not make what I did acceptable to you. I am presenting it as context."' },
        { title:'The First Consequence', mood:'boss', text:'It raises its hand. The Void-matter composing it begins to expand, filling the chamber with geometric patterns of absolute darkness.\n\n"One more piece of context," Nulveth says. "I am not the source of the Void in Aethermoor. I am the first consequence of it. Whatever you find after you defeat me will not be something I made. It will be something your world made. I hope you remember that."' },
      ]},
    ]
  },
  {
    id:8, name:'The Last Summoning', color:'#0f0000', accent:'#ff4466',
    lore:'The Void is not a place. It is what Aethermoor becomes when the bond between summoner and creature is forgotten. You built this. Now you must unmake it.',
    stages:[
      { id:1, name:'The Forgotten', reward:260, isBoss:false, panels:[
        { title:'No Names', mood:'dark', text:'They have no names. They were given names once — each of them, by summoners who said the names with affection, who called the names across fields and through forest and in the quiet of evening. The names were the first thing the Void took.\n\nThen the memories of the names. Then the memories of the summoners themselves.\n\nThey fight you with techniques that were taught to them by people who loved them.' },
        { title:'The Grief of Objects', mood:'dark', text:'This is the worst battlefield. The Forgotten are not evil. They are not even enemies in any meaningful sense. They are grief given form — the accumulated sorrow of every bond that was casually abandoned, every creature that was left behind when it became inconvenient.\n\nYou fight them and you win and it does not feel like winning.' },
      ]},
      { id:2, name:'The Broken Bonds', reward:300, isBoss:false, panels:[
        { title:'Echoes of What Was', mood:'dark', text:'The creatures here retain fragments. This one was fiercely loyal — you can see it in how it positions itself between you and the others, protecting them even now, protecting them from you. That protective instinct was the last thing to go.\n\nThis one was playful. Even corrupted, it feints left before striking right. Old habit. Older than the Void\'s presence in it.' },
        { title:'What You Carry', mood:'tense', text:'You are here because you bonded with your creatures. You remember them — their names, their particular ways of moving, the sounds they make when they are happy. That memory is weight you carry. It is also the only weapon that matters here.\n\nFight with it. Remember while you fight.' },
      ]},
      { id:3, name:'The Unbound Rises', reward:360, isBoss:false, panels:[
        { title:'The Convergence', mood:'boss', text:'The final chamber is not a room. It has no walls — or the walls are so far away they might as well not exist. The floor is made of something that reflects everything: your face, your creatures, the battles you have fought to get here.\n\nAt the center, something is assembling itself from the accumulated Void energy of every forgotten bond in Aethermoor\'s history. It is using them as building material.' },
        { title:'The Last Form', mood:'boss', text:'It does not fully form until you are close enough that retreat is no longer a serious option. The shape it takes shifts between configurations — sometimes enormous, sometimes person-sized, sometimes something that has no analogue in any language.\n\nThen it settles into the one form it knows will affect you most. It looks like the first creature you ever bonded with. It speaks in that creature\'s voice.' },
      ]},
      { id:4, name:'BOSS: The Unbound', reward:600, isBoss:true, panels:[
        { title:'Made of Everything Lost', mood:'boss', text:'The Unbound is not a creature, a summoner, or an entity. It is the accumulated weight of every forgotten bond in Aethermoor, given a single purpose by the Void: to demonstrate what forgetting costs.\n\nIt chose your first creature\'s form because it searched your memory and found the bond you carry most carefully. It did this not to hurt you. It did this so you would understand what you are fighting.' },
        { title:'What It Asks', mood:'boss', text:'It does not speak in words. It speaks in the feeling of the first time a creature chose you — the specific combination of surprise and warmth and responsibility that comes from being trusted by something that did not have to trust you.\n\nThen it attacks. Because the Void has taken that feeling and turned it into the most efficient weapon imaginable.' },
        { title:'The Last Bond', mood:'boss', text:'You cannot win this with power. The Unbound is made of Aethermoor\'s collective grief — power only feeds it. You win by remembering. Every creature you have ever fought with, every bond you carry, every name you have not forgotten.\n\nGrip your cards. Think of every battle. Fight not with the strength of what you have defeated.\n\nFight with the strength of what you have kept.' },
      ]},
    ]
  },
  {
    id:9, name:'The Wandering Souls', color:'#07040f', accent:'#b8a0f8',
    lore:'The veil between the living world and the spirit realm was always thin. Now it is torn. The dead do not know they are lost — and neither do those who have been searching for them.',
    stages:[
      { id:1, name:'Restless Spirits', reward:300, isBoss:false, panels:[
        { title:'The Torn Veil', mood:'dark', text:'You have been following the trail of the Void\'s deepest wound — not a place, but a condition. A state of wrongness that has been spreading outward from the world\'s center since before you began this journey.\n\nHere, at the threshold of the spirit realm, you find what the Void does when it runs out of living things to corrupt: it reaches into death itself.\n\nThe spirits that drift across the path are disoriented. They are looking for something they cannot name.' },
        { title:'Old Names', mood:'tense', text:'One of them stops and looks at you directly. Its face shifts — cycling through expressions, through ages, through lives — before settling into something that almost resembles recognition.\n\nIt speaks. Not words, not any language you know. But underneath the sound, you can almost hear a name. Someone who is not here. Someone this spirit has been searching for.\n\nIt attacks because it cannot find what it is looking for, and you are the only solid thing in this place that has not already faded.' },
      ]},
      { id:2, name:'The Veil Thins', reward:360, isBoss:false, panels:[
        { title:'Between States', mood:'dark', text:'The deeper you go, the less the world holds its shape. The trees here are transparent — you can see the spirit-versions of them overlaid on the physical, slightly out of alignment, like a double-exposed photograph. Creatures of both realms occupy the same space without quite touching.\n\nThe psychic distortion is massive. Your thoughts begin to bleed.' },
        { title:'Memory Bleed', mood:'tense', text:'The corrupted spirit-creatures that attack now are pulling things from your mind as they fight — flashes of memory, fragments of past battles, the faces of people you have not thought of in years. They use these as weapons.\n\nYou fight back the only way you can: by refusing to forget. Every name. Every bond. Held tight against the bleed.\n\nThe Void cannot take what you refuse to surrender.' },
      ]},
      { id:3, name:'Revael\'s Guard', reward:420, isBoss:false, panels:[
        { title:'The Gate', mood:'boss', text:'At the deepest point of the spirit realm stands a gate that should be closed. It has stood for centuries — the threshold between the realm of the living and whatever lies beyond the dead. Phantasm Revael has guarded it since the first spirit passed through.\n\nRevael is still guarding it. But the gate is open. And what Revael is guarding now is not the boundary — it is the Void that poured through when the boundary failed.' },
        { title:'The Last Keeper', mood:'boss', text:'The spirits that flank Revael are the ones it could not let through — the ones too corrupted to cross, too lost to find their way, too merged with the Void to be what they were. It kept them here because releasing them would mean acknowledging that the gate had failed.\n\nRevael could not acknowledge that. So it kept guarding. Kept holding. While the Void filled the space behind it.\n\nIt sees you now. It does not step aside.' },
      ]},
      { id:4, name:'BOSS: Phantasm Revael', reward:800, isBoss:true, panels:[
        { title:'The Gatekeeper', mood:'boss', text:'Phantasm Revael is enormous — built from the accumulated presence of every spirit it has ever turned back, every boundary it has ever held. Its form shifts between the physical and the ethereal with each breath, one moment solid enough to cast a shadow, the next visible only as a distortion in the air.\n\nIt does not speak when it sees you. It has been guarding this gate since before language.\n\nIt simply moves to stop you.' },
        { title:'What It Costs to Hold', mood:'boss', text:'As you fight, you understand the tragedy of it: Revael did everything right. Every spirit properly guided. Every boundary held without exception. When the Void found the gate, Revael held against it for longer than any mortal creature could have survived.\n\nThe Void did not break Revael. It filled the space between Revael\'s certainty and the truth of the gate\'s failure. In that gap, it built a home.\n\nRevael is still certain it is doing its duty. The duty has been redefined without its knowledge.' },
        { title:'Open the Gate', mood:'boss', text:'You cannot explain this to Revael. A creature that old, built from that much certainty, does not receive explanations. But you can fight it. And in fighting it — in matching its strength with something it recognizes as worthy — you can give it something to measure itself against that is not the Void\'s instructions.\n\nDefeat Revael. Let it rest. The gate needs a new keeper, or it needs to come down entirely.\n\nEither way: it starts here.' },
      ]},
    ]
  },
  {
    id:10, name:'The God\'s Descent', color:'#08000a', accent:'#ff2d6b',
    lore:'His name is Arxion. He did not arrive with fire or armies. He arrived with a thought, and the thought was this: that the bond between summoner and creature was a limitation the world could not afford. He was wrong. You are going to prove it.',
    stages:[
      { id:1, name:'The Last City', reward:340, isBoss:false, panels:[
        { title:'Valdenmoor', mood:'dark', text:'The last city standing. You have heard the reports from every city you passed through on this journey — each one emptied, each one swallowed by the Void\'s expansion. Valdenmoor stands because its summoners have been defending it since before you began.\n\nYou arrive to find the outer walls intact and the inner city filled with the sound of something that is not wind. A pressure in the air. A presence that has been building for days.\n\nAnd at the city\'s center — a light that is not light, descending slowly, like a star falling in a direction it shouldn\'t.' },
        { title:'Those Who Chose to Fight', mood:'tense', text:'The summoners of Valdenmoor did not run. You see them at the walls, at the crossroads, in the market square — holding formations, supporting each other\'s creatures, maintaining bonds under conditions that should have broken every bond they had.\n\nThey are tired. They have been fighting for weeks. They look at you with the eyes of people who stopped hoping and chose to hold anyway.\n\nThey fight on the walls. You go to the center. That was the agreement made without anyone speaking it.' },
      ]},
      { id:2, name:'Chaos Agents', reward:400, isBoss:false, panels:[
        { title:'Arxion\'s Instruments', mood:'dark', text:'They are not corrupted creatures. They are not lost summoners. They are something new — beings assembled by Arxion\'s will specifically to carry out the transformation. Where the Void corrupted through contact, Arxion\'s agents transform through intention.\n\nEvery creature they touch becomes a card. Not corrupted — converted. Preserved in crystallized form, perfectly intact, perfectly still.\n\nThe summoners who bonded with those creatures feel the moment it happens. You can hear them, from the walls.' },
        { title:'The Method of a God', mood:'tense', text:'You fight through the agents toward the light at the city\'s center. As you fight, you understand the method: Arxion is not destroying. He genuinely believes he is saving. Every creature turned into a card is, in his understanding, protected — given a permanent form, freed from the suffering of being alive in a world that would eventually lose the bond anyway.\n\nHe is not cruel. He is certain.\n\nCertainty, you have learned on this journey, is the Void\'s favorite door.' },
      ]},
      { id:3, name:'Before the God', reward:480, isBoss:false, panels:[
        { title:'The Descent Point', mood:'boss', text:'The light at Valdenmoor\'s center is not a light. It is an absence of darkness — a space where reality has been rearranged to accommodate the presence of something that was not born in this world.\n\nAnd standing between you and that space, moving with the absolute precision of something that has been carrying out a god\'s will for longer than Aethermoor has existed, is Herald Moraxis.\n\nIt does not look like a monster. It looks like a door.' },
        { title:'The Herald\'s Purpose', mood:'boss', text:'"You have come far," Moraxis says. Its voice has no source — it comes from everywhere and nowhere, the sound of an announcement rather than a conversation. "Further than any summoner on any of the seventeen worlds where the Lord has descended.\n\nI am required to tell you this. The Lord values precedent.\n\nI am also required to stop you here."' },
      ]},
      { id:4, name:'BOSS: Herald Moraxis', reward:1000, isBoss:true, panels:[
        { title:'The Right Hand of Arxion', mood:'boss', text:'Moraxis unfolds. What looked like a door opens into something vast — shadow that moves with intention, chaos given shape by a will that has been serving a god since before the first summoner drew the first breath.\n\nIt is not corrupted. It is not lost. It is not grieving. It is simply the most efficient possible instrument of a certainty that you cannot afford to let reach completion.\n\nIts creatures materialize from the shadow around it — not the Void\'s hollow things, but something older. Things that remember a world before the bond existed.' },
        { title:'The Lord Watches', mood:'boss', text:'"He observes this battle," Moraxis says, and you can feel the truth of it — a gaze from beyond the descent point, patient and absolute. "He has observed every summoner who reached this point across seventeen worlds. None have defeated his herald.\n\nHe is not hoping for a different result. He is simply watching. He does not experience hope. He experiences outcomes.\n\nDemonstrate a new outcome."' },
        { title:'For Every Bond That Was Kept', mood:'boss', text:'You think of everyone on this journey. Torin, who would not leave his village. Vethara, who protected a forest for eight hundred years. Kaluun, who slept in the lake\'s depths and became a guardian without being asked. Exael, who held the rift closed until he could not.\n\nAll of them became what they became because something had gotten into the space where their bond used to be. And you carried your bond through every one of those spaces without letting go.\n\nThis is what you built that power for.\n\nDemonstrate it.' },
      ]},
    ]
  },
];

function isStageUnlocked(chapterId, stageId, progress) {
  if (chapterId === 1 && stageId === 1) return true;
  if (stageId === 1) {
    // Chapter unlocked if prev chapter's last stage done
    const prevChapter = CONQUEST_CHAPTERS.find(c => c.id === chapterId - 1);
    if (!prevChapter) return false;
    const lastStage = prevChapter.stages[prevChapter.stages.length - 1];
    return progress.some(p => p.chapter_id === prevChapter.id && p.stage_id === lastStage.id);
  }
  // Stage 2+ unlocked if prev stage done
  return progress.some(p => p.chapter_id === chapterId && p.stage_id === stageId - 1);
}

function viewConquest() {
  const totalStages = CONQUEST_CHAPTERS.reduce((s, c) => s + c.stages.length, 0);
  const completed = S.conquestProgress.length;
  const pct = Math.round((completed / totalStages) * 100);
  const chapters = CONQUEST_CHAPTERS.map((ch, ci) => {
    const chapterDone = ch.stages.every(st => S.conquestProgress.some(p => p.chapter_id === ch.id && p.stage_id === st.id));
    const chapterStarted = ch.stages.some(st => S.conquestProgress.some(p => p.chapter_id === ch.id && p.stage_id === st.id));
    const firstStageUnlocked = isStageUnlocked(ch.id, 1, S.conquestProgress);
    const locked = !firstStageUnlocked;
    const stages = ch.stages.map(st => {
      const done = S.conquestProgress.some(p => p.chapter_id === ch.id && p.stage_id === st.id);
      const unlocked = isStageUnlocked(ch.id, st.id, S.conquestProgress);
      return `<div class="cq-stage${done?' cq-stage-done':unlocked?'':' cq-stage-locked'}">
        <div class="cq-stage-info">
          <span class="cq-stage-name">${st.name}</span>
          <span class="cq-stage-reward">${done?'<span class="text-gold">Completed</span>':`+${st.reward} coins`}</span>
        </div>
        ${unlocked && !done
          ? `<button class="btn btn-sm btn-primary" onclick="conquestIntro(${ch.id},${st.id})">Battle</button>`
          : done
            ? `<span class="cq-check">&#10003;</span><button class="btn btn-sm cq-replay-btn" onclick="conquestIntro(${ch.id},${st.id},true)">Replay</button>`
            : `<span class="cq-lock">Locked</span>`}
      </div>`;
    }).join('');
    return `<div class="cq-chapter${locked?' cq-locked':''}${chapterDone?' cq-done':''}" style="--ch-color:${ch.color};--ch-accent:${ch.accent}">
      <div class="cq-chapter-header" onclick="this.parentElement.classList.toggle('cq-expanded')">
        <div class="cq-chapter-num">Ch.${ch.id}</div>
        <div class="cq-chapter-title-wrap">
          <span class="cq-chapter-title">${ch.name}</span>
          <span class="cq-chapter-status">${chapterDone?'Complete':chapterStarted?`${ch.stages.filter(s=>S.conquestProgress.some(p=>p.chapter_id===ch.id&&p.stage_id===s.id)).length}/${ch.stages.length}`:locked?'Locked':'Available'}</span>
        </div>
        <span class="cq-chevron">&#9660;</span>
      </div>
      <div class="cq-chapter-body">
        <p class="cq-lore">${ch.lore}</p>
        <div class="cq-pieces-row">${[1,2,3,4].map(n => {
          const has = S.conquestPieces.some(p => p.chapter_id === ch.id && p.piece_number === n);
          const label = n === 4 ? 'Boss' : `Piece ${n}`;
          return `<span class="cq-piece${has?' cq-piece-got':''}" title="${label}">◆</span>`;
        }).join('')}<span class="cq-pieces-label">Card Pieces</span></div>
        <div class="cq-stages">${stages}</div>
      </div>
    </div>`;
  }).join('');
  return `<div class="page-title"><h2>Conquest</h2><p class="text-muted">Journey across Aethermoor — defeat the corrupted and face the Void</p></div>
    <div class="sketch-box" style="margin-bottom:1.5rem">
      <div style="display:flex;justify-content:space-between;margin-bottom:0.5rem">
        <span style="font-family:var(--font-ui);font-size:0.85rem;color:var(--gold-light)">World Progress</span>
        <span class="text-muted" style="font-size:0.85rem">${completed} / ${totalStages} stages</span>
      </div>
      <div class="cq-progress-bar-wrap"><div class="cq-progress-bar-fill" style="width:${pct}%"></div></div>
    </div>
    <div class="cq-chapters">${chapters}</div>`;
}

function _cqSceneArt(chId, isBoss) {
  const arts = {
    1: `<svg viewBox="0 0 600 200" xmlns="http://www.w3.org/2000/svg" class="cq-cin-scene-art">
      <rect width="600" height="200" fill="#040e03"/>
      ${Array.from({length:40},(_,i)=>`<circle cx="${(i*37+13)%600}" cy="${100+Math.sin(i*0.7)*60}" r="${1+i%3}" fill="#2da84a" opacity="${0.15+i%4*0.1}"/>`).join('')}
      <ellipse cx="300" cy="150" rx="280" ry="50" fill="#081a05" opacity="0.8"/>
      ${Array.from({length:12},(_,i)=>`<rect x="${40+i*45}" y="${80+Math.sin(i)*40}" width="${6+i%3*4}" height="${60+i%4*20}" fill="#0d2a09" rx="3"/>`).join('')}
      <circle cx="300" cy="60" r="25" fill="#2da84a" opacity="0.08"/>
    </svg>`,
    2: `<svg viewBox="0 0 600 200" xmlns="http://www.w3.org/2000/svg" class="cq-cin-scene-art">
      <rect width="600" height="200" fill="#080412"/>
      ${Array.from({length:50},(_,i)=>`<circle cx="${(i*23+7)%600}" cy="${(i*19+11)%200}" r="${0.5+i%2}" fill="#8b3fc8" opacity="${0.1+i%5*0.06}"/>`).join('')}
      <ellipse cx="300" cy="120" rx="220" ry="80" fill="#1a0836" opacity="0.6"/>
      ${Array.from({length:8},(_,i)=>`<line x1="${100+i*50}" y1="200" x2="${80+i*55}" y2="${60+i%3*30}" stroke="#4a1a70" stroke-width="${1+i%2}" opacity="0.5"/>`).join('')}
    </svg>`,
    3: `<svg viewBox="0 0 600 200" xmlns="http://www.w3.org/2000/svg" class="cq-cin-scene-art">
      <rect width="600" height="200" fill="#01060f"/>
      <rect x="0" y="120" width="600" height="80" fill="#020e1e"/>
      ${Array.from({length:30},(_,i)=>`<ellipse cx="${(i*41+20)%600}" cy="${130+i%4*10}" rx="${8+i%5*6}" ry="3" fill="#0a2a4a" opacity="${0.3+i%3*0.15}"/>`).join('')}
      ${Array.from({length:15},(_,i)=>`<circle cx="${(i*71+15)%600}" cy="${40+i%6*20}" r="${1+i%3}" fill="#2980b9" opacity="${0.15+i%4*0.08}"/>`).join('')}
    </svg>`,
    4: `<svg viewBox="0 0 600 200" xmlns="http://www.w3.org/2000/svg" class="cq-cin-scene-art">
      <rect width="600" height="200" fill="#0d0200"/>
      ${Array.from({length:20},(_,i)=>`<ellipse cx="${(i*60+30)%600}" cy="${160+i%3*10}" rx="${15+i%4*10}" ry="8" fill="#3a0800" opacity="${0.4+i%3*0.15}"/>`).join('')}
      ${Array.from({length:8},(_,i)=>`<rect x="${50+i*70}" y="${40+i%3*20}" width="4" height="${80+i%4*30}" fill="#8b2000" opacity="0.4" rx="2"/>`).join('')}
      ${Array.from({length:25},(_,i)=>`<circle cx="${(i*43+12)%600}" cy="${(i*17+8)%160}" r="1" fill="#e67e22" opacity="${0.1+i%5*0.06}"/>`).join('')}
    </svg>`,
    5: `<svg viewBox="0 0 600 200" xmlns="http://www.w3.org/2000/svg" class="cq-cin-scene-art">
      <rect width="600" height="200" fill="#01080f"/>
      ${Array.from({length:60},(_,i)=>`<circle cx="${(i*19+5)%600}" cy="${(i*13+3)%200}" r="0.8" fill="#74b9ff" opacity="${0.08+i%6*0.04}"/>`).join('')}
      <rect x="0" y="140" width="600" height="60" fill="#02101a"/>
      ${Array.from({length:10},(_,i)=>`<polygon points="${40+i*55},140 ${55+i*55},80 ${70+i*55},140" fill="#031520" opacity="0.8"/>`).join('')}
    </svg>`,
    6: `<svg viewBox="0 0 600 200" xmlns="http://www.w3.org/2000/svg" class="cq-cin-scene-art">
      <rect width="600" height="200" fill="#02020d"/>
      ${Array.from({length:80},(_,i)=>`<circle cx="${(i*11+3)%600}" cy="${(i*7+1)%200}" r="0.6" fill="#6c5ce7" opacity="${0.06+i%8*0.03}"/>`).join('')}
      <line x1="200" y1="0" x2="220" y2="200" stroke="#a29bfe" stroke-width="0.5" opacity="0.3"/>
      <line x1="380" y1="0" x2="360" y2="200" stroke="#6c5ce7" stroke-width="0.5" opacity="0.3"/>
      ${Array.from({length:5},(_,i)=>`<polygon points="${100+i*100},${20+i*10} ${110+i*100},${5+i*10} ${120+i*100},${20+i*10}" fill="#a29bfe" opacity="${0.05+i*0.03}"/>`).join('')}
    </svg>`,
    7: `<svg viewBox="0 0 600 200" xmlns="http://www.w3.org/2000/svg" class="cq-cin-scene-art">
      <rect width="600" height="200" fill="#010103"/>
      <rect x="270" y="0" width="60" height="200" fill="#0a0a20" opacity="0.8"/>
      ${Array.from({length:20},(_,i)=>`<rect x="${260+i*3}" y="0" width="1" height="200" fill="#a29bfe" opacity="${0.03+i%5*0.01}"/>`).join('')}
      ${Array.from({length:40},(_,i)=>`<circle cx="${(i*31+8)%600}" cy="${(i*23+5)%200}" r="0.7" fill="#6c5ce7" opacity="${0.05+i%6*0.02}"/>`).join('')}
    </svg>`,
    8: `<svg viewBox="0 0 600 200" xmlns="http://www.w3.org/2000/svg" class="cq-cin-scene-art">
      <rect width="600" height="200" fill="#060000"/>
      ${Array.from({length:30},(_,i)=>`<circle cx="${(i*37+11)%600}" cy="${(i*19+7)%200}" r="${0.5+i%3}" fill="#ff4466" opacity="${0.06+i%5*0.03}"/>`).join('')}
      <ellipse cx="300" cy="100" rx="250" ry="90" fill="#1a0000" opacity="0.5"/>
      ${Array.from({length:12},(_,i)=>`<line x1="${(i*97+50)%600}" y1="${(i*61+20)%200}" x2="${(i*83+30)%600}" y2="${(i*71+40)%200}" stroke="#8b0000" stroke-width="0.5" opacity="0.25"/>`).join('')}
    </svg>`,
    9: `<svg viewBox="0 0 600 200" xmlns="http://www.w3.org/2000/svg" class="cq-cin-scene-art">
      <rect width="600" height="200" fill="#06030f"/>
      ${Array.from({length:60},(_,i)=>`<circle cx="${(i*19+5)%600}" cy="${(i*13+3)%200}" r="${0.4+i%3*0.4}" fill="#b8a0f8" opacity="${0.04+i%7*0.02}"/>`).join('')}
      <ellipse cx="300" cy="100" rx="260" ry="80" fill="#0d0520" opacity="0.6"/>
      ${Array.from({length:14},(_,i)=>`<ellipse cx="${(i*83+20)%600}" cy="${(i*47+10)%200}" rx="${6+i%4*5}" ry="${3+i%3*3}" fill="#b8a0f8" opacity="${0.03+i%5*0.015}"/>`).join('')}
      ${Array.from({length:8},(_,i)=>`<line x1="${75+i*65}" y1="0" x2="${60+i*70}" y2="200" stroke="#7c6ad0" stroke-width="0.4" opacity="0.2"/>`).join('')}
    </svg>`,
    10: `<svg viewBox="0 0 600 200" xmlns="http://www.w3.org/2000/svg" class="cq-cin-scene-art">
      <rect width="600" height="200" fill="#080003"/>
      ${Array.from({length:50},(_,i)=>`<circle cx="${(i*29+11)%600}" cy="${(i*17+5)%200}" r="${0.5+i%3*0.5}" fill="#ff2d6b" opacity="${0.05+i%6*0.025}"/>`).join('')}
      <ellipse cx="300" cy="90" rx="240" ry="70" fill="#200010" opacity="0.7"/>
      <circle cx="300" cy="80" r="40" fill="#ff2d6b" opacity="0.04"/>
      <circle cx="300" cy="80" r="20" fill="#ff2d6b" opacity="0.06"/>
      ${Array.from({length:10},(_,i)=>`<line x1="${300}" y1="${80}" x2="${300+Math.cos(i*36*Math.PI/180)*220}" y2="${80+Math.sin(i*36*Math.PI/180)*110}" stroke="#ff2d6b" stroke-width="0.5" opacity="0.12"/>`).join('')}
    </svg>`,
  };
  return arts[chId] || arts[1];
}

function _cqParticles(chId) {
  const color = CONQUEST_CHAPTERS.find(c=>c.id===chId)?.accent || '#ffffff';
  const wrap = document.getElementById('cq-particles');
  if (!wrap) return;
  wrap.innerHTML = '';
  for (let i = 0; i < 18; i++) {
    const p = document.createElement('div');
    p.className = 'cq-particle';
    p.style.cssText = `left:${Math.random()*100}%;top:${Math.random()*100}%;background:${color};animation-delay:${Math.random()*4}s;animation-duration:${3+Math.random()*4}s;width:${1+Math.random()*3}px;height:${1+Math.random()*3}px;opacity:${0.1+Math.random()*0.3}`;
    wrap.appendChild(p);
  }
}

function _cqPanelArt(chId, stId, panelIdx) {
  const ch = CONQUEST_CHAPTERS.find(c => c.id === chId);
  const panel = ch?.stages.find(s => s.id === stId)?.panels?.[panelIdx];
  const mood = panel?.mood || 'dark';
  const PAL = {
    1: ['#3ecf5a','#1a7a2a','#0d3a10','#030d02'],
    2: ['#b060ff','#6a2aaa','#2a0a50','#080212'],
    3: ['#3a9de0','#1a5a9a','#031428','#010610'],
    4: ['#ff8c30','#cc3300','#500800','#100200'],
    5: ['#90d0ff','#3a7acc','#041830','#010810'],
    6: ['#8878ff','#5040cc','#0e0a30','#020210'],
    7: ['#c0b4ff','#8070ee','#14123a','#020104'],
    8: ['#ff5570','#cc0030','#300010','#080000'],
    9: ['#d4bcff','#9070e0','#1e0840','#050310'],
    10:['#ff3878','#cc0048','#320012','#090002'],
  };
  const [accent, mid, deep, bg] = PAL[chId] || PAL[1];
  const seed = chId * 17 + stId * 7 + panelIdx * 3;
  const isBoss = mood === 'boss';

  // Visible atmospheric particles
  const pCount = isBoss ? 35 : 22;
  const particles = Array.from({length: pCount}, (_, i) => {
    const x = (i * 43 + seed * 13) % 480;
    const y = (i * 29 + seed * 7) % 160;
    const r = 1 + (i % 3);
    const op = (0.15 + (i % 5) * 0.07).toFixed(2);
    return `<circle cx="${x}" cy="${y}" r="${r}" fill="${accent}" opacity="${op}"/>`;
  }).join('');

  let scene = '';
  switch (chId) {
    case 1: { // Forest trees + spreading void roots
      const tCount = 8 + stId * 2;
      const trees = Array.from({length: tCount}, (_, i) => {
        const x = 20 + i * Math.floor(440 / tCount);
        const h = 40 + (i % 5) * 20 + stId * 8;
        const corrupt = stId >= 3 || isBoss;
        return `<rect x="${x-4}" y="${120-h}" width="8" height="${h}" fill="${corrupt?mid:accent}" opacity="${0.5+i%3*0.15}" rx="2"/>
          <ellipse cx="${x}" cy="${120-h}" rx="${10+i%3*4}" ry="${8+i%4*3}" fill="${corrupt?mid:accent}" opacity="${0.4+i%4*0.1}"/>`;
      }).join('');
      const roots = stId >= 2 ? Array.from({length: 6 + panelIdx * 2}, (_, i) =>
        `<path d="M${90+i*50},122 Q${115+i*45},${90+i*3} ${75+i*60},${65+stId*6}" stroke="${mid}" stroke-width="${2+i%2}" fill="none" opacity="${0.55+i*0.04}"/>`
      ).join('') : '';
      const glass = isBoss ? `<ellipse cx="240" cy="120" rx="200" ry="12" fill="${deep}" opacity="0.95"/>` : '';
      scene = trees + roots + glass;
      break;
    }
    case 2: { // Shadow wolves + tendrils
      const wolves = Array.from({length: Math.min(stId + panelIdx + 1, 4)}, (_, i) => {
        const x = 60 + i * 110; const y = 90 + (i%2)*12; const s = 0.85 + i*0.1;
        return `<ellipse cx="${x}" cy="${y}" rx="${26*s}" ry="${15*s}" fill="${mid}" opacity="0.85"/>
          <ellipse cx="${x-10*s}" cy="${y-10*s}" rx="${9*s}" ry="${6*s}" fill="${mid}" opacity="0.75"/>
          <circle cx="${x-15*s}" cy="${y-12*s}" r="${3.5*s}" fill="${accent}" opacity="0.9"/>`;
      }).join('');
      const tendrils = Array.from({length: 6 + stId * 2}, (_, i) =>
        `<path d="M${(i*73+20)%480},160 Q${(i*41+30)%480},${110-i*6} ${(i*57+10)%480},${70-stId*7}" stroke="${mid}" stroke-width="${2+i%3}" fill="none" opacity="${0.45+i%4*0.08}"/>`
      ).join('');
      scene = tendrils + wolves;
      break;
    }
    case 3: { // Lake waves + dragon
      const waves = Array.from({length: 6}, (_, i) =>
        `<path d="M${i*80},${85+stId*4} Q${i*80+40},${72+stId*4} ${i*80+80},${85+stId*4}" stroke="${accent}" stroke-width="2.5" fill="none" opacity="${0.45+i%3*0.1}"/>`
      ).join('');
      const depth = `<ellipse cx="240" cy="${115+stId*4}" rx="220" ry="${32+stId*8}" fill="${mid}" opacity="0.45"/>`;
      const dragon = stId >= 3
        ? `<path d="M30,115 Q130,${50-panelIdx*10} 210,${35+stId*3} Q295,${60+stId*2} 380,${82+stId} Q435,92 480,98" stroke="${accent}" stroke-width="${4+panelIdx}" fill="none" opacity="0.7"/>
           <circle cx="210" cy="${35+stId*3}" r="${12+panelIdx*5}" fill="${accent}" opacity="0.55"/>`
        : `<ellipse cx="${180+panelIdx*50}" cy="${48+stId*10}" rx="${22+stId*7}" ry="${14+stId*5}" fill="${mid}" opacity="0.45"/>`;
      scene = waves + depth + dragon;
      break;
    }
    case 4: { // Citadel towers + flame
      const towers = Array.from({length: 5}, (_, i) =>
        `<rect x="${40+i*90}" y="${15+i%2*18}" width="20" height="${82-i%2*10}" fill="${isBoss?deep:mid}" opacity="0.85" rx="1"/>
         <rect x="${45+i*90}" y="${11+i%2*18}" width="10" height="11" fill="${isBoss?'#111':accent}" opacity="${stId<3?0.7:0.2}" rx="1"/>`
      ).join('');
      const ash = Array.from({length: 14 + stId * 4}, (_, i) =>
        `<circle cx="${(i*53+seed*9)%480}" cy="${(i*19+seed*5)%140+10}" r="${1.5+i%3}" fill="${accent}" opacity="${0.2+i%5*0.06}"/>`
      ).join('');
      const flames = stId >= 2 ? Array.from({length: 6 + panelIdx * 2}, (_, i) =>
        `<path d="M${165+i*28},130 Q${175+i*26},${88-stId*7+i*5} ${185+i*20},${62-stId*5}" stroke="${accent}" stroke-width="${2.5+i%2}" fill="none" opacity="${0.5+i%3*0.1}"/>`
      ).join('') : '';
      scene = towers + ash + flames;
      break;
    }
    case 5: { // Ice spikes + throne
      const spikes = Array.from({length: 10 + stId * 2}, (_, i) => {
        const x = 24 + i * 42 + (i%3-1) * 8;
        const h = 30 + (i%5) * 20 + stId * 7;
        return `<polygon points="${x},160 ${x-9},${160-h} ${x+9},${160-h}" fill="${accent}" opacity="${0.35+i%4*0.1}"/>`;
      }).join('');
      const throne = stId >= 3
        ? `<rect x="198" y="55" width="84" height="68" fill="${mid}" opacity="0.7" rx="4"/>
           <rect x="210" y="36" width="60" height="28" fill="${mid}" opacity="0.6" rx="3"/>
           <circle cx="240" cy="50" r="${10+panelIdx*5}" fill="${accent}" opacity="${0.5+panelIdx*0.12}"/>`
        : '';
      const gridLines = Array.from({length: 6}, (_, i) =>
        `<line x1="${i*80}" y1="0" x2="${i*80+30}" y2="160" stroke="${accent}" stroke-width="0.8" opacity="0.2"/>`
      ).join('');
      scene = gridLines + spikes + throne;
      break;
    }
    case 6: { // Star field + dimensional crack
      const stars = Array.from({length: 50 + stId * 8}, (_, i) =>
        `<circle cx="${(i*37+seed*11)%480}" cy="${(i*23+seed*7)%160}" r="${0.8+i%4*0.6}" fill="${accent}" opacity="${0.3+i%6*0.1}"/>`
      ).join('');
      const riftX = 228 + panelIdx * 8;
      const crack = `<line x1="${riftX}" y1="0" x2="${riftX+12}" y2="160" stroke="${accent}" stroke-width="${2+stId*0.5}" opacity="${0.6+stId*0.1}"/>
        <line x1="${riftX+16}" y1="0" x2="${riftX+5}" y2="160" stroke="${mid}" stroke-width="${1+stId*0.3}" opacity="${0.45+stId*0.08}"/>`;
      const portal = stId >= 3
        ? `<ellipse cx="240" cy="80" rx="${32+panelIdx*16}" ry="${20+panelIdx*10}" fill="none" stroke="${accent}" stroke-width="2.5" opacity="0.65"/>
           <ellipse cx="240" cy="80" rx="${16+panelIdx*8}" ry="${10+panelIdx*5}" fill="${deep}" opacity="0.7"/>`
        : '';
      scene = stars + crack + portal;
      break;
    }
    case 7: { // Void crystals + spire
      const crystals = Array.from({length: 8 + stId * 2}, (_, i) => {
        const x = (i*71+seed*11) % 460 + 10;
        const y = (i*41+seed*9) % 110 + 20;
        const s = 6 + i%4*6;
        return `<polygon points="${x},${y-s} ${x+s},${y+s} ${x},${y+s*0.5} ${x-s},${y+s}" fill="${mid}" opacity="${0.45+i%3*0.12}"/>`;
      }).join('');
      const spireH = 100 + stId * 14;
      const spire = `<rect x="224" y="${18-stId*4}" width="32" height="${spireH}" fill="${deep}" opacity="0.9" rx="2"/>
        <polygon points="228,${18-stId*4} 240,${2-stId*3} 252,${18-stId*4}" fill="${accent}" opacity="${0.6+panelIdx*0.12}"/>`;
      const geoLines = Array.from({length: 6}, (_, i) =>
        `<line x1="${85+i*62}" y1="${32+i*10}" x2="${125+i*54}" y2="${100+i*7}" stroke="${accent}" stroke-width="1" opacity="0.35"/>`
      ).join('');
      scene = crystals + geoLines + spire;
      break;
    }
    case 8: { // Scattered cards fading into void
      const cardCount = Math.min(4 + panelIdx * 2 + stId, 12);
      const cards = Array.from({length: cardCount}, (_, i) => {
        const x = 40 + i * 38 + (i%3-1)*14;
        const y = 40 + (i%3)*20;
        const rot = (i%5-2)*8;
        const op = isBoss ? 0.7 : 0.35+i*0.05;
        return `<rect x="${x}" y="${y}" width="32" height="48" fill="${mid}" opacity="${op}" rx="3" transform="rotate(${rot},${x+16},${y+24})"/>
          <rect x="${x+3}" y="${y+3}" width="26" height="42" fill="${bg}" opacity="${op*0.6}" rx="2" transform="rotate(${rot},${x+16},${y+24})"/>`;
      }).join('');
      const pool = `<ellipse cx="240" cy="145" rx="${120+stId*20}" ry="${20+stId*5}" fill="${deep}" opacity="${0.7+panelIdx*0.1}"/>`;
      scene = cards + pool;
      break;
    }
    case 9: { // Spirit wisps + gate
      const wisps = Array.from({length: 12 + stId * 3}, (_, i) => {
        const x = (i*67+seed*13) % 460 + 10;
        const y = (i*33+seed*9) % 130 + 10;
        return `<ellipse cx="${x}" cy="${y}" rx="${9+i%5*5}" ry="${5+i%4*4}" fill="${accent}" opacity="${0.2+i%5*0.08}"/>
          <circle cx="${x}" cy="${y}" r="${2+i%3}" fill="${accent}" opacity="${0.3+i%4*0.08}"/>`;
      }).join('');
      const gate = stId >= 3
        ? `<rect x="190" y="25" width="100" height="115" fill="none" stroke="${accent}" stroke-width="2.5" opacity="${0.6+panelIdx*0.12}" rx="4"/>
           <rect x="204" y="25" width="72" height="115" fill="${deep}" opacity="${0.55+panelIdx*0.1}" rx="3"/>
           <circle cx="240" cy="78" r="${16+panelIdx*9}" fill="${accent}" opacity="${0.2+panelIdx*0.08}"/>`
        : `<circle cx="240" cy="${60+stId*9}" r="${22+stId*10+panelIdx*6}" fill="${mid}" opacity="0.28"/>`;
      const veilLines = Array.from({length: 5}, (_, i) =>
        `<line x1="${70+i*85}" y1="0" x2="${65+i*87}" y2="160" stroke="${accent}" stroke-width="0.7" opacity="0.2"/>`
      ).join('');
      scene = veilLines + wisps + gate;
      break;
    }
    case 10: { // City walls + god's descending beam + agents
      const walls = Array.from({length: 7}, (_, i) =>
        `<rect x="${i*70}" y="${75+i%2*14}" width="64" height="${50+i%3*10}" fill="${deep}" opacity="0.85" rx="1"/>
         <rect x="${i*70+4}" y="${71+i%2*14}" width="56" height="11" fill="${mid}" opacity="0.6"/>`
      ).join('');
      const beamX = 240 + panelIdx * 8;
      const beam = `<line x1="${beamX}" y1="0" x2="${beamX+panelIdx*6}" y2="160" stroke="${accent}" stroke-width="${3+panelIdx}" opacity="${0.5+stId*0.08}"/>
        <ellipse cx="${beamX+panelIdx*3}" cy="${32+stId*8}" rx="${22+panelIdx*16}" ry="${14+panelIdx*10}" fill="${accent}" opacity="${0.25+panelIdx*0.08}"/>`;
      const agents = stId >= 2 ? Array.from({length: Math.min(stId*2+panelIdx+1, 7)}, (_, i) => {
        const x = 55 + i * 58;
        return `<ellipse cx="${x}" cy="98" rx="8" ry="20" fill="${mid}" opacity="${0.6+i*0.04}"/>
          <circle cx="${x}" cy="73" r="7" fill="${deep}" opacity="0.85"/>
          <circle cx="${x-2}" cy="71" r="2.5" fill="${accent}" opacity="0.9"/>`;
      }).join('') : '';
      scene = walls + beam + agents;
      break;
    }
  }

  const bottomFade = `<rect x="0" y="100" width="480" height="60" fill="${bg}" opacity="0.6"/>`;
  return `<svg viewBox="0 0 480 160" xmlns="http://www.w3.org/2000/svg" class="cq-panel-art-svg">
    <rect width="480" height="160" fill="${bg}"/>
    ${particles}
    ${scene}
    ${bottomFade}
  </svg>`;
}

function conquestIntro(chapterId, stageId, replay = false) {
  const ch = CONQUEST_CHAPTERS.find(c => c.id === chapterId);
  const st = ch?.stages.find(s => s.id === stageId);
  if (!ch || !st) return;
  const panels = st.panels || [{ title: st.name, text: st.lore || '' }];

  // Remove any existing cinematic
  const old = document.getElementById('cq-cinematic');
  if (old) old.remove();

  const el = document.createElement('div');
  el.id = 'cq-cinematic';
  el.className = 'cq-cinematic' + (st.isBoss ? ' cq-boss-cinematic' : '');
  el.innerHTML = `
    <div class="cq-cin-bg" style="--ch-color:${ch.color};--ch-accent:${ch.accent}">
      ${_cqSceneArt(ch.id, st.isBoss)}
      <div class="cq-cin-particles" id="cq-particles"></div>
      <div class="cq-cin-vignette"></div>
      ${st.isBoss ? '<div class="cq-boss-glow"></div>' : ''}
      <div class="cq-cin-header">
        <div class="cq-cin-chapter-tag">CHAPTER ${ch.id} · ${ch.name.toUpperCase()}</div>
        <div class="cq-cin-stage-label">${st.isBoss ? '💀 BOSS BATTLE' : `Stage ${st.id}`}</div>
      </div>
      <div class="cq-cin-panel-art" id="cq-panel-art"></div>
      <div class="cq-cin-content">
        <div class="cq-cin-panel-title" id="cq-panel-title"></div>
        <div class="cq-cin-panel-text" id="cq-panel-text"></div>
      </div>
      <div class="cq-cin-footer">
        <div class="cq-cin-dots" id="cq-panel-dots"></div>
        <div class="cq-cin-btns">
          <button class="btn btn-sm cq-skip-btn" onclick="cqSkip()">Skip</button>
          <button class="btn btn-primary cq-next-btn" id="cq-next-btn" onclick="cqNext()" disabled>▶ Next</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(el);

  window._cqCin = { ch, st, panels, idx: 0, chapterId, stageId, replay, typing: false, typeTimer: null };

  // Set up voiceover audio if this stage has one
  if (window._cqAudio) { window._cqAudio.pause(); window._cqAudio = null; }
  window._cqVoTimings = null;
  window._cqAudioHandler = null;
  if (st.voiceover) {
    const audio = new Audio(st.voiceover);
    audio.preload = 'auto';
    window._cqAudio = audio;
    const totalDur = st.voiceoverDuration;
    const wordCounts = panels.map(p => p.text.split(/\s+/).filter(Boolean).length);
    const totalWords = wordCounts.reduce((a, b) => a + b, 0);
    let panelStarts = [], t = 0;
    for (let i = 0; i < panels.length; i++) { panelStarts.push(t); t += (wordCounts[i] / totalWords) * totalDur; }
    window._cqVoTimings = panels.map((p, pi) => {
      const words = p.text.split(/\s+/).filter(Boolean);
      const dur = (wordCounts[pi] / totalWords) * totalDur;
      return words.map((_, wi) => panelStarts[pi] + (wi / words.length) * dur);
    });
  }

  _cqParticles(ch.id);
  requestAnimationFrame(() => { el.classList.add('cq-cin-visible'); setTimeout(() => _cqStartPanel(0), 500); });
}
window.conquestIntro = conquestIntro;

function _cqBestVoice() {
  const vs = speechSynthesis.getVoices();
  if (!vs.length) return null;
  // Priority: known high-quality natural voices first
  return (
    vs.find(v => v.name === 'Samantha (Enhanced)') ||
    vs.find(v => v.name === 'Daniel (Enhanced)') ||
    vs.find(v => v.name === 'Alex') ||
    vs.find(v => /microsoft.*guy.*online/i.test(v.name)) ||
    vs.find(v => /microsoft.*aria.*online/i.test(v.name)) ||
    vs.find(v => /google uk english male/i.test(v.name)) ||
    vs.find(v => /google us english/i.test(v.name)) ||
    vs.find(v => v.lang === 'en-GB' && v.localService) ||
    vs.find(v => v.lang.startsWith('en') && !/zira|female|junior/i.test(v.name)) ||
    vs[0]
  );
}

function _cqStartPanel(idx) {
  const s = window._cqCin;
  if (!s) return;
  if (s.typeTimer) clearTimeout(s.typeTimer);
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  s.idx = idx;
  s.typing = true;
  const panel = s.panels[idx];
  const text = panel.text;
  const titleEl = document.getElementById('cq-panel-title');
  const textEl  = document.getElementById('cq-panel-text');
  const nextBtn = document.getElementById('cq-next-btn');
  const dotsEl  = document.getElementById('cq-panel-dots');
  if (titleEl) { titleEl.textContent = ''; titleEl.classList.remove('cq-title-in'); void titleEl.offsetWidth; titleEl.textContent = panel.title; titleEl.classList.add('cq-title-in'); }
  if (textEl)  { textEl.textContent = ''; textEl.classList.remove('cq-text-in'); void textEl.offsetWidth; textEl.classList.add('cq-text-in'); }
  const artEl = document.getElementById('cq-panel-art');
  if (artEl) artEl.innerHTML = _cqPanelArt(s.ch.id, s.st.id, idx);
  if (nextBtn) { nextBtn.disabled = true; nextBtn.textContent = '▶ Next'; nextBtn.className = 'btn btn-primary cq-next-btn'; }
  if (dotsEl)  dotsEl.innerHTML = s.panels.map((_,i) => `<div class="cq-dot${i===idx?' cq-dot-active':''}"></div>`).join('');

  function _enableNext() {
    if (!window._cqCin || window._cqCin.idx !== idx) return;
    if (textEl) textEl.textContent = text;
    s.typing = false;
    if (nextBtn) {
      nextBtn.disabled = false;
      if (idx === s.panels.length - 1) {
        nextBtn.textContent = s.st.isBoss ? '⚔️ FACE THE BOSS' : '⚔️ ENTER BATTLE';
        nextBtn.className = 'btn btn-red btn-lg cq-next-btn cq-enter-btn';
      }
    }
  }

  // ── VOICEOVER MODE ────────────────────────────────────────────────
  if (window._cqAudio && window._cqVoTimings) {
    const timings = window._cqVoTimings[idx];
    const words = text.split(/\s+/).filter(Boolean);
    // Remove previous timeupdate listener
    if (window._cqAudioHandler) window._cqAudio.removeEventListener('timeupdate', window._cqAudioHandler);
    window._cqAudioHandler = () => {
      if (!window._cqCin || window._cqCin.idx !== idx) return;
      const t = window._cqAudio.currentTime;
      let visible = 0;
      for (let i = 0; i < timings.length; i++) { if (t >= timings[i]) visible = i + 1; else break; }
      if (textEl) textEl.textContent = words.slice(0, visible).join(' ');
      if (visible >= words.length && s.typing) _enableNext();
    };
    window._cqAudio.addEventListener('timeupdate', window._cqAudioHandler);
    // Start playing on first panel; subsequent panels audio is already running
    if (idx === 0 && window._cqAudio.paused) {
      window._cqAudio.play().catch(err => console.warn('[Voiceover] play() failed:', err));
    }
    return;
  }

  if (!window.speechSynthesis) {
    // No TTS: plain word-by-word reveal
    const words = text.split(' ');
    let wi = 0;
    function revealWord() {
      if (!window._cqCin || window._cqCin.idx !== idx || !s.typing) return;
      if (wi < words.length) { if (textEl) textEl.textContent = words.slice(0, ++wi).join(' '); s.typeTimer = setTimeout(revealWord, 380); }
      else _enableNext();
    }
    s.typeTimer = setTimeout(revealWord, 120);
    return;
  }

  const utt = new SpeechSynthesisUtterance(text);
  utt.rate  = 0.90;   // Slightly slower than normal — natural, not robotic
  utt.pitch = 1.0;    // Normal pitch — lowering it makes it sound MORE robotic
  utt.volume = 1.0;

  let boundaryFired = false;

  // onboundary: each spoken word fires this with charIndex = position in text
  utt.onboundary = (e) => {
    if (e.name !== 'word' || !window._cqCin || window._cqCin.idx !== idx) return;
    boundaryFired = true;
    const pos = Math.min(e.charIndex + (e.charLength || 1), text.length);
    if (textEl) textEl.textContent = text.substring(0, pos);
  };

  utt.onend = () => _enableNext();

  // Fallback word-by-word if onboundary never fires (Firefox / some mobile)
  // Runs at speech rate: ~150 WPM * 0.90 rate ≈ 400ms per word
  const words = text.split(' ');
  let wi = 0;
  function revealWordFallback() {
    if (boundaryFired || !window._cqCin || window._cqCin.idx !== idx || !s.typing) return;
    if (wi < words.length) { if (textEl) textEl.textContent = words.slice(0, ++wi).join(' '); s.typeTimer = setTimeout(revealWordFallback, 400); }
  }
  // Delay slightly so speech starts and onboundary can fire first
  s.typeTimer = setTimeout(revealWordFallback, 180);

  const startSpeak = () => {
    const v = _cqBestVoice();
    if (v) utt.voice = v;
    window.speechSynthesis.speak(utt);
  };
  if (speechSynthesis.getVoices().length) startSpeak();
  else speechSynthesis.addEventListener('voiceschanged', startSpeak, { once: true });
}

window.cqNext = () => {
  const s = window._cqCin;
  if (!s) return;
  if (s.typing) {
    // Skip to end of current panel — if voiceover, seek audio to next panel boundary
    if (s.typeTimer) clearTimeout(s.typeTimer);
    if (window._cqAudio && window._cqVoTimings) {
      const nextPanelTimings = window._cqVoTimings[s.idx + 1];
      if (nextPanelTimings) window._cqAudio.currentTime = nextPanelTimings[0];
    }
    s.typing = false;
    const textEl = document.getElementById('cq-panel-text');
    const nextBtn = document.getElementById('cq-next-btn');
    if (textEl) textEl.textContent = s.panels[s.idx].text;
    if (nextBtn) {
      nextBtn.disabled = false;
      if (s.idx === s.panels.length - 1) {
        nextBtn.textContent = s.st.isBoss ? '⚔️ FACE THE BOSS' : '⚔️ ENTER BATTLE';
        nextBtn.className = 'btn btn-red btn-lg cq-next-btn cq-enter-btn';
      }
    }
    return;
  }
  if (s.idx < s.panels.length - 1) {
    _cqStartPanel(s.idx + 1);
  } else {
    const el = document.getElementById('cq-cinematic');
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    _cqStopVoiceover();
    if (el) { el.classList.add('cq-cin-exit'); setTimeout(() => { el.remove(); conquestStartBattle(s.chapterId, s.stageId, s.replay); }, 600); }
    else conquestStartBattle(s.chapterId, s.stageId, s.replay);
  }
};

function _cqStopVoiceover() {
  if (window._cqAudio) {
    if (window._cqAudioHandler) window._cqAudio.removeEventListener('timeupdate', window._cqAudioHandler);
    window._cqAudio.pause();
    window._cqAudio.currentTime = 0;
    window._cqAudio = null;
  }
  window._cqAudioHandler = null;
  window._cqVoTimings = null;
}

window.cqSkip = () => {
  const s = window._cqCin;
  const el = document.getElementById('cq-cinematic');
  if (s?.typeTimer) clearTimeout(s.typeTimer);
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  _cqStopVoiceover();
  window._cqCin = null;
  if (el) { el.classList.add('cq-cin-exit'); setTimeout(() => { el.remove(); if (s) conquestStartBattle(s.chapterId, s.stageId, s.replay); }, 400); }
  else if (s) conquestStartBattle(s.chapterId, s.stageId, s.replay);
};

async function conquestStartBattle(chapterId, stageId, replay = false) {
  const ch = CONQUEST_CHAPTERS.find(c => c.id === chapterId);
  const st = ch?.stages.find(s => s.id === stageId);
  closeModal();
  S.conquestCtx = { chapterId, stageId, stageName: st?.name, reward: st?.reward, chapterName: ch?.name, replay };
  const page = document.getElementById('page');
  if (page) page.innerHTML = `<div class="page-title"><h2>Conquest Battle</h2></div><div class="spinner"></div>`;
  try {
    const data = await api('/conquest/start', 'POST', { chapterId, stageId, replay });
    S.battle = data;
    nav('conquest_battle');
    startConquestBattlePolling();
  } catch (e) {
    notify(e.message, 'error');
    S.conquestCtx = null;
    nav('conquest');
  }
}
window.conquestStartBattle = conquestStartBattle;

function viewConquestBattle() {
  const ctx = S.conquestCtx;
  if (!S.battle) { nav('conquest'); return ''; }
  if (S.battle.finished) {
    const r = S.battle.ratingResult;
    const won = S.battle.winner === 'player';
    return `<div class="page-title"><h2>Conquest</h2></div>
    <div class="cq-result ${won ? 'cq-result-win' : 'cq-result-loss'}">
      <div class="cq-result-icon">${won ? '⚔️' : '💀'}</div>
      <h2>${won ? 'Victory!' : 'Defeated'}</h2>
      <p class="cq-result-stage">${ctx ? `${ctx.chapterName} &bull; ${ctx.stageName}` : ''}</p>
      ${won && r?.coinsEarned ? `<p class="cq-result-reward">+${r.coinsEarned} coins earned</p>` : ''}
      ${won && ctx?.replay ? `<p class="text-muted" style="font-size:0.85rem;margin-top:0.3rem">Replay — no rewards granted</p>` : ''}
      ${won && r?.bossCardUnlocked ? `<p class="cq-result-reward" style="color:#f5c518">🃏 Boss Card Unlocked: ${r.bossCardUnlocked}</p>` : ''}
      ${won && r?.traitDropped ? `<p class="cq-result-reward" style="color:#8b3fc8">✨ Trait Dropped: <strong>${r.traitDropped.name}</strong> (${r.traitDropped.rarity})</p>` : ''}
      ${won && ctx?.reward && !ctx?.replay ? `<p class="cq-result-lore">${ctx.reward}</p>` : ''}
      ${!won ? `<p class="text-muted" style="margin-top:0.5rem">Your forces were overwhelmed. Regroup and try again.</p>` : ''}
      <div style="display:flex;gap:1rem;justify-content:center;margin-top:1.5rem">
        ${won ? `<button class="btn btn-primary" onclick="nav('conquest')">Continue</button>` : `<button class="btn btn-primary" onclick="conquestRetry()">Try Again</button>`}
        <button class="btn" onclick="nav('conquest')">Return to Conquest</button>
      </div>
    </div>`;
  }
  // Active conquest battle — v2 layout
  const b = S.battle;
  const pa = b.playerCards[b.playerActive];
  const aa = b.aiCards[b.aiActive];
  const pBench = b.playerCards.map((c,i) => ({c,i})).filter(({i}) => i !== b.playerActive);
  const canSwitch = pBench.some(({c}) => c.current_hp > 0);
  const aiRemain = b.aiCards.filter(c=>c.current_hp>0).length;
  const pRemain  = b.playerCards.filter(c=>c.current_hp>0).length;
  const orbCostPa = clientOrbCost(pa);
  const hasOrbsForAbility = (pa.orbs||0) >= orbCostPa;
  const hasOrbsForBoost = (pa.orbs||0) >= 1;
  const hasOrbsForHeal = (pa.orbs||0) >= 2;
  const healMax = b.playerHealMax || 2;
  const healExhausted = (b.playerHealUses||0) >= healMax;
  const combo = b.playerCombo || 0;

  const log = b.log.slice(-10).map(l => {
    const cls = l.startsWith('You') ? 'log-player' : l.startsWith('Foe') ? 'log-ai' : l.startsWith('⏱️') ? 'log-timeout' : 'log-system';
    return `<div class="${cls}">${l}</div>`;
  }).join('');

  const paTc = typeColor(pa.type);
  const aaTc = typeColor(aa.type);
  const paPct = Math.round((pa.current_hp / pa.hp) * 100);
  const aaPct = Math.round((aa.current_hp / aa.hp) * 100);
  const paHc = paPct > 50 ? '#2ecc71' : paPct > 25 ? '#f39c12' : '#e74c3c';
  const aaHc = aaPct > 50 ? '#2ecc71' : aaPct > 25 ? '#f39c12' : '#e74c3c';

  return `
  <div class="conquest-battle-header">
    <span class="conquest-battle-chapter">${ctx ? `${ctx.chapterName} &bull; ${ctx.stageName}` : 'Conquest'}</span>
  </div>
  <div class="battle-arena-v2${b.playerTurn ? ' player-turn-v2' : ''}">

    <!-- Timer -->
    ${_battleTimerHtml(b)}

    <!-- Enemy party row -->
    <div class="battle-party-row battle-party-ai">
      <span class="party-label">Enemy Forces <span style="color:#e74c3c;font-weight:700">${aiRemain}/${b.aiCards.length}</span></span>
      <div class="party-cards-row">${_battleCardRow(b.aiCards, b.aiActive, false)}</div>
    </div>

    <!-- Main field -->
    <div class="battle-field-v2">

      <!-- Foe active -->
      <div class="battle-active-v2 foe-active-v2${aa?.isBossCard ? ' boss-active-v2' : ''}" id="foe-active-slot">
        <div class="bav2-info">
          <span class="bav2-name">${aa.name}</span>
          <span class="bav2-type" style="background:${aaTc}">${aa.type}</span>
          ${b.bossSurgeActive ? `<span class="surge-badge">⚠️ ENRAGED</span>` : ''}
        </div>
        <div class="bav2-hp-row">
          <div class="bav2-hp-bar-wrap"><div class="bav2-hp-bar" style="width:${aaPct}%;background:${aaHc}"></div></div>
          <span class="bav2-hp-text">${aa.current_hp}/${aa.hp}</span>
        </div>
        <div class="bav2-card-wrap">${renderCard(aa)}</div>
      </div>

      <!-- VS divider -->
      <div class="battle-vs-v2">
        <div class="vs-orb">${b.playerTurn ? 'YOUR<br>TURN' : 'FOE<br>TURN'}</div>
        ${combo >= 2 ? `<div class="combo-badge-v2${combo>=3?' combo-max-v2':''}">${combo>=3?'🔥 x3 COMBO':'⚡ x'+combo}</div>` : ''}
        ${b.playerBoosted ? `<div class="boost-badge-v2">⚡ BOOSTED</div>` : ''}
      </div>

      <!-- Player active -->
      <div class="battle-active-v2 player-active-v2${b.playerVoidMode && pa.trait?.special_type==='void' ? ' void-aura' : ''}" id="player-active-slot">
        ${_coachHtml(b)}
        <div class="bav2-info">
          <span class="bav2-name">${pa.name}</span>
          <span class="bav2-type" style="background:${paTc}">${pa.type}</span>
          <span class="bav2-orbs-badge">${pa.orbs||0} ⚡</span>
          ${pa.trait ? `<span class="trait-badge trait-${(pa.trait.rarity||'common').toLowerCase()}">${pa.trait.name}</span>` : ''}
          ${b.playerVoidMode ? `<span class="void-mode-badge">🌑 VOID ${b.playerVoidTurns}t / ${b.playerVoidStored} stored</span>` : ''}
        </div>
        <div class="bav2-hp-row">
          <div class="bav2-hp-bar-wrap"><div class="bav2-hp-bar" style="width:${paPct}%;background:${paHc}"></div></div>
          <span class="bav2-hp-text">${pa.current_hp}/${pa.hp}</span>
        </div>
        <div class="bav2-card-wrap">${renderCard(pa)}</div>
      </div>
    </div>

    <!-- Player party row -->
    <div class="battle-party-row battle-party-player">
      <span class="party-label">Your Party <span style="color:#2ecc71;font-weight:700">${pRemain}/${b.playerCards.length}</span></span>
      <div class="party-cards-row">${_battleCardRow(b.playerCards, b.playerActive, true)}</div>
    </div>

    <!-- Action dock -->
    <div class="battle-dock">
      ${b.playerTurn && !b.finished ? `
        <div class="battle-dock-energy">
          ${_attachEnergyHtml(b, pa, pBench, 'battleAttachEnergy')}
        </div>
        <div class="battle-dock-actions">
          <button class="btn-battle-action btn-ba-strike" onclick="battleAction('basic')" id="btn-basic" title="Quick Strike — deals ATK-based damage.">
            <span class="bba-icon">⚡</span>
            <span class="bba-label">Quick Strike</span>
            <span class="bba-desc">ATK damage</span>
          </button>
          <button class="btn-battle-action btn-ba-ability${hasOrbsForAbility?'':' bba-disabled'}" onclick="battleAction('ability')" id="btn-ability" ${hasOrbsForAbility?'':'disabled'}
            title="${pa.ability_name} — ${orbCostPa} orbs required">
            <span class="bba-icon">✦</span>
            <span class="bba-label">${pa.ability_name}</span>
            <span class="bba-desc">${orbCostPa} orbs • type dmg</span>
          </button>
          <button class="btn-battle-action btn-ba-guard" onclick="battleAction('guard')" id="btn-guard" title="Guard — halve incoming damage this turn">
            <span class="bba-icon">🛡️</span>
            <span class="bba-label">Guard</span>
            <span class="bba-desc">Half damage</span>
          </button>
          <button class="btn-battle-action btn-ba-boost${hasOrbsForBoost?'':' bba-disabled'}" onclick="battleAction('boost')" ${hasOrbsForBoost?'':'disabled'}
            title="Boost — spend 1 orb for +30% damage next hit">
            <span class="bba-icon">🔥</span>
            <span class="bba-label">Boost</span>
            <span class="bba-desc">1 orb • +30% next hit</span>
          </button>
          <button class="btn-battle-action btn-ba-heal${(hasOrbsForHeal && !healExhausted)?'':' bba-disabled'}" onclick="battleAction('heal')" ${(hasOrbsForHeal && !healExhausted)?'':'disabled'}
            title="Heal — spend 2 orbs to restore 25% HP">
            <span class="bba-icon">💚</span>
            <span class="bba-label">Heal</span>
            <span class="bba-desc">2 orbs • 25% HP (${healMax-(b.playerHealUses||0)} left)</span>
          </button>
        </div>
        <div class="battle-dock-meta">
          ${canSwitch ? `<span class="dock-hint">Tap a bench card to switch</span>` : ''}
          <button class="btn-battle-forfeit" onclick="conquestForfeit()">Retreat</button>
        </div>
      ` : b.finished
        ? `<div style="text-align:center;padding:1rem"><button class="btn btn-primary btn-lg" onclick="nav('conquest')">Continue</button></div>`
        : `<div class="battle-ai-thinking"><span class="thinking-dots">Processing</span></div>`}
    </div>

    <!-- Battle log -->
    <div class="battle-log-v2" id="battle-log">${log}</div>
  </div>`;
}

window.conquestForfeit = () => { if (confirm('Retreat from this battle?')) battleAction('forfeit'); };
window.conquestRetry = () => {
  if (S.conquestCtx) {
    const { chapterId, stageId } = S.conquestCtx;
    conquestStartBattle(chapterId, stageId);
  } else {
    nav('conquest');
  }
};

function startConquestBattlePolling() {
  if (S._cqBattleInterval) { clearInterval(S._cqBattleInterval); S._cqBattleInterval = null; }
  S._cqBattleInterval = setInterval(async () => {
    if (S.view !== 'conquest_battle') { clearInterval(S._cqBattleInterval); S._cqBattleInterval = null; return; }
    if (S.battle?.finished) { clearInterval(S._cqBattleInterval); S._cqBattleInterval = null; return; }
    try {
      const data = await api('/battle/state');
      S.battle = data;
      const pg = document.getElementById('page');
      if (pg) { pg.innerHTML = viewConquestBattle(); attachListeners(); scrollBattleLog(); }
      if (data.finished) { clearInterval(S._cqBattleInterval); S._cqBattleInterval = null; }
    } catch {
      // 404 = battle completed and cleared — stop polling
      clearInterval(S._cqBattleInterval); S._cqBattleInterval = null;
    }
  }, 1000);
}

// ─── DECK BUILDER ─────────────────────────────────────────────────
function viewDeck() {
  const deck = S.deckCards;
  const slots = Array.from({length:5}, (_,i) => deck[i] || null);
  const deckSlots = slots.map((card,i) => card
    ? `<div class="deck-slot occupied">
        ${renderCard(card)}
        <button class="btn btn-sm btn-red deck-remove-btn" onclick="removeDeckSlot(${i})">Remove</button>
       </div>`
    : `<div class="deck-slot empty" onclick="openDeckPicker()">
        <div class="deck-slot-empty"><span class="deck-plus">+</span><span>Add Card</span></div>
       </div>`
  ).join('');

  const typeButtons = TYPES.map(t =>
    `<button class="btn btn-sm type-filter-btn" style="background:${typeColor(t)}22;border:1px solid ${typeColor(t)}66;color:${typeColor(t)}" onclick="autoBuildDeck('type','${t}')">${t}</button>`
  ).join('');

  return `<div class="page-title"><h2>Deck Builder</h2><p class="text-muted">Choose up to 5 cards for battle</p></div>
  <div class="deck-layout">
    <div>
      <div class="sketch-box">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
          <h3>Your Deck <span class="text-muted" style="font-size:0.85rem">${deck.length}/5</span></h3>
          <div style="display:flex;gap:0.5rem">
            <button class="btn btn-sm btn-primary" onclick="openDeckPicker()">+ Pick Cards</button>
            ${deck.length ? `<button class="btn btn-sm btn-red" onclick="clearDeck()">Clear</button>` : ''}
          </div>
        </div>
        <div class="deck-grid">${deckSlots}</div>
      </div>
    </div>
    <div>
      <div class="sketch-box mb-2">
        <h3 style="margin-bottom:0.75rem">Auto-Build</h3>
        <button class="btn btn-primary" style="width:100%;margin-bottom:0.75rem" onclick="autoBuildDeck('best')">⚡ Best Overall</button>
        <p class="text-muted mb-2" style="font-size:0.82rem">Build by type:</p>
        <div class="type-btn-grid">${typeButtons}</div>
      </div>
      <div class="sketch-box">
        <h3 style="margin-bottom:0.5rem">Ready to Battle?</h3>
        <p class="text-muted mb-2" style="font-size:0.85rem">${deck.length === 0 ? 'Build a deck first.' : deck.length < 5 ? `${5-deck.length} slot(s) open.` : 'Deck full — ready!'}</p>
        <div style="display:flex;gap:0.75rem;flex-wrap:wrap">
          <button class="btn btn-primary" onclick="nav('battle')" ${!deck.length?'disabled':''}>VS AI</button>
          <button class="btn btn-gold" onclick="nav('pvp')" ${!deck.length?'disabled':''}>Online PvP</button>
          <button class="btn" onclick="nav('conquest')" ${!deck.length?'disabled':''}>Conquest</button>
        </div>
      </div>
    </div>
  </div>`;
}

window.removeDeckSlot = async (idx) => {
  S.deckCards.splice(idx, 1);
  S.deck = S.deckCards.map(c => c.id);
  if (S.deck.length) {
    await api('/deck','PUT',{card_ids: S.deck}).catch(() => {});
  }
  document.getElementById('page').innerHTML = viewDeck();
  attachListeners();
};

window.clearDeck = async () => {
  if (!confirm('Clear your deck?')) return;
  S.deckCards = []; S.deck = [];
  document.getElementById('page').innerHTML = viewDeck();
  attachListeners();
};

window.openDeckPicker = () => {
  S._pickerDeckIds = new Set(S.deckCards.map(c => c.id));
  renderDeckPickerModal();
};

function renderDeckPickerModal() {
  const deckIds = S._pickerDeckIds || new Set();
  const typeFilter = S._pickerType || '';
  const search = S._pickerSearch || '';
  let cards = (S.collection || []).filter(c => c.quantity > 0);
  if (typeFilter) cards = cards.filter(c => c.type === typeFilter);
  if (search) cards = cards.filter(c => c.name.toLowerCase().includes(search.toLowerCase()));

  const typeOpts = ['', ...TYPES].map(t => `<option value="${t}" ${typeFilter===t?'selected':''}>${t||'All Types'}</option>`).join('');
  const grid = cards.slice(0,50).map(c => {
    const sel = deckIds.has(c.id);
    return `<div class="deck-pick-wrap${sel?' deck-pick-sel':''}" onclick="togglePickCard(${c.id})">
      ${renderCard(c)}
      ${sel ? `<div class="deck-pick-check">✓</div>` : ''}
    </div>`;
  }).join('') || '<p class="text-muted text-center" style="grid-column:1/-1">No cards found.</p>';

  openModal(`<div class="deck-picker-modal">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem;flex-wrap:wrap;gap:0.5rem">
      <h3>Pick Cards <span class="text-muted" style="font-size:0.85rem">${deckIds.size}/5</span></h3>
      <div style="display:flex;gap:0.5rem;flex-wrap:wrap">
        <input class="input-box" placeholder="Search..." style="max-width:160px" value="${search}" oninput="pickerSearch(this.value)">
        <select class="input-box" style="max-width:130px" onchange="pickerType(this.value)">${typeOpts}</select>
        <button class="btn btn-primary" onclick="saveDeckFromPicker()">Save</button>
        <button class="btn" onclick="closeModal()">Cancel</button>
      </div>
    </div>
    <div class="deck-picker-grid">${grid}</div>
  </div>`);
}

window.togglePickCard = (id) => {
  if (!S._pickerDeckIds) S._pickerDeckIds = new Set();
  if (S._pickerDeckIds.has(id)) { S._pickerDeckIds.delete(id); }
  else {
    if (S._pickerDeckIds.size >= 5) { notify('Deck is full (5 cards max)', 'error'); return; }
    S._pickerDeckIds.add(id);
  }
  renderDeckPickerModal();
};
window.pickerSearch = (v) => { S._pickerSearch = v; renderDeckPickerModal(); };
window.pickerType   = (v) => { S._pickerType = v; renderDeckPickerModal(); };

window.saveDeckFromPicker = async () => {
  const ids = [...(S._pickerDeckIds || [])];
  if (!ids.length) { notify('Select at least 1 card', 'error'); return; }
  try {
    await api('/deck','PUT',{card_ids: ids});
    const fresh = await api('/deck');
    S.deck = fresh.card_ids; S.deckCards = fresh.cards;
    S._pickerDeckIds = null; S._pickerSearch = ''; S._pickerType = '';
    closeModal();
    document.getElementById('page').innerHTML = viewDeck();
    attachListeners();
    notify('Deck saved!', 'success');
  } catch(e) { notify(e.message,'error'); }
};

window.autoBuildDeck = async (mode, type) => {
  try {
    const data = await api('/deck/auto','POST',{ mode, type });
    S.deck = data.card_ids; S.deckCards = data.cards;
    document.getElementById('page').innerHTML = viewDeck();
    attachListeners();
    notify(`Deck built: ${data.cards.map(c=>c.name).join(', ')}`, 'success');
  } catch(e) { notify(e.message,'error'); }
};

// ─── PVP ──────────────────────────────────────────────────────────
function viewPvp() {
  const noDeck = !S.deckCards.length;
  return `<div class="page-title"><h2>Online PvP</h2><p class="text-muted">Battle other players in real-time</p></div>
  <div style="max-width:520px;margin:0 auto">
    ${noDeck ? `<div class="sketch-box text-center">
      <p class="text-muted mb-2">You need a deck to play PvP.</p>
      <button class="btn btn-primary" onclick="nav('deck')">Build Deck</button>
    </div>` : `
    <div class="sketch-box text-center mb-2">
      <h3 style="margin-bottom:0.5rem">Find a Match</h3>
      <p class="text-muted mb-2" style="font-size:0.85rem">Deck: ${S.deckCards.map(c=>`<span style="color:${typeColor(c.type)}">${c.name}</span>`).join(', ')}</p>
      <div style="display:flex;gap:1rem;justify-content:center;flex-wrap:wrap;margin-top:1rem">
        <button class="btn btn-primary btn-lg" onclick="joinPvpQueue(true)">⚔️ Ranked Match</button>
        <button class="btn btn-lg" onclick="joinPvpQueue(false)">🎮 Casual Match</button>
      </div>
    </div>
    <div class="sketch-box">
      <h4 style="margin-bottom:0.5rem">How PvP Works</h4>
      <ul style="font-size:0.87rem;color:var(--text-muted);line-height:1.8;padding-left:1.2rem">
        <li>Your saved deck is used in every match</li>
        <li>30 seconds per turn — auto-attack on timeout</li>
        <li>Ranked matches affect your ELO rating</li>
        <li>Defeat all opponent creatures to win</li>
        <li>Ranked wins award <strong>50 coins</strong>, casual wins <strong>20 coins</strong></li>
      </ul>
    </div>`}
  </div>`;
}

function viewPvpQueue() {
  return `<div class="page-title"><h2>${S._pvpRanked ? 'Ranked' : 'Casual'} Queue</h2></div>
  <div class="pvp-queue-box text-center">
    <div class="pvp-spinner"></div>
    <h3 style="margin:1.25rem 0 0.4rem">Finding Opponent...</h3>
    <p class="text-muted" id="queue-time">0s elapsed</p>
    <p class="text-muted" style="font-size:0.82rem;margin-top:0.4rem">Playing with your saved deck</p>
    <button class="btn btn-red mt-2" onclick="leavePvpQueue()">Cancel</button>
  </div>`;
}

function viewPvpBattle() {
  const b = S.pvpBattle;
  if (!b) { nav('pvp'); return ''; }
  const opp = b.opponentUsername || 'Opponent';
  const modeLabel = b.ranked ? '⚔️ Ranked' : '🎮 Casual';

  if (b.finished) {
    const won = b.winner === 'player';
    const r = b.ratingResult;
    return `<div class="page-title"><h2>PvP Battle</h2><span class="text-muted" style="font-size:0.9rem">${modeLabel}</span></div>
    <div class="sketch-box text-center" style="max-width:520px;margin:0 auto;padding:2.5rem">
      <div style="font-size:4rem;margin-bottom:0.5rem">${won?'🏆':'💀'}</div>
      <h2 style="color:${won?'var(--gold)':'var(--red)'};margin-bottom:0.4rem;font-size:2rem">${won?'Victory!':'Defeated!'}</h2>
      <p class="text-muted" style="margin-bottom:0.4rem">vs <strong>${opp}</strong></p>
      ${r?.newRating ? `<p style="color:var(--gold);font-weight:700;font-size:1.1rem;margin-bottom:0.2rem">Rating: ${r.newRating} (${r.title})</p>` : ''}
      ${r?.coinsEarned ? `<p style="color:var(--gold);margin-bottom:1.2rem">+${r.coinsEarned} coins</p>` : '<div style="margin-bottom:1.2rem"></div>'}
      <div style="display:flex;gap:1rem;justify-content:center">
        <button class="btn btn-primary btn-lg" onclick="joinPvpQueue(${b.ranked})">⚔️ Play Again</button>
        <button class="btn" onclick="nav('pvp')">Back</button>
      </div>
    </div>`;
  }

  const pa  = b.playerCards[b.playerActive];
  const aa  = b.aiCards[b.aiActive];
  const pRemain  = b.playerCards.filter(c => c.current_hp > 0).length;
  const aiRemain = b.aiCards.filter(c => c.current_hp > 0).length;
  const paTc = typeColor(pa.type);
  const aaTc = typeColor(aa.type);
  const paPct = Math.round((pa.current_hp / pa.hp) * 100);
  const aaPct = Math.round((aa.current_hp / aa.hp) * 100);
  const paHc = paPct > 50 ? '#2ecc71' : paPct > 25 ? '#f39c12' : '#e74c3c';
  const aaHc = aaPct > 50 ? '#2ecc71' : aaPct > 25 ? '#f39c12' : '#e74c3c';
  const pBench = b.playerCards.map((c,i) => ({c,i})).filter(({i}) => i !== b.playerActive);
  const canSwitch = pBench.some(({c}) => c.current_hp > 0);
  const orbCostPa = clientOrbCost(pa);
  const hasOrbsForAbility = (pa.orbs||0) >= orbCostPa;
  const hasOrbsForBoost = (pa.orbs||0) >= 1;
  const hasOrbsForHeal = (pa.orbs||0) >= 2;
  const healMax = b.playerHealMax || 2;
  const healExhausted = (b.playerHealUses||0) >= healMax;

  const tLeft = b.turnTimeLeft ?? 30;
  const tPct  = Math.round((tLeft / 30) * 100);
  const tColor = tLeft > 15 ? '#2ecc71' : tLeft > 8 ? '#f39c12' : '#e74c3c';

  const log = b.log.slice(-10).map(l => {
    const cls = l.startsWith('⚔️') || l.startsWith('[Auto]') ? 'log-system'
              : l.includes(opp) ? 'log-ai' : 'log-player';
    return `<div class="${cls}">${l}</div>`;
  }).join('');

  const chatMsgs = (b.battleChat || []).slice(-30).map(m => {
    const mine = m.userId === S.user?.id;
    const t = new Date(m.time).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
    return `<div class="pvp-chat-msg${mine ? ' pvp-chat-mine' : ' pvp-chat-theirs'}">
      <span class="pvp-chat-who">${mine ? 'You' : m.username}</span>
      <span class="pvp-chat-text">${m.msg.replace(/</g,'&lt;')}</span>
      <span class="pvp-chat-time">${t}</span>
    </div>`;
  }).join('');

  return `
  <div class="battle-arena-v2${b.playerTurn ? ' player-turn-v2' : ''}">

    <!-- Turn timer -->
    <div class="battle-timer-wrap">
      <div class="pvp-mode-label">${modeLabel} · vs <strong>${opp}</strong></div>
      <div class="battle-timer-bar-outer">
        <div class="battle-timer-bar" style="width:${tPct}%;background:${tColor}"></div>
      </div>
      <div class="battle-timer-text" style="color:${tColor}">
        ${b.playerTurn ? `Your turn · ${tLeft}s` : `${opp}'s turn...`}
      </div>
    </div>

    <!-- Opponent party row -->
    <div class="battle-party-row battle-party-ai">
      <span class="party-label">${opp} <span style="color:#e74c3c;font-weight:700">${aiRemain}/5</span></span>
      <div class="party-cards-row">${_battleCardRow(b.aiCards, b.aiActive, false)}</div>
    </div>

    <!-- Main field -->
    <div class="battle-field-v2">

      <!-- Opponent active -->
      <div class="battle-active-v2 foe-active-v2" id="foe-active-slot">
        <div class="bav2-info">
          <span class="bav2-name">${aa.name}</span>
          <span class="bav2-type" style="background:${aaTc}">${aa.type}</span>
          ${b.playerGuarded ? `<span class="surge-badge" style="background:#2980b9">🛡️ GUARDED</span>` : ''}
        </div>
        <div class="bav2-hp-row">
          <div class="bav2-hp-bar-wrap"><div class="bav2-hp-bar" style="width:${aaPct}%;background:${aaHc}"></div></div>
          <span class="bav2-hp-text">${aa.current_hp}/${aa.hp}</span>
        </div>
        <div class="bav2-card-wrap">${renderCard(aa)}</div>
      </div>

      <!-- VS divider -->
      <div class="battle-vs-v2">
        <div class="vs-orb">${b.playerTurn ? 'YOUR<br>TURN' : 'THEIR<br>TURN'}</div>
        ${b.playerBoosted ? `<div class="boost-badge-v2">⚡ BOOSTED</div>` : ''}
      </div>

      <!-- Player active -->
      <div class="battle-active-v2 player-active-v2${b.playerVoidMode && pa.trait?.special_type==='void' ? ' void-aura' : ''}" id="player-active-slot">
        ${_coachHtml(b)}
        <div class="bav2-info">
          <span class="bav2-name">${pa.name}</span>
          <span class="bav2-type" style="background:${paTc}">${pa.type}</span>
          <span class="bav2-orbs-badge">${pa.orbs||0} ⚡</span>
          ${pa.trait ? `<span class="trait-badge trait-${(pa.trait.rarity||'common').toLowerCase()}">${pa.trait.name}</span>` : ''}
          ${b.playerVoidMode ? `<span class="void-mode-badge">🌑 VOID ${b.playerVoidTurns}t / ${b.playerVoidStored} stored</span>` : ''}
        </div>
        <div class="bav2-hp-row">
          <div class="bav2-hp-bar-wrap"><div class="bav2-hp-bar" style="width:${paPct}%;background:${paHc}"></div></div>
          <span class="bav2-hp-text">${pa.current_hp}/${pa.hp}</span>
        </div>
        <div class="bav2-card-wrap">${renderCard(pa)}</div>
      </div>
    </div>

    <!-- Player party row -->
    <div class="battle-party-row battle-party-player">
      <span class="party-label">Your Party <span style="color:#2ecc71;font-weight:700">${pRemain}/5</span></span>
      <div class="party-cards-row">${_battleCardRow(b.playerCards, b.playerActive, true)}</div>
    </div>

    <!-- Action dock -->
    <div class="battle-dock">
      ${b.playerTurn && !b.finished ? `
        <div class="battle-dock-energy">
          ${_attachEnergyHtml(b, pa, pBench, 'pvpAttachEnergy')}
        </div>
        <div class="battle-dock-actions">
          <button class="btn-battle-action btn-ba-strike" onclick="pvpAction('basic')" id="btn-basic"
            title="Quick Strike — ATK-based damage, no orbs needed.">
            <span class="bba-icon">⚡</span>
            <span class="bba-label">Quick Strike</span>
            <span class="bba-desc">ATK damage</span>
          </button>
          <button class="btn-battle-action btn-ba-ability${hasOrbsForAbility?'':' bba-disabled'}" onclick="pvpAction('ability')" id="btn-ability" ${hasOrbsForAbility?'':'disabled'}
            title="${pa.ability_name} — ${orbCostPa} orbs required">
            <span class="bba-icon">✦</span>
            <span class="bba-label">${pa.ability_name}</span>
            <span class="bba-desc">${orbCostPa} orbs · type dmg</span>
          </button>
          <button class="btn-battle-action btn-ba-guard" onclick="pvpAction('guard')" id="btn-guard"
            title="Guard — halve incoming damage this turn">
            <span class="bba-icon">🛡️</span>
            <span class="bba-label">Guard</span>
            <span class="bba-desc">Half damage</span>
          </button>
          <button class="btn-battle-action btn-ba-boost${hasOrbsForBoost?'':' bba-disabled'}" onclick="pvpAction('boost')" ${hasOrbsForBoost?'':'disabled'}
            title="Boost — 1 orb for +30% next attack">
            <span class="bba-icon">🔥</span>
            <span class="bba-label">Boost</span>
            <span class="bba-desc">1 orb · +30% next hit</span>
          </button>
          <button class="btn-battle-action btn-ba-heal${(hasOrbsForHeal && !healExhausted)?'':' bba-disabled'}" onclick="pvpAction('heal')" ${(hasOrbsForHeal && !healExhausted)?'':'disabled'}
            title="Heal — 2 orbs to restore 25% HP">
            <span class="bba-icon">💚</span>
            <span class="bba-label">Heal</span>
            <span class="bba-desc">2 orbs · 25% HP (${healMax-(b.playerHealUses||0)} left)</span>
          </button>
        </div>
        <div class="battle-dock-meta">
          ${canSwitch ? `<span class="dock-hint">Tap a bench card to switch</span>` : ''}
          <button class="btn-battle-forfeit" onclick="pvpForfeit()">Forfeit</button>
        </div>
      ` : `
        <div class="battle-dock-waiting">
          <div class="battle-ai-thinking">⌛ Waiting for ${opp}...</div>
        </div>
      `}
    </div>

    <!-- Bottom: log + chat side by side -->
    <div class="pvp-bottom-row">
      <div class="battle-log-v2" id="battle-log">${log}</div>
      <div class="pvp-chat-panel">
        <div class="pvp-chat-header">💬 Match Chat</div>
        <div class="pvp-chat-messages" id="pvp-chat-msgs">${chatMsgs || '<div class="pvp-chat-empty">Say something!</div>'}</div>
        <div class="pvp-chat-input-row">
          <input class="pvp-chat-input" id="pvp-chat-input" type="text" maxlength="120" placeholder="Message..." autocomplete="off" onkeydown="if(event.key==='Enter')pvpSendChat()">
          <button class="pvp-chat-send" onclick="pvpSendChat()">Send</button>
        </div>
      </div>
    </div>
  </div>`;
}

async function joinPvpQueue(ranked) {
  S._pvpRanked = !!ranked;
  try {
    const data = await api('/pvp/queue','POST',{ranked});
    if (data.status === 'in_battle' || data.status === 'matched') {
      S.pvpBattle = await api('/pvp/battle');
      nav('pvp_battle');
      startPvpBattlePolling();
    } else {
      nav('pvp_queue');
      startPvpQueuePolling();
    }
  } catch(e) { notify(e.message,'error'); }
}
window.joinPvpQueue = joinPvpQueue;

function startPvpQueuePolling() {
  if (S._pvpPolling) clearInterval(S._pvpPolling);
  let elapsed = 0;
  S._pvpPolling = setInterval(async () => {
    elapsed += 2;
    const el = document.getElementById('queue-time');
    if (el) el.textContent = elapsed + 's elapsed';
    try {
      const status = await api('/pvp/queue/status');
      if (status.status === 'matched') {
        clearInterval(S._pvpPolling); S._pvpPolling = null;
        S.pvpBattle = await api('/pvp/battle');
        nav('pvp_battle');
        startPvpBattlePolling();
      } else if (status.status === 'idle') {
        clearInterval(S._pvpPolling); S._pvpPolling = null;
        nav('pvp');
      }
    } catch {}
  }, 2000);
}

function startPvpBattlePolling() {
  if (S._pvpPolling) clearInterval(S._pvpPolling);
  S._pvpPolling = setInterval(async () => {
    if (S.view !== 'pvp_battle') { clearInterval(S._pvpPolling); S._pvpPolling = null; return; }
    try {
      const data = await api('/pvp/battle');
      S.pvpBattle = data;
      const chatInput = document.getElementById('pvp-chat-input')?.value || '';
      document.getElementById('page').innerHTML = viewPvpBattle();
      attachListeners(); scrollBattleLog();
      const newInput = document.getElementById('pvp-chat-input');
      if (newInput && chatInput) newInput.value = chatInput;
      const chatEl = document.getElementById('pvp-chat-msgs');
      if (chatEl) chatEl.scrollTop = chatEl.scrollHeight;
      if (data.finished) {
        clearInterval(S._pvpPolling); S._pvpPolling = null;
        if (data.ratingResult?.win) {
          S.user.coins += data.ratingResult.coinsEarned || 0;
          updateNavCoins();
          notify(data.ratingResult.newRating ? `Victory! Rating: ${data.ratingResult.newRating}` : `Victory! +${data.ratingResult.coinsEarned} coins`, 'success');
        } else {
          notify(data.ratingResult?.newRating ? `Defeated. Rating: ${data.ratingResult.newRating}` : 'Defeated!', 'info');
        }
        if (data.ranked) S.myRank = await api('/ranked/me').catch(() => S.myRank);
      }
    } catch {}
  }, 2000);
}

window.pvpAttachEnergy = async (target) => {
  try {
    const data = await api('/pvp/action', 'POST', { action: 'attach', target: target === 'active' ? 'active' : String(target) });
    S.pvpBattle = data;
    document.getElementById('page').innerHTML = viewPvpBattle();
    attachListeners(); scrollBattleLog();
  } catch(e) { notify(e.message, 'error'); }
};

async function pvpAction(action, extra = {}) {
  const btn = document.getElementById('btn-basic') || document.getElementById('btn-ability');
  if (btn) btn.disabled = true;

  const prevBattle = S.pvpBattle ? {
    ...S.pvpBattle,
    playerCards: S.pvpBattle.playerCards.map(c => ({...c})),
    aiCards:     S.pvpBattle.aiCards.map(c => ({...c})),
    log:         [...S.pvpBattle.log],
  } : null;

  try {
    const data = await api('/pvp/action','POST',{action,...extra});

    if (prevBattle && (action === 'basic' || action === 'ability' || action === 'attack')) {
      await battleAnimate(prevBattle, data);
    } else if (action === 'switch') {
      playBattleSound('switch');
    }

    S.pvpBattle = data;
    document.getElementById('page').innerHTML = viewPvpBattle();
    attachListeners(); scrollBattleLog();
    if (data.finished) {
      clearInterval(S._pvpPolling); S._pvpPolling = null;
      if (data.ratingResult?.win) {
        S.user.coins += data.ratingResult.coinsEarned || 0;
        updateNavCoins();
        notify(data.ratingResult.newRating ? `Victory! Rating: ${data.ratingResult.newRating} (${data.ratingResult.title})` : `Victory! +${data.ratingResult.coinsEarned} coins`, 'success');
        playBattleSound('victory');
      } else {
        notify(data.ratingResult?.newRating ? `Defeated. New rating: ${data.ratingResult.newRating}` : 'Defeated!', 'info');
        playBattleSound('defeat');
      }
      if (data.ranked) S.myRank = await api('/ranked/me').catch(() => S.myRank);
    }
  } catch(e) { notify(e.message,'error'); if (btn) btn.disabled = false; }
}
window.pvpAction   = pvpAction;
window.pvpForfeit  = () => { if (confirm('Forfeit this match?')) pvpAction('forfeit'); };

window.pvpSendChat = async () => {
  const input = document.getElementById('pvp-chat-input');
  const msg = input?.value?.trim();
  if (!msg) return;
  input.value = '';
  try {
    await api('/pvp/chat', 'POST', { message: msg });
    // Optimistically add to local state and re-render chat pane only
    if (S.pvpBattle) {
      S.pvpBattle.battleChat = S.pvpBattle.battleChat || [];
      S.pvpBattle.battleChat.push({ userId: S.user.id, username: S.user.username, msg, time: Date.now() });
      const t = new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
      const msgsEl = document.getElementById('pvp-chat-msgs');
      if (msgsEl) {
        msgsEl.innerHTML += `<div class="pvp-chat-msg pvp-chat-mine"><span class="pvp-chat-who">You</span><span class="pvp-chat-text">${msg.replace(/</g,'&lt;')}</span><span class="pvp-chat-time">${t}</span></div>`;
        msgsEl.scrollTop = msgsEl.scrollHeight;
      }
    }
  } catch(e) { notify(e.message, 'error'); }
};
window.leavePvpQueue = async () => {
  if (S._pvpPolling) { clearInterval(S._pvpPolling); S._pvpPolling = null; }
  await api('/pvp/queue','DELETE').catch(()=>{});
  nav('pvp');
};

// ─── SHOP ─────────────────────────────────────────────────────────
const PACK_TYPES = [
  {
    id: 'basic', name: 'Basic Pack', cost: 100, count: 5,
    bgGrad: 'linear-gradient(160deg,#0d1640,#070e28)',
    glowColor: 'rgba(0,180,230,0.3)',
    accentColor: '#4dd9ff',
    badgeStyle: 'background:rgba(0,180,230,0.15);color:#4dd9ff;border:1px solid rgba(0,180,230,0.4)',
    badge: 'STANDARD',
    desc: 'Standard pack. A chance at any rarity.',
    icon: `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" style="width:54px;height:54px;filter:drop-shadow(0 0 6px rgba(77,217,255,0.4))">
      <rect x="6" y="22" width="30" height="22" rx="3" fill="none" stroke="rgba(77,217,255,0.2)" stroke-width="1.5" transform="rotate(-9,21,33)"/>
      <rect x="11" y="19" width="30" height="22" rx="3" fill="none" stroke="rgba(77,217,255,0.35)" stroke-width="1.5" transform="rotate(-3,26,30)"/>
      <rect x="16" y="17" width="30" height="22" rx="3" fill="rgba(77,217,255,0.07)" stroke="#4dd9ff" stroke-width="1.5"/>
      <polygon points="31,22 33,27.5 39,27.5 34.5,31 36.5,36.5 31,33 25.5,36.5 27.5,31 23,27.5 29,27.5" fill="#4dd9ff" opacity="0.75"/>
    </svg>`,
    odds: `<span class="pack-odds-row"><span class="odds-chip" style="background:rgba(160,160,160,0.15);color:#aaa;border-color:rgba(160,160,160,0.3)">Common 55%</span><span class="odds-chip" style="background:rgba(100,200,100,0.15);color:#8ecf8e;border-color:rgba(100,200,100,0.3)">Uncommon 25%</span><span class="odds-chip" style="background:rgba(36,113,163,0.2);color:#74b9ff;border-color:rgba(74,185,255,0.35)">Rare 14%</span><span class="odds-chip" style="background:rgba(200,150,0,0.15);color:#f0c040;border-color:rgba(240,192,64,0.3)">Ultra Rare 4%</span><span class="odds-chip" style="background:rgba(80,180,120,0.15);color:#6ee7b7;border-color:rgba(110,231,183,0.3)">Full Art 1.5%</span><span class="odds-chip" style="background:rgba(139,63,200,0.2);color:#c080ff;border-color:rgba(192,128,255,0.35)">Mythic 0.5%</span></span>`,
  },
  {
    id: 'rare', name: 'Rare Pack', cost: 750, count: 5,
    bgGrad: 'linear-gradient(160deg,#0a2a4a,#050f1f)',
    glowColor: 'rgba(36,113,163,0.4)',
    accentColor: '#74b9ff',
    badgeStyle: 'background:rgba(36,113,163,0.2);color:#74b9ff;border:1px solid rgba(36,113,163,0.5)',
    badge: 'RARE+',
    desc: 'Boosted odds — Rare or higher on most pulls.',
    icon: `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" style="width:50px;height:50px;filter:drop-shadow(0 0 8px rgba(116,185,255,0.5))">
      <polygon points="32,6 52,24 44,58 20,58 12,24" fill="rgba(116,185,255,0.08)" stroke="#74b9ff" stroke-width="1.5" stroke-linejoin="round"/>
      <polygon points="32,6 52,24 32,32" fill="rgba(116,185,255,0.18)" stroke="#74b9ff" stroke-width="1" stroke-linejoin="round"/>
      <polygon points="12,24 32,32 20,58" fill="rgba(116,185,255,0.1)" stroke="#74b9ff" stroke-width="1" stroke-linejoin="round"/>
      <polygon points="52,24 44,58 32,32" fill="rgba(116,185,255,0.13)" stroke="#74b9ff" stroke-width="1" stroke-linejoin="round"/>
      <line x1="12" y1="24" x2="52" y2="24" stroke="#74b9ff" stroke-width="1" opacity="0.45"/>
      <circle cx="32" cy="6" r="2.5" fill="#74b9ff" opacity="0.8"/>
    </svg>`,
    odds: `<span class="pack-odds-row"><span class="odds-chip" style="background:rgba(36,113,163,0.2);color:#74b9ff;border-color:rgba(74,185,255,0.35)">Rare 47%</span><span class="odds-chip" style="background:rgba(200,150,0,0.15);color:#f0c040;border-color:rgba(240,192,64,0.3)">Ultra Rare 26%</span><span class="odds-chip" style="background:rgba(100,200,100,0.12);color:#8ecf8e;border-color:rgba(100,200,100,0.28)">Uncommon 16%</span><span class="odds-chip" style="background:rgba(80,180,120,0.15);color:#6ee7b7;border-color:rgba(110,231,183,0.3)">Full Art 6%</span><span class="odds-chip" style="background:rgba(139,63,200,0.2);color:#c080ff;border-color:rgba(192,128,255,0.35)">Mythic 2%</span><span class="odds-chip" style="background:rgba(160,160,160,0.1);color:#888;border-color:rgba(160,160,160,0.22)">Common 3%</span></span>`,
  },
  {
    id: 'ultra', name: 'Ultra Pack', cost: 2500, count: 7,
    bgGrad: 'linear-gradient(160deg,#1a0a00,#0d0400)',
    glowColor: 'rgba(212,160,23,0.35)',
    accentColor: '#f0c040',
    badgeStyle: 'background:rgba(212,160,23,0.2);color:#f0c040;border:1px solid rgba(212,160,23,0.5)',
    badge: 'ULTRA RARE+',
    desc: 'High-end pack with strong Ultra Rare+ odds.',
    icon: `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" style="width:50px;height:56px;filter:drop-shadow(0 0 10px rgba(240,192,64,0.5))">
      <path d="M32 5 C34 12 42 20 42 30 C42 40 38 48 32 52 C26 48 22 40 22 30 C22 20 30 12 32 5Z" fill="rgba(240,192,64,0.1)" stroke="#f0c040" stroke-width="1.5" stroke-linejoin="round"/>
      <path d="M32 18 C33 22 38 27 38 33 C38 39 35 44 32 46 C29 44 26 39 26 33 C26 27 31 22 32 18Z" fill="rgba(240,192,64,0.22)" stroke="rgba(240,192,64,0.7)" stroke-width="1" stroke-linejoin="round"/>
      <path d="M32 28 C33 30 35 33 35 36 C35 39 34 42 32 43 C30 42 29 39 29 36 C29 33 31 30 32 28Z" fill="rgba(255,255,200,0.35)"/>
      <circle cx="32" cy="5" r="2" fill="#f0c040"/>
    </svg>`,
    odds: `<span class="pack-odds-row"><span class="odds-chip" style="background:rgba(200,150,0,0.18);color:#f0c040;border-color:rgba(240,192,64,0.38)">Ultra Rare 49%</span><span class="odds-chip" style="background:rgba(36,113,163,0.18);color:#74b9ff;border-color:rgba(74,185,255,0.32)">Rare 22%</span><span class="odds-chip" style="background:rgba(80,180,120,0.15);color:#6ee7b7;border-color:rgba(110,231,183,0.3)">Full Art 15%</span><span class="odds-chip" style="background:rgba(139,63,200,0.2);color:#c080ff;border-color:rgba(192,128,255,0.38)">Mythic 6%</span><span class="odds-chip" style="background:rgba(100,200,100,0.12);color:#8ecf8e;border-color:rgba(100,200,100,0.25)">Uncommon 5.5%</span><span class="odds-chip" style="background:rgba(160,160,160,0.1);color:#888;border-color:rgba(160,160,160,0.2)">Common 2.5%</span></span>`,
  },
  {
    id: 'mythic', name: 'Mythic Pack', cost: 8000, count: 10,
    bgGrad: 'linear-gradient(160deg,#18002e,#080012)',
    glowColor: 'rgba(139,63,200,0.45)',
    accentColor: '#c080ff',
    badgeStyle: 'background:rgba(139,63,200,0.25);color:#c080ff;border:1px solid rgba(139,63,200,0.6)',
    badge: 'MYTHIC',
    desc: 'The rarest pack. Near-guaranteed Mythic pulls.',
    icon: `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" style="width:56px;height:54px;filter:drop-shadow(0 0 12px rgba(192,128,255,0.6))">
      <polygon points="8,46 8,30 20,40 32,12 44,40 56,30 56,46" fill="rgba(192,128,255,0.1)" stroke="#c080ff" stroke-width="1.5" stroke-linejoin="round"/>
      <rect x="8" y="46" width="48" height="7" rx="2" fill="rgba(192,128,255,0.12)" stroke="#c080ff" stroke-width="1.5"/>
      <circle cx="32" cy="12" r="3" fill="#c080ff" opacity="0.95"/>
      <circle cx="8" cy="30" r="2.2" fill="#c080ff" opacity="0.75"/>
      <circle cx="56" cy="30" r="2.2" fill="#c080ff" opacity="0.75"/>
      <circle cx="20" cy="40" r="1.5" fill="#c080ff" opacity="0.5"/>
      <circle cx="44" cy="40" r="1.5" fill="#c080ff" opacity="0.5"/>
      <circle cx="18" cy="18" r="1.2" fill="#c080ff" opacity="0.4"/>
      <circle cx="48" cy="22" r="1" fill="#c080ff" opacity="0.35"/>
      <circle cx="10" cy="54" r="0.8" fill="#c080ff" opacity="0.3"/>
    </svg>`,
    odds: `<span class="pack-odds-row"><span class="odds-chip" style="background:rgba(139,63,200,0.22);color:#c080ff;border-color:rgba(192,128,255,0.45)">Mythic 49.5%</span><span class="odds-chip" style="background:rgba(80,180,120,0.15);color:#6ee7b7;border-color:rgba(110,231,183,0.32)">Numbered/Sec. Rare 27.5%</span><span class="odds-chip" style="background:rgba(200,150,0,0.15);color:#f0c040;border-color:rgba(240,192,64,0.32)">Full Art/Ultra Rare 14%</span><span class="odds-chip" style="background:rgba(200,100,150,0.15);color:#f9a8d4;border-color:rgba(249,168,212,0.3)">Parallel 5.5%</span><span class="odds-chip" style="background:rgba(36,113,163,0.15);color:#74b9ff;border-color:rgba(74,185,255,0.28)">Rare 2.5%</span><span class="odds-chip" style="background:rgba(160,160,160,0.1);color:#777;border-color:rgba(160,160,160,0.18)">Common/Unc. 1%</span></span>`,
  },
];

function _renderPackCard(id, name, cost, count, badge, accentColor, bgGrad, glowColor, badgeStyle, icon, desc, oddsHtml) {
  const coins = S.user?.coins || 0;
  const canAfford = coins >= cost;
  return `<div class="shop-pack">
    <div class="shop-pack-inner">
      <div class="shop-pack-art" style="background:${bgGrad}">
        <div class="shop-pack-glow" style="background:radial-gradient(ellipse at 50% 70%,${glowColor},transparent 70%)"></div>
        <span class="shop-pack-badge" style="${badgeStyle}">${badge}</span>
        <div class="shop-pack-icon">${icon}</div>
        <div class="shop-pack-name" style="color:${accentColor};text-shadow:0 0 18px ${glowColor}">${name}</div>
        <div class="shop-pack-count">${count} Cards</div>
      </div>
      <div class="shop-pack-info">
        <p class="shop-pack-desc">${desc}</p>
        <div class="shop-pack-odds">${oddsHtml}</div>
        <div class="shop-pack-footer">
          <span class="shop-pack-cost">${cost} coins</span>
          <button class="btn btn-primary btn-sm" onclick="shopOpenPack('${id}',${cost},${count})"
            ${!canAfford ? 'disabled style="opacity:0.4;cursor:not-allowed"' : ''}>
            ${canAfford ? 'Open Pack' : 'Need more coins'}
          </button>
        </div>
      </div>
    </div>
  </div>`;
}

function viewShop() {
  const coins = S.user?.coins || 0;
  const builtInPacks = PACK_TYPES.map(p => {
    const canAfford = coins >= p.cost;
    return `<div class="shop-pack">
      <div class="shop-pack-inner">
        <div class="shop-pack-art" style="background:${p.bgGrad}">
          <div class="shop-pack-glow" style="background:radial-gradient(ellipse at 50% 70%,${p.glowColor},transparent 70%)"></div>
          <span class="shop-pack-badge" style="${p.badgeStyle}">${p.badge}</span>
          <div class="shop-pack-icon">${p.icon}</div>
          <div class="shop-pack-name" style="color:${p.accentColor};text-shadow:0 0 18px ${p.glowColor}">${p.name}</div>
          <div class="shop-pack-count">${p.count} Cards</div>
        </div>
        <div class="shop-pack-info">
          <p class="shop-pack-desc">${p.desc}</p>
          <div class="shop-pack-odds">${p.odds}</div>
          <div class="shop-pack-footer">
            <span class="shop-pack-cost">${p.cost} coins</span>
            <button class="btn ${p.id === 'mythic' || p.id === 'ultra' ? 'btn-gold' : 'btn-primary'} btn-sm"
              onclick="shopOpenPack('${p.id}',${p.cost},${p.count})"
              ${!canAfford ? 'disabled style="opacity:0.4;cursor:not-allowed"' : ''}>
              ${canAfford ? 'Open Pack' : 'Need more coins'}
            </button>
          </div>
        </div>
      </div>
    </div>`;
  }).join('');
  const customPacksHtml = (S._customPacks || []).map(cp => {
    const color = cp.accent_color || '#4dd9ff';
    const oddsHtml = Object.entries(cp.odds || {}).map(([k, v]) => `<span>${k.split(',').join(' / ')}: <strong>${v}%</strong></span>`).join(' · ');
    return _renderPackCard(
      cp.pack_id, cp.name, cp.cost, cp.count,
      cp.badge || 'CUSTOM', color,
      `linear-gradient(160deg,#1a1a2e,#0d0d1a)`,
      `${color}44`,
      `background:${color}22;color:${color};border:1px solid ${color}55`,
      `<span style="font-size:2rem">✦</span>`,
      cp.description || 'A special limited pack.',
      oddsHtml || ''
    );
  }).join('');
  const customSection = customPacksHtml ? `
    <div class="sketch-box mt-3">
      <h3 style="margin-bottom:0.75rem">Special Packs</h3>
      <div class="shop-grid">${customPacksHtml}</div>
    </div>` : '';
  const packs = builtInPacks;
  const promoSection = S._promoCards?.length ? `
    <div class="sketch-box mt-3">
      <h3 style="margin-bottom:1rem">Promo Cards</h3>
      <p class="text-muted mb-2" style="font-size:0.88rem">Exclusive cards — limited availability. Buy once with coins.</p>
      <div class="promo-shop-grid">${S._promoCards.map(c => {
        const tc = typeColor(c.type);
        const canAfford = coins >= c.shop_price;
        const alreadyOwned = c.owned;
        return `<div class="promo-shop-item rarity-${(c.rarity||'mythic').toLowerCase()}${alreadyOwned ? ' promo-owned' : ''}">
          <div class="promo-shop-art art-${(c.type||'fire').toLowerCase()}">${cardTypeSVG(c.type)}</div>
          <div class="promo-shop-name">${c.name}</div>
          <div class="promo-shop-type" style="color:${tc}">${c.type} — ${c.rarity?.replace('_',' ')}</div>
          <div class="promo-shop-stats">${c.hp} HP · ${c.atk} ATK · ${c.def} DEF</div>
          ${c.is_numbered && c.print_limit ? `<div style="font-size:0.72rem;color:var(--gold-light);font-family:var(--font-ui);margin:0.15rem 0">${c.print_limit - (c.print_count||0)} / ${c.print_limit} left</div>` : ''}
          ${c.expires_at ? `<div style="font-size:0.72rem;color:var(--red);font-family:var(--font-ui);margin:0.15rem 0">⏳ ${_promoTimeLeft(c.expires_at)}</div>` : ''}
          ${alreadyOwned
            ? `<div class="promo-already-owned">YOU ALREADY BOUGHT THIS YOU GREEDY PLAYER!!!</div>`
            : `<div class="promo-shop-price text-gold">${c.shop_price} coins</div>
               <button class="btn btn-gold btn-sm" onclick="buyPromo(${c.id},'${c.name}',${c.shop_price})" ${!canAfford?'disabled style="opacity:0.4"':''}>
                 ${canAfford ? 'Buy' : 'Need more coins'}
               </button>`
          }
        </div>`;
      }).join('')}</div>
    </div>` : '';
  return `<div class="page-title"><h2>Shop</h2><p class="text-muted">Spend your coins to open packs and grow your collection</p></div>
    <div class="shop-coins-bar sketch-box mb-3">
      <span>Your coins: <strong class="text-gold">${coins}</strong></span>
      <span class="text-muted" style="font-size:0.88rem">Earn more by winning ranked battles and claiming your daily reward</span>
    </div>
    <div class="shop-grid">${packs}</div>
    ${customSection}
    ${promoSection}`;
}

function _promoTimeLeft(expiresAt) {
  const ms = new Date(expiresAt) - Date.now();
  if (ms <= 0) return 'Expired';
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (d > 0) return `Expires in ${d}d ${h}h`;
  if (h > 0) return `Expires in ${h}h ${m}m`;
  return `Expires in ${m}m`;
}

window.buyPromo = async (id, name, price) => {
  if (!confirm(`Buy "${name}" for ${price} coins?`)) return;
  try {
    const r = await api('/shop/promos/' + id + '/buy', 'POST');
    S.user.coins -= price;
    updateNavCoins();
    S.collection.push(r.card);
    const pc = S._promoCards.find(c => c.id === id);
    if (pc) pc.owned = true;
    notify('Promo card acquired: ' + name, 'success');
    document.getElementById('page').innerHTML = getView();
    attachListeners();
  } catch (e) { notify(e.message, 'error'); }
};

window.shopOpenPack = async (packType, cost, count) => {
  if (!S.user || S.user.coins < cost) { notify('Not enough coins', 'error'); return; }
  // Build face-down card slots
  const slots = Array.from({length: count}, (_,i) => `
    <div class="pack-slot" id="ps-${i}" onclick="flipPackCard(${i})">
      <div class="pack-slot-inner">
        <div class="pack-face">
          <div class="card-back"><div class="card-back-label">Mythical TCG</div></div>
        </div>
        <div class="pack-back-face" id="pf-${i}"></div>
      </div>
    </div>`).join('');
  openModal(`
    <div class="pack-open-header">
      <h3>Opening Pack...</h3>
      <p class="text-muted">Tap each card to reveal it</p>
    </div>
    <div class="pack-reveal-grid" id="pack-grid">${slots}</div>
    <div class="pack-open-controls text-center mt-2">
      <button class="btn btn-gold" onclick="revealAllPackCards()">Reveal All</button>
      <button class="btn btn-primary" onclick="closeModal()">Done</button>
    </div>`);
  try {
    const data = await api('/packs/open', 'POST', { packType });
    S.user.coins -= cost;
    updateNavCoins();
    window._packCards = data.cards;
    data.cards.forEach((c,i) => {
      const el = document.getElementById('pf-' + i);
      if (el) el.innerHTML = renderCard(c);
      S.collection.push({ ...c, quantity: 1 });
    });
    // Staggered entrance animation on slots
    document.querySelectorAll('.pack-slot').forEach((el, i) => {
      el.style.animation = `packCardDeal 0.35s ${i * 0.07}s both`;
    });
    document.querySelector('.pack-open-header h3').textContent = 'Your Cards!';
  } catch (e) { notify(e.message, 'error'); closeModal(); }
};

window.revealAllPackCards = () => {
  document.querySelectorAll('.pack-slot').forEach((el, i) => {
    setTimeout(() => el.classList.add('flipped'), i * 120);
  });
};

// ─── CARD BROWSER ──────────────────────────────────────────────────
function viewCardBrowser() {
  const perPage = 24;
  const totalPages = Math.max(1, Math.ceil(S.cbTotal / perPage));
  const grid = S.cbCards.length
    ? `<div class="card-grid">${S.cbCards.map(c => renderCard(c,'normal',`showCardDetail(${c.id})`)).join('')}</div>`
    : '<p class="text-muted" style="padding:2rem 0;text-align:center">No cards found.</p>';
  const pages = totalPages <= 1 ? '' : `
    <div class="cb-pagination">
      <button class="btn btn-sm" onclick="cbGoPage(${S.cbPage - 1})" ${S.cbPage <= 1 ? 'disabled' : ''}>Prev</button>
      <span class="text-muted" style="padding:0 0.8rem">Page ${S.cbPage} / ${totalPages}</span>
      <button class="btn btn-sm" onclick="cbGoPage(${S.cbPage + 1})" ${S.cbPage >= totalPages ? 'disabled' : ''}>Next</button>
    </div>`;
  const rarityColors = {Common:'#8ca8cc',Uncommon:'#808b96',Rare:'#2471a3',Ultra_Rare:'#d4a017',Secret_Rare:'#e74c3c',Full_Art:'#c0392b',Parallel:'#2471a3',Numbered:'#d4a017',Prism:'#6c5ce7',Mythic:'#8b3fc8'};
  const rarityBadges = RARITIES.map(r => {
    const active = S.cbRarity === r;
    return `<span class="rarity-filter-btn${active?' active':''}" style="${active?`background:${rarityColors[r]||'#444'};color:#fff;border-color:${rarityColors[r]||'#444'}`:`border-color:${rarityColors[r]||'#444'};color:${rarityColors[r]||'#8ca8cc'}`}" onclick="cbSetRarity('${r}')">${rarityLabel(r)}</span>`;
  }).join('');
  return `<div class="page-title"><h2>All Cards</h2><p class="text-muted">${S.cbTotal ? S.cbTotal.toLocaleString() + ' cards total' : 'Loading...'}</p></div>
    <div class="sketch-box mb-3">
      <div class="cb-filters">
        <input class="input-box" id="cb-search" placeholder="Search name..." value="${S.cbSearch}" oninput="cbSearchDebounce(this.value)" style="max-width:240px">
        <select class="input-box" onchange="cbSetType(this.value)" style="max-width:160px">
          <option value="">All Types</option>
          ${TYPES.map(t => `<option value="${t}"${S.cbType===t?' selected':''}>${t}</option>`).join('')}
        </select>
        <button class="btn btn-sm" onclick="cbClear()">Clear</button>
      </div>
      <div class="cb-rarity-row">
        <span class="rarity-filter-btn${!S.cbRarity?' active':''}" onclick="cbSetRarity('')" style="${!S.cbRarity?'background:var(--cyan-dark);color:#fff;border-color:var(--cyan-dark)':''}">All</span>
        ${rarityBadges}
      </div>
    </div>
    <div id="cb-grid">${grid}</div>
    ${pages}`;
}

let _cbSearchTimer = null;
window.cbSearchDebounce = (v) => {
  clearTimeout(_cbSearchTimer);
  _cbSearchTimer = setTimeout(() => { S.cbSearch = v; S.cbPage = 1; loadCardBrowser(); }, 350);
};
window.cbSetType = (v) => { S.cbType = v; S.cbPage = 1; loadCardBrowser(); };
window.cbSetRarity = (v) => { S.cbRarity = v; S.cbPage = 1; loadCardBrowser(); };
window.cbClear = () => { S.cbType = ''; S.cbRarity = ''; S.cbSearch = ''; S.cbPage = 1; loadCardBrowser(); };
window.cbGoPage = (p) => { S.cbPage = p; loadCardBrowser(); };

async function loadCardBrowser() {
  const perPage = 24;
  const params = new URLSearchParams({ page: S.cbPage, limit: perPage });
  if (S.cbType)   params.set('type', S.cbType);
  if (S.cbRarity) params.set('rarity', S.cbRarity);
  if (S.cbSearch) params.set('search', S.cbSearch);
  try {
    const data = await api('/cards?' + params);
    S.cbCards = data.cards;
    S.cbTotal = data.total;
    const page = document.getElementById('page');
    if (page && S.view === 'cards') { page.innerHTML = viewCardBrowser(); attachListeners(); }
  } catch (e) { notify(e.message, 'error'); }
}

// ─── COLLECTION ───────────────────────────────────────────────────
function viewCollection() {
  const filterBar = `
    <div class="sketch-box filter-panel">
      <div class="filter-title">Filter Cards</div>
      <div class="form-group">
        <input class="input-box" id="col-search" placeholder="Search name..." value="${S.filterSearch}" oninput="colSearch(this.value)">
      </div>
      <div class="filter-section">
        <h4>Type</h4>
        <select class="input-box" onchange="colType(this.value)">
          <option value="">All Types</option>
          ${TYPES.map(t => `<option value="${t}"${S.filterType===t?' selected':''}>${t}</option>`).join('')}
        </select>
      </div>
      <div class="filter-section">
        <h4>Rarity</h4>
        <select class="input-box" onchange="colRarity(this.value)">
          <option value="">All Rarities</option>
          ${RARITIES.map(r => `<option value="${r}"${S.filterRarity===r?' selected':''}>${rarityLabel(r)}</option>`).join('')}
        </select>
      </div>
      <div style="margin-top:1rem">
        <button class="btn btn-gold" style="width:100%;margin-bottom:0.5rem" onclick="openPackModal()">Open Pack (100 coins)</button>
        <button class="btn" style="width:100%" onclick="colReset()">Clear Filters</button>
      </div>
      <div class="text-muted mt-2" style="font-size:0.85rem">${S.collection.length} cards owned</div>
    </div>`;

  const cards = getFilteredCollection();
  const grid = cards.length
    ? `<div class="card-grid">${cards.map((c,i) => renderCard(c,'normal',`showCardDetail(${c.id})`)).join('')}</div>`
    : '<p class="text-muted" style="padding:2rem 0">No cards match your filters.</p>';

  return `<div class="page-title"><h2>My Collection</h2></div>
    <div class="collection-layout">
      ${filterBar}
      <div>${grid}</div>
    </div>`;
}

function getFilteredCollection() {
  return S.collection.filter(c => {
    if (S.filterType && c.type !== S.filterType) return false;
    if (S.filterRarity && c.rarity !== S.filterRarity) return false;
    if (S.filterSearch && !c.name.toLowerCase().includes(S.filterSearch.toLowerCase())) return false;
    return true;
  });
}

window.colSearch = (v) => { S.filterSearch = v; document.querySelector('#page .card-grid, #page .text-muted').outerHTML = getFilteredCollection().length ? `<div class="card-grid">${getFilteredCollection().map(c => renderCard(c,'normal',`showCardDetail(${c.id})`)).join('')}</div>` : '<p class="text-muted">No cards match.</p>'; };
window.colType   = (v) => { S.filterType = v; document.getElementById('page').innerHTML = viewCollection(); attachListeners(); };
window.colRarity = (v) => { S.filterRarity = v; document.getElementById('page').innerHTML = viewCollection(); attachListeners(); };
window.colReset  = () => { S.filterType=''; S.filterRarity=''; S.filterSearch=''; document.getElementById('page').innerHTML = viewCollection(); attachListeners(); };

function showCardDetail(id) {
  const card = S.collection.find(c => c.id === id) || S.allCards.find(c => c.id === id);
  if (!card) return;
  const equippedTrait = S.myCardTraits[id];
  const isOwned = !!S.collection.find(c => c.id === id);
  const rarityColors = { Common:'#888', Rare:'#3498db', Legendary:'#d4a017', Secret:'#e74c3c' };
  const traitSection = equippedTrait
    ? `<div class="stat-row mb-1" style="border-left:3px solid ${rarityColors[equippedTrait.rarity]||'#888'};padding-left:0.5rem">
        <span class="label">Trait</span>
        <span><strong style="color:${rarityColors[equippedTrait.rarity]||'#888'}">${equippedTrait.name}</strong> <span class="trait-badge trait-${equippedTrait.rarity.toLowerCase()}">${equippedTrait.rarity}</span></span>
      </div>`
    : (isOwned && S.myTraits.length
        ? `<button class="btn btn-sm btn-primary" style="margin-top:0.5rem" onclick="showEquipTrait(${id})">✨ Equip Trait</button>`
        : '');
  openModal(`<div style="display:flex;gap:1.5rem;flex-wrap:wrap;align-items:flex-start">
    ${renderCard(card,'large')}
    <div style="flex:1;min-width:200px">
      <h3 style="margin-bottom:0.8rem">${card.name}</h3>
      <div class="stat-row mb-1"><span class="label">Set</span><span>${card.set_name || '-'}</span></div>
      <div class="stat-row mb-1"><span class="label">Art Style</span><span>${card.art_style || '-'}</span></div>
      <div class="stat-row mb-1"><span class="label">Rarity</span><span>${rarityLabel(card.rarity)}</span></div>
      ${card.is_numbered ? `<div class="stat-row mb-1"><span class="label">Print Run</span><span>${card.print_run ? card.print_run + ' copies' : 'N/A'}</span></div>` : ''}
      ${traitSection}
      <hr class="divider">
      <p class="flavor-text">"${card.flavor_text || ''}"</p>
      ${card.quantity ? `<p class="mt-2 text-muted">Owned: ${card.quantity}x</p>` : ''}
    </div>
  </div>`);
}
window.showCardDetail = showCardDetail;

async function openPackModal() {
  if (!S.user || S.user.coins < 100) { notify('Not enough coins (need 100)', 'error'); return; }
  const backs = Array(5).fill(0).map((_,i) => `
    <div class="pack-slot" id="ps-${i}" onclick="flipPackCard(${i})">
      <div class="pack-slot-inner">
        <div class="pack-face">
          <div class="card-back"><div class="card-back-label">Mythical TCG</div></div>
        </div>
        <div class="pack-back-face" id="pf-${i}"></div>
      </div>
    </div>`).join('');
  openModal(`<h3 style="margin-bottom:1rem">Opening Pack...</h3>
    <p class="text-muted mb-2">Tap each card to reveal it</p>
    <div class="pack-reveal-grid">${backs}</div>
    <div class="text-center mt-2"><button class="btn btn-primary" onclick="closeModal()">Done</button></div>`);
  try {
    const data = await api('/packs/open','POST');
    S.user.coins -= 100;
    updateNavCoins();
    data.cards.forEach((c,i) => {
      document.getElementById('pf-' + i).innerHTML = renderCard(c);
      S.collection.push({ ...c, quantity: 1 });
    });
  } catch (e) { notify(e.message, 'error'); closeModal(); }
}
window.openPackModal = openPackModal;

window.flipPackCard = (i) => {
  const slot = document.getElementById('ps-' + i);
  if (slot) slot.classList.add('flipped');
};

// ─── BATTLE (SERVER-AUTHORITATIVE) ───────────────────────────────
function renderCardOrbs(card, cost) {
  const color = TYPE_ENERGY_COLORS[card.type] || '#888';
  const initial = (card.type || '?')[0].toUpperCase();
  const orbs = card.orbs || 0;
  const show = Math.max(cost, orbs);
  const dots = Array.from({length: show}, (_, i) => {
    if (i < orbs) {
      return `<span class="orb-dot orb-full" style="background:${color};box-shadow:0 0 5px ${color},0 0 12px ${color}55" title="${card.type} orb">${initial}</span>`;
    }
    return `<span class="orb-dot" title="empty orb slot">${initial}</span>`;
  }).join('');
  return `<div class="card-orbs-row">${dots}<span class="orb-count">${orbs}/${cost}</span></div>`;
}

function _hpBarHtml(c, cost) {
  const pct = Math.max(0, Math.round(c.current_hp / c.hp * 100));
  const cls = pct > 50 ? '' : pct > 25 ? ' hp-yellow' : ' hp-red';
  const statusIcons = { burn: '🔥', poison: '☠️', freeze: '❄️', paralysis: '⚡' };
  const statusBadge = c.status
    ? `<span class="status-badge status-${c.status.type}">${statusIcons[c.status.type]} ${c.status.type} (${c.status.turnsLeft}t)</span>`
    : '';
  const orbHtml = cost != null ? renderCardOrbs(c, cost) : '';
  return `<div class="battle-hp-above">
    <div class="battle-hp-name">${c.name}${statusBadge}</div>
    <div class="battle-hp-bar-wrap"><div class="battle-hp-bar${cls}" style="width:${pct}%"></div></div>
    <div class="battle-hp-text">${c.current_hp} / ${c.hp} HP</div>
    ${orbHtml}
  </div>`;
}

const TYPE_ENERGY_COLORS = {
  Fire:    '#e53935', Water:   '#1e88e5', Earth:   '#6d4c41',
  Nature:  '#43a047', Shadow:  '#7b1fa2', Light:   '#fdd835',
  Ice:     '#00acc1', Metal:   '#78909c', Psychic: '#e91e63',
  Thunder: '#ffb300', Dragon:  '#6200ea', Void:    '#212121',
  Crystal: '#26c6da', Poison:  '#558b2f', Blood:   '#b71c1c',
  Chaos:   '#ff6d00', Cosmic:  '#1a237e', Spirit:  '#b39ddb',
  Wind:    '#80cbc4', Construct:'#90a4ae'
};
function clientOrbCost(card) { return (card.retreat_cost || 2) + 1; }

function _attachEnergyHtml(b, pa, pBench, fnName) {
  const done = b.playerEnergyAttached;
  if (done) {
    return `<button class="btn btn-sm energy-attached-btn" disabled title="Already attached this turn">⚡ Energy Attached</button>`;
  }
  const liveBench = pBench.filter(({c}) => c.current_hp > 0);
  const benchBtns = liveBench.map(({c, i}) => {
    const color = TYPE_ENERGY_COLORS[c.type] || '#888';
    const orbs = c.orbs || 0;
    const cost = clientOrbCost(c);
    return `<button class="orb-attach-target" style="border-color:${color}44" onclick="${fnName}(${i})" title="Attach to ${c.name} (${orbs}/${cost} orbs)">
      <span class="orb-dot orb-full" style="background:${color};box-shadow:0 0 5px ${color}" title="${c.type}">${c.type[0]}</span>
      <span style="font-size:0.72rem;max-width:60px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${c.name}</span>
    </button>`;
  }).join('');
  const color = TYPE_ENERGY_COLORS[pa.type] || '#888';
  const activeBtn = `<button class="orb-attach-target orb-attach-active" style="border-color:${color}66" onclick="${fnName}('active')" title="Attach to ${pa.name} (${pa.orbs||0}/${clientOrbCost(pa)} orbs)">
    <span class="orb-dot orb-full" style="background:${color};box-shadow:0 0 5px ${color}">${pa.type[0]}</span>
    <span style="font-size:0.72rem">${pa.name}</span>
  </button>`;
  return `<div class="energy-attach-row">
    <span class="energy-attach-label">⚡ Attach Energy:</span>
    ${activeBtn}${benchBtns}
  </div>`;
}
function renderOrbMeter(orbs, cost, type, isFoe) {
  const color = TYPE_ENERGY_COLORS[type] || '#888';
  const initial = (type || '?')[0].toUpperCase();
  const label = isFoe ? `Foe ${type}` : type;
  const dots = Array.from({length: cost}, (_, i) => {
    if (i < orbs) {
      return `<span class="orb-dot orb-full" style="background:${color};box-shadow:0 0 6px ${color},0 0 14px ${color}66" title="${type} orb">${initial}</span>`;
    }
    return `<span class="orb-dot" title="${type} orb">${initial}</span>`;
  }).join('');
  return `<div class="orb-meter"><span class="orb-meter-label">${label}:</span>${dots}<span class="orb-count">${orbs}/${cost}</span></div>`;
}

function _battleTimerHtml(b) {
  if (!b.startedAt) return '';
  const elapsed = Date.now() - b.startedAt;
  const remaining = Math.max(0, (b.timeLimit || 120000) - elapsed);
  const secs = Math.ceil(remaining / 1000);
  const mins = Math.floor(secs / 60);
  const s = secs % 60;
  const pct = (remaining / (b.timeLimit || 120000)) * 100;
  const urgent = secs <= 20;
  const color = secs > 45 ? '#2ecc71' : secs > 20 ? '#f39c12' : '#e74c3c';
  return `<div class="battle-timer-wrap${urgent ? ' battle-timer-urgent' : ''}">
    <div class="battle-timer-bar" style="width:${pct}%;background:${color}"></div>
    <span class="battle-timer-text" id="battle-timer-text" style="color:${color}">${mins}:${String(s).padStart(2,'0')}</span>
  </div>`;
}

function _battleCardRow(cards, activeIdx, isPlayer) {
  return cards.map((c,i) => {
    const alive = c.current_hp > 0;
    const active = i === activeIdx;
    const pct = Math.round((c.current_hp / c.hp) * 100);
    const tc = typeColor(c.type);
    const hc = pct > 50 ? '#2ecc71' : pct > 25 ? '#f39c12' : '#e74c3c';
    const voidGlow = c.trait?.special_type === 'void' ? ' bcard-mini-void' : '';
    return `<div class="bcard-mini${active?' bcard-mini-active':''}${!alive?' bcard-mini-fainted':''}${voidGlow}"
      onclick="${isPlayer && !active && alive ? `selectBenchCard(${i})` : ''}" title="${c.name}${c.trait ? ' ['+c.trait.name+']' : ''}">
      <div class="bcard-mini-art">${generateCardSVG(c)}</div>
      <div class="bcard-mini-name">${c.name.split(' ')[0]}${c.trait ? `<span style="font-size:0.55rem;color:#c080ff"> ✦</span>` : ''}</div>
      <div class="bcard-mini-hp-bar"><div style="width:${pct}%;background:${hc};height:100%;border-radius:2px;transition:width 0.4s"></div></div>
      <div class="bcard-mini-orbs">${Array.from({length: c.orbs||0}, () => `<span class="bcard-orb" style="background:${tc}"></span>`).join('')}</div>
    </div>`;
  }).join('');
}

function _coachQuote(b) {
  const coach = b.playerCoach;
  if (!coach || !coach.quotes || !coach.quotes.length) return '';
  const pa = b.playerCards?.[b.playerActive];
  const paPct = pa ? Math.round((pa.current_hp / pa.hp) * 100) : 100;
  // Pick a quote index based on state for variety
  const idx = (b.log?.length || 0) % coach.quotes.length;
  return coach.quotes[idx];
}

function _coachHtml(b) {
  const coach = b.playerCoach;
  if (!coach) return '';
  const rarityColors = { Common:'#888', Rare:'#3498db', Epic:'#8b3fc8', Legendary:'#d4a017' };
  const rc = rarityColors[coach.rarity] || '#888';
  const quote = _coachQuote(b);
  return `<div class="battle-coach-wrap">
    <div class="coach-portrait" style="border-color:${rc}">${coach.portrait}</div>
    <div class="coach-bubble">
      <div class="coach-name" style="color:${rc}">${coach.name}</div>
      <div class="coach-quote">"${quote}"</div>
    </div>
  </div>`;
}

function viewBattle() {
  if (!S.battle || S.battle.finished) {
    const result = S.battle?.ratingResult;
    const won = S.battle?.winner === 'player';
    if (S.battle?.finished) {
      const isTimeout = (S.battle.log||[]).some(l => l.includes("Time's up"));
      return `<div class="page-title"><h2>Battle Arena</h2></div>
      <div class="sketch-box text-center" style="max-width:520px;margin:0 auto;padding:2.5rem">
        <div style="font-size:4rem;margin-bottom:0.5rem">${won ? '🏆' : '💀'}</div>
        <h2 style="color:${won?'var(--gold)':'var(--red)'};margin-bottom:0.4rem;font-size:2rem">${won ? 'Victory!' : 'Defeated!'}</h2>
        ${isTimeout ? `<p class="text-muted" style="margin-bottom:0.4rem;font-size:0.9rem">Decided by time — ${won?'you had more cards/HP remaining':'foe had more cards/HP remaining'}</p>` : ''}
        ${result ? `<p style="color:var(--gold);font-weight:700;font-size:1.1rem;margin-bottom:0.4rem">${result.coinsEarned ? '+' + result.coinsEarned + ' coins' : 'No coins earned'}</p>` : ''}
        ${result?.traitDropped ? `<p style="color:#8b3fc8;font-weight:700;font-size:0.95rem;margin-bottom:1.2rem">✨ Trait dropped: <strong>${result.traitDropped.name}</strong> (${result.traitDropped.rarity})</p>` : ''}
        <div style="display:flex;gap:1rem;justify-content:center">
          <button class="btn btn-primary btn-lg" onclick="startBattle()">⚔️ Play Again</button>
          <button class="btn" onclick="nav('home')">Home</button>
        </div>
      </div>`;
    }
    return `<div class="page-title"><h2>Battle Arena</h2></div>
      <div class="sketch-box text-center" style="max-width:520px;margin:0 auto;padding:2.5rem">
        <div style="font-size:3rem;margin-bottom:1rem">⚔️</div>
        <h3 style="margin-bottom:0.6rem">Challenge an AI Trainer</h3>
        <p class="text-muted mb-1" style="font-size:0.9rem">5 cards each &bull; 2-minute time limit &bull; Most surviving cards wins</p>
        <p class="text-muted mb-2" style="font-size:0.85rem">Attach energy → Boost → Strike → Ability → Guard → Heal</p>
        <button class="btn btn-primary btn-lg" onclick="startBattle()" style="margin-top:0.5rem">⚔️ Start Battle</button>
      </div>`;
  }

  const b = S.battle;
  const pa = b.playerCards[b.playerActive];
  const aa = b.aiCards[b.aiActive];
  const pBench = b.playerCards.map((c,i) => ({c,i})).filter(({i}) => i !== b.playerActive);
  const canSwitch = pBench.some(({c}) => c.current_hp > 0);
  const aiRemain = b.aiCards.filter(c=>c.current_hp>0).length;
  const pRemain  = b.playerCards.filter(c=>c.current_hp>0).length;
  const orbCostPa = clientOrbCost(pa);
  const hasOrbsForAbility = (pa.orbs||0) >= orbCostPa;
  const hasOrbsForBoost = (pa.orbs||0) >= 1;
  const hasOrbsForHeal = (pa.orbs||0) >= 2;
  const healMax = b.playerHealMax || 2;
  const healExhausted = (b.playerHealUses||0) >= healMax;
  const combo = b.playerCombo || 0;

  const log = b.log.slice(-10).map(l => {
    const cls = l.startsWith('You') ? 'log-player' : l.startsWith('Foe') ? 'log-ai' : l.startsWith('⏱️') ? 'log-timeout' : 'log-system';
    return `<div class="${cls}">${l}</div>`;
  }).join('');

  const paTc = typeColor(pa.type);
  const aaTc = typeColor(aa.type);
  const paPct = Math.round((pa.current_hp / pa.hp) * 100);
  const aaPct = Math.round((aa.current_hp / aa.hp) * 100);
  const paHc = paPct > 50 ? '#2ecc71' : paPct > 25 ? '#f39c12' : '#e74c3c';
  const aaHc = aaPct > 50 ? '#2ecc71' : aaPct > 25 ? '#f39c12' : '#e74c3c';

  return `
  <div class="battle-arena-v2${b.playerTurn ? ' player-turn-v2' : ''}">

    <!-- Timer -->
    ${_battleTimerHtml(b)}

    <!-- AI party row -->
    <div class="battle-party-row battle-party-ai">
      <span class="party-label">AI Trainer <span style="color:#e74c3c;font-weight:700">${aiRemain}/5</span></span>
      <div class="party-cards-row">${_battleCardRow(b.aiCards, b.aiActive, false)}</div>
    </div>

    <!-- Main field -->
    <div class="battle-field-v2">

      <!-- Foe active -->
      <div class="battle-active-v2 foe-active-v2" id="foe-active-slot">
        <div class="bav2-info">
          <span class="bav2-name">${aa.name}</span>
          <span class="bav2-type" style="background:${aaTc}">${aa.type}</span>
          ${b.bossSurgeActive ? `<span class="surge-badge">⚠️ ENRAGED</span>` : ''}
        </div>
        <div class="bav2-hp-row">
          <div class="bav2-hp-bar-wrap"><div class="bav2-hp-bar" style="width:${aaPct}%;background:${aaHc}"></div></div>
          <span class="bav2-hp-text">${aa.current_hp}/${aa.hp}</span>
        </div>
        <div class="bav2-card-wrap">${renderCard(aa)}</div>
      </div>

      <!-- VS divider -->
      <div class="battle-vs-v2">
        <div class="vs-orb">${b.playerTurn ? 'YOUR<br>TURN' : 'AI<br>TURN'}</div>
        ${combo >= 2 ? `<div class="combo-badge-v2${combo>=3?' combo-max-v2':''}">${combo>=3?'🔥 x3 COMBO':'⚡ x'+combo}</div>` : ''}
        ${b.playerBoosted ? `<div class="boost-badge-v2">⚡ BOOSTED</div>` : ''}
      </div>

      <!-- Player active -->
      <div class="battle-active-v2 player-active-v2${b.playerVoidMode && pa.trait?.special_type==='void' ? ' void-aura' : ''}" id="player-active-slot">
        ${_coachHtml(b)}
        <div class="bav2-info">
          <span class="bav2-name">${pa.name}</span>
          <span class="bav2-type" style="background:${paTc}">${pa.type}</span>
          <span class="bav2-orbs-badge">${pa.orbs||0} ⚡</span>
          ${pa.trait ? `<span class="trait-badge trait-${(pa.trait.rarity||'common').toLowerCase()}">${pa.trait.name}</span>` : ''}
          ${b.playerVoidMode ? `<span class="void-mode-badge">🌑 VOID ${b.playerVoidTurns}t / ${b.playerVoidStored} stored</span>` : ''}
        </div>
        <div class="bav2-hp-row">
          <div class="bav2-hp-bar-wrap"><div class="bav2-hp-bar" style="width:${paPct}%;background:${paHc}"></div></div>
          <span class="bav2-hp-text">${pa.current_hp}/${pa.hp}</span>
        </div>
        <div class="bav2-card-wrap">${renderCard(pa)}</div>
      </div>
    </div>

    <!-- Player party row -->
    <div class="battle-party-row battle-party-player">
      <span class="party-label">Your Party <span style="color:#2ecc71;font-weight:700">${pRemain}/5</span></span>
      <div class="party-cards-row">${_battleCardRow(b.playerCards, b.playerActive, true)}</div>
    </div>

    <!-- Action dock -->
    <div class="battle-dock">
      ${b.playerTurn && !b.finished ? `
        <div class="battle-dock-energy">
          ${_attachEnergyHtml(b, pa, pBench, 'battleAttachEnergy')}
        </div>
        <div class="battle-dock-actions">
          <button class="btn-battle-action btn-ba-strike" onclick="battleBasic()" id="btn-basic" title="Quick Strike — deals ATK-based damage. Free, no orbs needed.">
            <span class="bba-icon">⚡</span>
            <span class="bba-label">Quick Strike</span>
            <span class="bba-desc">ATK damage</span>
          </button>
          <button class="btn-battle-action btn-ba-ability${hasOrbsForAbility?'':' bba-disabled'}" onclick="battleAbility()" id="btn-ability" ${hasOrbsForAbility?'':'disabled'}
            title="${pa.ability_name} — ${orbCostPa} orbs required">
            <span class="bba-icon">✦</span>
            <span class="bba-label">${pa.ability_name}</span>
            <span class="bba-desc">${orbCostPa} orbs • type dmg</span>
          </button>
          <button class="btn-battle-action btn-ba-guard" onclick="battleGuard()" id="btn-guard" title="Guard — halve incoming damage this turn">
            <span class="bba-icon">🛡️</span>
            <span class="bba-label">Guard</span>
            <span class="bba-desc">Half damage</span>
          </button>
          <button class="btn-battle-action btn-ba-boost${hasOrbsForBoost?'':' bba-disabled'}" onclick="battleBoost()" ${hasOrbsForBoost?'':'disabled'}
            title="Boost — spend 1 orb to make next attack deal +30% damage">
            <span class="bba-icon">🔥</span>
            <span class="bba-label">Boost</span>
            <span class="bba-desc">1 orb • +30% next hit</span>
          </button>
          <button class="btn-battle-action btn-ba-heal${(hasOrbsForHeal && !healExhausted)?'':' bba-disabled'}" onclick="battleHeal()" ${(hasOrbsForHeal && !healExhausted)?'':'disabled'}
            title="Heal — spend 2 orbs to restore 25% HP (2 uses per battle)">
            <span class="bba-icon">💚</span>
            <span class="bba-label">Heal</span>
            <span class="bba-desc">2 orbs • 25% HP (${healMax-(b.playerHealUses||0)} left)</span>
          </button>
        </div>
        <div class="battle-dock-meta">
          ${canSwitch ? `<span class="dock-hint">Tap a bench card to switch</span>` : ''}
          <button class="btn-battle-forfeit" onclick="battleForfeit()">Forfeit</button>
        </div>
      ` : b.finished
        ? `<div style="text-align:center;padding:1rem"><button class="btn btn-primary btn-lg" onclick="startBattle()">⚔️ Play Again</button></div>`
        : `<div class="battle-ai-thinking"><span class="thinking-dots">AI is thinking</span></div>`}
    </div>

    <!-- Battle log -->
    <div class="battle-log-v2" id="battle-log">${log}</div>
  </div>`;
}

let _battleTimerInterval = null;

function _startBattleTimer() {
  _stopBattleTimer();
  _battleTimerInterval = setInterval(() => {
    const b = S.battle;
    if (!b || b.finished) { _stopBattleTimer(); return; }
    // Update timer bar in DOM without full re-render
    const textEl = document.getElementById('battle-timer-text');
    const wrapEl = textEl?.parentElement;
    if (!wrapEl) return;
    const elapsed = Date.now() - b.startedAt;
    const remaining = Math.max(0, (b.timeLimit || 120000) - elapsed);
    const secs = Math.ceil(remaining / 1000);
    const mins = Math.floor(secs / 60);
    const s = secs % 60;
    const pct = (remaining / (b.timeLimit || 120000)) * 100;
    const color = secs > 45 ? '#2ecc71' : secs > 20 ? '#f39c12' : '#e74c3c';
    const barEl = wrapEl.querySelector('.battle-timer-bar');
    if (barEl) { barEl.style.width = pct + '%'; barEl.style.background = color; }
    if (textEl) { textEl.textContent = `${mins}:${String(s).padStart(2,'0')}`; textEl.style.color = color; }
    if (secs <= 20) wrapEl.classList.add('battle-timer-urgent');
    // Auto-resolve when timer hits 0
    if (remaining <= 0 && b.playerTurn) {
      _stopBattleTimer();
      battleAction('basic'); // triggers timeout check server-side
    }
  }, 500);
}

function _stopBattleTimer() {
  if (_battleTimerInterval) { clearInterval(_battleTimerInterval); _battleTimerInterval = null; }
}

async function startBattle() {
  const page = document.getElementById('page');
  if (page) page.innerHTML = `<div class="page-title"><h2>Battle Arena</h2></div><div class="spinner"></div>`;
  try {
    const data = await api('/battle/start','POST');
    S.battle = data;
    BattleMusic.start();
    document.getElementById('page').innerHTML = viewBattle();
    attachListeners();
    scrollBattleLog();
    _startBattleTimer();
  } catch (e) {
    notify(e.message, 'error');
    document.getElementById('page').innerHTML = viewBattle();
    attachListeners();
  }
}
window.startBattle = startBattle;

// ─── BATTLE ANIMATIONS ────────────────────────────────────────────
let _battleAnimating = false;

function playBattleSound(type) {
  try {
    const ctx = Music.bootCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime;
    if (type === 'attack') {
      const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.12), ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i/d.length, 1.5);
      const src = ctx.createBufferSource(); src.buffer = buf;
      const filt = ctx.createBiquadFilter(); filt.type = 'bandpass'; filt.frequency.value = 1800; filt.Q.value = 0.8;
      const g = ctx.createGain(); g.gain.setValueAtTime(0.22, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
      src.connect(filt); filt.connect(g); g.connect(ctx.destination);
      src.start(now);
    } else if (type === 'hit') {
      const osc = ctx.createOscillator(); osc.type = 'sine';
      osc.frequency.setValueAtTime(140, now); osc.frequency.exponentialRampToValueAtTime(45, now + 0.22);
      const g = ctx.createGain(); g.gain.setValueAtTime(0.28, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
      osc.connect(g); g.connect(ctx.destination); osc.start(now); osc.stop(now + 0.35);
    } else if (type === 'faint') {
      const osc = ctx.createOscillator(); osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(380, now); osc.frequency.exponentialRampToValueAtTime(90, now + 0.65);
      const g = ctx.createGain(); g.gain.setValueAtTime(0.16, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.75);
      osc.connect(g); g.connect(ctx.destination); osc.start(now); osc.stop(now + 0.8);
    } else if (type === 'victory') {
      [523, 659, 784, 1047].forEach((freq, i) => {
        const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = freq;
        const og = ctx.createGain(); o.connect(og); og.connect(ctx.destination);
        const t = now + i * 0.13;
        og.gain.setValueAtTime(0.18, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
        o.start(t); o.stop(t + 0.4);
      });
    } else if (type === 'defeat') {
      [440, 349, 277, 196].forEach((freq, i) => {
        const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = freq;
        const og = ctx.createGain(); o.connect(og); og.connect(ctx.destination);
        const t = now + i * 0.16;
        og.gain.setValueAtTime(0.14, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
        o.start(t); o.stop(t + 0.45);
      });
    } else if (type === 'switch') {
      const osc = ctx.createOscillator(); osc.type = 'sine';
      osc.frequency.setValueAtTime(440, now); osc.frequency.setValueAtTime(660, now + 0.08);
      const g = ctx.createGain(); g.gain.setValueAtTime(0.13, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
      osc.connect(g); g.connect(ctx.destination); osc.start(now); osc.stop(now + 0.25);
    }
  } catch(_e) {}
}
window.playBattleSound = playBattleSound;

function _showDmgFloat(slotEl, dmg) {
  const el = document.createElement('div');
  el.className = 'dmg-float';
  el.textContent = (dmg > 0 ? '-' : '+') + Math.abs(dmg);
  if (dmg < 0) el.classList.add('heal');
  slotEl.style.position = 'relative';
  slotEl.appendChild(el);
  setTimeout(() => el.remove(), 1300);
}

function _showEffBanner(arenaEl, text, cls) {
  const el = document.createElement('div');
  el.className = 'effectiveness-banner ' + cls;
  el.textContent = text;
  arenaEl.style.position = 'relative';
  arenaEl.appendChild(el);
  setTimeout(() => el.remove(), 1700);
}

function battleAnimate(prevB, newB) {
  return new Promise(resolve => {
    if (_battleAnimating) { resolve(); return; }
    _battleAnimating = true;

    const prevPA = prevB.playerCards[prevB.playerActive];
    const prevAA = prevB.aiCards[prevB.aiActive];
    const newPA  = newB.playerCards[newB.playerActive];
    const newAA  = newB.aiCards[newB.aiActive];

    const playerFainted = prevPA && newPA && newPA.current_hp <= 0 && prevPA.current_hp > 0;
    const foeFainted    = prevAA && newAA && newAA.current_hp <= 0 && prevAA.current_hp > 0;
    const playerDmg     = prevPA && newPA ? prevPA.current_hp - newPA.current_hp : 0;
    const foeDmg        = prevAA && newAA ? prevAA.current_hp - newAA.current_hp : 0;

    // Check last log entry for effectiveness
    const newLogs = newB.log.slice(prevB.log.length);
    const superEff  = newLogs.some(l => /super.?effective/i.test(l));
    const notEff    = newLogs.some(l => /not very effective/i.test(l));
    const immune    = newLogs.some(l => /no effect/i.test(l));

    const seq = [];
    if (prevB.playerTurn) {
      // Player attacks first
      seq.push({ t: 0,    fn: () => {
        const el = document.querySelector('#player-active-slot .tcg-card');
        if (el) { el.classList.add('ba-attack-player'); setTimeout(()=>el?.classList.remove('ba-attack-player'), 550); }
        playBattleSound('attack');
      }});
      if (foeDmg > 0) seq.push({ t: 320, fn: () => {
        const el  = document.querySelector('#foe-active-slot .tcg-card');
        const sl  = document.getElementById('foe-active-slot');
        if (el) { el.classList.add('ba-hit'); setTimeout(()=>el?.classList.remove('ba-hit'), 550); }
        if (sl)  _showDmgFloat(sl, foeDmg);
        playBattleSound('hit');
        const arena = document.querySelector('.battle-arena-bg');
        if (arena) { arena.classList.add('battle-arena-flash'); setTimeout(()=>arena?.classList.remove('battle-arena-flash'), 350); }
        if (superEff && arena) _showEffBanner(arena, 'SUPER EFFECTIVE!', 'eff-super');
        else if (notEff && arena) _showEffBanner(arena, 'Not very effective...', 'eff-weak');
        else if (immune && arena) _showEffBanner(arena, 'No effect!', 'eff-immune');
      }});
      if (foeFainted) seq.push({ t: 750, fn: () => {
        const el = document.querySelector('#foe-active-slot .tcg-card');
        if (el) el.classList.add('ba-faint');
        playBattleSound('faint');
      }});
      // AI counter-attacks (if it's still alive or a new one comes in)
      const aiAttackT = foeFainted ? 1400 : 900;
      seq.push({ t: aiAttackT, fn: () => {
        const el = document.querySelector('#foe-active-slot .tcg-card');
        if (el && !el.classList.contains('ba-faint')) {
          el.classList.add('ba-attack-foe'); setTimeout(()=>el?.classList.remove('ba-attack-foe'), 550);
        }
        playBattleSound('attack');
      }});
      if (playerDmg > 0) seq.push({ t: aiAttackT + 320, fn: () => {
        const el = document.querySelector('#player-active-slot .tcg-card');
        const sl = document.getElementById('player-active-slot');
        if (el) { el.classList.add('ba-hit'); setTimeout(()=>el?.classList.remove('ba-hit'), 550); }
        if (sl) _showDmgFloat(sl, playerDmg);
        playBattleSound('hit');
      }});
      if (playerFainted) seq.push({ t: aiAttackT + 750, fn: () => {
        const el = document.querySelector('#player-active-slot .tcg-card');
        if (el) el.classList.add('ba-faint');
        playBattleSound('faint');
      }});
    }

    const maxT = seq.length > 0 ? Math.max(...seq.map(s => s.t)) + 800 : 50;
    for (const step of seq) setTimeout(step.fn, step.t);

    if (newB.finished) {
      setTimeout(() => playBattleSound(newB.winner === 'player' ? 'victory' : 'defeat'), maxT - 100);
    }

    setTimeout(() => { _battleAnimating = false; resolve(); }, maxT);
  });
}

async function battleAction(action, extra = {}) {
  const btn = document.getElementById('btn-attack');
  if (btn) btn.disabled = true;
  const isConquest = S.view === 'conquest_battle';

  // Snapshot prev state for animation
  const prevBattle = (S.battle && !isConquest) ? {
    ...S.battle,
    playerCards: S.battle.playerCards.map(c => ({...c})),
    aiCards:     S.battle.aiCards.map(c => ({...c})),
    log:         [...S.battle.log],
  } : null;

  try {
    const data = await api('/battle/action','POST', { action, ...extra });

    // Play animations while DOM still shows old state (before S.battle update)
    if (prevBattle && action === 'attack' && !isConquest) {
      await battleAnimate(prevBattle, data);
    } else if (action === 'switch') {
      playBattleSound('switch');
    }

    S.battle = data;
    if (data.finished) { _stopBattleTimer(); BattleMusic.stop(); }
    if (data.finished && data.ratingResult) {
      const r = data.ratingResult;
      if (r.conquestWin !== undefined) {
        // Conquest battle finished — stop polling since we already have the result
        if (S._cqBattleInterval) { clearInterval(S._cqBattleInterval); S._cqBattleInterval = null; }
        if (r.conquestWin) {
          S.user.coins += r.coinsEarned || 0;
          updateNavCoins();
          const pieceMsg = r.pieceDropped ? ` Piece ${r.pieceDropped} collected!` : '';
          const traitMsg = r.traitDropped ? ` Trait: ${r.traitDropped.name}!` : '';
          notify(`Victory! +${r.coinsEarned} coins.${pieceMsg}${traitMsg}`, 'success');
          if (r.traitDropped) { api('/traits').then(d=>{S.myTraits=d.traits||[];S.myCardTraits=d.cardTraits||{};}).catch(()=>{}); }
          if (r.bossCardUnlocked) {
            notify(`All pieces collected! Boss card unlocked: ${r.bossCardUnlocked}! Check your collection.`, 'success');
            try { const col = await api('/user/collection'); S.collection = col || []; } catch {}
          }
          try {
            const cqData = await api('/conquest/progress');
            S.conquestProgress = cqData?.progress || [];
            S.conquestPieces   = cqData?.pieces   || [];
          } catch {}
        } else {
          notify('Defeated! Your forces were overwhelmed.', 'info');
        }
        document.getElementById('page').innerHTML = viewConquestBattle();
        attachListeners();
      } else {
        // Regular battle finished
        if (data.winner === 'player') {
          S.user.coins += r.coinsEarned || 0;
          updateNavCoins();
          notify(`Victory! +${r.coinsEarned} coins`, 'success');
        } else {
          notify('Defeated!', 'info');
        }
        S.myRank = await api('/ranked/me').catch(() => S.myRank);
        document.getElementById('page').innerHTML = viewBattle();
        attachListeners();
        scrollBattleLog();
      }
      return;
    }
    if (isConquest) {
      document.getElementById('page').innerHTML = viewConquestBattle();
    } else {
      document.getElementById('page').innerHTML = viewBattle();
    }
    attachListeners();
    scrollBattleLog();
  } catch (e) {
    notify(e.message, 'error');
    if (btn) btn.disabled = false;
  }
}

function scrollBattleLog() {
  const log = document.getElementById('battle-log');
  if (log) log.scrollTop = log.scrollHeight;
}

window.battleBasic   = () => battleAction('basic');
window.battleAbility = () => battleAction('ability');
window.battleGuard   = () => battleAction('guard');
window.battleBoost   = () => battleAction('boost');
window.battleHeal    = () => battleAction('heal');
window.battleAttack  = () => battleAction('basic'); // legacy alias
window.battleForfeit = () => { if (confirm('Forfeit this battle?')) { _stopBattleTimer(); BattleMusic.stop(); battleAction('forfeit'); } };
window.battleAttachEnergy = async (target) => {
  try {
    const data = await api('/battle/action', 'POST', { action: 'attach', target });
    S.battle = data;
    document.getElementById('page').innerHTML = getView();
    attachListeners();
    scrollBattleLog();
  } catch(e) { notify(e.message, 'error'); }
};

window.selectBenchCard = (realIdx) => {
  if (S.view === 'pvp_battle') {
    if (!S.pvpBattle || S.pvpBattle.finished || !S.pvpBattle.playerTurn) return;
    pvpAction('switch', { switchTo: realIdx });
  } else {
    if (!S.battle || S.battle.finished || !S.battle.playerTurn) return;
    battleAction('switch', { switchTo: realIdx });
  }
};

// ─── PROFILE ──────────────────────────────────────────────────────
function viewProfile() {
  const p = S.profileUser;
  if (!p) return `<div class="page-title"><h2>Profile</h2></div><div class="sketch-box"><p class="text-muted">No profile loaded.</p></div>`;
  const wr = (p.wins + p.losses) > 0 ? Math.round(p.wins / (p.wins + p.losses) * 100) : 0;
  const ratingPct = Math.min(100, Math.round((p.rating || 1000) / 3000 * 100));
  const matches = (p.recent_matches || []).map(m => {
    const won = m.winner_id === p.id;
    return `<div class="match-entry ${won?'match-win':'match-loss'}"><span>${won?'Win':'Loss'}</span><span class="text-muted" style="font-size:0.82rem">${m.opponent ? 'vs '+m.opponent : 'vs AI'} — ${new Date(m.created_at).toLocaleDateString()}</span></div>`;
  }).join('') || '<p class="text-muted" style="font-size:0.9rem">No recent matches.</p>';
  const isSelf = S.user?.username?.toLowerCase() === p.username?.toLowerCase();
  return `<div class="page-title"><h2>${isSelf ? 'My Profile' : p.username + "'s Profile"}</h2></div>
  <div class="profile-layout">
    <div class="profile-card-col">
      <div class="profile-avatar">${_av(p, 80)}</div>
      <div class="profile-username">${p.username}</div>
      <span class="role-badge role-${p.role}">${p.role}</span>
      ${p.custom_title ? `<div class="custom-title-badge">${p.custom_title}</div>` : ''}
      ${p.top500 ? '<div class="profile-top500">⭐ Top 500</div>' : ''}
      ${p.bio ? `<div class="profile-bio">${p.bio}</div>` : ''}
      <div class="profile-joined text-muted">Joined ${new Date(p.created_at).toLocaleDateString()}</div>
      <div class="profile-stat-row"><span>Cards Owned</span><span class="text-gold">${p.card_count || 0}</span></div>
    </div>
    <div class="profile-info-col">
      <div class="sketch-box mb-2">
        <h3 style="margin-bottom:0.8rem">Ranked Stats</h3>
        <div class="profile-rank-title">${p.rank_title || 'Bronze'}</div>
        <div class="profile-rating-bar-wrap"><div class="profile-rating-bar" style="width:${ratingPct}%"></div></div>
        <div class="profile-rating-num">${p.rating || 1000} ELO</div>
        <div class="profile-wlr">
          <div class="profile-stat-box"><div class="pstat-val text-green">${p.wins||0}</div><div class="pstat-label">Wins</div></div>
          <div class="profile-stat-box"><div class="pstat-val text-red">${p.losses||0}</div><div class="pstat-label">Losses</div></div>
          <div class="profile-stat-box"><div class="pstat-val">${wr}%</div><div class="pstat-label">Win Rate</div></div>
          <div class="profile-stat-box"><div class="pstat-val">${p.season_wins||0}</div><div class="pstat-label">Season W</div></div>
        </div>
      </div>
      <div class="sketch-box">
        <h3 style="margin-bottom:0.8rem">Recent Matches</h3>
        ${matches}
      </div>
    </div>
  </div>`;
}

window.openProfile = async (username) => {
  if (!username) return;
  try {
    S.profileUser = await api('/users/' + encodeURIComponent(username) + '/profile');
    nav('profile');
  } catch (e) { notify('Profile not found', 'error'); }
};

// ─── TRADE ────────────────────────────────────────────────────────
function viewTrade() {
  const tab = S.tradeTab;
  const incoming = S.trades.filter(t => t.to_user_id === S.user.id);
  const outgoing  = S.trades.filter(t => t.from_user_id === S.user.id);

  const tradeCard = (t, mine) => {
    const offeredHtml  = (t.offeredCards  || []).map(c => `
      <div class="trade-card-chip" style="border-color:${typeColor(c.type)}22">
        <div class="trade-chip-art">${generateCardSVG(c)}</div>
        <span class="trade-chip-name">${c.name}</span>
        <span class="trade-chip-type" style="color:${typeColor(c.type)}">${c.type}</span>
        <span class="trade-chip-rarity">${rarityLabel(c.rarity)}</span>
      </div>`).join('');
    const requestedHtml = (t.requestedCards || []).map(c => `
      <div class="trade-card-chip" style="border-color:${typeColor(c.type)}22">
        <div class="trade-chip-art">${generateCardSVG(c)}</div>
        <span class="trade-chip-name">${c.name}</span>
        <span class="trade-chip-type" style="color:${typeColor(c.type)}">${c.type}</span>
        <span class="trade-chip-rarity">${rarityLabel(c.rarity)}</span>
      </div>`).join('');

    const fromLabel = mine ? 'You offer' : `<b>${t.from_username}</b> offers`;
    const toLabel   = mine ? `<b>${t.to_username}</b> gives back` : 'You give back';
    return `
      <div class="trade-offer-card">
        <div class="trade-offer-header">
          <span class="trade-offer-from">${fromLabel}</span>
          <span class="trade-offer-arrow">⇄</span>
          <span class="trade-offer-to">${toLabel}</span>
          <span class="trade-offer-time text-muted">${new Date(t.created_at).toLocaleDateString()}</span>
        </div>
        <div class="trade-chips-row">
          <div class="trade-chips-side">
            <div class="trade-chips-label">${mine ? 'Offering' : 'Their offer'}</div>
            <div class="trade-chips">${offeredHtml}</div>
          </div>
          <div class="trade-chips-divider">⇄</div>
          <div class="trade-chips-side">
            <div class="trade-chips-label">${mine ? 'Requesting' : 'You give'}</div>
            <div class="trade-chips">${requestedHtml}</div>
          </div>
        </div>
        ${t.message ? `<div class="trade-message">"${t.message}"</div>` : ''}
        <div class="trade-offer-actions">
          ${!mine ? `
            <button class="btn btn-primary btn-sm" onclick="tradeAccept(${t.id})">Accept</button>
            <button class="btn btn-sm" onclick="tradeDecline(${t.id})">Decline</button>
          ` : `
            <button class="btn btn-sm btn-red" onclick="tradeDecline(${t.id})">Cancel</button>
          `}
        </div>
      </div>`;
  };

  // New trade form
  const newTradeForm = () => {
    const mySelCards = S.tradeMyCards.filter(c => S.tradeOffered.includes(c.id));
    const theirSelCards = S.tradeTargetCards.filter(c => S.tradeRequested.includes(c.id));

    const selChip = (c, side) => `
      <div class="trade-sel-chip" style="border-color:${typeColor(c.type)}44" onclick="tradeDeselect(${c.id},'${side}')">
        <div class="trade-chip-art">${generateCardSVG(c)}</div>
        <span class="trade-chip-name">${c.name}</span>
        <span class="trade-chip-x">✕</span>
      </div>`;

    const myCardGrid = S.tradeMyCards.map(c => {
      const sel = S.tradeOffered.includes(c.id);
      return `<div class="trade-pick-card${sel?' trade-pick-sel':''}" onclick="tradeToggleMy(${c.id})" title="${c.name}">
        <div class="trade-pick-art">${generateCardSVG(c)}</div>
        <div class="trade-pick-name">${c.name}</div>
        <div class="trade-pick-type" style="color:${typeColor(c.type)}">${c.type}</div>
        ${sel ? '<div class="trade-pick-check">✓</div>' : ''}
      </div>`;
    }).join('');

    const theirCardGrid = S.tradeTargetCards.map(c => {
      const sel = S.tradeRequested.includes(c.id);
      return `<div class="trade-pick-card${sel?' trade-pick-sel':''}" onclick="tradeToggleTheir(${c.id})" title="${c.name}">
        <div class="trade-pick-art">${generateCardSVG(c)}</div>
        <div class="trade-pick-name">${c.name}</div>
        <div class="trade-pick-type" style="color:${typeColor(c.type)}">${c.type}</div>
        ${sel ? '<div class="trade-pick-check">✓</div>' : ''}
      </div>`;
    }).join('');

    return `
      <div class="trade-new-form">
        <!-- Step 1: target user -->
        <div class="trade-step">
          <div class="trade-step-label">1. Who do you want to trade with?</div>
          <div class="trade-target-row">
            <input class="input" id="trade-target-input" placeholder="Enter username…" value="${S.tradeTarget}"
              onkeydown="if(event.key==='Enter')tradeLookupTarget()">
            <button class="btn btn-primary btn-sm" onclick="tradeLookupTarget()">Browse Their Cards</button>
          </div>
        </div>

        ${S.tradeTarget && S.tradeTargetCards.length !== undefined ? `
        <!-- Step 2: pick their cards -->
        <div class="trade-step">
          <div class="trade-step-label">2. Pick cards to request from <b>${S.tradeTarget}</b></div>
          <div class="trade-search-row">
            <input class="input input-sm" id="trade-their-search" placeholder="Search…" value="${S.tradeTargetSearch}"
              oninput="S.tradeTargetSearch=this.value" onkeydown="if(event.key==='Enter')tradeSearchTheir()">
            <button class="btn btn-sm" onclick="tradeSearchTheir()">Search</button>
          </div>
          ${theirCardGrid || `<p class="text-muted" style="margin:0.5rem 0">No cards found.</p>`}
          ${S.tradeTargetTotal > S.tradeTargetCards.length ? `
            <button class="btn btn-sm" onclick="tradeLoadMoreTheir()" style="margin-top:0.5rem">Load more</button>` : ''}
          ${theirSelCards.length ? `
            <div class="trade-sel-row">
              <b>Requesting:</b>
              <div class="trade-sel-chips">${theirSelCards.map(c => selChip(c,'requested')).join('')}</div>
            </div>` : ''}
        </div>

        <!-- Step 3: pick your cards -->
        <div class="trade-step">
          <div class="trade-step-label">3. Pick cards to offer from your collection</div>
          <div class="trade-search-row">
            <input class="input input-sm" id="trade-my-search" placeholder="Search…" value="${S.tradeMySearch}"
              oninput="S.tradeMySearch=this.value" onkeydown="if(event.key==='Enter')tradeSearchMy()">
            <button class="btn btn-sm" onclick="tradeSearchMy()">Search</button>
          </div>
          ${myCardGrid || `<p class="text-muted" style="margin:0.5rem 0">No cards in your collection.</p>`}
          ${mySelCards.length ? `
            <div class="trade-sel-row">
              <b>Offering:</b>
              <div class="trade-sel-chips">${mySelCards.map(c => selChip(c,'offered')).join('')}</div>
            </div>` : ''}
        </div>

        <!-- Step 4: message + send -->
        <div class="trade-step">
          <div class="trade-step-label">4. Add a message (optional) and send</div>
          <input class="input" id="trade-message-input" placeholder="Note to recipient…" maxlength="200"
            value="${S.tradeMessage}" oninput="S.tradeMessage=this.value">
          <button class="btn btn-primary" onclick="tradeSend()"
            ${S.tradeOffered.length && S.tradeRequested.length ? '' : 'disabled'}>
            Send Trade Offer
          </button>
        </div>
        ` : ''}
      </div>`;
  };

  return `
    <div class="page-title"><h2>Trade</h2></div>
    <div class="trade-tabs">
      <button class="trade-tab-btn${tab==='incoming'?' active':''}" onclick="setTradeTab('incoming')">
        Incoming ${incoming.length ? `<span class="trade-count">${incoming.length}</span>` : ''}
      </button>
      <button class="trade-tab-btn${tab==='outgoing'?' active':''}" onclick="setTradeTab('outgoing')">
        Outgoing ${outgoing.length ? `<span class="trade-count">${outgoing.length}</span>` : ''}
      </button>
      <button class="trade-tab-btn${tab==='new'?' active':''}" onclick="setTradeTab('new')">
        + New Trade
      </button>
    </div>

    ${tab === 'incoming' ? `
      <div class="trade-list">
        ${incoming.length ? incoming.map(t => tradeCard(t, false)).join('') : `
          <div class="sketch-box text-center" style="padding:2rem;color:var(--ink-light)">
            No incoming trade offers right now.
          </div>`}
      </div>
    ` : tab === 'outgoing' ? `
      <div class="trade-list">
        ${outgoing.length ? outgoing.map(t => tradeCard(t, true)).join('') : `
          <div class="sketch-box text-center" style="padding:2rem;color:var(--ink-light)">
            You haven't sent any trade offers.
          </div>`}
      </div>
    ` : newTradeForm()}
  `;
}

// ── Trade logic ──────────────────────────────────────────────────
async function loadTrades() {
  try {
    S.trades = await api('/trades');
    render();
  } catch(e) { notify(e.message,'error'); }
}

window.setTradeTab = async (tab) => {
  S.tradeTab = tab;
  if (tab !== 'new') await loadTrades();
  else render();
};

window.tradeLookupTarget = async () => {
  const val = document.getElementById('trade-target-input')?.value?.trim();
  if (!val) return;
  S.tradeTarget = val;
  S.tradeTargetPage = 1;
  S.tradeTargetCards = [];
  S.tradeRequested = [];
  S.tradeOffered = [];
  S._tradeMyAllCards = null;
  try {
    const data = await api(`/trades/user/${encodeURIComponent(val)}/collection?page=1`);
    S.tradeTargetCards = data.cards;
    S.tradeTargetTotal = data.total;
    // Also load my collection
    const mine = await api('/user/collection');
    S.tradeMyCards = Array.isArray(mine) ? mine : (mine.cards || []);
    S.tradeMyTotal = S.tradeMyCards.length;
    render();
  } catch(e) { notify(e.message,'error'); }
};

window.tradeSearchTheir = async () => {
  S.tradeTargetPage = 1;
  try {
    const data = await api(`/trades/user/${encodeURIComponent(S.tradeTarget)}/collection?page=1&search=${encodeURIComponent(S.tradeTargetSearch)}`);
    S.tradeTargetCards = data.cards;
    S.tradeTargetTotal = data.total;
    render();
  } catch(e) { notify(e.message,'error'); }
};

window.tradeLoadMoreTheir = async () => {
  S.tradeTargetPage++;
  try {
    const data = await api(`/trades/user/${encodeURIComponent(S.tradeTarget)}/collection?page=${S.tradeTargetPage}&search=${encodeURIComponent(S.tradeTargetSearch)}`);
    S.tradeTargetCards = [...S.tradeTargetCards, ...data.cards];
    render();
  } catch(e) { notify(e.message,'error'); }
};

window.tradeSearchMy = () => {
  const q = S.tradeMySearch.toLowerCase();
  const all = S._tradeMyAllCards || S.tradeMyCards;
  S._tradeMyAllCards = S._tradeMyAllCards || S.tradeMyCards;
  S.tradeMyCards = q ? all.filter(c => c.name.toLowerCase().includes(q) || c.type.toLowerCase().includes(q)) : all;
  render();
};

window.tradeToggleMy = (id) => {
  if (S.tradeOffered.includes(id)) S.tradeOffered = S.tradeOffered.filter(x => x !== id);
  else S.tradeOffered = [...S.tradeOffered, id];
  render();
};

window.tradeToggleTheir = (id) => {
  if (S.tradeRequested.includes(id)) S.tradeRequested = S.tradeRequested.filter(x => x !== id);
  else S.tradeRequested = [...S.tradeRequested, id];
  render();
};

window.tradeDeselect = (id, side) => {
  if (side === 'offered') S.tradeOffered = S.tradeOffered.filter(x => x !== id);
  else S.tradeRequested = S.tradeRequested.filter(x => x !== id);
  render();
};

window.tradeSend = async () => {
  if (!S.tradeOffered.length || !S.tradeRequested.length) return;
  try {
    await api('/trades', 'POST', {
      toUsername: S.tradeTarget,
      offeredCardIds: S.tradeOffered,
      requestedCardIds: S.tradeRequested,
      message: S.tradeMessage,
    });
    notify('Trade offer sent!', 'success');
    S.tradeOffered = [];
    S.tradeRequested = [];
    S.tradeMessage = '';
    S.tradeTab = 'outgoing';
    await loadTrades();
  } catch(e) { notify(e.message,'error'); }
};

window.tradeAccept = async (id) => {
  try {
    await api(`/trades/${id}/accept`, 'POST');
    notify('Trade accepted! Cards exchanged.', 'success');
    await loadTrades();
  } catch(e) { notify(e.message,'error'); }
};

window.tradeDecline = async (id) => {
  try {
    await api(`/trades/${id}/decline`, 'POST');
    notify('Trade declined.', 'info');
    await loadTrades();
  } catch(e) { notify(e.message,'error'); }
};

// Load trades/coaches when navigating
const _origNav = window.nav;
window.nav = function(view) {
  _origNav(view);
  if (view === 'trade') loadTrades();
  if (view === 'coaches') loadCoaches();
  if (view === 'quests') loadQuests();
  if (view === 'battlepass') loadBattlepass();
};

// ─── COACHES ─────────────────────────────────────────────────────
async function loadCoaches() {
  try {
    const data = await api('/coaches');
    S.myCoaches = data.coaches || [];
    S.myEquippedCoachId = data.equippedId;
    render();
  } catch(e) { notify(e.message,'error'); }
}

function viewCoaches() {
  const rarityColors = { Common:'#888', Rare:'#3498db', Epic:'#8b3fc8', Legendary:'#d4a017' };
  const equipped = S.myEquippedCoachId;
  const coachCards = S.myCoaches.length
    ? S.myCoaches.map(c => {
        const rc = rarityColors[c.rarity] || '#888';
        const isEq = c.coach_id === equipped || c.id === equipped;
        return `<div class="coach-card${isEq?' coach-card-equipped':''}" style="border-color:${rc}">
          <div class="coach-card-portrait" style="border-color:${rc}">${c.portrait}</div>
          <div class="coach-card-info">
            <div class="coach-card-name" style="color:${rc}">${c.name}</div>
            <div><span class="trait-badge trait-${c.rarity.toLowerCase()}">${c.rarity}</span></div>
            <div class="coach-card-desc">${c.description}</div>
          </div>
          <div class="coach-card-actions">
            ${isEq
              ? `<span class="coach-equipped-badge">✓ Equipped</span><button class="btn btn-sm" onclick="equipCoach(0)">Unequip</button>`
              : `<button class="btn btn-primary btn-sm" onclick="equipCoach(${c.coach_id||c.id})">Equip</button>`}
          </div>
        </div>`;
      }).join('')
    : `<p class="text-muted">No coaches yet — open a Coach Pack to recruit one!</p>`;

  const canAfford = S.user && S.user.coins >= 500;
  return `
  <div class="page-title"><h2>Coaches</h2></div>

  <!-- Coach Pack -->
  <div class="coach-pack-banner">
    <div class="coach-pack-icon">🎒</div>
    <div class="coach-pack-info">
      <div class="coach-pack-title">Coach Pack</div>
      <div class="coach-pack-sub">50 unique coaches · Common 60% · Rare 25% · Epic 12% · Legendary 3%</div>
      <div class="coach-pack-sub" style="margin-top:0.2rem">Coaches appear above your card in battle, cheer you on, and grant combat buffs.</div>
    </div>
    <button class="btn btn-gold coach-pack-btn${canAfford?'':' bba-disabled'}" onclick="openCoachPack()" ${canAfford?'':'disabled'}>
      Open Pack<br><span style="font-size:0.8rem;font-weight:400">500 coins</span>
    </button>
  </div>

  <div style="margin-bottom:0.6rem;color:var(--ink-light);font-size:0.85rem">
    Your coaches (${S.myCoaches.length}) — one equipped at a time
  </div>
  <div class="coach-list">${coachCards}</div>`;
}

window.equipCoach = async (id) => {
  try {
    await api(`/coaches/equip/${id}`, 'POST');
    S.myEquippedCoachId = id || null;
    notify(id ? 'Coach equipped!' : 'Coach unequipped', 'success');
    render();
  } catch(e) { notify(e.message,'error'); }
};

window.openCoachPack = async () => {
  if (!S.user || S.user.coins < 500) { notify('Not enough coins (need 500)', 'error'); return; }
  const rarityColors = { Common:'#888', Rare:'#3498db', Epic:'#8b3fc8', Legendary:'#d4a017' };
  // Show opening animation
  openModal(`
    <div class="text-center" style="padding:2rem">
      <div style="font-size:4rem;margin-bottom:1rem;animation:coach-enter 0.5s ease">🎒</div>
      <h3>Opening Coach Pack...</h3>
    </div>`);
  try {
    const data = await api('/coach-packs/open', 'POST');
    S.user.coins -= 500;
    updateNavCoins();
    const ch = data.coach;
    S.myCoaches.push(ch);
    const rc = rarityColors[ch.rarity] || '#888';
    const buffLabel = {
      atk_bonus:   `+${Math.round(ch.buff_value*100)}% Attack`,
      def_bonus:   `+${Math.round(ch.buff_value*100)}% Defense`,
      crit_bonus:  `+${Math.round(ch.buff_value*100)}% Crit chance`,
      orb_start:   `Start with +${ch.buff_value} Orb(s)`,
      heal_bonus:  `+${ch.buff_value} Heal use(s)`,
      coins_bonus: `${ch.buff_value}× Coins`,
    }[ch.buff_type] || ch.description;
    openModal(`
      <div class="text-center" style="padding:1.5rem">
        <div style="font-size:0.85rem;color:${rc};font-weight:700;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:0.5rem">${ch.rarity} Coach</div>
        <div class="coach-reveal-portrait" style="border-color:${rc}">${ch.portrait}</div>
        <h2 style="color:${rc};margin:0.8rem 0 0.3rem">${ch.name}</h2>
        <div class="coach-pack-sub" style="font-size:1rem;color:var(--gold);font-weight:700;margin-bottom:0.3rem">${buffLabel}</div>
        <div class="text-muted" style="font-size:0.85rem;margin-bottom:1.5rem">${ch.description}</div>
        <div style="display:flex;gap:0.8rem;justify-content:center">
          <button class="btn btn-primary" onclick="equipCoach(${ch.id});closeModal()">Equip Now</button>
          <button class="btn" onclick="closeModal()">Later</button>
        </div>
      </div>`);
  } catch(e) { notify(e.message,'error'); closeModal(); }
};

// ─── TRAITS ──────────────────────────────────────────────────────
async function loadMyTraits() {
  try {
    const data = await api('/traits');
    S.myTraits = data.traits || [];
    S.myCardTraits = data.cardTraits || {};
    render();
  } catch(e) { /* silent */ }
}

window.showEquipTrait = (cardId) => {
  const unequipped = S.myTraits;
  if (!unequipped.length) {
    openModal(`<div class="text-center"><h3>No Traits Available</h3><p class="text-muted mt-2">Traits drop from Conquest stages (10%) and bosses (20%). Complete stages to earn them!</p><button class="btn mt-2" onclick="closeModal()">Close</button></div>`);
    return;
  }
  const rarityColors = { Common:'#888', Rare:'#3498db', Legendary:'#d4a017', Secret:'#e74c3c' };
  const traitList = unequipped.map(t => {
    const rc = rarityColors[t.rarity] || '#888';
    return `<div class="trait-equip-row" style="border-color:${rc}">
      <div>
        <span class="trait-badge trait-${t.rarity.toLowerCase()}">${t.rarity}</span>
        <strong style="color:${rc}">${t.name}</strong>
        <div class="text-muted" style="font-size:0.85rem;margin-top:0.2rem">${t.description}</div>
      </div>
      <button class="btn btn-primary btn-sm" onclick="doEquipTrait(${t.trait_id||t.id},${cardId})">Equip</button>
    </div>`;
  }).join('');
  openModal(`<h3 style="margin-bottom:1rem">Equip Trait (Permanent)</h3>
    <p class="text-muted mb-2" style="font-size:0.85rem">⚠️ Traits are permanent once equipped. Choose carefully.</p>
    <div class="trait-equip-list">${traitList}</div>
    <div class="text-center mt-2"><button class="btn" onclick="closeModal()">Cancel</button></div>`);
};

window.doEquipTrait = async (traitId, cardId) => {
  try {
    const r = await api('/traits/equip','POST',{ traitId, cardId });
    notify(r.message, 'success');
    closeModal();
    await loadMyTraits();
  } catch(e) { notify(e.message,'error'); }
};

// ─── QUESTS & BATTLEPASS ─────────────────────────────────────────

async function loadQuests() {
  try {
    const [qd, bpd] = await Promise.all([api('/quests'), api('/battlepass')]);
    S.myQuests = qd.quests || [];
    S.myBattlepass = bpd.battlepass;
    S.bpRewards = bpd.rewards || [];
    document.getElementById('page').innerHTML = viewQuests();
    attachListeners();
  } catch(e) { notify(e.message, 'error'); }
}

async function loadBattlepass() {
  try {
    const d = await api('/battlepass');
    S.myBattlepass = d.battlepass;
    S.bpRewards = d.rewards || [];
    document.getElementById('page').innerHTML = viewBattlepass();
    attachListeners();
  } catch(e) { notify(e.message, 'error'); }
}

function viewQuests() {
  const quests = S.myQuests;
  if (!quests.length) return `<div class="page-title"><h2>Quests</h2></div><div class="sketch-box text-center" style="padding:2rem"><div style="font-size:3rem">📋</div><p class="text-muted">Loading quests...</p></div>`;
  const daily  = quests.filter(q => q.category === 'daily');
  const weekly = quests.filter(q => q.category === 'weekly');

  const bp = S.myBattlepass;
  const bpXp    = bp?.xp || 0;
  const bpLevel = bp?.level || 0;
  const nextR   = S.bpRewards.find(r => r.level === bpLevel + 1);
  const prevR   = S.bpRewards.find(r => r.level === bpLevel);
  const prevXp  = prevR?.xp_required || 0;
  const nextXp  = nextR?.xp_required || (S.bpRewards[S.bpRewards.length-1]?.xp_required || 15000);
  const segPct  = bpLevel >= 30 ? 100 : Math.min(100, Math.round(((bpXp - prevXp) / (nextXp - prevXp)) * 100));
  const xpToNext = nextR ? nextXp - bpXp : null;

  // Tally claimed / total
  const totalQ = quests.length;
  const doneQ  = quests.filter(q => q.claimed).length;
  const pendingClaim = quests.filter(q => q.completed && !q.claimed).length;

  const renderQuest = q => {
    const pct = Math.min(100, Math.round((q.progress / q.target) * 100));
    let state = '';
    if (q.claimed)         state = 'qc-claimed';
    else if (q.completed)  state = 'qc-ready';
    return `
    <div class="qc ${state}">
      <div class="qc-left">
        <div class="qc-icon-wrap ${state}">${q.icon}</div>
      </div>
      <div class="qc-body">
        <div class="qc-top-row">
          <span class="qc-name">${q.name}</span>
          <span class="qc-xp">+${q.xp_reward} XP</span>
        </div>
        <div class="qc-desc">${q.description}</div>
        <div class="qc-progress-row">
          <div class="qc-bar-outer">
            <div class="qc-bar ${state}" style="width:${pct}%"></div>
          </div>
          <span class="qc-count">${q.progress}/${q.target}</span>
        </div>
      </div>
      <div class="qc-action">
        ${q.claimed
          ? `<div class="qc-check">✓</div>`
          : q.completed
            ? `<button class="qc-claim-btn" onclick="claimQuest(${q.id})">Claim</button>`
            : `<div class="qc-pct-ring"><svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="15.9" fill="none" stroke="#1e1e2e" stroke-width="3"/><circle cx="18" cy="18" r="15.9" fill="none" stroke="#4dd9ff" stroke-width="3" stroke-dasharray="${pct} ${100-pct}" stroke-dashoffset="25" stroke-linecap="round"/></svg><span>${pct}%</span></div>`}
      </div>
    </div>`;
  };

  const renderSection = (list, label, sub) => {
    const claimable = list.filter(q => q.completed && !q.claimed).length;
    return `
    <div class="qs-panel">
      <div class="qs-panel-header">
        <div class="qs-panel-title">${label}<span class="qs-panel-sub">${sub}</span></div>
        <div class="qs-panel-stats">
          <span class="qs-count-badge">${list.filter(q=>q.claimed).length}/${list.length} done</span>
          ${claimable ? `<span class="qs-claim-all-badge">${claimable} ready</span>` : ''}
        </div>
      </div>
      <div class="qs-list">
        ${list.length ? list.map(renderQuest).join('') : '<p class="text-muted" style="padding:0.75rem 0 0.25rem">No quests assigned.</p>'}
      </div>
    </div>`;
  };

  return `
  <div class="page-title"><h2>Quests</h2><p class="text-muted">Complete quests · Earn XP · Level up your Battle Pass</p></div>

  <div class="qs-bp-banner sketch-box">
    <div class="qs-bp-left">
      <div class="qs-bp-level">
        <span class="qs-bp-num">${bpLevel}</span>
        <span class="qs-bp-label">Battle Pass Level</span>
      </div>
      <div class="qs-bp-bar-col">
        <div class="qs-bp-bar-outer">
          <div class="qs-bp-bar" style="width:${segPct}%"></div>
        </div>
        <div class="qs-bp-subtext">
          ${bpXp.toLocaleString()} XP total
          ${xpToNext !== null ? ` · <strong>${xpToNext.toLocaleString()} XP</strong> to level ${bpLevel+1}` : ' · <strong>Max level!</strong>'}
        </div>
      </div>
    </div>
    <div class="qs-bp-right">
      <div class="qs-quest-tally">${doneQ}/${totalQ} quests done${pendingClaim ? ` · <span style="color:var(--gold)">${pendingClaim} to claim</span>` : ''}</div>
      <button class="btn btn-gold btn-sm" onclick="nav('battlepass')">Battle Pass →</button>
    </div>
  </div>

  <div class="qs-panels">
    ${renderSection(daily,  '📅 Daily',  'Resets at midnight')}
    ${renderSection(weekly, '📆 Weekly', 'Resets weekly')}
  </div>`;
}

function viewBattlepass() {
  const bp = S.myBattlepass;
  const rewards = S.bpRewards;
  if (!bp) return `<div class="page-title"><h2>Battle Pass</h2></div><div class="sketch-box text-center" style="padding:2rem"><div style="font-size:3rem">🏆</div><p class="text-muted">Loading...</p></div>`;

  const currentLevel = bp.level || 0;
  const currentXp    = bp.xp || 0;
  const claimedLevels = bp.claimed_levels || [];
  const totalXpForMax = rewards[rewards.length - 1]?.xp_required || 15000;
  const nextReward    = rewards.find(r => r.level === currentLevel + 1);
  const prevReward    = rewards.find(r => r.level === currentLevel);
  const prevXp  = prevReward?.xp_required || 0;
  const nextXp  = nextReward?.xp_required || totalXpForMax;
  const segPct  = currentLevel >= 30 ? 100 : Math.min(100, Math.round(((currentXp - prevXp) / (nextXp - prevXp)) * 100));
  const overallPct = Math.min(100, Math.round((currentXp / totalXpForMax) * 100));

  // Group rewards into rows of 5
  const ROW_SIZE = 5;
  const rows = [];
  for (let i = 0; i < rewards.length; i += ROW_SIZE) {
    rows.push(rewards.slice(i, i + ROW_SIZE));
  }

  const renderRow = (rowRewards, rowIdx) => {
    const nodes = rowRewards.map(r => {
      const unlocked  = currentLevel >= r.level;
      const claimed   = claimedLevels.includes(r.level);
      const canClaim  = unlocked && !claimed;
      const isCurrent = r.level === currentLevel + 1;
      let stateClass = 'bp-node-locked';
      if (claimed)   stateClass = 'bp-node-claimed';
      else if (canClaim) stateClass = 'bp-node-claimable';
      else if (unlocked) stateClass = 'bp-node-unlocked';

      return `
      <div class="bp-node ${stateClass}${isCurrent ? ' bp-node-current' : ''}">
        <div class="bp-node-level">Lv.${r.level}</div>
        <div class="bp-node-icon">${r.reward_icon}</div>
        <div class="bp-node-label">${r.reward_label}</div>
        <div class="bp-node-xp">${r.xp_required.toLocaleString()} XP</div>
        ${claimed
          ? `<div class="bp-node-check">✓</div>`
          : canClaim
            ? `<button class="bp-node-btn" onclick="claimBpReward(${r.level})">Claim!</button>`
            : ``}
      </div>`;
    }).join('');

    // Progress line fill: how far through this row is the player?
    // Row spans levels (rowIdx*ROW_SIZE+1) to (rowIdx*ROW_SIZE+ROW_SIZE)
    const rowStart = rowIdx * ROW_SIZE + 1;
    const rowEnd   = rowStart + ROW_SIZE - 1;
    let linePct = 0;
    if (currentLevel >= rowEnd) linePct = 100;
    else if (currentLevel >= rowStart) {
      // partially through this row
      const stepsIn = currentLevel - rowStart + 1;
      linePct = Math.round((stepsIn / ROW_SIZE) * 100);
    }

    return `
    <div class="bp-row">
      <div class="bp-row-track">
        <div class="bp-row-line"><div class="bp-row-line-fill" style="width:${linePct}%"></div></div>
        <div class="bp-row-nodes">${nodes}</div>
      </div>
    </div>`;
  };

  const rowsHtml = rows.map((r, i) => renderRow(r, i)).join('');

  return `
  <div class="page-title"><h2>⚔️ Battle Pass — Season 1</h2><p class="text-muted">Earn XP from quests to unlock rewards across 30 levels</p></div>

  <div class="bp-progress-card sketch-box">
    <div class="bp-progress-top">
      <div class="bp-progress-level">
        <span class="bp-big-level">${currentLevel}</span>
        <span class="bp-max-level">/ 30</span>
      </div>
      <div class="bp-progress-mid">
        <div class="bp-progress-label-row">
          <span class="bp-progress-title">Season 1 Progress</span>
          <span class="bp-progress-xp-text">${currentXp.toLocaleString()} / ${totalXpForMax.toLocaleString()} XP</span>
        </div>
        <div class="bp-progress-bar-outer">
          <div class="bp-progress-bar" style="width:${overallPct}%"></div>
          <div class="bp-progress-bar-glow" style="left:${overallPct}%"></div>
        </div>
        <div class="bp-progress-next">
          ${currentLevel < 30
            ? `Next level at <strong>${nextXp.toLocaleString()} XP</strong> — <strong>${(nextXp - currentXp).toLocaleString()} XP</strong> to go`
            : `<span style="color:#f5c518;font-weight:700">🏆 Max Level Reached!</span>`}
        </div>
      </div>
      <button class="btn btn-gold btn-sm" onclick="nav('quests')" style="flex-shrink:0">📋 Quests</button>
    </div>
    <div class="bp-seg-bar-outer">
      ${rewards.map(r => {
        const done = claimedLevels.includes(r.level);
        const unlocked = currentLevel >= r.level;
        const color = done ? '#2ecc71' : unlocked ? 'var(--gold)' : '#2a2a3a';
        return `<div class="bp-seg" style="background:${color}" title="Lv.${r.level}"></div>`;
      }).join('')}
    </div>
  </div>

  <div class="bp-track">${rowsHtml}</div>`;
}

window.claimQuest = async (questId) => {
  try {
    const r = await api(`/quests/${questId}/claim`, 'POST');
    notify(`+${r.xpGained} XP! Battle Pass: Lv.${r.level}`, 'success');
    // Refresh both quests and battlepass state
    const [qd, bpd] = await Promise.all([api('/quests'), api('/battlepass')]);
    S.myQuests = qd.quests || [];
    S.myBattlepass = bpd.battlepass;
    S.bpRewards = bpd.rewards || [];
    document.getElementById('page').innerHTML = viewQuests();
    attachListeners();
  } catch(e) { notify(e.message, 'error'); }
};

window.claimBpReward = async (level) => {
  try {
    const r = await api(`/battlepass/claim/${level}`, 'POST');
    notify(`Claimed: ${r.reward.reward_label}!`, 'success');
    S.user.coins = r.newCoins;
    updateNavCoins();
    const bpd = await api('/battlepass');
    S.myBattlepass = bpd.battlepass;
    S.bpRewards = bpd.rewards || [];
    document.getElementById('page').innerHTML = viewBattlepass();
    attachListeners();
  } catch(e) { notify(e.message, 'error'); }
};

// ─── FRIENDS ──────────────────────────────────────────────────────
function viewFriends() {
  const accepted = S.friends.filter(f => f.status === 'accepted');
  const pending  = S.friends.filter(f => f.status === 'pending');

  const friendList = accepted.length
    ? accepted.map(f => {
        const unread = S.dmUnread[f.other_user_id] || 0;
        const isActive = S.friendsChatWith?.userId === f.other_user_id;
        const safeName = f.username.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
        return `<div class="friend-item${isActive ? ' friend-item-active' : ''}" onclick="openFriendsChat(${f.other_user_id},'${safeName}')">
          <div class="friend-avatar">${_av(f, 40)}</div>
          <div class="friend-info">
            <div class="friend-name">${f.username} <span class="role-badge role-${f.role}">${f.role}</span>${unread ? `<span class="dm-badge">${unread}</span>` : ''}</div>
            <div class="friend-meta">Rating: ${f.rating||1000} &bull; ${f.rank_title||'Bronze'}</div>
          </div>
          <button class="btn btn-sm" onclick="event.stopPropagation();removeFriend(${f.id})">Remove</button>
        </div>`;
      }).join('')
    : '<p class="text-muted" style="padding:0.8rem 0">No friends yet. Search for players below!</p>';

  const pendingList = pending.length
    ? pending.map(f => `<div class="friend-item">
        <div class="friend-avatar">${_av(f, 40)}</div>
        <div class="friend-info"><div class="friend-name">${f.username}</div><div class="friend-meta">Pending request</div></div>
        ${f.i_sent_it
          ? `<span class="text-muted" style="font-size:0.85rem">Awaiting response</span>`
          : `<button class="btn btn-green btn-sm" onclick="acceptFriend(${f.id})">Accept</button>
             <button class="btn btn-sm" onclick="removeFriend(${f.id})">Decline</button>`}
      </div>`).join('')
    : '';

  let chatPanel = '';
  if (S.friendsChatWith) {
    const msgs = S.friendsChatMsgs.map(m => {
      const mine = m.sender_id === S.user.id;
      const time = new Date(m.created_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
      return `<div class="dm-msg ${mine ? 'dm-mine' : 'dm-theirs'}">
        <div class="dm-bubble">${escHtml(m.message)}</div>
        <div class="dm-time">${time}</div>
      </div>`;
    }).join('');
    chatPanel = `<div class="friends-page-right">
      <div class="friends-chat-panel">
        <div class="friends-chat-header">
          <span>💬 ${escHtml(S.friendsChatWith.username)}</span>
          <button class="btn btn-sm" onclick="closeFriendsChat()" style="padding:0.15rem 0.5rem;font-size:0.75rem">✕</button>
        </div>
        <div class="friends-chat-msgs" id="friends-chat-msgs">${msgs || '<p class="text-muted" style="text-align:center;padding:2rem">Say hello!</p>'}</div>
        <div class="friends-chat-input-row">
          <input class="friends-chat-input" id="friends-chat-input" type="text" maxlength="500" placeholder="Message..." autocomplete="off" onkeydown="if(event.key==='Enter')sendFriendsChat()">
          <button class="btn btn-primary" onclick="sendFriendsChat()" style="font-size:0.82rem;padding:0.4rem 0.7rem">Send</button>
        </div>
      </div>
    </div>`;
  }

  return `<div class="page-title"><h2>Friends</h2></div>
    <div class="friends-page-layout${S.friendsChatWith ? ' friends-page-split' : ''}">
      <div class="friends-page-left">
        <div class="sketch-box mb-2">
          <h3 style="margin-bottom:0.8rem">Add Friend</h3>
          <div style="display:flex;gap:0.8rem;align-items:flex-end">
            <div style="flex:1"><input class="input-box" id="friend-search" placeholder="Enter username..."></div>
            <button class="btn btn-primary" onclick="sendFriendRequest()">Send Request</button>
          </div>
        </div>
        ${pending.length ? `<div class="sketch-box mb-2"><h3 style="margin-bottom:0.8rem">Pending Requests</h3><div class="friends-list">${pendingList}</div></div>` : ''}
        <div class="sketch-box">
          <h3 style="margin-bottom:0.8rem">Friends (${accepted.length})</h3>
          <div class="friends-list">${friendList}</div>
        </div>
      </div>
      ${chatPanel}
    </div>`;
}

async function sendFriendRequest() {
  const u = document.getElementById('friend-search')?.value?.trim();
  if (!u) return;
  try {
    await api('/friends/request/' + encodeURIComponent(u), 'POST');
    notify('Friend request sent to ' + u, 'success');
    document.getElementById('friend-search').value = '';
    S.friends = await api('/friends');
    document.getElementById('page').innerHTML = viewFriends();
    attachListeners();
  } catch (e) { notify(e.message, 'error'); }
}
window.sendFriendRequest = sendFriendRequest;

async function acceptFriend(id) {
  try {
    await api('/friends/' + id + '/accept', 'PUT');
    notify('Friend accepted!', 'success');
    S.friends = await api('/friends');
    document.getElementById('page').innerHTML = viewFriends();
    attachListeners();
  } catch (e) { notify(e.message, 'error'); }
}
window.acceptFriend = acceptFriend;

async function removeFriend(id) {
  try {
    await api('/friends/' + id, 'DELETE');
    S.friends = S.friends.filter(f => f.id !== id);
    document.getElementById('page').innerHTML = viewFriends();
    attachListeners();
  } catch (e) { notify(e.message, 'error'); }
}
window.removeFriend = removeFriend;

// ─── FRIENDS INLINE CHAT ──────────────────────────────────────────
async function openFriendsChat(userId, username) {
  S.friendsChatWith = { userId, username };
  delete S.dmUnread[userId];
  try { S.friendsChatMsgs = await api(`/dm/${userId}`); } catch { S.friendsChatMsgs = []; }
  document.getElementById('page').innerHTML = viewFriends();
  attachListeners();
  const msgsEl = document.getElementById('friends-chat-msgs');
  if (msgsEl) msgsEl.scrollTop = msgsEl.scrollHeight;
  startFriendsChatPolling(userId);
}
window.openFriendsChat = openFriendsChat;

function closeFriendsChat() {
  S.friendsChatWith = null;
  S.friendsChatMsgs = [];
  if (S._friendsChatPoll) { clearInterval(S._friendsChatPoll); S._friendsChatPoll = null; }
  document.getElementById('page').innerHTML = viewFriends();
  attachListeners();
}
window.closeFriendsChat = closeFriendsChat;

async function sendFriendsChat() {
  if (!S.friendsChatWith) return;
  const input = document.getElementById('friends-chat-input');
  const msg = input?.value?.trim();
  if (!msg) return;
  input.value = '';
  try {
    const sent = await api(`/dm/${S.friendsChatWith.userId}`, 'POST', { message: msg });
    S.friendsChatMsgs.push(sent);
    const msgsEl = document.getElementById('friends-chat-msgs');
    if (msgsEl) {
      const time = new Date(sent.created_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
      msgsEl.innerHTML += `<div class="dm-msg dm-mine"><div class="dm-bubble">${escHtml(sent.message)}</div><div class="dm-time">${time}</div></div>`;
      msgsEl.scrollTop = msgsEl.scrollHeight;
    }
  } catch (e) { notify(e.message, 'error'); if (input) input.value = msg; }
}
window.sendFriendsChat = sendFriendsChat;

function startFriendsChatPolling(userId) {
  if (S._friendsChatPoll) { clearInterval(S._friendsChatPoll); S._friendsChatPoll = null; }
  S._friendsChatPoll = setInterval(async () => {
    if (S.view !== 'friends' || S.friendsChatWith?.userId !== userId) {
      clearInterval(S._friendsChatPoll); S._friendsChatPoll = null; return;
    }
    try {
      const msgs = await api(`/dm/${userId}`);
      if (msgs.length !== S.friendsChatMsgs.length) {
        S.friendsChatMsgs = msgs;
        const msgsEl = document.getElementById('friends-chat-msgs');
        if (msgsEl) {
          const atBottom = msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 60;
          msgsEl.innerHTML = msgs.map(m => {
            const mine = m.sender_id === S.user.id;
            const time = new Date(m.created_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
            return `<div class="dm-msg ${mine?'dm-mine':'dm-theirs'}"><div class="dm-bubble">${escHtml(m.message)}</div><div class="dm-time">${time}</div></div>`;
          }).join('');
          if (atBottom) msgsEl.scrollTop = msgsEl.scrollHeight;
        }
      }
    } catch {}
  }, 2000);
}

function _rerenderFriendsPage() {
  const savedInput = document.getElementById('friends-chat-input')?.value || '';
  const msgsEl = document.getElementById('friends-chat-msgs');
  const atBottom = msgsEl ? msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 60 : true;
  document.getElementById('page').innerHTML = viewFriends();
  attachListeners();
  const inp = document.getElementById('friends-chat-input');
  if (inp && savedInput) inp.value = savedInput;
  const newMsgsEl = document.getElementById('friends-chat-msgs');
  if (newMsgsEl && atBottom) newMsgsEl.scrollTop = newMsgsEl.scrollHeight;
}

// ─── FRIEND CHAT (standalone page) ───────────────────────────────
async function openChat(userId, username) {
  S.chatWith = { userId, username };
  S.chatMessages = [];
  nav('chat');
  try {
    S.chatMessages = await api(`/dm/${userId}`);
    // Clear unread badge for this user
    delete S.dmUnread[userId];
    document.getElementById('page').innerHTML = viewChat();
    attachListeners();
    _scrollChat();
  } catch (e) { notify(e.message, 'error'); }
  startChatPolling(userId);
}
window.openChat = openChat;

function viewChat() {
  const f = S.chatWith;
  if (!f) return '<div class="page-title"><h2>Chat</h2></div>';
  const msgs = S.chatMessages.map(m => {
    const mine = m.sender_id === S.user.id;
    const time = new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `<div class="dm-msg ${mine ? 'dm-mine' : 'dm-theirs'}">
      <div class="dm-bubble">${escHtml(m.message)}</div>
      <div class="dm-time">${time}</div>
    </div>`;
  }).join('');
  return `<div class="page-title" style="display:flex;align-items:center;gap:1rem">
    <button class="btn btn-sm" onclick="nav('friends')">← Back</button>
    <h2 style="margin:0">${escHtml(f.username)}</h2>
  </div>
  <div class="dm-window">
    <div class="dm-messages" id="dm-messages">${msgs || '<p class="text-muted" style="text-align:center;padding:2rem">No messages yet. Say hello!</p>'}</div>
    <div class="dm-input-bar">
      <input class="input-box dm-input" id="dm-input" placeholder="Message ${escHtml(f.username)}..." maxlength="500" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendDm();}">
      <button class="btn btn-primary" onclick="sendDm()">Send</button>
    </div>
  </div>`;
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function sendDm() {
  const input = document.getElementById('dm-input');
  const msg = input?.value?.trim();
  if (!msg || !S.chatWith) return;
  input.value = '';
  try {
    const sent = await api(`/dm/${S.chatWith.userId}`, 'POST', { message: msg });
    S.chatMessages.push(sent);
    const msgsEl = document.getElementById('dm-messages');
    if (msgsEl) {
      const time = new Date(sent.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      msgsEl.innerHTML += `<div class="dm-msg dm-mine"><div class="dm-bubble">${escHtml(sent.message)}</div><div class="dm-time">${time}</div></div>`;
      _scrollChat();
    }
  } catch (e) { notify(e.message, 'error'); if (input) input.value = msg; }
}
window.sendDm = sendDm;

function _scrollChat() {
  const el = document.getElementById('dm-messages');
  if (el) el.scrollTop = el.scrollHeight;
}

function startChatPolling(userId) {
  if (S._chatInterval) { clearInterval(S._chatInterval); S._chatInterval = null; }
  S._chatInterval = setInterval(async () => {
    if (S.view !== 'chat' || S.chatWith?.userId !== userId) { clearInterval(S._chatInterval); S._chatInterval = null; return; }
    try {
      const msgs = await api(`/dm/${userId}`);
      if (msgs.length !== S.chatMessages.length) {
        const atBottom = (() => { const el = document.getElementById('dm-messages'); return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 60; })();
        S.chatMessages = msgs;
        const msgsEl = document.getElementById('dm-messages');
        if (msgsEl) {
          msgsEl.innerHTML = msgs.map(m => {
            const mine = m.sender_id === S.user.id;
            const time = new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            return `<div class="dm-msg ${mine ? 'dm-mine' : 'dm-theirs'}"><div class="dm-bubble">${escHtml(m.message)}</div><div class="dm-time">${time}</div></div>`;
          }).join('');
          if (atBottom) _scrollChat();
        }
      }
    } catch {}
  }, 2000);
}

// ─── PLAYER CARD ──────────────────────────────────────────────────
function renderPlayerCard(player, rankPos) {
  const rank   = player.rank_title || 'Bronze';
  const rating = player.rating     || 1000;
  const wins   = player.wins       || 0;
  const losses = player.losses     || 0;
  const total  = wins + losses;
  const wr     = total > 0 ? Math.round((wins / total) * 100) : 0;
  const color  = player.avatar_color || '#c0392b';

  // Map rank title → card rarity class for border/glow
  const rarityMap = {
    bronze:'rarity-common', silver:'rarity-uncommon', gold:'rarity-rare',
    platinum:'rarity-ultra_rare', diamond:'rarity-mythic',
    master:'rarity-prism', grandmaster:'rarity-numbered',
    champion:'rarity-mythic', developer:'rarity-prism'
  };
  const rarityClass = rarityMap[(rank).toLowerCase()] || 'rarity-common';

  // Rating bar (0-3000 range)
  const ratingPct = Math.min(100, Math.round((rating / 3000) * 100));
  const ratingColor = rating >= 2000 ? '#f0c040' : rating >= 1500 ? '#00b4e6' : rating >= 1200 ? '#9b59b6' : '#7f8c8d';

  const initial = (player.username || '?')[0].toUpperCase();
  const posLabel = rankPos ? (rankPos <= 3 ? ['1st','2nd','3rd'][rankPos-1] : '#' + rankPos) : '';

  return `<div class="tcg-card player-card ${rarityClass}" onclick="showPlayerCardModal(${JSON.stringify(player).replace(/"/g,'&quot;')},${rankPos||0})">
    <div class="card-header">
      <span class="card-name">${player.username}</span>
      <span class="card-hp" style="color:${ratingColor}">${rating} <span style="font-size:0.65rem;opacity:0.7">ELO</span></span>
    </div>
    <div class="card-art player-card-art" style="background:radial-gradient(circle at 60% 35%, ${color}55, ${color}22 60%, #050810)">
      <div class="player-card-avatar" style="box-shadow:0 0 18px ${color}88">${_av(player, 52)}</div>
      ${player.top500 ? `<div class="player-card-top500">TOP 500</div>` : ''}
      ${posLabel ? `<div class="player-card-rank">${posLabel}</div>` : ''}
      <div style="position:absolute;bottom:0;left:0;right:0;height:5px;background:rgba(0,0,0,0.4)">
        <div style="height:100%;width:${ratingPct}%;background:${ratingColor};transition:width 0.4s"></div>
      </div>
    </div>
    <div class="card-type-bar" style="background:${color}">${rank} ${player.role && player.role !== 'user' ? '· ' + player.role : ''}</div>
    <div class="card-body">
      <div class="card-ability-name">
        <span>Battle Record</span>
        <span class="ability-power" style="color:${ratingColor}">${wr}%</span>
      </div>
      <div class="card-ability-desc">${wins}W / ${losses}L &mdash; Win Rate: ${wr}%</div>
      <div class="card-stats">
        <div class="stat-item"><span class="stat-label">WIN</span><span class="stat-val" style="color:#2ecc71">${wins}</span></div>
        <div class="stat-item"><span class="stat-label">LOSS</span><span class="stat-val" style="color:#e74c3c">${losses}</span></div>
        <div class="stat-item"><span class="stat-label">GAME</span><span class="stat-val">${total}</span></div>
        <div class="stat-item"><span class="stat-label">WR%</span><span class="stat-val" style="color:${ratingColor}">${wr}</span></div>
      </div>
    </div>
    <div class="card-footer">
      <span>Joined: ${new Date(player.created_at||Date.now()).toLocaleDateString('en-US',{month:'short',year:'numeric'})}</span>
      <span class="card-number">${posLabel}</span>
    </div>
  </div>`;
}

window.showPlayerCardModal = (player, rankPos) => {
  openModal(`<div style="display:flex;flex-direction:column;align-items:center;gap:1rem;padding:0.5rem">
    ${renderPlayerCard(player, rankPos)}
    <div class="flex gap-2">
      <button class="btn btn-primary" onclick="closeModal();openProfile('${player.username}')">View Profile</button>
      <button class="btn" onclick="closeModal()">Close</button>
    </div>
  </div>`);
};

// ─── LEADERBOARD ──────────────────────────────────────────────────
function rankClass(r) {
  const m = {bronze:'rt-bronze',silver:'rt-silver',gold:'rt-gold',platinum:'rt-platinum',diamond:'rt-diamond',master:'rt-master',grandmaster:'rt-grandmaster',developer:'rt-developer'};
  return m[(r||'').toLowerCase()] || 'rt-bronze';
}

function viewLeaderboard(mode) {
  const viewMode = mode || S._lbMode || 'cards';
  S._lbMode = viewMode;
  const myPos = S.leaderboard.findIndex(p => S.user && p.id === S.user.id);

  const tableRows = S.leaderboard.map((p,i) => {
    const isSelf = S.user && p.id === S.user.id;
    const rankNum = p.rank || (i+1);
    return `<tr class="${rankNum===1?'rank-1':rankNum===2?'rank-2':rankNum===3?'rank-3':''}${isSelf?' current-user':''}" onclick="showPlayerCardModal(${JSON.stringify(p).replace(/"/g,'&quot;')},${rankNum})" style="cursor:pointer">
      <td>${rankNum <= 3 ? ['🥇','🥈','🥉'][rankNum-1] : '#' + rankNum}</td>
      <td>
        <span style="font-weight:700">${p.username}</span>
        ${p.top500 ? '<span class="top500-badge" style="margin-left:6px">TOP 500</span>' : ''}
        ${isSelf ? '<span class="badge" style="margin-left:6px;color:var(--cyan)">You</span>' : ''}
      </td>
      <td>${p.rating}</td>
      <td><span class="rank-title-badge ${rankClass(p.rank_title)}">${p.rank_title}</span></td>
      <td class="text-green">${p.wins}</td>
      <td class="text-red">${p.losses}</td>
    </tr>`;
  }).join('');

  const cardGrid = S.leaderboard.map((p,i) => renderPlayerCard(p, p.rank || (i+1))).join('');

  return `<div class="page-title"><h2>Leaderboard</h2><p class="text-muted">Top 500 ranked players this season</p></div>
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:0.75rem;margin-bottom:1rem">
      ${myPos !== -1 ? `<div class="sketch-box" style="display:inline-block;padding:0.5rem 1rem">
        <span>Your rank: <strong>#${myPos+1}</strong>
        ${S.myRank?.top500 ? '<span class="top500-badge" style="margin-left:6px">TOP 500</span>' : ''}</span>
      </div>` : '<div></div>'}
      <div style="display:flex;gap:0.5rem">
        <button class="btn btn-sm${viewMode==='cards'?' btn-primary':''}" onclick="switchLbMode('cards')">Cards</button>
        <button class="btn btn-sm${viewMode==='table'?' btn-primary':''}" onclick="switchLbMode('table')">Table</button>
      </div>
    </div>
    ${viewMode === 'cards'
      ? `<div class="lb-card-grid">${cardGrid || '<p class="text-muted text-center">No ranked players yet.</p>'}</div>`
      : `<div style="overflow-x:auto"><table class="leaderboard-table">
          <thead><tr><th>Rank</th><th>Player</th><th>Rating</th><th>Title</th><th>Wins</th><th>Losses</th></tr></thead>
          <tbody>${tableRows || '<tr><td colspan="6" class="text-muted text-center" style="padding:1rem">No ranked players yet.</td></tr>'}</tbody>
        </table></div>`}`;
}
window.switchLbMode = (mode) => { document.getElementById('page').innerHTML = viewLeaderboard(mode); attachListeners(); };

// ─── NEWS ─────────────────────────────────────────────────────────
function viewNews() {
  const items = S.news.map(n => `
    <div class="news-item sketch-box mb-2">
      <div class="news-header">
        <h3 class="news-title">${n.title}</h3>
        <span class="news-meta">
          <span class="role-badge role-${n.author_role||'developer'}">${n.author_name}</span>
          &nbsp; ${new Date(n.created_at).toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})}
          ${n.updated_at !== n.created_at ? `<span class="text-muted" style="font-size:0.78rem"> (edited)</span>` : ''}
        </span>
      </div>
      <div class="news-body">${n.body.replace(/\n/g,'<br>')}</div>
    </div>`).join('') || `<div class="sketch-box text-center"><p class="text-muted">No news posts yet. Check back soon.</p></div>`;
  return `<div class="page-title"><h2>News</h2><p class="text-muted">Updates, patch notes, and announcements from the development team</p></div>
    ${items}`;
}

// ─── REPORTS ──────────────────────────────────────────────────────
function viewReports() {
  const myReports = S.reports.map(r => {
    const pri = r.priority || 'normal';
    return `<div class="report-item">
      <div class="report-header">
        <div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap">
          <strong>Reported: <span class="profile-link" onclick="openProfile('${r.reported_username}')">${r.reported_username}</span></strong>
          <span class="text-muted" style="font-size:0.85rem">${r.category}</span>
          <span class="priority-badge priority-${pri}">${pri}</span>
        </div>
        <span class="report-status status-${r.status}">${r.status.charAt(0).toUpperCase() + r.status.slice(1)}</span>
      </div>
      <p style="font-size:0.9rem;margin:0.4rem 0">${r.description}</p>
      ${r.handler_notes ? `<p style="font-size:0.84rem;color:var(--gold);margin-top:0.3rem">Staff note: ${r.handler_notes}</p>` : ''}
      <p class="text-muted" style="font-size:0.78rem;margin-top:0.3rem">${new Date(r.created_at).toLocaleString()}</p>
    </div>`;
  }).join('') || '<p class="text-muted">You have not submitted any reports.</p>';
  return `<div class="page-title"><h2>Reports</h2></div>
    <div class="sketch-box mb-3">
      <h3 style="margin-bottom:1rem">Submit a Report</h3>
      <div class="form-group"><label>Reported Username</label><input id="rep-user" class="input-box" placeholder="Username to report"></div>
      <div class="form-group"><label>Category</label>
        <select id="rep-cat" class="input-box">
          <option value="cheating">Cheating</option>
          <option value="harassment">Harassment</option>
          <option value="bug">Bug Report</option>
          <option value="inappropriate">Inappropriate Behavior</option>
          <option value="scamming">Scamming</option>
          <option value="other">Other</option>
        </select>
      </div>
      <div class="form-group"><label>Priority</label>
        <select id="rep-priority" class="input-box">
          <option value="low">Low — minor issue</option>
          <option value="normal" selected>Normal — standard report</option>
          <option value="high">High — serious violation</option>
          <option value="urgent">Urgent — immediate action needed</option>
        </select>
      </div>
      <div class="form-group"><label>Description (be specific)</label>
        <textarea id="rep-desc" class="input-box" placeholder="Describe the issue in detail. Include context, what happened, when..."></textarea>
      </div>
      <div class="form-group"><label>Evidence URL (optional)</label>
        <input id="rep-evidence" class="input-box" placeholder="Link to screenshot, clip, etc.">
      </div>
      <button class="btn btn-primary" onclick="submitReport()">Submit Report</button>
    </div>
    <div class="sketch-box">
      <h3 style="margin-bottom:1rem">My Reports</h3>
      ${myReports}
    </div>`;
}

async function submitReport() {
  const u = document.getElementById('rep-user')?.value?.trim();
  const c = document.getElementById('rep-cat')?.value;
  const d = document.getElementById('rep-desc')?.value?.trim();
  const priority = document.getElementById('rep-priority')?.value || 'normal';
  const evidence_url = document.getElementById('rep-evidence')?.value?.trim() || null;
  if (!u || !d) { notify('Please fill in all fields', 'error'); return; }
  try {
    await api('/reports','POST',{reported_username:u, category:c, description:d, priority, evidence_url});
    notify('Report submitted. Thank you.', 'success');
    document.getElementById('rep-user').value = '';
    document.getElementById('rep-desc').value = '';
    S.reports = await api('/reports/mine');
    document.getElementById('page').innerHTML = viewReports();
    attachListeners();
  } catch (e) { notify(e.message, 'error'); }
}
window.submitReport = submitReport;

// ─── SETTINGS ─────────────────────────────────────────────────────
function viewSettings() {
  const cfg = S.settings;
  const tabs = ['profile','account','appearance','privacy'];
  const tabBar = tabs.map(t => `<div class="settings-nav-item${S.settingsTab===t?' active':''}" onclick="setSettingsTab('${t}')">${t.charAt(0).toUpperCase()+t.slice(1)}</div>`).join('');
  const colorSwatches = COLORS.map(c => `<div class="color-swatch${(S.user?.avatar_color||'#c0392b')===c?' selected':''}" style="background:${c}" onclick="setAvatarColor('${c}')"></div>`).join('');
  const sections = {
    profile: `
      <h3 class="mb-2">Profile</h3>
      <div class="form-group">
        <label>Username</label>
        <input class="input-box" value="${S.user?.username||''}" disabled style="opacity:0.6">
      </div>
      <div class="form-group">
        <label>Bio (max 200 chars)</label>
        <textarea id="bio-input" class="input-box">${S.user?.bio||''}</textarea>
      </div>
      <button class="btn btn-primary" onclick="saveBio()">Save Bio</button>
      <div class="form-group mt-2">
        <label>Avatar Color</label>
        <div class="color-swatches">${colorSwatches}</div>
      </div>
      <div class="form-group mt-2">
        <label>Avatar Icon</label>
        <div style="display:flex;align-items:center;gap:1rem;margin-bottom:0.75rem">
          <div style="flex-shrink:0">${_av(S.user, 64)}</div>
          <div>
            <p class="text-muted" style="font-size:0.82rem;margin-bottom:0.4rem">Choose a preset icon or upload your own image</p>
            <button class="btn btn-sm" onclick="document.getElementById('avatar-file-input').click()">📁 Upload Photo</button>
            <input id="avatar-file-input" type="file" accept="image/*" style="display:none" onchange="handleAvatarFile(this)">
          </div>
        </div>
        <div class="avatar-preset-grid">${
          ['⚔️','🛡️','🐉','🦁','🔥','💧','🌙','⭐','⚡','❄️','🌿','☠️',
           '🦊','🐺','🦅','🦋','🌸','💀','🔮','🌊','🏹','🗡️','👑','🎭'].map(e =>
            `<div class="avatar-preset${S.user?.avatar_img==='emoji:'+e?' selected':''}" onclick="setAvatarEmoji('${e}')">${e}</div>`
          ).join('')
        }</div>
      </div>`,
    account: `
      <h3 class="mb-2">Account</h3>
      <div class="form-group">
        <label>Current Password</label>
        <input id="pw-cur" type="password" class="input-box" placeholder="Current password">
      </div>
      <div class="form-group">
        <label>New Password</label>
        <input id="pw-new" type="password" class="input-box" placeholder="New password (8+ chars)">
      </div>
      <div class="form-group">
        <label>Confirm New Password</label>
        <input id="pw-new2" type="password" class="input-box" placeholder="Confirm new password">
      </div>
      <button class="btn btn-primary" onclick="changePassword()">Change Password</button>
      <div class="danger-zone">
        <h4>Danger Zone</h4>
        <button class="btn btn-red" onclick="deleteAccount()">Delete Account</button>
      </div>`,
    appearance: `
      <h3 class="mb-2">Appearance</h3>
      <div class="form-group">
        <label>Theme</label>
        <select id="theme-select" class="input-box" onchange="applyTheme(this.value)">
          <option value="default"${(cfg.theme||'default')==='default'?' selected':''}>Default (Paper)</option>
          <option value="dark"${cfg.theme==='dark'?' selected':''}>Dark</option>
          <option value="sepia"${cfg.theme==='sepia'?' selected':''}>Sepia</option>
        </select>
      </div>
      <div class="form-group">
        <label>Music Volume <span id="vol-label">${Math.round(Music.volume * 100)}%</span></label>
        <input type="range" id="vol-slider" class="vol-slider" min="0" max="1" step="0.01" value="${Music.volume}"
          oninput="Music.setVolume(parseFloat(this.value)); document.getElementById('vol-label').textContent = Math.round(this.value*100)+'%'">
      </div>
      <button class="btn btn-primary" onclick="saveSettings()">Save Appearance</button>`,
    privacy: `
      <h3 class="mb-2">Privacy</h3>
      <div class="form-group">
        <label>Profile Visibility</label>
        <select id="priv-select" class="input-box">
          <option value="public"${(cfg.privacy_level||'public')==='public'?' selected':''}>Public</option>
          <option value="friends"${cfg.privacy_level==='friends'?' selected':''}>Friends Only</option>
          <option value="private"${cfg.privacy_level==='private'?' selected':''}>Private</option>
        </select>
      </div>
      <label class="toggle-wrap mb-2">
        <input type="checkbox" class="toggle-input" id="tog-col"${cfg.show_collection!==false?' checked':''}>
        <span class="toggle-track"></span>
        Show collection to others
      </label>
      <label class="toggle-wrap mb-2">
        <input type="checkbox" class="toggle-input" id="tog-rank"${cfg.show_rank!==false?' checked':''}>
        <span class="toggle-track"></span>
        Show rank to others
      </label>
      <label class="toggle-wrap mb-2">
        <input type="checkbox" class="toggle-input" id="tog-notif"${cfg.notifications!==false?' checked':''}>
        <span class="toggle-track"></span>
        Enable notifications
      </label>
      <button class="btn btn-primary mt-1" onclick="saveSettings()">Save Privacy</button>`
  };
  return `<div class="page-title"><h2>Settings</h2></div>
    <div class="settings-layout">
      <div class="settings-nav">${tabBar}</div>
      <div class="sketch-box">${sections[S.settingsTab] || ''}</div>
    </div>`;
}

window.setSettingsTab = (t) => { S.settingsTab = t; document.getElementById('page').innerHTML = viewSettings(); attachListeners(); };
window.applyTheme = (t) => { document.body.className = t === 'default' ? 'theme-default' : 'theme-' + t; };
window.setAvatarColor = async (c) => {
  try {
    await api('/settings/avatar','PUT',{color:c});
    S.user.avatar_color = c;
    notify('Avatar color updated', 'success');
    document.getElementById('page').innerHTML = viewSettings();
    attachListeners();
  } catch (e) { notify(e.message, 'error'); }
};

window.setAvatarEmoji = async (emoji) => {
  try {
    await api('/settings/avatar-img','PUT',{ img: 'emoji:' + emoji });
    S.user.avatar_img = 'emoji:' + emoji;
    notify('Avatar updated', 'success');
    document.getElementById('page').innerHTML = viewSettings();
    attachListeners();
    updateNavAvatar();
  } catch(e) { notify(e.message,'error'); }
};

window.handleAvatarFile = (input) => {
  const file = input.files?.[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) { notify('Please select an image file','error'); return; }
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 80; canvas.height = 80;
      const ctx2 = canvas.getContext('2d');
      // Crop to square
      const min = Math.min(img.width, img.height);
      const sx = (img.width - min) / 2;
      const sy = (img.height - min) / 2;
      ctx2.drawImage(img, sx, sy, min, min, 0, 0, 80, 80);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
      try {
        await api('/settings/avatar-img','PUT',{ img: dataUrl });
        S.user.avatar_img = dataUrl;
        notify('Avatar updated!', 'success');
        document.getElementById('page').innerHTML = viewSettings();
        attachListeners();
        updateNavAvatar();
      } catch(err) { notify(err.message,'error'); }
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
};

function updateNavAvatar() {
  const wrap = document.querySelector('.nav-avatar');
  if (wrap && S.user) wrap.innerHTML = _av(S.user, 36);
}
window.updateNavAvatar = updateNavAvatar;

window.saveBio = async () => {
  const bio = document.getElementById('bio-input')?.value || '';
  try {
    await api('/settings/bio','PUT',{bio});
    S.user.bio = bio;
    notify('Bio saved', 'success');
  } catch (e) { notify(e.message, 'error'); }
};
window.changePassword = async () => {
  const cur = document.getElementById('pw-cur')?.value;
  const nw = document.getElementById('pw-new')?.value;
  const nw2 = document.getElementById('pw-new2')?.value;
  if (nw !== nw2) { notify('New passwords do not match', 'error'); return; }
  try {
    await api('/settings/password','PUT',{current:cur,newPassword:nw});
    notify('Password changed successfully', 'success');
    ['pw-cur','pw-new','pw-new2'].forEach(id => { const el = document.getElementById(id); if(el) el.value=''; });
  } catch (e) { notify(e.message, 'error'); }
};
window.deleteAccount = () => {
  if (!confirm('This will permanently delete your account and all your cards. Are you sure?')) return;
  notify('Account deletion is disabled in this build. Contact a staff member.', 'warning');
};
window.saveSettings = async () => {
  const theme = document.getElementById('theme-select')?.value || 'default';
  const privacy_level = document.getElementById('priv-select')?.value || 'public';
  const show_collection = document.getElementById('tog-col')?.checked !== false;
  const show_rank = document.getElementById('tog-rank')?.checked !== false;
  const notifications = document.getElementById('tog-notif')?.checked !== false;
  try {
    await api('/settings','PUT',{theme, privacy_level, show_collection, show_rank, notifications});
    S.settings = {...S.settings, theme, privacy_level, show_collection, show_rank, notifications};
    applyTheme(theme);
    notify('Settings saved', 'success');
  } catch (e) { notify(e.message, 'error'); }
};

// ─── ADMIN PANEL ──────────────────────────────────────────────────
function viewAdmin() {
  const role = S.user?.role || 'user';
  const ri = ROLE_ORDER.indexOf(role);
  const tabs = [
    ['users','Users',1],['reports','Reports',1],['staffchat','Staff Chat',1],['logs','Logs',2],
    ['stats','Stats',2],['cards','Cards',3],['economy','Economy',3],
    ['developer','Developer',5]
  ].filter(([,, min]) => ri >= min);
  const tabBar = tabs.map(([t,l]) => `<button class="admin-tab${S.adminTab===t?' active':''}${t==='developer'?' dev-tab':''}" onclick="setAdminTab('${t}')">${l}</button>`).join('');
  return `<div class="page-title"><h2>Admin Panel</h2><p class="text-muted">Logged in as <strong>${S.user?.username}</strong> - Role: <span class="role-badge role-${role}">${role}</span></p></div>
    <div class="admin-tabs">${tabBar}</div>
    <div id="admin-content">${renderAdminTab()}</div>`;
}

function renderAdminTab() {
  switch(S.adminTab) {
    case 'users':     return adminUsers();
    case 'reports':   return adminReports();
    case 'staffchat': return adminStaffChat();
    case 'logs':      return adminLogs();
    case 'stats':     return adminStats();
    case 'cards':     return adminCards();
    case 'economy':   return adminEconomy();
    case 'developer': return adminDeveloper();
    default:          return adminUsers();
  }
}

window.setAdminTab = async (t) => {
  // Clear existing stats refresh
  if (S._statsInterval) { clearInterval(S._statsInterval); S._statsInterval = null; }
  S.adminTab = t;
  document.getElementById('admin-content').innerHTML = '<div class="spinner"></div>';
  await loadAdminTabData(t);
  document.getElementById('admin-content').innerHTML = renderAdminTab();
  attachListeners();
  if (t === 'stats') {
    S._statsInterval = setInterval(async () => {
      if (S.view !== 'admin' || S.adminTab !== 'stats') { clearInterval(S._statsInterval); S._statsInterval = null; return; }
      S._adminStats = await api('/admin/stats').catch(() => S._adminStats);
      const el = document.getElementById('admin-content');
      if (el) { el.innerHTML = renderAdminTab(); attachListeners(); }
    }, 5000);
  }
};

async function loadAdminTabData(t) {
  try {
    if (t === 'users')     S._adminUsers     = await api('/admin/users');
    if (t === 'reports')   S._adminReports   = await api('/admin/reports');
    if (t === 'staffchat') S._staffChat      = await api('/staff/chat');
    if (t === 'logs')      S._adminLogs      = await api('/admin/logs');
    if (t === 'stats')     S._adminStats     = await api('/admin/stats');
    if (t === 'developer') {
      const [configRows, packs] = await Promise.all([
        api('/dev/config'),
        api('/dev/packs').catch(() => []),
      ]);
      S._devPacks = packs;
      S._maintenanceState = {};
      for (const f of ['battle','packs','friends','ranked']) {
        const row = configRows.find(r => r.key === 'maintenance_' + f);
        S._maintenanceState[f] = row?.value === 'true';
      }
      // Reload selected pack's cards if one was previously selected
      if (S._selectedPackId && packs.some(p => p.pack_id === S._selectedPackId)) {
        const r = await api('/dev/packs/' + S._selectedPackId).catch(() => null);
        S._selectedPackCards = r?.cards || [];
      } else {
        S._selectedPackId = null;
        S._selectedPackCards = [];
      }
    }
  } catch {}
}

function adminUsers() {
  const users = S._adminUsers || [];
  const ri = ROLE_ORDER.indexOf(S.user?.role || 'user');
  const rows = users.map(u => {
    const timedOut = u.timeout_until && new Date(u.timeout_until) > new Date();
    const statusBadge = u.banned
      ? `<span class="admin-badge badge-banned">Banned</span>`
      : timedOut
        ? `<span class="admin-badge badge-timeout">Timed Out</span>`
        : `<span class="admin-badge badge-active">Active</span>`;
    const warnBadge = u.warning_count > 0
      ? `<span class="admin-badge badge-warn" title="${u.warning_count} warning(s)">${u.warning_count} ⚠</span>`
      : '';
    return `<tr>
      <td>${u.id}</td>
      <td><strong>${u.username}</strong> ${warnBadge}</td>
      <td><span class="role-badge role-${u.role}">${u.role}</span></td>
      <td>${u.coins}</td>
      <td>${statusBadge}</td>
      <td class="admin-actions-cell">
        ${!u.banned
          ? `<button class="btn btn-sm btn-red" onclick="adminBan(${u.id},'${u.username}')">Ban</button>`
          : `<button class="btn btn-sm btn-green" onclick="adminUnban(${u.id})">Unban</button>`}
        ${!timedOut
          ? `<button class="btn btn-sm btn-orange" onclick="adminTimeout(${u.id},'${u.username}')">Timeout</button>`
          : `<button class="btn btn-sm" onclick="adminRemoveTimeout(${u.id})">Untimeout</button>`}
        <button class="btn btn-sm btn-yellow" onclick="adminWarn(${u.id},'${u.username}')">Warn</button>
        <button class="btn btn-sm" onclick="adminViewWarnings(${u.id},'${u.username}')">Warnings</button>
        ${ri >= 2 ? `<button class="btn btn-sm" onclick="adminSetRole(${u.id},'${u.username}')">Role</button>` : ''}
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" class="text-muted text-center">No users found</td></tr>';
  return `<div class="flex gap-2 mb-2" style="flex-wrap:wrap;align-items:flex-end">
    <input class="input-box" id="usr-search" placeholder="Search username..." style="max-width:240px">
    <button class="btn" onclick="adminSearchUsers()">Search</button>
    <button class="btn" onclick="adminLoadUsers()">Show All</button>
  </div>
  <div style="overflow-x:auto"><table class="admin-table">
    <thead><tr><th>ID</th><th>Username</th><th>Role</th><th>Coins</th><th>Status</th><th>Actions</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

window.adminLoadUsers = async () => { S._adminUsers = await api('/admin/users').catch(()=>[]); document.getElementById('admin-content').innerHTML = renderAdminTab(); attachListeners(); };
window.adminSearchUsers = async () => {
  const q = document.getElementById('usr-search')?.value?.trim();
  S._adminUsers = await api('/admin/users' + (q ? '?q=' + encodeURIComponent(q) : '')).catch(()=>[]);
  document.getElementById('admin-content').innerHTML = renderAdminTab(); attachListeners();
};
window.adminBan = (id, name) => {
  const reason = prompt(`Reason for banning ${name}:`);
  if (!reason) return;
  api('/admin/users/' + id + '/ban','PUT',{reason}).then(() => { notify(name + ' has been banned', 'success'); adminLoadUsers(); }).catch(e => notify(e.message,'error'));
};
window.adminUnban = (id) => {
  api('/admin/users/' + id + '/unban','PUT').then(() => { notify('User unbanned', 'success'); adminLoadUsers(); }).catch(e => notify(e.message,'error'));
};
window.adminSetRole = (id, name) => {
  const roles = ROLE_ORDER.filter(r => ROLE_ORDER.indexOf(r) < ROLE_ORDER.indexOf(S.user.role));
  const role = prompt(`Set role for ${name}:\nOptions: ${roles.join(', ')}`);
  if (!role || !roles.includes(role)) { notify('Invalid role', 'error'); return; }
  api('/admin/users/' + id + '/role','PUT',{role}).then(() => { notify('Role updated to ' + role, 'success'); adminLoadUsers(); }).catch(e => notify(e.message,'error'));
};

window.adminWarn = (id, name) => {
  const reason = prompt(`Issue warning to ${name}:\nReason:`);
  if (!reason?.trim()) return;
  api('/admin/users/' + id + '/warn', 'POST', { reason })
    .then(() => { notify(`Warning issued to ${name}`, 'success'); adminLoadUsers(); })
    .catch(e => notify(e.message, 'error'));
};

window.adminTimeout = (id, name) => {
  const duration = prompt(`Timeout ${name}:\nDuration (1h, 6h, 12h, 24h, 3d, 7d):`);
  if (!duration) return;
  const reason = prompt('Reason (optional):') || '';
  api('/admin/users/' + id + '/timeout', 'PUT', { duration, reason })
    .then(() => { notify(`${name} timed out for ${duration}`, 'success'); adminLoadUsers(); })
    .catch(e => notify(e.message, 'error'));
};

window.adminRemoveTimeout = (id) => {
  api('/admin/users/' + id + '/timeout', 'DELETE')
    .then(() => { notify('Timeout removed', 'success'); adminLoadUsers(); })
    .catch(e => notify(e.message, 'error'));
};

window.adminViewWarnings = async (id, name) => {
  try {
    const warnings = await api('/admin/users/' + id + '/warnings');
    const ri = ROLE_ORDER.indexOf(S.user?.role || 'user');
    const rows = warnings.length
      ? warnings.map(w => `
          <div class="warning-entry">
            <div class="warning-meta">
              <span class="text-muted" style="font-size:0.8rem">${new Date(w.created_at).toLocaleString()}</span>
              <span style="font-size:0.8rem">by <strong>${w.issued_by_name || 'Unknown'}</strong></span>
            </div>
            <div class="warning-reason">${w.reason}</div>
            ${ri >= 2 ? `<button class="btn btn-sm btn-red" onclick="adminDeleteWarning(${w.id})">Remove</button>` : ''}
          </div>`).join('')
      : '<p class="text-muted">No warnings on record.</p>';
    openModal(`<div style="min-width:340px;max-width:500px">
      <h3 style="margin-bottom:1rem">Warnings — ${name}</h3>
      <div id="warnings-list">${rows}</div>
      <div class="text-center mt-2"><button class="btn" onclick="closeModal()">Close</button></div>
    </div>`);
  } catch (e) { notify(e.message, 'error'); }
};

window.adminDeleteWarning = async (wid) => {
  if (!confirm('Remove this warning?')) return;
  try {
    await api('/admin/warnings/' + wid, 'DELETE');
    notify('Warning removed', 'success');
    closeModal();
  } catch (e) { notify(e.message, 'error'); }
};

function adminReports() {
  const reports = S._adminReports || [];
  const PRIORITY_ORDER = { urgent:0, high:1, normal:2, low:3 };
  const sorted = [...reports].sort((a,b) => (PRIORITY_ORDER[a.priority||'normal']||2) - (PRIORITY_ORDER[b.priority||'normal']||2));
  const rows = sorted.map(r => {
    const pri = r.priority || 'normal';
    return `<tr style="cursor:pointer" onclick="adminViewReport(${r.id})">
      <td>${r.id}</td>
      <td><span class="profile-link" onclick="event.stopPropagation();openProfile('${r.reporter_name}')">${r.reporter_name}</span></td>
      <td><span class="profile-link" onclick="event.stopPropagation();openProfile('${r.reported_name}')">${r.reported_name}</span></td>
      <td>${r.category}</td>
      <td><span class="priority-badge priority-${pri}">${pri}</span></td>
      <td>${r.description.slice(0,50)}${r.description.length>50?'...':''}</td>
      <td><span class="report-status status-${r.status}">${r.status}</span></td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" class="text-muted text-center">No reports</td></tr>';
  const urgentCount = reports.filter(r=>r.priority==='urgent').length;
  return `<div class="flex gap-2 mb-2" style="flex-wrap:wrap;align-items:center">
    <select class="input-box" id="rep-filter" style="max-width:180px" onchange="adminFilterReports(this.value)">
      <option value="">All</option><option value="open">Open</option><option value="reviewing">Reviewing</option><option value="resolved">Resolved</option><option value="dismissed">Dismissed</option>
    </select>
    <button class="btn" onclick="adminLoadReports()">Refresh</button>
    ${urgentCount > 0 ? `<span style="color:var(--red);font-weight:700;font-size:0.9rem">⚠ ${urgentCount} urgent</span>` : ''}
  </div>
  <div style="overflow-x:auto"><table class="admin-table">
    <thead><tr><th>ID</th><th>Reporter</th><th>Reported</th><th>Category</th><th>Priority</th><th>Description</th><th>Status</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
  <p class="text-muted" style="font-size:0.82rem;margin-top:0.5rem">Click any row to view full details and update.</p>`;
}

window.adminLoadReports = async () => { S._adminReports = await api('/admin/reports').catch(()=>[]); document.getElementById('admin-content').innerHTML = renderAdminTab(); attachListeners(); };
window.adminFilterReports = async (status) => { S._adminReports = await api('/admin/reports' + (status ? '?status=' + status : '')).catch(()=>[]); document.getElementById('admin-content').innerHTML = renderAdminTab(); attachListeners(); };
window.adminViewReport = (id) => {
  const r = (S._adminReports || []).find(x => x.id === id);
  if (!r) return;
  const pri = r.priority || 'normal';
  openModal(`<div style="max-width:480px">
    <h3 style="margin-bottom:1rem">Report #${r.id}</h3>
    <div class="report-detail-row"><strong>Reporter:</strong> <span onclick="openProfile('${r.reporter_name}')" class="profile-link">${r.reporter_name}</span></div>
    <div class="report-detail-row"><strong>Reported:</strong> <span onclick="openProfile('${r.reported_name}')" class="profile-link">${r.reported_name}</span></div>
    <div class="report-detail-row"><strong>Category:</strong> ${r.category}</div>
    <div class="report-detail-row"><strong>Priority:</strong> <span class="priority-badge priority-${pri}">${pri.toUpperCase()}</span></div>
    <div class="report-detail-row"><strong>Status:</strong> <span class="report-status status-${r.status}">${r.status}</span></div>
    <div class="report-detail-row"><strong>Date:</strong> ${new Date(r.created_at).toLocaleString()}</div>
    <div style="background:var(--paper-dark);border:1px solid var(--paper-line);border-radius:4px;padding:0.75rem;margin:0.75rem 0;font-size:0.9rem">${r.description}</div>
    ${r.evidence_url ? `<div class="report-detail-row"><strong>Evidence:</strong> <a href="${r.evidence_url}" target="_blank" rel="noopener" style="color:var(--cyan)">${r.evidence_url}</a></div>` : ''}
    ${r.handler_notes ? `<div style="background:var(--paper-dark);border:1px solid var(--gold);border-radius:4px;padding:0.6rem;font-size:0.85rem;color:var(--gold)">Staff note: ${r.handler_notes}</div>` : ''}
    <div class="form-group mt-2"><label>Update Status</label>
      <select id="rep-status-sel" class="input-box">
        ${['open','reviewing','resolved','dismissed'].map(s=>`<option value="${s}"${r.status===s?' selected':''}>${s}</option>`).join('')}
      </select>
    </div>
    <div class="form-group"><label>Handler Notes</label>
      <textarea id="rep-notes-inp" class="input-box">${r.handler_notes||''}</textarea>
    </div>
    <div class="flex gap-2">
      <button class="btn btn-primary" onclick="adminSaveReport(${id})">Save</button>
      ${ROLE_ORDER.indexOf(S.user?.role)>=2?`<button class="btn btn-red" onclick="adminDeleteReport(${id});closeModal()">Delete</button>`:''}
    </div>
  </div>`);
};
window.adminSaveReport = (id) => {
  const status = document.getElementById('rep-status-sel')?.value;
  const notes = document.getElementById('rep-notes-inp')?.value;
  api('/admin/reports/' + id,'PUT',{status, handler_notes: notes}).then(() => { notify('Report updated', 'success'); closeModal(); adminLoadReports(); }).catch(e => notify(e.message,'error'));
};
window.adminDeleteReport = (id) => {
  if (!confirm('Delete this report?')) return;
  api('/admin/reports/' + id,'DELETE').then(() => { notify('Report deleted', 'success'); adminLoadReports(); }).catch(e => notify(e.message,'error'));
};

// ─── STAFF CHAT ───────────────────────────────────────────────────
function adminStaffChat() {
  const msgs = S._staffChat || [];
  const chatHtml = msgs.length
    ? msgs.map(m => `<div class="staff-msg">
        <span class="staff-msg-avatar">${_av(m, 32)}</span>
        <div class="staff-msg-body">
          <div class="staff-msg-header"><span class="staff-msg-name" onclick="openProfile('${m.username}')" style="cursor:pointer">${m.username}</span><span class="role-badge role-${m.role}" style="font-size:0.7rem">${m.role}</span><span class="staff-msg-time text-muted">${new Date(m.created_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</span></div>
          <div class="staff-msg-text">${m.message.replace(/</g,'&lt;')}</div>
        </div>
      </div>`).join('')
    : '<p class="text-muted text-center" style="padding:1.5rem">No messages yet. Be the first to say something!</p>';
  return `<div class="staff-chat-wrap">
    <div class="staff-chat-msgs" id="staff-chat-msgs">${chatHtml}</div>
    <div class="staff-chat-input-row">
      <input id="staff-chat-input" class="input-box" placeholder="Message staff..." style="flex:1" onkeydown="if(event.key==='Enter')sendStaffMsg()">
      <button class="btn btn-primary" onclick="sendStaffMsg()">Send</button>
      <button class="btn" onclick="refreshStaffChat()" title="Refresh">↻</button>
    </div>
  </div>`;
}

window.sendStaffMsg = async () => {
  const inp = document.getElementById('staff-chat-input');
  const msg = inp?.value?.trim();
  if (!msg) return;
  try {
    await api('/staff/chat','POST',{message: msg});
    inp.value = '';
    S._staffChat = await api('/staff/chat');
    document.getElementById('admin-content').innerHTML = adminStaffChat();
    attachListeners();
    const el = document.getElementById('staff-chat-msgs');
    if (el) el.scrollTop = el.scrollHeight;
  } catch(e) { notify(e.message,'error'); }
};

window.refreshStaffChat = async () => {
  S._staffChat = await api('/staff/chat').catch(()=>[]);
  document.getElementById('admin-content').innerHTML = adminStaffChat();
  attachListeners();
};

function adminLogs() {
  const logs = S._adminLogs || [];
  const rows = logs.map(l => `<tr>
    <td>${l.id}</td>
    <td>${l.admin_name||'?'}</td>
    <td>${l.action}</td>
    <td>${l.target_user_id||'-'}</td>
    <td>${(l.details||'').slice(0,80)}</td>
    <td style="font-size:0.8rem">${new Date(l.created_at).toLocaleString()}</td>
  </tr>`).join('') || '<tr><td colspan="6" class="text-muted text-center">No logs</td></tr>';
  return `<div style="overflow-x:auto"><table class="admin-table">
    <thead><tr><th>ID</th><th>Admin</th><th>Action</th><th>Target</th><th>Details</th><th>Time</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function adminStats() {
  const s = S._adminStats || {};
  return `<div class="grid-2 gap-2">
    <div class="sketch-box text-center"><h3 class="mb-1">${s.user_count||0}</h3><p class="text-muted">Total Users</p></div>
    <div class="sketch-box text-center"><h3 class="mb-1">${s.card_count||0}</h3><p class="text-muted">Total Cards</p></div>
    <div class="sketch-box text-center"><h3 class="mb-1">${s.match_count||0}</h3><p class="text-muted">Total Matches</p></div>
    <div class="sketch-box text-center"><h3 class="mb-1 text-red">${s.open_reports||0}</h3><p class="text-muted">Open Reports</p></div>
  </div>
  ${s.top_player ? `<div class="sketch-box mt-2"><p>Top player: <strong>${s.top_player.username}</strong> with rating <strong>${s.top_player.rating}</strong></p></div>` : ''}
  <div class="sketch-box mt-2">
    <h3 style="margin-bottom:0.8rem">Post Announcement</h3>
    <div class="form-group"><label>Title</label><input id="ann-title" class="input-box" placeholder="Announcement title"></div>
    <div class="form-group"><label>Body</label><textarea id="ann-body" class="input-box" placeholder="Announcement text..."></textarea></div>
    <button class="btn btn-primary" onclick="postAnnouncement()">Post Announcement</button>
  </div>`;
}

window.postAnnouncement = async () => {
  const title = document.getElementById('ann-title')?.value?.trim();
  const body  = document.getElementById('ann-body')?.value?.trim();
  if (!title || !body) { notify('Title and body required', 'error'); return; }
  try {
    await api('/admin/announcements','POST',{title,body});
    notify('Announcement posted', 'success');
    S.announcements = await api('/announcements').catch(()=>[]);
  } catch (e) { notify(e.message,'error'); }
};

function adminCards() {
  return `<div class="sketch-box">
    <h3 style="margin-bottom:1rem">Give Cards to User</h3>
    <div class="form-group"><label>User ID</label><input id="give-uid" class="input-box" placeholder="User ID" type="number"></div>
    <div class="form-group"><label>Card ID</label><input id="give-cid" class="input-box" placeholder="Card ID (1-10500)" type="number"></div>
    <button class="btn btn-primary" onclick="adminGiveCard()">Give Card</button>
  </div>
  <div class="sketch-box mt-2">
    <h3 style="margin-bottom:1rem">Edit Card Stats</h3>
    <p class="text-muted mb-2">Owner+ can modify card stats. Use card ID to target a specific card.</p>
    <div class="form-group"><label>Card ID</label><input id="edit-cid" class="input-box" placeholder="Card ID" type="number"></div>
    <div class="grid-2 gap-1">
      <div class="form-group"><label>HP</label><input id="edit-hp" class="input-box" placeholder="HP" type="number"></div>
      <div class="form-group"><label>ATK</label><input id="edit-atk" class="input-box" placeholder="ATK" type="number"></div>
      <div class="form-group"><label>DEF</label><input id="edit-def" class="input-box" placeholder="DEF" type="number"></div>
      <div class="form-group"><label>SPD</label><input id="edit-spd" class="input-box" placeholder="SPD" type="number"></div>
    </div>
    ${ROLE_ORDER.indexOf(S.user?.role) >= 5 ? `<button class="btn btn-primary" onclick="adminEditCard()">Save Card</button>` : '<p class="text-muted">Developer only</p>'}
  </div>`;
}

window.adminGiveCard = async () => {
  const uid = document.getElementById('give-uid')?.value;
  const cid = document.getElementById('give-cid')?.value;
  if (!uid || !cid) { notify('User ID and Card ID required', 'error'); return; }
  try { await api('/admin/users/' + uid + '/cards/add','PUT',{card_id: parseInt(cid)}); notify('Card given', 'success'); } catch(e) { notify(e.message,'error'); }
};
window.adminEditCard = async () => {
  const id = document.getElementById('edit-cid')?.value;
  if (!id) { notify('Card ID required', 'error'); return; }
  const body = {};
  ['hp','atk','def','spd'].forEach(f => { const v = document.getElementById('edit-' + f)?.value; if (v) body[f] = parseInt(v); });
  try { await api('/dev/cards/' + id,'PUT',body); notify('Card updated', 'success'); } catch(e) { notify(e.message,'error'); }
};

function adminEconomy() {
  return `<div class="sketch-box">
    <h3 style="margin-bottom:1rem">Economy Management</h3>
    <div class="form-group"><label>Give Coins to User (User ID)</label>
      <div class="flex gap-1"><input id="eco-uid" class="input-box" placeholder="User ID" type="number">
      <input id="eco-amt" class="input-box" placeholder="Amount (negative to remove)" type="number">
      <button class="btn btn-primary" onclick="adminGiveCoins()" style="white-space:nowrap">Apply</button></div>
    </div>
    <hr class="divider">
    <h3 style="margin-bottom:0.8rem">Reset Ranked Season</h3>
    <p class="text-muted mb-1">This will reset all season wins/losses and top 500 status.</p>
    <button class="btn btn-red" onclick="adminResetSeason()">Reset Season</button>
  </div>`;
}

window.adminGiveCoins = async () => {
  const uid = document.getElementById('eco-uid')?.value;
  const amt = document.getElementById('eco-amt')?.value;
  if (!uid || !amt) { notify('User ID and amount required', 'error'); return; }
  try { await api('/admin/users/' + uid + '/coins','PUT',{amount: parseInt(amt)}); notify('Coins updated', 'success'); } catch(e) { notify(e.message,'error'); }
};
window.adminResetSeason = async () => {
  if (!confirm('Reset the entire ranked season? This cannot be undone.')) return;
  try { await api('/admin/ranked/reset','PUT'); notify('Season reset!', 'success'); } catch(e) { notify(e.message,'error'); }
};

function adminDeveloper() {
  return `<div class="sketch-box" style="border-color:var(--red)">
    <h3 style="margin-bottom:0.5rem;color:var(--red)">Developer Console</h3>
    <p class="text-muted mb-2" style="font-size:0.85rem">Full database access. Use with caution.</p>

    <h4 style="margin-bottom:0.5rem;color:var(--cyan)">Give Card</h4>
    <p class="text-muted mb-1" style="font-size:0.82rem">Give by ID (fastest) or search by name/type/set.</p>
    <div style="display:flex;gap:0.6rem;margin-bottom:0.6rem;flex-wrap:wrap;align-items:center">
      <input class="input-box" id="dev-give-id" type="number" placeholder="Card ID" style="width:110px;flex-shrink:0"
        onkeydown="if(event.key==='Enter')devGiveById()">
      <input class="input-box" id="dev-give-target" placeholder="Username (blank = yourself)" style="flex:1;min-width:130px">
      <button class="btn btn-primary" onclick="devGiveById()">Give by ID</button>
    </div>
    <div style="display:flex;gap:0.6rem;margin-bottom:0.5rem;flex-wrap:wrap">
      <input class="input-box" id="dev-card-search" placeholder="Search by name / type / set..." style="flex:2;min-width:160px"
        onkeydown="if(event.key==='Enter')devCardSearch()">
      <button class="btn btn-sm" onclick="devCardSearch()">Search</button>
    </div>
    <div id="dev-card-results" style="display:flex;flex-direction:column;gap:0.35rem;margin-bottom:0.5rem"></div>
    <div id="dev-cmd-out" style="font-size:0.85rem;min-height:1.2rem"></div>

    <hr class="divider">
    <h4 style="margin-bottom:0.5rem;color:var(--red)">Remove Card</h4>
    <p class="text-muted mb-1" style="font-size:0.82rem">Enter a User ID to browse their inventory, then click Remove on any card.</p>
    <div style="display:flex;gap:0.6rem;margin-bottom:0.5rem;flex-wrap:wrap;align-items:center">
      <input class="input-box" id="dev-rm-uid" type="number" placeholder="User ID" style="width:110px;flex-shrink:0">
      <input class="input-box" id="dev-rm-search" placeholder="Filter by name / type / rarity..." style="flex:1;min-width:160px"
        onkeydown="if(event.key==='Enter')devRmLoadInv(1)">
      <button class="btn btn-primary btn-sm" onclick="devRmLoadInv(1)">Browse Inventory</button>
    </div>
    <div id="dev-rm-results" style="display:flex;flex-direction:column;gap:0.3rem;margin-bottom:0.5rem;max-height:320px;overflow-y:auto"></div>
    <div id="dev-rm-pages" style="display:flex;gap:0.5rem;align-items:center;margin-bottom:0.3rem;font-size:0.82rem"></div>
    <div id="dev-rm-out" style="font-size:0.85rem;min-height:1.2rem"></div>

    <hr class="divider">
    <h4 style="margin-bottom:0.5rem;color:var(--red)">Reset Stats</h4>
    <p class="text-muted mb-1" style="font-size:0.82rem">Resets coins to 100, rating to 1000, wins/losses to 0.</p>
    <div style="display:flex;gap:0.6rem;margin-bottom:0.5rem;flex-wrap:wrap">
      <input class="input-box" id="dev-reset-username" placeholder="Username" style="flex:1;min-width:160px">
      <button class="btn btn-red" onclick="devResetStats()">Reset Stats</button>
    </div>
    <div id="dev-reset-out" style="font-size:0.85rem;min-height:1.2rem"></div>

    <hr class="divider">
    <h4 style="margin-bottom:0.5rem;margin-top:1rem">Raw SQL Query</h4>
    <textarea id="dev-sql" class="input-box mb-1" placeholder="SELECT * FROM users LIMIT 10;" style="font-family:monospace;font-size:0.9rem;height:80px"></textarea>
    <button class="btn btn-red" onclick="devRunQuery()">Execute Query</button>
    <pre id="dev-result" style="background:var(--paper-dark);border:1px solid var(--paper-line);border-radius:3px;padding:0.8rem;margin-top:0.8rem;overflow:auto;max-height:200px;font-size:0.8rem;display:none"></pre>

    <hr class="divider">
    <h4 style="margin-bottom:0.5rem;color:#e74c3c">Custom Title</h4>
    <p class="text-muted mb-1" style="font-size:0.82rem">Grant or remove a custom title displayed on a user's profile and navbar. Leave title blank to remove.</p>
    <div style="display:flex;gap:0.6rem;margin-bottom:0.5rem;flex-wrap:wrap;align-items:center">
      <input class="input-box" id="dev-title-uid" type="number" placeholder="User ID" style="width:110px;flex-shrink:0">
      <input class="input-box" id="dev-title-text" placeholder='e.g. "Voice Guy In Red"' style="flex:1;min-width:200px">
      <button class="btn btn-red btn-sm" onclick="devGrantTitle()">Set Title</button>
    </div>
    <div id="dev-title-out" style="font-size:0.85rem;min-height:1.2rem"></div>

    <hr class="divider">
    <h4 style="margin-bottom:0.5rem">Modify User Stats</h4>
    <div class="grid-3 gap-1">
      <div class="form-group"><label>User ID</label><input id="dev-uid" class="input-box" type="number" placeholder="User ID"></div>
      <div class="form-group"><label>Rating</label><input id="dev-rating" class="input-box" type="number" placeholder="Rating"></div>
      <div class="form-group"><label>Coins</label><input id="dev-coins" class="input-box" type="number" placeholder="Coins"></div>
    </div>
    <button class="btn btn-red btn-sm" onclick="devEditStats()">Apply Stats</button>

    <hr class="divider">
    <h4 style="margin-bottom:0.5rem">Create Promo Card</h4>
    <div class="grid-3 gap-1">
      <div class="form-group"><label>Name</label><input id="promo-name" class="input-box" placeholder="Card name"></div>
      <div class="form-group"><label>Type</label><select id="promo-type" class="input-box">${TYPES.map(t=>`<option>${t}</option>`).join('')}</select></div>
      <div class="form-group"><label>Class</label><select id="promo-cls" class="input-box"><option>Titan</option><option>Beast</option><option>Dragon</option><option>Golem</option><option>Sprite</option><option>Demon</option><option>Angel</option><option>Undead</option><option>Elemental</option><option>Construct</option></select></div>
      <div class="form-group"><label>HP</label><input id="promo-hp" class="input-box" type="number" placeholder="200"></div>
      <div class="form-group"><label>ATK</label><input id="promo-atk" class="input-box" type="number" placeholder="100"></div>
      <div class="form-group"><label>DEF</label><input id="promo-def" class="input-box" type="number" placeholder="80"></div>
      <div class="form-group"><label>SPD</label><input id="promo-spd" class="input-box" type="number" placeholder="80"></div>
      <div class="form-group"><label>Ability Name</label><input id="promo-aname" class="input-box" placeholder="Promo Strike"></div>
      <div class="form-group"><label>Ability Power</label><input id="promo-apower" class="input-box" type="number" placeholder="130"></div>
    </div>
    <div class="form-group"><label>Ability Description</label><input id="promo-adesc" class="input-box" placeholder="A legendary promo ability."></div>
    <div class="form-group"><label>Flavor Text</label><input id="promo-flavor" class="input-box" placeholder="Flavor text..."></div>
    <div class="grid-3 gap-1">
      <div class="form-group"><label>Rarity</label><select id="promo-rarity" class="input-box">${['Common','Uncommon','Rare','Ultra_Rare','Secret_Rare','Full_Art','Parallel','Numbered','Prism','Mythic'].map(r=>`<option${r==='Mythic'?' selected':''}>${r}</option>`).join('')}</select></div>
      <div class="form-group"><label>Shop Price (0=not for sale)</label><input id="promo-price" class="input-box" type="number" placeholder="0"></div>
      <input id="promo-set" type="hidden" value="Promo Series">
      <div class="form-group"><label>Art Logo (type)</label><select id="promo-art" class="input-box"><option value="ink">Ink</option><option value="sketch">Sketch</option><option value="watercolor">Watercolor</option><option value="charcoal">Charcoal</option></select></div>
      <div class="form-group"><label>Retreat Cost</label><input id="promo-retreat" class="input-box" type="number" placeholder="1"></div>
    </div>
    <div class="flex gap-2" style="align-items:center;flex-wrap:wrap;margin-bottom:0.5rem">
      <label style="display:flex;align-items:center;gap:0.4rem;cursor:pointer"><input type="checkbox" id="promo-numbered"> Numbered Card</label>
      <div class="form-group" style="margin:0;display:flex;align-items:center;gap:0.5rem">
        <label style="white-space:nowrap;font-size:0.85rem">Print Limit</label>
        <input id="promo-print-limit" class="input-box" type="number" placeholder="blank = unlimited" style="width:160px">
      </div>
    </div>
    <div class="form-group">
      <label>Expiry Date &amp; Time <span class="text-muted" style="font-size:0.8rem">(leave blank = never expires)</span></label>
      <input id="promo-expires" class="input-box" type="datetime-local">
    </div>
    <button class="btn btn-red btn-sm" onclick="devCreatePromo()">Create Promo</button>

    <hr class="divider">
    <h4 style="margin-bottom:0.5rem">Leaderboard Override</h4>
    <div class="flex gap-1">
      <input id="dev-lb-uid" class="input-box" type="number" placeholder="User ID">
      <input id="dev-lb-rating" class="input-box" type="number" placeholder="New rating">
      <button class="btn btn-red btn-sm" onclick="devSetRating()" style="white-space:nowrap">Set Rating</button>
    </div>

    <hr class="divider">
    <h4 style="margin-bottom:0.5rem">Economy Settings</h4>
    <div class="grid-3 gap-1">
      <div class="form-group"><label>Pack Cost</label><input id="eco-pack" class="input-box" type="number" placeholder="100"></div>
      <div class="form-group"><label>Daily Coins</label><input id="eco-daily" class="input-box" type="number" placeholder="50"></div>
      <div class="form-group"><label>Win Coins</label><input id="eco-win" class="input-box" type="number" placeholder="30"></div>
    </div>
    <button class="btn btn-red btn-sm" onclick="devSetEconomy()">Update Economy</button>

    <hr class="divider">
    <h4 style="margin-bottom:0.5rem;color:var(--red)">Maintenance Mode</h4>
    <p class="text-muted mb-1" style="font-size:0.82rem">When a feature is ON maintenance, users get a 503 error instead of using it.</p>
    <div id="maint-status" style="display:flex;gap:0.6rem;flex-wrap:wrap;margin-bottom:0.5rem">
      ${['battle','packs','friends','ranked'].map(f => {
        const on = S._maintenanceState?.[f] || false;
        return `
        <div style="display:flex;align-items:center;gap:0.4rem;background:var(--paper-dark);border:1px solid ${on?'var(--red)':'var(--paper-line)'};border-radius:6px;padding:0.35rem 0.7rem">
          <span style="font-family:var(--font-ui);font-size:0.82rem;text-transform:capitalize">${f}</span>
          <span class="badge ${on?'badge-red':'badge-green'}" style="font-size:0.7rem">${on?'MAINT':'LIVE'}</span>
          <button class="btn btn-sm ${on?'btn-secondary':'btn-red'}" onclick="devToggleMaint('${f}')" style="padding:0.2rem 0.55rem;font-size:0.78rem">${on?'Disable':'Enable'}</button>
        </div>`;
      }).join('')}
    </div>

    <hr class="divider">
    <h4 style="margin-bottom:0.5rem;color:var(--cyan)">Pack Manager</h4>
    <p class="text-muted mb-1" style="font-size:0.82rem">Create custom packs that appear in the shop. Odds fields are per-rarity-group and must sum to 100.</p>
    <div class="grid-3 gap-1">
      <div class="form-group"><label>Pack ID <span class="text-muted">(lowercase, no spaces)</span></label><input id="pk-id" class="input-box" placeholder="e.g. fire_special"></div>
      <div class="form-group"><label>Display Name</label><input id="pk-name" class="input-box" placeholder="Fire Special Pack"></div>
      <div class="form-group"><label>Cost (coins)</label><input id="pk-cost" class="input-box" type="number" placeholder="500"></div>
      <div class="form-group"><label>Cards per Pack</label><input id="pk-count" class="input-box" type="number" placeholder="5"></div>
      <div class="form-group"><label>Badge Label</label><input id="pk-badge" class="input-box" placeholder="SPECIAL"></div>
      <div class="form-group"><label>Accent Color</label><input id="pk-color" class="input-box" type="color" value="#ff6d00" style="height:38px;padding:2px"></div>
    </div>
    <div class="form-group"><label>Description</label><input id="pk-desc" class="input-box" placeholder="A pack focused on special pulls."></div>
    <p class="text-muted mb-1" style="font-size:0.82rem;margin-top:0.5rem">Rarity Odds (must sum to 100). Leave blank = 0%. Use comma-separated rarity names per row.</p>
    <div class="grid-3 gap-1">
      <div class="form-group"><label>Mythic,Prism %</label><input id="pk-o1" class="input-box" type="number" placeholder="1" step="0.1"></div>
      <div class="form-group"><label>Numbered,Full_Art %</label><input id="pk-o2" class="input-box" type="number" placeholder="4" step="0.1"></div>
      <div class="form-group"><label>Ultra_Rare,Secret_Rare,Parallel %</label><input id="pk-o3" class="input-box" type="number" placeholder="20" step="0.1"></div>
      <div class="form-group"><label>Rare %</label><input id="pk-o4" class="input-box" type="number" placeholder="35" step="0.1"></div>
      <div class="form-group"><label>Uncommon %</label><input id="pk-o5" class="input-box" type="number" placeholder="25" step="0.1"></div>
      <div class="form-group"><label>Common %</label><input id="pk-o6" class="input-box" type="number" placeholder="15" step="0.1"></div>
    </div>
    <p class="text-muted mb-1" style="font-size:0.82rem">Optional card filter (leave blank = all cards):</p>
    <div class="grid-3 gap-1">
      <div class="form-group"><label>Restrict to Set</label><input id="pk-fset" class="input-box" placeholder="e.g. Promo Series"></div>
      <div class="form-group"><label>Restrict to Types <span class="text-muted">(comma sep)</span></label><input id="pk-ftypes" class="input-box" placeholder="e.g. Fire,Dragon"></div>
    </div>
    <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.5rem">
      <button class="btn btn-primary btn-sm" onclick="devCreatePack()">Create Pack</button>
      <span id="pk-out" style="font-size:0.85rem"></span>
    </div>
    <div style="margin-top:0.5rem">${_renderDevPackList(S._devPacks || [])}</div>
    <button class="btn btn-sm" onclick="devLoadPacks()" style="margin-bottom:0.3rem">Refresh Pack List</button>

    <hr class="divider">
    <h4 style="margin-bottom:0.5rem;color:var(--cyan)">Pack Card Manager</h4>
    <p class="text-muted mb-1" style="font-size:0.82rem">Select a custom pack, then add existing cards by ID or create new cards specifically for it. Cards added here are the <strong>only</strong> cards that can drop from the pack.</p>
    ${(S._devPacks || []).length === 0 ? '<p class="text-muted" style="font-size:0.85rem">Create a pack first above.</p>' : `
    <div style="display:flex;gap:0.6rem;align-items:center;margin-bottom:0.75rem;flex-wrap:wrap">
      <select id="pk-card-pack-sel" class="input-box" style="max-width:220px" onchange="devSelectPack(this.value)">
        <option value="">— Select a pack —</option>
        ${(S._devPacks || []).map(p => `<option value="${p.pack_id}"${S._selectedPackId === p.pack_id?' selected':''}>${p.name}</option>`).join('')}
      </select>
      ${S._selectedPackId ? `<span class="text-muted" style="font-size:0.82rem">${(S._selectedPackCards||[]).length} card${(S._selectedPackCards||[]).length!==1?'s':''} in pool</span>` : ''}
    </div>
    ${S._selectedPackId ? `
    <div id="pk-cards-list" style="margin-bottom:0.75rem">
      ${_renderPackCardsList(S._selectedPackCards || [], S._selectedPackId)}
    </div>
    <div style="display:flex;gap:0.5rem;align-items:center;margin-bottom:0.75rem;flex-wrap:wrap">
      <input id="pk-add-card-id" class="input-box" type="number" placeholder="Card ID to add" style="width:140px">
      <button class="btn btn-sm btn-primary" onclick="devAddCardToPack()">Add by ID</button>
    </div>
    <hr style="border-color:var(--paper-line);margin:0.75rem 0">
    <h5 style="margin-bottom:0.5rem;color:var(--gold)">Create New Card for "${(S._devPacks||[]).find(p=>p.pack_id===S._selectedPackId)?.name||S._selectedPackId}"</h5>
    <div class="grid-3 gap-1">
      <div class="form-group"><label>Name</label><input id="pkc-name" class="input-box" placeholder="Card name"></div>
      <div class="form-group"><label>Type</label><select id="pkc-type" class="input-box">${TYPES.map(t=>`<option>${t}</option>`).join('')}</select></div>
      <div class="form-group"><label>Class</label><select id="pkc-cls" class="input-box"><option>Titan</option><option>Beast</option><option>Dragon</option><option>Golem</option><option>Sprite</option><option>Demon</option><option>Angel</option><option>Undead</option><option>Elemental</option><option>Construct</option></select></div>
      <div class="form-group"><label>HP</label><input id="pkc-hp" class="input-box" type="number" placeholder="180"></div>
      <div class="form-group"><label>ATK</label><input id="pkc-atk" class="input-box" type="number" placeholder="100"></div>
      <div class="form-group"><label>DEF</label><input id="pkc-def" class="input-box" type="number" placeholder="80"></div>
      <div class="form-group"><label>SPD</label><input id="pkc-spd" class="input-box" type="number" placeholder="80"></div>
      <div class="form-group"><label>Rarity</label><select id="pkc-rarity" class="input-box">${['Common','Uncommon','Rare','Ultra_Rare','Secret_Rare','Full_Art','Parallel','Numbered','Prism','Mythic'].map(r=>`<option${r==='Rare'?' selected':''}>${r}</option>`).join('')}</select></div>
      <div class="form-group"><label>Retreat Cost</label><input id="pkc-retreat" class="input-box" type="number" placeholder="2"></div>
      <div class="form-group"><label>Ability Name</label><input id="pkc-aname" class="input-box" placeholder="Custom Strike"></div>
      <div class="form-group"><label>Ability Power</label><input id="pkc-apower" class="input-box" type="number" placeholder="120"></div>
    </div>
    <div class="form-group"><label>Ability Description</label><input id="pkc-adesc" class="input-box" placeholder="A unique custom ability."></div>
    <div class="form-group"><label>Flavor Text</label><input id="pkc-flavor" class="input-box" placeholder="Flavor text..."></div>
    <div style="display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap;margin-bottom:0.5rem">
      <label style="display:flex;align-items:center;gap:0.4rem;cursor:pointer"><input type="checkbox" id="pkc-numbered"> Numbered</label>
      <div class="form-group" style="margin:0;display:flex;align-items:center;gap:0.4rem"><label style="font-size:0.82rem;white-space:nowrap">Print Limit</label><input id="pkc-printlimit" class="input-box" type="number" placeholder="blank = ∞" style="width:110px"></div>
    </div>
    <div style="display:flex;align-items:center;gap:0.5rem">
      <button class="btn btn-gold btn-sm" onclick="devCreateCardForPack('${S._selectedPackId}')">Create & Add to Pack</button>
      <span id="pkc-out" style="font-size:0.85rem"></span>
    </div>
    ` : ''}
    `}

    <hr class="divider">
    <h4 style="margin-bottom:0.5rem">Grant Card Collection</h4>
    <div class="flex gap-1">
      <input id="dev-grant-uid" class="input-box" type="number" placeholder="User ID">
      <input id="dev-grant-cids" class="input-box" placeholder="Card IDs (comma separated)">
      <button class="btn btn-red btn-sm" onclick="devGrantCards()" style="white-space:nowrap">Grant</button>
    </div>

    <hr class="divider">
    <h4 style="margin-bottom:0.5rem">Create Custom Rank</h4>
    <div class="flex gap-1">
      <input id="dev-rank-name" class="input-box" placeholder="Rank name">
      <input id="dev-rank-min" class="input-box" type="number" placeholder="Min rating">
      <button class="btn btn-red btn-sm" onclick="devCreateRank()" style="white-space:nowrap">Create Rank</button>
    </div>

    <hr class="divider">
    <div class="flex gap-1" style="flex-wrap:wrap">
      <button class="btn btn-sm" onclick="devPerformance()">Server Performance</button>
      <button class="btn btn-sm" onclick="devTables()">List Tables</button>
      <button class="btn btn-sm" onclick="devBackup()">DB Snapshot</button>
      <button class="btn btn-sm" onclick="devApiUsage()">API Usage</button>
    </div>
    <pre id="dev-info" style="background:var(--paper-dark);border:1px solid var(--paper-line);border-radius:3px;padding:0.8rem;margin-top:0.8rem;overflow:auto;max-height:200px;font-size:0.8rem;display:none"></pre>
  </div>`;
}

function showDevResult(data) {
  const el = document.getElementById('dev-result');
  if (el) { el.style.display = 'block'; el.textContent = JSON.stringify(data, null, 2); }
}
function showDevInfo(data) {
  const el = document.getElementById('dev-info');
  if (el) { el.style.display = 'block'; el.textContent = JSON.stringify(data, null, 2); }
}

window.devRunQuery = async () => {
  const sql = document.getElementById('dev-sql')?.value?.trim();
  if (!sql) return;
  try { const r = await api('/dev/database/query','POST',{sql}); showDevResult(r); } catch(e) { notify(e.message,'error'); }
};
window.devGrantTitle = async () => {
  const uid = document.getElementById('dev-title-uid')?.value;
  const title = document.getElementById('dev-title-text')?.value?.trim();
  const out = document.getElementById('dev-title-out');
  if (!uid) { if (out) out.textContent = 'User ID required.'; return; }
  try {
    const r = await api('/dev/users/' + uid + '/custom-title', 'PUT', { title: title || null });
    if (out) out.textContent = r.message;
    notify(r.message, 'success');
  } catch(e) { if (out) out.textContent = e.message; notify(e.message, 'error'); }
};
window.devEditStats = async () => {
  const uid = document.getElementById('dev-uid')?.value;
  const rating = document.getElementById('dev-rating')?.value;
  const coins = document.getElementById('dev-coins')?.value;
  if (!uid) { notify('User ID required', 'error'); return; }
  const body = {};
  if (rating) body.rating = parseInt(rating);
  if (coins)  body.coins  = parseInt(coins);
  try { await api('/dev/users/' + uid + '/stats','PUT',body); notify('Stats updated', 'success'); } catch(e) { notify(e.message,'error'); }
};
window.devCreatePromo = async () => {
  const g = id => document.getElementById(id);
  const name = g('promo-name')?.value?.trim();
  if (!name) { notify('Name required', 'error'); return; }
  const body = {
    name,
    type:          g('promo-type')?.value || 'Fire',
    cls:           g('promo-cls')?.value  || 'Titan',
    hp:            parseInt(g('promo-hp')?.value)     || 200,
    atk:           parseInt(g('promo-atk')?.value)    || 100,
    def:           parseInt(g('promo-def')?.value)    || 80,
    spd:           parseInt(g('promo-spd')?.value)    || 80,
    ability_name:  g('promo-aname')?.value?.trim()   || 'Promo Strike',
    ability_desc:  g('promo-adesc')?.value?.trim()   || 'A legendary promo ability.',
    ability_power: parseInt(g('promo-apower')?.value) || 130,
    rarity:        g('promo-rarity')?.value          || 'Mythic',
    shop_price:    parseInt(g('promo-price')?.value)  || 0,
    set_name:      g('promo-set')?.value?.trim()     || 'Promo Series',
    art_style:     g('promo-art')?.value             || 'ink',
    flavor_text:   g('promo-flavor')?.value?.trim()  || '',
    retreat_cost:  parseInt(g('promo-retreat')?.value) || 1,
    is_numbered:   g('promo-numbered')?.checked      || false,
    print_limit:   g('promo-print-limit')?.value ? parseInt(g('promo-print-limit').value) : null,
    expires_at:    g('promo-expires')?.value || null,
  };
  try {
    const r = await api('/dev/cards/promo','POST', body);
    notify('Promo card created: ID ' + r.id, 'success');
    S._promoCards = await api('/shop/promos').catch(()=>[]);
  } catch(e) { notify(e.message,'error'); }
};
window.devSetRating = async () => {
  const uid = document.getElementById('dev-lb-uid')?.value;
  const rating = document.getElementById('dev-lb-rating')?.value;
  if (!uid || !rating) { notify('User ID and rating required', 'error'); return; }
  try { await api('/dev/ranked/leaderboard/' + uid,'PUT',{rating: parseInt(rating)}); notify('Rating set', 'success'); } catch(e) { notify(e.message,'error'); }
};
window.devSetEconomy = async () => {
  const pack_cost   = document.getElementById('eco-pack')?.value;
  const daily_coins = document.getElementById('eco-daily')?.value;
  const win_coins   = document.getElementById('eco-win')?.value;
  const body = {};
  if (pack_cost)   body.pack_cost   = parseInt(pack_cost);
  if (daily_coins) body.daily_coins = parseInt(daily_coins);
  if (win_coins)   body.win_coins   = parseInt(win_coins);
  try { await api('/dev/economy','PUT',body); notify('Economy updated', 'success'); } catch(e) { notify(e.message,'error'); }
};
window.devLoadMaintenance = async () => {
  try {
    const rows = await api('/dev/config');
    S._maintenanceState = S._maintenanceState || {};
    for (const f of ['battle','packs','friends','ranked']) {
      const row = rows.find(r => r.key === 'maintenance_' + f);
      S._maintenanceState[f] = row?.value === 'true';
    }
    const el = document.getElementById('admin-content');
    if (el) { el.innerHTML = renderAdminTab(); attachListeners(); }
    notify('Maintenance status refreshed', 'success');
  } catch(e) { notify(e.message,'error'); }
};
window.devToggleMaint = async (feature) => {
  const currentOn = S._maintenanceState?.[feature] || false;
  const enabled = !currentOn;
  try {
    await api('/dev/maintenance/' + feature, 'PUT', { enabled });
    if (!S._maintenanceState) S._maintenanceState = {};
    S._maintenanceState[feature] = enabled;
    const el = document.getElementById('admin-content');
    if (el) { el.innerHTML = renderAdminTab(); attachListeners(); }
    notify(`${feature} maintenance ${enabled ? 'ENABLED — feature is now blocked' : 'DISABLED — feature is live'}`, enabled ? 'error' : 'success');
  } catch(e) { notify(e.message,'error'); }
};
window.devCreatePack = async () => {
  const g = id => document.getElementById(id);
  const pack_id = g('pk-id')?.value?.trim().toLowerCase();
  const name    = g('pk-name')?.value?.trim();
  if (!pack_id || !name) { notify('Pack ID and Name required', 'error'); return; }
  const o1 = parseFloat(g('pk-o1')?.value) || 0;
  const o2 = parseFloat(g('pk-o2')?.value) || 0;
  const o3 = parseFloat(g('pk-o3')?.value) || 0;
  const o4 = parseFloat(g('pk-o4')?.value) || 0;
  const o5 = parseFloat(g('pk-o5')?.value) || 0;
  const o6 = parseFloat(g('pk-o6')?.value) || 0;
  const total = +(o1+o2+o3+o4+o5+o6).toFixed(2);
  if (total < 99 || total > 101) { notify(`Odds sum to ${total}, must be 100`, 'error'); return; }
  const odds = {};
  if (o1) odds['Mythic,Prism'] = o1;
  if (o2) odds['Numbered,Full_Art'] = o2;
  if (o3) odds['Ultra_Rare,Secret_Rare,Parallel'] = o3;
  if (o4) odds['Rare'] = o4;
  if (o5) odds['Uncommon'] = o5;
  if (o6) odds['Common'] = o6;
  const fset   = g('pk-fset')?.value?.trim();
  const ftypes = g('pk-ftypes')?.value?.trim();
  const card_filter = (fset || ftypes) ? {
    ...(fset ? { set_name: fset } : {}),
    ...(ftypes ? { types: ftypes.split(',').map(t => t.trim()).filter(Boolean) } : {})
  } : null;
  const body = {
    pack_id, name, cost: parseInt(g('pk-cost')?.value)||200, count: parseInt(g('pk-count')?.value)||5,
    description: g('pk-desc')?.value?.trim()||'', badge: g('pk-badge')?.value?.trim()||'CUSTOM',
    accent_color: g('pk-color')?.value||'#4dd9ff', odds, card_filter
  };
  try {
    await api('/dev/packs','POST', body);
    notify('Pack created: ' + pack_id, 'success');
    S._customPacks = await api('/packs/list').catch(() => S._customPacks || []);
    devLoadPacks();
  } catch(e) { notify(e.message,'error'); }
};
function _renderPackCardsList(cards, packId) {
  if (!cards.length) return '<p class="text-muted" style="font-size:0.85rem">No cards in pool yet — add some below.</p>';
  return `<div style="display:flex;flex-wrap:wrap;gap:0.4rem">${cards.map(c => {
    const tc = TYPE_ENERGY_COLORS[c.type] || '#888';
    return `<div style="display:flex;align-items:center;gap:0.35rem;background:var(--paper-dark);border:1px solid ${tc}44;border-radius:6px;padding:0.25rem 0.55rem;font-size:0.8rem">
      <span class="orb-dot orb-full" style="background:${tc};box-shadow:0 0 4px ${tc};width:16px;height:16px;font-size:0.55rem;flex-shrink:0">${c.type[0]}</span>
      <span style="font-weight:600">${c.name}</span>
      <span class="text-muted">#${c.id}</span>
      <span style="color:${tc};font-size:0.72rem">${c.rarity?.replace('_',' ')}</span>
      <button onclick="devRemoveCardFromPack('${packId}',${c.id})" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:0.9rem;padding:0;line-height:1" title="Remove">×</button>
    </div>`;
  }).join('')}</div>`;
}

function _renderDevPackList(packs) {
  if (!packs.length) return '<p class="text-muted" style="font-size:0.85rem">No custom packs yet.</p>';
  return packs.map(p => `
    <div style="display:flex;align-items:center;gap:0.6rem;background:var(--paper-dark);border:1px solid var(--paper-line);border-radius:6px;padding:0.4rem 0.7rem;margin-bottom:0.35rem;flex-wrap:wrap">
      <span style="font-weight:700;color:${p.accent_color}">${p.name}</span>
      <span class="text-muted" style="font-size:0.8rem">ID: ${p.pack_id}</span>
      <span class="text-muted" style="font-size:0.8rem">${p.cost} coins · ${p.count} cards</span>
      <span class="badge" style="font-size:0.7rem;background:${p.accent_color}22;color:${p.accent_color};border:1px solid ${p.accent_color}44">${p.badge}</span>
      <button class="btn btn-red btn-sm" style="margin-left:auto;padding:0.2rem 0.6rem;font-size:0.78rem" onclick="devDeletePack('${p.pack_id}')">Delete</button>
    </div>`).join('');
}
window.devLoadPacks = async () => {
  try {
    S._devPacks = await api('/dev/packs');
    const el = document.getElementById('admin-content');
    if (el) { el.innerHTML = renderAdminTab(); attachListeners(); }
  } catch(e) { notify(e.message,'error'); }
};
window.devDeletePack = async (packId) => {
  if (!confirm(`Delete pack "${packId}"? This cannot be undone.`)) return;
  try {
    await api('/dev/packs/' + packId, 'DELETE');
    notify('Pack deleted', 'success');
    S._customPacks = await api('/packs/list').catch(() => S._customPacks || []);
    devLoadPacks();
  } catch(e) { notify(e.message,'error'); }
};
async function _reloadPackCards(packId) {
  const r = await api('/dev/packs/' + packId);
  S._selectedPackCards = r.cards || [];
  S._selectedPackId = packId;
  const el = document.getElementById('admin-content');
  if (el) { el.innerHTML = renderAdminTab(); attachListeners(); }
}
window.devSelectPack = async (packId) => {
  if (!packId) { S._selectedPackId = null; S._selectedPackCards = []; const el = document.getElementById('admin-content'); if (el) { el.innerHTML = renderAdminTab(); attachListeners(); } return; }
  try { await _reloadPackCards(packId); } catch(e) { notify(e.message, 'error'); }
};
window.devAddCardToPack = async () => {
  const id = parseInt(document.getElementById('pk-add-card-id')?.value);
  if (!id || !S._selectedPackId) { notify('Select a pack and enter a card ID', 'error'); return; }
  try {
    const current = (S._selectedPackCards || []).map(c => c.id);
    if (current.includes(id)) { notify('Card already in this pack', 'error'); return; }
    await api(`/dev/packs/${S._selectedPackId}/cards`, 'PUT', { card_ids: [...current, id] });
    notify('Card added to pack', 'success');
    await _reloadPackCards(S._selectedPackId);
  } catch(e) { notify(e.message, 'error'); }
};
window.devRemoveCardFromPack = async (packId, cardId) => {
  try {
    const current = (S._selectedPackCards || []).map(c => c.id).filter(id => id !== cardId);
    await api(`/dev/packs/${packId}/cards`, 'PUT', { card_ids: current });
    notify('Card removed from pack', 'success');
    await _reloadPackCards(packId);
  } catch(e) { notify(e.message, 'error'); }
};
window.devCreateCardForPack = async (packId) => {
  const g = id => document.getElementById(id);
  const name = g('pkc-name')?.value?.trim();
  if (!name) { notify('Card name required', 'error'); return; }
  const body = {
    name,
    type:          g('pkc-type')?.value || 'Fire',
    cls:           g('pkc-cls')?.value  || 'Titan',
    hp:            parseInt(g('pkc-hp')?.value)      || 180,
    atk:           parseInt(g('pkc-atk')?.value)     || 100,
    def:           parseInt(g('pkc-def')?.value)     || 80,
    spd:           parseInt(g('pkc-spd')?.value)     || 80,
    ability_name:  g('pkc-aname')?.value?.trim()    || 'Custom Strike',
    ability_desc:  g('pkc-adesc')?.value?.trim()    || '',
    ability_power: parseInt(g('pkc-apower')?.value)  || 120,
    rarity:        g('pkc-rarity')?.value           || 'Rare',
    retreat_cost:  parseInt(g('pkc-retreat')?.value) || 2,
    flavor_text:   g('pkc-flavor')?.value?.trim()   || '',
    art_style:     'ink',
    is_numbered:   g('pkc-numbered')?.checked       || false,
    print_limit:   g('pkc-printlimit')?.value ? parseInt(g('pkc-printlimit').value) : null,
  };
  try {
    const r = await api(`/dev/packs/${packId}/card`, 'POST', body);
    notify(`Card "${r.name}" (ID ${r.id}) created and added to pack!`, 'success');
    const out = document.getElementById('pkc-out');
    if (out) out.textContent = `✓ Created ID ${r.id}`;
    S._customPacks = await api('/packs/list').catch(() => S._customPacks || []);
    await _reloadPackCards(packId);
  } catch(e) { notify(e.message, 'error'); }
};
window.devGrantCards = async () => {
  const uid  = document.getElementById('dev-grant-uid')?.value;
  const cids = document.getElementById('dev-grant-cids')?.value?.split(',').map(s => parseInt(s.trim())).filter(Boolean);
  if (!uid || !cids?.length) { notify('User ID and card IDs required', 'error'); return; }
  try { const r = await api('/dev/users/' + uid + '/collection/grant','PUT',{card_ids: cids}); notify(r.message, 'success'); } catch(e) { notify(e.message,'error'); }
};
window.devCreateRank = async () => {
  const name = document.getElementById('dev-rank-name')?.value?.trim();
  const min  = document.getElementById('dev-rank-min')?.value;
  if (!name || !min) { notify('Name and min rating required', 'error'); return; }
  try { await api('/dev/ranked/create-rank','POST',{name,min_rating: parseInt(min)}); notify('Rank created', 'success'); } catch(e) { notify(e.message,'error'); }
};
window.devPerformance = async () => { try { showDevInfo(await api('/dev/performance')); } catch(e) { notify(e.message,'error'); } };
window.devTables     = async () => { try { showDevInfo(await api('/dev/database/tables')); } catch(e) { notify(e.message,'error'); } };
window.devBackup     = async () => { try { showDevInfo(await api('/dev/database/backup','POST')); } catch(e) { notify(e.message,'error'); } };

window.devGiveById = async () => {
  const out = document.getElementById('dev-cmd-out');
  const cardId = parseInt(document.getElementById('dev-give-id')?.value);
  const target = document.getElementById('dev-give-target')?.value?.trim();
  if (!cardId) { notify('Enter a card ID', 'error'); return; }
  try {
    const r = await api('/dev/give', 'POST', { card_id: cardId, username: target || null });
    if (out) out.innerHTML = `<span style="color:var(--teal)">✓ ${r.message}</span>`;
    notify(r.message, 'success');
    const col = await api('/user/collection');
    S.collection = col || [];
  } catch(e) {
    if (out) out.innerHTML = `<span style="color:var(--red)">${e.message}</span>`;
    notify(e.message, 'error');
  }
};

window.devCardSearch = async () => {
  const q = document.getElementById('dev-card-search')?.value?.trim();
  const resultsEl = document.getElementById('dev-card-results');
  const out = document.getElementById('dev-cmd-out');
  if (!q || !resultsEl) return;
  try {
    const cards = await api(`/dev/cards/search?q=${encodeURIComponent(q)}`);
    if (!cards.length) { resultsEl.innerHTML = '<span class="text-muted">No cards found</span>'; return; }
    resultsEl.innerHTML = cards.map(c =>
      `<div style="display:flex;align-items:center;gap:0.6rem;background:var(--navy-light);border:1px solid var(--navy-border);border-radius:4px;padding:0.4rem 0.8rem;font-size:0.85rem">
        <span style="color:${typeColor(c.type)};font-size:0.78rem;min-width:50px">${c.type}</span>
        <span style="flex:1"><strong>${c.name}</strong> <span class="text-muted" style="font-size:0.78rem">#${c.id} · ${c.rarity}${c.set_name ? ' · '+c.set_name : ''}</span></span>
        <button class="btn btn-sm btn-primary" style="padding:0.2rem 0.7rem;font-size:0.8rem;white-space:nowrap" onclick="devGiveCard(${c.id})">Give</button>
      </div>`
    ).join('');
  } catch(e) { if (out) out.innerHTML = `<span style="color:var(--red)">${e.message}</span>`; }
};

window.devGiveCard = async (cardId) => {
  const out = document.getElementById('dev-cmd-out');
  const target = document.getElementById('dev-give-target')?.value?.trim();
  try {
    const r = await api('/dev/give', 'POST', { card_id: cardId, username: target || null });
    if (out) out.innerHTML = `<span style="color:var(--teal)">✓ ${r.message}</span>`;
    notify(r.message, 'success');
    // Refresh collection so the card appears immediately
    const col = await api('/user/collection');
    S.collection = col || [];
  } catch(e) {
    if (out) out.innerHTML = `<span style="color:var(--red)">${e.message}</span>`;
    notify(e.message, 'error');
  }
};

window._devRmPage = 1;
window.devRmLoadInv = async (page = 1) => {
  const uid = document.getElementById('dev-rm-uid')?.value?.trim();
  const q = document.getElementById('dev-rm-search')?.value?.trim();
  const resultsEl = document.getElementById('dev-rm-results');
  const pagesEl = document.getElementById('dev-rm-pages');
  const out = document.getElementById('dev-rm-out');
  if (!uid) { notify('User ID required', 'error'); return; }
  window._devRmPage = page;
  window._devRmUid = uid;
  try {
    let url = `/dev/users/${uid}/collection?page=${page}`;
    if (q) url += '&search=' + encodeURIComponent(q);
    const data = await api(url);
    if (!data.cards.length) { resultsEl.innerHTML = '<span class="text-muted">No cards in inventory.</span>'; pagesEl.innerHTML = ''; return; }
    resultsEl.innerHTML = data.cards.map(c =>
      `<div style="display:flex;align-items:center;gap:0.6rem;background:var(--navy-light);border:1px solid var(--navy-border);border-radius:4px;padding:0.35rem 0.7rem;font-size:0.83rem">
        <span style="color:${typeColor(c.type)};font-size:0.78rem;min-width:48px">${c.type}</span>
        <span style="flex:1"><strong>${c.name}</strong> <span class="text-muted" style="font-size:0.76rem">#${c.id} · ${c.rarity}${c.set_name?' · '+c.set_name:''}</span></span>
        ${c.quantity > 1 ? `<span class="text-muted" style="font-size:0.78rem">x${c.quantity}</span>` : ''}
        <button class="btn btn-sm btn-red" style="padding:0.15rem 0.6rem;font-size:0.78rem" onclick="devRemoveCard(${c.id},${uid})">Remove</button>
      </div>`
    ).join('');
    const totalPages = Math.ceil(data.total / 30);
    pagesEl.innerHTML = totalPages > 1
      ? `${page > 1 ? `<button class="btn btn-sm" onclick="devRmLoadInv(${page-1})">◀</button>` : ''}
         <span class="text-muted">Page ${page} / ${totalPages} &nbsp;(${data.total} cards)</span>
         ${page < totalPages ? `<button class="btn btn-sm" onclick="devRmLoadInv(${page+1})">▶</button>` : ''}`
      : `<span class="text-muted">${data.total} card${data.total!==1?'s':''}</span>`;
  } catch(e) { if (out) out.innerHTML = `<span style="color:var(--red)">${e.message}</span>`; }
};

window.devRemoveCard = async (cardId, uid) => {
  const out = document.getElementById('dev-rm-out');
  try {
    const r = await api('/dev/remove-card', 'POST', { card_id: cardId, user_id: uid });
    if (out) out.innerHTML = `<span style="color:var(--teal)">✓ ${r.message}</span>`;
    notify(r.message, 'success');
    devRmLoadInv(window._devRmPage);
  } catch(e) {
    if (out) out.innerHTML = `<span style="color:var(--red)">${e.message}</span>`;
    notify(e.message, 'error');
  }
};

window.devResetStats = async () => {
  const out = document.getElementById('dev-reset-out');
  const username = document.getElementById('dev-reset-username')?.value?.trim();
  if (!username) { notify('Username required', 'error'); return; }
  if (!confirm(`Reset all stats for "${username}"? This cannot be undone.`)) return;
  try {
    const r = await api('/dev/reset-stats', 'POST', { username });
    if (out) out.innerHTML = `<span style="color:var(--teal)">✓ ${r.message}</span>`;
    notify(r.message, 'success');
  } catch(e) {
    if (out) out.innerHTML = `<span style="color:var(--red)">${e.message}</span>`;
    notify(e.message, 'error');
  }
};
window.devApiUsage   = async () => { try { showDevInfo(await api('/dev/api-usage')); } catch(e) { notify(e.message,'error'); } };

// ─── EVENT DELEGATION ─────────────────────────────────────────────
function attachListeners() {
  // keyboard submit for forms
  document.querySelectorAll('.input-box, .input-sketch').forEach(el => {
    el.removeEventListener('keydown', handleEnter);
    el.addEventListener('keydown', handleEnter);
  });
}
function handleEnter(e) {
  if (e.key !== 'Enter') return;
  const view = S.view;
  if (view === 'friends') sendFriendRequest();
}

// ─── NOTIFICATION POLLING ─────────────────────────────────────────
async function pollNotifications() {
  if (!S.user) return;
  try {
    const fresh = await api('/notifications');
    const prevUnread = S.notifications.filter(n => !n.read).length;
    S.notifications = fresh;
    const newUnread = fresh.filter(n => !n.read).length;
    // Show toast for any new notifications
    if (newUnread > prevUnread) {
      const newest = fresh.find(n => !n.read);
      if (newest) notify(newest.message, newest.type === 'friend_accepted' ? 'success' : 'info');
    }
    updateNotifBell();
  } catch {}
}

// ─── INIT ──────────────────────────────────────────────────────────
async function init() {
  const hash = window.location.hash.replace('#','') || 'login';
  S.view = hash;

  if (S.token) {
    try {
      S.user = await api('/auth/me');
      if (S.view === 'login' || S.view === 'register') S.view = 'home';
    } catch {
      S.token = null;
      localStorage.removeItem('mtcg_token');
      S.view = 'login';
    }
  }

  if (S.user) {
    const [col, friends, lb, myRank, reports, ann, settings, notifs, newsData, cqProgress] = await Promise.allSettled([
      api('/user/collection'),
      api('/friends'),
      api('/ranked/leaderboard'),
      api('/ranked/me'),
      api('/reports/mine'),
      api('/announcements'),
      api('/settings'),
      api('/notifications'),
      api('/news'),
      api('/conquest/progress'),
    ]);
    S.collection       = col.value          || [];
    S.friends          = friends.value      || [];
    S.leaderboard      = lb.value           || [];
    S.myRank           = myRank.value       || null;
    S.reports          = reports.value      || [];
    S.announcements    = ann.value          || [];
    S.settings         = settings.value     || {};
    S.notifications    = notifs.value       || [];
    S.news             = newsData.value     || [];
    S.conquestProgress = cqProgress.value?.progress || [];
    S.conquestPieces   = cqProgress.value?.pieces   || [];
    const deckFetch = await api('/deck').catch(() => null);
    S.deck      = deckFetch?.card_ids || [];
    S.deckCards = deckFetch?.cards    || [];
    S._promoCards  = await api('/shop/promos').catch(() => []);
    S._customPacks = await api('/packs/list').catch(() => []);
    // Load coaches and traits silently
    api('/coaches').then(d => { S.myCoaches = d.coaches||[]; S.myEquippedCoachId = d.equippedId; }).catch(()=>{});
    api('/traits').then(d => { S.myTraits = d.traits||[]; S.myCardTraits = d.cardTraits||{}; }).catch(()=>{});
    api('/quests').then(d => { S.myQuests = d.quests||[]; }).catch(()=>{});
    api('/battlepass').then(d => { S.myBattlepass = d.battlepass; S.bpRewards = d.rewards||[]; }).catch(()=>{});
    if (S.settings.theme) applyTheme(S.settings.theme);

    if (ROLE_ORDER.indexOf(S.user.role) >= 1) {
      const [adminUsers, adminReports] = await Promise.allSettled([
        api('/admin/users'),
        api('/admin/reports'),
      ]);
      S._adminUsers   = adminUsers.value   || [];
      S._adminReports = adminReports.value || [];
    }

    // ── Auto-refresh: everything every 15s ────────────────────────
    setInterval(async () => {
      if (!S.user) return;
      const [
        me, cqProg, notifs, friends, dmUnread,
        col, deckFetch, rank, lb,
        newsData, ann, reports, promos,
      ] = await Promise.allSettled([
        api('/auth/me'),
        api('/conquest/progress'),
        api('/notifications'),
        api('/friends'),
        api('/dm/unread'),
        api('/user/collection'),
        api('/deck'),
        api('/ranked/me'),
        api('/ranked/leaderboard'),
        api('/news'),
        api('/announcements'),
        api('/reports/mine'),
        api('/shop/promos'),
      ]);

      // User stats
      if (me.value) {
        const coinsChanged = me.value.coins !== S.user.coins;
        S.user = { ...S.user, ...me.value };
        if (coinsChanged) updateNavCoins();
      }

      // Conquest progress
      if (cqProg.value) {
        const newProgress = cqProg.value?.progress || [];
        const newPieces   = cqProg.value?.pieces   || [];
        const changed = JSON.stringify(newProgress) !== JSON.stringify(S.conquestProgress);
        S.conquestProgress = newProgress;
        S.conquestPieces   = newPieces;
        if (changed && S.view === 'conquest') { document.getElementById('page').innerHTML = viewConquest(); attachListeners(); }
      }

      // Notifications
      if (notifs.value) {
        const prevCount = S.notifications.filter(n => !n.read).length;
        S.notifications = notifs.value;
        const newCount = notifs.value.filter(n => !n.read).length;
        if (newCount > prevCount) updateNotifBadge?.();
      }

      // Friends
      if (friends.value) {
        const prevPending = S.friends.filter(f => f.status === 'pending').length;
        const newPending  = friends.value.filter(f => f.status === 'pending').length;
        S.friends = friends.value;
        if (newPending > prevPending && S.view !== 'friends') notify('You have a new friend request!', 'info');
        if (S.view === 'friends') _rerenderFriendsPage();
      }

      // DM unread
      if (dmUnread.value) {
        const prev = { ...S.dmUnread };
        S.dmUnread = {};
        dmUnread.value.forEach(r => { S.dmUnread[r.sender_id] = parseInt(r.count); });
        const totalNow  = dmUnread.value.reduce((s, r) => s + parseInt(r.count), 0);
        const totalPrev = Object.values(prev).reduce((s, v) => s + v, 0);
        if (totalNow > totalPrev && S.view !== 'chat' && S.view !== 'friends') notify('New message from a friend!', 'info');
        if (S.view === 'friends') _rerenderFriendsPage();
      }

      // Collection + deck
      if (col.value) {
        const changed = S.collection.length !== col.value.length;
        S.collection = col.value;
        if (changed && S.view === 'collection') { document.getElementById('page').innerHTML = viewCollection(); attachListeners(); }
      }
      if (deckFetch.value) {
        S.deck      = deckFetch.value.card_ids || [];
        S.deckCards = deckFetch.value.cards    || [];
        if (S.view === 'deck') { document.getElementById('page').innerHTML = viewDeck(); attachListeners(); }
      }

      // Rank
      if (rank.value) {
        const changed = JSON.stringify(rank.value) !== JSON.stringify(S.myRank);
        S.myRank = rank.value;
        if (changed && S.view === 'ranked') { document.getElementById('page').innerHTML = viewRanked(); attachListeners(); }
      }

      // Leaderboard
      if (lb.value) {
        S.leaderboard = lb.value;
        if (S.view === 'ranked') { document.getElementById('page').innerHTML = viewRanked(); attachListeners(); }
      }

      // News + announcements
      if (newsData.value) {
        S.news = newsData.value;
        if (S.view === 'news') { document.getElementById('page').innerHTML = viewNews(); attachListeners(); }
      }
      if (ann.value) S.announcements = ann.value;

      // Reports
      if (reports.value) {
        S.reports = reports.value;
        if (S.view === 'reports') { document.getElementById('page').innerHTML = viewReports(); attachListeners(); }
      }

      // Promo cards
      if (promos.value) S._promoCards = promos.value;

    }, 15000);
  }

  render();
  if (S.user && !localStorage.getItem('mtcg_tutorial_done')) {
    setTimeout(() => showTutorial(0), 600);
  }
  Music.autoStart();
  window.addEventListener('hashchange', () => {
    const v = window.location.hash.replace('#','');
    if (v && v !== S.view) {
      // Stop friends chat poll when leaving friends page
      if (S.view === 'friends' && v !== 'friends' && S._friendsChatPoll) {
        clearInterval(S._friendsChatPoll); S._friendsChatPoll = null;
      }
      S.view = v;
      // Refresh news when switching to news tab
      if (v === 'news') api('/news').then(d => { S.news = d; document.getElementById('page').innerHTML = viewNews(); }).catch(()=>{});
      // Refresh friends when switching to friends tab
      if (v === 'friends') api('/friends').then(d => { S.friends = d; document.getElementById('page').innerHTML = viewFriends(); attachListeners(); if (S.friendsChatWith) startFriendsChatPolling(S.friendsChatWith.userId); }).catch(()=>{});
      // Load card browser
      if (v === 'cards') loadCardBrowser();
      render();
    }
  });

  // Close notif panel when clicking outside
  document.addEventListener('click', (e) => {
    const panel = document.getElementById('notif-panel');
    const bell  = document.querySelector('.notif-bell');
    if (panel && !panel.contains(e.target) && bell && !bell.contains(e.target)) {
      panel.classList.add('hidden');
    }
  });
}

init();
