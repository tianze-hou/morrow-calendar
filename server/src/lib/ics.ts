/**
 * iCalendar（RFC 5545）写出。
 *
 * 只做「写」这一半，不解析。整份规则就是转义、折行、时间格式、组件骨架四条，
 * 自己写比引一个解析器更容易审 —— 第三方 ical 库动辄几千行，为一次导出不值得。
 *
 * 时间一律写成 UTC（结尾的 Z）。带 TZID 的写法要求客户端认得那个时区，
 * 认不出就整条落错位置；UTC 是绝对时刻，没有这个前提。全天日程按规范用
 * VALUE=DATE，不带时间也不带时区，客户端会自己按本地日期显示。
 */
import type { ScheduleEvent } from '../../../shared/types';
import { dayjs } from './time';

/** RFC 5545 §3.1：一行不超过 75 个八位组，续行以一个空格打头。 */
const MAX_LINE_OCTETS = 75;

const PRODID = '-//morrow-calendar//NONSGML morrow-calendar//ZH';

/**
 * 文本转义。
 *
 * 反斜杠必须最先处理，否则后面写进去的转义符会被再转义一次，
 * 「a;b」会变成「a\\;b」，导入方读出来多一个反斜杠。
 */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * 折行。
 *
 * 按码点切，不按字节切：一个汉字 3 个八位组，按字节切会把它劈成两半，
 * 客户端解出来就是乱码。续行开头那个空格自己占 1 个八位组，所以续行实际
 * 只有 74 个可写。
 */
export function foldLine(line: string): string {
  if (Buffer.byteLength(line, 'utf8') <= MAX_LINE_OCTETS) return line;

  const parts: string[] = [];
  let current = '';
  let octets = 0;

  for (const char of line) {
    const size = Buffer.byteLength(char, 'utf8');
    if (octets + size > MAX_LINE_OCTETS) {
      parts.push(current);
      current = ' ';
      octets = 1;
    }
    current += char;
    octets += size;
  }
  parts.push(current);
  return parts.join('\r\n');
}

/** Date → 20261018T093000Z */
function utcStamp(date: Date): string {
  return dayjs(date).utc().format('YYYYMMDDTHHmmss[Z]');
}

/** Date → 20261018，按给定时区取日期。 */
function dateStamp(date: Date | ReturnType<typeof dayjs>, tz: string): string {
  return dayjs(date).tz(tz).format('YYYYMMDD');
}

interface EncodeOptions {
  timezone: string;
  /** 整份文件共用一个 DTSTAMP，便于测试时固定输出 */
  stamp: string;
  /** 该条日程所属分组名，写进 CATEGORIES */
  groupName?: string;
}

/**
 * 起止时间。
 *
 * 库里全天日程存的是「当日 00:00:00 – 23:59:59」，而 RFC 5545 里 DATE 型的
 * DTEND 是开区间、不含当天，所以要往后挪一天。不挪的话导进别家日历会少一天。
 */
function timeLines(event: ScheduleEvent, tz: string): string[] {
  const start = new Date(event.start);
  const end = new Date(event.end);

  if (event.allDay) {
    // 用「同一时区的次日零点」而不是 +24 小时：碰上夏令时切换，加 24 小时会
    // 落在前一天的 23 点或次日 1 点，取日期就错位了。
    return [
      `DTSTART;VALUE=DATE:${dateStamp(start, tz)}`,
      `DTEND;VALUE=DATE:${dateStamp(dayjs(end).tz(tz).add(1, 'day'), tz)}`,
    ];
  }
  return [`DTSTART:${utcStamp(start)}`, `DTEND:${utcStamp(end)}`];
}

function eventBlock(event: ScheduleEvent, opts: EncodeOptions): string[] {
  const lines = [
    'BEGIN:VEVENT',
    `UID:${event.id}@morrow-calendar`,
    `DTSTAMP:${opts.stamp}`,
    `CREATED:${utcStamp(new Date(event.createdAt))}`,
    `LAST-MODIFIED:${utcStamp(new Date(event.updatedAt))}`,
    // 版本号拿来当 SEQUENCE，客户端据此判断哪条更新；RFC 要求从 0 开始。
    `SEQUENCE:${Math.max(event.version - 1, 0)}`,
    ...timeLines(event, opts.timezone),
    `SUMMARY:${escapeText(event.title)}`,
  ];

  if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
  if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
  if (opts.groupName) lines.push(`CATEGORIES:${escapeText(opts.groupName)}`);
  // 非标准字段，保留颜色是为了将来自己做导入时能原样还原，别家日历会忽略它。
  if (event.color) lines.push(`X-MORROW-COLOR:${event.color}`);

  lines.push('STATUS:CONFIRMED', 'END:VEVENT');
  return lines;
}

export interface CalendarOptions {
  timezone: string;
  /** 日历名，写进 X-WR-CALNAME；导出单个分组时用分组名 */
  name?: string;
  /** 分组 id → 分组名，用来给每条日程打 CATEGORIES */
  groupNames?: Map<string, string>;
  /** 固定 DTSTAMP；不传取当前时间 */
  stamp?: string;
}

/** 把一批日程写成一份完整的 VCALENDAR 文本。 */
export function buildCalendar(events: ScheduleEvent[], options: CalendarOptions): string {
  const stamp = options.stamp ?? utcStamp(new Date());
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(options.name ?? 'morrow calendar')}`,
    // 只影响客户端默认按哪个时区展示，不参与时间换算 —— DTSTART 一律是 UTC。
    `X-WR-TIMEZONE:${options.timezone}`,
  ];

  // 按开始时间排：导出的文件人也会打开看，时间线乱序读不下去。
  const sorted = [...events].sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
  for (const event of sorted) {
    lines.push(...eventBlock(event, { timezone: options.timezone, stamp, groupName: options.groupNames?.get(event.calendarId) }));
  }

  lines.push('END:VCALENDAR');
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}
