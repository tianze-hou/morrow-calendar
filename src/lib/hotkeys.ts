/**
 * 全局快捷键。
 *
 * 只做一件事：键位、说明、分组和动作一起声明，帮助面板直接从这份声明生成。
 * 否则迟早会变成「改了键位、忘了改文案」，而快捷键没有提示就等于没有。
 *
 * 组合键写法：`mod+enter`、`mod+shift+z`、`?`、`d`。
 * `mod` 在 macOS 上是 ⌘，其他平台是 Ctrl —— 匹配时两者都认，不必先判断平台。
 */
import { useEffect, useRef } from 'react';

export interface HotkeySpec {
  /** 组合键。最后一段是按键本身，前面是修饰键（mod / shift / alt）。 */
  combo: string;
  /** 帮助面板里的说明，动词开头。 */
  label: string;
  /** 帮助面板里的分组，同组会排在一起。 */
  group: string;
  /**
   * 焦点在输入框 / 文本域 / contenteditable 里时是否仍然生效。
   * 默认关：打字时的字母键属于输入框，全局快捷键不该抢。
   */
  whileTyping?: boolean;
  run: () => void;
}

interface ParsedCombo {
  key: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
}

function parseCombo(combo: string): ParsedCombo {
  const parts = combo.toLowerCase().split('+');
  const key = parts.pop() ?? '';
  return {
    key,
    mod: parts.includes('mod'),
    shift: parts.includes('shift'),
    alt: parts.includes('alt'),
  };
}

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** 焦点是否落在「用户正在打字」的地方。 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return TYPING_TAGS.has(target.tagName) || target.isContentEditable;
}

/**
 * 修饰键要求严格相等，多按一个 Shift 就不算命中。
 * 否则 `mod+z` 会把 `mod+shift+z`（通常是另一件事）一起吃掉。
 *
 * 符号键是例外：`?` 本身就得按住 Shift 才打得出来，浏览器给的 `e.key` 已经
 * 是 `?` 而不是 `/`。对这类键不再校验 Shift，否则真实键盘上永远按不出来。
 */
function matches(spec: ParsedCombo, e: KeyboardEvent): boolean {
  if (e.altKey !== spec.alt) return false;
  if ((e.ctrlKey || e.metaKey) !== spec.mod) return false;
  if (e.key.toLowerCase() !== spec.key) return false;
  const symbolic = spec.key.length === 1 && !/[a-z0-9]/.test(spec.key);
  return symbolic || e.shiftKey === spec.shift;
}

function isApplePlatform(): boolean {
  return /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);
}

/** 把组合键拆成渲染用的键帽，`?` 这类单字符原样返回。 */
export function comboKeys(combo: string): string[] {
  const apple = isApplePlatform();
  const parsed = parseCombo(combo);
  const keys: string[] = [];
  if (parsed.mod) keys.push(apple ? '⌘' : 'Ctrl');
  if (parsed.shift) keys.push(apple ? '⇧' : 'Shift');
  if (parsed.alt) keys.push(apple ? '⌥' : 'Alt');
  keys.push(parsed.key === 'enter' ? 'Enter' : parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key);
  return keys;
}

/**
 * 注册一批快捷键。
 *
 * `enabled=false` 时整体摘掉监听 —— 弹窗打开期间就靠这个把控制权交还给弹窗，
 * 免得 Esc / 字母键被两边同时响应。
 */
export function useHotkeys(specs: HotkeySpec[], enabled = true): void {
  // 放进 ref：动作函数每次渲染都是新的，不该因此重新绑监听
  const specsRef = useRef(specs);
  specsRef.current = specs;

  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (e: KeyboardEvent) => {
      // 输入法组字过程中的按键不算快捷键
      if (e.repeat || e.isComposing) return;
      const typing = isTypingTarget(e.target);

      for (const spec of specsRef.current) {
        if (typing && !spec.whileTyping) continue;
        if (!matches(parseCombo(spec.combo), e)) continue;
        e.preventDefault();
        spec.run();
        return;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}
