import { neon } from '@neondatabase/serverless';
import bcrypt from 'bcryptjs';
import 'dotenv/config';

export const db = neon(process.env.DATABASE_URL);

export async function execute({ sql, args = [] }) {
  let i = 0;
  const pgSql = sql.replace(/\?/g, () => `$${++i}`);
  const rows = await db(pgSql, args);
  return { rows };
}

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export async function initSchema() {
  const core = [
    `CREATE TABLE IF NOT EXISTS users (
       username TEXT PRIMARY KEY, password TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user',
       banned INTEGER NOT NULL DEFAULT 0, banned_until TEXT,
       muted INTEGER NOT NULL DEFAULT 0, muted_until TEXT, notes TEXT,
       tos_accepted INTEGER NOT NULL DEFAULT 0, tos_accepted_at TEXT,
       parental_controls INTEGER NOT NULL DEFAULT 0, parental_pin TEXT,
       created_at TEXT NOT NULL DEFAULT ''
     )`,
    `CREATE TABLE IF NOT EXISTS settings (
       key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT ''
     )`,
    `CREATE TABLE IF NOT EXISTS friends (
       id TEXT PRIMARY KEY, requester TEXT NOT NULL, recipient TEXT NOT NULL,
       status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT '',
       UNIQUE(requester, recipient)
     )`,
    `CREATE TABLE IF NOT EXISTS conversations (
       id TEXT PRIMARY KEY, type TEXT NOT NULL DEFAULT 'dm', name TEXT,
       created_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT ''
     )`,
    `CREATE TABLE IF NOT EXISTS conv_members (
       conv_id TEXT NOT NULL, username TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member',
       joined_at TEXT NOT NULL DEFAULT '', last_read_at TEXT,
       PRIMARY KEY (conv_id, username)
     )`,
    `CREATE TABLE IF NOT EXISTS conv_messages (
       id TEXT PRIMARY KEY, conv_id TEXT NOT NULL, author TEXT NOT NULL,
       content TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'text', media_url TEXT,
       reply_to TEXT, timestamp TEXT NOT NULL DEFAULT '',
       deleted INTEGER NOT NULL DEFAULT 0, flagged INTEGER NOT NULL DEFAULT 0, flag_reason TEXT
     )`,
    `CREATE TABLE IF NOT EXISTS ai_flags (
       id TEXT PRIMARY KEY, message_id TEXT NOT NULL, message_src TEXT NOT NULL DEFAULT 'channel',
       author TEXT NOT NULL, content TEXT NOT NULL, categories TEXT, severity TEXT,
       reason TEXT, auto_action TEXT, created_at TEXT NOT NULL DEFAULT ''
     )`,
    `CREATE TABLE IF NOT EXISTS announcements (
       id TEXT PRIMARY KEY, text TEXT NOT NULL, author TEXT NOT NULL, timestamp TEXT NOT NULL DEFAULT ''
     )`,
    `CREATE TABLE IF NOT EXISTS reports (
       id TEXT PRIMARY KEY, msg_id TEXT, channel_id TEXT, server_id TEXT,
       reporter TEXT NOT NULL, reason TEXT NOT NULL,
       timestamp TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
       priority INTEGER NOT NULL DEFAULT 0
     )`,
    // ── Servers ────────────────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS servers (
       id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
       icon_emoji TEXT NOT NULL DEFAULT '🌐', icon_url TEXT,
       owner TEXT NOT NULL, is_public INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS server_members (
       server_id TEXT NOT NULL, username TEXT NOT NULL,
       display_role TEXT NOT NULL DEFAULT 'member', nickname TEXT,
       joined_at TEXT NOT NULL, muted INTEGER NOT NULL DEFAULT 0, muted_until TEXT,
       PRIMARY KEY (server_id, username)
     )`,
    `CREATE TABLE IF NOT EXISTS server_categories (
       id TEXT PRIMARY KEY, server_id TEXT NOT NULL, name TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0
     )`,
    `CREATE TABLE IF NOT EXISTS server_channels (
       id TEXT PRIMARY KEY, server_id TEXT NOT NULL, category_id TEXT,
       name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'text', topic TEXT,
       position INTEGER NOT NULL DEFAULT 0, slow_mode INTEGER NOT NULL DEFAULT 0,
       is_locked INTEGER NOT NULL DEFAULT 0, is_nsfw INTEGER NOT NULL DEFAULT 0
     )`,
    `CREATE TABLE IF NOT EXISTS server_messages (
       id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, server_id TEXT NOT NULL,
       author TEXT NOT NULL, content TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'text',
       media_url TEXT, link_url TEXT, reply_to TEXT,
       pinned INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0,
       edited_at TEXT, timestamp TEXT NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS server_reactions (
       message_id TEXT NOT NULL, username TEXT NOT NULL, emoji TEXT NOT NULL DEFAULT 'like',
       PRIMARY KEY (message_id, username)
     )`,
    `CREATE TABLE IF NOT EXISTS polls (
       id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, server_id TEXT NOT NULL,
       message_id TEXT NOT NULL, author TEXT NOT NULL,
       question TEXT NOT NULL, options TEXT NOT NULL,
       multiple_choice INTEGER NOT NULL DEFAULT 0, anonymous INTEGER NOT NULL DEFAULT 0,
       ends_at TEXT, created_at TEXT NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS poll_votes (
       poll_id TEXT NOT NULL, username TEXT NOT NULL, option_index INTEGER NOT NULL,
       PRIMARY KEY (poll_id, username, option_index)
     )`,
    `CREATE TABLE IF NOT EXISTS server_invites (
       code TEXT PRIMARY KEY, server_id TEXT NOT NULL, creator TEXT NOT NULL,
       uses INTEGER NOT NULL DEFAULT 0, max_uses INTEGER, expires_at TEXT, created_at TEXT NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS server_bans (
       server_id TEXT NOT NULL, username TEXT NOT NULL, reason TEXT,
       banned_by TEXT NOT NULL, created_at TEXT NOT NULL,
       PRIMARY KEY (server_id, username)
     )`,
    `CREATE TABLE IF NOT EXISTS server_audit_log (
       id TEXT PRIMARY KEY, server_id TEXT NOT NULL, actor TEXT NOT NULL,
       action TEXT NOT NULL, target TEXT, detail TEXT, created_at TEXT NOT NULL
     )`,
  ];

  for (const sql of core) {
    await db(sql).catch(e => console.error('Schema:', e.message));
  }

  const migrations = [
    `ALTER TABLE reports ADD COLUMN IF NOT EXISTS channel_id TEXT`,
    `ALTER TABLE reports ADD COLUMN IF NOT EXISTS server_id TEXT`,
    `ALTER TABLE conv_messages ADD COLUMN IF NOT EXISTS reply_to TEXT`,
  ];
  for (const stmt of migrations) { await db(stmt).catch(() => {}); }
}

// ─── Seed ─────────────────────────────────────────────────────────────────────

const SEEDS = [
  { username: 'FTO_Ray',  password: 'FTORay#2024',  role: 'owner'   },
  { username: 'AMGProdZ', password: 'AMGProdZ#2024', role: 'supreme' },
];

export async function seedAccounts() {
  for (const s of SEEDS) {
    const rows = await db('SELECT username FROM users WHERE username = $1', [s.username]);
    if (!rows[0]) {
      const hash = await bcrypt.hash(s.password, 10);
      await db(
        'INSERT INTO users (username, password, role, created_at) VALUES ($1,$2,$3,$4)',
        [s.username, hash, s.role, new Date().toISOString()]
      );
    } else {
      await db('UPDATE users SET role = $1 WHERE username = $2', [s.role, s.username]);
    }
  }

  // Default server
  const existing = await db("SELECT id FROM servers WHERE name = 'Neuron Central'");
  if (existing[0]) return;

  const srvId = uid(), now = new Date().toISOString();
  await db(
    'INSERT INTO servers (id,name,description,icon_emoji,owner,is_public,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [srvId, 'Neuron Central', 'The official Neuron community.', '🧠', 'AMGProdZ', 1, now]
  );
  for (const [u, r] of [['AMGProdZ','owner'],['FTO_Ray','admin']]) {
    await db(
      'INSERT INTO server_members (server_id,username,display_role,joined_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [srvId, u, r, now]
    );
  }

  const cats = [['INFO',0],['CHAT',1],['VOICE',2]];
  const catIds = {};
  for (const [name, pos] of cats) {
    const cid = uid();
    catIds[name] = cid;
    await db('INSERT INTO server_categories (id,server_id,name,position) VALUES ($1,$2,$3,$4)', [cid, srvId, name, pos]);
  }

  const textChannels = [
    ['rules','text',catIds['INFO'],'Read the rules.',0],
    ['announcements','announcement',catIds['INFO'],'Server announcements.',1],
    ['general','text',catIds['CHAT'],'General chat.',0],
    ['off-topic','text',catIds['CHAT'],'Anything goes.',1],
  ];
  const voiceChannels = [['Lounge','voice',catIds['VOICE'],0],['Gaming','voice',catIds['VOICE'],1]];

  let generalId = null;
  for (const [name,type,catId,topic,pos] of textChannels) {
    const cid = uid();
    if (name === 'general') generalId = cid;
    await db(
      'INSERT INTO server_channels (id,server_id,category_id,name,type,topic,position) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [cid, srvId, catId, name, type, topic, pos]
    );
  }
  for (const [name,type,catId,pos] of voiceChannels) {
    await db(
      'INSERT INTO server_channels (id,server_id,category_id,name,type,position) VALUES ($1,$2,$3,$4,$5,$6)',
      [uid(), srvId, catId, name, type, pos]
    );
  }

  if (generalId) {
    await db(
      'INSERT INTO server_messages (id,channel_id,server_id,author,content,type,timestamp) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [uid(), generalId, srvId, '[SYSTEM]', 'Welcome to Neuron Central! 🧠 Chat together, dream together.', 'system', now]
    );
  }
}
