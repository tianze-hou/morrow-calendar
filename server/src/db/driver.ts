/**
 * SQLite 驱动抽象层。
 *
 * 两种实现，按可用性自动挑选：
 *
 * 1. `better-sqlite3`（首选）—— 原生模块，但自带预编译二进制，Node 主流版本上
 *    `npm i` 不需要 C++ 工具链。性能好、事务开销低（实测 2000 条事务写入 ~8ms）。
 * 2. `node-sqlite3-wasm`（兜底）—— 纯 WASM，任何环境都能装，但写路径每次提交都要
 *    走 journal + 多次 fsync，写入量大时慢一到两个数量级，且长时间连续写入后
 *    偶发抛 `disk I/O error`。**只应作为装不上原生模块时的应急方案。**
 *
 * 两者都只依赖 `SqlDriver` 这一个小接口，因此仓储层与路由层完全不感知用的是哪个。
 * 想强制指定：`DB_DRIVER=better-sqlite3`（装不上就直接报错）或 `DB_DRIVER=wasm`。
 */

import { createRequire } from 'node:module';

export type SqlParams = unknown[] | Record<string, unknown>;

export interface SqlDriver {
  readonly name: string;
  exec(sql: string): void;
  run(sql: string, params?: SqlParams): { changes: number };
  all<T = Record<string, unknown>>(sql: string, params?: SqlParams): T[];
  get<T = Record<string, unknown>>(sql: string, params?: SqlParams): T | undefined;
  transaction<T>(fn: () => T): T;
  close(): void;
}

/** 当前实例实际用上的驱动名，供启动横幅与 /api/health 显示。 */
export let chosenDriver = 'unknown';

/** 优先 better-sqlite3（原生、更快）；不可用时回退 WASM。 */
export async function createDriver(filename: string): Promise<SqlDriver> {
  if (process.env.DB_DRIVER === 'wasm') {
    chosenDriver = 'node-sqlite3-wasm';
    return createWasmDriver(filename);
  }

  try {
    const spec = 'better-sqlite3';
    const mod = (await import(spec)) as { default: new (f: string) => BetterLike };
    const driver = createBetterDriver(new mod.default(filename));
    chosenDriver = driver.name;
    return driver;
  } catch (err) {
    if (process.env.DB_DRIVER === 'better-sqlite3') {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `指定了 DB_DRIVER=better-sqlite3，但加载失败：${reason}\n` +
          '请确认已执行 npm install better-sqlite3（预编译包下载失败时需要 Node 头文件与构建工具链）。',
      );
    }
    // eslint-disable-next-line no-console
    console.warn(
      '[db] 未能加载 better-sqlite3，回退到 node-sqlite3-wasm。' +
        '数据完全一致，但写入吞吐明显更低；建议执行 `npm install better-sqlite3`。',
    );
    chosenDriver = 'node-sqlite3-wasm';
    return createWasmDriver(filename);
  }
}

interface BetterLike {
  pragma(source: string, options?: { simple: boolean }): unknown;
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...args: unknown[]): { changes: number };
    all(...args: unknown[]): unknown[];
    get(...args: unknown[]): unknown;
  };
  close(): void;
}

function createBetterDriver(db: BetterLike): SqlDriver {
  try {
    db.pragma('journal_mode = WAL');
  } catch {
    /* 某些环境不支持 WAL，忽略 */
  }
  return {
    name: 'better-sqlite3',
    exec: (sql) => void db.exec(sql),
    run: (sql, params) => db.prepare(sql).run(...toArray(params)),
    all: <T,>(sql: string, params?: SqlParams) => db.prepare(sql).all(...toArray(params)) as T[],
    get: <T,>(sql: string, params?: SqlParams) => db.prepare(sql).get(...toArray(params)) as T | undefined,
    transaction: (fn) => {
      db.exec('BEGIN');
      try {
        const out = fn();
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    close: () => db.close(),
  };
}

function createWasmDriver(filename: string): SqlDriver {
  const require = createRequire(import.meta.url);
  const { Database } = require('node-sqlite3-wasm') as {
    Database: new (f: string) => WasmLike;
  };
  const db = new Database(filename);
  /*
   * 刻意用回滚日志（DELETE）而不是 WAL。
   * WAL 需要 -wal / -shm 两个辅助文件与共享内存语义，而 node-sqlite3-wasm 的 VFS
   * 在这套模式下长时间运行后会间歇性抛 "disk I/O error"（实测：连续写入数十次后触发）。
   * 本服务是单进程低并发，DELETE 模式完全够用，且只落一个 .db 文件，备份也更简单。
   */
  try {
    db.exec('PRAGMA journal_mode = DELETE');
  } catch {
    /* 某些构建可能不支持显式设置，忽略 */
  }
  return {
    name: 'node-sqlite3-wasm',
    exec: (sql) => db.exec(sql),
    run: (sql, params) => {
      const res = db.run(sql, bind(params));
      return { changes: Number(res.changes ?? 0) };
    },
    all: <T,>(sql: string, params?: SqlParams) => db.all(sql, bind(params)) as T[],
    get: <T,>(sql: string, params?: SqlParams) =>
      (db.get(sql, bind(params)) as T | null) ?? undefined,
    transaction: (fn) => {
      db.exec('BEGIN');
      try {
        const out = fn();
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    close: () => db.close(),
  };
}

interface WasmLike {
  exec(sql: string): void;
  run(sql: string, values?: unknown): { changes?: number };
  all(sql: string, values?: unknown): unknown[];
  get(sql: string, values?: unknown): unknown;
  close(): void;
}

function toArray(params?: SqlParams): unknown[] {
  if (!params) return [];
  return Array.isArray(params) ? params : [params];
}

/** WASM 驱动在无参数时要求传 undefined 而不是空数组。 */
function bind(params?: SqlParams): unknown[] | undefined {
  const arr = toArray(params);
  return arr.length ? arr : undefined;
}
