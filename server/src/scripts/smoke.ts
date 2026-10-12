/**
 * 端到端冒烟自测：拉起真实服务（独立端口 + 临时数据库），跑完即删库。
 * 覆盖：鉴权、多用户数据隔离、日历分组、回收站、令牌、以及原有的 CRUD/幂等/乐观锁。
 *
 * 用法：
 *   npm run smoke                                 对本地临时实例跑
 *   SCHEDULE_API_BASE=https://域名/api npm run smoke   对已部署的服务器跑同一套断言
 *     （远端模式需要一个可用的管理员账号，见下方 REMOTE_USER / REMOTE_PASSWORD）
 */
import fs from 'node:fs';
import path from 'node:path';

process.env.PORT = process.env.PORT ?? '8799';
process.env.DB_PATH = process.env.DB_PATH ?? path.resolve(process.cwd(), 'data', 'smoke.db');
process.env.TZ_NAME = process.env.TZ_NAME ?? 'Asia/Shanghai';
process.env.AUTH_ENABLED = process.env.AUTH_ENABLED ?? 'true';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'smoke-admin-pw';

const { createApp } = await import('../app');
const { config } = await import('../config');
const { bootstrap } = await import('../bootstrap');
const { closeDb } = await import('../db/index');

const REMOTE = process.env.SCHEDULE_API_BASE?.replace(/\/+$/, '');
const BASE = REMOTE ?? `http://127.0.0.1:${config.port}/api`;

const ADMIN_USER = process.env.REMOTE_USER ?? 'admin';
const ADMIN_PASS = process.env.REMOTE_PASSWORD ?? 'smoke-admin-pw';

let failures = 0;

function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : '');
  }
}

/** 极简 cookie 罐：只记 name=value，够用来跑会话流程。 */
class Jar {
  private store = new Map<string, string>();

  absorb(res: Response) {
    const list = res.headers.getSetCookie?.() ?? [];
    for (const raw of list) {
      const [pair] = raw.split(';');
      const idx = pair.indexOf('=');
      if (idx < 0) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (value === '' || /Max-Age=0/i.test(raw)) this.store.delete(name);
      else this.store.set(name, value);
    }
  }

  header(): Record<string, string> {
    if (this.store.size === 0) return {};
    return {
      cookie: [...this.store.entries()].map(([k, v]) => `${k}=${v}`).join('; '),
    };
  }

  clear() {
    this.store.clear();
  }
}

interface CallOptions {
  jar?: Jar;
  token?: string;
  headers?: Record<string, string>;
}

async function call(method: string, url: string, body?: unknown, opts: CallOptions = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(opts.headers ?? {}) };
  if (opts.jar) Object.assign(headers, opts.jar.header());
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;

  const res = await fetch(BASE + url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  opts.jar?.absorb(res);
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json, headers: res.headers };
}

const errCode = (r: { json: Record<string, unknown> }) =>
  (r.json.error as { code?: string } | undefined)?.code;
const data = <T,>(r: { json: Record<string, unknown> }) => r.json.data as T;

/**
 * 临时库的清理。前后各做一次：前一次保证起点干净（重复跑结果一致），后一次不留垃圾。
 *
 * 必须连 -journal 一起删：进程若在上一次运行中异常退出，会留下未回收的回滚日志；
 * 带着这个陈旧日志去打开一个全新的库，SQLite 会尝试回滚而报 "disk I/O error"。
 */
function wipeTempDb() {
  if (REMOTE) return; // 远端模式绝不动服务器上的数据
  for (const suffix of ['', '-wal', '-shm', '-journal', '.lock']) {
    try {
      fs.rmSync(`${config.dbPath}${suffix}`, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响测试结果 */
    }
  }
}

async function main() {
  wipeTempDb();
  console.log(`\n== morrow calendar 冒烟自测 ==\n目标：${BASE}\n`);

  let server: import('node:http').Server | null = null;
  if (!REMOTE) {
    const app = createApp();
    await bootstrap();
    server = app.listen(config.port);
  }

  const admin = new Jar();
  const other = new Jar();

  try {
    /* ── 1. 公开端点 ───────────────────────────────────── */
    const meta = await call('GET', '/meta');
    check('GET /api/meta 返回 200', meta.status === 200);
    const metaData = data<{
      endpoints: unknown[];
      capabilities: Record<string, boolean>;
      authentication: { required: boolean; schemes: unknown[] };
      limits: Record<string, number>;
      quickstart: Array<{ step: number; request: string }>;
      agentPrompt: string;
      onboarding: { required: boolean; endpoint: string };
    }>(meta);
    check('meta 含端点清单', Array.isArray(metaData.endpoints) && metaData.endpoints.length > 10);
    check('meta 声明 dryRun 能力', metaData.capabilities.dryRun === true);
    check('meta 声明多用户与鉴权', metaData.capabilities.multiUser === true && metaData.capabilities.auth === true);
    check('meta 声明回收站与日历分组', metaData.capabilities.trash === true && metaData.capabilities.calendars === true);
    check('meta 说明如何取令牌', typeof (metaData.authentication as { howToGetToken?: string }).howToGetToken === 'string');
    check(
      'meta 提供上手序列与 Agent 提示词',
      Array.isArray(metaData.quickstart) && metaData.quickstart.length >= 3 && typeof metaData.agentPrompt === 'string',
    );
    check('meta 的 onboarding 指出初始化状态', metaData.onboarding?.required === false, metaData.onboarding);

    const briefRes = await fetch(`${BASE}/agent.md`);
    const briefText = await briefRes.text();
    check(
      'GET /api/agent.md 返回 Markdown 简报',
      briefRes.status === 200 && (briefRes.headers.get('content-type') ?? '').includes('text/markdown'),
      { status: briefRes.status, type: briefRes.headers.get('content-type') },
    );
    check(
      'agent.md 内容含上手序列与端点表',
      briefText.includes('Agent 简报') && briefText.includes('上手序列') && briefText.includes('/api/events'),
    );

    const setupStatus = await call('GET', '/setup/status');
    check('已初始化实例的 /setup/status 返回 needsSetup=false', data<{ needsSetup: boolean }>(setupStatus).needsSetup === false);
    const setupAgain = await call('POST', '/setup/admin', { username: 'again', password: 'again-password' });
    check(
      '已初始化后再次初始化被拒（409 ALREADY_EXISTS）',
      setupAgain.status === 409 && errCode(setupAgain) === 'ALREADY_EXISTS',
      setupAgain.json,
    );

    const health = await call('GET', '/health');
    check('GET /api/health 返回 200（无需登录）', health.status === 200, health.json);

    const status = await call('GET', '/auth/status');
    check('未登录时 /auth/status 返回 authenticated=false', data<{ authenticated: boolean }>(status).authenticated === false);

    /* ── 2. 未登录必须被挡住 ───────────────────────────── */
    const anonEvents = await call('GET', '/events');
    check('未登录访问 /events 返回 401', anonEvents.status === 401 && errCode(anonEvents) === 'UNAUTHORIZED');
    const anonTrash = await call('GET', '/events/trash');
    check('未登录访问回收站返回 401', anonTrash.status === 401);
    const anonCal = await call('GET', '/calendars');
    check('未登录访问日历分组返回 401', anonCal.status === 401);

    /* ── 3. 登录 ───────────────────────────────────────── */
    const badUser = await call('POST', '/auth/login', { username: 'no-such-user', password: 'x' });
    const badPass = await call('POST', '/auth/login', { username: ADMIN_USER, password: 'wrong-password' });
    check('不存在的用户返回 401', badUser.status === 401);
    check(
      '错误口令与不存在的用户返回同一错误码（不泄漏用户是否存在）',
      errCode(badUser) === errCode(badPass),
      { badUser: errCode(badUser), badPass: errCode(badPass) },
    );

    const login = await call('POST', '/auth/login', { username: ADMIN_USER, password: ADMIN_PASS }, { jar: admin });
    check('正确口令登录成功', login.status === 200, login.json);
    check('登录后下发会话 cookie', admin.header().cookie !== undefined);
    const me = await call('GET', '/auth/me', undefined, { jar: admin });
    check('登录后可读取 /auth/me', me.status === 200 && data<{ username: string }>(me).username === ADMIN_USER);

    /* ── 4. 日历分组 ───────────────────────────────────── */
    const calList0 = await call('GET', '/calendars', undefined, { jar: admin });
    const defaults = data<Array<{ id: string; isDefault: boolean }>>(calList0);
    check('新用户自动拥有一个默认分组', defaults.length === 1 && defaults[0].isDefault === true);
    const defaultCalId = defaults[0].id;

    const calNew = await call('POST', '/calendars', { name: '工作', color: 'green' }, { jar: admin });
    check('新建日历分组返回 201', calNew.status === 201, calNew.json);
    const workCalId = data<{ id: string; color: string }>(calNew).id;

    const calDupName = await call('POST', '/calendars', { name: '' }, { jar: admin });
    check('空分组名被拒', calDupName.status === 400 && errCode(calDupName) === 'VALIDATION_FAILED');

    const delDefault = await call('DELETE', `/calendars/${defaultCalId}`, undefined, { jar: admin });
    check('默认分组不可删除', delDefault.status === 400, delDefault.json);

    const otherCal = await call('GET', `/calendars/${workCalId}`, undefined, { jar: other });
    check('未登录读取他人分组返回 401', otherCal.status === 401);

    /* ── 5. 日程 CRUD ──────────────────────────────────── */
    const dryPayload = {
      title: '冒烟测试会议',
      start: '2026-11-02T10:00:00+08:00',
      end: '2026-11-02T11:00:00+08:00',
      calendarId: workCalId,
    };
    const dry = await call('POST', '/events?dry_run=true', dryPayload, { jar: admin });
    check('dry_run 创建返回 dryRun=true', data<{ dryRun: boolean }>(dry).dryRun === true, dry.json);
    check('dry_run 的 id 为 dryrun_ 前缀', String(data<{ result: { id: string } }>(dry).result.id).startsWith('dryrun_'));

    const afterDry = await call('GET', '/events', undefined, { jar: admin });
    check('dry_run 未落库', (data<unknown[]>(afterDry) as unknown[]).length === 0);

    const created = await call('POST', '/events', dryPayload, { jar: admin });
    check('创建返回 201', created.status === 201, created.json);
    const ev = data<{ result: { id: string; version: number; calendarId: string; ownerId: string } }>(created).result;
    check('创建后带 version=1', ev.version === 1);
    check('日程落在指定分组', ev.calendarId === workCalId);

    const badCal = await call(
      'POST',
      '/events',
      { title: 'X', start: '2026-11-05T09:00:00+08:00', end: '2026-11-05T10:00:00+08:00', calendarId: 'cal_not_mine' },
      { jar: admin },
    );
    check('使用不属于自己的分组被拒 403', badCal.status === 403 && errCode(badCal) === 'FORBIDDEN', badCal.json);

    const idem1 = await call('POST', '/events', dryPayload, { jar: admin, headers: { 'Idempotency-Key': 'smoke-key-1' } });
    const idem2 = await call('POST', '/events', dryPayload, { jar: admin, headers: { 'Idempotency-Key': 'smoke-key-1' } });
    check('幂等键首次创建成功', idem1.status === 201);
    check('幂等键重复提交命中缓存', (idem2.json.meta as { idempotentReplay?: boolean } | undefined)?.idempotentReplay === true);

    const today = await call('GET', '/events?window=today', undefined, { jar: admin });
    check(
      'window=today 解析为相对窗口',
      (today.json.meta as { resolvedRange: { source: string } }).resolvedRange.source === 'window',
    );

    const byCal = await call('GET', `/events?calendar_ids=${workCalId}`, undefined, { jar: admin });
    check('按分组过滤生效', (data<unknown[]>(byCal) as unknown[]).length >= 1);
    const noneCal = await call('GET', '/events?calendar_ids=', undefined, { jar: admin });
    check('空分组列表返回空集而不是全部', (data<unknown[]>(noneCal) as unknown[]).length === 0);

    /* ── 6. 冲突与乐观锁 ───────────────────────────────── */
    const conflict = await call(
      'POST',
      '/events',
      { title: '冲突测试', start: '2026-11-02T10:30:00+08:00', end: '2026-11-02T11:30:00+08:00' },
      { jar: admin },
    );
    const warn = (data<{ warnings: Array<{ code: string }> }>(conflict).warnings ?? []);
    check('重叠日程返回 TIME_CONFLICT 警告', warn.some((w) => w.code === 'TIME_CONFLICT'), conflict.json);

    const rejected = await call(
      'POST',
      '/events?on_conflict=reject',
      { title: '冲突测试2', start: '2026-11-02T10:30:00+08:00', end: '2026-11-02T11:30:00+08:00' },
      { jar: admin },
    );
    check('on_conflict=reject 返回 409', rejected.status === 409 && errCode(rejected) === 'CONFLICT_REJECTED');

    const patched = await call('PATCH', `/events/${ev.id}`, { title: '冒烟测试会议（改）' }, { jar: admin });
    check('PATCH 更新成功且 version 递增', data<{ result: { version: number } }>(patched).result.version === 2);

    const stale = await call('PATCH', `/events/${ev.id}`, { title: 'X' }, { jar: admin, headers: { 'If-Match': '1' } });
    check('过期 If-Match 返回 409 VERSION_CONFLICT', stale.status === 409 && errCode(stale) === 'VERSION_CONFLICT');

    const invalid = await call('POST', '/events', { title: '' }, { jar: admin });
    check('非法入参返回 VALIDATION_FAILED', invalid.status === 400 && errCode(invalid) === 'VALIDATION_FAILED');
    check('错误体带 details 字段', Array.isArray((invalid.json.error as { details: unknown }).details));

    /* ── 7. 批量 ───────────────────────────────────────── */
    const batchDry = await call(
      'POST',
      '/events/batch',
      {
        dryRun: true,
        operations: [
          { op: 'create', data: { title: 'A', start: '2026-11-03T09:00:00+08:00', end: '2026-11-03T10:00:00+08:00' } },
          { op: 'update', id: ev.id, data: { location: '图书馆' } },
          { op: 'delete', id: ev.id },
        ],
      },
      { jar: admin },
    );
    check('批量 dry_run 全部成功', (batchDry.json.meta as { succeeded: number }).succeeded === 3, batchDry.json.meta);

    const tooMany = await call(
      'POST',
      '/events/batch',
      {
        operations: Array.from({ length: config.limits.maxBatchSize + 1 }, () => ({
          op: 'create',
          data: { title: 'X', start: '2026-11-04T09:00:00+08:00', end: '2026-11-04T10:00:00+08:00' },
        })),
      },
      { jar: admin },
    );
    check(`批量超过 ${config.limits.maxBatchSize} 条被拒`, tooMany.status === 400);

    /* ── 8. 回收站 ─────────────────────────────────────── */
    const softDel = await call('DELETE', `/events/${ev.id}`, undefined, { jar: admin });
    check('删除默认为软删除', softDel.status === 200 && (softDel.json.meta as { mode?: string })?.mode === 'soft');
    check(
      '软删除后的快照带 deletedAt',
      typeof data<{ result: { deletedAt: string | null } }>(softDel).result.deletedAt === 'string',
    );

    const normalList = await call('GET', '/events', undefined, { jar: admin });
    check('软删除后不出现在正常列表', !(data<Array<{ id: string }>>(normalList) as Array<{ id: string }>).some((e) => e.id === ev.id));

    const trashList = await call('GET', '/events/trash', undefined, { jar: admin });
    check('软删除后出现在回收站', (data<Array<{ id: string }>>(trashList) as Array<{ id: string }>).some((e) => e.id === ev.id));
    check('回收站 meta 带 total', typeof (trashList.json.meta as { total?: number }).total === 'number');

    const restored = await call('POST', `/events/${ev.id}/restore`, undefined, { jar: admin });
    check('从回收站恢复成功', restored.status === 200 && data<{ result: { deletedAt: string | null } }>(restored).result.deletedAt === null);
    const backList = await call('GET', '/events', undefined, { jar: admin });
    check('恢复后重新出现在正常列表', (data<Array<{ id: string }>>(backList) as Array<{ id: string }>).some((e) => e.id === ev.id));

    const purgeTarget = await call(
      'POST',
      '/events',
      { title: '待彻底删除', start: '2026-11-06T09:00:00+08:00', end: '2026-11-06T10:00:00+08:00' },
      { jar: admin },
    );
    const purgeId = data<{ result: { id: string } }>(purgeTarget).result.id;
    await call('DELETE', `/events/${purgeId}`, undefined, { jar: admin });
    const purged = await call('DELETE', `/events/${purgeId}/purge`, undefined, { jar: admin });
    check('彻底删除返回 200', purged.status === 200);
    const gone = await call('GET', `/events/${purgeId}`, undefined, { jar: admin });
    check('彻底删除后读取返回 404', gone.status === 404 && errCode(gone) === 'NOT_FOUND');

    /* ── 9. 删除分组：组内日程迁移 ─────────────────────── */
    const scratch = await call('POST', '/calendars', { name: '临时分组' }, { jar: admin });
    const scratchId = data<{ id: string }>(scratch).id;
    const inScratch = await call(
      'POST',
      '/events',
      {
        title: '搬迁测试',
        start: '2026-11-07T09:00:00+08:00',
        end: '2026-11-07T10:00:00+08:00',
        calendarId: scratchId,
      },
      { jar: admin },
    );
    const movedId = data<{ result: { id: string } }>(inScratch).result.id;
    const delScratch = await call('DELETE', `/calendars/${scratchId}`, undefined, { jar: admin });
    check('删除分组返回迁移条数', data<{ movedEvents: number }>(delScratch).movedEvents === 1, delScratch.json);
    const moved = await call('GET', `/events/${movedId}`, undefined, { jar: admin });
    check('组内日程被迁入默认分组', data<{ calendarId: string }>(moved).calendarId === defaultCalId);

    /* ── 10. 界面设置 ──────────────────────────────────── */
    const settings0 = await call('GET', '/settings', undefined, { jar: admin });
    check(
      'GET /settings 提供昼夜两套配色',
      (settings0.json.meta as { available: { themes: string[] } }).available.themes.length === 2,
      settings0.json.meta,
    );

    const settingsPut = await call('PUT', '/settings', { theme: 'night', timeFormat: '12-hour' }, { jar: admin });
    const afterPut = data<Record<string, unknown>>(settingsPut);
    check(
      'PUT /settings 只改传入字段',
      afterPut.theme === 'night' && afterPut.timeFormat === '12-hour' && afterPut.defaultView === 'week',
      afterPut,
    );

    const badTheme = await call('PUT', '/settings', { theme: 'midnight' }, { jar: admin });
    check('已废弃的旧主题被拒', badTheme.status === 400 && errCode(badTheme) === 'VALIDATION_FAILED');

    /* ── 11. API 令牌 ──────────────────────────────────── */
    const tokenCreate = await call('POST', '/tokens', { name: '冒烟测试令牌' }, { jar: admin });
    check('创建令牌返回 201', tokenCreate.status === 201, tokenCreate.json);
    const plaintext = data<{ token: string; prefix: string }>(tokenCreate).token;
    check('创建响应含明文令牌', typeof plaintext === 'string' && plaintext.startsWith('isk_'));

    const viaToken = await call('GET', '/events', undefined, { token: plaintext });
    check('用令牌可访问接口（无需 cookie）', viaToken.status === 200);
    const tokenMe = await call('GET', '/auth/me', undefined, { token: plaintext });
    check('令牌可识别为用户本人', data<{ username: string }>(tokenMe).username === ADMIN_USER);

    const tokenList = await call('GET', '/tokens', undefined, { jar: admin });
    check('令牌列表不含明文', !JSON.stringify(data<unknown[]>(tokenList)).includes(plaintext));

    const tokenId = (tokenCreate.json.data as { id: string }).id;
    await call('POST', `/tokens/${tokenId}/revoke`, undefined, { jar: admin });
    const afterRevoke = await call('GET', '/events', undefined, { token: plaintext });
    check('吊销后令牌立即失效', afterRevoke.status === 401);

    /* ── 12. 多用户隔离 ────────────────────────────────── */
    const createB = await call(
      'POST',
      '/users',
      { username: 'smoke-user-b', password: 'user-b-password', displayName: '乙用户' },
      { jar: admin },
    );
    check('管理员可创建用户', createB.status === 201, createB.json);
    const userB = data<{ id: string; role: string }>(createB);
    check('新用户默认是普通成员', userB.role === 'member');

    const loginB = await call('POST', '/auth/login', { username: 'smoke-user-b', password: 'user-b-password' }, { jar: other });
    check('新用户可登录', loginB.status === 200, loginB.json);

    const listB = await call('GET', '/events', undefined, { jar: other });
    check('乙用户看不到甲用户的日程', (data<unknown[]>(listB) as unknown[]).length === 0);

    const peek = await call('GET', `/events/${ev.id}`, undefined, { jar: other });
    check('乙用户按 id 访问甲的日程返回 404', peek.status === 404);

    const calListB = await call('GET', '/calendars', undefined, { jar: other });
    const bCals = data<Array<{ id: string }>>(calListB);
    check('乙用户有自己的默认分组', bCals.length === 1 && bCals[0].id !== defaultCalId);

    const usersAsB = await call('GET', '/users', undefined, { jar: other });
    check('普通用户只能看到自己', (data<unknown[]>(usersAsB) as unknown[]).length === 1);

    const createAsB = await call('POST', '/users', { username: 'x', password: 'xxxxxxxx' }, { jar: other });
    check('普通用户无权创建账号（403）', createAsB.status === 403 && errCode(createAsB) === 'FORBIDDEN');

    const resetB = await call('PATCH', `/users/${userB.id}`, { password: 'user-b-new-password' }, { jar: admin });
    check('管理员可为他人重置口令', resetB.status === 200, resetB.json);
    const reLoginB = await call(
      'POST',
      '/auth/login',
      { username: 'smoke-user-b', password: 'user-b-new-password' },
      { jar: other },
    );
    check('重置后可用新口令登录', reLoginB.status === 200);

    const delOther = await call('DELETE', `/users/${userB.id}`, undefined, { jar: admin });
    check('管理员可以删除其他用户', delOther.status === 200);

    const meAdmin = await call('GET', '/auth/me', undefined, { jar: admin });
    const adminId = data<{ id: string }>(meAdmin).id;
    const delMe = await call('DELETE', `/users/${adminId}`, undefined, { jar: admin });
    check('不能删除自己（403）', delMe.status === 403);

    const demoteSelf = await call('PATCH', `/users/${adminId}`, { role: 'member' }, { jar: admin });
    check('最后一个管理员不能被降级（409 LAST_ADMIN）', demoteSelf.status === 409 && errCode(demoteSelf) === 'LAST_ADMIN');

    /* ── 13. 清空回收站与登出 ──────────────────────────── */
    const emptyDry = await call('POST', '/events/trash/empty?dry_run=true', undefined, { jar: admin });
    check('清空回收站支持 dry_run', data<{ dryRun: boolean }>(emptyDry).dryRun === true);

    const before = await call('POST', '/events', { title: '待清空', start: '2026-11-08T09:00:00+08:00', end: '2026-11-08T10:00:00+08:00' }, { jar: admin });
    await call('DELETE', `/events/${data<{ result: { id: string } }>(before).result.id}`, undefined, { jar: admin });
    const emptied = await call('POST', '/events/trash/empty', undefined, { jar: admin });
    check('清空回收站返回删除条数', (data<{ removed: number }>(emptied).removed ?? 0) >= 1, emptied.json);
    const trashAfter = await call('GET', '/events/trash', undefined, { jar: admin });
    check('清空后回收站为空', (data<unknown[]>(trashAfter) as unknown[]).length === 0);

    const logout = await call('POST', '/auth/logout', undefined, { jar: admin });
    check('登出返回 200', logout.status === 200);
    const afterLogout = await call('GET', '/auth/me', undefined, { jar: admin });
    check('登出后会话失效（401）', afterLogout.status === 401);

    /* ── 14. 恢复出厂设置 ──────────────────────────────── */
    await call('POST', '/auth/login', { username: ADMIN_USER, password: ADMIN_PASS }, { jar: admin });
    await call('POST', '/settings/reset', undefined, { jar: admin });
    const settings2 = await call('GET', '/settings', undefined, { jar: admin });
    check('恢复默认生效', data<{ theme: string }>(settings2).theme === 'day');
  } finally {
    server?.close();
    await closeDb().catch(() => undefined);
  }

  if (!REMOTE) {
    wipeTempDb();
  }

  console.log(`\n结果：${failures === 0 ? '全部通过 ✓' : `${failures} 项失败 ✗`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
