/**
 * 令牌与 ID 生成。
 * 明文令牌只在创建那一刻返回一次，库里只留 SHA-256 —— 数据库泄漏也无法直接冒用。
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';

/** API 令牌前缀，便于在日志与配置里识别来源。 */
export const TOKEN_PREFIX = 'isk';

/** 令牌明文里可以拿出来展示的位数（列表里用来对号入座，不足以还原令牌）。 */
const DISPLAY_LEN = TOKEN_PREFIX.length + 1 + 8;

export interface GeneratedToken {
  /** 明文，只此一次 */
  token: string;
  /** 落库的 SHA-256 */
  hash: string;
  /** 展示用前缀，例 isk_9f3a2b1c */
  prefix: string;
}

export function generateToken(): GeneratedToken {
  const secret = randomBytes(32).toString('base64url');
  const token = `${TOKEN_PREFIX}_${secret}`;
  return { token, hash: hashToken(token), prefix: token.slice(0, DISPLAY_LEN) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 业务 ID。前缀让日志和接口返回一眼能看出是什么实体。 */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}

/** 生成一个便于人工抄写的一次性口令（引导管理员时用）。 */
export function generatePassword(length = 16): string {
  // 去掉 0/O/1/l/I 这类易混字符
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out;
}
