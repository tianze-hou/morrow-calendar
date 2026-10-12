import { Router, type NextFunction, type Request, type Response } from 'express';
import type { LoginResult } from '../../../shared/types';
import { config } from '../config';
import { clearSessionCookie, setSessionCookie } from '../lib/cookies';
import { badRequest, forbidden, unauthorized } from '../lib/errors';
import { checkPasswordStrength, verifyPassword } from '../lib/password';
import { currentUser, requireAuth } from '../middleware/auth';
import { createSession, deleteSession } from '../repository/sessions';
import { getPasswordHash, getUser, getUserByUsername, updateUser } from '../repository/users';
import { changePasswordSchema, loginSchema, toValidationError } from '../validation';

const router = Router();

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

function readSessionCookie(req: Request): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === config.auth.cookieName) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * GET /api/auth/status —— 前端启动时先问这一句，才知道要不要弹登录页。
 * 刻意做成公开端点：不带任何敏感信息，只有「要不要登录」和「你是谁」。
 */
router.get('/status', (req: Request, res: Response) => {
  res.json({
    ok: true,
    data: {
      authRequired: config.auth.enabled,
      authenticated: Boolean(req.authUser),
      user: req.authUser ?? null,
      method: req.authMethod ?? null,
    },
  });
});

/** POST /api/auth/login —— 口令登录，成功后下发 HttpOnly 会话 cookie。 */
router.post(
  '/login',
  wrap(async (req, res) => {
    const parsed = loginSchema.safeParse(req.body ?? {});
    if (!parsed.success) toValidationError(parsed.error);

    const { username, password } = parsed.data;
    const user = await getUserByUsername(username);

    // 用户不存在与口令错误返回同一个错误，避免变成用户名枚举接口
    const hash = user ? await getPasswordHash(user.id) : null;
    const matches = Boolean(hash) && verifyPassword(password, hash!);
    if (!user || !matches) {
      throw unauthorized('用户名或口令不正确', '确认大小写与输入法后重试。');
    }
    if (user.disabled) {
      throw forbidden('该账号已被停用', '联系管理员恢复后再登录。');
    }

    const session = await createSession(user.id, req.header('user-agent') ?? undefined);
    setSessionCookie(res, session.token, session.expiresAt);

    const result: LoginResult = { user, expiresAt: session.expiresAt };
    res.json({ ok: true, data: result });
  }),
);

/** POST /api/auth/logout —— 清掉会话与 cookie。 */
router.post(
  '/logout',
  wrap(async (req, res) => {
    const token = readSessionCookie(req);
    if (token) await deleteSession(token).catch(() => undefined);
    clearSessionCookie(res);
    res.json({ ok: true, data: { loggedOut: true } });
  }),
);

/** GET /api/auth/me —— 当前身份。 */
router.get('/me', requireAuth, (req: Request, res: Response) => {
  res.json({ ok: true, data: currentUser(req) });
});

/** PUT /api/auth/password —— 改自己的口令。 */
router.put(
  '/password',
  requireAuth,
  wrap(async (req, res) => {
    const user = currentUser(req);
    const parsed = changePasswordSchema.safeParse(req.body ?? {});
    if (!parsed.success) toValidationError(parsed.error);

    const hash = await getPasswordHash(user.id);
    if (!hash || !verifyPassword(parsed.data.currentPassword, hash)) {
      throw unauthorized('当前口令不正确', '忘记口令请联系管理员重置。');
    }
    const reason = checkPasswordStrength(parsed.data.newPassword);
    if (reason) throw badRequest(reason);

    await updateUser(user.id, { password: parsed.data.newPassword });
    res.json({ ok: true, data: await getUser(user.id) });
  }),
);

export default router;
