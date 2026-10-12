/**
 * 日历分组。
 * 当前每个分组归属于单个用户，彼此不可见。
 * 【预留】将来做共享时，加一张 calendar_members 表并把下面的可见性判断
 * 从 `user_id = ?` 换成「本人 or 成员」，其余逻辑与接口都不用动。
 */
import type {
  CalendarGroup,
  CreateCalendarInput,
  EventColor,
  UpdateCalendarInput,
} from '../../../shared/types';
import { config } from '../config';
import { getDb } from '../db/index';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { newId } from '../lib/tokens';
import { toUtcIso } from '../lib/time';

interface CalendarRow {
  id: string;
  user_id: string;
  name: string;
  color: string | null;
  visible: number;
  sort_order: number;
  is_default: number;
  created_at: string;
  updated_at: string;
}

const COLUMNS = 'id, user_id, name, color, visible, sort_order, is_default, created_at, updated_at';

function rowToCalendar(row: CalendarRow): CalendarGroup {
  return {
    id: row.id,
    ownerId: row.user_id,
    name: row.name,
    color: (row.color ?? 'blue') as EventColor,
    visible: row.visible === 1,
    sortOrder: row.sort_order,
    isDefault: row.is_default === 1,
    memberCount: 1, // 预留：将来统计真实成员数
    createdAt: toUtcIso(new Date(row.created_at)),
    updatedAt: toUtcIso(new Date(row.updated_at)),
  };
}

export async function listCalendars(userId: string): Promise<CalendarGroup[]> {
  const db = await getDb();
  const rows = db.all<CalendarRow>(
    `SELECT ${COLUMNS} FROM calendars WHERE user_id = ? ORDER BY is_default DESC, sort_order ASC, created_at ASC`,
    [userId],
  );
  return rows.map(rowToCalendar);
}

export async function getCalendar(userId: string, id: string): Promise<CalendarGroup | null> {
  const db = await getDb();
  const row = db.get<CalendarRow>(`SELECT ${COLUMNS} FROM calendars WHERE id = ? AND user_id = ?`, [
    id,
    userId,
  ]);
  return row ? rowToCalendar(row) : null;
}

/** 每个用户必须恰好有一个默认分组；用户创建时调用，幂等。 */
export async function ensureDefaultCalendar(userId: string): Promise<CalendarGroup> {
  const db = await getDb();
  const existing = db.get<CalendarRow>(
    `SELECT ${COLUMNS} FROM calendars WHERE user_id = ? AND is_default = 1`,
    [userId],
  );
  if (existing) return rowToCalendar(existing);

  const id = newId('cal');
  const now = toUtcIso(new Date());
  db.run(
    `INSERT INTO calendars (id, user_id, name, color, visible, sort_order, is_default, created_at, updated_at)
     VALUES (?, ?, '默认日历', 'blue', 1, 0, 1, ?, ?)`,
    [id, userId, now, now],
  );
  const created = await getCalendar(userId, id);
  if (!created) throw new Error('写入后回读失败');
  return created;
}

/**
 * 把外部传入的 calendarId 归一化成「确实属于该用户」的分组 id。
 * 传空 → 用默认分组；传了不属于自己的 id → 403（而不是静默改写，
 * 否则 AI 会以为写成功了，实际落到了别的分组）。
 */
export async function resolveCalendarId(userId: string, requested?: string): Promise<string> {
  if (!requested) return (await ensureDefaultCalendar(userId)).id;
  const found = await getCalendar(userId, requested);
  if (!found) {
    throw forbidden(
      `日历分组不存在或不属于当前用户：${requested}`,
      '先用 GET /api/calendars 列出自己的分组，再用其中某个 id。',
    );
  }
  return found.id;
}

export async function createCalendar(
  userId: string,
  input: CreateCalendarInput,
): Promise<CalendarGroup> {
  const db = await getDb();
  const count = (await listCalendars(userId)).length;
  if (count >= config.limits.maxCalendars) {
    throw forbidden(
      `每个用户最多创建 ${config.limits.maxCalendars} 个日历分组`,
      '删掉不用的分组后再建。',
    );
  }

  const maxRow = db.get<{ m: number | null }>(
    'SELECT MAX(sort_order) AS m FROM calendars WHERE user_id = ?',
    [userId],
  );
  const id = newId('cal');
  const now = toUtcIso(new Date());
  db.run(
    `INSERT INTO calendars (id, user_id, name, color, visible, sort_order, is_default, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    [
      id,
      userId,
      input.name.trim(),
      input.color ?? 'blue',
      input.visible === false ? 0 : 1,
      input.sortOrder ?? Number(maxRow?.m ?? 0) + 1,
      now,
      now,
    ],
  );
  const created = await getCalendar(userId, id);
  if (!created) throw new Error('写入后回读失败');
  return created;
}

export async function updateCalendar(
  userId: string,
  id: string,
  patch: UpdateCalendarInput,
): Promise<CalendarGroup> {
  const db = await getDb();
  const current = await getCalendar(userId, id);
  if (!current) throw notFound('日历分组不存在');

  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (col: string, val: unknown) => {
    sets.push(`${col} = ?`);
    params.push(val);
  };
  if (patch.name !== undefined) set('name', patch.name.trim());
  if (patch.color !== undefined) set('color', patch.color);
  if (patch.visible !== undefined) set('visible', patch.visible ? 1 : 0);
  if (patch.sortOrder !== undefined) set('sort_order', patch.sortOrder);

  if (sets.length === 0) return current;
  set('updated_at', toUtcIso(new Date()));
  params.push(id, userId);
  db.run(`UPDATE calendars SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`, params);

  const updated = await getCalendar(userId, id);
  if (!updated) throw notFound('日历分组不存在');
  return updated;
}

export interface DeleteCalendarResult {
  /** 被删除的分组 */
  deleted: CalendarGroup;
  /** 迁走的日程条数（迁到默认分组，不跟着一起消失） */
  movedEvents: number;
}

export async function deleteCalendar(userId: string, id: string): Promise<DeleteCalendarResult> {
  const db = await getDb();
  const current = await getCalendar(userId, id);
  if (!current) throw notFound('日历分组不存在');
  if (current.isDefault) {
    throw badRequest(
      '默认分组不能删除',
      '可以把它的名字改掉；若要精简，删除其他分组即可。',
    );
  }

  const fallback = await ensureDefaultCalendar(userId);
  let moved = 0;
  db.transaction(() => {
    const res = db.run('UPDATE events SET calendar_id = ? WHERE calendar_id = ? AND user_id = ?', [
      fallback.id,
      id,
      userId,
    ]);
    moved = res.changes;
    db.run('DELETE FROM calendars WHERE id = ? AND user_id = ?', [id, userId]);
  });

  return { deleted: current, movedEvents: moved };
}
