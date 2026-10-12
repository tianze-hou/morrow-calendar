/**
 * 界面设置的持久化仓储。
 * 用一张简单的键值表存，键名形如 `ui.<userId>.<field>`，天然按用户隔离。
 * 后续若把设置拆到独立表，只需换实现，接口不变。
 */
import {
  DEFAULT_SETTINGS,
  LEGACY_THEME_ALIASES,
  THEMES,
  VIEWS,
  type AppSettings,
} from '../../../shared/types';
import { getDb } from '../db/index';
import { toUtcIso } from '../lib/time';

const PREFIX = 'ui.';

const userPrefix = (userId: string) => `${PREFIX}${userId}.`;

function coerce(key: keyof AppSettings, raw: string): AppSettings[keyof AppSettings] | null {
  switch (key) {
    case 'theme': {
      // 兼容历史版本写下的 midnight/braun/nomos/bauhaus
      const normalized = (THEMES as readonly string[]).includes(raw)
        ? (raw as AppSettings['theme'])
        : LEGACY_THEME_ALIASES[raw];
      return normalized ?? null;
    }
    case 'timeFormat':
      return raw === '12-hour' || raw === '24-hour' ? raw : null;
    case 'firstDayOfWeek':
      return raw === 'monday' || raw === 'sunday' ? raw : null;
    case 'defaultView':
      return (VIEWS as readonly string[]).includes(raw) ? (raw as AppSettings['defaultView']) : null;
    case 'sidebarOpen':
      return raw === 'true' ? true : raw === 'false' ? false : null;
    default:
      return null;
  }
}

export interface SettingsResult {
  settings: AppSettings;
  /** default = 从未保存过；stored = 全部字段都在库里；partial = 只存过一部分 */
  source: 'default' | 'stored' | 'partial';
}

export async function getSettings(userId: string): Promise<SettingsResult> {
  const db = await getDb();
  const prefix = userPrefix(userId);
  const rows = db.all<{ key: string; value: string }>(
    'SELECT key, value FROM settings WHERE key LIKE ?',
    [`${prefix}%`],
  );

  const found: Partial<AppSettings> = {};
  for (const row of rows) {
    const field = row.key.slice(prefix.length) as keyof AppSettings;
    const value = coerce(field, row.value);
    if (value !== null) found[field] = value as never;
  }

  if (rows.length === 0) return { settings: { ...DEFAULT_SETTINGS }, source: 'default' };
  return {
    settings: { ...DEFAULT_SETTINGS, ...found },
    source: Object.keys(found).length === rows.length ? 'stored' : 'partial',
  };
}

export async function updateSettings(
  userId: string,
  patch: Partial<AppSettings>,
): Promise<AppSettings> {
  const db = await getDb();
  const now = toUtcIso(new Date());

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    db.run(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      [`${userPrefix(userId)}${key}`, String(value), now],
    );
  }

  return (await getSettings(userId)).settings;
}

/** 恢复出厂设置：只清掉当前用户的配置，不影响别人。 */
export async function resetSettings(userId: string): Promise<AppSettings> {
  const db = await getDb();
  db.run('DELETE FROM settings WHERE key LIKE ?', [`${userPrefix(userId)}%`]);
  return { ...DEFAULT_SETTINGS };
}

/**
 * 把 v2 时代无归属的设置键（ui.theme 这类）划归到指定用户名下。
 * 只在首次引导时调用一次。
 */
export async function adoptLegacySettings(userId: string): Promise<number> {
  const db = await getDb();
  const rows = db.all<{ key: string; value: string }>(
    "SELECT key, value FROM settings WHERE key LIKE 'ui.%' AND key NOT LIKE 'ui.%.%'",
  );
  if (rows.length === 0) return 0;
  const now = toUtcIso(new Date());
  for (const row of rows) {
    const field = row.key.slice(PREFIX.length);
    db.run(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      [`${userPrefix(userId)}${field}`, row.value, now],
    );
    db.run('DELETE FROM settings WHERE key = ?', [row.key]);
  }
  return rows.length;
}
