import { z } from 'zod';
import {
  DELETE_MODES,
  EVENT_COLORS,
  ON_CONFLICT,
  THEMES,
  TIME_WINDOWS,
  USER_ROLES,
  VIEWS,
} from '../../shared/types';
import { config } from './config';
import { PASSWORD_MAX, PASSWORD_MIN } from './lib/password';
import { validationFailed } from './lib/errors';

const colorEnum = z.enum(EVENT_COLORS);

const timeString = z
  .string()
  .trim()
  .min(1, '时间不能为空')
  .refine((v) => !Number.isNaN(new Date(v).getTime()) || /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/.test(v), {
    message: '时间需为 ISO 8601，例：2026-10-12T10:00:00+08:00',
  });

/* ───────────────────────── 日程 ───────────────────────── */

export const createEventSchema = z.object({
  title: z.string().trim().min(1, '标题不能为空').max(config.limits.maxTitleLength, '标题过长'),
  start: timeString,
  end: timeString,
  allDay: z.boolean().optional(),
  description: z.string().max(4000).optional(),
  location: z.string().max(200).optional(),
  color: colorEnum.optional(),
  calendarId: z.string().trim().min(1).max(64).optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
});

export const updateEventSchema = createEventSchema.partial().refine(
  (v) => Object.keys(v).length > 0,
  { message: '至少需要提供一个待更新字段' },
);

/** 完整替换（PUT）：必填 title/start/end。 */
export const replaceEventSchema = createEventSchema.required({ title: true, start: true, end: true });

export const listQuerySchema = z.object({
  from: z.string().trim().min(1).optional(),
  to: z.string().trim().min(1).optional(),
  window: z.enum(TIME_WINDOWS).optional(),
  q: z.string().trim().min(1).optional(),
  calendarId: z.string().trim().min(1).optional(),
  /** 逗号分隔的多个分组 id；显式传空串表示「没有任何可见分组」，会返回空集 */
  calendarIds: z.string().optional(),
  /** 布尔：true=只看回收站 */
  deleted: z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
    .optional()
    .transform((v) => v === true || v === 'true' || v === '1'),
  limit: z.coerce.number().int().min(1).max(config.limits.maxLimit).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  order: z.enum(['asc', 'desc']).optional(),
});

export const writeQuerySchema = z.object({
  /** 试运行：只返回将要发生的变更，不落库。 */
  dryRun: z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
    .optional()
    .transform((v) => v === true || v === 'true' || v === '1'),
  /** 时间冲突策略：allow（默认，照写+警告）/ reject（409 拒绝）。 */
  onConflict: z.enum(ON_CONFLICT).optional(),
  /** 删除方式：soft=进回收站（默认）/ hard=直接抹掉。 */
  mode: z.enum(DELETE_MODES).optional(),
});

const batchOperationSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('create'),
    idempotencyKey: z.string().trim().min(1).max(128).optional(),
    data: createEventSchema,
  }),
  z.object({ op: z.literal('update'), id: z.string().trim().min(1), data: updateEventSchema }),
  z.object({
    op: z.literal('delete'),
    id: z.string().trim().min(1),
    mode: z.enum(DELETE_MODES).optional(),
  }),
]);

export const batchSchema = z.object({
  dryRun: z.boolean().optional(),
  onConflict: z.enum(ON_CONFLICT).optional(),
  /** true 时任一子操作失败即整体回滚（默认 false：逐条执行并返回逐条结果）。 */
  atomic: z.boolean().optional(),
  operations: z.array(batchOperationSchema).min(1).max(config.limits.maxBatchSize),
});

/* ───────────────────────── 用户与鉴权 ───────────────────────── */

const username = z
  .string()
  .trim()
  .min(3, '用户名至少 3 位')
  .max(32, '用户名最多 32 位')
  .regex(/^[A-Za-z0-9._-]+$/, '用户名只能包含字母、数字、点、下划线与短横线');

const password = z.string().min(PASSWORD_MIN, `口令至少 ${PASSWORD_MIN} 位`).max(PASSWORD_MAX, '口令过长');

export const loginSchema = z.object({
  username: z.string().trim().min(1, '请输入用户名'),
  password: z.string().min(1, '请输入口令'),
});

export const createUserSchema = z.object({
  username,
  password,
  displayName: z.string().trim().max(64).optional(),
  role: z.enum(USER_ROLES).optional(),
});

export const updateUserSchema = z
  .object({
    displayName: z.string().trim().max(64).optional(),
    password: password.optional(),
    role: z.enum(USER_ROLES).optional(),
    disabled: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '至少需要提供一个待更新字段' });

/** 初始化引导：只允许创建首个管理员，不含角色字段。 */
export const setupAdminSchema = z.object({
  username,
  password,
  displayName: z.string().trim().max(64).optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, '请输入当前口令'),
  newPassword: password,
});

/* ───────────────────────── API 令牌 ───────────────────────── */

export const createTokenSchema = z.object({
  name: z.string().trim().min(1, '请给令牌起个名字').max(64, '名字过长'),
  /** 有效期（天）；不传表示长期有效。 */
  ttlDays: z.number().int().min(1).max(3650).nullable().optional(),
});

/* ───────────────────────── 日历分组 ───────────────────────── */

export const createCalendarSchema = z.object({
  name: z.string().trim().min(1, '分组名不能为空').max(40, '分组名过长'),
  color: colorEnum.optional(),
  visible: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(999).optional(),
});

export const updateCalendarSchema = z
  .object({
    name: z.string().trim().min(1).max(40).optional(),
    color: colorEnum.optional(),
    visible: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(999).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '至少需要提供一个待更新字段' });

/* ───────────────────────── 界面设置 ───────────────────────── */

export const settingsSchema = z.object({
  theme: z.enum(THEMES).optional(),
  timeFormat: z.enum(['12-hour', '24-hour']).optional(),
  firstDayOfWeek: z.enum(['monday', 'sunday']).optional(),
  defaultView: z.enum(VIEWS).optional(),
  sidebarOpen: z.boolean().optional(),
});

/** 把 zod 错误转成统一的 VALIDATION_FAILED ApiError。 */
export function toValidationError(err: z.ZodError): never {
  throw validationFailed(
    err.issues.map((i) => ({
      field: i.path.join('.') || '(root)',
      message: i.message,
    })),
    '按 details 里的字段修正后重试。',
  );
}

export type Parsed<T> = T;
