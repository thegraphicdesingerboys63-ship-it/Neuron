import 'dotenv/config';
import express          from 'express';
import jwt              from 'jsonwebtoken';
import bcrypt           from 'bcryptjs';
import { randomUUID }   from 'crypto';
import { fileURLToPath } from 'url';
import { dirname }       from 'path';
import { createServer }  from 'http';
import { WebSocketServer } from 'ws';
import { execute as dbExec, initSchema, seedAccounts } from './db.js';

const db = { execute: dbExec };


const __dirname  = dirname(fileURLToPath(import.meta.url));
const app        = express();
const httpServer = createServer(app);
const PORT       = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'neuron-dev-secret-change-in-prod';
const RESERVED   = ['FTO_Ray', 'AMGProdZ'];

app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function uid() { return randomUUID().replace(/-/g, ''); }

function safeRole(role, viewerRole) {
  return (role === 'supreme' && viewerRole !== 'supreme') ? 'owner' : (role || 'user');
}

const RANK = { user: 0, admin: 1, owner: 2, supreme: 3 };
function roleRank(r) { return RANK[r] ?? 0; }

function canManage(managerRole, targetRole) {
  if (managerRole === targetRole) return false;
  if (managerRole === 'supreme')  return true;
  if (managerRole === 'owner')    return targetRole === 'user' || targetRole === 'admin';
  return false;
}

async function getUser(username) {
  return (await db.execute({ sql: 'SELECT * FROM users WHERE username = ?', args: [username] })).rows[0] ?? null;
}

function isBanned(user) {
  if (!user || !user.banned) return false;
  if (!user.banned_until) return true;
  return Date.now() < new Date(user.banned_until).getTime();
}

async function getServerMember(serverId, username) {
  return (await db.execute({ sql: 'SELECT * FROM server_members WHERE server_id = ? AND username = ?', args: [serverId, username] })).rows[0] ?? null;
}

async function getServer(serverId) {
  return (await db.execute({ sql: 'SELECT * FROM servers WHERE id = ?', args: [serverId] })).rows[0] ?? null;
}

async function auditLog(serverId, actor, action, target = null, detail = null) {
  await db.execute({
    sql: 'INSERT INTO server_audit_log (id,server_id,actor,action,target,detail,created_at) VALUES (?,?,?,?,?,?,?)',
    args: [uid(), serverId, actor, action, target, detail, new Date().toISOString()],
  }).catch(() => {});
}

const SERVER_ROLE_RANK = { member: 0, mod: 1, admin: 2, owner: 3 };
function canManageServerMember(actorRole, targetRole) {
  if (actorRole === 'owner') return targetRole !== 'owner';
  if (actorRole === 'admin') return targetRole === 'member' || targetRole === 'mod';
  if (actorRole === 'mod')   return targetRole === 'member';
  return false;
}

// ─── Local Safety Engine ──────────────────────────────────────────────────────

const _SAFETY_RULES = [
  {
    cat: 'csam', severity: 'critical',
    patterns: [
      /\b(nude|naked|sex(ual)?|porn|explicit)\b.{0,30}\b(kid|child|minor|teen|underage|yo|year.?old|preteen|tween)\b/i,
      /\b(kid|child|minor|teen|underage|preteen)\b.{0,30}\b(nude|naked|sex(ual)?|porn|explicit)\b/i,
      /\b(cp|c\.p\.|childporn|child porn|kiddie ?porn|jailbait)\b/i,
    ],
    reason: 'Possible CSAM-related content detected.',
  },
  {
    cat: 'grooming', severity: 'critical',
    patterns: [
      /\b(don'?t tell (your )?mom|don'?t tell (your )?parents?|keep (it|this) (a )?secret|our (little )?secret)\b/i,
      /\b(i('?m| am) ?\d{2,3}).{0,40}\b(you('?re| are) ?\d{1,2}|your age)\b/i,
    ],
    reason: 'Possible grooming behaviour detected.',
  },
  {
    cat: 'doxxing', severity: 'critical',
    patterns: [
      /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/,
      /\b\d{1,6}\s+[a-z]{2,}\s+(street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|way|court|ct|place|pl)\b/i,
      /\b(here('?s| is)|posting|leaking|dropping).{0,20}(address|ssn|social security|phone number|location|ip address)\b/i,
    ],
    reason: 'Possible doxxing — personal information shared.',
  },
  {
    cat: 'threats', severity: 'high',
    patterns: [
      /\b(i('?m| am| will| gonna| going to)).{0,30}(kill|shoot|stab|murder|hurt|attack|beat)\b.{0,20}(you|u|him|her|them)\b/i,
      /\b(bomb|shoot up|mass (shooting|killing|murder)).{0,40}(school|church|mall|building)\b/i,
    ],
    reason: 'Credible threat of violence detected.',
  },
  {
    cat: 'harassment', severity: 'high',
    patterns: [
      /\b(you should|go|just|please).{0,15}(kill your(self|selves)|kys|end your(self| it))\b/i,
    ],
    reason: 'Severe targeted harassment detected.',
  },
];

function _localSafetyCheck(content) {
  if (!content || typeof content !== 'string') return null;
  const text = content.trim();
  if (text.length < 3) return null;
  for (const rule of _SAFETY_RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(text)) {
        return { flagged: true, categories: [rule.cat], severity: rule.severity, reason: rule.reason };
      }
    }
  }
  return null;
}

async function moderateContent(messageId, content, author, src = 'channel', serverId = null, channelId = null) {
  if (!content || content.startsWith('[SYSTEM]')) return;
  try {
    const result = _localSafetyCheck(content);
    if (!result) return;
    const flagId = uid();
    await db.execute({
      sql: 'INSERT INTO ai_flags (id,message_id,message_src,author,content,categories,severity,reason,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      args: [flagId, messageId, src, author, content.slice(0, 500), JSON.stringify(result.categories), result.severity, result.reason, new Date().toISOString()],
    });
    if (result.severity === 'critical') {
      const tbl = src === 'server' ? 'server_messages' : src === 'dm' ? 'conv_messages' : 'server_messages';
      await db.execute({ sql: `UPDATE ${tbl} SET deleted = 1 WHERE id = ?`, args: [messageId] });
      await db.execute({ sql: 'UPDATE users SET banned = 1, banned_until = NULL WHERE username = ?', args: [author] });
      await db.execute({ sql: 'UPDATE ai_flags SET auto_action = ? WHERE id = ?', args: ['deleted_banned', flagId] });
    } else if (result.severity === 'high') {
      if (serverId && channelId) {
        await db.execute({
          sql: 'INSERT INTO reports (id,msg_id,channel_id,server_id,reporter,reason,timestamp,status,priority) VALUES (?,?,?,?,?,?,?,?,?)',
          args: [uid(), messageId, channelId, serverId, '[Safety Filter]', result.reason, new Date().toISOString(), 'pending', 1],
        });
      }
      await db.execute({ sql: 'UPDATE ai_flags SET auto_action = ? WHERE id = ?', args: ['flagged', flagId] });
    }
  } catch (e) { console.error('Safety filter error:', e.message); }
}

// ─── Settings cache ────────────────────────────────────────────────────────────

let _sc = null, _scTime = 0;
async function getSettings() {
  if (_sc && Date.now() - _scTime < 8000) return _sc;
  const rows = (await db.execute({ sql: 'SELECT key, value FROM settings', args: [] })).rows;
  _sc = {};
  for (const r of rows) _sc[r.key] = r.value;
  _scTime = Date.now();
  return _sc;
}
function invalidateSettings() { _sc = null; }

// ─── Middleware ───────────────────────────────────────────────────────────────

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (roles.includes(req.user?.role)) return next();
    res.status(403).json({ error: 'Forbidden' });
  };
}
const requireOwnerOrAbove = requireRole('owner', 'supreme');
const requireAdminOrAbove = requireRole('admin', 'owner', 'supreme');

// ════════════════════════════════════════════════════════════ AUTH ══════════

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body ?? {};
    if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });
    if (!RESERVED.includes(username)) {
      const s = await getSettings();
      if (s.maintenance_mode === '1') return res.status(503).json({ error: 'Server is in maintenance mode.' });
    }
    if (!/^[a-zA-Z0-9_]{3,15}$/.test(username)) return res.status(400).json({ error: 'Username must be 3–15 characters.' });

    let user = await getUser(username);
    if (user) {
      if (!await bcrypt.compare(password, user.password)) return res.status(401).json({ error: 'Incorrect password.' });
      if (isBanned(user)) {
        const until = user.banned_until ? `until ${new Date(user.banned_until).toLocaleString()}` : 'permanently';
        return res.status(403).json({ error: `You are banned ${until}.` });
      }
    } else {
      if (RESERVED.includes(username)) return res.status(400).json({ error: 'That username is reserved.' });
      const hash = await bcrypt.hash(password, 10);
      await db.execute({ sql: 'INSERT INTO users (username,password,role,created_at) VALUES (?,?,?,?)', args: [username, hash, 'user', new Date().toISOString()] });
      user = await getUser(username);
      // Auto-join public servers
      const publicServers = (await db.execute({ sql: 'SELECT id FROM servers WHERE is_public = 1', args: [] })).rows;
      for (const s of publicServers) {
        await db.execute({
          sql: 'INSERT INTO server_members (server_id,username,display_role,joined_at) VALUES (?,?,?,?) ON CONFLICT DO NOTHING',
          args: [s.id, username, 'member', new Date().toISOString()],
        });
      }
    }

    const token = jwt.sign({ username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username: user.username, role: user.role });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error.' }); }
});

app.get('/api/me', auth, async (req, res) => {
  try {
    const user = await getUser(req.user.username);
    if (!user) return res.status(401).json({ error: 'User not found.' });
    res.json({ username: user.username, role: user.role, tosAccepted: !!user.tos_accepted, parentalControls: !!user.parental_controls });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/tos/accept', auth, async (req, res) => {
  try {
    await db.execute({ sql: 'UPDATE users SET tos_accepted = 1, tos_accepted_at = ? WHERE username = ?', args: [new Date().toISOString(), req.user.username] });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.get('/api/tos/status', auth, async (req, res) => {
  try {
    const user = await getUser(req.user.username);
    res.json({ accepted: !!user?.tos_accepted });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.patch('/api/me/parental', auth, async (req, res) => {
  try {
    const { action, pin, currentPin } = req.body ?? {};
    const user = await getUser(req.user.username);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (action === 'enable') {
      if (!pin || pin.length < 4) return res.status(400).json({ error: 'PIN must be at least 4 digits.' });
      await db.execute({ sql: 'UPDATE users SET parental_controls = 1, parental_pin = ? WHERE username = ?', args: [await bcrypt.hash(pin, 10), user.username] });
      return res.json({ ok: true });
    }
    if (action === 'disable') {
      if (!currentPin) return res.status(400).json({ error: 'Current PIN required.' });
      if (!user.parental_pin) return res.status(400).json({ error: 'Not set up.' });
      if (!await bcrypt.compare(currentPin, user.parental_pin)) return res.status(401).json({ error: 'Incorrect PIN.' });
      await db.execute({ sql: 'UPDATE users SET parental_controls = 0, parental_pin = NULL WHERE username = ?', args: [user.username] });
      return res.json({ ok: true });
    }
    res.status(400).json({ error: 'Invalid action.' });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.patch('/api/me/password', auth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body ?? {};
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required.' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    const user = await getUser(req.user.username);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (!await bcrypt.compare(currentPassword, user.password)) return res.status(401).json({ error: 'Current password incorrect.' });
    await db.execute({ sql: 'UPDATE users SET password = ? WHERE username = ?', args: [await bcrypt.hash(newPassword, 10), user.username] });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.delete('/api/me', auth, async (req, res) => {
  try {
    const { password } = req.body ?? {};
    if (!password) return res.status(400).json({ error: 'Password required.' });
    const user = await getUser(req.user.username);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (RESERVED.includes(user.username)) return res.status(403).json({ error: 'This account cannot be deleted.' });
    if (!await bcrypt.compare(password, user.password)) return res.status(401).json({ error: 'Incorrect password.' });
    await db.execute({ sql: 'DELETE FROM users WHERE username = ?', args: [user.username] });
    await db.execute({ sql: 'UPDATE server_messages SET deleted = 1 WHERE author = ?', args: [user.username] });
    await db.execute({ sql: 'UPDATE conv_messages SET deleted = 1 WHERE author = ?', args: [user.username] });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

// ════════════════════════════════════════════════════ SERVERS ══════════

app.get('/api/servers', auth, async (req, res) => {
  try {
    const me = req.user.username;
    const rows = (await db.execute({
      sql: `SELECT s.*, sm.display_role,
              (SELECT COUNT(*) FROM server_members sm2 WHERE sm2.server_id = s.id) AS member_count
            FROM servers s
            JOIN server_members sm ON sm.server_id = s.id AND sm.username = ?
            ORDER BY s.created_at ASC`,
      args: [me],
    })).rows;
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error.' }); }
});

app.get('/api/servers/discover', auth, async (req, res) => {
  try {
    const me = req.user.username;
    const rows = (await db.execute({
      sql: `SELECT s.*,
              (SELECT COUNT(*) FROM server_members sm WHERE sm.server_id = s.id) AS member_count
            FROM servers s
            WHERE s.is_public = 1
              AND s.id NOT IN (SELECT server_id FROM server_members WHERE username = ?)
            ORDER BY member_count DESC LIMIT 20`,
      args: [me],
    })).rows;
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/servers', auth, async (req, res) => {
  try {
    const { name, description, icon_emoji, is_public } = req.body ?? {};
    if (!name?.trim()) return res.status(400).json({ error: 'Server name required.' });
    const me = req.user.username;
    const id = uid(), now = new Date().toISOString();
    await db.execute({
      sql: 'INSERT INTO servers (id,name,description,icon_emoji,owner,is_public,created_at) VALUES (?,?,?,?,?,?,?)',
      args: [id, name.trim().slice(0, 50), description?.slice(0, 200) || null, icon_emoji || '🌐', me, is_public ? 1 : 0, now],
    });
    await db.execute({
      sql: 'INSERT INTO server_members (server_id,username,display_role,joined_at) VALUES (?,?,?,?)',
      args: [id, me, 'owner', now],
    });
    // Default channels
    const catId = uid(), chanId = uid();
    await db.execute({ sql: 'INSERT INTO server_categories (id,server_id,name,position) VALUES (?,?,?,?)', args: [catId, id, 'CHAT', 0] });
    await db.execute({ sql: 'INSERT INTO server_channels (id,server_id,category_id,name,type,position) VALUES (?,?,?,?,?,?)', args: [chanId, id, catId, 'general', 'text', 0] });
    await db.execute({ sql: 'INSERT INTO server_messages (id,channel_id,server_id,author,content,type,timestamp) VALUES (?,?,?,?,?,?,?)', args: [uid(), chanId, id, '[SYSTEM]', `Welcome to **${name.trim()}**! 🎉`, 'system', now] });
    res.json({ id });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error.' }); }
});

app.get('/api/servers/:id', auth, async (req, res) => {
  try {
    const me = req.user.username;
    const member = await getServerMember(req.params.id, me);
    if (!member) return res.status(403).json({ error: 'Not a member.' });
    const server = await getServer(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found.' });
    const categories = (await db.execute({ sql: 'SELECT * FROM server_categories WHERE server_id = ? ORDER BY position ASC', args: [req.params.id] })).rows;
    const channels   = (await db.execute({ sql: 'SELECT * FROM server_channels   WHERE server_id = ? ORDER BY position ASC', args: [req.params.id] })).rows;
    const members    = (await db.execute({ sql: 'SELECT username, display_role, nickname, muted FROM server_members WHERE server_id = ? ORDER BY display_role ASC, username ASC', args: [req.params.id] })).rows;
    res.json({ ...server, categories, channels, members, myRole: member.display_role });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.patch('/api/servers/:id', auth, async (req, res) => {
  try {
    const member = await getServerMember(req.params.id, req.user.username);
    if (!member || (member.display_role !== 'owner' && req.user.role !== 'supreme'))
      return res.status(403).json({ error: 'Forbidden.' });
    const { name, description, icon_emoji, is_public } = req.body ?? {};
    if (name !== undefined) await db.execute({ sql: 'UPDATE servers SET name = ? WHERE id = ?', args: [name.trim().slice(0, 50), req.params.id] });
    if (description !== undefined) await db.execute({ sql: 'UPDATE servers SET description = ? WHERE id = ?', args: [description?.slice(0, 200) || null, req.params.id] });
    if (icon_emoji !== undefined) await db.execute({ sql: 'UPDATE servers SET icon_emoji = ? WHERE id = ?', args: [icon_emoji || '🌐', req.params.id] });
    if (is_public !== undefined) await db.execute({ sql: 'UPDATE servers SET is_public = ? WHERE id = ?', args: [is_public ? 1 : 0, req.params.id] });
    auditLog(req.params.id, req.user.username, 'server_settings_update');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.delete('/api/servers/:id', auth, async (req, res) => {
  try {
    const server = await getServer(req.params.id);
    if (!server) return res.status(404).json({ error: 'Not found.' });
    const member = await getServerMember(req.params.id, req.user.username);
    if (!member && req.user.role !== 'supreme') return res.status(403).json({ error: 'Forbidden.' });
    if (member?.display_role !== 'owner' && req.user.role !== 'supreme') return res.status(403).json({ error: 'Only owner can delete server.' });
    await db.execute({ sql: 'DELETE FROM servers WHERE id = ?', args: [req.params.id] });
    await db.execute({ sql: 'DELETE FROM server_members WHERE server_id = ?', args: [req.params.id] });
    await db.execute({ sql: 'DELETE FROM server_channels WHERE server_id = ?', args: [req.params.id] });
    await db.execute({ sql: 'DELETE FROM server_categories WHERE server_id = ?', args: [req.params.id] });
    await db.execute({ sql: 'UPDATE server_messages SET deleted = 1 WHERE server_id = ?', args: [req.params.id] });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/servers/:id/leave', auth, async (req, res) => {
  try {
    const me = req.user.username;
    const server = await getServer(req.params.id);
    if (!server) return res.status(404).json({ error: 'Not found.' });
    if (server.owner === me) return res.status(400).json({ error: 'Transfer ownership before leaving.' });
    await db.execute({ sql: 'DELETE FROM server_members WHERE server_id = ? AND username = ?', args: [req.params.id, me] });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

// ── Members ─────────────────────────────────────────────────────────────────

app.get('/api/servers/:id/members', auth, async (req, res) => {
  try {
    if (!await getServerMember(req.params.id, req.user.username)) return res.status(403).json({ error: 'Not a member.' });
    const rows = (await db.execute({ sql: 'SELECT username, display_role, nickname, muted, muted_until, joined_at FROM server_members WHERE server_id = ? ORDER BY joined_at ASC', args: [req.params.id] })).rows;
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.patch('/api/servers/:id/members/:username', auth, async (req, res) => {
  try {
    const me = req.user.username;
    const actor = await getServerMember(req.params.id, me);
    if (!actor) return res.status(403).json({ error: 'Not a member.' });
    const target = await getServerMember(req.params.id, req.params.username);
    if (!target) return res.status(404).json({ error: 'Member not found.' });
    if (!canManageServerMember(actor.display_role, target.display_role) && req.user.role !== 'supreme')
      return res.status(403).json({ error: 'Insufficient permissions.' });

    const { action, role, muteUntil, reason } = req.body ?? {};
    switch (action) {
      case 'kick':
        await db.execute({ sql: 'DELETE FROM server_members WHERE server_id = ? AND username = ?', args: [req.params.id, req.params.username] });
        await auditLog(req.params.id, me, 'kick', req.params.username, reason || null);
        break;
      case 'ban':
        await db.execute({ sql: 'DELETE FROM server_members WHERE server_id = ? AND username = ?', args: [req.params.id, req.params.username] });
        await db.execute({ sql: 'INSERT INTO server_bans (server_id,username,reason,banned_by,created_at) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING', args: [req.params.id, req.params.username, reason || null, me, new Date().toISOString()] });
        await auditLog(req.params.id, me, 'ban', req.params.username, reason || null);
        break;
      case 'unban':
        await db.execute({ sql: 'DELETE FROM server_bans WHERE server_id = ? AND username = ?', args: [req.params.id, req.params.username] });
        await auditLog(req.params.id, me, 'unban', req.params.username);
        break;
      case 'mute':
        await db.execute({ sql: 'UPDATE server_members SET muted = 1, muted_until = ? WHERE server_id = ? AND username = ?', args: [muteUntil || null, req.params.id, req.params.username] });
        await auditLog(req.params.id, me, 'mute', req.params.username, muteUntil ? `until ${muteUntil}` : 'permanent');
        break;
      case 'unmute':
        await db.execute({ sql: 'UPDATE server_members SET muted = 0, muted_until = NULL WHERE server_id = ? AND username = ?', args: [req.params.id, req.params.username] });
        await auditLog(req.params.id, me, 'unmute', req.params.username);
        break;
      case 'set_role':
        if (!['member','mod','admin'].includes(role)) return res.status(400).json({ error: 'Invalid role.' });
        if (actor.display_role !== 'owner' && req.user.role !== 'supreme') return res.status(403).json({ error: 'Only owner can set roles.' });
        await db.execute({ sql: 'UPDATE server_members SET display_role = ? WHERE server_id = ? AND username = ?', args: [role, req.params.id, req.params.username] });
        await auditLog(req.params.id, me, 'role_change', req.params.username, `→ ${role}`);
        break;
      default:
        return res.status(400).json({ error: 'Unknown action.' });
    }
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error.' }); }
});

// ── Bans ────────────────────────────────────────────────────────────────────

app.get('/api/servers/:id/bans', auth, async (req, res) => {
  try {
    const actor = await getServerMember(req.params.id, req.user.username);
    if (!actor || SERVER_ROLE_RANK[actor.display_role] < 1) return res.status(403).json({ error: 'Forbidden.' });
    const rows = (await db.execute({ sql: 'SELECT * FROM server_bans WHERE server_id = ? ORDER BY created_at DESC', args: [req.params.id] })).rows;
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

// ── Invites ─────────────────────────────────────────────────────────────────

app.get('/api/servers/:id/invites', auth, async (req, res) => {
  try {
    const actor = await getServerMember(req.params.id, req.user.username);
    if (!actor) return res.status(403).json({ error: 'Not a member.' });
    const rows = (await db.execute({ sql: 'SELECT * FROM server_invites WHERE server_id = ? ORDER BY created_at DESC', args: [req.params.id] })).rows;
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/servers/:id/invites', auth, async (req, res) => {
  try {
    const actor = await getServerMember(req.params.id, req.user.username);
    if (!actor) return res.status(403).json({ error: 'Not a member.' });
    const { maxUses, expiresInHours } = req.body ?? {};
    const code = Math.random().toString(36).slice(2, 9).toUpperCase();
    const expiresAt = expiresInHours ? new Date(Date.now() + expiresInHours * 3600000).toISOString() : null;
    await db.execute({
      sql: 'INSERT INTO server_invites (code,server_id,creator,max_uses,expires_at,created_at) VALUES (?,?,?,?,?,?)',
      args: [code, req.params.id, req.user.username, maxUses || null, expiresAt, new Date().toISOString()],
    });
    res.json({ code });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.delete('/api/servers/:id/invites/:code', auth, async (req, res) => {
  try {
    const actor = await getServerMember(req.params.id, req.user.username);
    if (!actor || SERVER_ROLE_RANK[actor.display_role] < 1) return res.status(403).json({ error: 'Forbidden.' });
    await db.execute({ sql: 'DELETE FROM server_invites WHERE code = ? AND server_id = ?', args: [req.params.code, req.params.id] });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.get('/api/invites/:code', async (req, res) => {
  try {
    const inv = (await db.execute({ sql: 'SELECT * FROM server_invites WHERE code = ?', args: [req.params.code] })).rows[0];
    if (!inv) return res.status(404).json({ error: 'Invalid invite code.' });
    if (inv.expires_at && Date.now() > new Date(inv.expires_at).getTime()) return res.status(410).json({ error: 'Invite has expired.' });
    if (inv.max_uses && inv.uses >= inv.max_uses) return res.status(410).json({ error: 'Invite has reached max uses.' });
    const server = await getServer(inv.server_id);
    res.json({ code: inv.code, server: { id: server?.id, name: server?.name, icon_emoji: server?.icon_emoji, member_count: (await db.execute({ sql: 'SELECT COUNT(*) AS n FROM server_members WHERE server_id = ?', args: [inv.server_id] })).rows[0].n } });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/invites/:code/join', auth, async (req, res) => {
  try {
    const me = req.user.username;
    const inv = (await db.execute({ sql: 'SELECT * FROM server_invites WHERE code = ?', args: [req.params.code] })).rows[0];
    if (!inv) return res.status(404).json({ error: 'Invalid code.' });
    if (inv.expires_at && Date.now() > new Date(inv.expires_at).getTime()) return res.status(410).json({ error: 'Expired.' });
    if (inv.max_uses && inv.uses >= inv.max_uses) return res.status(410).json({ error: 'No uses left.' });
    const banned = (await db.execute({ sql: 'SELECT 1 FROM server_bans WHERE server_id = ? AND username = ?', args: [inv.server_id, me] })).rows[0];
    if (banned) return res.status(403).json({ error: 'You are banned from this server.' });
    await db.execute({
      sql: 'INSERT INTO server_members (server_id,username,display_role,joined_at) VALUES (?,?,?,?) ON CONFLICT DO NOTHING',
      args: [inv.server_id, me, 'member', new Date().toISOString()],
    });
    await db.execute({ sql: 'UPDATE server_invites SET uses = uses + 1 WHERE code = ?', args: [req.params.code] });
    res.json({ serverId: inv.server_id });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

// ── Categories ──────────────────────────────────────────────────────────────

app.post('/api/servers/:id/categories', auth, async (req, res) => {
  try {
    const actor = await getServerMember(req.params.id, req.user.username);
    if (!actor || SERVER_ROLE_RANK[actor.display_role] < 2) return res.status(403).json({ error: 'Admin required.' });
    const { name } = req.body ?? {};
    if (!name?.trim()) return res.status(400).json({ error: 'Name required.' });
    const maxPos = (await db.execute({ sql: 'SELECT COALESCE(MAX(position),0) AS p FROM server_categories WHERE server_id = ?', args: [req.params.id] })).rows[0].p;
    const id = uid();
    await db.execute({ sql: 'INSERT INTO server_categories (id,server_id,name,position) VALUES (?,?,?,?)', args: [id, req.params.id, name.trim().toUpperCase().slice(0, 30), Number(maxPos) + 1] });
    auditLog(req.params.id, req.user.username, 'category_create', name.trim());
    res.json({ id });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.patch('/api/servers/:id/categories/:catId', auth, async (req, res) => {
  try {
    const actor = await getServerMember(req.params.id, req.user.username);
    if (!actor || SERVER_ROLE_RANK[actor.display_role] < 2) return res.status(403).json({ error: 'Admin required.' });
    const { name } = req.body ?? {};
    if (name !== undefined) await db.execute({ sql: 'UPDATE server_categories SET name = ? WHERE id = ? AND server_id = ?', args: [name.trim().toUpperCase().slice(0, 30), req.params.catId, req.params.id] });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.delete('/api/servers/:id/categories/:catId', auth, async (req, res) => {
  try {
    const actor = await getServerMember(req.params.id, req.user.username);
    if (!actor || SERVER_ROLE_RANK[actor.display_role] < 2) return res.status(403).json({ error: 'Admin required.' });
    await db.execute({ sql: 'UPDATE server_channels SET category_id = NULL WHERE category_id = ? AND server_id = ?', args: [req.params.catId, req.params.id] });
    await db.execute({ sql: 'DELETE FROM server_categories WHERE id = ? AND server_id = ?', args: [req.params.catId, req.params.id] });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

// ── Channels ────────────────────────────────────────────────────────────────

app.post('/api/servers/:id/channels', auth, async (req, res) => {
  try {
    const actor = await getServerMember(req.params.id, req.user.username);
    if (!actor || SERVER_ROLE_RANK[actor.display_role] < 2) return res.status(403).json({ error: 'Admin required.' });
    const { name, type, categoryId, topic } = req.body ?? {};
    if (!name?.trim()) return res.status(400).json({ error: 'Name required.' });
    const maxPos = (await db.execute({ sql: 'SELECT COALESCE(MAX(position),0) AS p FROM server_channels WHERE server_id = ?', args: [req.params.id] })).rows[0].p;
    const id = uid();
    await db.execute({
      sql: 'INSERT INTO server_channels (id,server_id,category_id,name,type,topic,position) VALUES (?,?,?,?,?,?,?)',
      args: [id, req.params.id, categoryId || null, name.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 50), type || 'text', topic?.slice(0, 200) || null, Number(maxPos) + 1],
    });
    auditLog(req.params.id, req.user.username, 'channel_create', name.trim());
    res.json({ id });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.patch('/api/servers/:id/channels/:channelId', auth, async (req, res) => {
  try {
    const actor = await getServerMember(req.params.id, req.user.username);
    if (!actor || SERVER_ROLE_RANK[actor.display_role] < 2) return res.status(403).json({ error: 'Admin required.' });
    const { name, topic, slowMode, isLocked, isNsfw, categoryId } = req.body ?? {};
    const ch = (await db.execute({ sql: 'SELECT * FROM server_channels WHERE id = ? AND server_id = ?', args: [req.params.channelId, req.params.id] })).rows[0];
    if (!ch) return res.status(404).json({ error: 'Channel not found.' });
    if (name !== undefined)       await db.execute({ sql: 'UPDATE server_channels SET name = ? WHERE id = ?', args: [name.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 50), ch.id] });
    if (topic !== undefined)      await db.execute({ sql: 'UPDATE server_channels SET topic = ? WHERE id = ?', args: [topic?.slice(0, 200) || null, ch.id] });
    if (slowMode !== undefined)   await db.execute({ sql: 'UPDATE server_channels SET slow_mode = ? WHERE id = ?', args: [Number(slowMode) || 0, ch.id] });
    if (isLocked !== undefined)   await db.execute({ sql: 'UPDATE server_channels SET is_locked = ? WHERE id = ?', args: [isLocked ? 1 : 0, ch.id] });
    if (isNsfw !== undefined)     await db.execute({ sql: 'UPDATE server_channels SET is_nsfw = ? WHERE id = ?', args: [isNsfw ? 1 : 0, ch.id] });
    if (categoryId !== undefined) await db.execute({ sql: 'UPDATE server_channels SET category_id = ? WHERE id = ?', args: [categoryId || null, ch.id] });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.delete('/api/servers/:id/channels/:channelId', auth, async (req, res) => {
  try {
    const actor = await getServerMember(req.params.id, req.user.username);
    if (!actor || SERVER_ROLE_RANK[actor.display_role] < 2) return res.status(403).json({ error: 'Admin required.' });
    await db.execute({ sql: 'DELETE FROM server_channels WHERE id = ? AND server_id = ?', args: [req.params.channelId, req.params.id] });
    await db.execute({ sql: 'UPDATE server_messages SET deleted = 1 WHERE channel_id = ?', args: [req.params.channelId] });
    auditLog(req.params.id, req.user.username, 'channel_delete', req.params.channelId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

// ── Channel Messages ─────────────────────────────────────────────────────────

app.get('/api/channels/:channelId/messages', auth, async (req, res) => {
  try {
    const ch = (await db.execute({ sql: 'SELECT * FROM server_channels WHERE id = ?', args: [req.params.channelId] })).rows[0];
    if (!ch) return res.status(404).json({ error: 'Channel not found.' });
    const member = await getServerMember(ch.server_id, req.user.username);
    if (!member) return res.status(403).json({ error: 'Not a member.' });

    const before = req.query.before || null;
    let sql, args;
    if (before) {
      sql = `SELECT m.*, u.role AS author_role,
               STRING_AGG(CASE WHEN r.emoji='like' THEN r.username ELSE NULL END, ',') AS likes,
               STRING_AGG(CASE WHEN r.emoji='dislike' THEN r.username ELSE NULL END, ',') AS dislikes
             FROM server_messages m LEFT JOIN users u ON u.username = m.author
             LEFT JOIN server_reactions r ON r.message_id = m.id
             WHERE m.channel_id = ? AND m.deleted = 0 AND m.timestamp < ?
             GROUP BY m.id ORDER BY m.timestamp DESC LIMIT 100`;
      args = [req.params.channelId, before];
    } else {
      sql = `SELECT m.*, u.role AS author_role,
               STRING_AGG(CASE WHEN r.emoji='like' THEN r.username ELSE NULL END, ',') AS likes,
               STRING_AGG(CASE WHEN r.emoji='dislike' THEN r.username ELSE NULL END, ',') AS dislikes
             FROM server_messages m LEFT JOIN users u ON u.username = m.author
             LEFT JOIN server_reactions r ON r.message_id = m.id
             WHERE m.channel_id = ? AND m.deleted = 0
             GROUP BY m.id ORDER BY m.timestamp DESC LIMIT 100`;
      args = [req.params.channelId];
    }

    const rows = (await db.execute({ sql, args })).rows;
    const vr = req.user.role;
    res.json(rows.reverse().map(m => ({
      id: m.id, channelId: m.channel_id, serverId: m.server_id,
      author: m.author, content: m.content, type: m.type,
      mediaUrl: m.media_url, linkUrl: m.link_url, replyTo: m.reply_to,
      pinned: !!m.pinned, editedAt: m.edited_at, timestamp: m.timestamp,
      authorRole: safeRole(m.author_role, vr),
      reactions: {
        like:    m.likes    ? m.likes.split(',').filter(Boolean)    : [],
        dislike: m.dislikes ? m.dislikes.split(',').filter(Boolean) : [],
      },
    })));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/channels/:channelId/messages', auth, async (req, res) => {
  try {
    const ch = (await db.execute({ sql: 'SELECT * FROM server_channels WHERE id = ?', args: [req.params.channelId] })).rows[0];
    if (!ch) return res.status(404).json({ error: 'Channel not found.' });
    const member = await getServerMember(ch.server_id, req.user.username);
    if (!member) return res.status(403).json({ error: 'Not a member.' });

    if (ch.is_locked && SERVER_ROLE_RANK[member.display_role] < 1) return res.status(403).json({ error: 'Channel is locked.' });
    if (member.muted && (!member.muted_until || Date.now() < new Date(member.muted_until).getTime()))
      return res.status(403).json({ error: 'You are muted in this server.' });

    const s = await getSettings();
    const maxLen = s.max_msg_length ? parseInt(s.max_msg_length) : 2000;

    const { content, type, mediaUrl, linkUrl, replyTo } = req.body ?? {};
    if (!content) return res.status(400).json({ error: 'Content required.' });
    if (content.length > maxLen) return res.status(400).json({ error: `Message too long (max ${maxLen}).` });

    const id = uid();
    await db.execute({
      sql: 'INSERT INTO server_messages (id,channel_id,server_id,author,content,type,media_url,link_url,reply_to,timestamp) VALUES (?,?,?,?,?,?,?,?,?,?)',
      args: [id, req.params.channelId, ch.server_id, req.user.username, content, type || 'text', mediaUrl || null, linkUrl || null, replyTo || null, new Date().toISOString()],
    });
    moderateContent(id, content, req.user.username, 'server', ch.server_id, req.params.channelId).catch(() => {});
    res.json({ id });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error.' }); }
});

app.delete('/api/channels/:channelId/messages/:msgId', auth, async (req, res) => {
  try {
    const msg = (await db.execute({ sql: 'SELECT * FROM server_messages WHERE id = ? AND channel_id = ?', args: [req.params.msgId, req.params.channelId] })).rows[0];
    if (!msg) return res.status(404).json({ error: 'Not found.' });
    const ch = (await db.execute({ sql: 'SELECT * FROM server_channels WHERE id = ?', args: [req.params.channelId] })).rows[0];
    const member = await getServerMember(ch?.server_id, req.user.username);
    const isOwn = msg.author === req.user.username;
    const isMod = member && SERVER_ROLE_RANK[member.display_role] >= 1;
    const isGlobalMod = ['admin','owner','supreme'].includes(req.user.role);
    if (!isOwn && !isMod && !isGlobalMod) return res.status(403).json({ error: 'Forbidden.' });
    await db.execute({ sql: 'UPDATE server_messages SET deleted = 1 WHERE id = ?', args: [req.params.msgId] });
    if (!isOwn && ch) auditLog(ch.server_id, req.user.username, 'message_delete', msg.author, msg.content.slice(0, 100));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/channels/:channelId/messages/:msgId/pin', auth, async (req, res) => {
  try {
    const msg = (await db.execute({ sql: 'SELECT * FROM server_messages WHERE id = ?', args: [req.params.msgId] })).rows[0];
    if (!msg) return res.status(404).json({ error: 'Not found.' });
    const ch = (await db.execute({ sql: 'SELECT * FROM server_channels WHERE id = ?', args: [req.params.channelId] })).rows[0];
    const member = await getServerMember(ch?.server_id, req.user.username);
    if (!member || SERVER_ROLE_RANK[member.display_role] < 1) return res.status(403).json({ error: 'Forbidden.' });
    const next = msg.pinned ? 0 : 1;
    await db.execute({ sql: 'UPDATE server_messages SET pinned = ? WHERE id = ?', args: [next, req.params.msgId] });
    res.json({ pinned: !!next });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/channels/:channelId/messages/:msgId/react', auth, async (req, res) => {
  try {
    const { emoji } = req.body ?? {};
    if (!emoji) return res.status(400).json({ error: 'emoji required.' });
    const { username } = req.user;
    const msgId = req.params.msgId;
    const existing = (await db.execute({ sql: 'SELECT emoji FROM server_reactions WHERE message_id = ? AND username = ?', args: [msgId, username] })).rows[0];
    if (existing) {
      if (existing.emoji === emoji) {
        await db.execute({ sql: 'DELETE FROM server_reactions WHERE message_id = ? AND username = ?', args: [msgId, username] });
      } else {
        await db.execute({ sql: 'UPDATE server_reactions SET emoji = ? WHERE message_id = ? AND username = ?', args: [emoji, msgId, username] });
      }
    } else {
      await db.execute({ sql: 'INSERT INTO server_reactions (message_id,username,emoji) VALUES (?,?,?)', args: [msgId, username, emoji] });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

// ─── Pinned Messages ──────────────────────────────────────────────────────────

app.get('/api/channels/:channelId/pins', auth, async (req, res) => {
  try {
    const ch = (await db.execute({ sql: 'SELECT * FROM server_channels WHERE id = ?', args: [req.params.channelId] })).rows[0];
    if (!ch) return res.status(404).json({ error: 'Not found.' });
    if (!await getServerMember(ch.server_id, req.user.username)) return res.status(403).json({ error: 'Not a member.' });
    const rows = (await db.execute({ sql: 'SELECT * FROM server_messages WHERE channel_id = ? AND pinned = 1 AND deleted = 0 ORDER BY timestamp DESC', args: [req.params.channelId] })).rows;
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

// ════════════════════════════════════════════════════════════ POLLS ══════════

app.post('/api/channels/:channelId/polls', auth, async (req, res) => {
  try {
    const ch = (await db.execute({ sql: 'SELECT * FROM server_channels WHERE id = ?', args: [req.params.channelId] })).rows[0];
    if (!ch) return res.status(404).json({ error: 'Channel not found.' });
    const member = await getServerMember(ch.server_id, req.user.username);
    if (!member) return res.status(403).json({ error: 'Not a member.' });

    const { question, options, multipleChoice, anonymous, endsInMinutes } = req.body ?? {};
    if (!question?.trim()) return res.status(400).json({ error: 'Question required.' });
    if (!Array.isArray(options) || options.length < 2) return res.status(400).json({ error: 'At least 2 options required.' });
    if (options.length > 10) return res.status(400).json({ error: 'Max 10 options.' });

    const now = new Date().toISOString();
    const endsAt = endsInMinutes ? new Date(Date.now() + Number(endsInMinutes) * 60000).toISOString() : null;

    const msgId = uid();
    await db.execute({
      sql: 'INSERT INTO server_messages (id,channel_id,server_id,author,content,type,timestamp) VALUES (?,?,?,?,?,?,?)',
      args: [msgId, req.params.channelId, ch.server_id, req.user.username, question.trim(), 'poll', now],
    });

    const pollId = uid();
    await db.execute({
      sql: 'INSERT INTO polls (id,channel_id,server_id,message_id,author,question,options,multiple_choice,anonymous,ends_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      args: [pollId, req.params.channelId, ch.server_id, msgId, req.user.username, question.trim(), JSON.stringify(options.map(o => String(o).slice(0, 100))), multipleChoice ? 1 : 0, anonymous ? 1 : 0, endsAt, now],
    });

    res.json({ id: pollId, messageId: msgId });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error.' }); }
});

app.get('/api/polls/:pollId', auth, async (req, res) => {
  try {
    const poll = (await db.execute({ sql: 'SELECT * FROM polls WHERE id = ?', args: [req.params.pollId] })).rows[0];
    if (!poll) return res.status(404).json({ error: 'Not found.' });
    const member = await getServerMember(poll.server_id, req.user.username);
    if (!member) return res.status(403).json({ error: 'Not a member.' });

    const votes = (await db.execute({ sql: 'SELECT option_index, username FROM poll_votes WHERE poll_id = ?', args: [req.params.pollId] })).rows;
    const options = JSON.parse(poll.options);
    const counts = options.map((_, i) => votes.filter(v => v.option_index === i).length);
    const myVotes = votes.filter(v => v.username === req.user.username).map(v => v.option_index);
    const totalVotes = votes.length;
    const voters = poll.anonymous ? null : votes.reduce((acc, v) => { (acc[v.option_index] = acc[v.option_index] || []).push(v.username); return acc; }, {});

    res.json({
      id: poll.id, messageId: poll.message_id, author: poll.author,
      question: poll.question, options, multipleChoice: !!poll.multiple_choice,
      anonymous: !!poll.anonymous, endsAt: poll.ends_at, createdAt: poll.created_at,
      ended: poll.ends_at ? Date.now() > new Date(poll.ends_at).getTime() : false,
      counts, totalVotes, myVotes, voters,
    });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/polls/:pollId/vote', auth, async (req, res) => {
  try {
    const { optionIndex } = req.body ?? {};
    if (optionIndex === undefined) return res.status(400).json({ error: 'optionIndex required.' });
    const poll = (await db.execute({ sql: 'SELECT * FROM polls WHERE id = ?', args: [req.params.pollId] })).rows[0];
    if (!poll) return res.status(404).json({ error: 'Poll not found.' });
    if (poll.ends_at && Date.now() > new Date(poll.ends_at).getTime()) return res.status(400).json({ error: 'Poll has ended.' });
    const options = JSON.parse(poll.options);
    if (optionIndex < 0 || optionIndex >= options.length) return res.status(400).json({ error: 'Invalid option.' });

    if (!poll.multiple_choice) {
      await db.execute({ sql: 'DELETE FROM poll_votes WHERE poll_id = ? AND username = ?', args: [req.params.pollId, req.user.username] });
    }
    await db.execute({
      sql: 'INSERT INTO poll_votes (poll_id,username,option_index) VALUES (?,?,?) ON CONFLICT DO NOTHING',
      args: [req.params.pollId, req.user.username, optionIndex],
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.delete('/api/polls/:pollId/vote', auth, async (req, res) => {
  try {
    const { optionIndex } = req.body ?? {};
    const poll = (await db.execute({ sql: 'SELECT * FROM polls WHERE id = ?', args: [req.params.pollId] })).rows[0];
    if (!poll) return res.status(404).json({ error: 'Poll not found.' });
    if (poll.ends_at && Date.now() > new Date(poll.ends_at).getTime()) return res.status(400).json({ error: 'Poll has ended.' });
    if (optionIndex !== undefined) {
      await db.execute({ sql: 'DELETE FROM poll_votes WHERE poll_id = ? AND username = ? AND option_index = ?', args: [req.params.pollId, req.user.username, optionIndex] });
    } else {
      await db.execute({ sql: 'DELETE FROM poll_votes WHERE poll_id = ? AND username = ?', args: [req.params.pollId, req.user.username] });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.delete('/api/polls/:pollId', auth, async (req, res) => {
  try {
    const poll = (await db.execute({ sql: 'SELECT * FROM polls WHERE id = ?', args: [req.params.pollId] })).rows[0];
    if (!poll) return res.status(404).json({ error: 'Not found.' });
    const member = await getServerMember(poll.server_id, req.user.username);
    const isAuthor = poll.author === req.user.username;
    const isMod = member && SERVER_ROLE_RANK[member.display_role] >= 1;
    if (!isAuthor && !isMod) return res.status(403).json({ error: 'Forbidden.' });
    await db.execute({ sql: 'DELETE FROM poll_votes WHERE poll_id = ?', args: [req.params.pollId] });
    await db.execute({ sql: 'DELETE FROM polls WHERE id = ?', args: [req.params.pollId] });
    await db.execute({ sql: 'UPDATE server_messages SET deleted = 1 WHERE id = ?', args: [poll.message_id] });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

// ════════════════════════════════════════════════════ SERVER ADMIN ══════════

app.get('/api/servers/:id/admin/audit-log', auth, async (req, res) => {
  try {
    const actor = await getServerMember(req.params.id, req.user.username);
    if (!actor || SERVER_ROLE_RANK[actor.display_role] < 1) return res.status(403).json({ error: 'Forbidden.' });
    const rows = (await db.execute({ sql: 'SELECT * FROM server_audit_log WHERE server_id = ? ORDER BY created_at DESC LIMIT 100', args: [req.params.id] })).rows;
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/servers/:id/admin/broadcast', auth, async (req, res) => {
  try {
    const actor = await getServerMember(req.params.id, req.user.username);
    if (!actor || SERVER_ROLE_RANK[actor.display_role] < 2) return res.status(403).json({ error: 'Admin required.' });
    const { text, channelId } = req.body ?? {};
    if (!text) return res.status(400).json({ error: 'Text required.' });
    const targetChannel = channelId || (await db.execute({ sql: 'SELECT id FROM server_channels WHERE server_id = ? AND type = ? ORDER BY position ASC LIMIT 1', args: [req.params.id, 'text'] })).rows[0]?.id;
    if (!targetChannel) return res.status(400).json({ error: 'No text channel found.' });
    const id = uid();
    await db.execute({ sql: 'INSERT INTO server_messages (id,channel_id,server_id,author,content,type,timestamp) VALUES (?,?,?,?,?,?,?)', args: [id, targetChannel, req.params.id, '[SYSTEM]', text, 'system', new Date().toISOString()] });
    res.json({ id });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

// ════════════════════════════════════════════════ GLOBAL ADMIN ══════════

app.get('/api/admin/servers', auth, async (req, res) => {
  if (req.user.role !== 'supreme') return res.status(403).json({ error: 'Forbidden.' });
  try {
    const rows = (await db.execute({
      sql: `SELECT s.*, (SELECT COUNT(*) FROM server_members sm WHERE sm.server_id = s.id) AS member_count,
                  (SELECT COUNT(*) FROM server_messages sm WHERE sm.server_id = s.id AND sm.deleted = 0) AS message_count
            FROM servers s ORDER BY created_at DESC`,
      args: [],
    })).rows;
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.delete('/api/admin/servers/:id', auth, async (req, res) => {
  if (req.user.role !== 'supreme') return res.status(403).json({ error: 'Forbidden.' });
  try {
    for (const tbl of ['server_members','server_channels','server_categories','server_invites','server_bans','server_audit_log'])
      await db.execute({ sql: `DELETE FROM ${tbl} WHERE server_id = ?`, args: [req.params.id] });
    await db.execute({ sql: 'UPDATE server_messages SET deleted = 1 WHERE server_id = ?', args: [req.params.id] });
    await db.execute({ sql: 'DELETE FROM servers WHERE id = ?', args: [req.params.id] });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.get('/api/admin/platform-stats', auth, async (req, res) => {
  if (req.user.role !== 'supreme') return res.status(403).json({ error: 'Forbidden.' });
  try {
    const [users, servers, messages, banned, reports, flags, topUsers, recentSignups] = await Promise.all([
      db.execute({ sql: 'SELECT COUNT(*) AS n FROM users', args: [] }),
      db.execute({ sql: 'SELECT COUNT(*) AS n FROM servers', args: [] }),
      db.execute({ sql: 'SELECT COUNT(*) AS n FROM server_messages WHERE deleted = 0', args: [] }),
      db.execute({ sql: 'SELECT COUNT(*) AS n FROM users WHERE banned = 1', args: [] }),
      db.execute({ sql: "SELECT COUNT(*) AS n FROM reports WHERE status = 'pending'", args: [] }),
      db.execute({ sql: 'SELECT COUNT(*) AS n FROM ai_flags', args: [] }),
      db.execute({ sql: 'SELECT author, COUNT(*) AS n FROM server_messages WHERE deleted = 0 GROUP BY author ORDER BY n DESC LIMIT 5', args: [] }),
      db.execute({ sql: 'SELECT username, created_at FROM users ORDER BY created_at DESC LIMIT 10', args: [] }),
    ]);
    res.json({
      totalUsers: Number(users.rows[0].n),
      totalServers: Number(servers.rows[0].n),
      totalMessages: Number(messages.rows[0].n),
      bannedUsers: Number(banned.rows[0].n),
      pendingReports: Number(reports.rows[0].n),
      aiFlags: Number(flags.rows[0].n),
      topPosters: topUsers.rows.map(r => ({ username: r.author, count: Number(r.n) })),
      recentSignups: recentSignups.rows,
    });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.get('/api/admin/users', auth, requireAdminOrAbove, async (req, res) => {
  try {
    const vr = req.user.role;
    const rows = (await db.execute({ sql: 'SELECT username, role, banned, banned_until, created_at, muted, muted_until, notes FROM users ORDER BY username' })).rows;
    res.json(rows.map(u => ({
      username: u.username, role: u.role, displayRole: safeRole(u.role, vr),
      banned: !!u.banned, bannedUntil: u.banned_until, createdAt: u.created_at,
      muted: !!u.muted, mutedUntil: u.muted_until, notes: u.notes || '',
    })));
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.get('/api/users', auth, async (req, res) => {
  try {
    const vr = req.user.role;
    const rows = (await db.execute('SELECT username, role, banned, banned_until FROM users ORDER BY username')).rows;
    res.json(rows.map(u => ({ username: u.username, role: safeRole(u.role, vr), banned: !!u.banned, bannedUntil: u.banned_until })));
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.get('/api/users/:username', auth, async (req, res) => {
  try {
    const target = await getUser(req.params.username);
    if (!target) return res.status(404).json({ error: 'User not found.' });
    const vr = req.user.role, tr = target.role;
    let canView = false;
    if (req.user.username === target.username) canView = false;
    else if (vr === 'supreme') canView = true;
    else if (vr === 'owner' && (tr === 'user' || tr === 'admin')) canView = true;
    else if (vr === 'admin' && tr === 'user') canView = true;
    if (!canView) return res.status(403).json({ error: 'Forbidden.' });
    const msgCount = (await db.execute({ sql: 'SELECT COUNT(*) AS n FROM server_messages WHERE author = ? AND deleted = 0', args: [target.username] })).rows[0].n;
    res.json({ username: target.username, role: safeRole(tr, vr), banned: !!target.banned, bannedUntil: target.banned_until, createdAt: target.created_at, messageCount: Number(msgCount) });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.patch('/api/admin/users/:username', auth, requireOwnerOrAbove, async (req, res) => {
  try {
    const { action, bannedUntil, muteUntil, note, role } = req.body ?? {};
    const cu = req.user;
    const target = await getUser(req.params.username);
    if (!target) return res.status(404).json({ error: 'User not found.' });
    if (!canManage(cu.role, target.role)) return res.status(403).json({ error: 'Forbidden.' });

    switch (action) {
      case 'ban':
        await db.execute({ sql: 'UPDATE users SET banned = 1, banned_until = ? WHERE username = ?', args: [bannedUntil || null, target.username] }); break;
      case 'unban':
        await db.execute({ sql: 'UPDATE users SET banned = 0, banned_until = NULL WHERE username = ?', args: [target.username] }); break;
      case 'grant_admin':
        await db.execute({ sql: 'UPDATE users SET role = ? WHERE username = ?', args: ['admin', target.username] }); break;
      case 'revoke_admin':
        await db.execute({ sql: 'UPDATE users SET role = ? WHERE username = ?', args: ['user', target.username] }); break;
      case 'promote_owner':
        if (cu.role !== 'supreme') return res.status(403).json({ error: 'Forbidden.' });
        await db.execute({ sql: 'UPDATE users SET role = ? WHERE username = ?', args: ['owner', target.username] }); break;
      case 'demote_owner':
        if (cu.role !== 'supreme') return res.status(403).json({ error: 'Forbidden.' });
        await db.execute({ sql: 'UPDATE users SET role = ? WHERE username = ?', args: [role || 'user', target.username] }); break;
      case 'mute':
        if (cu.role !== 'supreme') return res.status(403).json({ error: 'Forbidden.' });
        await db.execute({ sql: 'UPDATE users SET muted = 1, muted_until = ? WHERE username = ?', args: [muteUntil || null, target.username] }); break;
      case 'unmute':
        if (cu.role !== 'supreme') return res.status(403).json({ error: 'Forbidden.' });
        await db.execute({ sql: 'UPDATE users SET muted = 0, muted_until = NULL WHERE username = ?', args: [target.username] }); break;
      case 'add_note':
        if (cu.role !== 'supreme') return res.status(403).json({ error: 'Forbidden.' });
        await db.execute({ sql: 'UPDATE users SET notes = ? WHERE username = ?', args: [note ?? '', target.username] }); break;
      case 'clear_note':
        if (cu.role !== 'supreme') return res.status(403).json({ error: 'Forbidden.' });
        await db.execute({ sql: 'UPDATE users SET notes = NULL WHERE username = ?', args: [target.username] }); break;
      case 'clear_messages':
        if (cu.role !== 'supreme') return res.status(403).json({ error: 'Forbidden.' });
        await db.execute({ sql: 'UPDATE server_messages SET deleted = 1 WHERE author = ?', args: [target.username] }); break;
      default:
        return res.status(400).json({ error: 'Unknown action.' });
    }
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error.' }); }
});

app.delete('/api/admin/users/:username', auth, requireOwnerOrAbove, async (req, res) => {
  try {
    const cu = req.user, target = await getUser(req.params.username);
    if (!target) return res.status(404).json({ error: 'User not found.' });
    if (!canManage(cu.role, target.role)) return res.status(403).json({ error: 'Forbidden.' });
    await db.execute({ sql: 'DELETE FROM users WHERE username = ?', args: [target.username] });
    await db.execute({ sql: 'UPDATE server_messages SET deleted = 1 WHERE author = ?', args: [target.username] });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.get('/api/admin/users/:username/messages', auth, async (req, res) => {
  if (req.user.role !== 'supreme') return res.status(403).json({ error: 'Forbidden.' });
  try {
    const rows = (await db.execute({ sql: 'SELECT id, channel_id, server_id, content, type, timestamp, deleted FROM server_messages WHERE author = ? ORDER BY timestamp DESC LIMIT 50', args: [req.params.username] })).rows;
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.get('/api/admin/ai-flags', auth, requireAdminOrAbove, async (req, res) => {
  try {
    const rows = (await db.execute({ sql: 'SELECT * FROM ai_flags ORDER BY created_at DESC LIMIT 100', args: [] })).rows;
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.delete('/api/admin/ai-flags/:id', auth, requireAdminOrAbove, async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM ai_flags WHERE id = ?', args: [req.params.id] });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.get('/api/reports', auth, requireAdminOrAbove, async (req, res) => {
  try {
    const sql = req.user.role === 'supreme'
      ? 'SELECT * FROM reports ORDER BY timestamp DESC'
      : "SELECT * FROM reports WHERE status = 'pending' ORDER BY timestamp DESC";
    res.json((await db.execute(sql)).rows);
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.patch('/api/reports/:id', auth, requireAdminOrAbove, async (req, res) => {
  try {
    const { action } = req.body ?? {};
    const report = (await db.execute({ sql: 'SELECT * FROM reports WHERE id = ?', args: [req.params.id] })).rows[0];
    if (!report) return res.status(404).json({ error: 'Not found.' });
    if (action === 'dismiss') {
      await db.execute({ sql: "UPDATE reports SET status = 'dismissed' WHERE id = ?", args: [req.params.id] });
    } else if (action === 'delete_msg') {
      if (report.msg_id) await db.execute({ sql: 'UPDATE server_messages SET deleted = 1 WHERE id = ?', args: [report.msg_id] });
      await db.execute({ sql: "UPDATE reports SET status = 'dismissed' WHERE id = ?", args: [req.params.id] });
    } else {
      return res.status(400).json({ error: 'Unknown action.' });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/reports', auth, async (req, res) => {
  try {
    const { msgId, reason, channelId, serverId } = req.body ?? {};
    if (!msgId || !reason) return res.status(400).json({ error: 'msgId and reason required.' });
    const priority = ['admin','owner','supreme'].includes(req.user.role) ? 1 : 0;
    await db.execute({
      sql: 'INSERT INTO reports (id,msg_id,channel_id,server_id,reporter,reason,timestamp,status,priority) VALUES (?,?,?,?,?,?,?,?,?)',
      args: [uid(), msgId, channelId || null, serverId || null, req.user.username, reason, new Date().toISOString(), 'pending', priority],
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.get('/api/admin/settings', auth, async (req, res) => {
  if (req.user.role !== 'supreme') return res.status(403).json({ error: 'Forbidden.' });
  try { res.json(await getSettings()); } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

const ALLOWED_SETTINGS = ['maintenance_mode','max_msg_length','word_filter','motd'];
app.patch('/api/admin/settings', auth, async (req, res) => {
  if (req.user.role !== 'supreme') return res.status(403).json({ error: 'Forbidden.' });
  try {
    const { key, value } = req.body ?? {};
    if (!key || !ALLOWED_SETTINGS.includes(key)) return res.status(400).json({ error: 'Invalid key.' });
    await db.execute({ sql: `INSERT INTO settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`, args: [key, String(value ?? ''), new Date().toISOString()] });
    invalidateSettings();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.get('/api/admin/deleted', auth, async (req, res) => {
  if (req.user.role !== 'supreme') return res.status(403).json({ error: 'Forbidden.' });
  try {
    const rows = (await db.execute({ sql: 'SELECT id, channel_id, server_id, author, content, type, timestamp FROM server_messages WHERE deleted = 1 ORDER BY timestamp DESC LIMIT 100', args: [] })).rows;
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/admin/mass-unban', auth, async (req, res) => {
  if (req.user.role !== 'supreme') return res.status(403).json({ error: 'Forbidden.' });
  try { await db.execute({ sql: 'UPDATE users SET banned = 0, banned_until = NULL WHERE banned = 1', args: [] }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.get('/api/motd', async (req, res) => {
  try { const s = await getSettings(); res.json({ motd: s.motd || '' }); }
  catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

// ════════════════════════════════════════════════ FRIENDS & DMs ══════════

app.get('/api/friends', auth, async (req, res) => {
  try {
    const me = req.user.username;
    const rows = (await db.execute({
      sql: `SELECT f.*, CASE WHEN f.requester = ? THEN f.recipient ELSE f.requester END AS other_user
            FROM friends f WHERE (f.requester = ? OR f.recipient = ?) AND f.status != 'blocked' ORDER BY f.created_at DESC`,
      args: [me, me, me],
    })).rows;
    const friends  = rows.filter(r => r.status === 'accepted').map(r => r.other_user);
    const incoming = rows.filter(r => r.status === 'pending' && r.recipient === me).map(r => ({ id: r.id, username: r.requester, createdAt: r.created_at }));
    const outgoing = rows.filter(r => r.status === 'pending' && r.requester === me).map(r => ({ id: r.id, username: r.recipient, createdAt: r.created_at }));
    res.json({ friends, incoming, outgoing });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/friends/request', auth, async (req, res) => {
  try {
    const { username } = req.body ?? {};
    if (!username) return res.status(400).json({ error: 'Username required.' });
    if (username === req.user.username) return res.status(400).json({ error: 'Cannot friend yourself.' });
    const target = await getUser(username);
    if (!target) return res.status(404).json({ error: 'User not found.' });
    const existing = (await db.execute({ sql: 'SELECT * FROM friends WHERE (requester = ? AND recipient = ?) OR (requester = ? AND recipient = ?)', args: [req.user.username, username, username, req.user.username] })).rows[0];
    if (existing) {
      if (existing.status === 'accepted') return res.status(400).json({ error: 'Already friends.' });
      if (existing.status === 'pending')  return res.status(400).json({ error: 'Request pending.' });
      if (existing.status === 'blocked')  return res.status(400).json({ error: 'Cannot send request.' });
    }
    await db.execute({ sql: 'INSERT INTO friends (id,requester,recipient,status,created_at) VALUES (?,?,?,?,?)', args: [uid(), req.user.username, username, 'pending', new Date().toISOString()] });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.patch('/api/friends/:username', auth, async (req, res) => {
  try {
    const { action } = req.body ?? {};
    const me = req.user.username, other = req.params.username;
    const row = (await db.execute({ sql: 'SELECT * FROM friends WHERE (requester = ? AND recipient = ?) OR (requester = ? AND recipient = ?)', args: [me, other, other, me] })).rows[0];
    if (!row) return res.status(404).json({ error: 'No relationship found.' });
    if (action === 'accept') {
      if (row.recipient !== me) return res.status(403).json({ error: 'Forbidden.' });
      await db.execute({ sql: "UPDATE friends SET status = 'accepted' WHERE id = ?", args: [row.id] });
    } else if (action === 'reject' || action === 'remove') {
      await db.execute({ sql: 'DELETE FROM friends WHERE id = ?', args: [row.id] });
    } else if (action === 'block') {
      await db.execute({ sql: "UPDATE friends SET status = 'blocked', requester = ?, recipient = ? WHERE id = ?", args: [me, other, row.id] });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.delete('/api/friends/:username', auth, async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM friends WHERE (requester = ? AND recipient = ?) OR (requester = ? AND recipient = ?)', args: [req.user.username, req.params.username, req.params.username, req.user.username] });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.get('/api/conversations', auth, async (req, res) => {
  try {
    const me = req.user.username;
    const rows = (await db.execute({
      sql: `SELECT c.*, cm.last_read_at,
              (SELECT COUNT(*) FROM conv_messages m WHERE m.conv_id = c.id AND m.deleted = 0 AND (cm.last_read_at IS NULL OR m.timestamp > cm.last_read_at)) AS unread,
              (SELECT m2.content FROM conv_messages m2 WHERE m2.conv_id = c.id AND m2.deleted = 0 ORDER BY m2.timestamp DESC LIMIT 1) AS last_msg,
              (SELECT m2.timestamp FROM conv_messages m2 WHERE m2.conv_id = c.id AND m2.deleted = 0 ORDER BY m2.timestamp DESC LIMIT 1) AS last_msg_at
            FROM conversations c JOIN conv_members cm ON cm.conv_id = c.id AND cm.username = ?
            ORDER BY last_msg_at DESC NULLS LAST`,
      args: [me],
    })).rows;
    const result = await Promise.all(rows.map(async c => {
      const members = (await db.execute({ sql: 'SELECT username, role FROM conv_members WHERE conv_id = ?', args: [c.id] })).rows;
      const name = c.type === 'dm' ? members.find(m => m.username !== me)?.username || 'Unknown' : c.name;
      return { id: c.id, type: c.type, name, members: members.map(m => m.username), unread: Number(c.unread) || 0, lastMsg: c.last_msg ? c.last_msg.slice(0, 60) : null, lastMsgAt: c.last_msg_at };
    }));
    res.json({ conversations: result });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/conversations', auth, async (req, res) => {
  try {
    const { type, username, name, members } = req.body ?? {};
    const me = req.user.username;
    if (type === 'dm') {
      if (!username) return res.status(400).json({ error: 'username required.' });
      if (username === me) return res.status(400).json({ error: 'Cannot DM yourself.' });
      const existing = (await db.execute({ sql: `SELECT c.id FROM conversations c JOIN conv_members cm1 ON cm1.conv_id = c.id AND cm1.username = ? JOIN conv_members cm2 ON cm2.conv_id = c.id AND cm2.username = ? WHERE c.type = 'dm'`, args: [me, username] })).rows[0];
      if (existing) return res.json({ id: existing.id, existing: true });
      const id = uid(), now = new Date().toISOString();
      await db.execute({ sql: 'INSERT INTO conversations (id,type,created_by,created_at) VALUES (?,?,?,?)', args: [id, 'dm', me, now] });
      await db.execute({ sql: 'INSERT INTO conv_members (conv_id,username,role,joined_at) VALUES (?,?,?,?)', args: [id, me, 'owner', now] });
      await db.execute({ sql: 'INSERT INTO conv_members (conv_id,username,role,joined_at) VALUES (?,?,?,?)', args: [id, username, 'member', now] });
      return res.json({ id });
    }
    if (type === 'group') {
      if (!name?.trim()) return res.status(400).json({ error: 'Group name required.' });
      const allMembers = [...new Set([me, ...(members || [])])].slice(0, 20);
      const id = uid(), now = new Date().toISOString();
      await db.execute({ sql: 'INSERT INTO conversations (id,type,name,created_by,created_at) VALUES (?,?,?,?,?)', args: [id, 'group', name.trim(), me, now] });
      for (const u of allMembers) {
        await db.execute({ sql: 'INSERT INTO conv_members (conv_id,username,role,joined_at) VALUES (?,?,?,?)', args: [id, u, u === me ? 'owner' : 'member', now] });
      }
      return res.json({ id });
    }
    res.status(400).json({ error: 'type must be dm or group.' });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error.' }); }
});

app.get('/api/conversations/:id/messages', auth, async (req, res) => {
  try {
    const me = req.user.username;
    const member = (await db.execute({ sql: 'SELECT 1 FROM conv_members WHERE conv_id = ? AND username = ?', args: [req.params.id, me] })).rows[0];
    if (!member) return res.status(403).json({ error: 'Not a member.' });
    const rows = (await db.execute({ sql: 'SELECT * FROM conv_messages WHERE conv_id = ? AND deleted = 0 ORDER BY timestamp ASC LIMIT 200', args: [req.params.id] })).rows;
    await db.execute({ sql: 'UPDATE conv_members SET last_read_at = ? WHERE conv_id = ? AND username = ?', args: [new Date().toISOString(), req.params.id, me] });
    res.json(rows.map(m => ({ id: m.id, author: m.author, content: m.content, type: m.type, mediaUrl: m.media_url, replyTo: m.reply_to, timestamp: m.timestamp })));
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/conversations/:id/messages', auth, async (req, res) => {
  try {
    const me = req.user.username;
    const member = (await db.execute({ sql: 'SELECT 1 FROM conv_members WHERE conv_id = ? AND username = ?', args: [req.params.id, me] })).rows[0];
    if (!member) return res.status(403).json({ error: 'Not a member.' });
    const { content, type, mediaUrl, replyTo } = req.body ?? {};
    if (!content) return res.status(400).json({ error: 'Content required.' });
    const s = await getSettings();
    const maxLen = s.max_msg_length ? parseInt(s.max_msg_length) : 2000;
    if (content.length > maxLen) return res.status(400).json({ error: `Too long (max ${maxLen}).` });
    const id = uid();
    await db.execute({ sql: 'INSERT INTO conv_messages (id,conv_id,author,content,type,media_url,reply_to,timestamp) VALUES (?,?,?,?,?,?,?,?)', args: [id, req.params.id, me, content, type || 'text', mediaUrl || null, replyTo || null, new Date().toISOString()] });
    await db.execute({ sql: 'UPDATE conv_members SET last_read_at = ? WHERE conv_id = ? AND username = ?', args: [new Date().toISOString(), req.params.id, me] });
    moderateContent(id, content, me, 'dm').catch(() => {});
    res.json({ id });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error.' }); }
});

app.delete('/api/conversations/:id/messages/:msgId', auth, async (req, res) => {
  try {
    const msg = (await db.execute({ sql: 'SELECT author FROM conv_messages WHERE id = ? AND conv_id = ?', args: [req.params.msgId, req.params.id] })).rows[0];
    if (!msg) return res.status(404).json({ error: 'Not found.' });
    if (msg.author !== req.user.username && !['admin','owner','supreme'].includes(req.user.role)) return res.status(403).json({ error: 'Forbidden.' });
    await db.execute({ sql: 'UPDATE conv_messages SET deleted = 1 WHERE id = ?', args: [req.params.msgId] });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.get('/api/conversations/:id', auth, async (req, res) => {
  try {
    const me = req.user.username;
    const member = (await db.execute({ sql: 'SELECT * FROM conv_members WHERE conv_id = ? AND username = ?', args: [req.params.id, me] })).rows[0];
    if (!member) return res.status(403).json({ error: 'Not a member.' });
    const conv = (await db.execute({ sql: 'SELECT * FROM conversations WHERE id = ?', args: [req.params.id] })).rows[0];
    if (!conv) return res.status(404).json({ error: 'Not found.' });
    const members = (await db.execute({ sql: 'SELECT username, role FROM conv_members WHERE conv_id = ?', args: [req.params.id] })).rows;
    res.json({ ...conv, members });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/conversations/:id/members', auth, async (req, res) => {
  try {
    const me = req.user.username;
    const myMembership = (await db.execute({ sql: 'SELECT role FROM conv_members WHERE conv_id = ? AND username = ?', args: [req.params.id, me] })).rows[0];
    if (!myMembership || myMembership.role !== 'owner') return res.status(403).json({ error: 'Only group owner can add members.' });
    const conv = (await db.execute({ sql: 'SELECT type FROM conversations WHERE id = ?', args: [req.params.id] })).rows[0];
    if (!conv || conv.type !== 'group') return res.status(400).json({ error: 'Not a group.' });
    const { username } = req.body ?? {};
    if (!username) return res.status(400).json({ error: 'username required.' });
    await db.execute({ sql: 'INSERT INTO conv_members (conv_id,username,role,joined_at) VALUES (?,?,?,?) ON CONFLICT DO NOTHING', args: [req.params.id, username, 'member', new Date().toISOString()] });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.delete('/api/conversations/:id/members/:username', auth, async (req, res) => {
  try {
    const me = req.user.username, target = req.params.username;
    if (me !== target) {
      const myM = (await db.execute({ sql: 'SELECT role FROM conv_members WHERE conv_id = ? AND username = ?', args: [req.params.id, me] })).rows[0];
      if (!myM || myM.role !== 'owner') return res.status(403).json({ error: 'Forbidden.' });
    }
    await db.execute({ sql: 'DELETE FROM conv_members WHERE conv_id = ? AND username = ?', args: [req.params.id, target] });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});


// ════════════════════════════════════════════════ VOICE / WEBSOCKET ══════════

const VOICE_ROOMS = [
  { id: 'lounge', name: 'Lounge', emoji: '🎮', staffOnly: false },
  { id: 'chill',  name: 'Chill',  emoji: '🎵', staffOnly: false },
  { id: 'gaming', name: 'Gaming', emoji: '🕹️', staffOnly: false },
  { id: 'staff',  name: 'Staff',  emoji: '🛡️', staffOnly: true  },
];

const _voiceRooms = new Map(VOICE_ROOMS.map(r => [r.id, new Map()]));
const _wsClients  = new Map();

function broadcastRoomState(roomId) {
  const room = _voiceRooms.get(roomId);
  if (!room) return;
  const members = [...room.keys()];
  const payload = JSON.stringify({ type: 'voice-room-state', roomId, members });
  for (const ws of room.values()) { if (ws.readyState === 1) ws.send(payload); }
  for (const [ws, info] of _wsClients) { if (!room.has(info.username) && ws.readyState === 1) ws.send(payload); }
}

function broadcastAllRooms(ws) {
  for (const [roomId, room] of _voiceRooms) {
    ws.send(JSON.stringify({ type: 'voice-room-state', roomId, members: [...room.keys()] }));
  }
}

function leaveCurrentRoom(username) {
  for (const [roomId, room] of _voiceRooms) {
    if (room.has(username)) {
      room.delete(username);
      const leftMsg = JSON.stringify({ type: 'voice-user-left', roomId, username });
      for (const ws of room.values()) { if (ws.readyState === 1) ws.send(leftMsg); }
      broadcastRoomState(roomId);
      return roomId;
    }
  }
  return null;
}

const wss = new WebSocketServer({ server: httpServer });
wss.on('connection', ws => {
  _wsClients.set(ws, { username: null, role: null, roomId: null });
  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const info = _wsClients.get(ws);
    if (msg.type === 'auth') {
      try { const d = jwt.verify(msg.token, JWT_SECRET); info.username = d.username; info.role = d.role; broadcastAllRooms(ws); }
      catch { ws.send(JSON.stringify({ type: 'error', message: 'Invalid token.' })); }
      return;
    }
    if (!info.username) return;
    if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }
    if (msg.type === 'join-voice') {
      const roomDef = VOICE_ROOMS.find(r => r.id === msg.roomId);
      if (!roomDef) return;
      if (roomDef.staffOnly && !['admin','owner','supreme'].includes(info.role)) { ws.send(JSON.stringify({ type: 'error', message: 'Staff only.' })); return; }
      leaveCurrentRoom(info.username);
      const room = _voiceRooms.get(msg.roomId);
      const existingMembers = [...room.keys()];
      room.set(info.username, ws); info.roomId = msg.roomId;
      ws.send(JSON.stringify({ type: 'voice-joined', roomId: msg.roomId, members: existingMembers }));
      const joinMsg = JSON.stringify({ type: 'voice-user-joined', roomId: msg.roomId, username: info.username });
      for (const mws of room.values()) { if (mws !== ws && mws.readyState === 1) mws.send(joinMsg); }
      broadcastRoomState(msg.roomId); return;
    }
    if (msg.type === 'leave-voice') { leaveCurrentRoom(info.username); info.roomId = null; ws.send(JSON.stringify({ type: 'voice-left' })); return; }
    if (['voice-offer','voice-answer','voice-ice'].includes(msg.type)) {
      for (const [client, cinfo] of _wsClients) { if (cinfo.username === msg.to && client.readyState === 1) { client.send(JSON.stringify({ ...msg, from: info.username })); break; } }
      return;
    }
    if (msg.type === 'voice-speaking') {
      const room = info.roomId ? _voiceRooms.get(info.roomId) : null; if (!room) return;
      const relay = JSON.stringify({ type: 'voice-speaking', username: info.username, speaking: !!msg.speaking });
      for (const [mu, mws] of room) { if (mu !== info.username && mws.readyState === 1) mws.send(relay); }
      return;
    }
    if (['call-invite','call-accept','call-reject','call-end','call-offer','call-answer','call-ice'].includes(msg.type)) {
      const targets = Array.isArray(msg.to) ? msg.to : [msg.to];
      const relayed = JSON.stringify({ ...msg, from: info.username });
      for (const target of targets) {
        for (const [client, cinfo] of _wsClients) { if (cinfo.username === target && client.readyState === 1) { client.send(relayed); break; } }
      }
    }
  });
  ws.on('close', () => { const info = _wsClients.get(ws); if (info?.username) leaveCurrentRoom(info.username); _wsClients.delete(ws); });
});

app.get('/api/voice/rooms', auth, (req, res) => {
  res.json(VOICE_ROOMS.filter(r => !r.staffOnly || ['admin','owner','supreme'].includes(req.user.role)).map(r => ({
    id: r.id, name: r.name, emoji: r.emoji, members: [...(_voiceRooms.get(r.id)?.keys() ?? [])],
  })));
});

// ══════════════════════════════════════════════════════════ BOOT ══════════

async function start() {
  await initSchema();
  await seedAccounts();
  httpServer.listen(PORT, () => console.log(`Neuron → http://localhost:${PORT}`));
}
start().catch(e => { console.error('Failed to start:', e); process.exit(1); });
