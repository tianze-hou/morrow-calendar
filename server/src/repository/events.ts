import type {
  ConflictInfo,
  CreateEventInput,
  ScheduleEvent,
  UpdateEventInput,
} from '../../../shared/types';
import { config } from '../config';
import { getDb } from '../db/index';
import type { SqlDriver } from '../db/driver';
import { parseInstant, formatInTz, toUtcIso } from '../lib/time';

interface EventRow {
  id: string;
  user_id: string | null;
  title: string;
  description: string | null;
  location: string | null;
  start_utc: string;
  end_utc: string;
  all_day: number;
  timezone: string;
  color: string | null;
  calendar_id: string;
  rrule: string | null;
  exdates: string | null;
  deleted_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

function rowToEvent(row: EventRow): ScheduleEvent {
  return {
    id: row.id,
    ownerId: row.user_id ?? '',
    title: row.title,
    start: formatInTz(new Date(row.start_utc), row.timezone),
    end: formatInTz(new Date(row.end_utc), row.timezone),
    allDay: row.all_day === 1,
    description: row.description ?? undefined,
    location: row.location ?? undefined,
    color: (row.color ?? undefined) as ScheduleEvent['color'],
    calendarId: row.calendar_id,
    timezone: row.timezone,
    rrule: row.rrule ?? null,
    exdates: row.exdates ? (JSON.parse(row.exdates) as string[]) : [],
    deletedAt: row.deleted_at ? formatInTz(new Date(row.deleted_at), row.timezone) : null,
    version: row.version,
    createdAt: formatInTz(new Date(row.created_at), row.timezone),
    updatedAt: formatInTz(new Date(row.updated_at), row.timezone),
  };
}

const COLUMNS = `id, user_id, title, description, location, start_utc, end_utc, all_day, timezone,
  color, calendar_id, rrule, exdates, deleted_at, version, created_at, updated_at`;

export interface ListOptions {
  /** 归属用户；所有查询都按它隔离 */
  userId: string;
  from?: string;
  to?: string;
  q?: string;
  calendarId?: string;
  /** 多个分组 id（与 calendarId 取并集语义，二者都给时以本字段为准） */
  calendarIds?: string[];
  /** true = 只看回收站；默认 false = 只看正常日程 */
  deleted?: boolean;
  limit?: number;
  offset?: number;
  order?: 'asc' | 'desc';
}

/** 把 ListOptions 里的过滤条件编译成 WHERE 子句，列表与计数共用。 */
function buildWhere(opts: Omit<ListOptions, 'limit' | 'offset' | 'order'>): {
  sql: string;
  params: unknown[];
} {
  const where: string[] = ['user_id = ?'];
  const params: unknown[] = [opts.userId];

  where.push(opts.deleted ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL');

  if (opts.from) {
    where.push('end_utc > ?');
    params.push(opts.from);
  }
  if (opts.to) {
    where.push('start_utc < ?');
    params.push(opts.to);
  }

  const ids = opts.calendarIds && opts.calendarIds.length ? opts.calendarIds : opts.calendarId ? [opts.calendarId] : [];
  if (ids.length) {
    where.push(`calendar_id IN (${ids.map(() => '?').join(', ')})`);
    params.push(...ids);
  } else if (opts.calendarIds && opts.calendarIds.length === 0) {
    // 显式传了空数组 = 没有任何可见分组，返回空集而不是全部
    where.push('1 = 0');
  }

  if (opts.q) {
    // 注意：SQLite 里双引号是标识符引号，这里的空串必须用单引号，
    // 写成 "" 会被当成列名，报 no such column: ""
    where.push("(title LIKE ? OR IFNULL(description, '') LIKE ? OR IFNULL(location, '') LIKE ?)");
    const like = `%${opts.q}%`;
    params.push(like, like, like);
  }

  return { sql: where.join(' AND '), params };
}

export async function listEvents(opts: ListOptions): Promise<ScheduleEvent[]> {
  const db = await getDb();
  const { sql: whereSql, params } = buildWhere(opts);
  const limit = Math.min(opts.limit ?? config.limits.defaultLimit, config.limits.maxLimit);
  const offset = Math.max(opts.offset ?? 0, 0);
  const order = opts.order === 'desc' ? 'DESC' : 'ASC';

  // 回收站按删除时间倒序更符合直觉，正常列表按开始时间排
  const orderCol = opts.deleted ? 'deleted_at' : 'start_utc';

  const rows = db.all<EventRow>(
    `SELECT ${COLUMNS} FROM events WHERE ${whereSql} ORDER BY ${orderCol} ${order} LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  return rows.map(rowToEvent);
}

export async function countEvents(
  opts: Omit<ListOptions, 'limit' | 'offset' | 'order'>,
): Promise<number> {
  const db = await getDb();
  const { sql: whereSql, params } = buildWhere(opts);
  const row = db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM events WHERE ${whereSql}`, params);
  return Number(row?.c ?? 0);
}

/** 取单条。必须带 userId —— 拿不到别人的日程。 */
export async function getEvent(userId: string, id: string): Promise<ScheduleEvent | null> {
  const db = await getDb();
  const row = db.get<EventRow>(`SELECT ${COLUMNS} FROM events WHERE id = ? AND user_id = ?`, [
    id,
    userId,
  ]);
  return row ? rowToEvent(row) : null;
}

export interface CreateOptions {
  /** 归属用户 */
  userId: string;
  /** 已解析好的绝对起止时刻（Date）。 */
  start: Date;
  end: Date;
  input: CreateEventInput;
  /** 已校验归属的 calendarId */
  calendarId: string;
  id?: string;
}

export async function insertEvent(opts: CreateOptions, db?: SqlDriver): Promise<ScheduleEvent> {
  const conn = db ?? (await getDb());
  const id = opts.id ?? newId();
  const tz = opts.input.timezone ?? config.timezone;
  const now = new Date();

  conn.run(
    `INSERT INTO events (id, user_id, title, description, location, start_utc, end_utc, all_day, timezone,
      color, calendar_id, rrule, exdates, deleted_at, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)`,
    [
      id,
      opts.userId,
      opts.input.title,
      opts.input.description ?? null,
      opts.input.location ?? null,
      toUtcIso(opts.start),
      toUtcIso(opts.end),
      opts.input.allDay ? 1 : 0,
      tz,
      opts.input.color ?? null,
      opts.calendarId,
      null,
      null,
      toUtcIso(now),
      toUtcIso(now),
    ],
  );

  const created = await getEvent(opts.userId, id);
  if (!created) throw new Error('写入后回读失败');
  return created;
}

export interface UpdateOptions {
  userId: string;
  id: string;
  patch: UpdateEventInput;
  start?: Date;
  end?: Date;
  /** 乐观锁：传入则校验当前 version 是否匹配。 */
  expectedVersion?: number;
}

export async function updateEventRow(opts: UpdateOptions): Promise<ScheduleEvent> {
  const db = await getDb();
  const current = await getEvent(opts.userId, opts.id);
  if (!current) throw new Error('NOT_FOUND');

  if (opts.expectedVersion !== undefined && current.version !== opts.expectedVersion) {
    throw new Error(`VERSION_CONFLICT:${current.version}`);
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (col: string, val: unknown) => {
    sets.push(`${col} = ?`);
    params.push(val);
  };

  if (opts.patch.title !== undefined) set('title', opts.patch.title);
  if (opts.patch.description !== undefined) set('description', opts.patch.description);
  if (opts.patch.location !== undefined) set('location', opts.patch.location);
  if (opts.patch.color !== undefined) set('color', opts.patch.color);
  if (opts.patch.calendarId !== undefined) set('calendar_id', opts.patch.calendarId);
  if (opts.patch.allDay !== undefined) set('all_day', opts.patch.allDay ? 1 : 0);
  if (opts.patch.timezone !== undefined) set('timezone', opts.patch.timezone);
  if (opts.start) set('start_utc', toUtcIso(opts.start));
  if (opts.end) set('end_utc', toUtcIso(opts.end));

  if (sets.length === 0) return current;

  set('version', current.version + 1);
  set('updated_at', toUtcIso(new Date()));
  params.push(opts.id, opts.userId);

  db.run(`UPDATE events SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`, params);
  const updated = await getEvent(opts.userId, opts.id);
  if (!updated) throw new Error('NOT_FOUND');
  return updated;
}

/** 软删除：进回收站。已经删过的再删一次是幂等的。 */
export async function softDeleteEvent(userId: string, id: string): Promise<ScheduleEvent | null> {
  const db = await getDb();
  const existing = await getEvent(userId, id);
  if (!existing) return null;
  if (existing.deletedAt) return existing;
  const now = toUtcIso(new Date());
  db.run('UPDATE events SET deleted_at = ?, version = version + 1, updated_at = ? WHERE id = ? AND user_id = ?', [
    now,
    now,
    id,
    userId,
  ]);
  return getEvent(userId, id);
}

/** 从回收站恢复。 */
export async function restoreEvent(userId: string, id: string): Promise<ScheduleEvent | null> {
  const db = await getDb();
  const existing = await getEvent(userId, id);
  if (!existing) return null;
  if (!existing.deletedAt) return existing;
  const now = toUtcIso(new Date());
  db.run('UPDATE events SET deleted_at = NULL, version = version + 1, updated_at = ? WHERE id = ? AND user_id = ?', [
    now,
    id,
    userId,
  ]);
  return getEvent(userId, id);
}

/** 彻底删除（不可恢复）。 */
export async function hardDeleteEvent(userId: string, id: string): Promise<ScheduleEvent | null> {
  const db = await getDb();
  const existing = await getEvent(userId, id);
  if (!existing) return null;
  db.run('DELETE FROM events WHERE id = ? AND user_id = ?', [id, userId]);
  return existing;
}

/** 清空回收站；返回清掉的条数。 */
export async function emptyTrash(userId: string): Promise<number> {
  const db = await getDb();
  const res = db.run('DELETE FROM events WHERE user_id = ? AND deleted_at IS NOT NULL', [userId]);
  return res.changes;
}

/** 检测 [start, end) 区间内与既有日程的重叠（excludeId 用于排除自身）。 */
export async function findConflicts(
  userId: string,
  start: Date,
  end: Date,
  excludeId?: string,
): Promise<ConflictInfo[]> {
  const db = await getDb();
  const rows = db.all<EventRow>(
    `SELECT ${COLUMNS} FROM events
     WHERE user_id = ? AND deleted_at IS NULL AND start_utc < ? AND end_utc > ? AND id != ?
     ORDER BY start_utc ASC
     LIMIT 20`,
    [userId, toUtcIso(end), toUtcIso(start), excludeId ?? ''],
  );

  return rows.map((row) => {
    const evStart = new Date(row.start_utc).getTime();
    const evEnd = new Date(row.end_utc).getTime();
    const overlapMs = Math.min(end.getTime(), evEnd) - Math.max(start.getTime(), evStart);
    return {
      eventId: row.id,
      title: row.title,
      start: formatInTz(new Date(row.start_utc), row.timezone),
      end: formatInTz(new Date(row.end_utc), row.timezone),
      overlapMinutes: Math.max(0, Math.round(overlapMs / 60000)),
    };
  });
}

/**
 * 用快照整行覆盖恢复（用于 atomic 批量失败时的回滚）。
 * 会保留原 id、version 与删除状态，让回滚对调用方不可见。
 */
export async function restoreSnapshot(snapshot: ScheduleEvent): Promise<void> {
  const db = await getDb();
  db.run(
    `INSERT OR REPLACE INTO events (id, user_id, title, description, location, start_utc, end_utc, all_day, timezone,
      color, calendar_id, rrule, exdates, deleted_at, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      snapshot.id,
      snapshot.ownerId,
      snapshot.title,
      snapshot.description ?? null,
      snapshot.location ?? null,
      toUtcIso(new Date(snapshot.start)),
      toUtcIso(new Date(snapshot.end)),
      snapshot.allDay ? 1 : 0,
      snapshot.timezone,
      snapshot.color ?? null,
      snapshot.calendarId,
      snapshot.rrule ?? null,
      snapshot.exdates.length ? JSON.stringify(snapshot.exdates) : null,
      snapshot.deletedAt ? toUtcIso(new Date(snapshot.deletedAt)) : null,
      snapshot.version,
      toUtcIso(new Date(snapshot.createdAt)),
      toUtcIso(new Date(snapshot.updatedAt)),
    ],
  );
}

/** 幂等键：命中则直接返回上次结果，避免 AI 重试造成重复创建。 */
export async function getIdempotent(
  userId: string,
  key: string,
): Promise<{ eventId: string; response: unknown } | null> {
  const db = await getDb();
  // 幂等键按用户隔离：不同用户的同名 key 不该互相命中
  const scopedKey = `${userId}:${key}`;
  const row = db.get<{ event_id: string; response: string }>(
    'SELECT event_id, response FROM idempotency_keys WHERE key = ?',
    [scopedKey],
  );
  if (!row) return null;
  try {
    return { eventId: row.event_id, response: JSON.parse(row.response) as unknown };
  } catch {
    return null;
  }
}

export async function saveIdempotent(
  userId: string,
  key: string,
  eventId: string,
  response: unknown,
): Promise<void> {
  const db = await getDb();
  db.run('INSERT OR REPLACE INTO idempotency_keys (key, event_id, response, created_at) VALUES (?, ?, ?, ?)', [
    `${userId}:${key}`,
    eventId,
    JSON.stringify(response),
    toUtcIso(new Date()),
  ]);
}

/** 判断待创建日程是否与既有日程重复（同标题 + 同起止）。 */
export async function findDuplicates(
  userId: string,
  title: string,
  start: Date,
  end: Date,
): Promise<ScheduleEvent[]> {
  const db = await getDb();
  const rows = db.all<EventRow>(
    `SELECT ${COLUMNS} FROM events
     WHERE user_id = ? AND deleted_at IS NULL AND title = ? AND start_utc = ? AND end_utc = ?
     LIMIT 5`,
    [userId, title, toUtcIso(start), toUtcIso(end)],
  );
  return rows.map(rowToEvent);
}

export function newId(): string {
  return `evt_${crypto.randomUUID().replace(/-/g, '')}`;
}

/** 供路由层复用：把用户输入的时间串解析成 Date（带时区兜底）。 */
export function toInstant(value: string, tz: string): Date {
  return parseInstant(value, tz);
}
