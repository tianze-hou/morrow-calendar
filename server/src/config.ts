import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 向上查找 package.json 定位项目根。
 * 开发环境从 server/src 出发、打包后从 dist-server 出发都能命中，
 * 不依赖「相对几层」这种会随产物位置改变的算法。
 */
export const projectRoot = (() => {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
})();

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === '1' || value.toLowerCase() === 'true';
}

export interface AppConfig {
  port: number;
  /** SQLite 文件路径。默认 ./data/calendar.db */
  dbPath: string;
  /** 服务端默认时区；AI 未显式指定时使用。 */
  timezone: string;
  limits: {
    maxBatchSize: number;
    defaultLimit: number;
    maxLimit: number;
    maxTitleLength: number;
    /** 每个用户最多能有几个日历分组 */
    maxCalendars: number;
    /** 每个用户最多能有几个有效 API 令牌 */
    maxTokens: number;
  };
  auth: {
    /** 是否强制鉴权。本地单人使用时可用 AUTH_ENABLED=false 免登录。 */
    enabled: boolean;
    /** 会话有效期（天） */
    sessionDays: number;
    /** 首次启动引导创建的管理员用户名 */
    adminUsername: string;
    /** 引导管理员口令；未提供则自动生成并在启动横幅里打印一次 */
    adminPassword?: string;
    /** 会话 cookie 名 */
    cookieName: string;
    /** 生产环境走 HTTPS 时置 true，cookie 加 Secure */
    cookieSecure: boolean;
  };
}

export const config: AppConfig = {
  port: Number(process.env.PORT ?? 8787),
  dbPath: process.env.DB_PATH ?? path.join(projectRoot, 'data', 'calendar.db'),
  timezone: process.env.TZ_NAME ?? 'Asia/Shanghai',
  limits: {
    maxBatchSize: Number(process.env.MAX_BATCH_SIZE ?? 50),
    defaultLimit: 200,
    maxLimit: 500,
    maxTitleLength: 200,
    maxCalendars: Number(process.env.MAX_CALENDARS ?? 20),
    maxTokens: Number(process.env.MAX_TOKENS ?? 10),
  },
  auth: {
    // 默认开启：多用户系统不应该「默认不设防」。本地单人可在 .env 里关掉。
    enabled: bool(process.env.AUTH_ENABLED, true),
    sessionDays: Number(process.env.SESSION_DAYS ?? 30),
    adminUsername: process.env.ADMIN_USERNAME ?? 'admin',
    adminPassword: process.env.ADMIN_PASSWORD,
    cookieName: process.env.SESSION_COOKIE ?? 'morrow_session',
    cookieSecure: bool(process.env.COOKIE_SECURE, process.env.NODE_ENV === 'production'),
  },
};

export const API_VERSION = '0.2.0';
