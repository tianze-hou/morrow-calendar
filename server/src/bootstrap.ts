/**
 * 首次启动引导。
 *
 * 库里一个用户都没有时，按两种路径之一处理：
 *
 * - 本地免登录模式（AUTH_ENABLED=false），或部署方显式提供了 ADMIN_PASSWORD：
 *   直接建好管理员并把口令打进启动横幅。无浏览器、容器、CI 都走这条。
 * - 其余情况（多用户模式且未指定口令）：什么都不建，把首个管理员的创建权交给
 *   浏览器里的初始化引导。前端拿到 GET /api/setup/status 的 needsSetup=true 后
 *   会显示「创建管理员」向导，人自己填用户名和口令，不再需要去控制台里抄一次性口令。
 *
 * 无论哪条路径，只要建了管理员，都会顺带做同一件事：给管理员补上默认日历分组，
 * 并把 v2 时代「无归属」的数据（事件、设置）划归给他，避免升级后数据凭空消失。
 *
 * 整个过程幂等，重复启动不会有副作用。
 */
import { config } from './config';
import { getDb } from './db/index';
import { generatePassword } from './lib/tokens';
import { toUtcIso } from './lib/time';
import { countUsers, createUser } from './repository/users';
import { adoptLegacySettings } from './repository/settings';

export interface BootstrapResult {
  /** 本次是否新建了管理员 */
  created: boolean;
  username?: string;
  /** 仅当口令是自动生成时才有值，需要在启动横幅里提示一次 */
  generatedPassword?: string;
  /** 被划归到该管理员名下的历史数据条数 */
  adopted: { events: number; settings: number };
  /**
   * true：库里没有用户，且没有自动建号——首个管理员要在浏览器里创建。
   * 前端据此显示初始化引导页，服务端据此放行 /api/setup/*。
   */
  setupPending: boolean;
}

const EMPTY_ADOPTED = { events: 0, settings: 0 };

/**
 * 把 v2 时代的无归属数据划归到指定用户名下。
 * 建号路径与浏览器引导路径都要用，所以单独抽出来。
 */
export async function adoptLegacyData(
  userId: string,
): Promise<{ events: number; settings: number }> {
  const db = await getDb();
  // 历史事件用的 calendar_id 是字面量 'default'，这里让默认分组沿用同一个 id，
  // 升级后既有日程依然落在「默认日历」里，不会变成孤儿。
  const now = toUtcIso(new Date());
  const occupied = db.get<{ id: string }>("SELECT id FROM calendars WHERE id = 'default'");
  if (!occupied) {
    db.run(
      `INSERT INTO calendars (id, user_id, name, color, visible, sort_order, is_default, created_at, updated_at)
       VALUES ('default', ?, '默认日历', 'blue', 1, 0, 1, ?, ?)`,
      [userId, now, now],
    );
  }

  const eventsRes = db.run('UPDATE events SET user_id = ? WHERE user_id IS NULL OR user_id = ?', [
    userId,
    '',
  ]);
  return { events: eventsRes.changes, settings: 0 };
}

export async function bootstrap(): Promise<BootstrapResult> {
  await getDb();
  const existing = await countUsers();
  if (existing > 0) {
    return { created: false, adopted: EMPTY_ADOPTED, setupPending: false };
  }

  // 多用户模式且没给初始口令：交给浏览器的初始化引导，服务端不擅自建号。
  const autoCreate = !config.auth.enabled || Boolean(config.auth.adminPassword);
  if (!autoCreate) {
    return { created: false, adopted: EMPTY_ADOPTED, setupPending: true };
  }

  const username = config.auth.adminUsername;
  const generatedPassword = config.auth.adminPassword ? undefined : generatePassword();
  const password = config.auth.adminPassword ?? generatedPassword!;

  const admin = await createUser({
    username,
    password,
    displayName: '管理员',
    role: 'admin',
  });

  const base = await adoptLegacyData(admin.id);
  const settings = await adoptLegacySettings(admin.id);

  return {
    created: true,
    username: admin.username,
    generatedPassword,
    adopted: { events: base.events, settings },
    setupPending: false,
  };
}
