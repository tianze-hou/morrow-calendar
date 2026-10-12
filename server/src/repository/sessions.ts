/** 浏览器会话：只存令牌哈希，明文令牌放在 HttpOnly cookie 里。 */
import { config } from '../config';
import { getDb } from '../db/index';
import { hashToken, generateToken } from '../lib/tokens';
import { toUtcIso } from '../lib/time';

export interface CreatedSession {
  token: string;
  expiresAt: string;
}

export async function createSession(userId: string, userAgent?: string): Promise<CreatedSession> {
  const db = await getDb();
  const { token, hash } = generateToken();
  const now = new Date();
  const expires = new Date(now.getTime() + config.auth.sessionDays * 24 * 60 * 60 * 1000);
  db.run(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)',
    [hash, userId, toUtcIso(now), toUtcIso(expires), userAgent ?? null],
  );
  return { token, expiresAt: toUtcIso(expires) };
}

/** 解析会话令牌 → 用户 id；过期的顺手清掉。 */
export async function resolveSession(token: string): Promise<string | null> {
  const db = await getDb();
  const hash = hashToken(token);
  const row = db.get<{ user_id: string; expires_at: string }>(
    'SELECT user_id, expires_at FROM sessions WHERE token_hash = ?',
    [hash],
  );
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    db.run('DELETE FROM sessions WHERE token_hash = ?', [hash]);
    return null;
  }
  return row.user_id;
}

export async function deleteSession(token: string): Promise<void> {
  const db = await getDb();
  db.run('DELETE FROM sessions WHERE token_hash = ?', [hashToken(token)]);
}

export async function deleteUserSessions(userId: string): Promise<void> {
  const db = await getDb();
  db.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
}

/** 清理所有过期会话；服务启动时跑一次即可。 */
export async function purgeExpiredSessions(): Promise<number> {
  const db = await getDb();
  const res = db.run('DELETE FROM sessions WHERE expires_at <= ?', [toUtcIso(new Date())]);
  return res.changes;
}
