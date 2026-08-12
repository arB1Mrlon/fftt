const Database = require('better-sqlite3');
require('dotenv').config();

const db = new Database(process.env.DB_PATH || './data.sqlite');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  telegram_id INTEGER PRIMARY KEY,
  mc_nickname TEXT NOT NULL,
  balance INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER NOT NULL,
  mc_nickname TEXT NOT NULL,
  amount INTEGER NOT NULL,
  spheres_count INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | processing | done | failed
  error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER NOT NULL,
  mc_nickname TEXT NOT NULL,
  amount INTEGER NOT NULL,
  expected_price INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | processing | done | failed
  error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS captcha_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL DEFAULT 'waiting', -- waiting | answered
  answer TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

module.exports = db;
