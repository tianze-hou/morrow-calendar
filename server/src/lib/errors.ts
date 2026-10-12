import type { ErrorCode } from '../../../shared/types';

export interface FieldError {
  field: string;
  message: string;
}

export class ApiError extends Error {
  public readonly status: number;
  public readonly code: ErrorCode;
  public readonly details?: FieldError[];
  public readonly hint?: string;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    options?: { details?: FieldError[]; hint?: string },
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = options?.details;
    this.hint = options?.hint;
  }
}

export const badRequest = (message: string, hint?: string) =>
  new ApiError(400, 'INVALID_REQUEST', message, { hint });

export const validationFailed = (details: FieldError[], hint?: string) =>
  new ApiError(400, 'VALIDATION_FAILED', '请求体校验失败', { details, hint });

export const unauthorized = (message = '未登录或凭据无效', hint?: string) =>
  new ApiError(
    401,
    'UNAUTHORIZED',
    message,
    { hint: hint ?? '浏览器端先 POST /api/auth/login；AI Agent 请带 Authorization: Bearer <token>。' },
  );

export const forbidden = (message = '没有权限执行该操作', hint?: string) =>
  new ApiError(403, 'FORBIDDEN', message, { hint });

export const notFound = (message = '日程不存在', hint?: string) =>
  new ApiError(404, 'NOT_FOUND', message, { hint });

export const alreadyExists = (message: string, hint?: string) =>
  new ApiError(409, 'ALREADY_EXISTS', message, { hint });

export const versionConflict = (expected: number | string, actual: number) =>
  new ApiError(
    409,
    'VERSION_CONFLICT',
    `版本冲突：期望 version=${expected}，当前为 ${actual}`,
    { hint: '重新 GET 该日程取最新 version 后重试，或去掉 If-Match 头。' },
  );

export const conflictRejected = (message: string, hint?: string) =>
  new ApiError(409, 'CONFLICT_REJECTED', message, { hint });

/** 不允许删掉/停用最后一个管理员，否则系统会被锁死。 */
export const lastAdmin = (message = '不能移除最后一个管理员') =>
  new ApiError(409, 'LAST_ADMIN', message, {
    hint: '先把另一个用户提升为 admin，再执行本次操作。',
  });
