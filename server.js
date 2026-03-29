import 'dotenv/config';
import express from 'express';
import jwt      from 'jsonwebtoken';
import bcrypt   from 'bcryptjs';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname }       from 'path';
import { execute as dbExec, initSchema, seedAccounts } from './db.js';
const db = { execute: dbExec };

const __dirname  = dirname(fileURLToPath(import.meta.url));
const app        = express();
const PORT       = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'neuron-dev-secret-change-in-prod';
const RESERVED   = ['FTO_Ray', 'AMGProdZ'];

app.use(express.json({ limit: '15mb' })); // accommodates base64-encoded media
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
    res.json({ username: user.username, role: user.role });
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

    const id = uid();
    await db.execute({
      sql:  `INSERT INTO messages (id, channel, author, content, type, media_url, link_url, timestamp, reply_to)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, ch, req.user.username, content, type || 'text',
             mediaUrl || null, linkUrl || null, new Date().toISOString(), replyTo || null],
    });
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
      'SELECT username, role, banned, banned_until, created_at FROM users ORDER BY username'
    )).rows;
    res.json(rows.map(u => ({
      username:    u.username,
      role:        u.role,                   // actual role for admin panel logic
      displayRole: safeRole(u.role, vr),     // display role for the table
      banned:      !!u.banned,
      bannedUntil: u.banned_until,
      createdAt:   u.created_at,
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

// ═══════════════════════════════════════════════════════════════ BOOT ══════════

async function start() {
  await initSchema();
  await seedAccounts();
  app.listen(PORT, () => console.log(`Neuron → http://localhost:${PORT}`));
}

start().catch(e => { console.error('Failed to start:', e); process.exit(1); });
