/**
 * 右键菜单。
 *
 * 自己实现而不是引入菜单库：只有「一串文字 + 一个二级菜单」这点需求，
 * 引入的东西还要自己接主题令牌。这里是 fixed 定位，跟随鼠标坐标，
 * 靠近窗口边缘时自动翻向另一侧，不做 portal —— 层级靠 z-index 撑住即可。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from './ui';

export interface MenuItem {
  label: string;
  icon?: string;
  /** 右侧灰字：当前所在分组、快捷键之类 */
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  /** 悬停后向右展开的子菜单 */
  submenu?: MenuItem[];
  onSelect?: () => void;
}

/**
 * 选中一项之后统一收尾：先关菜单再执行。
 * 反过来的话，动作里如果打开了弹窗，菜单会盖在弹窗上面。
 */
function run(item: MenuItem, close: () => void) {
  if (item.disabled) return;
  close();
  item.onSelect?.();
}

export function ContextMenu({
  x,
  y,
  heading,
  note,
  items,
  onClose,
}: {
  x: number;
  y: number;
  /** 菜单顶部那条不可点的标题，通常是日程名 */
  heading: string;
  note?: string;
  items: MenuItem[];
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState({ left: x, top: y, flip: false });
  const [openSub, setOpenSub] = useState<number | null>(null);
  const [active, setActive] = useState(-1);

  // 量出来再定位：窗口右/下边缘附近要往里收，否则菜单会被裁掉一半
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const margin = 8;
    const { offsetWidth: w, offsetHeight: h } = el;
    const left = Math.max(margin, Math.min(x, window.innerWidth - w - margin));
    const top = y + h + margin > window.innerHeight ? Math.max(margin, y - h) : y;
    // 右侧放不下子菜单就朝左开
    setPlace({ left, top, flip: left + w + 180 > window.innerWidth });
  }, [x, y]);

  useEffect(() => {
    panelRef.current?.focus();

    const onPointerDown = (e: MouseEvent) => {
      if (!panelRef.current?.contains(e.target as Node)) onClose();
    };
    const onScrollOrResize = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => {
          const next = e.key === 'ArrowDown' ? i + 1 : i - 1;
          if (next < 0) return items.length - 1;
          return next >= items.length ? 0 : next;
        });
        return;
      }
      if (e.key === 'Enter' && active >= 0) {
        e.preventDefault();
        const item = items[active];
        if (item?.submenu) setOpenSub(active);
        else if (item) run(item, onClose);
      }
    };

    window.addEventListener('mousedown', onPointerDown, true);
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onPointerDown, true);
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('keydown', onKey, true);
    };
    // active 变了要重绑，键盘才会用最新的高亮项
  }, [active, items, onClose]);

  return (
    <div
      ref={panelRef}
      role="menu"
      tabIndex={-1}
      aria-label={heading}
      onContextMenu={(e) => e.preventDefault()}
      style={{ left: place.left, top: place.top }}
      className="fixed z-[70] min-w-[13rem] max-w-[18rem] overflow-visible rounded-[var(--radius-md)] border border-border bg-card py-1 shadow-xl outline-none"
    >
      <div className="border-b border-border px-3 pb-1.5 pt-1">
        <div className="truncate text-sm text-foreground">{heading}</div>
        {note && <div className="mt-0.5 text-2xs text-muted-foreground">{note}</div>}
      </div>

      <div className="pt-1">
        {items.map((item, i) => (
          <div
            key={`${item.label}-${i}`}
            className="relative"
            onMouseEnter={() => {
              setActive(i);
              setOpenSub(item.submenu ? i : null);
            }}
          >
            <button
              type="button"
              role="menuitem"
              disabled={item.disabled}
              aria-haspopup={item.submenu ? 'menu' : undefined}
              onClick={() => (item.submenu ? setOpenSub(openSub === i ? null : i) : run(item, onClose))}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors ${
                item.disabled
                  ? 'cursor-not-allowed text-muted-foreground/60'
                  : item.danger
                    ? 'text-[color:var(--destructive)] hover:bg-accent'
                    : 'text-foreground hover:bg-accent'
              } ${active === i && !item.disabled ? 'bg-accent' : ''}`}
            >
              {item.icon && <Icon name={item.icon} size={14} />}
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.hint && <span className="shrink-0 text-2xs text-muted-foreground">{item.hint}</span>}
              {item.submenu && <Icon name="chevron" size={12} />}
            </button>

            {item.submenu && openSub === i && (
              <div
                role="menu"
                aria-label={item.label}
                className={`absolute top-0 min-w-[10rem] rounded-[var(--radius-md)] border border-border bg-card py-1 shadow-xl ${
                  place.flip ? 'right-full mr-1' : 'left-full ml-1'
                }`}
              >
                {item.submenu.map((sub, j) => (
                  <button
                    key={`${sub.label}-${j}`}
                    type="button"
                    role="menuitem"
                    disabled={sub.disabled}
                    onClick={() => run(sub, onClose)}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors ${
                      sub.disabled
                        ? 'cursor-not-allowed text-muted-foreground/60'
                        : 'text-foreground hover:bg-accent'
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate">{sub.label}</span>
                    {sub.hint && <span className="shrink-0 text-2xs text-muted-foreground">{sub.hint}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
