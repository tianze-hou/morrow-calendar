/**
 * 日程业务逻辑层（service）。
 *
 * 这一层刻意与 Express 无关：输入输出都是普通 JS 值与自定义类型，不碰 req / res，
 * 也不负责 HTTP 状态码。这样 REST 路由和 MCP 工具走的是同一份规则
 *（时间归一化、冲突检测、变更投影），不会出现两套实现各自漂移。
 *
 * 层次：routes / mcp → services（本文件）→ repository → db
 */
import crypto from 'node:crypto';
import type { CreateEventInput, ScheduleEvent, WriteResult } from '../../../shared/types';
import { config } from '../config';
import { badRequest } from '../lib/errors';
import { dayjs, formatInTz, parseInstant, resolveWindow, toUtcIso } from '../lib/time';
import * as repo from '../repository/events';
import { listQuerySchema, toValidationError, writeQuerySchema } from '../validation';

/** 写操作返回的警告项。 */
export type Warning = NonNullable<WriteResult<unknown>['warnings']>[number];

/** 归一化后的时间：一律是 Date，配合 tz 便于回显。 */
export interface NormalizedTimes {
  start: Date;
  end: Date;
  tz: string;
  allDay: boolean;
}

/** 查询区间解析结果，含「这次解析到底用了什么」的溯源信息。 */
export interface RangeResolution {
  from?: string;
  to?: string;
  /** 供调用方（人或模型）核对实际生效的区间，均为 UTC ISO。 */
  resolved: { from?: string; to?: string; source: 'explicit' | 'window' | 'none' };
}

export interface ListFilters {
  userId: string;
  from?: string;
  to?: string;
  q?: string;
  calendarId?: string;
  calendarIds?: string[];
  deleted: boolean;
}

/* ---------------------------------------------------------- 参数归一化 */

/** query 参数同时接受 snake_case 与 camelCase（AI 两种风格都可能用）。 */
export function camelizeQuery(query: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query)) {
    out[key.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase())] = value;
  }
  return out;
}

/** 逗号分隔的多个分组 id。显式传空串表示「没有任何可见分组」，会返回空集。 */
export function parseCalendarIds(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 解析写操作共用的 query：dry_run / on_conflict / mode。 */
export function parseWriteQuery(query: Record<string, unknown>) {
  const parsed = writeQuerySchema.safeParse(query);
  if (!parsed.success) toValidationError(parsed.error);
  return {
    dryRun: parsed.data.dryRun ?? false,
    onConflict: parsed.data.onConflict ?? 'allow',
    mode: parsed.data.mode ?? 'soft',
  };
}

/** 解析 If-Match 头（支持 5 / "5" / W/"5"）。 */
export function parseIfMatch(header: string | undefined): number | undefined {
  if (!header) return undefined;
  const cleaned = header.replace(/^W\//, '').replace(/"/g, '').trim();
  const n = Number(cleaned);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/* ------------------------------------------------------------ 查询区间 */

/**
 * 把 query 变成实际查询边界。
 * 显式 from/to 优先，其次 window 关键字，都没有就不限。
 */
export function resolveRange(query: Record<string, unknown>): RangeResolution {
  const parsed = listQuerySchema.safeParse(query);
  if (!parsed.success) toValidationError(parsed.error);

  const tz = config.timezone;
  const { from, to, window } = parsed.data;

  if (from || to) {
    const fromDate = from ? parseInstant(from, tz) : undefined;
    const toDate = to ? parseInstant(to, tz) : undefined;
    if (fromDate && toDate && toDate.getTime() <= fromDate.getTime()) {
      throw badRequest('to 必须晚于 from', '交换两个参数或改用 window=today 之类的相对窗口。');
    }
    return {
      from: fromDate ? toUtcIso(fromDate) : undefined,
      to: toDate ? toUtcIso(toDate) : undefined,
      resolved: {
        from: fromDate ? toUtcIso(fromDate) : undefined,
        to: toDate ? toUtcIso(toDate) : undefined,
        source: 'explicit',
      },
    };
  }

  if (window) {
    const r = resolveWindow(window, tz);
    return { from: r.from, to: r.to, resolved: { ...r, source: 'window' } };
  }

  return { resolved: { source: 'none' } };
}

/** 组装列表查询条件。自动限定为指定用户，越权访问他人数据是不可能的。 */
export function buildListFilters(userId: string, query: Record<string, unknown>): ListFilters {
  const parsed = listQuerySchema.safeParse(query);
  if (!parsed.success) toValidationError(parsed.error);

  const range = resolveRange(query);
  return {
    userId,
    from: range.from,
    to: range.to,
    q: parsed.data.q,
    calendarId: parsed.data.calendarId,
    calendarIds: parseCalendarIds(parsed.data.calendarIds),
    deleted: parsed.data.deleted ?? false,
  };
}

/** 把列表查询的余下参数（分页与排序）单独拆出来。 */
export function parseListOptions(query: Record<string, unknown>) {
  const parsed = listQuerySchema.safeParse(query);
  if (!parsed.success) toValidationError(parsed.error);
  return {
    limit: parsed.data.limit,
    offset: parsed.data.offset,
    order: parsed.data.order,
  };
}

/* -------------------------------------------------------------- 时间 */

/**
 * 归一化起止时间。全天日程会被摊到当日 00:00:00–23:59:59。
 * end 必须晚于 start，否则抛 INVALID_REQUEST。
 */
export function normalizeTimes(input: CreateEventInput): NormalizedTimes {
  const tz = input.timezone ?? config.timezone;
  let start = parseInstant(input.start, tz);
  let end = parseInstant(input.end, tz);
  const allDay = input.allDay ?? false;

  if (allDay) {
    // 全天日程：start 归到当日 00:00:00，end 归到当日 23:59:59（闭区间语义，便于渲染）
    start = dayjs(start).tz(tz).startOf('day').toDate();
    end = dayjs(end).tz(tz).endOf('day').toDate();
  }

  if (end.getTime() <= start.getTime()) {
    throw badRequest(
      'end 必须晚于 start',
      '检查起止时间；全天日程只需传日期，服务端会自动归一化。',
    );
  }

  return { start, end, tz, allDay };
}

/**
 * 更新时决定用哪套时间：patch 里带了任何时间字段就按新值重新归一化，
 * 否则沿用原值。REST 的 PUT/PATCH 与 MCP 的 update 共用这条规则。
 */
export function resolvePatchTimes(projected: ScheduleEvent, patch: Partial<CreateEventInput>): NormalizedTimes {
  if (patch.start || patch.end || patch.allDay !== undefined || patch.timezone) {
    return normalizeTimes({
      title: projected.title,
      start: projected.start,
      end: projected.end,
      allDay: projected.allDay,
      timezone: projected.timezone,
    });
  }
  return {
    start: new Date(projected.start),
    end: new Date(projected.end),
    tz: projected.timezone,
    allDay: projected.allDay,
  };
}

/* ------------------------------------------------------------ 变更投影 */

/** 把 patch 叠到现有日程上，得到「改完之后会是什么样」。不落库。 */
export function projectEvent(base: ScheduleEvent, patch: Partial<CreateEventInput>): ScheduleEvent {
  const merged = { ...base, ...patch } as ScheduleEvent;
  if (patch.start || patch.end || patch.timezone || patch.allDay !== undefined) {
    const tz = patch.timezone ?? base.timezone;
    const times = normalizeTimes({
      title: merged.title,
      start: patch.start ?? base.start,
      end: patch.end ?? base.end,
      allDay: patch.allDay ?? base.allDay,
      timezone: tz,
    });
    merged.timezone = tz;
    merged.allDay = times.allDay;
    merged.start = formatInTz(times.start, tz);
    merged.end = formatInTz(times.end, tz);
  }
  return merged;
}

/**
 * 试运行时的新建投影：不落库，但要长得和真实对象一样，调用方才好比对。
 * id 带 dryrun_ 前缀，防止有人把它当真 id 回写。
 */
export function projectNew(
  input: CreateEventInput,
  times: NormalizedTimes,
  calendarId: string,
  ownerId: string,
): ScheduleEvent {
  return {
    id: `dryrun_${crypto.randomUUID().slice(0, 8)}`,
    ownerId,
    title: input.title,
    start: formatInTz(times.start, times.tz),
    end: formatInTz(times.end, times.tz),
    allDay: times.allDay,
    description: input.description,
    location: input.location,
    color: input.color,
    calendarId,
    timezone: times.tz,
    rrule: null,
    exdates: [],
    deletedAt: null,
    version: 1,
    createdAt: formatInTz(new Date(), times.tz),
    updatedAt: formatInTz(new Date(), times.tz),
  };
}

/* ------------------------------------------------------------ 冲突检测 */

/**
 * 写操作前的体检：时间冲突 + 疑似重复。
 * 返回的是「警告」而非「错误」——要不要因此中止，由调用方的 on_conflict 策略决定。
 */
export async function detectWarnings(
  userId: string,
  times: NormalizedTimes,
  title: string,
  excludeId?: string,
): Promise<Warning[]> {
  const warnings: Warning[] = [];

  const conflicts = await repo.findConflicts(userId, times.start, times.end, excludeId);
  if (conflicts.length > 0) {
    warnings.push({
      code: 'TIME_CONFLICT',
      message: `与 ${conflicts.length} 条日程时间重叠`,
      conflicts,
    });
  }

  const duplicates = await repo.findDuplicates(userId, title, times.start, times.end);
  const dup = duplicates.find((d) => d.id !== excludeId);
  if (dup) {
    warnings.push({
      code: 'DUPLICATE_SUSPECTED',
      message: `已存在同标题同时间的日程（id=${dup.id}）`,
    });
  }

  return warnings;
}

/** 两两比对，找出互相重叠的日程对及重叠分钟数。 */
export function findOverlapPairs(
  events: ScheduleEvent[],
): Array<{ a: ScheduleEvent; b: ScheduleEvent; overlapMinutes: number }> {
  const pairs: Array<{ a: ScheduleEvent; b: ScheduleEvent; overlapMinutes: number }> = [];
  for (let i = 0; i < events.length; i += 1) {
    for (let j = i + 1; j < events.length; j += 1) {
      const a = events[i];
      const b = events[j];
      const overlapMs =
        Math.min(new Date(a.end).getTime(), new Date(b.end).getTime()) -
        Math.max(new Date(a.start).getTime(), new Date(b.start).getTime());
      if (overlapMs > 0) {
        pairs.push({ a, b, overlapMinutes: Math.round(overlapMs / 60000) });
      }
    }
  }
  return pairs;
}

/* ---------------------------------------------------------- 组合读取 */

/** 列表查询：一次性返回数据、总数与实际生效的区间。 */
export async function listEventsDetailed(userId: string, query: Record<string, unknown>) {
  const filters = buildListFilters(userId, query);
  const options = parseListOptions(query);
  const events = await repo.listEvents({ ...filters, ...options });
  const total = await repo.countEvents(filters);
  const range = { resolved: { source: 'none' as const, from: filters.from, to: filters.to } };
  return {
    events,
    total,
    meta: {
      count: events.length,
      total,
      limit: options.limit ?? config.limits.defaultLimit,
      offset: options.offset ?? 0,
      timezone: config.timezone,
      scope: { ownerId: userId, deleted: filters.deleted },
      resolvedRange: range.resolved,
    },
  };
}
