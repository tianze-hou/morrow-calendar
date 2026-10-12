import dayjs from 'dayjs';
// 注意：这里必须带 .js 后缀。打包后的产物由 Node 原生 ESM 加载，
// 而 dayjs 的 plugin 子路径没有 exports 映射，省略后缀会解析失败。
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import type { TimeWindow } from '../../../shared/types';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

export { dayjs };

/** 宽松的本地时间格式：2026-10-12 10:00 / 2026-10-12T10:00 */
const LOOSE_PATTERNS = ['YYYY-MM-DDTHH:mm', 'YYYY-MM-DD HH:mm', 'YYYY-MM-DDTHH:mm:ss', 'YYYY-MM-DD HH:mm:ss'];

/**
 * 把任意输入时间解析成 Date（绝对时刻）。
 * - 带偏移或 Z：按偏移解析。
 * - 不带偏移：视为 tz 时区的本地时间（AI 传 '2026-10-12T10:00' 也不会出错）。
 * - 非法输入抛 Error，由上层转成 VALIDATION_FAILED。
 */
export function parseInstant(input: string, tz: string): Date {
  const raw = input.trim();
  if (!raw) throw new Error('时间不能为空');

  // 带时区信息：Z 或 ±HH:mm
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(raw)) {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) throw new Error(`无法解析时间：${input}`);
    return d;
  }

  for (const pattern of LOOSE_PATTERNS) {
    const parsed = dayjs.tz(raw, pattern, tz);
    if (parsed.isValid()) return parsed.toDate();
  }

  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new Error(`无法解析时间：${input}`);
  return d;
}

/** Date → 指定时区的 ISO 8601 字符串（带偏移），例 2026-10-12T10:00:00+08:00 */
export function formatInTz(date: Date, tz: string): string {
  return dayjs(date).tz(tz).format('YYYY-MM-DDTHH:mm:ssZ');
}

/** Date → UTC ISO（...Z），用于落库。 */
export function toUtcIso(date: Date): string {
  return dayjs(date).utc().format('YYYY-MM-DDTHH:mm:ss[Z]');
}

/** 相对时间窗口 → 绝对区间 [from, to)，均为 UTC ISO。 */
export function resolveWindow(window: TimeWindow, tz: string): { from: string; to: string } {
  const now = dayjs().tz(tz);
  let start = now.startOf('day');
  let end = start.add(1, 'day');

  switch (window) {
    case 'today':
      break;
    case 'tomorrow':
      start = start.add(1, 'day');
      end = start.add(1, 'day');
      break;
    case 'yesterday':
      start = start.subtract(1, 'day');
      end = start.add(1, 'day');
      break;
    case 'this_week':
    case 'next_week': {
      // 周一为一周起点（dayjs 默认周日，这里手动回退到本周一）
      const mondayOffset = (now.day() + 6) % 7;
      start = now.startOf('day').subtract(mondayOffset, 'day');
      if (window === 'next_week') start = start.add(7, 'day');
      end = start.add(7, 'day');
      break;
    }
    case 'this_month':
      start = now.startOf('month');
      end = start.add(1, 'month');
      break;
    case 'next_7_days':
      end = start.add(7, 'day');
      break;
    case 'next_30_days':
      end = start.add(30, 'day');
      break;
  }

  return { from: toUtcIso(start.toDate()), to: toUtcIso(end.toDate()) };
}
