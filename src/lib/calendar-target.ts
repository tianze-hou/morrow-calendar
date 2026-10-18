/**
 * 右键点在哪儿。
 *
 * 组件库只给了左键的两个回调（`onCellClick` / `onEventClick`），右键没有。
 * 好在它给每个事件块和网格格都留了稳定的 `data-testid`，于是从 DOM 反查：
 *
 *   vertical-event-<id>              周 / 日视图里的定时日程
 *   horizontal-event-<id>            月视图、全天行里的日程
 *   vertical-cell-<date>-<HH>-<mm>   周 / 日视图的空白时间格
 *   day-cell-<date>                  月视图日期格、全天行里的单日格
 *   agenda-day-<date>                日程列表视图的一天（事件行没有 id，见下）
 *
 * 注意不能只取「最近的那个 data-testid」：格子内部还套了一层
 * `grid-cell-content`，事件内部也有别的 testid。要沿祖先链往上找，第一个
 * 认识的才算数 —— 这也顺带保证了「月视图里点在事件上」优先命中事件本身。
 *
 * 日程列表视图是唯一的例外：插件自绘事件行，既不用 `renderEvent`，DOM 上也
 * 没有任何 id。只能拿行里的标题去猜——同一日期内标题唯一时才认，否则当作
 * 「没点中事件」，不说话比猜错好。
 */
export type ContextTarget =
  | { kind: 'event'; eventId: string }
  | { kind: 'agendaEvent'; date: string; title: string }
  | { kind: 'slot'; start: string }
  | { kind: 'day'; date: string };

const EVENT_ID = /^(?:vertical|horizontal)-event-(.+)$/;
const SLOT = /^vertical-cell-(\d{4}-\d{2}-\d{2})-(\d{2})-(\d{2})$/;
const DAY_CELL = /^day-cell-(\d{4}-\d{2}-\d{2})$/;
const AGENDA_DAY = /^agenda-day-(\d{4}-\d{2}-\d{2})$/;

/** 单个 testid 的解析；不认识就返回 null，由调用处继续往上找。 */
function matchTestId(testid: string, ancestor: HTMLElement, origin: HTMLElement): ContextTarget | null {
  const event = EVENT_ID.exec(testid);
  if (event) return { kind: 'event', eventId: event[1] };

  const slot = SLOT.exec(testid);
  if (slot) return { kind: 'slot', start: `${slot[1]}T${slot[2]}:${slot[3]}` };

  const day = DAY_CELL.exec(testid);
  if (day) return { kind: 'day', date: day[1] };

  const agenda = AGENDA_DAY.exec(testid);
  if (agenda) {
    // 事件行是按钮，行内最后一个 span 是标题；点在当天空白处则落到「当天」
    const row = origin.closest('button');
    const title = row && ancestor.contains(row) ? [...row.querySelectorAll('span')].pop()?.textContent?.trim() : '';
    return title ? { kind: 'agendaEvent', date: agenda[1], title } : { kind: 'day', date: agenda[1] };
  }

  return null;
}

export function readContextTarget(target: EventTarget | null): ContextTarget | null {
  if (!(target instanceof HTMLElement)) return null;

  for (let el: HTMLElement | null = target; el; el = el.parentElement) {
    const testid = el.dataset.testid;
    if (!testid) continue;
    const hit = matchTestId(testid, el, target);
    if (hit) return hit;
  }
  return null;
}
