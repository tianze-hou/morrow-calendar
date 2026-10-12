/** 灌入一批演示日程，便于自测与前端首屏验证。用法：npm run seed [-- --user admin] */
import { config } from '../config';
import { bootstrap } from '../bootstrap';
import { dayjs, toUtcIso } from '../lib/time';
import { closeDb } from '../db/index';
import { ensureDefaultCalendar, listCalendars } from '../repository/calendars';
import * as repo from '../repository/events';
import { listUsers } from '../repository/users';

const samples: Array<{
  title: string;
  offsetDays: number;
  hour: number;
  durationMin: number;
  color?: string;
  location?: string;
  description?: string;
  calendar?: string;
}> = [
  { title: '晨间写作', offsetDays: 0, hour: 8, durationMin: 60, color: 'blue', description: '论文第三章', calendar: '工作' },
  { title: '导师例会', offsetDays: 0, hour: 14, durationMin: 90, color: 'green', location: '线上', calendar: '工作' },
  { title: '葡语课', offsetDays: 1, hour: 19, durationMin: 60, color: 'purple', calendar: '学习' },
  { title: '体检预约', offsetDays: 2, hour: 9, durationMin: 30, color: 'red', location: '校医院', calendar: '生活' },
  { title: '选题会', offsetDays: -1, hour: 10, durationMin: 120, color: 'indigo', calendar: '工作' },
];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  await bootstrap(); // 保证至少有管理员和默认分组
  const tz = config.timezone;

  const users = await listUsers();
  const wanted = arg('user');
  const owner = wanted ? users.find((u) => u.username === wanted) : users[0];
  if (!owner) {
    console.error('没有任何用户，无法灌入演示数据');
    process.exit(1);
  }
  await ensureDefaultCalendar(owner.id);

  // 让演示数据分布在多个分组里，顺便验证分组功能
  const groups = new Map<string, string>();
  const def = await ensureDefaultCalendar(owner.id);
  groups.set('默认', def.id);
  for (const wanted2 of ['工作', '学习', '生活']) {
    const existing = (await listCalendars(owner.id)).find((c) => c.name === wanted2);
    if (existing) {
      groups.set(wanted2, existing.id);
      continue;
    }
    const { createCalendar } = await import('../repository/calendars');
    const palette = ['blue', 'green', 'purple', 'red', 'yellow', 'pink', 'indigo', 'gray'] as const;
    const created = await createCalendar(owner.id, {
      name: wanted2,
      color: palette[groups.size % palette.length],
    });
    groups.set(wanted2, created.id);
  }

  for (const s of samples) {
    const start = dayjs().tz(tz).add(s.offsetDays, 'day').hour(s.hour).minute(0).second(0).millisecond(0);
    const end = start.add(s.durationMin, 'minute');
    const calendarId = (s.calendar && groups.get(s.calendar)) || def.id;
    await repo.insertEvent({
      userId: owner.id,
      start: start.toDate(),
      end: end.toDate(),
      calendarId,
      input: {
        title: s.title,
        start: start.format('YYYY-MM-DDTHH:mm:ssZ'),
        end: end.format('YYYY-MM-DDTHH:mm:ssZ'),
        description: s.description,
        location: s.location,
        color: s.color as never,
        timezone: tz,
      },
    });
    console.log(
      `  已写入：${s.title}  ${start.format('YYYY-MM-DD HH:mm')}–${end.format('HH:mm')}  [${s.calendar ?? '默认'}]  (${toUtcIso(start.toDate())})`,
    );
  }
  console.log(`seed 完成（归属用户：${owner.username}）`);
  await closeDb();
}

main().catch(async (e) => {
  console.error(e);
  await closeDb().catch(() => undefined);
  process.exit(1);
});
