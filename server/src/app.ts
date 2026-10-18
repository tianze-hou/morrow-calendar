import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { ApiError } from './lib/errors';
import { config, projectRoot } from './config';
import { authenticate, requireAuth } from './middleware/auth';
import { attachAuthInfo } from './mcp/auth';
import { createMcpEndpoint } from './mcp';
import authRouter from './routes/auth';
import calendarsRouter from './routes/calendars';
import eventsRouter from './routes/events';
import exportRouter from './routes/export';
import metaRouter, { ENDPOINT_CATALOG } from './routes/meta';
import settingsRouter from './routes/settings';
import setupRouter from './routes/setup';
import tokensRouter from './routes/tokens';
import usersRouter from './routes/users';

/**
 * 无需登录即可访问的端点。只放三类：
 * - 服务自描述（AI 必须先知道怎么鉴权，否则是鸡生蛋问题）
 * - 健康检查
 * - 登录本身
 */
const PUBLIC_PATHS = new Set([
  '/api',
  '/api/meta',
  '/api/agent.md',
  '/api/health',
  '/api/openapi.yaml',
  '/api/auth/status',
  '/api/auth/login',
  '/api/auth/logout',
  // 初始化引导：这两个接口本身处理的是「还没有任何身份」的场景，
  // 真正的闸门是服务端「零用户才放行」的判定，不是这里的鉴权。
  '/api/setup/status',
  '/api/setup/admin',
  // MCP 端点：不放行到这里鉴权，因为它的 401 必须是 JSON-RPC 格式而不是 REST 信封，
  // 否则 MCP 客户端读不懂。鉴权由 attachAuthInfo 自己接管，用的仍是同一套令牌体系。
  '/api/mcp',
]);

function isPublic(req: Request): boolean {
  const full = req.baseUrl + (req.path === '/' ? '' : req.path);
  return PUBLIC_PATHS.has(full);
}

export function createApp() {
  const app = express();

  // CORS 默认关闭：生产环境由本服务自己托管前端，浏览器同源，不需要跨域头；
  // 开发环境下 Vite 已把 /api 反代到本服务，同样是同源。
  // 仅当前端确实部署在另一个域（例如前后端分离部署）时，才通过 CORS_ORIGINS 显式放行白名单。
  // 注意不要改成 `origin: true` —— 那会回显任意来源，配合 credentials 等于给所有站点开了带凭据的跨域入口。
  const corsOrigins = process.env.CORS_ORIGINS?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (corsOrigins && corsOrigins.length) {
    app.use(cors({ origin: corsOrigins, credentials: true }));
  }
  app.use(express.json({ limit: '1mb' }));

  // 1) 尽力解析身份（API 令牌 / 会话 cookie / 本机隐式用户）
  app.use('/api', authenticate);

  // 2) 非公开端点强制登录
  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    if (isPublic(req)) {
      next();
      return;
    }
    requireAuth(req, res, next);
  });

  app.get('/api', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      data: {
        service: 'morrow-calendar',
        hint: 'AI Agent 请看 GET /api/meta（自描述 JSON）或 GET /api/agent.md（一页式简报）。',
        authRequired: config.auth.enabled,
        endpoints: ENDPOINT_CATALOG,
      },
    });
  });

  app.use('/api', metaRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/setup', setupRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/tokens', tokensRouter);
  app.use('/api/calendars', calendarsRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/events', eventsRouter);
  app.use('/api/export', exportRouter);

  /**
   * MCP 端点（Model Context Protocol）。
   *
   * 给 ChatGPT / Claude Desktop / Cursor / Claude Code 这类 AI 客户端用的第二入口，
   * 与上面的 REST 共用同一份 service 与 repository，所以两条路径的行为天然一致。
   *
   * `req.body` 已由全局 express.json() 解析好，传给适配器避免二次读流；
   * attachAuthInfo 负责把身份写成 req.auth，toNodeHandler 再把它转成工具的 authInfo。
   */
  const mcpNodeHandler = toNodeHandler(createMcpEndpoint());
  app.all('/api/mcp', attachAuthInfo, (req: Request, res: Response) => {
    void mcpNodeHandler(req, res, req.body);
  });

  // 生产模式下顺带托管前端构建产物（本地开发用 Vite，不依赖这条）
  const distDir = path.join(projectRoot, 'dist');
  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    // 前端是单页应用：非 /api 的未知路径一律回落到 index.html
    app.get(/^(?!\/api).*/, (_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.use((req: Request, res: Response) => {
    res.status(404).json({
      ok: false,
      error: {
        code: 'NOT_FOUND',
        message: `接口不存在：${req.method} ${req.originalUrl}`,
        hint: 'GET /api/meta 查看全部可用端点。',
      },
    });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ApiError) {
      res.status(err.status).json({
        ok: false,
        error: { code: err.code, message: err.message, details: err.details, hint: err.hint },
      });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error('[unhandled]', err);
    res.status(500).json({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message, hint: '查看服务端日志定位问题。' },
    });
  });

  return app;
}
