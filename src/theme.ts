/**
 * 配色方案：定义、应用与本地缓存。
 *
 * 只保留两套 —— 一昼一夜。日程块的颜色由用户逐条指定，
 * 界面基调不需要更多花样；可选项越少，每套配色的对比度就越容易守住。
 */
import { LEGACY_THEME_ALIASES, THEMES, type AppSettings, type ThemeKey } from '../shared/types';

export interface Palette {
  /** 方案名 */
  label: string;
  /** 一句设计说明，展示在设置面板里 */
  note: string;
  /** 是否深色（用于切换 html.dark 类与浏览器 color-scheme） */
  dark: boolean;
  /** 设置面板色卡上从左到右的三块颜色：底 / 强调 / 文字 */
  swatch: [string, string, string];
}

export const PALETTES: Record<ThemeKey, Palette> = {
  day: {
    label: '白日',
    note: '米黄纸底 + 陶土橘 + 深褐字，像在纸上写字，室内光下最稳',
    dark: false,
    swatch: ['#f7f1e5', '#ad5c30', '#2b2420'],
  },
  night: {
    label: '黑夜',
    note: '深褐底 + 琥珀强调 + 米白字，关灯后像暖光下的纸，不刺眼',
    dark: true,
    swatch: ['#1a1614', '#d09258', '#e6ddcf'],
  },
};

export const THEME_OPTIONS = THEMES.map((key) => ({ key, ...PALETTES[key] }));

const STORAGE_KEY = 'morrow-calendar.settings';

/** 把历史版本用过的主题键折算成 day/night；无法识别时回落到白日。 */
export function normalizeTheme(value: unknown): ThemeKey {
  if (typeof value !== 'string') return 'day';
  if ((THEMES as readonly string[]).includes(value)) return value as ThemeKey;
  return LEGACY_THEME_ALIASES[value] ?? 'day';
}

/** 把主题写到 <html>，令牌切换即完成换肤，无需重新渲染 React 树。 */
export function applyTheme(theme: ThemeKey): void {
  const safe = normalizeTheme(theme);
  const root = document.documentElement;
  root.dataset.theme = safe;
  root.classList.toggle('dark', PALETTES[safe].dark);
  root.style.colorScheme = PALETTES[safe].dark ? 'dark' : 'light';
}

/** 本地缓存：首屏立刻套用，避免先闪一下默认色再跳到用户主题。 */
export function readLocalSettings(): Partial<AppSettings> | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    if (!parsed || typeof parsed !== 'object') return null;
    if ('theme' in parsed) parsed.theme = normalizeTheme(parsed.theme);
    return parsed;
  } catch {
    return null;
  }
}

export function writeLocalSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* 隐私模式下 localStorage 不可写，忽略即可 */
  }
}

export function clearLocalSettings(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* 同上 */
  }
}
