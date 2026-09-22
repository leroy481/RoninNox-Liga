import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.env.DATA_DIR || './data');
fs.mkdirSync(dir,{recursive:true});
export const db = new Database(path.join(dir,'ronin-nox.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 ic_name TEXT NOT NULL UNIQUE COLLATE NOCASE,
 password_hash TEXT NOT NULL,
 discord_id TEXT UNIQUE,
 discord_name TEXT,
 role TEXT NOT NULL DEFAULT 'DRIVER' CHECK(role IN ('DRIVER','OWNER')),
 status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','BLOCKED')),
 total_points REAL NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
 token TEXT PRIMARY KEY,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS seasons (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 start_at TEXT,
 end_at TEXT,
 status TEXT NOT NULL DEFAULT 'PLANNED' CHECK(status IN ('PLANNED','ACTIVE','COMPLETED')),
 winner_user_id INTEGER REFERENCES users(id),
 reward TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS races (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 scheduled_at TEXT NOT NULL,
 start_point TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'PLANNED' CHECK(status IN ('PLANNED','ACTIVE','COMPLETED','CANCELLED')),
 season_id INTEGER REFERENCES seasons(id),
 started_at TEXT,
 ended_at TEXT,
 created_by INTEGER NOT NULL REFERENCES users(id),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS checkpoints (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 race_id INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
 seq INTEGER NOT NULL,
 name TEXT NOT NULL,
 operator_user_id INTEGER REFERENCES users(id),
 UNIQUE(race_id,seq)
);
CREATE TABLE IF NOT EXISTS participants (
 race_id INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(race_id,user_id)
);
CREATE TABLE IF NOT EXISTS checkpoint_passes (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 race_id INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
 checkpoint_id INTEGER NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 confirmed_at TEXT NOT NULL,
 confirmed_by INTEGER REFERENCES users(id),
 confirmation_type TEXT NOT NULL CHECK(confirmation_type IN ('OPERATOR','SELF')),
 status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPROVED','REJECTED','CORRECTED')),
 points_awarded REAL NOT NULL DEFAULT 0,
 original_pass_id INTEGER REFERENCES checkpoint_passes(id)
);
CREATE TABLE IF NOT EXISTS goals (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 race_id INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 finished_at TEXT NOT NULL,
 confirmed_by INTEGER REFERENCES users(id),
 confirmation_type TEXT NOT NULL CHECK(confirmation_type IN ('OPERATOR','SELF')),
 placement INTEGER,
 points_awarded REAL NOT NULL DEFAULT 0,
 UNIQUE(race_id,user_id)
);
CREATE TABLE IF NOT EXISTS point_changes (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL REFERENCES users(id),
 amount REAL NOT NULL,
 reason TEXT NOT NULL,
 owner_id INTEGER REFERENCES users(id),
 source TEXT NOT NULL DEFAULT 'MANUAL',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sanctions (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL REFERENCES users(id),
 type TEXT NOT NULL CHECK(type IN ('POINTS','MONEY')),
 amount REAL NOT NULL,
 reason TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','LIFTED')),
 starts_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 ends_at TEXT,
 season_id INTEGER REFERENCES seasons(id),
 created_by INTEGER NOT NULL REFERENCES users(id),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS audit_logs (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 actor_user_id INTEGER REFERENCES users(id),
 action TEXT NOT NULL,
 entity_type TEXT NOT NULL,
 entity_id TEXT,
 details_json TEXT NOT NULL DEFAULT '{}',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_cp_passes_race_cp ON checkpoint_passes(race_id,checkpoint_id,confirmed_at);
CREATE INDEX IF NOT EXISTS idx_goals_race ON goals(race_id,finished_at);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
`);
