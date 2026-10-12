/**
 * MCP 端的身份桥接。
 *
 * 刻意复用 REST 那套 `authenticate`（Bearer / 会话 cookie / AUTH_ENABLED=false 本机用户），
 * 而不是 MCP SDK 自带的 `requireBearerAuth`——后者假定 OAuth 授权服务器，
 * 会回 `WWW-Authenticate` 挑战，和本项目「用户自己在设置页签令牌」的模型对不上。
 *
 * 走同一套逻辑的好处是：一个令牌在 REST 和 MCP 两个入口的行为完全一致，
 * 吊销也只需要一处。
 */
import type { NextFunction, Request, Response } from 'express';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { config } from '../config';
import { authenticate } from '../middleware/auth';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /**
       * 已校验的身份。`toNodeHandler` 会把它转发成 MCP handler 的 authInfo。
       * 只有 MCP 端点会写它；REST 侧仍按 authUser 走。
       */
      auth?: AuthInfo;
    }
  }
}

/** 令牌本身不需要回显给调用方，这里只留一个占位。 */
const REDACTED = 'redacted';

/**
 * Express 中间件：解析身份，并把结果写成 `req.auth`。
 *
 * `toNodeHandler` 会把 `req.auth` 原样转成 MCP handler 的 `authInfo`，
 * 于是每个工具的回调都能通过工厂闭包拿到当前用户，不需要从参数里传 userId。
 */
export async function attachAuthInfo(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    // 先跑一遍标准的身份解析（尽力解析，不拦截）
    await authenticate(req, res, () => undefined);

    // MCP 端点不接受「没带凭据」：这是给外部 AI 的入口，不存在浏览器会话的隐式登录
    if (config.auth.enabled && !req.authUser) {
      res.status(401).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message:
            '未授权：请带 Authorization: Bearer <令牌>。令牌在网页「设置 → API 令牌」里生成，' +
            '或由管理员执行 npm run token -- --user <用户名> --name "<备注>" 签发。',
        },
      });
      return;
    }

    if (!req.authUser) {
      res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: '无法确认身份：本实例没有可用的隐式用户。' },
      });
      return;
    }

    const user = req.authUser;
    const auth: AuthInfo = {
      token: REDACTED,
      clientId: req.authMethod === 'api_token' ? 'api-token' : 'session-cookie',
      scopes: user.role === 'admin' ? ['events:read', 'events:write', 'calendars:write'] : ['events:read', 'events:write'],
      extra: {
        userId: user.id,
        username: user.username,
        displayName: user.displayName ?? user.username,
        role: user.role,
        authMethod: req.authMethod ?? 'local',
      },
    };
    req.auth = auth;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * 从 authInfo 里取出用户 id。工具回调一律通过它确定数据边界，
 * 这样「每个用户只能看到自己的日程」这条约束在两条入口上都不可能绕过。
 */
export function requireUserId(ctx: { authInfo?: AuthInfo }): string {
  const id = ctx.authInfo?.extra?.userId;
  if (typeof id !== 'string' || !id) {
    throw new Error('MCP_UNAUTHORIZED: 请求缺少有效身份');
  }
  return id;
}
