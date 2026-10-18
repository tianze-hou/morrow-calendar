import { useEffect } from 'react';
import { useIlamyCalendarContext, type IlamyCalendarApi } from '@ilamy/calendar';

/**
 * 把日历内部的 API 递回给外层。
 *
 * `IlamyCalendar` 没有受控的 `view` 属性，只认 `initialView`；想程序化地切视图、
 * 跳回今天或翻页，唯一途径是 `useIlamyCalendarContext()`。而这个 hook 必须在
 * 组件的 Provider 内部调用 —— 树里唯一一个「内部位置」是 `renderEventForm`
 * 这个槽（库的实现是 `if (renderEventForm) return renderEventForm(props)`），
 * 于是用这个不渲染任何东西的组件把 API 捞出来。
 *
 * 交给外层的是 ref，不是 state：API 对象每次渲染都可能换引用，落进 state 会
 * 自己触发自己。
 */
export function CalendarApiBridge({ onReady }: { onReady: (api: IlamyCalendarApi) => void }) {
  const api = useIlamyCalendarContext();

  useEffect(() => {
    onReady(api);
  }, [api, onReady]);

  return null;
}
