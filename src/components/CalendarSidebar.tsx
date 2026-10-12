import { useEffect, useState } from 'react';
import { EVENT_COLORS, type CalendarGroup, type EventColor } from '../../shared/types';
import { calendars as calendarsApi, ApiError } from '../api/client';
import { COLOR_HEX, COLOR_LABEL } from './colors';
import { Btn, Field, Icon, INPUT_CLS, Modal, Notice } from './ui';

export interface CalendarSidebarProps {
  items: CalendarGroup[];
  /** 各分组下的日程条数，用于列表右侧的角标 */
  counts: Record<string, number>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChanged: () => void;
  trashCount: number;
  onOpenTrash: () => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

export function CalendarSidebar({
  items,
  counts,
  selectedId,
  onSelect,
  onChanged,
  trashCount,
  onOpenTrash,
  collapsed,
  onToggleCollapse,
}: CalendarSidebarProps) {
  const [editing, setEditing] = useState<CalendarGroup | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggleVisible(item: CalendarGroup) {
    try {
      await calendarsApi.update(item.id, { visible: !item.visible });
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '操作失败');
    }
  }

  if (collapsed) {
    return (
      <aside className="flex w-12 shrink-0 flex-col items-center gap-2 border-r border-border bg-sidebar py-3">
        <button
          type="button"
          aria-label="展开侧栏"
          title="展开侧栏"
          onClick={onToggleCollapse}
          className="rounded-[var(--radius-sm)] p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Icon name="chevron" />
        </button>
        <button
          type="button"
          aria-label="回收站"
          title={`回收站（${trashCount}）`}
          onClick={onOpenTrash}
          className="relative rounded-[var(--radius-sm)] p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Icon name="trash" />
          {trashCount > 0 && (
            <span className="absolute -right-0.5 -top-0.5 rounded-full bg-primary px-1 text-2xs leading-4 text-primary-foreground">
              {trashCount > 99 ? '99+' : trashCount}
            </span>
          )}
        </button>
      </aside>
    );
  }

  const total = items.reduce((sum, c) => sum + (counts[c.id] ?? 0), 0);

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-sidebar">
      <div className="flex items-center justify-between px-3.5 pb-2 pt-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-medium tracking-wide">日历</h2>
          <span className="text-2xs text-muted-foreground">{items.length} 个分组</span>
        </div>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            aria-label="新建分组"
            title="新建分组"
            onClick={() => {
              setError(null);
              setCreating(true);
            }}
            className="rounded-[var(--radius-sm)] p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Icon name="plus" size={15} />
          </button>
          <button
            type="button"
            aria-label="收起侧栏"
            title="收起侧栏"
            onClick={onToggleCollapse}
            className="rounded-[var(--radius-sm)] p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Icon name="chevronDown" size={15} />
          </button>
        </div>
      </div>

      {error && (
        <div className="px-3.5 pb-2">
          <Notice tone="danger">{error}</Notice>
        </div>
      )}

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <button
          type="button"
          onClick={() => onSelect(null)}
          className={`mb-0.5 flex w-full items-center gap-2 rounded-[var(--radius-md)] px-2 py-1.5 text-left text-sm transition-colors ${
            selectedId === null ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/60'
          }`}
        >
          <span className="flex w-4 justify-center">
            <Icon name="calendar" size={14} />
          </span>
          <span className="flex-1 truncate">全部日程</span>
          <span className="text-2xs tabular-nums text-muted-foreground">{total}</span>
        </button>

        <div className="my-2 h-px bg-border" />

        {items.map((item) => {
          const active = selectedId === item.id;
          return (
            <div
              key={item.id}
              className={`group mb-0.5 flex items-center gap-1.5 rounded-[var(--radius-md)] px-2 py-1.5 transition-colors ${
                active ? 'bg-accent' : 'hover:bg-accent/60'
              }`}
            >
              <button
                type="button"
                aria-label={item.visible ? `隐藏「${item.name}」` : `显示「${item.name}」`}
                title={item.visible ? '在日历中显示' : '已隐藏'}
                onClick={() => void toggleVisible(item)}
                className="shrink-0 text-muted-foreground hover:text-foreground"
              >
                <Icon name={item.visible ? 'eye' : 'eyeOff'} size={14} />
              </button>

              <button
                type="button"
                onClick={() => onSelect(item.id)}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                <span
                  className="h-2.5 w-2.5 shrink-0"
                  style={{
                    background: item.visible ? COLOR_HEX[item.color] : 'transparent',
                    border: item.visible ? 'none' : '1.5px solid var(--muted-foreground)',
                    borderRadius: 'var(--radius-xs)',
                  }}
                />
                <span
                  className={`min-w-0 flex-1 truncate text-sm ${
                    item.visible ? 'text-foreground' : 'text-muted-foreground line-through decoration-1'
                  }`}
                >
                  {item.name}
                </span>
                <span className="text-2xs tabular-nums text-muted-foreground">{counts[item.id] ?? 0}</span>
              </button>

              <button
                type="button"
                aria-label={`设置「${item.name}」`}
                title="设置分组"
                onClick={() => {
                  setError(null);
                  setEditing(item);
                }}
                className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
              >
                <Icon name="settings" size={14} />
              </button>
            </div>
          );
        })}
      </nav>

      <div className="border-t border-border p-2">
        <button
          type="button"
          onClick={onOpenTrash}
          className="flex w-full items-center gap-2 rounded-[var(--radius-md)] px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <span className="flex w-4 justify-center">
            <Icon name="trash" size={14} />
          </span>
          <span className="flex-1 truncate">回收站</span>
          <span className="text-2xs tabular-nums">{trashCount}</span>
        </button>
      </div>

      <CalendarForm
        open={creating || editing !== null}
        initial={editing}
        count={items.length}
        busy={busy}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        onSubmit={async (payload, remove) => {
          setBusy(true);
          setError(null);
          try {
            if (remove && editing) {
              await calendarsApi.remove(editing.id);
            } else if (editing) {
              await calendarsApi.update(editing.id, payload);
            } else {
              await calendarsApi.create({ name: payload.name!, color: payload.color, visible: payload.visible });
            }
            setCreating(false);
            setEditing(null);
            onChanged();
          } catch (e) {
            setError(e instanceof ApiError ? e.message : '保存失败');
          } finally {
            setBusy(false);
          }
        }}
      />
    </aside>
  );
}

/* ───────────────────── 新建 / 编辑分组弹窗 ───────────────────── */

function CalendarForm({
  open,
  initial,
  count,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean;
  initial: CalendarGroup | null;
  count: number;
  busy: boolean;
  onClose: () => void;
  onSubmit: (
    payload: { name?: string; color?: EventColor; visible?: boolean },
    remove?: boolean,
  ) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [color, setColor] = useState<EventColor>('blue');
  const [visible, setVisible] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? '');
    setColor(initial?.color ?? EVENT_COLORS[count % EVENT_COLORS.length]);
    setVisible(initial?.visible ?? true);
    setConfirmDelete(false);
  }, [open, initial, count]);

  const isEdit = initial !== null;
  const canDelete = isEdit && !initial.isDefault;

  return (
    <Modal
      open={open}
      onClose={onClose}
      width="sm"
      title={isEdit ? '设置分组' : '新建分组'}
      description={
        isEdit
          ? initial.isDefault
            ? '这是默认分组，不可删除；可以改名与换色。'
            : '隐藏后该分组下的日程不会出现在日历里，但数据仍在。'
          : '用分组把工作、学习、生活分开，可以整组显示或隐藏。'
      }
      footer={
        <>
          {canDelete ? (
            <Btn
              variant="danger"
              size="sm"
              disabled={busy}
              onClick={() => {
                if (!confirmDelete) {
                  setConfirmDelete(true);
                  return;
                }
                void onSubmit({}, true);
              }}
            >
              {confirmDelete ? '确认删除？' : '删除分组'}
            </Btn>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Btn variant="ghost" size="sm" onClick={onClose}>
              取消
            </Btn>
            <Btn
              variant="primary"
              size="sm"
              disabled={busy || !name.trim()}
              onClick={() => void onSubmit({ name: name.trim(), color, visible })}
            >
              {busy ? '保存中…' : '保存'}
            </Btn>
          </div>
        </>
      }
    >
      <div className="space-y-4">
        {canDelete && confirmDelete && (
          <Notice tone="warn">
            删除后，该分组下的日程会自动迁入「默认日历」，不会一起消失。
          </Notice>
        )}

        <Field label="分组名">
          <input
            className={INPUT_CLS}
            value={name}
            autoFocus
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
            placeholder="例：工作"
          />
        </Field>

        <div>
          <span className="mb-1.5 block text-xs text-muted-foreground">颜色</span>
          <div className="flex flex-wrap gap-2">
            {EVENT_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={COLOR_LABEL[c]}
                title={COLOR_LABEL[c]}
                onClick={() => setColor(c)}
                className={`h-6 w-6 rounded-[var(--radius-sm)] border transition-transform ${
                  color === c ? 'scale-110 border-foreground' : 'border-black/15 hover:scale-105'
                }`}
                style={{ background: COLOR_HEX[c] }}
              />
            ))}
          </div>
        </div>

        {isEdit && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={visible}
              onChange={(e) => setVisible(e.target.checked)}
              style={{ accentColor: 'var(--primary)' }}
            />
            在日历中显示该分组
          </label>
        )}
      </div>
    </Modal>
  );
}
