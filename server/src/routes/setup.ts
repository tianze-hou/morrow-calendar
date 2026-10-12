/**
 * 浏览器初始化引导。
 *
 * 只在「库里一个用户都没有」时可用，用完即封——一旦存在任何用户，
 * 两个接口都会拒绝服务，避免变成绕过鉴权开账号的后门。
 *
 * 两个接口都是公开端点，因为它们本来就是给「还没有任何身份」的人用的。
 * 安全上的兜底是 countUsers() 那道闸，而不是鉴权中间件。
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import type { LoginResult, SetupStatus } from '../../../shared/types';
import { API_VERSION, config } from '../config';
import { adoptLegacyData } from '../bootstrap';
import { setSessionCookie } from '../lib/cookies';
import { alreadyExists, forbidden } from '../lib/errors';
import { ensureDefaultCalendar } from '../repository/calendars';
import { createSession } from '../repository/sessions';
import { countUsers, createUser } from '../repository/users';
import { setupAdminSchema, toValidationError } from '../validation';

const router = Router();

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

/** 引导是否仍然开着：多用户模式 + 库里零用户。 */
async function setupOpen(): Promise<boolean> {
  if (!config.auth.enabled) return false;
  return (await countUsers()) === 0;
}

/** GET /api/setup/status —— 前端启动时先问一句：要不要显示「创建管理员」向导。 */
router.get(
  '/status',
  wrap(async (_req, res) => {
    const status: SetupStatus = {
      service: 'morrow-calendar',
      version: API_VERSION,
      needsSetup: await setupOpen(),
      authRequired: config.auth.enabled,
      suggestedUsername: config.auth.adminUsername,
    };
    res.json({ ok: true, data: status });
  }),
);

/**
 * POST /api/setup/admin —— 创建首个管理员，并顺手把这次操作当作登录，
 * 下发的会话 cookie 与正常登录完全一致。前端拿到用户后即可直接进主界面。
 */
router.post(
  '/admin',
  wrap(async (req, res) => {
    if (!config.auth.enabled) {
      throw forbidden('当前实例未启用鉴权，无需初始化', '直接打开页面即可使用。');
    }
    if (!(await setupOpen())) {
      throw alreadyExists('该实例已经完成初始化', '请直接登录；忘记口令可运行 npm run passwd 重置。');
    }

    const parsed = setupAdminSchema.safeParse(req.body ?? {});
    if (!parsed.success) toValidationError(parsed.error);

    // 唯一一个用户直接建为管理员——这里不需要、也不该有角色参数。
    const admin = await createUser({ ...parsed.data, role: 'admin' });
    // 顺序不能反：先接管历史数据（它会承接 v2 的 id='default' 分组），
    // 再补默认分组。反过来会撞上「每用户至多一个默认分组」的部分唯一索引。
    await adoptLegacyData(admin.id);
    await ensureDefaultCalendar(admin.id);

    const session = await createSession(admin.id, req.header('user-agent') ?? undefined);
    setSessionCookie(res, session.token, session.expiresAt);

    const result: LoginResult = { user: admin, expiresAt: session.expiresAt };
    res.status(201).json({ ok: true, data: result });
  }),
);

export default router;
