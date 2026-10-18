/**
 * iCalendar 导出。
 *
 * 单独挂在 /api/export 下，没塞进 /api/events/:id 那一族：后者有一条参数路由，
 * /events/export.ics 这种路径能不能被正确匹配全看注册顺序，太脆。
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import type { ScheduleEvent } from '../../../shared/types';
import { config } from '../config';
import { buildCalendar } from '../lib/ics';
import { dayjs } from '../lib/time';
import { currentUser } from '../middleware/auth';
import { listCalendars } from '../repository/calendars';
import * as repo from '../repository/events';
import { buildListFilters, camelizeQuery, parseCalendarIds } from '../services/events';

const router = Router();

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

/** 文件名里出现这些字符会被各系统当成路径或通配符。 */
function safeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|\r\n]+/g, '-').trim() || 'calendar';
}

/**
 * Content-Disposition 双写：filename= 给只认 ASCII 的老客户端兜底，
 * filename*= 走 RFC 5987 带中文原名。少写一个，中文分组名就会变成乱码或 .ics 丢失。
 */
function attachmentHeader(filename: string): string {
  // 纯中文名去掉非 ASCII 后只剩一个「.ics」，那还不如给个通用的；判断有没有
  // 字母数字，而不是判断是否为空。
  const ascii = filename.replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '').trim();
  const fallback = /[A-Za-z0-9]/.test(ascii) ? ascii : 'morrow-events.ics';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * 取要导出的日程。
 *
 * `ids` 优先：单条导出不需要带上区间和分组。列表接口没有按 id 过滤的参数，
 * 所以这里逐个查；不存在的 id 静默跳过 —— 导出是读操作，为一个过期 id
 * 让整份文件失败没道理。
 */
async function collectEvents(userId: string, query: Record<string, unknown>): Promise<ScheduleEvent[]> {
  if (typeof query.ids === 'string') {
    const ids = query.ids
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length) {
      const found = await Promise.all(ids.map((id) => repo.getEvent(userId, id)));
      return found.filter((e): e is ScheduleEvent => e !== null && !e.deletedAt);
    }
  }

  const filters = buildListFilters(userId, query);

  // 分页拉全量。列表接口一页最多 500 条（config.limits.maxLimit），直接取一页就
  // 结束的话，日程攒到 501 条之后导出会悄悄少掉后面那些 —— 备份少东西是最难
  // 发现的那类 bug，宁可多查一次。
  const limit = config.limits.maxLimit;
  const all: ScheduleEvent[] = [];
  for (let offset = 0; ; offset += limit) {
    const page = await repo.listEvents({ ...filters, deleted: false, limit, offset, order: 'asc' });
    all.push(...page);
    if (page.length < limit) break;
  }
  return all;
}

/** GET /api/export/events.ics —— 导出为 iCalendar 文件 */
router.get(
  '/events.ics',
  wrap(async (req, res) => {
    const user = currentUser(req);
    const query = camelizeQuery(req.query as Record<string, unknown>);

    const events = await collectEvents(user.id, query);
    const calendars = await listCalendars(user.id);
    const groupNames = new Map(calendars.map((c) => [c.id, c.name]));

    // 只选了一个分组时用它的名字当日历名，导进手机后能一眼看出这是哪一组。
    const requested = typeof query.calendarIds === 'string' ? query.calendarIds : undefined;
    const single =
      parseCalendarIds(requested)?.[0] ?? (typeof query.calendarId === 'string' ? query.calendarId : undefined);
    const groupName = single ? groupNames.get(single) : undefined;

    const body = buildCalendar(events, {
      timezone: config.timezone,
      name: groupName ? `morrow · ${groupName}` : 'morrow calendar',
      groupNames,
    });

    const filename = groupName
      ? `${safeFilename(groupName)}.ics`
      : `morrow-${dayjs().tz(config.timezone).format('YYYYMMDD')}.ics`;

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', attachmentHeader(filename));
    res.setHeader('Cache-Control', 'no-store');
    // 让调用方（尤其是 Agent）不用解析文件就知道里面有几条。
    res.setHeader('X-Event-Count', String(events.length));
    res.send(body);
  }),
);

export default router;
