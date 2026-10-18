/**
 * 当前时刻指示线（那条横线）。
 *
 * 为什么要自己接管，而不是用组件库自带的：
 *
 * 1) 库里的线只在 React 重渲染时才重算位置。日历本身几乎不会因为「时间流逝」
 *    而重渲染，于是线会一直停在页面打开时的那一刻，直到手动刷新（或恰好有别的
 *    状态变化触发重渲染）。这里把「现在几点」交给自己的定时器，位置随真实时间走。
 *
 * 2) 日程列表（agenda）视图里纵向位置与时间并不成比例：列表按事件条数排布，
 *    而库仍按「当天已过去的百分比」来放线，于是线会浮在列表中间。agenda 分支
 *    改为量取容器真实布局，把线放在「最后一条已经开始的事件」那一行下方，
 *    直到下一条事件开始为止。
 */
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Ref,
} from 'react';
import dayjs from 'dayjs';
import type { RenderCurrentTimeIndicatorProps } from '@ilamy/calendar';
import type { ScheduleEvent } from '../../shared/types';

/**
 * 位置刷新间隔。
 *
 * 不必更快：一周的纵向网格里，一小时通常只有几十像素，一分钟也就一两个像素，
 * 再密也看不出差别；这个量级既能让线始终贴着真实时刻，也几乎不产生开销。
 */
const TICK_MS = 15_000;

/**
 * 一个会自己走的「现在」（毫秒时间戳）。
 *
 * 后台标签页的定时器会被浏览器降频甚至冻结，所以额外监听「重新可见」与
 * 「窗口重新获得焦点」，一回来就立刻补算一次，不等下一个 tick。
 */
function useNowTick(intervalMs = TICK_MS): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const bump = () => setNow(Date.now());
    const id = window.setInterval(bump, intervalMs);

    const onWake = () => {
      if (document.visibilityState === 'visible') bump();
    };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    window.addEventListener('resize', bump);

    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
      window.removeEventListener('resize', bump);
    };
  }, [intervalMs]);

  return now;
}

/**
 * 与组件库默认线条相同的类名与结构 —— 只换「谁来驱动位置」，不改视觉。
 * 颜色走 --primary：原先是写死的 bg-red-500，在暖色界面里像一条报错提示；
 * 换成主色后，「此刻」和「今天」的高亮同源，日夜两套主题都对得上。
 * 定位属性（top / left）由调用方通过 style 传入。
 */
function Line({
  axis,
  style,
  ref,
}: {
  axis: 'vertical' | 'horizontal';
  style: CSSProperties;
  ref?: Ref<HTMLDivElement>;
}) {
  if (axis === 'horizontal') {
    return (
      <div
        ref={ref}
        className="absolute top-0 bottom-0 z-50 flex -translate-x-1/2 flex-col items-center pointer-events-none"
        data-testid="current-time-indicator"
        style={style}
      >
        <div className="size-2 shrink-0 rounded-full bg-primary" data-testid="current-time-dot" />
        <div className="w-0.5 flex-1 bg-primary" />
      </div>
    );
  }
  return (
    <div
      ref={ref}
      className="absolute right-0 left-0 z-50 flex -translate-y-1/2 items-center pointer-events-none"
      data-testid="current-time-indicator"
      style={style}
    >
      <div className="size-2 shrink-0 rounded-full bg-primary" data-testid="current-time-dot" />
      <div className="h-0.5 flex-1 bg-primary" />
    </div>
  );
}

type GridProps = Pick<RenderCurrentTimeIndicatorProps, 'rangeStart' | 'rangeEnd' | 'axis'>;

/**
 * 日 / 周 / 资源视图：按时间比例摆放。
 *
 * 用库传进来的 rangeStart / rangeEnd 重新算百分比（公式与库内部一致），
 * 但取的是「此刻」而不是「上次渲染时」。这样即使父级被 memo 住不再重渲染，
 * 线也会跟着自己的定时器走。
 */
export function GridNowLine({ rangeStart, rangeEnd, axis = 'vertical' }: GridProps) {
  const now = useNowTick();

  const from = rangeStart.valueOf();
  const span = rangeEnd.valueOf() - from;
  if (span <= 0) return null;

  const pct = ((now - from) / span) * 100;
  // 当前时刻落在可视区间之外就不画（与库的判断一致）
  if (pct < 0 || pct > 100) return null;

  return <Line axis={axis} style={axis === 'horizontal' ? { left: `${pct}%` } : { top: `${pct}%` }} />;
}

/** 列表容器内的事件行，按 DOM 顺序取出（容器里除本组件外只有事件行）。 */
function eventRows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.children).filter(
    (c): c is HTMLElement => c instanceof HTMLElement && c.tagName === 'BUTTON',
  );
}

/**
 * 日程列表视图：按容器真实布局摆放。
 *
 * 组件库把这条线作为「事件列表容器」的第一个子节点渲染，所以这里先量取该容器
 * 内各事件行的位置，再把线放到目标行的下沿。这些行的高度由字体与内容决定，
 * 用测量而不是「行数 × 固定行高」，换字体、换语言都不会错位。
 */
export function AgendaNowLine({ events }: { events: ScheduleEvent[] }) {
  const now = useNowTick();
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState<number | null>(null);

  /** 「最后一条已经开始的事件」在列表中的序号；-1 表示今天还没有事件开始。 */
  const index = useMemo(() => {
    let k = -1;
    events.forEach((ev, i) => {
      if (dayjs(ev.start).valueOf() <= now) k = i;
    });
    return k;
  }, [events, now]);

  useLayoutEffect(() => {
    const self = ref.current;
    const container = self?.parentElement;
    if (!container) return;

    const measure = () => {
      const rows = eventRows(container);
      if (rows.length === 0 || index < 0) {
        setTop(0);
        return;
      }
      const base = container.getBoundingClientRect().top;
      const current = rows[Math.min(index, rows.length - 1)].getBoundingClientRect();
      const next = rows[index + 1]?.getBoundingClientRect();
      // 落在「当前这条的下沿」与「下一条的上沿」正中：读起来就是「紧跟在正在进行
      // 的那条下面」，又不会贴着下一条的文字。已经是最后一条时，落在它下方一点。
      setTop((next ? (current.bottom + next.top) / 2 : current.bottom + 2) - base);
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(container);
    eventRows(container).forEach((row) => ro.observe(row));
    return () => ro.disconnect();
  }, [index, events]);

  if (top === null) {
    // 首帧还没量到位置：先挂上去（隐藏），拿到 ref 才能找到所在容器
    return <Line axis="vertical" style={{ top: 0, visibility: 'hidden' }} ref={ref} />;
  }

  // 绝对定位，不参与列表的流式布局，因此不会把行距撑开
  return <Line axis="vertical" style={{ top }} ref={ref} />;
}
