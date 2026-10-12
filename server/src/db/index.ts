import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import { createDriver, type SqlDriver } from './driver';

const SCHEMA_VERSION = 3;

let dbPromise: Promise<SqlDriver> | null = null;

/** 获取数据库连接（懒初始化 + 单例）。 */
export async function getDb(): Promise<SqlDriver> {
  if (!dbPromise) {
    dbPromise = (async () => {
      fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
      const db = await createDriver(config.dbPath);
      migrate(db);
      return db;
    })();
  }
  return dbPromise;
}

export async function closeDb(): Promise<void> {
  if (!dbPromise) return;
  const db = await dbPromise;
  db.close();
  dbPromise = null;
}

/** 某张表是否存在（SQLite 用 sqlite_master 查）。 */
function tableExists(db: SqlDriver, name: string): boolean {
  const row = db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?",
    [name],
  );
  return Number(row?.n ?? 0) > 0;
}

/** 某个字段是否存在（用于给已有表补列，SQLite 没有 ADD COLUMN IF NOT EXISTS）。 */
function columnExists(db: SqlDriver, table: string, column: string): boolean {
  const rows = db.all<{ name: string }>(`PRAGMA table_info(${table})`);
  return rows.some((r) => r.name === column);
}

/**
 * 迁移到最新结构。
 * 只负责「结构」，不负责「数据归属」——把历史数据挂到引导管理员名下这一步
 * 需要先知道管理员 id，因此放在 bootstrap 里做（见 server/src/bootstrap.ts）。
 */
function migrate(db: SqlDriver): void {
  const row = db.get<{ user_version: number }>('PRAGMA user_version');
  const current = Number(row?.user_version ?? 0);
  if (current >= SCHEMA_VERSION) return;

  // ── v1：日程表 + 幂等键表 ─────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id            TEXT PRIMARY KEY,
      title         TEXT NOT NULL,
      description   TEXT,
      location      TEXT,
      start_utc     TEXT NOT NULL,
      end_utc       TEXT NOT NULL,
      all_day       INTEGER NOT NULL DEFAULT 0,
      timezone      TEXT NOT NULL DEFAULT 'Asia/Shanghai',
      color         TEXT,
      calendar_id   TEXT NOT NULL DEFAULT 'default',
      rrule         TEXT,
      exdates       TEXT,
      version       INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_events_start    ON events(start_utc);
    CREATE INDEX IF NOT EXISTS idx_events_end      ON events(end_utc);
    CREATE INDEX IF NOT EXISTS idx_events_calendar ON events(calendar_id);

    -- 幂等键表：AI Agent 重试写操作时用它避免重复创建
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key         TEXT PRIMARY KEY,
      event_id    TEXT NOT NULL,
      response    TEXT NOT NULL,
      created_at  TEXT NOT NULL
    );
  `);

  // ── v2：界面设置表（键值存储；键名形如 ui.<userId>.<field>） ──
  if (current < 2 && !tableExists(db, 'settings')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key         TEXT PRIMARY KEY,
        value       TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
    `);
  }

  // ── v3：多用户 + API 令牌 + 日历分组 + 回收站 ──────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id             TEXT PRIMARY KEY,
      username       TEXT NOT NULL,
      display_name   TEXT NOT NULL,
      password_hash  TEXT NOT NULL,
      role           TEXT NOT NULL DEFAULT 'member',
      disabled       INTEGER NOT NULL DEFAULT 0,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username COLLATE NOCASE);

    -- 浏览器会话：只存令牌的 SHA-256，库被读走也无法直接冒用
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash  TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      expires_at  TEXT NOT NULL,
      user_agent  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    -- 给 AI Agent 用的长期令牌
    CREATE TABLE IF NOT EXISTS api_tokens (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL,
      name          TEXT NOT NULL,
      token_hash    TEXT NOT NULL UNIQUE,
      prefix        TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      last_used_at  TEXT,
      expires_at    TEXT,
      revoked_at    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tokens_user ON api_tokens(user_id);

    -- 日历分组：当前归属单个用户，彼此不可见
    CREATE TABLE IF NOT EXISTS calendars (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      name        TEXT NOT NULL,
      color       TEXT,
      visible     INTEGER NOT NULL DEFAULT 1,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      is_default  INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_calendars_user ON calendars(user_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_calendars_default
      ON calendars(user_id) WHERE is_default = 1;
  `);

  // events 补列：归属用户 + 软删除时间
  if (!columnExists(db, 'events', 'user_id')) {
    db.exec(`ALTER TABLE events ADD COLUMN user_id TEXT`);
  }
  if (!columnExists(db, 'events', 'deleted_at')) {
    db.exec(`ALTER TABLE events ADD COLUMN deleted_at TEXT`);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_events_user          ON events(user_id);
    CREATE INDEX IF NOT EXISTS idx_events_user_start    ON events(user_id, start_utc);
    CREATE INDEX IF NOT EXISTS idx_events_deleted       ON events(user_id, deleted_at);
  `);

  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}
