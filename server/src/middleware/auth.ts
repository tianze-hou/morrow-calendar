/**
 * 身份解析中间件。
 *
 * 认两种凭据，按优先级：
 * 1. `Authorization: Bearer <token>`（或 `X-API-Token`）—— 给 AI Agent 用
 * 2. 会话 cookie —— 给浏览器用
 *
 * 注意：本中间件「尽力解析」身份，不负责拦截。是否必须登录由 requireAuth 决定，
 * 这样 /api/meta、/api/auth/login 这类端点可以公开。
 */
import type { NextFunction, Request, Response } from 'express';
import type { User } from '../../../shared/types';
import { config } from '../config';
import { forbidden, unauthorized } from '../lib/errors';
import { readCookie } from '../lib/cookies';
import { resolveSession } from '../repository/sessions';
import { resolveToken } from '../repository/tokens';
import { createUser, getUser, getUserByUsername } from '../repository/users';
import { ensureDefaultCalendar } from '../repository/calendars';
import { generatePassword } from '../lib/tokens';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** 已解析出的身份；未登录时为 undefined */
      authUser?: User;
      /** 凭据来自哪条通道，便于日志与审计 */
      authMethod?: 'api_token' | 'session_cookie' | 'local';
    }
  }
}

/** AUTH_ENABLED=false 时的隐式单用户，免登录，方便本地开发。 */
let localUserIdPromise: Promise<string> | null = null;

async function getLocalUserId(): Promise<string> {
  if (!localUserIdPromise) {
    localUserIdPromise = (async () => {
      const existing = await getUserByUsername('local');
      if (existing) return existing.id;
      const created = await createUser({
        username: 'local',
        password: generatePassword(24),
        displayName: '本机用户',
        role: 'admin',
      });
      await ensureDefaultCalendar(created.id);
      return created.id;
    })();
  }
  return localUserIdPromise;
}

function extractBearer(req: Request): string | null {
  const auth = req.header('authorization');
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1].trim();
  }
  const header = req.header('x-api-token');
  return header ? header.trim() : null;
}

export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    if (!config.auth.enabled) {
      const id = await getLocalUserId();
      const user = await getUser(id);
      if (user) {
        req.authUser = user;
        req.authMethod = 'local';
      }
      next();
      return;
    }

    const bearer = extractBearer(req);
    if (bearer) {
      const userId = await resolveToken(bearer);
      if (userId) {
        const user = await getUser(userId);
        if (user && !user.disabled) {
          req.authUser = user;
          req.authMethod = 'api_token';
          next();
          return;
        }
      }
    }

    const sessionToken = readCookie(req, config.auth.cookieName);
    if (sessionToken) {
      const userId = await resolveSession(sessionToken);
      if (userId) {
        const user = await getUser(userId);
        if (user && !user.disabled) {
          req.authUser = user;
          req.authMethod = 'session_cookie';
        }
      }
    }

    next();
  } catch (err) {
    next(err);
  }
}

/** 必须已登录，否则 401。挂在需要保护的 router 前面。 */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.authUser) {
    next(unauthorized());
    return;
  }
  next();
}

/** 必须是管理员。 */
export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (!req.authUser) {
    next(unauthorized());
    return;
  }
  if (req.authUser.role !== 'admin') {
    next(forbidden('该操作仅管理员可执行'));
    return;
  }
  next();
}

/** 取当前用户；调用点保证 requireAuth 已经跑过。 */
export function currentUser(req: Request): User {
  if (!req.authUser) throw unauthorized();
  return req.authUser;
}
