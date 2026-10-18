import { useEffect, useState } from 'react';
import dayjs from 'dayjs';
import { EVENT_COLORS, type CalendarGroup, type EventColor } from '../../shared/types';
import { comboKeys } from '../lib/hotkeys';
import { COLOR_HEX, COLOR_LABEL } from './colors';
import { Btn, Field, INPUT_CLS, Modal, Notice } from './ui';

export interface DialogDraft {
  /** 有 id 表示编辑，无 id 表示新建 */
  id?: string;
  title: string;
  allDay: boolean;
  /** datetime-local 用的本地时间串：YYYY-MM-DDTHH:mm */
  start: string;
  end: string;
  location: string;
  description: string;
  color: EventColor;
  calendarId: string;
}

export interface EventDialogProps {
  draft: DialogDraft;
  /** 可选分组；为空时不显示分组选择器 */
  calendars?: CalendarGroup[];
  onCancel: () => void;
  onSave: (draft: DialogDraft) => Promise<void>;
  onDelete?: (id: string) => void;
  /** 服务端返回的冲突提示，展示在弹窗顶部 */
  warnings?: string[];
}

export function EventDialog({
  draft,
  calendars = [],
  onCancel,
  onSave,
  onDelete,
  warnings,
}: EventDialogProps) {
  const [form, setForm] = useState<DialogDraft>(draft);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setForm(draft), [draft]);

  /**
   * `Ctrl/⌘+Enter` 与 `Ctrl/⌘+S` 都保存。
   *
   * 后者必须 preventDefault：浏览器的默认动作是「保存网页」，抢不过它就等于
   * 每次按都弹一次文件对话框。放在 window 上而不是面板上，是因为焦点通常在
   * 输入框里，事件不会冒泡到面板。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || saving) return;
      const key = e.key.toLowerCase();
      if (key !== 'enter' && key !== 's') return;
      e.preventDefault();
      void submit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [form, saving]);

  const set = <K extends keyof DialogDraft>(key: K, value: DialogDraft[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  async function submit() {
    if (!form.title.trim()) {
      setError('标题不能为空');
      return;
    }
    if (dayjs(form.end).valueOf() <= dayjs(form.start).valueOf()) {
      setError('结束时间必须晚于开始时间');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(form);
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  const isEdit = Boolean(form.id);

  return (
    <Modal
      open
      onClose={onCancel}
      title={isEdit ? '编辑日程' : '新建日程'}
      description={isEdit ? '修改后立即生效。删除会先移入回收站，可以撤销。' : undefined}
      footer={
        <>
          {isEdit && onDelete ? (
            <Btn variant="danger" size="sm" onClick={() => onDelete(form.id!)}>
              删除
            </Btn>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-3">
            <span className="hidden text-2xs text-muted-foreground sm:inline">
              {comboKeys('mod+enter').join(' + ')} 保存
            </span>
            <Btn variant="ghost" size="sm" onClick={onCancel}>
              取消
            </Btn>
            <Btn variant="primary" size="sm" disabled={saving} onClick={submit}>
              {saving ? '保存中…' : '保存'}
            </Btn>
          </div>
        </>
      }
    >
      <div className="space-y-4">
        {warnings && warnings.length > 0 && (
          <Notice tone="warn">
            {warnings.map((w) => (
              <div key={w}>· {w}</div>
            ))}
          </Notice>
        )}

        <Field label="标题">
          <input
            className={INPUT_CLS}
            value={form.title}
            autoFocus
            maxLength={200}
            onChange={(e) => set('title', e.target.value)}
            placeholder="例：导师例会"
          />
        </Field>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.allDay}
            onChange={(e) => set('allDay', e.target.checked)}
            style={{ accentColor: 'var(--primary)' }}
          />
          全天日程
        </label>

        <div className="grid grid-cols-2 gap-3">
          <Field label="开始">
            <input
              type="datetime-local"
              className={INPUT_CLS}
              value={form.start}
              onChange={(e) => set('start', e.target.value)}
            />
          </Field>
          <Field label="结束">
            <input
              type="datetime-local"
              className={INPUT_CLS}
              value={form.end}
              onChange={(e) => set('end', e.target.value)}
            />
          </Field>
        </div>

        {calendars.length > 0 && (
          <Field label="所属分组">
            <select
              className={INPUT_CLS}
              value={form.calendarId}
              onChange={(e) => set('calendarId', e.target.value)}
            >
              {calendars.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
        )}

        <Field label="地点">
          <input
            className={INPUT_CLS}
            value={form.location}
            maxLength={200}
            onChange={(e) => set('location', e.target.value)}
          />
        </Field>

        <Field label="备注">
          <textarea
            className={`${INPUT_CLS} h-20 resize-none py-2`}
            value={form.description}
            onChange={(e) => set('description', e.target.value)}
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
                onClick={() => set('color', c)}
                className={`h-6 w-6 rounded-[var(--radius-sm)] border transition-transform ${
                  form.color === c ? 'scale-110 border-foreground' : 'border-black/15 hover:scale-105'
                }`}
                style={{ background: COLOR_HEX[c] }}
              />
            ))}
          </div>
        </div>

        {error && <Notice tone="danger">{error}</Notice>}
      </div>
    </Modal>
  );
}
