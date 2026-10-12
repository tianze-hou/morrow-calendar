import type { CreateUserInput, UpdateUserInput, User, UserRole } from '../../../shared/types';
import { getDb } from '../db/index';
import { alreadyExists, forbidden, lastAdmin, notFound } from '../lib/errors';
import { checkPasswordStrength, hashPassword } from '../lib/password';
import { newId } from '../lib/tokens';
import { toUtcIso } from '../lib/time';

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  role: string;
  disabled: number;
  created_at: string;
  updated_at: string;
}

const COLUMNS = 'id, username, display_name, password_hash, role, disabled, created_at, updated_at';

function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: (row.role === 'admin' ? 'admin' : 'member') as UserRole,
    disabled: row.disabled === 1,
    createdAt: toUtcIso(new Date(row.created_at)),
    updatedAt: toUtcIso(new Date(row.updated_at)),
  };
}

export async function countUsers(): Promise<number> {
  const db = await getDb();
  const row = db.get<{ c: number }>('SELECT COUNT(*) AS c FROM users');
  return Number(row?.c ?? 0);
}

export async function countAdmins(): Promise<number> {
  const db = await getDb();
  const row = db.get<{ c: number }>(
    "SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND disabled = 0",
  );
  return Number(row?.c ?? 0);
}

export async function listUsers(): Promise<User[]> {
  const db = await getDb();
  const rows = db.all<UserRow>(`SELECT ${COLUMNS} FROM users ORDER BY created_at ASC`);
  return rows.map(rowToUser);
}

export async function getUser(id: string): Promise<User | null> {
  const db = await getDb();
  const row = db.get<UserRow>(`SELECT ${COLUMNS} FROM users WHERE id = ?`, [id]);
  return row ? rowToUser(row) : null;
}

export async function getUserByUsername(username: string): Promise<User | null> {
  const db = await getDb();
  const row = db.get<UserRow>(`SELECT ${COLUMNS} FROM users WHERE username = ? COLLATE NOCASE`, [
    username,
  ]);
  return row ? rowToUser(row) : null;
}

/** 校验口令 + 拿哈希。登录用，避免把哈希泄给调用方。 */
export async function getPasswordHash(userId: string): Promise<string | null> {
  const db = await getDb();
  const row = db.get<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', [
    userId,
  ]);
  return row?.password_hash ?? null;
}

export async function createUser(input: CreateUserInput): Promise<User> {
  const db = await getDb();
  const username = input.username.trim();
  if (!username) throw new Error('用户名不能为空');
  const reason = checkPasswordStrength(input.password);
  if (reason) throw new Error(reason);

  const dup = await getUserByUsername(username);
  if (dup) throw alreadyExists(`用户名已被占用：${username}`, '换一个用户名，或先删掉旧账号。');

  const id = newId('usr');
  const now = toUtcIso(new Date());
  db.run(
    `INSERT INTO users (id, username, display_name, password_hash, role, disabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    [
      id,
      username,
      input.displayName?.trim() || username,
      hashPassword(input.password),
      input.role === 'admin' ? 'admin' : 'member',
      now,
      now,
    ],
  );

  const created = await getUser(id);
  if (!created) throw new Error('写入后回读失败');
  return created;
}

export async function updateUser(id: string, patch: UpdateUserInput): Promise<User> {
  const db = await getDb();
  const current = await getUser(id);
  if (!current) throw notFound('用户不存在');

  // 降级或停用最后一个管理员会导致无人能管理系统
  const losingAdmin =
    current.role === 'admin' && ((patch.role && patch.role !== 'admin') || patch.disabled === true);
  if (losingAdmin && (await countAdmins()) <= 1) throw lastAdmin();

  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (col: string, val: unknown) => {
    sets.push(`${col} = ?`);
    params.push(val);
  };

  if (patch.displayName !== undefined) set('display_name', patch.displayName.trim() || current.username);
  if (patch.role !== undefined) set('role', patch.role === 'admin' ? 'admin' : 'member');
  if (patch.disabled !== undefined) set('disabled', patch.disabled ? 1 : 0);
  if (patch.password !== undefined) {
    const reason = checkPasswordStrength(patch.password);
    if (reason) throw new Error(reason);
    set('password_hash', hashPassword(patch.password));
  }

  if (sets.length === 0) return current;

  set('updated_at', toUtcIso(new Date()));
  params.push(id);
  db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);

  const updated = await getUser(id);
  if (!updated) throw notFound('用户不存在');
  return updated;
}

/** 删除用户，并连带清掉他的日程、日历、令牌与设置。 */
export async function deleteUser(id: string): Promise<void> {
  const db = await getDb();
  const current = await getUser(id);
  if (!current) throw notFound('用户不存在');
  if (current.role === 'admin' && (await countAdmins()) <= 1) throw lastAdmin();
  if (current.username === 'local') throw forbidden('内置的 local 账号不可删除');

  db.transaction(() => {
    db.run('DELETE FROM events WHERE user_id = ?', [id]);
    db.run('DELETE FROM calendars WHERE user_id = ?', [id]);
    db.run('DELETE FROM api_tokens WHERE user_id = ?', [id]);
    db.run('DELETE FROM sessions WHERE user_id = ?', [id]);
    db.run("DELETE FROM settings WHERE key LIKE ?", [`ui.${id}.%`]);
    db.run('DELETE FROM users WHERE id = ?', [id]);
  });
}
