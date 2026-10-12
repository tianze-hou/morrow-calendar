import { Router, type Request, type Response, type NextFunction } from 'express';
import type { CreateEventInput, ScheduleEvent, WriteResult } from '../../../shared/types';
import { config } from '../config';
import {
  ApiError,
  badRequest,
  conflictRejected,
  notFound,
  versionConflict,
} from '../lib/errors';
import { parseInstant, resolveWindow, formatInTz, toUtcIso, dayjs } from '../lib/time';
import { currentUser } from '../middleware/auth';
import * as repo from '../repository/events';
import { resolveCalendarId } from '../repository/calendars';
import {
  batchSchema,
  createEventSchema,
  listQuerySchema,
  replaceEventSchema,
  updateEventSchema,
  writeQuerySchema,
  toValidationError,
} from '../validation';

const router = Router();

/** 统一异步错误捕获，避免 express 4 丢失 async 异常。 */
const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

const ok = <T>(res: Response, data: T, meta?: Record<string, unknown>) =>
  res.json(meta ? { ok: true, data, meta } : { ok: true, data });

/* ------------------------------------------------------------------ helpers */

/** query 参数同时接受 snake_case 与 camelCase（AI 两种风格都可能用）。 */
function camelizeQuery(query: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query)) {
    out[key.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase())] = value;
  }
  return out;
}

function parseCalendarIds(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list;
}

interface RangeResolution {
  from?: string;
  to?: string;
  /** 供 AI 校验：最终实际生效的区间（UTC ISO）。 */
  resolved: { from?: string; to?: string; source: 'explicit' | 'window' | 'none' };
}

function resolveRange(query: Record<string, unknown>): RangeResolution {
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

interface NormalizedTimes {
  start: Date;
  end: Date;
  tz: string;
  allDay: boolean;
}

function normalizeTimes(input: CreateEventInput): NormalizedTimes {
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

type Warning = NonNullable<WriteResult<unknown>['warnings']>[number];

async function detectWarnings(
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

function parseWriteQuery(query: Record<string, unknown>) {
  const parsed = writeQuerySchema.safeParse(query);
  if (!parsed.success) toValidationError(parsed.error);
  return {
    dryRun: parsed.data.dryRun ?? false,
    onConflict: parsed.data.onConflict ?? 'allow',
    mode: parsed.data.mode ?? 'soft',
  };
}

/** 解析 If-Match 头（支持 5 / "5" / W/"5"）。 */
function parseIfMatch(header: string | undefined): number | undefined {
  if (!header) return undefined;
  const cleaned = header.replace(/^W\//, '').replace(/"/g, '').trim();
  const n = Number(cleaned);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

function projectEvent(base: ScheduleEvent, patch: Partial<CreateEventInput>): ScheduleEvent {
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

/** 试运行时的投影对象：不落库，但要长得和真实对象一样，AI 才好比对。 */
function projectNew(
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

/* ------------------------------------------------------------------- routes */

/** GET /api/events —— 列表查询（自动限定为当前用户） */
router.get(
  '/',
  wrap(async (req, res) => {
    const user = currentUser(req);
    const query = listQuerySchema.safeParse(camelizeQuery(req.query as Record<string, unknown>));
    if (!query.success) toValidationError(query.error);

    const range = resolveRange(camelizeQuery(req.query as Record<string, unknown>));
    const filters = {
      userId: user.id,
      from: range.from,
      to: range.to,
      q: query.data.q,
      calendarId: query.data.calendarId,
      calendarIds: parseCalendarIds(query.data.calendarIds),
      deleted: query.data.deleted ?? false,
    };
    const events = await repo.listEvents({
      ...filters,
      limit: query.data.limit,
      offset: query.data.offset,
      order: query.data.order,
    });
    const total = await repo.countEvents(filters);

    ok(res, events, {
      count: events.length,
      total,
      limit: query.data.limit ?? config.limits.defaultLimit,
      offset: query.data.offset ?? 0,
      timezone: config.timezone,
      scope: { ownerId: user.id, deleted: filters.deleted },
      resolvedRange: range.resolved,
    });
  }),
);

/** GET /api/events/trash —— 回收站列表 */
router.get(
  '/trash',
  wrap(async (req, res) => {
    const user = currentUser(req);
    const range = resolveRange(camelizeQuery(req.query as Record<string, unknown>));
    const events = await repo.listEvents({
      userId: user.id,
      from: range.from,
      to: range.to,
      deleted: true,
      limit: config.limits.maxLimit,
      order: 'desc',
    });
    const total = await repo.countEvents({ userId: user.id, deleted: true });
    ok(res, events, {
      count: events.length,
      total,
      note: '回收站不会自动清空，确认无误后用 POST /api/events/trash/empty 清空，或逐条彻底删除。',
    });
  }),
);

/** POST /api/events/trash/empty —— 清空回收站（不可恢复） */
router.post(
  '/trash/empty',
  wrap(async (req, res) => {
    const user = currentUser(req);
    const { dryRun } = parseWriteQuery(camelizeQuery(req.query as Record<string, unknown>));
    const total = await repo.countEvents({ userId: user.id, deleted: true });
    if (dryRun) {
      ok(res, { dryRun: true, wouldDelete: total });
      return;
    }
    const removed = await repo.emptyTrash(user.id);
    ok(res, { dryRun: false, removed });
  }),
);

/** GET /api/events/conflicts —— 扫描区间内互相重叠的日程 */
router.get(
  '/conflicts',
  wrap(async (req, res) => {
    const user = currentUser(req);
    const range = resolveRange(camelizeQuery(req.query as Record<string, unknown>));
    const events = await repo.listEvents({
      userId: user.id,
      from: range.from,
      to: range.to,
      limit: config.limits.maxLimit,
    });

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

    ok(res, pairs, { count: pairs.length, scanned: events.length, resolvedRange: range.resolved });
  }),
);

/** POST /api/events/batch —— 批量增改删（上限 maxBatchSize） */
router.post(
  '/batch',
  wrap(async (req, res) => {
    const user = currentUser(req);
    const parsed = batchSchema.safeParse(req.body);
    if (!parsed.success) toValidationError(parsed.error);

    const { operations, dryRun = false, atomic = false, onConflict = 'allow' } = parsed.data;
    const results: Array<Record<string, unknown>> = [];
    const undo: Array<() => Promise<void>> = [];

    // atomic 模式：先全量预检，任一不通过则整批拒绝。
    if (atomic) {
      for (const [index, op] of operations.entries()) {
        if (op.op === 'create') continue;
        const existing = await repo.getEvent(user.id, op.id);
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

    for (const [index, op] of operations.entries()) {
      try {
        if (op.op === 'create') {
          const cached = op.idempotencyKey ? await repo.getIdempotent(user.id, op.idempotencyKey) : null;
          if (cached) {
            results.push({ index, op: op.op, ok: true, idempotentReplay: true, data: cached.response });
            continue;
          }

          const times = normalizeTimes(op.data);
          const calendarId = await resolveCalendarId(user.id, op.data.calendarId);
          const warnings = await detectWarnings(user.id, times, op.data.title);
          if (onConflict === 'reject' && warnings.some((w) => w.code === 'TIME_CONFLICT')) {
            throw conflictRejected('存在时间冲突且 onConflict=reject');
          }

          if (dryRun) {
            const projected = projectNew(op.data, times, calendarId, user.id);
            results.push({
              index,
              op: op.op,
              ok: true,
              data: {
                dryRun: true,
                result: projected,
                changes: { before: null, after: projected },
                warnings,
              } satisfies WriteResult<ScheduleEvent>,
            });
            continue;
          }

          const created = await repo.insertEvent({
            userId: user.id,
            start: times.start,
            end: times.end,
            input: op.data,
            calendarId,
          });
          undo.push(async () => {
            await repo.hardDeleteEvent(user.id, created.id);
          });
          const payload: WriteResult<ScheduleEvent> = {
            dryRun: false,
            result: created,
            changes: { before: null, after: created },
            warnings,
          };
          if (op.idempotencyKey) {
            await repo.saveIdempotent(user.id, op.idempotencyKey, created.id, payload);
          }
          results.push({ index, op: op.op, ok: true, data: payload });
          continue;
        }

        if (op.op === 'update') {
          const current = await repo.getEvent(user.id, op.id);
          if (!current) throw notFound(`日程不存在：${op.id}`);
          const projected = projectEvent(current, op.data);
          if (op.data.calendarId !== undefined) {
            projected.calendarId = await resolveCalendarId(user.id, op.data.calendarId);
          }

          const times =
            op.data.start || op.data.end || op.data.allDay !== undefined
              ? normalizeTimes({
                  title: projected.title,
                  start: projected.start,
                  end: projected.end,
                  allDay: projected.allDay,
                  timezone: projected.timezone,
                })
              : {
                  start: new Date(current.start),
                  end: new Date(current.end),
                  tz: current.timezone,
                  allDay: current.allDay,
                };

          const warnings = await detectWarnings(user.id, times, projected.title, op.id);
          if (onConflict === 'reject' && warnings.some((w) => w.code === 'TIME_CONFLICT')) {
            throw conflictRejected('存在时间冲突且 onConflict=reject');
          }

          if (dryRun) {
            results.push({
              index,
              op: op.op,
              ok: true,
              data: {
                dryRun: true,
                result: projected,
                changes: { before: current, after: projected },
                warnings,
              } satisfies WriteResult<ScheduleEvent>,
            });
            continue;
          }

          const snapshot = current;
          const updated = await repo.updateEventRow({
            userId: user.id,
            id: op.id,
            patch: op.data,
            start: times.start,
            end: times.end,
          });
          undo.push(async () => {
            await repo.restoreSnapshot(snapshot);
          });
          results.push({
            index,
            op: op.op,
            ok: true,
            data: {
              dryRun: false,
              result: updated,
              changes: { before: current, after: updated },
              warnings,
            } satisfies WriteResult<ScheduleEvent>,
          });
          continue;
        }

        // delete
        const existing = await repo.getEvent(user.id, op.id);
        if (!existing) throw notFound(`日程不存在：${op.id}`);
        const mode = op.mode ?? 'soft';
        if (dryRun) {
          results.push({
            index,
            op: op.op,
            ok: true,
            data: {
              dryRun: true,
              result: existing,
              changes: { before: existing, after: null },
              warnings: [],
            } satisfies WriteResult<ScheduleEvent>,
            mode,
          });
          continue;
        }
        if (mode === 'hard') {
          await repo.hardDeleteEvent(user.id, op.id);
        } else {
          await repo.softDeleteEvent(user.id, op.id);
        }
        undo.push(async () => {
          await repo.restoreSnapshot(existing);
        });
        results.push({
          index,
          op: op.op,
          ok: true,
          mode,
          data: {
            dryRun: false,
            result: existing,
            changes: { before: existing, after: null },
            warnings: [],
          } satisfies WriteResult<ScheduleEvent>,
        });
      } catch (err) {
        if (atomic) {
          for (const fn of undo.reverse()) await fn();
          throw err;
        }
        const apiErr = err instanceof ApiError ? err : new ApiError(500, 'INTERNAL_ERROR', String(err));
        results.push({
          index,
          op: op.op,
          ok: false,
          error: { code: apiErr.code, message: apiErr.message, details: apiErr.details, hint: apiErr.hint },
        });
      }
    }

    const succeeded = results.filter((r) => r.ok).length;
    ok(res, results, {
      dryRun,
      atomic,
      requested: operations.length,
      succeeded,
      failed: operations.length - succeeded,
      maxBatchSize: config.limits.maxBatchSize,
    });
  }),
);

/** POST /api/events —— 创建 */
router.post(
  '/',
  wrap(async (req, res) => {
    const user = currentUser(req);
    const body = createEventSchema.safeParse(req.body);
    if (!body.success) toValidationError(body.error);

    const { dryRun, onConflict } = parseWriteQuery(camelizeQuery(req.query as Record<string, unknown>));
    const idempotencyKey = (req.header('Idempotency-Key') ?? req.header('X-Idempotency-Key'))?.trim();

    if (idempotencyKey) {
      const cached = await repo.getIdempotent(user.id, idempotencyKey);
      if (cached) {
        return res.status(200).json({ ok: true, data: cached.response, meta: { idempotentReplay: true } });
      }
    }

    const times = normalizeTimes(body.data);
    const calendarId = await resolveCalendarId(user.id, body.data.calendarId);
    const warnings = await detectWarnings(user.id, times, body.data.title);
    if (onConflict === 'reject' && warnings.some((w) => w.code === 'TIME_CONFLICT')) {
      throw conflictRejected(
        '该时间段已有日程，且 onConflict=reject',
        '改用 onConflict=allow 强制创建，或先查询冲突项让用户确认。',
      );
    }

    if (dryRun) {
      const projected = projectNew(body.data, times, calendarId, user.id);
      return ok(res, {
        dryRun: true,
        result: projected,
        changes: { before: null, after: projected },
        warnings,
      } satisfies WriteResult<ScheduleEvent>);
    }

    const created = await repo.insertEvent({
      userId: user.id,
      start: times.start,
      end: times.end,
      input: body.data,
      calendarId,
    });
    const payload: WriteResult<ScheduleEvent> = {
      dryRun: false,
      result: created,
      changes: { before: null, after: created },
      warnings,
    };
    if (idempotencyKey) await repo.saveIdempotent(user.id, idempotencyKey, created.id, payload);

    const meta: Record<string, unknown> = {};
    if (idempotencyKey) meta.idempotencyKey = idempotencyKey;
    return res.status(201).json({ ok: true, data: payload, ...(Object.keys(meta).length ? { meta } : {}) });
  }),
);

/** GET /api/events/:id —— 单条读取 */
router.get(
  '/:id',
  wrap(async (req, res) => {
    const user = currentUser(req);
    const event = await repo.getEvent(user.id, req.params.id);
    if (!event) throw notFound();
    ok(res, event);
  }),
);

/** POST /api/events/:id/restore —— 从回收站恢复 */
router.post(
  '/:id/restore',
  wrap(async (req, res) => {
    const user = currentUser(req);
    const { dryRun } = parseWriteQuery(camelizeQuery(req.query as Record<string, unknown>));
    const current = await repo.getEvent(user.id, req.params.id);
    if (!current) throw notFound(`日程不存在：${req.params.id}`);
    if (!current.deletedAt) {
      ok(res, {
        dryRun: false,
        result: current,
        changes: { before: current, after: current },
        warnings: [{ code: 'NOT_DELETED', message: '该日程不在回收站，无需恢复' }],
      } satisfies WriteResult<ScheduleEvent>);
      return;
    }

    const projected = { ...current, deletedAt: null };
    if (dryRun) {
      ok(res, {
        dryRun: true,
        result: projected,
        changes: { before: current, after: projected },
        warnings: [],
      } satisfies WriteResult<ScheduleEvent>);
      return;
    }

    const restored = await repo.restoreEvent(user.id, req.params.id);
    if (!restored) throw notFound();
    ok(res, {
      dryRun: false,
      result: restored,
      changes: { before: current, after: restored },
      warnings: [],
    } satisfies WriteResult<ScheduleEvent>);
  }),
);

/** DELETE /api/events/:id/purge —— 从回收站彻底删除 */
router.delete(
  '/:id/purge',
  wrap(async (req, res) => {
    const user = currentUser(req);
    const { dryRun } = parseWriteQuery(camelizeQuery(req.query as Record<string, unknown>));
    const current = await repo.getEvent(user.id, req.params.id);
    if (!current) throw notFound(`日程不存在：${req.params.id}`);

    if (dryRun) {
      ok(res, {
        dryRun: true,
        result: current,
        changes: { before: current, after: null },
        warnings: [],
      } satisfies WriteResult<ScheduleEvent>);
      return;
    }
    await repo.hardDeleteEvent(user.id, req.params.id);
    ok(res, {
      dryRun: false,
      result: current,
      changes: { before: current, after: null },
      warnings: [],
    } satisfies WriteResult<ScheduleEvent>);
  }),
);

/** PUT /api/events/:id —— 完整替换（title/start/end 必填） */
router.put(
  '/:id',
  wrap(async (req, res) => {
    const body = replaceEventSchema.safeParse(req.body);
    if (!body.success) toValidationError(body.error);
    return applyUpdate(req, res, body.data);
  }),
);

/** PATCH /api/events/:id —— 局部更新 */
router.patch(
  '/:id',
  wrap(async (req, res) => {
    const body = updateEventSchema.safeParse(req.body);
    if (!body.success) toValidationError(body.error);
    return applyUpdate(req, res, body.data);
  }),
);

async function applyUpdate(
  req: Request,
  res: Response,
  patch: Partial<CreateEventInput>,
): Promise<void> {
  const user = currentUser(req);
  const { dryRun, onConflict } = parseWriteQuery(camelizeQuery(req.query as Record<string, unknown>));
  const expectedVersion = parseIfMatch(req.header('If-Match'));

  const current = await repo.getEvent(user.id, req.params.id);
  if (!current) throw notFound(`日程不存在：${req.params.id}`);

  if (expectedVersion !== undefined && current.version !== expectedVersion) {
    throw versionConflict(expectedVersion, current.version);
  }

  const projected = projectEvent(current, patch);
  if (patch.calendarId !== undefined) {
    projected.calendarId = await resolveCalendarId(user.id, patch.calendarId);
  }

  const times =
    patch.start || patch.end || patch.allDay !== undefined || patch.timezone
      ? normalizeTimes({
          title: projected.title,
          start: projected.start,
          end: projected.end,
          allDay: projected.allDay,
          timezone: projected.timezone,
        })
      : {
          start: new Date(current.start),
          end: new Date(current.end),
          tz: current.timezone,
          allDay: current.allDay,
        };

  const warnings = await detectWarnings(user.id, times, projected.title, current.id);
  if (onConflict === 'reject' && warnings.some((w) => w.code === 'TIME_CONFLICT')) {
    throw conflictRejected('更新后会产生时间冲突，且 onConflict=reject');
  }

  if (dryRun) {
    ok(res, {
      dryRun: true,
      result: projected,
      changes: { before: current, after: projected },
      warnings,
    } satisfies WriteResult<ScheduleEvent>);
    return;
  }

  let updated: ScheduleEvent;
  try {
    updated = await repo.updateEventRow({
      userId: user.id,
      id: current.id,
      patch,
      start: times.start,
      end: times.end,
      expectedVersion,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    if (msg.startsWith('VERSION_CONFLICT:')) {
      throw versionConflict(expectedVersion ?? current.version, Number(msg.split(':')[1]));
    }
    throw err;
  }

  const changed = JSON.stringify(current) !== JSON.stringify(updated);
  if (!changed) {
    warnings.push({ code: 'NO_CHANGE', message: '提交的内容与当前日程一致，未产生实际变更' });
  }

  ok(res, {
    dryRun: false,
    result: updated,
    changes: { before: current, after: updated },
    warnings,
  } satisfies WriteResult<ScheduleEvent>);
}

/**
 * DELETE /api/events/:id —— 删除。
 * 默认软删除（进回收站），带 ?mode=hard 则直接抹掉。
 */
router.delete(
  '/:id',
  wrap(async (req, res) => {
    const user = currentUser(req);
    const { dryRun, mode } = parseWriteQuery(camelizeQuery(req.query as Record<string, unknown>));
    const existing = await repo.getEvent(user.id, req.params.id);
    if (!existing) throw notFound(`日程不存在：${req.params.id}`);

    if (dryRun) {
      ok(res, {
        dryRun: true,
        result: existing,
        changes: { before: existing, after: null },
        warnings: [{ code: 'DELETE_MODE', message: mode === 'hard' ? '将彻底删除，不可恢复' : '将移入回收站，可恢复' }],
      } satisfies WriteResult<ScheduleEvent>);
      return;
    }

    const result =
      mode === 'hard'
        ? await repo.hardDeleteEvent(user.id, req.params.id)
        : await repo.softDeleteEvent(user.id, req.params.id);
    if (!result) throw notFound();

    ok(
      res,
      {
        dryRun: false,
        result,
        changes: { before: existing, after: null },
        warnings: [],
      } satisfies WriteResult<ScheduleEvent>,
      { mode, recoverable: mode === 'soft' },
    );
  }),
);

export default router;
