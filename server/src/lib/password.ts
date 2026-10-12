/**
 * 口令哈希。
 * 用 Node 内置 crypto 的 scrypt —— 无需任何原生依赖，抗暴力破解强度足够，
 * 且刻意不引入 bcrypt/argon2 这类要编译的包（本机没有 C++ 工具链的历史教训）。
 *
 * 存储格式：scrypt$N$r$p$<saltHex>$<hashHex>
 * 把参数写进哈希串里，将来调参也不会让旧口令失效。
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const N = 16384; // CPU/内存开销
const R = 8;
const P = 1;
const KEY_LEN = 64;

/** 口令长度下限。上限防止超长输入拖垮 scrypt。 */
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/** 恒定时间比较，避免通过响应耗时逐字节猜口令。 */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  let expected: Buffer;
  let salt: Buffer;
  try {
    salt = Buffer.from(parts[4], 'hex');
    expected = Buffer.from(parts[5], 'hex');
  } catch {
    return false;
  }
  if (expected.length === 0) return false;

  let actual: Buffer;
  try {
    actual = scryptSync(password, salt, expected.length, { N: n, r, p });
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** 口令强度检查。返回 null 表示合格，否则返回给用户看的原因。 */
export function checkPasswordStrength(password: string): string | null {
  if (password.length < PASSWORD_MIN) return `口令至少 ${PASSWORD_MIN} 位`;
  if (password.length > PASSWORD_MAX) return `口令最多 ${PASSWORD_MAX} 位`;
  return null;
}
