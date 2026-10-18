import type {
  ApiToken,
  ApiTokenCreated,
  AppSettings,
  CalendarGroup,
  CreateCalendarInput,
  CreateEventInput,
  CreateUserInput,
  LoginResult,
  ScheduleEvent,
  SetupStatus,
  UpdateCalendarInput,
  UpdateEventInput,
  UpdateUserInput,
  User,
  WriteResult,
} from '../../shared/types';

const BASE = import.meta.env.VITE_API_BASE ?? '/api';

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
    public readonly details?: Array<{ field: string; message: string }>,
    public readonly hint?: string,
  ) {
    super(message);
  }

  /** 未登录：调用方据此切到登录页，而不是弹一个红色的错误提示。 */
  get isAuthError(): boolean {
    return this.status === 401 || this.code === 'UNAUTHORIZED';
  }
}

interface Envelope<T> {
  ok: boolean;
  data?: T;
  meta?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
    details?: Array<{ field: string; message: string }>;
    hint?: string;
  };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    ...init,
  });

  let json: Envelope<T>;
  try {
    json = (await res.json()) as Envelope<T>;
  } catch {
    throw new ApiError(`服务返回了非 JSON 响应（HTTP ${res.status}）`, 'INTERNAL_ERROR', res.status);
  }

  if (!json.ok) {
    const err = json.error ?? { code: 'INTERNAL_ERROR', message: '未知错误' };
    throw new ApiError(err.message, err.code, res.status, err.details, err.hint);
  }
  return json.data as T;
}

/** 需要同时拿到 data 与 meta 的场景（如设置来源、回收站条数）。 */
async function requestWithMeta<T>(path: string, init?: RequestInit): Promise<{ data: T; meta: Record<string, unknown> }> {
  const res = await fetch(BASE + path, {
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  const json = (await res.json()) as Envelope<T>;
  if (!json.ok) {
    const err = json.error ?? { code: 'INTERNAL_ERROR', message: '未知错误' };
    throw new ApiError(err.message, err.code, res.status, err.details, err.hint);
  }
  return { data: json.data as T, meta: json.meta ?? {} };
}

/* ───────────────────────────── 鉴权 ───────────────────────────── */

export interface AuthStatus {
  authRequired: boolean;
  authenticated: boolean;
  user: User | null;
  method: string | null;
}

export const auth = {
  status: () => request<AuthStatus>('/auth/status'),
  login: (username: string, password: string) =>
    request<LoginResult>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  logout: () => request<{ loggedOut: boolean }>('/auth/logout', { method: 'POST' }),
  me: () => request<User>('/auth/me'),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<User>('/auth/password', {
      method: 'PUT',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
};

/* ─────────────────────────── 初始化引导 ─────────────────────────── */

export const setup = {
  /** 零用户时返回 needsSetup=true，前端据此显示「创建管理员」向导。 */
  status: () => request<SetupStatus>('/setup/status'),
  /** 创建首个管理员；成功后服务端已下发会话，可直接进主界面。 */
  createAdmin: (input: { username: string; password: string; displayName?: string }) =>
    request<LoginResult>('/setup/admin', { method: 'POST', body: JSON.stringify(input) }),
};

/* ───────────────────────────── 令牌 ───────────────────────────── */

export const tokens = {
  list: () => request<ApiToken[]>('/tokens'),
  create: (name: string, ttlDays: number | null) =>
    request<ApiTokenCreated>('/tokens', {
      method: 'POST',
      body: JSON.stringify({ name, ttlDays }),
    }),
  revoke: (id: string) => request<ApiToken>(`/tokens/${id}/revoke`, { method: 'POST' }),
  remove: (id: string) => request<{ id: string; deleted: boolean }>(`/tokens/${id}`, { method: 'DELETE' }),
};

/* ───────────────────────────── 用户 ───────────────────────────── */

export const users = {
  list: () => request<User[]>('/users'),
  create: (input: CreateUserInput) =>
    request<User>('/users', { method: 'POST', body: JSON.stringify(input) }),
  update: (id: string, patch: UpdateUserInput) =>
    request<User>(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  remove: (id: string) => request<{ id: string; deleted: boolean }>(`/users/${id}`, { method: 'DELETE' }),
};

/* ─────────────────────────── 日历分组 ─────────────────────────── */

export const calendars = {
  list: () => requestWithMeta<CalendarGroup[]>('/calendars'),
  create: (input: CreateCalendarInput) =>
    request<CalendarGroup>('/calendars', { method: 'POST', body: JSON.stringify(input) }),
  update: (id: string, patch: UpdateCalendarInput) =>
    request<CalendarGroup>(`/calendars/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  remove: (id: string) =>
    requestWithMeta<{ deleted: CalendarGroup; movedEvents: number }>(`/calendars/${id}`, {
      method: 'DELETE',
    }),
};

/* ───────────────────────────── 日程 ───────────────────────────── */

export interface ListParams {
  from?: string;
  to?: string;
  q?: string;
  limit?: number;
  /** 多个分组 id；传空数组表示「没有任何可见分组」，服务端会返回空集 */
  calendarIds?: string[];
  deleted?: boolean;
}

export const events = {
  list: ({ from, to, q, limit, calendarIds, deleted }: ListParams = {}) => {
    const qs = new URLSearchParams();
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    if (q) qs.set('q', q);
    if (limit) qs.set('limit', String(limit));
    if (deleted) qs.set('deleted', 'true');
    if (calendarIds) qs.set('calendar_ids', calendarIds.join(','));
    return request<ScheduleEvent[]>(`/events?${qs.toString()}`);
  },

  create: (input: CreateEventInput) =>
    request<WriteResult<ScheduleEvent>>('/events', { method: 'POST', body: JSON.stringify(input) }),

  update: (id: string, patch: UpdateEventInput) =>
    request<WriteResult<ScheduleEvent>>(`/events/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  /** 删除。默认进回收站；mode='hard' 直接抹掉。 */
  remove: (id: string, mode: 'soft' | 'hard' = 'soft') =>
    requestWithMeta<WriteResult<ScheduleEvent>>(`/events/${id}?mode=${mode}`, { method: 'DELETE' }),

  restore: (id: string) =>
    request<WriteResult<ScheduleEvent>>(`/events/${id}/restore`, { method: 'POST' }),

  purge: (id: string) =>
    request<WriteResult<ScheduleEvent>>(`/events/${id}/purge`, { method: 'DELETE' }),

  emptyTrash: () =>
    requestWithMeta<{ dryRun: boolean; removed?: number }>('/events/trash/empty', { method: 'POST' }),

  trash: (params: ListParams = {}) => {
    const qs = new URLSearchParams();
    if (params.from) qs.set('from', params.from);
    if (params.to) qs.set('to', params.to);
    return requestWithMeta<ScheduleEvent[]>(`/events/trash?${qs.toString()}`);
  },
};

/* ───────────────────────────── 设置 ───────────────────────────── */

export const settings = {
  get: () => requestWithMeta<AppSettings>('/settings'),
  update: (patch: Partial<AppSettings>) =>
    request<AppSettings>('/settings', { method: 'PUT', body: JSON.stringify(patch) }),
  reset: () => request<AppSettings>('/settings/reset', { method: 'POST' }),
};

/* ───────────────────────────── 导出 ───────────────────────────── */

export interface IcsParams {
  from?: string;
  to?: string;
  calendarId?: string;
  /** 指定日程 id；不传则按区间 / 分组导出 */
  ids?: string[];
}

/**
 * 取回 .ics 文件内容。
 *
 * 走 fetch 拿 Blob，而不是把 window.location 指过去：令牌过期时要能拿到 401
 * 并回登录页。直接跳转的话，浏览器会把那段 JSON 错误当成文件存下来。
 */
export async function downloadIcs(params: IcsParams = {}): Promise<{ blob: Blob; filename: string }> {
  const qs = new URLSearchParams();
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  if (params.calendarId) qs.set('calendar_id', params.calendarId);
  if (params.ids?.length) qs.set('ids', params.ids.join(','));

  const res = await fetch(`${BASE}/export/events.ics?${qs.toString()}`, { credentials: 'include' });
  if (!res.ok) {
    const json = (await res.json().catch(() => null)) as Envelope<unknown> | null;
    const err = json?.error ?? { code: 'INTERNAL_ERROR', message: `导出失败（HTTP ${res.status}）` };
    throw new ApiError(err.message, err.code, res.status, err.details, err.hint);
  }

  return { blob: await res.blob(), filename: filenameFrom(res.headers.get('content-disposition')) };
}

/** 从 Content-Disposition 里取文件名，优先 RFC 5987 那份（能带中文）。 */
function filenameFrom(disposition: string | null): string {
  const encoded = disposition?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      /* 编码坏了就落到下面的 ASCII 兜底 */
    }
  }
  return disposition?.match(/filename="([^"]+)"/)?.[1] ?? 'calendar.ics';
}

/** 事件接口的短别名，历史调用点沿用 api.xxx 的写法。 */
export const api = events;
