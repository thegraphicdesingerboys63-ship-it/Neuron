import 'dotenv/config';
import express        from 'express';
import jwt            from 'jsonwebtoken';
import bcrypt         from 'bcryptjs';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname }       from 'path';
import { createServer }  from 'http';
import { WebSocketServer } from 'ws';
import { v2 as cloudinary } from 'cloudinary';
import { execute as dbExec, initSchema, seedAccounts } from './db.js';
const db = { execute: dbExec };
// No external AI API — moderation runs locally, zero cost.

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const __dirname  = dirname(fileURLToPath(import.meta.url));
const app        = express();
const httpServer = createServer(app);
const PORT       = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'neuron-dev-secret-change-in-prod';
const RESERVED   = ['FTO_Ray', 'AMGProdZ'];

app.use(express.json({ limit: '50mb' })); // upload endpoint receives base64 before Cloudinary upload
app.use(express.static(__dirname));       // serves index.html, style.css, app.js

// ─── Helpers ──────────────────────────────────────────────────────────────────

function uid() { return randomUUID().replace(/-/g, ''); }

// Maps 'supreme' → 'owner' for non-supreme viewers.
function safeRole(role, viewerRole) {
  return (role === 'supreme' && viewerRole !== 'supreme') ? 'owner' : (role || 'user');
}

// Rank used only for canManage() comparison.
const RANK = { user: 0, admin: 1, owner: 2, supreme: 3 };
function roleRank(r) { return RANK[r] ?? 0; }

// Returns true when manager is allowed to take mod actions against target.
function canManage(managerRole, targetRole) {
  if (managerRole === targetRole)  return false;
  if (managerRole === 'supreme')   return true;
  if (managerRole === 'owner')     return targetRole === 'user' || targetRole === 'admin';
  return false;
}

async function getUser(username) {
  return (await db.execute({
    sql:  'SELECT * FROM users WHERE username = ?',
    args: [username],
  })).rows[0] ?? null;
}

function isBanned(user) {
  if (!user || !user.banned) return false;
  if (!user.banned_until)   return true;  // permanent
  return Date.now() < new Date(user.banned_until).getTime();
}

// ─── Local Safety Engine (free, no API, runs on-server) ──────────────────────
//
// Checks for: CSAM/grooming, doxxing, credible threats, severe harassment.
// Returns { flagged, categories, severity, reason } — same shape as before.

const _SAFETY_RULES = [
  // ── CRITICAL: CSAM / grooming ─────────────────────────────────────────────
  // Explicit sexual content involving minors
  {
    cat: 'csam', severity: 'critical',
    patterns: [
      /\b(nude|naked|sex(ual)?|porn|explicit)\b.{0,30}\b(kid|child|minor|teen|underage|yo|year.?old|preteen|tween)\b/i,
      /\b(kid|child|minor|teen|underage|preteen)\b.{0,30}\b(nude|naked|sex(ual)?|porn|explicit)\b/i,
      /\b(cp|c\.p\.|childporn|child porn|kiddie ?porn|jailbait)\b/i,
      /\b(send|share|show).{0,20}\b(pic|photo|image|vid).{0,20}\b(kid|child|minor|teen)\b/i,
    ],
    reason: 'Possible CSAM-related content detected.',
  },
  // Grooming / predatory solicitation of minors
  {
    cat: 'grooming', severity: 'critical',
    patterns: [
      /\b(how old are you|what'?s? your age|are you \d{1,2})\b.{0,60}\b(meet|come over|my place|alone)\b/i,
      /\b(don'?t tell (your )?mom|don'?t tell (your )?parents?|keep (it|this) (a )?secret|our (little )?secret)\b/i,
      /\b(are you (a )?(minor|kid|child|underage|young))\b.{0,40}\b(send|meet|alone|pic|photo)\b/i,
      /\b(i('?m| am) ?\d{2,3}).{0,40}\b(you('?re| are) ?\d{1,2}|your age)\b/i,
      /\bhow old.{0,20}\b(you|ur|u)\b.{0,20}\balone\b/i,
      /\b(meet (me|up)|come (over|to my)).{0,40}\b(parents? (don'?t|not|won'?t) know|tell no.?one|secret)\b/i,
    ],
    reason: 'Possible grooming behaviour detected.',
  },

  // ── CRITICAL: Doxxing ─────────────────────────────────────────────────────
  {
    cat: 'doxxing', severity: 'critical',
    patterns: [
      // SSN  xxx-xx-xxxx or xxxxxxxxx
      /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/,
      // Home address pattern: number + street name + street type
      /\b\d{1,6}\s+[a-z]{2,}\s+(street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|way|court|ct|place|pl)\b/i,
      // "your address is / lives at" phrases
      /\b(your|his|her|their).{0,15}(address|home|house|location|ip).{0,20}(is|:)/i,
      /\b(lives? at|located at|address is)\b.{0,60}\d/i,
      // Full name + phone combo
      /\b[A-Z][a-z]+ [A-Z][a-z]+.{0,30}\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/,
      // "here is [name]'s [personal info]"
      /\b(here('?s| is)|posting|leaking|dropping).{0,20}(address|ssn|social security|phone number|location|ip address)\b/i,
      // IP address shared with "your" or "found"
      /\b(your|found|leaked).{0,20}\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/i,
    ],
    reason: 'Possible doxxing — personal information shared.',
  },

  // ── HIGH: Credible threats of violence ────────────────────────────────────
  {
    cat: 'threats', severity: 'high',
    patterns: [
      /\b(i('?m| am| will| gonna| going to)).{0,30}(kill|shoot|stab|murder|hurt|attack|beat|destroy|harm)\b.{0,20}(you|u|him|her|them|your|his|her|their)\b/i,
      /\b(i('?ll| will)).{0,20}(find|track|hunt).{0,20}(you|u|him|her|them)\b/i,
      /\b(watch (your|ur) back|you('?re| are) dead|dead (man|meat)|say goodbye|enjoy your last)\b/i,
      /\bgoing to.{0,20}(your|ur).{0,20}(house|home|school|work|address)\b.{0,30}(gun|knife|weapon|hurt|kill)\b/i,
      /\b(bomb|shoot up|mass (shooting|killing|murder)).{0,40}(school|church|mall|building|place)\b/i,
    ],
    reason: 'Credible threat of violence detected.',
  },

  // ── HIGH: Severe harassment / targeted abuse ──────────────────────────────
  {
    cat: 'harassment', severity: 'high',
    patterns: [
      // Telling someone to kill themselves (targeted)
      /\b(you should|go|just|please|why don'?t you).{0,15}(kill your(self|selves)|kys|end your(self| it)|off your(self)?|suicide)\b/i,
      // Slurs combined with targeting language (you are / you're a [slur])
      /\b(you('?re| are)).{0,10}(f+a+g+|f+a+g+g+o+t+|n+i+g+|n+i+g+g+[ae]+r*|c+u+n+t+|r+e+t+a+r+d+|tr+a+n+n+y+)\b/i,
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
        return {
          flagged:    true,
          categories: [rule.cat],
          severity:   rule.severity,
          reason:     rule.reason,
        };
      }
    }
  }
  return null; // clean
}

async function moderateContent(messageId, content, author, src = 'channel') {
  if (!content || content.startsWith('[SYSTEM]')) return;
  try {
    const result = _localSafetyCheck(content);
    if (!result) return;

    const flagId = uid();
    await db.execute({
      sql: 'INSERT INTO ai_flags (id, message_id, message_src, author, content, categories, severity, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      args: [flagId, messageId, src, author, content.slice(0, 500), JSON.stringify(result.categories), result.severity, result.reason, new Date().toISOString()],
    });

    const isCritical = result.severity === 'critical';
    if (isCritical) {
      const tbl = src === 'channel' ? 'messages' : 'conv_messages';
      await db.execute({ sql: `UPDATE ${tbl} SET deleted = 1 WHERE id = ?`, args: [messageId] });
      await db.execute({ sql: 'UPDATE users SET banned = 1, banned_until = NULL WHERE username = ?', args: [author] });
      await db.execute({ sql: 'UPDATE ai_flags SET auto_action = ? WHERE id = ?', args: ['deleted_banned', flagId] });
    } else if (result.severity === 'high') {
      if (src === 'channel') {
        await db.execute({
          sql: 'INSERT INTO reports (id, msg_id, reporter, reason, timestamp, status, priority) VALUES (?, ?, ?, ?, ?, ?, ?)',
          args: [uid(), messageId, '[Safety Filter]', result.reason, new Date().toISOString(), 'pending', 1],
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
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (roles.includes(req.user?.role)) return next();
    res.status(403).json({ error: 'Forbidden' });
  };
}
const requireOwnerOrAbove = requireRole('owner', 'supreme');
const requireAdminOrAbove = requireRole('admin', 'owner', 'supreme');

// ═══════════════════════════════════════════════════════════════ ROUTES ═══════

// ─── Auth ─────────────────────────────────────────────────────────────────────

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body ?? {};
    if (!username || !password)
      return res.status(400).json({ error: 'Username and password required.' });

    // Check maintenance mode (reserved accounts can always log in)
    if (!RESERVED.includes(username)) {
      const s = await getSettings();
      if (s.maintenance_mode === '1')
        return res.status(503).json({ error: 'Server is in maintenance mode. Please try again later.' });
    }

    if (!/^[a-zA-Z0-9_]{3,15}$/.test(username))
      return res.status(400).json({ error: 'Username must be 3–15 characters.' });

    let user = await getUser(username);

    if (user) {
      const match = await bcrypt.compare(password, user.password);
      if (!match) return res.status(401).json({ error: 'Incorrect password.' });
      if (isBanned(user)) {
        const until = user.banned_until
          ? `until ${new Date(user.banned_until).toLocaleString()}`
          : 'permanently';
        return res.status(403).json({ error: `You are banned ${until}.` });
      }
    } else {
      if (RESERVED.includes(username))
        return res.status(400).json({ error: 'That username is reserved.' });
      const hash = await bcrypt.hash(password, 10);
      await db.execute({
        sql:  'INSERT INTO users (username, password, role) VALUES (?, ?, ?)',
        args: [username, hash, 'user'],
      });
      user = await getUser(username);
    }

    const token = jwt.sign(
      { username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.json({ token, username: user.username, role: user.role });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error.' }); }
});

// Re-reads role from DB so mid-session promotions/demotions are picked up on
// the next poll without forcing a logout.
app.get('/api/me', auth, async (req, res) => {
  try {
    const user = await getUser(req.user.username);
    if (!user) return res.status(401).json({ error: 'User not found.' });
    res.json({ username: user.username, role: user.role, tosAccepted: !!user.tos_accepted, parentalControls: !!user.parental_controls });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/tos/accept', auth, async (req, res) => {
  try {
    await db.execute({
      sql: 'UPDATE users SET tos_accepted = 1, tos_accepted_at = ? WHERE username = ?',
      args: [new Date().toISOString(), req.user.username],
    });
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
      const hash = await bcrypt.hash(pin, 10);
      await db.execute({ sql: 'UPDATE users SET parental_controls = 1, parental_pin = ? WHERE username = ?', args: [hash, user.username] });
      return res.json({ ok: true });
    }
    if (action === 'disable') {
      if (!currentPin) return res.status(400).json({ error: 'Current PIN required.' });
      if (!user.parental_pin) return res.status(400).json({ error: 'Parental controls not set up.' });
      const match = await bcrypt.compare(currentPin, user.parental_pin);
      if (!match) return res.status(401).json({ error: 'Incorrect PIN.' });
      await db.execute({ sql: 'UPDATE users SET parental_controls = 0, parental_pin = NULL WHERE username = ?', args: [user.username] });
      return res.json({ ok: true });
    }
    res.status(400).json({ error: 'Invalid action.' });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

// ─── Friends ──────────────────────────────────────────────────────────────────

app.get('/api/friends', auth, async (req, res) => {
  try {
    const me = req.user.username;
    const rows = (await db.execute({
      sql: `SELECT f.*,
              CASE WHEN f.requester = ? THEN f.recipient ELSE f.requester END AS other_user
            FROM friends f
            WHERE (f.requester = ? OR f.recipient = ?) AND f.status != 'blocked'
            ORDER BY f.created_at DESC`,
      args: [me, me, me],
    })).rows;

    const friends = rows.filter(r => r.status === 'accepted').map(r => r.other_user);
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
    if (isBanned(target)) return res.status(400).json({ error: 'Cannot send friend request.' });

    const existing = (await db.execute({
      sql: 'SELECT * FROM friends WHERE (requester = ? AND recipient = ?) OR (requester = ? AND recipient = ?)',
      args: [req.user.username, username, username, req.user.username],
    })).rows[0];

    if (existing) {
      if (existing.status === 'accepted') return res.status(400).json({ error: 'Already friends.' });
      if (existing.status === 'pending')  return res.status(400).json({ error: 'Request already pending.' });
      if (existing.status === 'blocked')  return res.status(400).json({ error: 'Cannot send request.' });
    }

    const id = uid();
    await db.execute({
      sql: 'INSERT INTO friends (id, requester, recipient, status, created_at) VALUES (?, ?, ?, ?, ?)',
      args: [id, req.user.username, username, 'pending', new Date().toISOString()],
    });
    res.json({ id });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.patch('/api/friends/:username', auth, async (req, res) => {
  try {
    const { action } = req.body ?? {};
    const me = req.user.username;
    const other = req.params.username;

    const row = (await db.execute({
      sql: 'SELECT * FROM friends WHERE (requester = ? AND recipient = ?) OR (requester = ? AND recipient = ?)',
      args: [me, other, other, me],
    })).rows[0];

    if (!row) return res.status(404).json({ error: 'No relationship found.' });

    if (action === 'accept') {
      if (row.recipient !== me) return res.status(403).json({ error: 'Forbidden.' });
      await db.execute({ sql: "UPDATE friends SET status = 'accepted' WHERE id = ?", args: [row.id] });
    } else if (action === 'reject') {
      await db.execute({ sql: 'DELETE FROM friends WHERE id = ?', args: [row.id] });
    } else if (action === 'block') {
      await db.execute({ sql: "UPDATE friends SET status = 'blocked', requester = ?, recipient = ? WHERE id = ?", args: [me, other, row.id] });
    } else {
      return res.status(400).json({ error: 'Unknown action.' });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.delete('/api/friends/:username', auth, async (req, res) => {
  try {
    const me = req.user.username;
    const other = req.params.username;
    await db.execute({
      sql: 'DELETE FROM friends WHERE (requester = ? AND recipient = ?) OR (requester = ? AND recipient = ?)',
      args: [me, other, other, me],
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

// ─── Conversations (DMs + Groups) ────────────────────────────────────────────

app.get('/api/conversations', auth, async (req, res) => {
  try {
    const me = req.user.username;
    const rows = (await db.execute({
      sql: `SELECT c.*, cm.last_read_at,
              (SELECT COUNT(*) FROM conv_messages m
               WHERE m.conv_id = c.id AND m.deleted = 0
                 AND (cm.last_read_at IS NULL OR m.timestamp > cm.last_read_at)) AS unread,
              (SELECT m2.content FROM conv_messages m2
               WHERE m2.conv_id = c.id AND m2.deleted = 0
               ORDER BY m2.timestamp DESC LIMIT 1) AS last_msg,
              (SELECT m2.timestamp FROM conv_messages m2
               WHERE m2.conv_id = c.id AND m2.deleted = 0
               ORDER BY m2.timestamp DESC LIMIT 1) AS last_msg_at
            FROM conversations c
            JOIN conv_members cm ON cm.conv_id = c.id AND cm.username = ?
            ORDER BY last_msg_at DESC NULLS LAST`,
      args: [me],
    })).rows;

    const result = await Promise.all(rows.map(async c => {
      const members = (await db.execute({
        sql: 'SELECT username, role FROM conv_members WHERE conv_id = ?',
        args: [c.id],
      })).rows;
      const name = c.type === 'dm'
        ? members.find(m => m.username !== me)?.username || 'Unknown'
        : c.name;
      return {
        id: c.id, type: c.type, name,
        members: members.map(m => m.username),
        unread: Number(c.unread) || 0,
        lastMsg: c.last_msg ? c.last_msg.slice(0, 60) : null,
        lastMsgAt: c.last_msg_at,
      };
    }));
    res.json(result);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/conversations', auth, async (req, res) => {
  try {
    const { type, username, name, members } = req.body ?? {};
    const me = req.user.username;

    if (type === 'dm') {
      if (!username) return res.status(400).json({ error: 'username required for DM.' });
      if (username === me) return res.status(400).json({ error: 'Cannot DM yourself.' });

      // Check if DM already exists
      const existing = (await db.execute({
        sql: `SELECT c.id FROM conversations c
              JOIN conv_members cm1 ON cm1.conv_id = c.id AND cm1.username = ?
              JOIN conv_members cm2 ON cm2.conv_id = c.id AND cm2.username = ?
              WHERE c.type = 'dm'`,
        args: [me, username],
      })).rows[0];
      if (existing) return res.json({ id: existing.id, existing: true });

      const id = uid();
      await db.execute({ sql: 'INSERT INTO conversations (id, type, created_by, created_at) VALUES (?, ?, ?, ?)', args: [id, 'dm', me, new Date().toISOString()] });
      await db.execute({ sql: 'INSERT INTO conv_members (conv_id, username, role, joined_at) VALUES (?, ?, ?, ?)', args: [id, me, 'owner', new Date().toISOString()] });
      await db.execute({ sql: 'INSERT INTO conv_members (conv_id, username, role, joined_at) VALUES (?, ?, ?, ?)', args: [id, username, 'member', new Date().toISOString()] });
      return res.json({ id });
    }

    if (type === 'group') {
      if (!name?.trim()) return res.status(400).json({ error: 'Group name required.' });
      const allMembers = [...new Set([me, ...(members || [])])].slice(0, 20);
      const id = uid();
      await db.execute({ sql: 'INSERT INTO conversations (id, type, name, created_by, created_at) VALUES (?, ?, ?, ?, ?)', args: [id, 'group', name.trim(), me, new Date().toISOString()] });
      for (const u of allMembers) {
        await db.execute({ sql: 'INSERT INTO conv_members (conv_id, username, role, joined_at) VALUES (?, ?, ?, ?)', args: [id, u, u === me ? 'owner' : 'member', new Date().toISOString()] });
      }
      return res.json({ id });
    }

    res.status(400).json({ error: 'type must be dm or group.' });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error.' }); }
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

app.get('/api/conversations/:id/messages', auth, async (req, res) => {
  try {
    const me = req.user.username;
    const member = (await db.execute({ sql: 'SELECT 1 FROM conv_members WHERE conv_id = ? AND username = ?', args: [req.params.id, me] })).rows[0];
    if (!member) return res.status(403).json({ error: 'Not a member.' });

    const rows = (await db.execute({
      sql: 'SELECT * FROM conv_messages WHERE conv_id = ? AND deleted = 0 ORDER BY timestamp ASC LIMIT 200',
      args: [req.params.id],
    })).rows;

    // Mark as read
    await db.execute({ sql: 'UPDATE conv_members SET last_read_at = ? WHERE conv_id = ? AND username = ?', args: [new Date().toISOString(), req.params.id, me] });

    res.json(rows.map(m => ({ id: m.id, author: m.author, content: m.content, type: m.type, mediaUrl: m.media_url, replyTo: m.reply_to, timestamp: m.timestamp, flagged: !!m.flagged })));
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/conversations/:id/messages', auth, async (req, res) => {
  try {
    const me = req.user.username;
    const member = (await db.execute({ sql: 'SELECT 1 FROM conv_members WHERE conv_id = ? AND username = ?', args: [req.params.id, me] })).rows[0];
    if (!member) return res.status(403).json({ error: 'Not a member.' });

    const { content, type, mediaUrl, replyTo } = req.body ?? {};
    if (!content) return res.status(400).json({ error: 'Content required.' });

    // Parental controls: check if recipient has DMs from non-friends locked
    const poster = await getUser(me);
    if (poster?.parental_controls) {
      const conv = (await db.execute({ sql: 'SELECT type FROM conversations WHERE id = ?', args: [req.params.id] })).rows[0];
      if (conv?.type === 'dm') {
        const members = (await db.execute({ sql: 'SELECT username FROM conv_members WHERE conv_id = ?', args: [req.params.id] })).rows;
        const other = members.find(m => m.username !== me)?.username;
        if (other) {
          const areFriends = (await db.execute({
            sql: "SELECT 1 FROM friends WHERE ((requester = ? AND recipient = ?) OR (requester = ? AND recipient = ?)) AND status = 'accepted'",
            args: [me, other, other, me],
          })).rows[0];
          if (!areFriends) return res.status(403).json({ error: 'Parental controls: you can only DM friends.' });
        }
      }
    }

    const s = await getSettings();
    const maxLen = s.max_msg_length ? parseInt(s.max_msg_length) : 2000;
    if (content.length > maxLen) return res.status(400).json({ error: `Message too long (max ${maxLen} chars).` });

    const id = uid();
    await db.execute({
      sql: 'INSERT INTO conv_messages (id, conv_id, author, content, type, media_url, reply_to, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      args: [id, req.params.id, me, content, type || 'text', mediaUrl || null, replyTo || null, new Date().toISOString()],
    });
    await db.execute({ sql: 'UPDATE conv_members SET last_read_at = ? WHERE conv_id = ? AND username = ?', args: [new Date().toISOString(), req.params.id, me] });

    moderateContent(id, content, me, 'dm').catch(() => {});
    res.json({ id });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error.' }); }
});

app.delete('/api/conversations/:id/messages/:msgId', auth, async (req, res) => {
  try {
    const me = req.user.username;
    const msg = (await db.execute({ sql: 'SELECT author FROM conv_messages WHERE id = ? AND conv_id = ?', args: [req.params.msgId, req.params.id] })).rows[0];
    if (!msg) return res.status(404).json({ error: 'Not found.' });
    if (msg.author !== me && !['admin','owner','supreme'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden.' });
    }
    await db.execute({ sql: 'UPDATE conv_messages SET deleted = 1 WHERE id = ?', args: [req.params.msgId] });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/conversations/:id/members', auth, async (req, res) => {
  try {
    const me = req.user.username;
    const myMembership = (await db.execute({ sql: "SELECT role FROM conv_members WHERE conv_id = ? AND username = ?", args: [req.params.id, me] })).rows[0];
    if (!myMembership || myMembership.role !== 'owner') return res.status(403).json({ error: 'Only group owner can add members.' });
    const conv = (await db.execute({ sql: 'SELECT type FROM conversations WHERE id = ?', args: [req.params.id] })).rows[0];
    if (!conv || conv.type !== 'group') return res.status(400).json({ error: 'Not a group.' });
    const { username } = req.body ?? {};
    if (!username) return res.status(400).json({ error: 'username required.' });
    await db.execute({ sql: 'INSERT INTO conv_members (conv_id, username, role, joined_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', args: [req.params.id, username, 'member', new Date().toISOString()] });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.delete('/api/conversations/:id/members/:username', auth, async (req, res) => {
  try {
    const me = req.user.username;
    const target = req.params.username;
    if (me !== target) {
      const myMembership = (await db.execute({ sql: "SELECT role FROM conv_members WHERE conv_id = ? AND username = ?", args: [req.params.id, me] })).rows[0];
      if (!myMembership || myMembership.role !== 'owner') return res.status(403).json({ error: 'Forbidden.' });
    }
    await db.execute({ sql: 'DELETE FROM conv_members WHERE conv_id = ? AND username = ?', args: [req.params.id, target] });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

// ─── Admin: AI flags ─────────────────────────────────────────────────────────

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

// ─── Messages ─────────────────────────────────────────────────────────────────

app.get('/api/messages', auth, async (req, res) => {
  try {
    const channel = req.query.channel === 'staff' ? 'staff' : 'general';
    if (channel === 'staff' && !['admin','owner','supreme'].includes(req.user.role))
      return res.status(403).json({ error: 'Forbidden.' });

    const result = await db.execute({
      sql: `
        SELECT m.id, m.channel, m.author, m.content, m.type,
               m.media_url, m.link_url, m.timestamp, m.reply_to, m.pinned,
               u.role AS author_role,
               STRING_AGG(CASE WHEN r.type='like'    THEN r.username ELSE NULL END, ',') AS likes,
               STRING_AGG(CASE WHEN r.type='dislike' THEN r.username ELSE NULL END, ',') AS dislikes
        FROM   messages  m
        LEFT JOIN users     u ON u.username   = m.author
        LEFT JOIN reactions r ON r.message_id = m.id
        WHERE  m.channel = ? AND m.deleted = 0
        GROUP  BY m.id, m.channel, m.author, m.content, m.type,
                  m.media_url, m.link_url, m.timestamp, m.reply_to, m.pinned, u.role
        ORDER  BY m.timestamp ASC`,
      args: [channel],
    });

    const vr = req.user.role;
    res.json(result.rows.map(row => ({
      id:         row.id,
      author:     row.author,
      content:    row.content,
      type:       row.type,
      mediaUrl:   row.media_url,
      linkUrl:    row.link_url,
      timestamp:  row.timestamp,
      replyTo:    row.reply_to,
      pinned:     !!row.pinned,
      authorRole: safeRole(row.author_role, vr),
      reactions: {
        like:    row.likes    ? row.likes.split(',').filter(Boolean)    : [],
        dislike: row.dislikes ? row.dislikes.split(',').filter(Boolean) : [],
      },
    })));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/messages', auth, async (req, res) => {
  try {
    const { content, type, mediaUrl, linkUrl, replyTo, channel } = req.body ?? {};
    const ch = channel === 'staff' ? 'staff' : 'general';
    if (ch === 'staff' && !['admin','owner','supreme'].includes(req.user.role))
      return res.status(403).json({ error: 'Forbidden.' });
    if (!content) return res.status(400).json({ error: 'Content required.' });

    // Check mute
    const poster = await getUser(req.user.username);
    if (poster?.muted) {
      if (!poster.muted_until || Date.now() < new Date(poster.muted_until).getTime()) {
        return res.status(403).json({ error: 'You are currently muted.' });
      }
      await db.execute({ sql: 'UPDATE users SET muted = 0, muted_until = NULL WHERE username = ?', args: [poster.username] });
    }

    const s = await getSettings();

    // Check channel lock (admins+ bypass)
    const lockKey = ch === 'staff' ? 'staff_locked' : 'general_locked';
    if (s[lockKey] === '1' && !['admin','owner','supreme'].includes(req.user.role))
      return res.status(403).json({ error: 'This channel is currently locked.' });

    // Check max message length
    const maxLen = s.max_msg_length ? parseInt(s.max_msg_length) : 2000;
    if (content.length > maxLen)
      return res.status(400).json({ error: `Message too long (max ${maxLen} characters).` });

    // Check word filter
    if (s.word_filter && !['owner','supreme'].includes(req.user.role)) {
      try {
        const words = JSON.parse(s.word_filter);
        const lower = content.toLowerCase();
        for (const w of words) {
          if (w && lower.includes(w.toLowerCase()))
            return res.status(400).json({ error: 'Your message contains a filtered word.' });
        }
      } catch {}
    }

    const id = uid();
    await db.execute({
      sql:  `INSERT INTO messages (id, channel, author, content, type, media_url, link_url, timestamp, reply_to)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, ch, req.user.username, content, type || 'text',
             mediaUrl || null, linkUrl || null, new Date().toISOString(), replyTo || null],
    });
    moderateContent(id, content, req.user.username, 'channel').catch(() => {});
    res.json({ id });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error.' }); }
});

app.delete('/api/messages/:id', auth, async (req, res) => {
  try {
    const msg = (await db.execute({
      sql: 'SELECT author FROM messages WHERE id = ?', args: [req.params.id],
    })).rows[0];
    if (!msg) return res.status(404).json({ error: 'Not found.' });

    const cu = req.user;
    const authorUser = await getUser(msg.author);
    const ar = authorUser?.role || 'user';

    let ok = false;
    if (msg.author === cu.username)                              ok = true;
    else if (cu.role === 'supreme')                             ok = true;
    else if (cu.role === 'owner'  && ar !== 'supreme')          ok = true;
    else if (cu.role === 'admin'  && (ar === 'user' || !ar))   ok = true;

    if (!ok) return res.status(403).json({ error: 'Forbidden.' });

    await db.execute({ sql: 'UPDATE messages SET deleted = 1 WHERE id = ?', args: [req.params.id] });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/messages/:id/pin', auth, async (req, res) => {
  try {
    if (req.user.role !== 'supreme') return res.status(403).json({ error: 'Forbidden.' });
    const row = (await db.execute({
      sql: 'SELECT pinned FROM messages WHERE id = ?', args: [req.params.id],
    })).rows[0];
    if (!row) return res.status(404).json({ error: 'Not found.' });
    const next = row.pinned ? 0 : 1;
    await db.execute({ sql: 'UPDATE messages SET pinned = ? WHERE id = ?', args: [next, req.params.id] });
    res.json({ pinned: !!next });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/messages/:id/react', auth, async (req, res) => {
  try {
    const { type } = req.body ?? {};
    if (type !== 'like' && type !== 'dislike')
      return res.status(400).json({ error: 'Invalid reaction type.' });

    const { username } = req.user;
    const msgId = req.params.id;
    const opp   = type === 'like' ? 'dislike' : 'like';

    // Remove opposite reaction
    await db.execute({
      sql:  'DELETE FROM reactions WHERE message_id = ? AND username = ? AND type = ?',
      args: [msgId, username, opp],
    });
    // Toggle current reaction
    const existing = (await db.execute({
      sql:  'SELECT 1 FROM reactions WHERE message_id = ? AND username = ? AND type = ?',
      args: [msgId, username, type],
    })).rows[0];

    if (existing) {
      await db.execute({
        sql:  'DELETE FROM reactions WHERE message_id = ? AND username = ? AND type = ?',
        args: [msgId, username, type],
      });
    } else {
      await db.execute({
        sql:  'INSERT INTO reactions (message_id, username, type) VALUES (?, ?, ?)',
        args: [msgId, username, type],
      });
    }
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error.' }); }
});

// ─── Announcements ────────────────────────────────────────────────────────────

app.get('/api/announcements', auth, async (req, res) => {
  try {
    const rows = (await db.execute('SELECT * FROM announcements ORDER BY timestamp ASC')).rows;
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/announcements', auth, requireOwnerOrAbove, async (req, res) => {
  try {
    const { text } = req.body ?? {};
    if (!text) return res.status(400).json({ error: 'Text required.' });
    const id = uid();
    await db.execute({
      sql:  'INSERT INTO announcements (id, text, author, timestamp) VALUES (?, ?, ?, ?)',
      args: [id, text, req.user.username, new Date().toISOString()],
    });
    res.json({ id });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.delete('/api/announcements/:id', auth, requireOwnerOrAbove, async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM announcements WHERE id = ?', args: [req.params.id] });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

// ─── Users ────────────────────────────────────────────────────────────────────

// Sidebar list — all authenticated users can fetch this
app.get('/api/users', auth, async (req, res) => {
  try {
    const vr   = req.user.role;
    const rows = (await db.execute(
      'SELECT username, role, banned, banned_until FROM users ORDER BY username'
    )).rows;
    res.json(rows.map(u => ({
      username:    u.username,
      role:        safeRole(u.role, vr),
      banned:      !!u.banned,
      bannedUntil: u.banned_until,
    })));
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

// Full detail card for a single user (permissions enforced here)
app.get('/api/users/:username', auth, async (req, res) => {
  try {
    const target = await getUser(req.params.username);
    if (!target) return res.status(404).json({ error: 'User not found.' });

    const vr = req.user.role;
    const tr = target.role;

    let canView = false;
    if (req.user.username === target.username) canView = false; // no self-view
    else if (vr === 'supreme')                  canView = true;
    else if (vr === 'owner' && (tr === 'user' || tr === 'admin')) canView = true;
    else if (vr === 'admin' && tr === 'user')   canView = true;

    if (!canView) return res.status(403).json({ error: 'Forbidden.' });

    const msgCount = (await db.execute({
      sql:  'SELECT COUNT(*) AS n FROM messages WHERE author = ? AND deleted = 0',
      args: [target.username],
    })).rows[0].n;

    res.json({
      username:     target.username,
      role:         safeRole(tr, vr),
      banned:       !!target.banned,
      bannedUntil:  target.banned_until,
      createdAt:    target.created_at,
      messageCount: Number(msgCount),
    });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

// Admin panel full user list
app.get('/api/admin/users', auth, requireOwnerOrAbove, async (req, res) => {
  try {
    const vr   = req.user.role;
    const rows = (await db.execute(
      'SELECT username, role, banned, banned_until, created_at, muted, muted_until, notes FROM users ORDER BY username'
    )).rows;
    res.json(rows.map(u => ({
      username:    u.username,
      role:        u.role,                   // actual role for admin panel logic
      displayRole: safeRole(u.role, vr),     // display role for the table
      banned:      !!u.banned,
      bannedUntil: u.banned_until,
      createdAt:   u.created_at,
      muted:       !!u.muted,
      mutedUntil:  u.muted_until,
      notes:       u.notes || '',
    })));
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

// Single PATCH endpoint handles all user management actions
app.patch('/api/admin/users/:username', auth, requireOwnerOrAbove, async (req, res) => {
  try {
    const { action, bannedUntil } = req.body ?? {};
    const cu     = req.user;
    const target = await getUser(req.params.username);
    if (!target) return res.status(404).json({ error: 'User not found.' });
    if (!canManage(cu.role, target.role))
      return res.status(403).json({ error: 'Forbidden.' });

    switch (action) {
      case 'ban':
        await db.execute({
          sql:  'UPDATE users SET banned = 1, banned_until = ? WHERE username = ?',
          args: [bannedUntil || null, target.username],
        }); break;

      case 'unban':
        await db.execute({
          sql:  'UPDATE users SET banned = 0, banned_until = NULL WHERE username = ?',
          args: [target.username],
        }); break;

      case 'grant_admin':
        if (target.role !== 'user')
          return res.status(400).json({ error: 'User is not a regular user.' });
        await db.execute({
          sql: 'UPDATE users SET role = ? WHERE username = ?', args: ['admin', target.username],
        }); break;

      case 'revoke_admin':
        if (target.role !== 'admin')
          return res.status(400).json({ error: 'User is not an admin.' });
        await db.execute({
          sql: 'UPDATE users SET role = ? WHERE username = ?', args: ['user', target.username],
        }); break;

      case 'promote_owner':
        if (cu.role !== 'supreme')
          return res.status(403).json({ error: 'Forbidden.' });
        await db.execute({
          sql: 'UPDATE users SET role = ? WHERE username = ?', args: ['owner', target.username],
        }); break;

      case 'mute': {
        if (req.user.role !== 'supreme') return res.status(403).json({ error: 'Forbidden.' });
        const muteUntil = req.body.muteUntil || null;
        await db.execute({
          sql: 'UPDATE users SET muted = 1, muted_until = ? WHERE username = ?',
          args: [muteUntil, target.username],
        }); break;
      }
      case 'unmute':
        if (req.user.role !== 'supreme') return res.status(403).json({ error: 'Forbidden.' });
        await db.execute({
          sql: 'UPDATE users SET muted = 0, muted_until = NULL WHERE username = ?',
          args: [target.username],
        }); break;

      case 'clear_messages':
        if (req.user.role !== 'supreme') return res.status(403).json({ error: 'Forbidden.' });
        await db.execute({ sql: 'UPDATE messages SET deleted = 1 WHERE author = ?', args: [target.username] }); break;

      case 'add_note':
        if (req.user.role !== 'supreme') return res.status(403).json({ error: 'Forbidden.' });
        await db.execute({
          sql: 'UPDATE users SET notes = ? WHERE username = ?',
          args: [req.body.note ?? '', target.username],
        }); break;

      case 'clear_note':
        if (req.user.role !== 'supreme') return res.status(403).json({ error: 'Forbidden.' });
        await db.execute({ sql: 'UPDATE users SET notes = NULL WHERE username = ?', args: [target.username] }); break;

      case 'demote_owner':
        if (cu.role !== 'supreme') return res.status(403).json({ error: 'Forbidden.' });
        if (target.role !== 'owner') return res.status(400).json({ error: 'User is not an owner.' });
        await db.execute({ sql: 'UPDATE users SET role = ? WHERE username = ?', args: ['user', target.username] }); break;

      case 'demote_owner_to_admin':
        if (cu.role !== 'supreme') return res.status(403).json({ error: 'Forbidden.' });
        if (target.role !== 'owner') return res.status(400).json({ error: 'User is not an owner.' });
        await db.execute({ sql: 'UPDATE users SET role = ? WHERE username = ?', args: ['admin', target.username] }); break;

      default:
        return res.status(400).json({ error: 'Unknown action.' });
    }
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error.' }); }
});

app.delete('/api/admin/users/:username', auth, requireOwnerOrAbove, async (req, res) => {
  try {
    const cu     = req.user;
    const target = await getUser(req.params.username);
    if (!target) return res.status(404).json({ error: 'User not found.' });
    if (!canManage(cu.role, target.role))
      return res.status(403).json({ error: 'Forbidden.' });

    await db.execute({ sql: 'DELETE FROM users WHERE username = ?',            args: [target.username] });
    await db.execute({ sql: 'UPDATE messages SET deleted = 1 WHERE author = ?', args: [target.username] });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

// ─── Reports ──────────────────────────────────────────────────────────────────

app.get('/api/reports', auth, requireAdminOrAbove, async (req, res) => {
  try {
    const sql = req.user.role === 'supreme'
      ? 'SELECT * FROM reports ORDER BY timestamp DESC'
      : "SELECT * FROM reports WHERE status = 'pending' ORDER BY timestamp DESC";
    res.json((await db.execute(sql)).rows);
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/reports', auth, async (req, res) => {
  try {
    const { msgId, reason } = req.body ?? {};
    if (!msgId || !reason)
      return res.status(400).json({ error: 'msgId and reason required.' });
    const id       = uid();
    const priority = ['admin','owner','supreme'].includes(req.user.role) ? 1 : 0;
    await db.execute({
      sql:  'INSERT INTO reports (id, msg_id, reporter, reason, timestamp, status, priority) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: [id, msgId, req.user.username, reason, new Date().toISOString(), 'pending', priority],
    });
    res.json({ id });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

// Fetch messages surrounding a reported message for mod context review
app.get('/api/reports/:id/context', auth, requireAdminOrAbove, async (req, res) => {
  try {
    const report = (await db.execute({
      sql: 'SELECT * FROM reports WHERE id = ?', args: [req.params.id],
    })).rows[0];
    if (!report) return res.status(404).json({ error: 'Not found.' });

    // Get the reported message to find its channel + timestamp
    const reported = (await db.execute({
      sql: 'SELECT * FROM messages WHERE id = ?', args: [report.msg_id],
    })).rows[0];
    if (!reported) return res.json({ channel: null, messages: [], reportedMsgId: report.msg_id });

    // Fetch 15 messages before and 10 after the reported message's timestamp
    const [before, after] = await Promise.all([
      db.execute({
        sql: `SELECT m.id, m.author, m.content, m.type, m.timestamp, m.deleted, u.role AS author_role
              FROM messages m LEFT JOIN users u ON u.username = m.author
              WHERE m.channel = ? AND m.timestamp <= ? AND m.deleted = 0
              ORDER BY m.timestamp DESC LIMIT 16`,
        args: [reported.channel, reported.timestamp],
      }),
      db.execute({
        sql: `SELECT m.id, m.author, m.content, m.type, m.timestamp, m.deleted, u.role AS author_role
              FROM messages m LEFT JOIN users u ON u.username = m.author
              WHERE m.channel = ? AND m.timestamp > ? AND m.deleted = 0
              ORDER BY m.timestamp ASC LIMIT 10`,
        args: [reported.channel, reported.timestamp],
      }),
    ]);

    const msgs = [
      ...before.rows.reverse(),
      ...after.rows,
    ].map(m => ({
      id:         m.id,
      author:     m.author,
      content:    m.content,
      type:       m.type,
      timestamp:  m.timestamp,
      authorRole: safeRole(m.author_role, req.user.role),
      isReported: m.id === report.msg_id,
    }));

    res.json({ channel: reported.channel, messages: msgs, reportedMsgId: report.msg_id });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error.' }); }
});

app.patch('/api/reports/:id', auth, requireAdminOrAbove, async (req, res) => {
  try {
    const { action } = req.body ?? {};
    const report = (await db.execute({
      sql: 'SELECT * FROM reports WHERE id = ?', args: [req.params.id],
    })).rows[0];
    if (!report) return res.status(404).json({ error: 'Not found.' });

    const dismiss = async () => db.execute({
      sql: "UPDATE reports SET status = 'dismissed' WHERE id = ?", args: [req.params.id],
    });

    if (action === 'dismiss') {
      await dismiss();
    } else if (action === 'delete_msg') {
      await db.execute({ sql: 'UPDATE messages SET deleted = 1 WHERE id = ?', args: [report.msg_id] });
      await dismiss();
    } else if (action === 'delete_ban') {
      await db.execute({ sql: 'UPDATE messages SET deleted = 1 WHERE id = ?', args: [report.msg_id] });
      const msgRow = (await db.execute({ sql: 'SELECT author FROM messages WHERE id = ?', args: [report.msg_id] })).rows[0];
      if (msgRow) {
        const author = await getUser(msgRow.author);
        if (author && canManage(req.user.role, author.role)) {
          await db.execute({
            sql: 'UPDATE users SET banned = 1, banned_until = NULL WHERE username = ?', args: [author.username],
          });
        }
      }
      await dismiss();
    } else {
      return res.status(400).json({ error: 'Unknown action.' });
    }
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error.' }); }
});

// ─── User self-service ────────────────────────────────────────────────────────

app.patch('/api/me/password', auth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body ?? {};
    if (!currentPassword || !newPassword)
      return res.status(400).json({ error: 'Current and new password required.' });
    if (newPassword.length < 6)
      return res.status(400).json({ error: 'New password must be at least 6 characters.' });

    const user = await getUser(req.user.username);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const match = await bcrypt.compare(currentPassword, user.password);
    if (!match) return res.status(401).json({ error: 'Current password is incorrect.' });

    const hash = await bcrypt.hash(newPassword, 10);
    await db.execute({
      sql:  'UPDATE users SET password = ? WHERE username = ?',
      args: [hash, user.username],
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.delete('/api/me', auth, async (req, res) => {
  try {
    const { password } = req.body ?? {};
    if (!password) return res.status(400).json({ error: 'Password required to confirm.' });

    const user = await getUser(req.user.username);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    if (RESERVED.includes(user.username))
      return res.status(403).json({ error: 'This account cannot be deleted.' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Incorrect password.' });

    await db.execute({ sql: 'DELETE FROM users WHERE username = ?',             args: [user.username] });
    await db.execute({ sql: 'UPDATE messages SET deleted = 1 WHERE author = ?', args: [user.username] });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

// ─── Supreme-only: clear all general messages ─────────────────────────────────

app.post('/api/admin/clear', auth, async (req, res) => {
  try {
    if (req.user.role !== 'supreme') return res.status(403).json({ error: 'Forbidden.' });
    await db.execute({ sql: "UPDATE messages SET deleted = 1 WHERE channel = 'general'", args: [] });
    await db.execute({ sql: "DELETE FROM reports", args: [] });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

// ─── Supreme: server stats ────────────────────────────────────────────────────

app.get('/api/admin/stats', auth, async (req, res) => {
  if (req.user.role !== 'supreme') return res.status(403).json({ error: 'Forbidden.' });
  try {
    const [users, msgs, reports, banned, muted, reactions, topUsers] = await Promise.all([
      db.execute({ sql: 'SELECT COUNT(*) AS n FROM users', args: [] }),
      db.execute({ sql: 'SELECT COUNT(*) AS n FROM messages WHERE deleted = 0', args: [] }),
      db.execute({ sql: "SELECT COUNT(*) AS n FROM reports WHERE status = 'pending'", args: [] }),
      db.execute({ sql: 'SELECT COUNT(*) AS n FROM users WHERE banned = 1', args: [] }),
      db.execute({ sql: 'SELECT COUNT(*) AS n FROM users WHERE muted = 1', args: [] }),
      db.execute({ sql: 'SELECT COUNT(*) AS n FROM reactions', args: [] }),
      db.execute({ sql: 'SELECT author, COUNT(*) AS n FROM messages WHERE deleted = 0 GROUP BY author ORDER BY n DESC LIMIT 5', args: [] }),
    ]);
    res.json({
      totalUsers:     Number(users.rows[0].n),
      totalMessages:  Number(msgs.rows[0].n),
      pendingReports: Number(reports.rows[0].n),
      bannedUsers:    Number(banned.rows[0].n),
      mutedUsers:     Number(muted.rows[0].n),
      totalReactions: Number(reactions.rows[0].n),
      topUsers:       topUsers.rows.map(r => ({ username: r.author, count: Number(r.n) })),
    });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error.' }); }
});

// ─── Supreme: settings ────────────────────────────────────────────────────────

app.get('/api/admin/settings', auth, async (req, res) => {
  if (req.user.role !== 'supreme') return res.status(403).json({ error: 'Forbidden.' });
  try {
    const s = await getSettings();
    res.json(s);
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

const ALLOWED_SETTINGS = ['general_locked','staff_locked','maintenance_mode','max_msg_length','word_filter','general_slowmode','staff_slowmode','motd'];

app.patch('/api/admin/settings', auth, async (req, res) => {
  if (req.user.role !== 'supreme') return res.status(403).json({ error: 'Forbidden.' });
  try {
    const { key, value } = req.body ?? {};
    if (!key || !ALLOWED_SETTINGS.includes(key)) return res.status(400).json({ error: 'Invalid setting key.' });
    await db.execute({
      sql: `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      args: [key, String(value ?? ''), new Date().toISOString()],
    });
    invalidateSettings();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

// ─── Supreme: deleted message log ────────────────────────────────────────────

app.get('/api/admin/deleted', auth, async (req, res) => {
  if (req.user.role !== 'supreme') return res.status(403).json({ error: 'Forbidden.' });
  try {
    const rows = (await db.execute({
      sql: 'SELECT id, channel, author, content, type, timestamp FROM messages WHERE deleted = 1 ORDER BY timestamp DESC LIMIT 100',
      args: [],
    })).rows;
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/messages/:id/restore', auth, async (req, res) => {
  if (req.user.role !== 'supreme') return res.status(403).json({ error: 'Forbidden.' });
  try {
    await db.execute({ sql: 'UPDATE messages SET deleted = 0 WHERE id = ?', args: [req.params.id] });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

// ─── Supreme: user message history ───────────────────────────────────────────

app.get('/api/admin/users/:username/messages', auth, async (req, res) => {
  if (req.user.role !== 'supreme') return res.status(403).json({ error: 'Forbidden.' });
  try {
    const rows = (await db.execute({
      sql: 'SELECT id, channel, content, type, timestamp, deleted FROM messages WHERE author = ? ORDER BY timestamp DESC LIMIT 50',
      args: [req.params.username],
    })).rows;
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

// ─── Supreme: mass unban ──────────────────────────────────────────────────────

app.post('/api/admin/mass-unban', auth, async (req, res) => {
  if (req.user.role !== 'supreme') return res.status(403).json({ error: 'Forbidden.' });
  try {
    await db.execute({ sql: 'UPDATE users SET banned = 0, banned_until = NULL WHERE banned = 1', args: [] });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

// ─── Supreme: mass unmute ─────────────────────────────────────────────────────

app.post('/api/admin/mass-unmute', auth, async (req, res) => {
  if (req.user.role !== 'supreme') return res.status(403).json({ error: 'Forbidden.' });
  try {
    await db.execute({ sql: 'UPDATE users SET muted = 0, muted_until = NULL WHERE muted = 1', args: [] });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

// ─── Supreme: purge old messages ─────────────────────────────────────────────

app.post('/api/admin/purge', auth, async (req, res) => {
  if (req.user.role !== 'supreme') return res.status(403).json({ error: 'Forbidden.' });
  try {
    const { days, channel } = req.body ?? {};
    if (!days || isNaN(Number(days))) return res.status(400).json({ error: 'Days required.' });
    const cutoff = new Date(Date.now() - Number(days) * 86400000).toISOString();
    const ch = channel === 'staff' ? 'staff' : 'general';
    await db.execute({
      sql: 'UPDATE messages SET deleted = 1 WHERE channel = ? AND timestamp < ? AND deleted = 0',
      args: [ch, cutoff],
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

// ─── Supreme: broadcast system message ───────────────────────────────────────

app.post('/api/admin/broadcast', auth, async (req, res) => {
  if (req.user.role !== 'supreme') return res.status(403).json({ error: 'Forbidden.' });
  try {
    const { text, channel } = req.body ?? {};
    if (!text) return res.status(400).json({ error: 'Text required.' });
    const ch = channel === 'staff' ? 'staff' : 'general';
    const id = uid();
    await db.execute({
      sql: 'INSERT INTO messages (id, channel, author, content, type, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
      args: [id, ch, '[SYSTEM]', text, 'system', new Date().toISOString()],
    });
    res.json({ id });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

// ─── Supreme: report management ──────────────────────────────────────────────

app.delete('/api/admin/reports', auth, async (req, res) => {
  if (req.user.role !== 'supreme') return res.status(403).json({ error: 'Forbidden.' });
  try {
    await db.execute({ sql: "DELETE FROM reports WHERE status = 'dismissed'", args: [] });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/admin/reports/dismiss-all', auth, async (req, res) => {
  if (req.user.role !== 'supreme') return res.status(403).json({ error: 'Forbidden.' });
  try {
    await db.execute({ sql: "UPDATE reports SET status = 'dismissed' WHERE status = 'pending'", args: [] });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

// ─── Supreme: clear all announcements ────────────────────────────────────────

app.delete('/api/admin/announcements', auth, async (req, res) => {
  if (req.user.role !== 'supreme') return res.status(403).json({ error: 'Forbidden.' });
  try {
    await db.execute({ sql: 'DELETE FROM announcements', args: [] });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

/// ─── Media upload (Cloudinary) ───────────────────────────────────────────────

app.post('/api/upload', auth, async (req, res) => {
  try {
    const { data, type } = req.body ?? {}; // data = base64 data URI, type = 'image'|'video'
    if (!data) return res.status(400).json({ error: 'No file data.' });

    const resourceType = type === 'video' ? 'video' : 'image';
    const result = await cloudinary.uploader.upload(data, {
      resource_type: resourceType,
      folder: 'neuron',
    });
    res.json({ url: result.secure_url, resourceType });
  } catch (e) {
    console.error('Cloudinary upload error:', e.message);
    res.status(500).json({ error: 'Upload failed.' });
  }
});

// ─── Public: MOTD ─────────────────────────────────────────────────────────────

app.get('/api/motd', async (req, res) => {
  try {
    const s = await getSettings();
    res.json({ motd: s.motd || '' });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

// ─── Supreme: clear all staff messages ───────────────────────────────────────

app.post('/api/admin/clear-staff', auth, async (req, res) => {
  try {
    if (req.user.role !== 'supreme') return res.status(403).json({ error: 'Forbidden.' });
    await db.execute({ sql: "UPDATE messages SET deleted = 1 WHERE channel = 'staff'", args: [] });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error.' }); }
});

// ═══════════════════════════════════════════════════════ VOICE / WEBSOCKET ═════

// Default voice rooms. Staff room requires admin+.
const VOICE_ROOMS = [
  { id: 'lounge',  name: 'Lounge',  emoji: '🎮', staffOnly: false },
  { id: 'chill',   name: 'Chill',   emoji: '🎵', staffOnly: false },
  { id: 'gaming',  name: 'Gaming',  emoji: '🕹️', staffOnly: false },
  { id: 'staff',   name: 'Staff',   emoji: '🛡️', staffOnly: true  },
];

// roomId → Map<username, ws>
const _voiceRooms = new Map(VOICE_ROOMS.map(r => [r.id, new Map()]));

// ws → { username, role, roomId }
const _wsClients = new Map();

function broadcastRoomState(roomId) {
  const room = _voiceRooms.get(roomId);
  if (!room) return;
  const members = [...room.keys()];
  const payload = JSON.stringify({ type: 'voice-room-state', roomId, members });
  for (const ws of room.values()) {
    if (ws.readyState === 1) ws.send(payload);
  }
  // Also tell everyone else (outside the room) so their UI updates
  for (const [ws, info] of _wsClients) {
    if (!room.has(info.username) && ws.readyState === 1) ws.send(payload);
  }
}

function broadcastAllRooms(ws) {
  // Send current state of every room to a newly connected client
  for (const [roomId, room] of _voiceRooms) {
    ws.send(JSON.stringify({ type: 'voice-room-state', roomId, members: [...room.keys()] }));
  }
}

function leaveCurrentRoom(username) {
  for (const [roomId, room] of _voiceRooms) {
    if (room.has(username)) {
      room.delete(username);
      // Tell remaining room members this user left
      const leftMsg = JSON.stringify({ type: 'voice-user-left', roomId, username });
      for (const ws of room.values()) {
        if (ws.readyState === 1) ws.send(leftMsg);
      }
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
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const info = _wsClients.get(ws);

    // ── Auth ──────────────────────────────────────────────────────────────────
    if (msg.type === 'auth') {
      try {
        const decoded = jwt.verify(msg.token, JWT_SECRET);
        info.username = decoded.username;
        info.role     = decoded.role;
        broadcastAllRooms(ws);
      } catch { ws.send(JSON.stringify({ type: 'error', message: 'Invalid token.' })); }
      return;
    }

    if (!info.username) return; // must auth first

    // ── Keepalive ─────────────────────────────────────────────────────────────
    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }

    // ── Join voice room ───────────────────────────────────────────────────────
    if (msg.type === 'join-voice') {
      const { roomId } = msg;
      const roomDef = VOICE_ROOMS.find(r => r.id === roomId);
      if (!roomDef) return;
      if (roomDef.staffOnly && !['admin','owner','supreme'].includes(info.role)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Staff-only voice room.' }));
        return;
      }

      leaveCurrentRoom(info.username); // leave any existing room first

      const room = _voiceRooms.get(roomId);
      const existingMembers = [...room.keys()];

      room.set(info.username, ws);
      info.roomId = roomId;

      // Tell the joiner who is already in the room (they must send offers to each)
      ws.send(JSON.stringify({ type: 'voice-joined', roomId, members: existingMembers }));

      // Tell existing members someone joined (they will receive offers from the joiner)
      const joinMsg = JSON.stringify({ type: 'voice-user-joined', roomId, username: info.username });
      for (const memberWs of room.values()) {
        if (memberWs !== ws && memberWs.readyState === 1) memberWs.send(joinMsg);
      }

      broadcastRoomState(roomId);
      return;
    }

    // ── Leave voice room ──────────────────────────────────────────────────────
    if (msg.type === 'leave-voice') {
      leaveCurrentRoom(info.username);
      info.roomId = null;
      ws.send(JSON.stringify({ type: 'voice-left' }));
      return;
    }

    // ── WebRTC signaling: relay to target peer ────────────────────────────────
    if (msg.type === 'voice-offer' || msg.type === 'voice-answer' || msg.type === 'voice-ice') {
      const { to } = msg;
      for (const [client, cinfo] of _wsClients) {
        if (cinfo.username === to && client.readyState === 1) {
          client.send(JSON.stringify({ ...msg, from: info.username }));
          break;
        }
      }
      return;
    }

    // ── Speaking indicator ────────────────────────────────────────────────────
    if (msg.type === 'voice-speaking') {
      const room = info.roomId ? _voiceRooms.get(info.roomId) : null;
      if (!room) return;
      const relay = JSON.stringify({ type: 'voice-speaking', username: info.username, speaking: !!msg.speaking });
      for (const [mUsername, mws] of room) {
        if (mUsername !== info.username && mws.readyState === 1) mws.send(relay);
      }
      return;
    }

    // ── Private call signaling (relay to target user(s)) ─────────────────────
    if (['call-invite','call-accept','call-reject','call-end',
         'call-offer','call-answer','call-ice'].includes(msg.type)) {
      const targets = Array.isArray(msg.to) ? msg.to : [msg.to];
      const relayed = JSON.stringify({ ...msg, from: info.username });
      for (const target of targets) {
        for (const [client, cinfo] of _wsClients) {
          if (cinfo.username === target && client.readyState === 1) {
            client.send(relayed);
            break;
          }
        }
      }
      return;
    }
  });

  ws.on('close', () => {
    const info = _wsClients.get(ws);
    if (info?.username) leaveCurrentRoom(info.username);
    _wsClients.delete(ws);
  });
});

// REST: get voice room list + member counts (for initial page load before WS connects)
app.get('/api/voice/rooms', auth, (req, res) => {
  const result = VOICE_ROOMS
    .filter(r => !r.staffOnly || ['admin','owner','supreme'].includes(req.user.role))
    .map(r => ({
      id:      r.id,
      name:    r.name,
      emoji:   r.emoji,
      members: [...(_voiceRooms.get(r.id)?.keys() ?? [])],
    }));
  res.json(result);
});

// ═══════════════════════════════════════════════════════════════ BOOT ══════════

async function start() {
  await initSchema();
  await seedAccounts();
  httpServer.listen(PORT, () => console.log(`Neuron → http://localhost:${PORT}`));
}

start().catch(e => { console.error('Failed to start:', e); process.exit(1); });
