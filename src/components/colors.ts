/**
 * 日程色板。
 *
 * 组件内部会对十六进制色自动推算一块可读的文字色（浅底转黑字、深底转白字），
 * 因此这里刻意全部选「中等偏深」的档位，避免落在中间灰区导致文字对比不足。
 * 色相沿用包豪斯式的克制版本：饱和但不刺眼，在昼夜两套主题下都成立。
 */
import type { EventColor } from '../../shared/types';

export const COLOR_HEX: Record<EventColor, string> = {
  blue: '#3f6f9f',
  green: '#4f7d5a',
  red: '#a94a3c',
  // 黄档比其余色相更暗一档：中等黄配白字只有 3.9:1，压到 #8a6d1f 才够 4.9:1
  yellow: '#8a6d1f',
  purple: '#6e5a94',
  pink: '#a05a72',
  indigo: '#4a5a94',
  gray: '#6b7280',
};

/** 颜色中文名，用于无障碍标签与悬浮提示 */
export const COLOR_LABEL: Record<EventColor, string> = {
  blue: '蓝',
  green: '绿',
  red: '红',
  yellow: '黄',
  purple: '紫',
  pink: '粉',
  indigo: '靛',
  gray: '灰',
};
