import { comboKeys, type HotkeySpec } from '../lib/hotkeys';
import { Modal } from './ui';

/** 分组显示顺序。没列到的分组排在后面，按声明顺序。 */
const GROUP_ORDER = ['视图与导航', '日程', '通用'];

/**
 * 快捷键速查表。
 *
 * 内容不是手写的 —— 直接由 App 里那份已经生效的绑定渲染出来，所以这里
 * 不可能出现「文档说有、实际没有」的键位。
 */
export function ShortcutSheet({
  open,
  onClose,
  specs,
}: {
  open: boolean;
  onClose: () => void;
  specs: HotkeySpec[];
}) {
  const groups = new Map<string, HotkeySpec[]>();
  for (const spec of specs) {
    const list = groups.get(spec.group);
    if (list) list.push(spec);
    else groups.set(spec.group, [spec]);
  }

  const ordered = [...groups.keys()].sort((a, b) => {
    const ia = GROUP_ORDER.indexOf(a);
    const ib = GROUP_ORDER.indexOf(b);
    return (ia === -1 ? GROUP_ORDER.length : ia) - (ib === -1 ? GROUP_ORDER.length : ib);
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="键盘快捷键"
      description="焦点在输入框里时，字母键归输入框，不会触发下面这些组合。"
    >
      <div className="space-y-5">
        {ordered.map((name) => (
          <section key={name}>
            <h3 className="mb-2 text-xs font-medium tracking-wide text-muted-foreground">{name}</h3>
            <dl className="space-y-1.5">
              {groups.get(name)!.map((spec) => (
                <div key={spec.combo} className="flex items-baseline justify-between gap-4">
                  <dt className="text-sm text-foreground">{spec.label}</dt>
                  <dd className="flex shrink-0 items-center gap-1">
                    {comboKeys(spec.combo).map((key, i) => (
                      <kbd
                        key={`${key}-${i}`}
                        className="min-w-6 rounded-[var(--radius-sm)] border border-border bg-muted px-1.5 py-0.5 text-center text-2xs font-mono text-foreground"
                      >
                        {key}
                      </kbd>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}
