import { neon } from '@neondatabase/serverless';
import bcrypt from 'bcryptjs';
import 'dotenv/config';

// ─── Neon client ──────────────────────────────────────────────────────────────
export const db = neon(process.env.DATABASE_URL);

// Thin wrapper so server.js can keep using { sql, args } style with ? placeholders.
// Converts ? → $1 $2 ... and wraps result in { rows } to match existing code.
export async function execute({ sql, args = [] }) {
  let i = 0;
  const pgSql = sql.replace(/\?/g, () => `$${++i}`);
  const rows = await db(pgSql, args);
  return { rows };
}

// ─── Schema ───────────────────────────────────────────────────────────────────
export async function initSchema() {
  const stmts = [
    // Users
    `CREATE TABLE IF NOT EXISTS users (
       username     TEXT PRIMARY KEY,
       password     TEXT NOT NULL,
       role         TEXT NOT NULL DEFAULT 'user',
       banned       INTEGER NOT NULL DEFAULT 0,
       banned_until TEXT,
       created_at   TEXT NOT NULL DEFAULT ''
     )`,

    // Messages (general + staff channels)
    `CREATE TABLE IF NOT EXISTS messages (
       id        TEXT PRIMARY KEY,
       channel   TEXT NOT NULL DEFAULT 'general',
       author    TEXT NOT NULL,
       content   TEXT NOT NULL,
       type      TEXT NOT NULL DEFAULT 'text',
       media_url TEXT,
       link_url  TEXT,
       timestamp TEXT NOT NULL DEFAULT '',
       reply_to  TEXT,
       pinned    INTEGER NOT NULL DEFAULT 0,
       deleted   INTEGER NOT NULL DEFAULT 0
     )`,

    // One reaction-type per user per message
    `CREATE TABLE IF NOT EXISTS reactions (
       message_id TEXT NOT NULL,
       username   TEXT NOT NULL,
       type       TEXT NOT NULL,
       PRIMARY KEY (message_id, username)
     )`,

    // Announcements
    `CREATE TABLE IF NOT EXISTS announcements (
       id        TEXT PRIMARY KEY,
       text      TEXT NOT NULL,
       author    TEXT NOT NULL,
       timestamp TEXT NOT NULL DEFAULT ''
     )`,

    // Reports
    `CREATE TABLE IF NOT EXISTS reports (
       id        TEXT PRIMARY KEY,
       msg_id    TEXT,
       reporter  TEXT NOT NULL,
       reason    TEXT NOT NULL,
       timestamp TEXT NOT NULL DEFAULT '',
       status    TEXT NOT NULL DEFAULT 'pending',
       priority  INTEGER NOT NULL DEFAULT 0
     )`,
  ];

  for (const sql of stmts) {
    await db(sql);
  }

  // Migrations — safe to run repeatedly
  const migrations = [
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS muted       INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS muted_until TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS notes       TEXT`,
    `CREATE TABLE IF NOT EXISTS settings (
       key        TEXT PRIMARY KEY,
       value      TEXT NOT NULL DEFAULT '',
       updated_at TEXT NOT NULL DEFAULT ''
     )`,
  ];
  for (const stmt of migrations) {
    await db(stmt).catch(() => {});
  }

  const newMigrations = [
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS tos_accepted     INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS tos_accepted_at  TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS parental_controls INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS parental_pin     TEXT`,
    `CREATE TABLE IF NOT EXISTS friends (
       id          TEXT PRIMARY KEY,
       requester   TEXT NOT NULL,
       recipient   TEXT NOT NULL,
       status      TEXT NOT NULL DEFAULT 'pending',
       created_at  TEXT NOT NULL DEFAULT '',
       UNIQUE(requester, recipient)
     )`,
    `CREATE TABLE IF NOT EXISTS conversations (
       id          TEXT PRIMARY KEY,
       type        TEXT NOT NULL DEFAULT 'dm',
       name        TEXT,
       created_by  TEXT NOT NULL,
       created_at  TEXT NOT NULL DEFAULT ''
     )`,
    `CREATE TABLE IF NOT EXISTS conv_members (
       conv_id     TEXT NOT NULL,
       username    TEXT NOT NULL,
       role        TEXT NOT NULL DEFAULT 'member',
       joined_at   TEXT NOT NULL DEFAULT '',
       last_read_at TEXT,
       PRIMARY KEY (conv_id, username)
     )`,
    `CREATE TABLE IF NOT EXISTS conv_messages (
       id          TEXT PRIMARY KEY,
       conv_id     TEXT NOT NULL,
       author      TEXT NOT NULL,
       content     TEXT NOT NULL,
       type        TEXT NOT NULL DEFAULT 'text',
       media_url   TEXT,
       timestamp   TEXT NOT NULL DEFAULT '',
       deleted     INTEGER NOT NULL DEFAULT 0,
       flagged     INTEGER NOT NULL DEFAULT 0,
       flag_reason TEXT
     )`,
    `CREATE TABLE IF NOT EXISTS ai_flags (
       id          TEXT PRIMARY KEY,
       message_id  TEXT NOT NULL,
       message_src TEXT NOT NULL DEFAULT 'channel',
       author      TEXT NOT NULL,
       content     TEXT NOT NULL,
       categories  TEXT,
       severity    TEXT,
       reason      TEXT,
       auto_action TEXT,
       created_at  TEXT NOT NULL DEFAULT ''
     )`,
  ];
  for (const stmt of newMigrations) {
    await db(stmt).catch(() => {});
  }

  const latestMigrations = [
    `ALTER TABLE conv_messages ADD COLUMN IF NOT EXISTS reply_to TEXT`,
  ];
  for (const stmt of latestMigrations) {
    await db(stmt).catch(() => {});
  }
}

// ─── Seed accounts ────────────────────────────────────────────────────────────
const SEEDS = [
  { username: 'FTO_Ray',  password: 'FTORay#2024',   role: 'owner'   },
  { username: 'AMGProdZ', password: 'AMGProdZ#2024', role: 'supreme' },
];

export async function seedAccounts() {
  for (const s of SEEDS) {
    const rows = await db(
      'SELECT username FROM users WHERE username = $1',
      [s.username]
    );

    if (!rows[0]) {
      const hash = await bcrypt.hash(s.password, 10);
      await db(
        'INSERT INTO users (username, password, role, created_at) VALUES ($1, $2, $3, $4)',
        [s.username, hash, s.role, new Date().toISOString()]
      );
    } else {
      // Always re-enforce the seeded role on startup
      await db(
        'UPDATE users SET role = $1 WHERE username = $2',
        [s.role, s.username]
      );
    }
  }
}
