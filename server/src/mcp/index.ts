/**
 * MCP 端点工厂。
 *
 * 采用 per-request 模型：每个请求 new 一个 McpServer。
 * 好处是身份天然隔离——工厂从 `ctx.authInfo` 里取出 userId 后闭包注入工具，
 * 每个实例只为那一个用户服务，不存在请求之间的状态泄漏。
 * 这也正好匹配 2026-07-28 规范的无状态传输，前面放负载均衡不需要粘性会话。
 */
import { createMcpHandler, McpServer, type McpRequestContext } from '@modelcontextprotocol/server';
import { API_VERSION, config } from '../config';
import { registerTools } from './tools';
import { requireUserId } from './auth';

function buildServer(userId: string): McpServer {
  const server = new McpServer({ name: 'morrow-calendar', version: API_VERSION });

  registerTools(server, userId);

  /**
   * 服务自描述资源。
   * 模型第一次连上时可以先读它，拿到时区、能力开关与各种上限，
   * 不必先试一次调用再从报错里反推规则。
   */
  server.registerResource(
    'service-info',
    'morrow://service-info',
    {
      title: '服务概况与硬性约定',
      mimeType: 'application/json',
      description:
        '时区、能力开关、各类上限与不可协商的规则。建议在处理涉及时间的问题之前先读一次。',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(
            {
              service: 'morrow-calendar',
              version: API_VERSION,
              timezone: config.timezone,
              limits: {
                maxBatchSize: config.limits.maxBatchSize,
                defaultLimit: config.limits.defaultLimit,
                maxLimit: config.limits.maxLimit,
                maxTitleLength: config.limits.maxTitleLength,
                maxCalendars: config.limits.maxCalendars,
              },
              capabilities: {
                recurrence: false,
                dryRun: true,
                idempotency: true,
                batch: true,
                trash: true,
                multiCalendar: true,
                settings: true,
              },
              rules: [
                '写操作默认试运行：必须显式传 dry_run=false 才会真的落库。',
                '时间一律用带时区偏移的 ISO 8601，例 2026-10-12T14:00:00+08:00。',
                '相对时间优先用 window 关键字，不要自己推算日期。',
                '删除默认进回收站（软删除），可恢复；purge / empty_trash 不可恢复。',
                '重复日程（rrule）暂不支持，遇到周期性需求逐条创建。',
                '日程数据严格按用户隔离，访问他人资源会返回 NOT_FOUND。',
              ],
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  return server;
}

/** 生成可直接接在 Express 上的 MCP handler。 */
export function createMcpEndpoint() {
  return createMcpHandler((ctx: McpRequestContext) => {
    const userId = requireUserId(ctx);
    return buildServer(userId);
  });
}
