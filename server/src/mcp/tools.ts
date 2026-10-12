/**
 * MCP 工具注册。
 *
 * 两条硬约定，写在这里是为了让调用方（模型）在 `tools/list` 阶段就能读到，
 * 而不是靠外部文档提醒：
 *
 * 1. **写操作默认 dry_run**。想真正落库必须显式传 `dry_run: false`。
 *    模型即便忘了「先试运行」这一步，也不会直接改数据。
 * 2. **userId 一律由服务端闭包注入**，绝不接受调用方传。
 *    「每个用户只能看到自己的日程」这条约束因此无法被绕过。
 *
 * 业务逻辑全部走 services/events.ts 与 repository，和 REST 是同一份实现。
 */
import type { McpServer } from '@modelcontextprotocol/server';
/**
 * 用 zod 4 的完整实现，不用 `zod/v4` subpath。
 * 后者是 zod 3.25 内置的精简版，缺 Standard Schema 的 JSON Schema 扩展，
 * MCP SDK 校验工具入参时认不了。靠 npm alias 与 REST 侧的 zod 3 共存，互不影响。
 */
import * as z from 'zod4';
import {
  DELETE_MODES,
  EVENT_COLORS,
  ON_CONFLICT,
  THEMES,
  TIME_WINDOWS,
  VIEWS,
} from '../../../shared/types';
import { ApiError } from '../lib/errors';
import { conflictRejected, notFound, versionConflict } from '../lib/errors';
import * as repoCalendar from '../repository/calendars';
import * as repoEvent from '../repository/events';
import * as repoSettings from '../repository/settings';
import {
  buildListFilters,
  detectWarnings,
  findOverlapPairs,
  normalizeTimes,
  parseCalendarIds,
  parseListOptions,
  projectEvent,
  projectNew,
  resolvePatchTimes,
  resolveRange,
  type Warning,
} from '../services/events';

/* --------------------------------------------------------------- 基础工具 */

function json(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

/** 把 ApiError 转成模型能读、能据此改写的错误体。未知异常继续往上抛，交给 SDK 兜底。 */
function fail(err: unknown) {
  if (err instanceof ApiError) {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              error: {
                code: err.code,
                message: err.message,
                details: err.details,
                hint: err.hint,
              },
            },
            null,
            2,
          ),
        },
      ],
    };
  }
  throw err;
}

/* 枚举：直接从 shared/types 的 const tuple 推断，保留字面量类型。
   写 `[...EVENT_COLORS] as [string, ...string[]]` 会把它们塌缩成 string，
   传给 repository 时过不了 EventColor 这一关。 */
const colorEnum = z.enum(EVENT_COLORS);
const windowEnum = z.enum(TIME_WINDOWS);
const onConflictEnum = z.enum(ON_CONFLICT);
const deleteModeEnum = z.enum(DELETE_MODES);
const themeEnum = z.enum(THEMES);
const viewEnum = z.enum(VIEWS);

const WINDOW_HINT =
  '相对时间优先用 window 关键字（today/tomorrow/yesterday/this_week/next_week/this_month/next_7_days/next_30_days），' +
  '不要自己推算日期；确需绝对区间时用半开区间 [from, to) 的 ISO 8601（须带时区偏移）。';

/* ------------------------------------------------------------- 餐禅 */

/**
 * 对外暴露的工具清单，供 /api/meta 自描述使用。
 *
 * 新增工具时请同步这里——meta 是 AI 判断「这个服务能干什么」的第一个入口，
 * 漏登记会让客户端以为该能力不存在。
 */
export const TOOL_NAMES = [
  'list_events',
  'get_event',
  'find_conflicts',
  'list_trash',
  'create_event',
  'update_event',
  'delete_event',
  'restore_event',
  'purge_event',
  'empty_trash',
  'batch_events',
  'list_calendars',
  'create_calendar',
  'update_calendar',
  'delete_calendar',
  'get_settings',
  'update_settings',
] as const;

export function registerTools(server: McpServer, userId: string): void {
  /* ─────────────── 读：日程 ─────────────── */

  server.registerTool(
    'list_events',
    {
      description:
        '查询日程列表。默认返回当前话题下的正常日程（不含回收站）。' + WINDOW_HINT,
      inputSchema: z.object({
        window: windowEnum.optional().describe('相对时间窗口，与 from/to 二选一'),
        from: z.string().optional().describe('绝对起始时间，ISO 8601 带偏移；优先于 window'),
        to: z.string().optional().describe('绝对结束时间，ISO 8601 带偏移；必须晚于 from'),
        q: z.string().optional().describe('关键词，匹配标题/描述/地点'),
        calendarId: z.string().optional().describe('只取某个日历分组；分组 id 用 list_calendars 获取'),
        deleted: z.boolean().optional().describe('true 时查回收站，默认 false'),
        limit: z.number().int().min(1).max(500).optional().describe('返回条数上限'),
        offset: z.number().int().min(0).optional().describe('跳过前 N 条，用于翻页'),
      }),
    },
    async (input) => {
      try {
        const query: Record<string, unknown> = {
          window: input.window,
          from: input.from,
          to: input.to,
          q: input.q,
          calendarId: input.calendarId,
          deleted: input.deleted ?? false,
          limit: input.limit,
          offset: input.offset,
        };
        for (const k of Object.keys(query)) if (query[k] === undefined) delete query[k];

        const opts = parseListOptions(query);
        // buildListFilters 内部会按 listQuerySchema 校验并解析 window
        const filters = buildListFilters(userId, query);
        const events = await repoEvent.listEvents({ ...filters, ...opts });
        const total = await repoEvent.countEvents(filters);
        const range = resolveRange(query);

        return json({
          count: events.length,
          total,
          limit: opts.limit,
          offset: opts.offset ?? 0,
          resolvedRange: range.resolved,
          events,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'get_event',
    {
      description: '读取单条日程的完整信息。id 必须是真实 id，不接受 dryrun_ 前缀的临时 id。',
      inputSchema: z.object({ id: z.string().min(1).describe('日程 id') }),
    },
    async (input) => {
      try {
        if (input.id.startsWith('dryrun_')) {
          throw new ApiError(400, 'INVALID_REQUEST', 'dryrun_ 前缀的是试运行临时 id，不是真实数据');
        }
        const event = await repoEvent.getEvent(userId, input.id);
        if (!event) throw notFound(`日程不存在：${input.id}`);
        return json({ event });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'find_conflicts',
    {
      description:
        '扫描某个时间区间内互相重叠的日程，返回每一对冲突及重叠分钟数。' +
        '适合在排新日程之前先摸清哪几段已经撞车。' + WINDOW_HINT,
      inputSchema: z.object({
        window: windowEnum.optional().describe('相对时间窗口'),
        from: z.string().optional().describe('绝对起始时间'),
        to: z.string().optional().describe('绝对结束时间'),
      }),
    },
    async (input) => {
      try {
        const query: Record<string, unknown> = {};
        if (input.window) query.window = input.window;
        if (input.from) query.from = input.from;
        if (input.to) query.to = input.to;

        const range = resolveRange(query);
        const events = await repoEvent.listEvents({
          userId,
          from: range.from,
          to: range.to,
          limit: 500,
        });
        const pairs = findOverlapPairs(events);
        return json({
          count: pairs.length,
          scanned: events.length,
          resolvedRange: range.resolved,
          conflicts: pairs,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'list_trash',
    {
      description: '列出回收站里的日程。用户说「我删错了」时先看这里，而不是重新创建一条。',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(500).optional().describe('返回条数上限'),
      }),
    },
    async (input) => {
      try {
        const events = await repoEvent.listEvents({
          userId,
          deleted: true,
          limit: input.limit ?? 100,
          order: 'desc',
        });
        const total = await repoEvent.countEvents({ userId, deleted: true });
        return json({
          count: events.length,
          total,
          note: '恢复用 restore_event（可恢复）；purge_event 与 empty_trash 不可恢复。',
          events,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  /* ─────────────── 写：日程 ─────────────── */

  server.registerTool(
    'create_event',
    {
      description:
        '创建日程。' +
        '必须先不带 dry_run:false 调用一次得到预览（默认就是试运行），' +
        '把时间段与任何 warnings（尤其 TIME_CONFLICT）展示给用户、拿到明确同意后，' +
        '再用相同参数并显式传 dry_run:false 真正创建。' +
        '重复日程（rrule）暂不支持，遇到周期性需求改为逐条创建。',
      inputSchema: z.object({
        title: z.string().min(1).describe('日程标题'),
        start: z.string().describe('开始时间，ISO 8601 带偏移，例 2026-10-12T14:00:00+08:00'),
        end: z.string().describe('结束时间，必须晚于 start；全天日程只写日期即可'),
        allDay: z.boolean().optional().describe('全天日程'),
        description: z.string().optional(),
        location: z.string().optional(),
        color: colorEnum.optional(),
        calendarId: z.string().optional().describe('目标分组 id；省略则落到默认分组'),
        timezone: z.string().optional().describe('IANA 时区名，缺省取服务端配置'),
        onConflict: z
          .enum([...ON_CONFLICT] as [string, ...string[]])
          .optional()
          .describe('allow=照写并警告（默认）；reject=有冲突就报 CONFLICT_REJECTED'),
        idempotencyKey: z.string().optional().describe('幂等键，重试同一意图时传相同值避免重复创建'),
        dryRun: z
          .boolean()
          .optional()
          .describe('试运行。默认 true，只预览不落库；显式传 false 才会真正创建'),
      }),
    },
    async (input) => {
      try {
        const dryRun = input.dryRun ?? true;
        const onConflict = input.onConflict ?? 'allow';
        const body = {
          title: input.title,
          start: input.start,
          end: input.end,
          allDay: input.allDay,
          description: input.description,
          location: input.location,
          color: input.color,
          calendarId: input.calendarId,
          timezone: input.timezone,
        };
        for (const k of Object.keys(body)) {
          if ((body as Record<string, unknown>)[k] === undefined) {
            delete (body as Record<string, unknown>)[k];
          }
        }

        if (input.idempotencyKey) {
          const cached = await repoEvent.getIdempotent(userId, input.idempotencyKey);
          if (cached) {
            return json({ idempotentReplay: true, result: cached.response });
          }
        }

        const times = normalizeTimes(body as never);
        const calendarId = await repoCalendar.resolveCalendarId(userId, input.calendarId);
        const warnings = await detectWarnings(userId, times, input.title);
        if (onConflict === 'reject' && warnings.some((w: Warning) => w.code === 'TIME_CONFLICT')) {
          throw conflictRejected(
            '该时间段已有日程，且 onConflict=reject',
            '改用 onConflict=allow 强制创建，或先查冲突项让用户确认。',
          );
        }

        if (dryRun) {
          const projected = projectNew(body as never, times, calendarId, userId);
          return json({
            dryRun: true,
            result: projected,
            changes: { before: null, after: projected },
            warnings,
            nextStep: '把将要发生的变化与 warnings 展示给用户，得到明确同意后传 dry_run:false 执行。',
          });
        }

        const created = await repoEvent.insertEvent({
          userId,
          start: times.start,
          end: times.end,
          input: body as never,
          calendarId,
        });
        const payload = { dryRun: false, result: created, changes: { before: null, after: created }, warnings };
        if (input.idempotencyKey) {
          await repoEvent.saveIdempotent(userId, input.idempotencyKey, created.id, payload as never);
        }
        return json(payload);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'update_event',
    {
      description:
        '局部更新日程：只传要改的字段，其余保持原样。' +
        '推荐只改时间，不要顺手覆盖标题、地点、分组等用户明确给过的字段。' +
        '同样遵循「先试运行、给用户看、再 dry_run:false」的流程。',
      inputSchema: z.object({
        id: z.string().min(1).describe('日程 id'),
        title: z.string().optional(),
        start: z.string().optional().describe('新的开始时间；改时间时通常要与 end 一起给'),
        end: z.string().optional().describe('新的结束时间，必须晚于 start'),
        allDay: z.boolean().optional(),
        description: z.string().optional(),
        location: z.string().optional(),
        color: colorEnum.optional(),
        calendarId: z.string().optional().describe('换分组；分组 id 用 list_calendars 获取'),
        timezone: z.string().optional(),
        expectedVersion: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('乐观锁：带上读到的 version，若期间被改过会报 VERSION_CONFLICT'),
        onConflict: onConflictEnum.optional(),
        dryRun: z.boolean().optional().describe('试运行，默认 true'),
      }),
    },
    async (input) => {
      try {
        const dryRun = input.dryRun ?? true;
        const onConflict = input.onConflict ?? 'allow';

        const current = await repoEvent.getEvent(userId, input.id);
        if (!current) throw notFound(`日程不存在：${input.id}`);
        if (input.expectedVersion !== undefined && current.version !== input.expectedVersion) {
          throw versionConflict(input.expectedVersion, current.version);
        }

        const patch: Record<string, unknown> = {};
        for (const k of [
          'title',
          'start',
          'end',
          'allDay',
          'description',
          'location',
          'color',
          'calendarId',
          'timezone',
        ] as const) {
          if (input[k] !== undefined) patch[k] = input[k];
        }
        if (Object.keys(patch).length === 0) {
          throw new ApiError(400, 'VALIDATION_FAILED', '至少需要提供一个待更新字段');
        }

        const projected = projectEvent(current, patch as never);
        if (input.calendarId !== undefined) {
          projected.calendarId = await repoCalendar.resolveCalendarId(userId, input.calendarId);
        }
        const times = resolvePatchTimes(projected, patch as never);
        const warnings = await detectWarnings(userId, times, projected.title, current.id);
        if (onConflict === 'reject' && warnings.some((w: Warning) => w.code === 'TIME_CONFLICT')) {
          throw conflictRejected('更新后会产生时间冲突，且 onConflict=reject');
        }

        if (dryRun) {
          return json({
            dryRun: true,
            result: projected,
            changes: { before: current, after: projected },
            warnings,
            nextStep: '展示给用户确认后，传 dry_run:false 执行。',
          });
        }

        let updated;
        try {
          updated = await repoEvent.updateEventRow({
            userId,
            id: current.id,
            patch: patch as never,
            start: times.start,
            end: times.end,
            expectedVersion: input.expectedVersion,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : '';
          if (msg.startsWith('VERSION_CONFLICT:')) {
            throw versionConflict(input.expectedVersion ?? current.version, Number(msg.split(':')[1]));
          }
          throw err;
        }

        if (JSON.stringify(current) !== JSON.stringify(updated)) {
          // 有实际变化
        } else {
          warnings.push({ code: 'NO_CHANGE', message: '提交的内容与当前日程一致，未产生实际变更' });
        }
        return json({ dryRun: false, result: updated, changes: { before: current, after: updated }, warnings });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'delete_event',
    {
      description:
        '删除日程。默认软删除（进回收站，可用 restore_event 恢复）；mode=hard 为彻底抹除、不可恢复，' +
        '属于高危操作，必须让用户逐条确认后才能用 dry_run:false 执行。',
      inputSchema: z.object({
        id: z.string().min(1).describe('日程 id'),
        mode: z
          .enum([...DELETE_MODES] as [string, ...string[]])
          .optional()
          .describe('soft=进回收站（默认）；hard=彻底删除'),
        dryRun: z.boolean().optional().describe('试运行，默认 true'),
      }),
    },
    async (input) => {
      try {
        const dryRun = input.dryRun ?? true;
        const mode = input.mode ?? 'soft';
        const existing = await repoEvent.getEvent(userId, input.id);
        if (!existing) throw notFound(`日程不存在：${input.id}`);

        if (dryRun) {
          return json({
            dryRun: true,
            result: existing,
            changes: { before: existing, after: null },
            warnings: [
              {
                code: 'DELETE_MODE',
                message: mode === 'hard' ? '将彻底删除，不可恢复' : '将移入回收站，可恢复',
              },
            ],
            nextStep:
              mode === 'hard'
                ? '这是不可恢复操作。必须逐条列给用户（标题+时间+id）并取得明确同意，再传 dry_run:false。'
                : '把对象展示给用户确认后，传 dry_run:false 执行。',
          });
        }

        const result =
          mode === 'hard'
            ? await repoEvent.hardDeleteEvent(userId, input.id)
            : await repoEvent.softDeleteEvent(userId, input.id);
        if (!result) throw notFound();
        return json({ dryRun: false, result, changes: { before: existing, after: null }, mode });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'restore_event',
    {
      description: '把回收站里的日程恢复回来。用户说「我删错了」时的第一选择。',
      inputSchema: z.object({ id: z.string().min(1).describe('回收站里的日程 id') }),
    },
    async (input) => {
      try {
        const current = await repoEvent.getEvent(userId, input.id);
        if (!current) throw notFound(`日程不存在：${input.id}`);
        if (!current.deletedAt) {
          return json({
            result: current,
            warnings: [{ code: 'NOT_DELETED', message: '该日程不在回收站，无需恢复' }],
          });
        }
        const restored = await repoEvent.restoreEvent(userId, input.id);
        if (!restored) throw notFound();
        return json({ result: restored, changes: { before: current, after: restored } });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'purge_event',
    {
      description:
        '从回收站彻底删除单条日程，不可恢复。高危操作：必须先取得用户明确同意。',
      inputSchema: z.object({
        id: z.string().min(1).describe('回收站里的日程 id'),
        dryRun: z.boolean().optional().describe('试运行，默认 true'),
      }),
    },
    async (input) => {
      try {
        const dryRun = input.dryRun ?? true;
        const current = await repoEvent.getEvent(userId, input.id);
        if (!current) throw notFound(`日程不存在：${input.id}`);
        if (dryRun) {
          return json({
            dryRun: true,
            result: current,
            changes: { before: current, after: null },
            warnings: [{ code: 'DELETE_MODE', message: '将彻底删除，不可恢复' }],
            nextStep: '必须列给用户确认后，传 dry_run:false 执行。',
          });
        }
        await repoEvent.hardDeleteEvent(userId, input.id);
        return json({ dryRun: false, result: current, changes: { before: current, after: null } });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'empty_trash',
    {
      description:
        '清空回收站，不可恢复。最高危操作之一，必须先试运行拿到条数、交给用户确认。' +
        '用户没明确要求时不要执行。',
      inputSchema: z.object({ dryRun: z.boolean().optional().describe('试运行，默认 true') }),
    },
    async (input) => {
      try {
        const dryRun = input.dryRun ?? true;
        const total = await repoEvent.countEvents({ userId, deleted: true });
        if (dryRun) {
          return json({
            dryRun: true,
            wouldDelete: total,
            nextStep: `将清空 ${total} 条。必须让用户明确确认后，再传 dry_run:false。`,
          });
        }
        const removed = await repoEvent.emptyTrash(userId);
        return json({ dryRun: false, removed });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'batch_events',
    {
      description:
        '批量增改删，单次最多 50 条，超出要拆批。' +
        '一次对话里含多个互不相关的日程改动时才用它；只有一处改动请逐条调 update_event，出错好定位。' +
        'atomic=true 时任一子操作失败即整批回滚。同样遵循先试运行再执行。',
      inputSchema: z.object({
        operations: z
          .array(
            z.discriminatedUnion('op', [
              z.object({
                op: z.literal('create'),
                data: z.object({
                  title: z.string().min(1),
                  start: z.string(),
                  end: z.string(),
                  allDay: z.boolean().optional(),
                  description: z.string().optional(),
                  location: z.string().optional(),
                  calendarId: z.string().optional(),
                  timezone: z.string().optional(),
                }),
                idempotencyKey: z.string().optional(),
              }),
              z.object({
                op: z.literal('update'),
                id: z.string().min(1),
                data: z.record(z.string(), z.unknown()),
              }),
              z.object({
                op: z.literal('delete'),
                id: z.string().min(1),
                mode: deleteModeEnum.optional(),
              }),
            ]),
          )
          .min(1)
          .max(50),
        atomic: z.boolean().optional().describe('true=任一失败整批回滚；默认 false=逐条执行'),
        onConflict: onConflictEnum.optional(),
        dryRun: z.boolean().optional().describe('试运行，默认 true'),
      }),
    },
    async (input) => {
      try {
        const dryRun = input.dryRun ?? true;
        const atomic = input.atomic ?? false;
        const onConflict = input.onConflict ?? 'allow';
        const results: Array<Record<string, unknown>> = [];
        const undo: Array<() => Promise<void>> = [];

        if (atomic) {
          for (const [index, op] of input.operations.entries()) {
            if (op.op === 'create') continue;
            const existing = await repoEvent.getEvent(userId, op.id);
            if (!existing) {
              throw new ApiError(
                400,
                'VALIDATION_FAILED',
                `atomic 批量：第 ${index} 个操作的目标不存在（id=${op.id}）`,
                { hint: '改回 atomic=false 可跳过失败项继续执行其余操作。' },
              );
            }
          }
        }

        for (const [index, op] of input.operations.entries()) {
          try {
            if (op.op === 'create') {
              const cached = op.idempotencyKey
                ? await repoEvent.getIdempotent(userId, op.idempotencyKey)
                : null;
              if (cached) {
                results.push({ index, op: 'create', ok: true, idempotentReplay: true, data: cached.response });
                continue;
              }
              const times = normalizeTimes(op.data as never);
              const calendarId = await repoCalendar.resolveCalendarId(userId, op.data.calendarId);
              const warnings = await detectWarnings(userId, times, op.data.title);
              if (onConflict === 'reject' && warnings.some((w: Warning) => w.code === 'TIME_CONFLICT')) {
                throw conflictRejected('存在时间冲突且 onConflict=reject');
              }
              if (dryRun) {
                const projected = projectNew(op.data as never, times, calendarId, userId);
                results.push({
                  index,
                  op: 'create',
                  ok: true,
                  data: { dryRun: true, changes: { before: null, after: projected }, warnings },
                });
                continue;
              }
              const created = await repoEvent.insertEvent({
                userId,
                start: times.start,
                end: times.end,
                input: op.data as never,
                calendarId,
              });
              undo.push(async () => {
                await repoEvent.hardDeleteEvent(userId, created.id);
              });
              const payload = { dryRun: false, result: created, warnings };
              if (op.idempotencyKey) {
                await repoEvent.saveIdempotent(userId, op.idempotencyKey, created.id, payload as never);
              }
              results.push({ index, op: 'create', ok: true, data: payload });
              continue;
            }

            if (op.op === 'update') {
              const current = await repoEvent.getEvent(userId, op.id);
              if (!current) throw notFound(`日程不存在：${op.id}`);
              const projected = projectEvent(current, op.data as never);
              if ((op.data as Record<string, unknown>).calendarId !== undefined) {
                projected.calendarId = await repoCalendar.resolveCalendarId(
                  userId,
                  (op.data as Record<string, unknown>).calendarId as string,
                );
              }
              const times = resolvePatchTimes(projected, op.data as never);
              const warnings = await detectWarnings(userId, times, projected.title, op.id);
              if (onConflict === 'reject' && warnings.some((w: Warning) => w.code === 'TIME_CONFLICT')) {
                throw conflictRejected('存在时间冲突且 onConflict=reject');
              }
              if (dryRun) {
                results.push({
                  index,
                  op: 'update',
                  ok: true,
                  data: { dryRun: true, changes: { before: current, after: projected }, warnings },
                });
                continue;
              }
              const updated = await repoEvent.updateEventRow({
                userId,
                id: op.id,
                patch: op.data as never,
                start: times.start,
                end: times.end,
              });
              undo.push(async () => {
                await repoEvent.restoreSnapshot(current);
              });
              results.push({
                index,
                op: 'update',
                ok: true,
                data: { dryRun: false, changes: { before: current, after: updated }, warnings },
              });
              continue;
            }

            // delete
            const existing = await repoEvent.getEvent(userId, op.id);
            if (!existing) throw notFound(`日程不存在：${op.id}`);
            const mode = op.mode ?? 'soft';
            if (dryRun) {
              results.push({
                index,
                op: 'delete',
                ok: true,
                mode,
                data: { dryRun: true, changes: { before: existing, after: null }, warnings: [] },
              });
              continue;
            }
            if (mode === 'hard') {
              await repoEvent.hardDeleteEvent(userId, op.id);
            } else {
              await repoEvent.softDeleteEvent(userId, op.id);
            }
            undo.push(async () => {
              await repoEvent.restoreSnapshot(existing);
            });
            results.push({
              index,
              op: 'delete',
              ok: true,
              mode,
              data: { dryRun: false, changes: { before: existing, after: null }, warnings: [] },
            });
          } catch (err) {
            if (atomic) {
              for (const fn of undo.reverse()) await fn();
              throw err;
            }
            const apiErr =
              err instanceof ApiError ? err : new ApiError(500, 'INTERNAL_ERROR', String(err));
            results.push({
              index,
              op: op.op,
              ok: false,
              error: { code: apiErr.code, message: apiErr.message, details: apiErr.details, hint: apiErr.hint },
            });
          }
        }

        const succeeded = results.filter((r) => r.ok).length;
        return json({
          dryRun,
          atomic,
          requested: input.operations.length,
          succeeded,
          failed: input.operations.length - succeeded,
          nextStep: dryRun ? '确认无误后传 dry_run:false 真正执行。' : undefined,
          results,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  /* ─────────────── 日历分组 ─────────────── */

  server.registerTool(
    'list_calendars',
    {
      description:
        '列出当前用户的全部日历分组。新建日程需要分组 id 时先调它。' +
        '返回结果里的 isDefault=true 那个是默认分组，不可删除。',
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const calendars = await repoCalendar.listCalendars(userId);
        return json({ count: calendars.length, calendars });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'create_calendar',
    {
      description: '新建日历分组。每个用户有数量上限，超了会报 FORBIDDEN。',
      inputSchema: z.object({
        name: z.string().min(1).max(40).describe('分组名'),
        color: colorEnum.optional(),
        visible: z.boolean().optional().describe('是否在侧栏显示，默认 true'),
      }),
    },
    async (input) => {
      try {
        const created = await repoCalendar.createCalendar(userId, input);
        return json({ calendar: created });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'update_calendar',
    {
      description: '修改日历分组：改名、换色、切换侧栏显隐、调整排序。至少提供一个字段。',
      inputSchema: z.object({
        id: z.string().min(1).describe('分组 id'),
        name: z.string().min(1).max(40).optional(),
        color: colorEnum.optional(),
        visible: z.boolean().optional(),
        sortOrder: z.number().int().min(0).max(999).optional(),
      }),
    },
    async (input) => {
      try {
        const { id, ...patch } = input;
        for (const k of Object.keys(patch)) {
          if ((patch as Record<string, unknown>)[k] === undefined) {
            delete (patch as Record<string, unknown>)[k];
          }
        }
        if (Object.keys(patch).length === 0) {
          throw new ApiError(400, 'VALIDATION_FAILED', '至少需要提供一个待更新字段');
        }
        const updated = await repoCalendar.updateCalendar(userId, id, patch);
        return json({ calendar: updated });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'delete_calendar',
    {
      description:
        '删除日历分组。组内日程不会跟着消失，会自动迁入默认分组。默认分组本身不可删除。',
      inputSchema: z.object({
        id: z.string().min(1).describe('分组 id'),
        dryRun: z.boolean().optional().describe('试运行，默认 true'),
      }),
    },
    async (input) => {
      try {
        const dryRun = input.dryRun ?? true;
        const current = await repoCalendar.getCalendar(userId, input.id);
        if (!current) throw notFound('日历分组不存在');
        if (current.isDefault) {
          throw new ApiError(400, 'INVALID_REQUEST', '默认分组不能删除', {
            hint: '可以改它的名字；要精简就删别的分组。',
          });
        }
        const moved = await repoEvent.countEvents({ userId, calendarIds: [input.id] });
        if (dryRun) {
          return json({
            dryRun: true,
            calendar: current,
            wouldMoveEvents: moved,
            nextStep: `确认后传 dry_run:false。届时 ${moved} 条日程会迁入默认分组。`,
          });
        }
        const result = await repoCalendar.deleteCalendar(userId, input.id);
        return json({ dryRun: false, deleted: result.deleted, movedEvents: result.movedEvents });
      } catch (err) {
        return fail(err);
      }
    },
  );

  /* ─────────────── 界面设置 ─────────────── */

  server.registerTool(
    'get_settings',
    {
      description: '读取当前用户的界面偏好：配色、12/24 小时制、周起始日、默认视图、侧栏展开。',
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const result = await repoSettings.getSettings(userId);
        return json(result);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'update_settings',
    {
      description:
        '修改界面偏好，局部更新，只传要改的字段。' +
        '注意：日程的颜色用 update_event 的 color 字段，跟这里的 theme（整体底板配色）不是一回事。',
      inputSchema: z.object({
        theme: themeEnum.optional().describe('day 白日 / night 黑夜'),
        timeFormat: z.enum(['12-hour', '24-hour']).optional(),
        firstDayOfWeek: z.enum(['monday', 'sunday']).optional(),
        defaultView: viewEnum.optional(),
        sidebarOpen: z.boolean().optional(),
      }),
    },
    async (input) => {
      try {
        const patch: Record<string, unknown> = {};
        for (const k of Object.keys(input)) {
          if ((input as Record<string, unknown>)[k] !== undefined) patch[k] = (input as Record<string, unknown>)[k];
        }
        if (Object.keys(patch).length === 0) {
          throw new ApiError(400, 'VALIDATION_FAILED', '至少需要提供一个待更新字段');
        }
        const settings = await repoSettings.updateSettings(userId, patch as never);
        return json({ settings, note: '改完用户刷新页面即可生效。' });
      } catch (err) {
        return fail(err);
      }
    },
  );
}

/** 需要用到但没直接从 services 暴露的类型占位，保持 import 单一来源。 */
export type { Warning };
