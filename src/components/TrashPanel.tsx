import { useEffect, useState } from 'react';
import dayjs from 'dayjs';
import type { ScheduleEvent } from '../../shared/types';
import { ApiError, events as eventsApi } from '../api/client';
import { COLOR_HEX } from './colors';
import { Btn, Empty, Icon, Modal, Notice } from './ui';

/** 回收站。删除是软删除，这里负责恢复、彻底删除与清空。 */
export function TrashPanel({
  open,
  onClose,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  /** 数据发生变化时通知外层刷新日历与角标 */
  onChanged: () => void;
}) {
  const [items, setItems] = useState<ScheduleEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmEmpty, setConfirmEmpty] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const { data } = await eventsApi.trash();
      setItems(data);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '读取回收站失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open) {
      setConfirmEmpty(false);
      void load();
    }
  }, [open]);

  async function restore(item: ScheduleEvent) {
    setBusyId(item.id);
    setError(null);
    try {
      await eventsApi.restore(item.id);
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '恢复失败');
    } finally {
      setBusyId(null);
    }
  }

  async function purge(item: ScheduleEvent) {
    setBusyId(item.id);
    setError(null);
    try {
      await eventsApi.purge(item.id);
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '彻底删除失败');
    } finally {
      setBusyId(null);
    }
  }

  async function emptyAll() {
    if (!confirmEmpty) {
      setConfirmEmpty(true);
      return;
    }
    setBusyId('__all__');
    setError(null);
    try {
      await eventsApi.emptyTrash();
      await load();
      onChanged();
      setConfirmEmpty(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '清空失败');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      width="lg"
      title="回收站"
      description="删除的日程先放在这里，随时可以恢复。清空或彻底删除后不可找回。"
      footer={
        <>
          <span className="text-xs text-muted-foreground">
            {loading ? '读取中…' : `共 ${items.length} 条`}
          </span>
          <div className="flex gap-2">
            <Btn variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
              <Icon name="refresh" size={14} />
              刷新
            </Btn>
            <Btn
              variant="danger"
              size="sm"
              disabled={items.length === 0 || busyId === '__all__'}
              onClick={() => void emptyAll()}
            >
              <Icon name="empty" size={14} />
              {busyId === '__all__' ? '清空中…' : confirmEmpty ? '确认清空？' : '清空回收站'}
            </Btn>
          </div>
        </>
      }
    >
      {error && (
        <div className="mb-3">
          <Notice tone="danger">{error}</Notice>
        </div>
      )}

      {confirmEmpty && (
        <div className="mb-3">
          <Notice tone="warn">
            将永久删除上方的 {items.length} 条日程，无法恢复。再次点击按钮确认。
          </Notice>
        </div>
      )}

      {loading ? (
        <Empty text="读取中…" />
      ) : items.length === 0 ? (
        <Empty text="回收站是空的" />
      ) : (
        <ul className="divide-y divide-border">
          {items.map((item) => (
            <li key={item.id} className="flex items-center gap-3 py-2.5">
              <span
                className="h-6 w-1 shrink-0 rounded-full"
                style={{ background: item.color ? COLOR_HEX[item.color] : 'var(--muted-foreground)' }}
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-foreground">{item.title}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-2xs text-muted-foreground">
                  <span>
                    {dayjs(item.start).format('YYYY-MM-DD HH:mm')} – {dayjs(item.end).format('HH:mm')}
                  </span>
                  {item.location && <span className="truncate">{item.location}</span>}
                  <span>删除于 {item.deletedAt ? dayjs(item.deletedAt).format('MM-DD HH:mm') : '未知'}</span>
                </div>
              </div>
              <div className="flex shrink-0 gap-1.5">
                <Btn
                  variant="outline"
                  size="sm"
                  disabled={busyId === item.id}
                  onClick={() => void restore(item)}
                >
                  <Icon name="restore" size={14} />
                  恢复
                </Btn>
                <Btn
                  variant="ghost"
                  size="sm"
                  disabled={busyId === item.id}
                  onClick={() => void purge(item)}
                  title="彻底删除，不可恢复"
                >
                  <Icon name="trash" size={14} />
                </Btn>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
