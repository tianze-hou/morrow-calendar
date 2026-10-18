import fs from 'node:fs';
import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import {
  DELETE_MODES,
  ERROR_CODES,
  EVENT_COLORS,
  ON_CONFLICT,
  TIME_WINDOWS,
  USER_ROLES,
  type ApiMeta,
} from '../../../shared/types';
import { API_VERSION, config, projectRoot } from '../config';
import { getDb } from '../db/index';
import { countUsers } from '../repository/users';
import { TOOL_NAMES } from '../mcp/tools';

const router = Router();

/**
 * 端点清单。写在 meta 里，AI Agent 读一次就拿到全部可用路径、权限和风险等级，
 * 不需要解析页面、不需要读源码。
 */
export const ENDPOINT_CATALOG: ApiMeta['endpoints'] = [
  { method: 'GET', path: '/api/meta', summary: '服务自描述：鉴权方式、能力、枚举、限制、端点清单、上手序列', sideEffect: 'read', riskLevel: 'safe', auth: false },
  { method: 'GET', path: '/api/agent.md', summary: '面向 Agent 的一页简报（Markdown），可直接喂给模型', sideEffect: 'read', riskLevel: 'safe', auth: false },
  { method: 'GET', path: '/api/health', summary: '健康检查与存储信息', sideEffect: 'read', riskLevel: 'safe', auth: false },
  { method: 'GET', path: '/api/setup/status', summary: '是否需要初始化（库里是否已有用户）', sideEffect: 'read', riskLevel: 'safe', auth: false },
  { method: 'POST', path: '/api/setup/admin', summary: '创建首个管理员（仅零用户时可用，一次性）', sideEffect: 'write', riskLevel: 'confirm', auth: false },
  { method: 'GET', path: '/api/auth/status', summary: '查询是否已登录、当前身份', sideEffect: 'read', riskLevel: 'safe', auth: false },
  { method: 'POST', path: '/api/auth/login', summary: '口令登录，下发会话 cookie', sideEffect: 'write', riskLevel: 'safe', auth: false },
  { method: 'POST', path: '/api/auth/logout', summary: '退出登录', sideEffect: 'write', riskLevel: 'safe', auth: false },
  { method: 'GET', path: '/api/auth/me', summary: '读取当前用户', sideEffect: 'read', riskLevel: 'safe', auth: true },
  { method: 'PUT', path: '/api/auth/password', summary: '修改本人登录口令', sideEffect: 'write', riskLevel: 'confirm', auth: true },

  { method: 'GET', path: '/api/tokens', summary: '列出本人的 API 令牌（不含明文）', sideEffect: 'read', riskLevel: 'safe', auth: true },
  { method: 'POST', path: '/api/tokens', summary: '创建 API 令牌，明文仅返回一次', sideEffect: 'write', riskLevel: 'confirm', auth: true },
  { method: 'POST', path: '/api/tokens/:id/revoke', summary: '吊销令牌（保留审计记录）', sideEffect: 'write', riskLevel: 'confirm', auth: true },
  { method: 'DELETE', path: '/api/tokens/:id', summary: '彻底删除令牌记录', sideEffect: 'write', riskLevel: 'danger', auth: true },

  { method: 'GET', path: '/api/users', summary: '用户列表（管理员看全部，普通用户只看自己）', sideEffect: 'read', riskLevel: 'safe', auth: true },
  { method: 'POST', path: '/api/users', summary: '创建用户（仅管理员）', sideEffect: 'write', riskLevel: 'confirm', auth: true },
  { method: 'PATCH', path: '/api/users/:id', summary: '修改用户资料/口令/角色/停用（仅管理员）', sideEffect: 'write', riskLevel: 'danger', auth: true },
  { method: 'DELETE', path: '/api/users/:id', summary: '删除用户及其全部数据（仅管理员）', sideEffect: 'write', riskLevel: 'danger', auth: true },

  { method: 'GET', path: '/api/calendars', summary: '列出本人的日历分组', sideEffect: 'read', riskLevel: 'safe', auth: true },
  { method: 'POST', path: '/api/calendars', summary: '新建日历分组', sideEffect: 'write', riskLevel: 'safe', auth: true },
  { method: 'PATCH', path: '/api/calendars/:id', summary: '改名/换色/切换可见性/排序', sideEffect: 'write', riskLevel: 'safe', auth: true },
  { method: 'DELETE', path: '/api/calendars/:id', summary: '删除分组（组内日程迁入默认分组）', sideEffect: 'write', riskLevel: 'confirm', auth: true },

  { method: 'GET', path: '/api/settings', summary: '读取界面设置（配色/时间格式/周起始/默认视图）', sideEffect: 'read', riskLevel: 'safe', auth: true },
  { method: 'PUT', path: '/api/settings', summary: '写入界面设置（局部更新，按用户隔离）', sideEffect: 'write', riskLevel: 'safe', auth: true },
  { method: 'POST', path: '/api/settings/reset', summary: '恢复出厂设置（只影响当前用户）', sideEffect: 'write', riskLevel: 'safe', auth: true },

  { method: 'GET', path: '/api/events', summary: '按时间范围/关键词/分组查询日程', sideEffect: 'read', riskLevel: 'safe', auth: true },
  { method: 'GET', path: '/api/events/trash', summary: '回收站列表', sideEffect: 'read', riskLevel: 'safe', auth: true },
  { method: 'POST', path: '/api/events/trash/empty', summary: '清空回收站（不可恢复）', sideEffect: 'write', riskLevel: 'danger', auth: true },
  { method: 'GET', path: '/api/events/conflicts', summary: '扫描区间内互相重叠的日程', sideEffect: 'read', riskLevel: 'safe', auth: true },
  { method: 'GET', path: '/api/events/:id', summary: '读取单条日程', sideEffect: 'read', riskLevel: 'safe', auth: true },
  { method: 'POST', path: '/api/events', summary: '创建日程（支持 dry_run / on_conflict / 幂等键）', sideEffect: 'write', riskLevel: 'confirm', auth: true },
  { method: 'PATCH', path: '/api/events/:id', summary: '局部更新日程', sideEffect: 'write', riskLevel: 'confirm', auth: true },
  { method: 'PUT', path: '/api/events/:id', summary: '完整替换日程（title/start/end 必填）', sideEffect: 'write', riskLevel: 'confirm', auth: true },
  { method: 'POST', path: '/api/events/:id/restore', summary: '从回收站恢复日程', sideEffect: 'write', riskLevel: 'safe', auth: true },
  { method: 'DELETE', path: '/api/events/:id', summary: '删除日程（默认进回收站，?mode=hard 彻底删除）', sideEffect: 'write', riskLevel: 'confirm', auth: true },
  { method: 'DELETE', path: '/api/events/:id/purge', summary: '从回收站彻底删除单条', sideEffect: 'write', riskLevel: 'danger', auth: true },
  { method: 'POST', path: '/api/events/batch', summary: '批量增改删（上限 50，支持 dry_run / atomic）', sideEffect: 'write', riskLevel: 'danger', auth: true },
  { method: 'GET', path: '/api/export/events.ics', summary: '导出 iCalendar（RFC 5545），可按区间 / 分组 / 指定 id', sideEffect: 'read', riskLevel: 'safe', auth: true },
];

/**
 * 最小上手序列。对模型来说，照抄四步比通读一本协议文档省钱得多，
 * 所以直接写进 meta，而不是只给一个文档链接。
 */
const QUICKSTART: ApiMeta['quickstart'] = [
  { step: 1, request: 'GET /api/meta', note: '先读自描述：鉴权方式、枚举、上限、端点清单（含风险等级）。' },
  { step: 2, request: 'GET /api/events?window=today', note: '拿现状。相对时间用 window 关键字，不要自己算日期。' },
  { step: 3, request: 'POST /api/events?dry_run=true', note: '试运行：返回将要发生的变化与警告，不落库。把它展示给人类。' },
  { step: 4, request: 'POST /api/events', note: '人类确认后再真写。创建时带 Idempotency-Key，防网络重试造成重复。' },
  { step: 5, request: 'GET /api/events/conflicts?window=next_7_days', note: '写完后自查时间冲突，把冲突对象如实回报人类。' },
];

/** 一段可以直接塞进系统提示的自描述文本。 */
const AGENT_PROMPT = `你是 morrow calendar 的日程助理。所有读写都走 REST 接口，不要打开网页或解析 DOM。

开始前先 GET /api/meta，读 authentication.required、limits、enums 与 endpoints[].riskLevel，不要凭记忆调用。
鉴权开启时每个请求都带 Authorization: Bearer <令牌>；令牌由人类提供，不要自己创建账号，也不要尝试绕过鉴权。

时间一律用带时区的 ISO 8601，例 2026-10-12T14:00:00+08:00。
相对时间优先用 ?window=today|tomorrow|yesterday|this_week|next_week|this_month|next_7_days|next_30_days，不要自己算日期。

写操作（POST / PATCH / PUT / DELETE）先加 ?dry_run=true，把 changes 与 warnings 给人类看，得到明确同意再真写；创建时带 Idempotency-Key 防重。
出错按 error.code 分支处理：details 是字段级修正建议，hint 是下一步动作。收到 401 就停下向人类要令牌，不要重试、不要猜测。

完整协议见 GET /api/openapi.yaml；协作细则见 GET /api/agent.md。`;

function buildMeta(needsSetup: boolean): ApiMeta {
  const authRequired = config.auth.enabled;
  return {
    service: 'morrow-calendar',
    version: API_VERSION,
    timezone: config.timezone,
    timeFormat: 'ISO 8601 / RFC 3339，必须带时区偏移，例 2026-10-12T10:00:00+08:00',
    authentication: {
      required: authRequired,
      schemes: authRequired
        ? [
            {
              type: 'api_token',
              header: 'Authorization: Bearer <token>',
              description:
                '推荐给 AI Agent 使用。令牌在设置页或 POST /api/tokens 创建，长期有效、可单独吊销，不影响用户的登录会话。',
            },
            {
              type: 'session_cookie',
              header: `Cookie: ${config.auth.cookieName}=<value>`,
              description: '浏览器登录后由服务端自动下发，HttpOnly，前端无需手工处理。',
            },
          ]
        : [
            {
              type: 'session_cookie',
              header: '(无需凭据)',
              description:
                '当前服务以 AUTH_ENABLED=false 运行，所有请求自动归属本机单一用户，无需任何凭据。',
            },
          ],
      howToGetToken: authRequired
        ? '先 POST /api/auth/login 取得会话，再 POST /api/tokens {name} 拿到明文令牌（只返回一次）。也可由管理员用 npm run token -- --user <用户名> --name <备注> 直接签发。'
        : '当前无需令牌。',
    },
    onboarding: {
      required: needsSetup,
      endpoint: 'POST /api/setup/admin',
      description: needsSetup
        ? '该实例还没有任何用户。请让人类打开网页完成初始化，或先调用 GET /api/setup/status 确认，再 POST /api/setup/admin 创建首个管理员。'
        : '已完成初始化，无需处理。',
    },
    capabilities: {
      recurrence: false,
      multiUser: true,
      auth: authRequired,
      dryRun: true,
      idempotency: true,
      batch: true,
      settings: true,
      trash: true,
      calendars: true,
      onboarding: authRequired,
    },
    limits: {
      maxBatchSize: config.limits.maxBatchSize,
      defaultLimit: config.limits.defaultLimit,
      maxLimit: config.limits.maxLimit,
      maxTitleLength: config.limits.maxTitleLength,
      maxCalendars: config.limits.maxCalendars,
      maxTokens: config.limits.maxTokens,
    },
    enums: {
      colors: EVENT_COLORS,
      timeWindows: TIME_WINDOWS,
      onConflict: ON_CONFLICT,
      deleteModes: DELETE_MODES,
      roles: USER_ROLES,
      errorCodes: ERROR_CODES,
    },
    endpoints: ENDPOINT_CATALOG,
    quickstart: QUICKSTART,
    agentPrompt: AGENT_PROMPT,
    mcp: {
      enabled: true,
      endpoint: '/api/mcp',
      transport: ['http'],
      description:
        'Model Context Protocol 端点：把日程能力暴露成可被 AI 客户端自动发现的工具。' +
        '与 REST 共用同一份业务逻辑，同一枚令牌两个入口都能用。',
      tools: [...TOOL_NAMES],
      authNote: '沿用 REST 的令牌，不需要单独签发：Authorization: Bearer <令牌>。',
      note:
        'ChatGPT / Claude Desktop / Cursor / Claude Code 直接填 https://<你的域名>/api/mcp 即可接入；' +
        '写操作默认试运行，必须显式传 dry_run=false 才会落库。',
    },
    docs: {
      protocol: 'docs/api-protocol.md',
      openapi: '/api/openapi.yaml',
      brief: '/api/agent.md',
    },
  };
}

router.get('/meta', async (_req: Request, res: Response) => {
  const needsSetup = config.auth.enabled && (await countUsers()) === 0;
  res.json({ ok: true, data: buildMeta(needsSetup) });
});

/**
 * GET /api/agent.md —— 一页式简报。
 * 人类可以用一条 curl 把它抓下来，直接贴进对话，不必手工摘抄协议要点。
 */
router.get('/agent.md', async (_req: Request, res: Response) => {
  const needsSetup = config.auth.enabled && (await countUsers()) === 0;
  const meta = buildMeta(needsSetup);
  res.type('text/markdown; charset=utf-8').send(buildAgentBrief(meta));
});

/** 把 meta 摊平成一段 Markdown。字段与 meta 同源，不会各说各话。 */
function buildAgentBrief(meta: ApiMeta): string {
  const endpointTable = meta.endpoints
    .map((e) => `| \`${e.method} ${e.path}\` | ${e.riskLevel} | ${e.auth ? '是' : '否'} | ${e.summary} |`)
    .join('\n');
  const quickstart = meta.quickstart
    .map((s) => `${s.step}. \`${s.request}\`\n   ${s.note}`)
    .join('\n');
  const windows = meta.enums.timeWindows.join(' / ');
  const colors = meta.enums.colors.join(', ');

  return `# morrow calendar · Agent 简报

服务地址：本文件所在路径去掉 \`/agent.md\` 即接口根（例 \`http://127.0.0.1:8787/api\`）。
版本：${meta.version} ｜ 时区：${meta.timezone} ｜ 鉴权：${meta.authentication.required ? '必需' : '关闭'}

${meta.agentPrompt}

## 上手序列

${quickstart}

## 约定

- 时间：${meta.timeFormat}。相对时间用 \`?window=\` 关键字：${windows}。
- 鉴权：${meta.authentication.schemes.map((s) => `\`${s.header}\``).join(' 或 ')}。
- 写操作先 \`?dry_run=true\` 拿 \`changes\` 与 \`warnings\`，人类同意后再真写；创建时带 \`Idempotency-Key\`。
- 查询参数同时接受 snake_case 与 camelCase（\`dry_run\` 与 \`dryRun\` 等价）。
- 删除默认进回收站（软删除）；彻底删除要显式 \`?mode=hard\`，属于 danger。
- 越权访问他人资源返回 404（而非 403），避免被用来枚举 id。
- 颜色取值：${colors}。
- 上限：单批 ${meta.limits.maxBatchSize} 条、列表默认 ${meta.limits.defaultLimit} / 最多 ${meta.limits.maxLimit} 条、每用户最多 ${meta.limits.maxCalendars} 个分组与 ${meta.limits.maxTokens} 个令牌。

## 端点一览

| 端点 | 风险 | 需登录 | 说明 |
| --- | --- | --- | --- |
${endpointTable}

## MCP 接入（支持工具协议的客户端走这条，更省事）

${meta.mcp.description}

- 端点：\`POST ${meta.mcp.endpoint}\`（JSON-RPC 2.0 over HTTP，一个 URL 就够）
- 鉴权：${meta.mcp.authNote}
- 工具：${meta.mcp.tools.join('、')}
- ${meta.mcp.note}

ChatGPT / Claude Desktop / Cursor / Claude Code 在「添加 MCP 服务器」处填上这个 URL 即可，
不用读协议文档、不用手工描述接口。客户端不支持 MCP 时照上面的 REST 端点调用，能力与鉴权完全一致。

## 机器可读协议

- OpenAPI 3：\`GET /api/openapi.yaml\`
- 自描述 JSON：\`GET /api/meta\`
`;
}

router.get('/health', async (_req: Request, res: Response) => {
  const db = await getDb();
  const events = db.get<{ c: number }>('SELECT COUNT(*) AS c FROM events WHERE deleted_at IS NULL');
  const trash = db.get<{ c: number }>('SELECT COUNT(*) AS c FROM events WHERE deleted_at IS NOT NULL');
  const users = db.get<{ c: number }>('SELECT COUNT(*) AS c FROM users');
  res.json({
    ok: true,
    data: {
      status: 'ok',
      service: 'morrow-calendar',
      version: API_VERSION,
      storage: { driver: db.name, path: config.dbPath },
      eventCount: Number(events?.c ?? 0),
      trashCount: Number(trash?.c ?? 0),
      userCount: Number(users?.c ?? 0),
      authRequired: config.auth.enabled,
      setupRequired: config.auth.enabled && Number(users?.c ?? 0) === 0,
    },
  });
});

/** 直接把 OpenAPI 文档通过 HTTP 提供出去，方便远端 Agent 拉取。 */
router.get('/openapi.yaml', (_req: Request, res: Response) => {
  const file = path.join(projectRoot, 'docs', 'openapi.yaml');
  if (!fs.existsSync(file)) {
    res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'openapi.yaml 未生成' } });
    return;
  }
  res.type('application/yaml; charset=utf-8').send(fs.readFileSync(file, 'utf8'));
});

export default router;
