/** 供 AI Agent 使用的长期 API 令牌。 */
import type { ApiToken, ApiTokenCreated } from '../../../shared/types';
import { config } from '../config';
import { getDb } from '../db/index';
import { forbidden, notFound } from '../lib/errors';
import { generateToken, hashToken, newId } from '../lib/tokens';
import { toUtcIso } from '../lib/time';

interface TokenRow {
  id: string;
  user_id: string;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

const COLUMNS = 'id, user_id, name, prefix, created_at, last_used_at, expires_at, revoked_at';

function rowToToken(row: TokenRow): ApiToken {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    createdAt: toUtcIso(new Date(row.created_at)),
    lastUsedAt: row.last_used_at ? toUtcIso(new Date(row.last_used_at)) : null,
    expiresAt: row.expires_at ? toUtcIso(new Date(row.expires_at)) : null,
    revoked: row.revoked_at !== null,
  };
}

export async function listTokens(userId: string): Promise<ApiToken[]> {
  const db = await getDb();
  const rows = db.all<TokenRow>(
    `SELECT ${COLUMNS} FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC`,
    [userId],
  );
  return rows.map(rowToToken);
}

export async function countActiveTokens(userId: string): Promise<number> {
  const db = await getDb();
  const row = db.get<{ c: number }>(
    'SELECT COUNT(*) AS c FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL',
    [userId],
  );
  return Number(row?.c ?? 0);
}

/**
 * 创建令牌。明文只在返回值里出现一次，之后库里只有哈希。
 * ttlDays 传 null 表示永不过期（默认，方便 Agent 长期使用）。
 */
export async function createToken(
  userId: string,
  name: string,
  ttlDays: number | null,
): Promise<ApiTokenCreated> {
  const db = await getDb();
  if ((await countActiveTokens(userId)) >= config.limits.maxTokens) {
    throw forbidden(
      `每个用户最多保留 ${config.limits.maxTokens} 个有效令牌`,
      '先吊销不再使用的令牌，再创建新的。',
    );
  }

  const id = newId('tok');
  const { token, hash, prefix } = generateToken();
  const now = new Date();
  const expiresAt =
    ttlDays === null ? null : toUtcIso(new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000));

  db.run(
    `INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, created_at, last_used_at, expires_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
    [id, userId, name.trim() || '未命名令牌', hash, prefix, toUtcIso(now), expiresAt],
  );

  return {
    id,
    name: name.trim() || '未命名令牌',
    prefix,
    createdAt: toUtcIso(now),
    lastUsedAt: null,
    expiresAt,
    revoked: false,
    token,
  };
}

/** 吊销（保留记录，便于审计）。 */
export async function revokeToken(userId: string, id: string): Promise<ApiToken> {
  const db = await getDb();
  const row = db.get<TokenRow>(`SELECT ${COLUMNS} FROM api_tokens WHERE id = ? AND user_id = ?`, [
    id,
    userId,
  ]);
  if (!row) throw notFound('令牌不存在');
  if (!row.revoked_at) {
    db.run('UPDATE api_tokens SET revoked_at = ? WHERE id = ?', [toUtcIso(new Date()), id]);
  }
  const updated = db.get<TokenRow>(`SELECT ${COLUMNS} FROM api_tokens WHERE id = ?`, [id]);
  return rowToToken(updated ?? row);
}

/** 彻底删除记录。 */
export async function deleteToken(userId: string, id: string): Promise<void> {
  const db = await getDb();
  const res = db.run('DELETE FROM api_tokens WHERE id = ? AND user_id = ?', [id, userId]);
  if (res.changes === 0) throw notFound('令牌不存在');
}

/** 用明文令牌解析用户 id；顺带刷新 last_used_at。 */
export async function resolveToken(token: string): Promise<string | null> {
  const db = await getDb();
  const hash = hashToken(token);
  const row = db.get<{ id: string; user_id: string; expires_at: string | null; revoked_at: string | null }>(
    'SELECT id, user_id, expires_at, revoked_at FROM api_tokens WHERE token_hash = ?',
    [hash],
  );
  if (!row) return null;
  if (row.revoked_at !== null) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return null;

  db.run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', [toUtcIso(new Date()), row.id]);
  return row.user_id;
}
