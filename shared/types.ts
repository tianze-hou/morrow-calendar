/**
 * 领域模型 + 接口契约的唯一来源（single source of truth）。
 * 前端（src/）与后端（server/src/）都从这里导入，避免两套类型漂移。
 *
 * 时间约定：所有对外时间字段均为 RFC 3339 / ISO 8601 字符串且带时区偏移，
 * 例：2026-10-12T10:00:00+08:00。数据库内部统一存 UTC（...Z）。
 */

/* ───────────────────────── 界面设置 ───────────────────────── */

/**
 * 配色方案：只保留两套，一昼一夜。
 * 日历本身的每个日程块颜色由用户逐条指定，界面基调不需要更多花样——
 * 减少可选项，也减少每套配色都要保证对比度达标的维护成本。
 * - day    白日：暖白纸感 + 近黑 + 克制的蓝，白天室内光线下最清晰
 * - night  黑夜：深灰蓝 + 浅灰字 + 低饱和蓝，夜间长时间看不刺眼
 */
export const THEMES = ['day', 'night'] as const;
export type ThemeKey = (typeof THEMES)[number];

/** 旧版本用过的主题键，仅用于把历史配置平滑迁移到 day/night。 */
export const LEGACY_THEME_ALIASES: Record<string, ThemeKey> = {
  midnight: 'night',
  braun: 'day',
  nomos: 'day',
  bauhaus: 'day',
};

/** 可切换的日历视图（年视图不在设置项内，组件自带）。 */
export const VIEWS = ['day', 'week', 'month', 'agenda'] as const;
export type ViewKey = (typeof VIEWS)[number];

/** 可持久化的界面设置。服务端按用户各存一份，浏览器本地再缓存一份用于首屏免闪。 */
export interface AppSettings {
  theme: ThemeKey;
  timeFormat: '12-hour' | '24-hour';
  firstDayOfWeek: 'monday' | 'sunday';
  defaultView: ViewKey;
  /** 侧栏是否常驻展开。 */
  sidebarOpen: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'day',
  timeFormat: '24-hour',
  firstDayOfWeek: 'monday',
  defaultView: 'week',
  sidebarOpen: true,
};

/** 允许日程颜色（映射到 @ilamy/calendar 的色板）。 */
export const EVENT_COLORS = [
  'blue',
  'green',
  'red',
  'yellow',
  'purple',
  'pink',
  'indigo',
  'gray',
] as const;
export type EventColor = (typeof EVENT_COLORS)[number];

/** 相对时间窗口关键字，供 AI 直接传语义化范围，不必自己算日期。 */
export const TIME_WINDOWS = [
  'today',
  'tomorrow',
  'yesterday',
  'this_week',
  'next_week',
  'this_month',
  'next_7_days',
  'next_30_days',
] as const;
export type TimeWindow = (typeof TIME_WINDOWS)[number];

/** 冲突处理策略：allow=照写但返回警告；reject=有冲突直接报 409。 */
export const ON_CONFLICT = ['allow', 'reject'] as const;
export type OnConflict = (typeof ON_CONFLICT)[number];

/** 删除方式：soft=进回收站（默认）；hard=直接抹掉。 */
export const DELETE_MODES = ['soft', 'hard'] as const;
export type DeleteMode = (typeof DELETE_MODES)[number];

/** 用户角色。admin 可以管理其他账号；member 只能动自己的数据。 */
export const USER_ROLES = ['admin', 'member'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** 机器可读错误码。AI 收到后可按 code 分支自愈，不必解析 message 文本。 */
export const ERROR_CODES = [
  'INVALID_REQUEST',
  'VALIDATION_FAILED',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'VERSION_CONFLICT',
  'CONFLICT_REJECTED',
  'BATCH_TOO_LARGE',
  'IDEMPOTENCY_KEY_REUSED',
  'LAST_ADMIN',
  'INTERNAL_ERROR',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/* ───────────────────────── 用户与鉴权 ───────────────────────── */

/** 对外暴露的用户信息，绝不包含任何口令或哈希。 */
export interface User {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LoginInput {
  username: string;
  password: string;
}

/** 登录成功后的返回：用户本体 + 当前会话过期时间。 */
export interface LoginResult {
  user: User;
  expiresAt: string;
}

/** 供 AI Agent 使用的长期令牌。明文只在创建那一刻返回一次。 */
export interface ApiToken {
  id: string;
  /** 便于识别的备注名，例：Claude Agent */
  name: string;
  /** 明文前缀（前 12 位），列表里用来对号入座，不足以还原令牌 */
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revoked: boolean;
}

/** 创建令牌的返回：多一个 token 字段，是唯一一次能看到明文的机会。 */
export interface ApiTokenCreated extends ApiToken {
  token: string;
}

/** 创建用户的输入。 */
export interface CreateUserInput {
  username: string;
  password: string;
  displayName?: string;
  role?: UserRole;
}

export interface UpdateUserInput {
  displayName?: string;
  password?: string;
  role?: UserRole;
  disabled?: boolean;
}

/* ───────────────────────── 初始化引导 ───────────────────────── */

/**
 * 浏览器初始化引导的状态。
 * 库里一个用户都没有时（且没有用 ADMIN_PASSWORD 自动建号），服务端会把首个管理员的
 * 创建权交给浏览器，而不是打印在控制台等人来抄。
 */
export interface SetupStatus {
  service: string;
  version: string;
  /** true：还没有任何用户，必须先创建管理员才能登录 */
  needsSetup: boolean;
  /** 是否启用鉴权。false 时不存在引导一说，打开即用 */
  authRequired: boolean;
  /** 仅作输入框预填提示，可以改 */
  suggestedUsername: string;
}

/** 创建首个管理员的输入。 */
export interface SetupAdminInput {
  username: string;
  password: string;
  displayName?: string;
}

/* ───────────────────────── 日历分组 ───────────────────────── */

/**
 * 日历分组：给日程分类，并支持整组显隐。
 * 当前每个分组归属于单个用户（ownerId），互不可见。
 * 【预留】将来要支持共享时，加一张 members 表并在这里加 shared 标记即可，
 * 现有字段与接口都不必改动。
 */
export interface CalendarGroup {
  id: string;
  /** 归属用户；当前恒等于调用者自己 */
  ownerId: string;
  name: string;
  color: EventColor;
  /** 侧栏里是否勾选显示 */
  visible: boolean;
  /** 越小越靠前 */
  sortOrder: number;
  /** 每个用户的默认分组，不可删除 */
  isDefault: boolean;
  /** 【预留】将来做共享时的成员数，当前恒为 1 */
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCalendarInput {
  name: string;
  color?: EventColor;
  visible?: boolean;
  sortOrder?: number;
}

export interface UpdateCalendarInput {
  name?: string;
  color?: EventColor;
  visible?: boolean;
  sortOrder?: number;
}

/* ───────────────────────── 日程实体 ───────────────────────── */

/** 日程实体（服务端返回的完整形态）。 */
export interface ScheduleEvent {
  /** 全局唯一 ID，创建时由服务端生成。 */
  id: string;
  /** 归属用户，调用者只能看到自己的。 */
  ownerId: string;
  title: string;
  /** 开始时间，ISO 8601 带偏移。 */
  start: string;
  /** 结束时间，ISO 8601 带偏移。end 必须晚于 start（全天日程按自然日比较）。 */
  end: string;
  /** 是否全天日程。全天日程的 start/end 应为当天 00:00。 */
  allDay: boolean;
  description?: string;
  location?: string;
  color?: EventColor;
  /** 日历分组 id。 */
  calendarId: string;
  /** IANA 时区名，缺省取服务端配置时区。 */
  timezone: string;
  /** 【预留】RFC 5545 重复规则，本轮恒为 null，不做展开。 */
  rrule: string | null;
  /** 【预留】重复例外日期，本轮恒为 []。 */
  exdates: string[];
  /** 软删除时间；为 null 表示在正常列表里，有值表示躺在回收站。 */
  deletedAt: string | null;
  /** 乐观锁版本号，每次写入 +1。写操作可带 If-Match 头做并发保护。 */
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** 创建日程的输入。id/version/时间戳由服务端生成。 */
export interface CreateEventInput {
  title: string;
  start: string;
  end: string;
  allDay?: boolean;
  description?: string;
  location?: string;
  color?: EventColor;
  calendarId?: string;
  timezone?: string;
}

/** 局部更新输入：只传要改的字段。 */
export type UpdateEventInput = Partial<CreateEventInput>;

/** 列表查询参数（GET /api/events）。 */
export interface ListEventsQuery {
  /** 绝对起始时间，ISO 8601。与 window 互斥，优先于 window。 */
  from?: string;
  /** 绝对结束时间，ISO 8601，开区间。 */
  to?: string;
  /** 相对窗口关键字；from/to 缺省时生效。 */
  window?: TimeWindow;
  /** 标题/描述/地点模糊搜索。 */
  q?: string;
  calendarId?: string;
  /** 只取指定分组；逗号分隔可传多个。 */
  calendarIds?: string;
  /** true 时返回回收站里的日程（默认 false，即只返回正常日程）。 */
  deleted?: boolean;
  limit?: number;
  offset?: number;
  /** 排序方向，默认 asc（按 start 升序）。 */
  order?: 'asc' | 'desc';
}

/** 冲突检测结果：与某条既有日程时间重叠。 */
export interface ConflictInfo {
  /** 与哪条日程冲突。 */
  eventId: string;
  title: string;
  start: string;
  end: string;
  /** 重叠时长（分钟）。 */
  overlapMinutes: number;
}

/** 统一成功响应信封。 */
export interface ApiSuccess<T> {
  ok: true;
  data: T;
  meta?: Record<string, unknown>;
}

/** 统一失败响应信封。 */
export interface ApiFailure {
  ok: false;
  error: {
    /** 机器可读错误码，见 ERROR_CODES。 */
    code: ErrorCode;
    /** 人类可读描述。 */
    message: string;
    /** 结构化字段级错误，AI 可据此改写请求体后重试。 */
    details?: Array<{ field: string; message: string }>;
    /** 修复建议：告诉调用方下一步该做什么。 */
    hint?: string;
  };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

/** 写操作（create/update/delete）的统一返回体。 */
export interface WriteResult<T> {
  /** true 表示未落库，仅返回将要发生的变化（试运行）。 */
  dryRun: boolean;
  /** 受影响的对象；删除时为被删对象的快照。 */
  result: T;
  /** 变更前后对比；删除时 before 为快照、after 为 null。 */
  changes?: { before: ScheduleEvent | null; after: ScheduleEvent | null };
  /** 非阻断性提示（如时间冲突、无实际变更）。 */
  warnings?: Array<{ code: string; message: string; conflicts?: ConflictInfo[] }>;
}

/** 批量操作里的单个操作描述。 */
export type BatchOperation =
  | { op: 'create'; idempotencyKey?: string; data: CreateEventInput }
  | { op: 'update'; id: string; data: UpdateEventInput }
  | { op: 'delete'; id: string; mode?: DeleteMode };

/** GET /api/meta 的返回：服务自描述，AI 只读这一个接口就能上手。 */
export interface ApiMeta {
  service: string;
  version: string;
  timezone: string;
  timeFormat: string;
  /** 鉴权说明：AI 必须先知道怎么带上身份，否则后续所有调用都会 401。 */
  authentication: {
    required: boolean;
    /** 支持的凭据传递方式，按推荐顺序排列 */
    schemes: Array<{
      type: 'api_token' | 'session_cookie';
      /** 例：Authorization: Bearer <token> */
      header: string;
      description: string;
    }>;
    /** 令牌怎么拿：登录后调用创建令牌接口 */
    howToGetToken: string;
  };
  /**
   * 初始化引导。required 为 true 时，这个实例还没有任何用户，
   * 必须先由人类在浏览器里创建管理员，Agent 无法也不应该代劳。
   */
  onboarding: {
    required: boolean;
    endpoint: string;
    description: string;
  };
  capabilities: {
    recurrence: boolean;
    multiUser: boolean;
    auth: boolean;
    dryRun: boolean;
    idempotency: boolean;
    batch: boolean;
    /** 界面设置是否在服务端持久化 */
    settings: boolean;
    /** 是否有回收站（软删除 + 恢复） */
    trash: boolean;
    /** 是否有多日历分组 */
    calendars: boolean;
    /** 是否提供浏览器初始化引导（首个管理员可在线创建） */
    onboarding: boolean;
  };
  limits: {
    maxBatchSize: number;
    defaultLimit: number;
    maxLimit: number;
    maxTitleLength: number;
    maxCalendars: number;
    maxTokens: number;
  };
  enums: {
    colors: readonly string[];
    timeWindows: readonly string[];
    onConflict: readonly string[];
    deleteModes: readonly string[];
    roles: readonly string[];
    errorCodes: readonly string[];
  };
  endpoints: Array<{
    method: string;
    path: string;
    summary: string;
    sideEffect: 'read' | 'write';
    riskLevel: 'safe' | 'confirm' | 'danger';
    /** 是否需要登录；false 表示未登录也能调（登录接口本身） */
    auth: boolean;
  }>;
  /**
   * 最小上手序列。按这个顺序照抄即可跑通一次完整读写，
   * 不必先通读协议文档——对模型来说这比一整本说明书省 token。
   */
  quickstart: Array<{
    step: number;
    /** 例：GET /api/events?window=today */
    request: string;
    note: string;
  }>;
  /** 一段可直接塞进系统提示的自描述文本，语言与语气都已调好。 */
  agentPrompt: string;
  docs: { protocol: string; openapi: string; brief: string };
}
