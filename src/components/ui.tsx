/**
 * 界面基础件。
 *
 * 之所以自己维护一套而不是直接拼 Tailwind 类：
 * 全站的间距、字号、圆角、交互态必须一致，散在十几个组件里迟早会漂。
 * 这里集中定义，改一处即改全站。
 */
import type { ReactNode } from 'react';
import { useEffect, useId, useRef } from 'react';

/* ───────────────────────────── 按钮 ───────────────────────────── */

type BtnVariant = 'primary' | 'outline' | 'ghost' | 'danger' | 'quiet';

const BTN_BASE =
  'inline-flex items-center justify-center gap-1.5 rounded-[var(--radius-md)] font-medium transition-colors ' +
  'disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-2';

const BTN_SIZE = {
  sm: 'h-7 px-2.5 text-xs',
  md: 'h-8 px-3 text-sm',
  lg: 'h-9 px-4 text-sm',
} as const;

const BTN_VARIANT: Record<BtnVariant, string> = {
  primary: 'bg-primary text-primary-foreground hover:brightness-110',
  outline: 'border border-border bg-card text-foreground hover:bg-accent',
  ghost: 'text-muted-foreground hover:bg-accent hover:text-foreground',
  danger: 'border border-[color:var(--destructive)] text-[color:var(--destructive)] hover:bg-[color-mix(in_srgb,var(--destructive)_12%,transparent)]',
  quiet: 'text-muted-foreground hover:text-foreground underline decoration-dotted underline-offset-4',
};

export function Btn({
  variant = 'outline',
  size = 'md',
  className = '',
  children,
  ...rest
}: {
  variant?: BtnVariant;
  size?: keyof typeof BTN_SIZE;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={`${BTN_BASE} ${BTN_SIZE[size]} ${BTN_VARIANT[variant]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

/* ───────────────────────────── 表单 ───────────────────────────── */

export const INPUT_CLS =
  'h-8 w-full rounded-[var(--radius-md)] border border-input bg-background px-2.5 text-sm text-foreground ' +
  'placeholder:text-muted-foreground/70 outline-none transition-colors focus:border-ring';

export function Field({
  label,
  hint,
  children,
  className = '',
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1.5 block text-xs text-muted-foreground">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-2xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex overflow-hidden rounded-[var(--radius-md)] border border-border">
      {options.map((opt, i) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={`flex-1 px-3 py-1.5 text-sm transition-colors ${
            value === opt.value
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground'
          } ${i === 0 ? '' : 'border-l border-border'}`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex items-center gap-2 text-sm text-foreground"
    >
      <span
        className={`flex w-8 items-center rounded-full border px-0.5 transition-colors ${
          checked ? 'border-primary bg-primary' : 'border-border bg-muted'
        }`}
        style={{ height: '18px' }}
      >
        <span
          className={`h-3 w-3 rounded-full bg-card transition-transform ${
            checked ? 'translate-x-3.5' : 'translate-x-0'
          }`}
          style={{ background: checked ? 'var(--primary-foreground)' : 'var(--muted-foreground)' }}
        />
      </span>
      {label}
    </button>
  );
}

/* ───────────────────────────── 弹窗 ───────────────────────────── */

/**
 * 统一弹层：遮罩点击关闭、Esc 关闭、面板比例一致。
 * 抽出来是为了所有弹窗的宽度与内边距都对齐，不会一个胖一个瘦。
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  footer,
  width = 'md',
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  footer?: ReactNode;
  width?: 'sm' | 'md' | 'lg';
  children: ReactNode;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    // 打开时把焦点移进面板，关闭时还给原来的元素，键盘用户不会「丢焦点」。
    const prev = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;
  const w = width === 'sm' ? 'max-w-sm' : width === 'lg' ? 'max-w-2xl' : 'max-w-lg';

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:items-center"
      style={{ background: 'var(--overlay)' }}
      onClick={onClose}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`my-auto flex w-full ${w} flex-col rounded-[var(--radius-lg)] border border-border bg-card shadow-xl outline-none`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-3.5">
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg font-medium">{title}</h2>
            {description && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>}
          </div>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="-mr-1 -mt-0.5 rounded-[var(--radius-sm)] p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Icon name="close" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>

        {footer && (
          <footer className="flex items-center justify-between gap-3 border-t border-border px-5 py-3.5">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}

/* ───────────────────────────── 图标 ───────────────────────────── */

const PATHS: Record<string, string> = {
  close: 'M4 4l10 10M14 4L4 14',
  menu: 'M3 5h12M3 9h12M3 13h12',
  plus: 'M9 3.5v11M3.5 9h11',
  trash: 'M3 5h12M7 5V3.5h4V5M4.5 5l.7 10h7.6l.7-10M7.5 8v4M10.5 8v4',
  settings:
    'M9 11.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM9 1.8v1.6M9 14.6v1.6M1.8 9h1.6M14.6 9h1.6M3.9 3.9l1.1 1.1M13 13l1.1 1.1M14.1 3.9L13 5M5 13l-1.1 1.1',
  refresh: 'M15 9a6 6 0 11-1.8-4.3M15 2.5V5h-2.5',
  calendar: 'M2.5 4.5h13v10h-13zM2.5 7.5h13M5.5 2.5v3M12.5 2.5v3',
  chevron: 'M6 4l5 5-5 5',
  chevronDown: 'M4 7l5 5 5-5',
  user: 'M9 9.5a2.75 2.75 0 100-5.5 2.75 2.75 0 000 5.5zM3.5 15c.6-2.6 2.9-4 5.5-4s4.9 1.4 5.5 4',
  key: 'M10.5 7.5a2.5 2.5 0 11-2.2-2.5M8.6 8.4L2.5 14.5v1.5h1.5v-1.5h1.5v-1.5h1.5L8.6 8.4z',
  logout: 'M11.5 5.5V3.5h-8v11h8v-2M7.5 9h8M13 6.5L15.5 9 13 11.5',
  restore: 'M9 3.5A5.5 5.5 0 103 9M3 3.5V6h2.5M9 6v3.5l2.5 1.5',
  empty: 'M3 5h12M4.5 5l.7 10h7.6l.7-10M7 8v4M10 8v4M6 3h6',
  check: 'M3.5 9.5l3.5 3.5 7.5-7.5',
  search: 'M8 13A5 5 0 108 3a5 5 0 000 10zM11.8 11.8L15.5 15.5',
  download: 'M9 2.5v8M5.8 7.3L9 10.5l3.2-3.2M3 12.5v2h12v-2',
  keyboard: 'M2 5.5h14v7H2zM4.6 8h.01M7 8h.01M9.4 8h.01M11.8 8h.01M14.2 8h.01M5.4 10.4h7.2',
  edit: 'M11.7 3.6l2.7 2.7-7.4 7.4-3.4.7.7-3.4zM10.2 5.1l2.7 2.7',
  eye: 'M9 5c-3 0-5.5 1.8-7 4 1.5 2.2 4 4 7 4s5.5-1.8 7-4c-1.5-2.2-4-4-7-4zM9 11a2 2 0 100-4 2 2 0 000 4z',
  eyeOff: 'M3.5 3.5l11 11M6.7 6.9C5.3 7.6 4.1 8.7 3 10c1.5 2.2 4 4 7 4 1.1 0 2.2-.3 3.1-.7M9 4c3 0 5.5 1.8 7 4-.6.9-1.4 1.7-2.3 2.4',
};

export function Icon({ name, size = 16 }: { name: keyof typeof PATHS | string; size?: number }) {
  const d = PATHS[name] ?? '';
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      <path d={d} />
    </svg>
  );
}

/* ───────────────────────────── 其他 ───────────────────────────── */

/** 一行提示条。用于冲突警告、令牌明文展示等需要被看见但不能是弹窗的信息。 */
export function Notice({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warn' | 'danger' | 'ok';
  children: ReactNode;
}) {
  const tones: Record<string, string> = {
    info: 'border-border bg-muted text-foreground',
    warn: 'border-[color:color-mix(in_srgb,#b8860b_55%,transparent)] bg-[color:color-mix(in_srgb,#b8860b_14%,transparent)] text-foreground',
    danger:
      'border-[color:color-mix(in_srgb,var(--destructive)_55%,transparent)] bg-[color:color-mix(in_srgb,var(--destructive)_12%,transparent)] text-foreground',
    ok: 'border-[color:color-mix(in_srgb,var(--primary)_50%,transparent)] bg-[color:color-mix(in_srgb,var(--primary)_12%,transparent)] text-foreground',
  };
  return (
    <div className={`rounded-[var(--radius-md)] border px-3 py-2 text-xs leading-relaxed ${tones[tone]}`}>
      {children}
    </div>
  );
}

export function Empty({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
      <div className="flex items-center gap-1 opacity-30" aria-hidden="true">
        <span className="h-2 w-2 bg-foreground" />
        <span className="h-2 w-2 rounded-full border border-foreground" />
        <span className="h-2 w-2 bg-foreground" />
      </div>
      <p className="text-xs text-muted-foreground">{text}</p>
    </div>
  );
}
