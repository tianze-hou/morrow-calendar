import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import { IlamyCalendar } from '@ilamy/calendar';
import { agendaPlugin } from '@ilamy/calendar/plugins/agenda';
import type {
  CalendarEvent,
  CellInfo,
  EventFormProps,
  IlamyCalendarProps,
  RenderCurrentTimeIndicatorProps,
} from '@ilamy/calendar';
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type CalendarGroup,
  type CreateEventInput,
  type ScheduleEvent,
  type UpdateEventInput,
  type User,
} from '../shared/types';
import { api, ApiError, auth as authApi, calendars as calendarsApi, events as eventsApi, settings as settingsApi, setup as setupApi } from './api/client';
import { CalendarSidebar } from './components/CalendarSidebar';
import { COLOR_HEX } from './components/colors';
import { EventDialog, type DialogDraft } from './components/EventDialog';
import { LoginScreen } from './components/LoginScreen';
import { AgendaNowLine, GridNowLine } from './components/NowIndicator';
import { SetupScreen } from './components/SetupScreen';
import { SettingsPanel } from './components/SettingsPanel';
import { TrashPanel } from './components/TrashPanel';
import { Btn, Icon } from './components/ui';
import { applyTheme, clearLocalSettings, readLocalSettings, writeLocalSettings } from './theme';
import { zhCN } from './i18n/zh-CN';

dayjs.locale('zh-cn');

/**
 * 手机断点（与 Tailwind 的 md=768px 对齐）。
 *
 * 用 useSyncExternalStore 而不是「useState + resize 监听」：后者首次渲染拿不到
 * 真实值，会先按桌面布局闪一帧，再跳成手机布局 —— 在真机上就是一次可见的抖动。
 */
const MOBILE_QUERY = '(max-width: 767px)';

function subscribeViewport(onChange: () => void) {
  const mql = window.matchMedia(MOBILE_QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

function useIsMobile(): boolean {
  return useSyncExternalStore(
    subscribeViewport,
    () => window.matchMedia(MOBILE_QUERY).matches,
    () => false,
  );
}

/** 插件数组放到模块级常量：避免每次渲染重建导致日历内部 memo 全部失效。 */
const plugins = [agendaPlugin({ window: 'week' })];

/** 领域模型 → 日历组件模型 */
function toCalendarEvent(ev: ScheduleEvent): CalendarEvent {
  return {
    id: ev.id,
    title: ev.title,
    start: dayjs(ev.start),
    end: dayjs(ev.end),
    allDay: ev.allDay,
    description: ev.description,
    location: ev.location,
    // @ilamy/calendar 的 `color` / `backgroundColor` 都是「当 CSS 类名或内联值直接塞进去」，
    // 不做 hex→类名 的换算（源码里就是 cx(backgroundColor || 'bg-blue-500', color || 'text-white')）。
    // 所以只把色值交给 backgroundColor，文字色留空让它走默认的 text-white，
    // 否则会出现「红字压蓝底」这种同色系撞车。色板已按白字 ≥ 4.5:1 挑过。
    backgroundColor: ev.color ? COLOR_HEX[ev.color] : undefined,
    data: { raw: ev },
  };
}

/** 组件没有导出 DateRange，从 props 上反推，避免手写类型与实现漂移 */
type VisibleRange = Parameters<NonNullable<IlamyCalendarProps['onDateChange']>>[1];

const LOCAL_FMT = 'YYYY-MM-DDTHH:mm';
/** 视图切换时前后各多取 3 天，避免月视图边缘出现空白 */
const RANGE_BUFFER_DAYS = 3;

/**
 * 把日历组件「内置的新建/编辑表单」接到我们自己的 EventDialog 上。
 *
 * 组件工具栏里那个「新建」按钮打开的是它自带的表单：既没有分组选择器，
 * 提交也不会走我们的接口（实测不落库），等于一个会丢数据的第二入口。
 * `renderEventForm` 允许整体替换该表单 —— 这里返回 null 把它藏起来，
 * 只在打开时把我们自己的弹窗叫出来，两条路径从此共用同一套字段与校验。
 */
function IlEventFormBridge({
  open,
  selectedEvent,
  onClose,
  registerClose,
  onOpened,
  onOpen,
}: {
  open: boolean;
  selectedEvent: CalendarEvent | null;
  onClose: () => void;
  registerClose: (fn: () => void) => void;
  onOpened: () => void;
  onOpen: (event: CalendarEvent | null) => void;
}) {
  useEffect(() => {
    registerClose(onClose);
  }, [onClose, registerClose]);

  useEffect(() => {
    if (!open) return;
    onOpened();
    onOpen(selectedEvent);
    // 只在「打开」这个动作上触发一次；文本编辑不该反复重置草稿
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selectedEvent]);

  return null;
}

type AuthState = 'checking' | 'setup' | 'anon' | 'authed';

export default function App() {
  const [authState, setAuthState] = useState<AuthState>('checking');
  const [user, setUser] = useState<User | null>(null);
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  /** 初始化引导页预填的用户名，取自服务端建议值 */
  const [setupUsername, setSetupUsername] = useState('admin');

  const [events, setEvents] = useState<ScheduleEvent[]>([]);
  const [calendars, setCalendars] = useState<CalendarGroup[]>([]);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);

  const [selectedCalendarId, setSelectedCalendarId] = useState<string | null>(null);
  /** 手机端侧栏是抽屉：独立开关，不吃 settings.sidebarOpen（那是桌面端的偏好） */
  const isMobile = useIsMobile();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [draft, setDraft] = useState<DialogDraft | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showTrash, setShowTrash] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [trashCount, setTrashCount] = useState(0);
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  /** null = 组件尚未回报可见范围，先全量拉取；一旦回报过就改为按范围拉取。 */
  const [visibleRange, setVisibleRange] = useState<{ from: string; to: string } | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  /** 请求序号：避免快速翻页时旧响应覆盖新响应 */
  const requestSeq = useRef(0);

  const notify = useCallback((kind: 'ok' | 'err', text: string) => setToast({ kind, text }), []);

  /* --------------------------------------------------------- 鉴权 */

  // 首屏先用本地缓存上色，避免先闪一下默认主题
  useEffect(() => {
    const local = readLocalSettings();
    if (local) {
      setSettings((s) => ({ ...s, ...local }));
      if (local.theme) applyTheme(local.theme);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        // 先问一句要不要初始化：库里零用户时直接进引导页，别让用户对着登录框发呆。
        const s = await setupApi.status();
        if (s.needsSetup) {
          setSetupUsername(s.suggestedUsername || 'admin');
          setAuthState('setup');
          return;
        }
        const status = await authApi.status();
        if (status.authenticated && status.user) {
          setUser(status.user);
          setAuthState('authed');
        } else {
          setUser(null);
          setAuthState('anon');
        }
      } catch {
        setAuthState('anon');
        setAuthNotice('连接服务端失败，请确认后端已启动。');
      }
    })();
  }, []);

  /** 统一的鉴权失效处理：清掉本地态，回到登录页。 */
  const handleAuthExpired = useCallback(() => {
    setAuthState('anon');
    setUser(null);
    setEvents([]);
    setCalendars([]);
    setAuthNotice('登录状态已失效，请重新登录。');
  }, []);

  const guarded = useCallback(
    <T,>(fn: () => Promise<T>): Promise<T | null> =>
      fn().catch((e: unknown) => {
        if (e instanceof ApiError && e.isAuthError) {
          handleAuthExpired();
          return null;
        }
        throw e;
      }),
    [handleAuthExpired],
  );

  /* --------------------------------------------------------- 首屏数据 */

  useEffect(() => {
    if (authState !== 'authed') return;
    void (async () => {
      try {
        const [settingsRes, calendarsRes] = await Promise.all([
          guarded(() => settingsApi.get()),
          guarded(() => calendarsApi.list()),
        ]);
        if (!settingsRes || !calendarsRes) return;

        const local = readLocalSettings();
        if (settingsRes.meta.source === 'default' && local && Object.keys(local).length > 0) {
          // 服务端从没存过：把本地偏好回传一次，实现无缝迁移
          const migrated = await guarded(() => settingsApi.update(local));
          if (migrated) {
            setSettings(migrated);
            applyTheme(migrated.theme);
            writeLocalSettings(migrated);
          }
        } else {
          setSettings(settingsRes.data);
          applyTheme(settingsRes.data.theme);
          writeLocalSettings(settingsRes.data);
        }
        setCalendars(calendarsRes.data);
      } catch (e) {
        notify('err', e instanceof Error ? e.message : '初始化失败');
      } finally {
        setLoading(false);
      }
    })();
  }, [authState, guarded, notify]);

  useEffect(() => {
    applyTheme(settings.theme);
    writeLocalSettings(settings);
  }, [settings]);

  /* ------------------------------------------------------- 数据加载 */

  useEffect(() => {
    if (authState !== 'authed') return;
    const seq = ++requestSeq.current;
    let cancelled = false;

    void (async () => {
      try {
        const list = visibleRange
          ? await api.list({ from: visibleRange.from, to: visibleRange.to })
          : await api.list({ limit: 500 });
        if (!cancelled && seq === requestSeq.current) setEvents(list);
      } catch (e) {
        if (cancelled || seq !== requestSeq.current) return;
        if (e instanceof ApiError && e.isAuthError) {
          handleAuthExpired();
          return;
        }
        notify('err', e instanceof Error ? e.message : '加载失败');
      } finally {
        if (!cancelled && seq === requestSeq.current) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [authState, visibleRange, reloadTick, handleAuthExpired, notify]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(timer);
  }, [toast]);

  const reload = useCallback(() => setReloadTick((n) => n + 1), []);

  /** 回收站条数：侧栏角标用。单独取一次，不必把已删数据混进主列表。 */
  const reloadTrashCount = useCallback(async () => {
    try {
      const { meta } = await eventsApi.trash();
      setTrashCount(Number(meta.total ?? 0));
    } catch {
      /* 角标不可用不影响主流程 */
    }
  }, []);

  useEffect(() => {
    if (authState !== 'authed') return;
    void reloadTrashCount();
  }, [authState, reloadTick, reloadTrashCount]);

  /** 转回桌面宽度时把抽屉状态收掉，否则下次变窄会自己弹开 */
  useEffect(() => {
    if (!isMobile) setMobileNavOpen(false);
  }, [isMobile]);

  /* ------------------------------------------------------- 可见性过滤 */

  const visibleIds = useMemo(
    () => new Set(calendars.filter((c) => c.visible).map((c) => c.id)),
    [calendars],
  );

  /** 侧栏角标：按分组统计已加载范围内的条数（不受隐藏影响，否则数字会失真） */
  const counts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const ev of events) map[ev.calendarId] = (map[ev.calendarId] ?? 0) + 1;
    return map;
  }, [events]);

  /** 真正送进日历的日程：先按可见分组、再按侧栏选中项过滤 */
  const shownEvents = useMemo(
    () =>
      events.filter(
        (ev) => visibleIds.has(ev.calendarId) && (selectedCalendarId === null || ev.calendarId === selectedCalendarId),
      ),
    [events, visibleIds, selectedCalendarId],
  );

  const calendarEvents = useMemo(() => shownEvents.map(toCalendarEvent), [shownEvents]);

  /**
   * 日程列表视图里，指示线要落在「已经开始的那一行」下方，因此需要按列表顺序
   * 拿到当天的日程。筛选与排序都对齐 agenda 插件的口径：开始时间落在今天（全天
   * 日程则与今天有重叠）的算今天这一组，组内全天在前、其余按开始时间升序。
   */
  const todayEvents = useMemo(() => {
    const dayStart = dayjs().startOf('day');
    const dayEnd = dayjs().endOf('day');
    return shownEvents
      .filter((ev) => {
        const start = dayjs(ev.start);
        if (ev.allDay) return !dayjs(ev.end).isBefore(dayStart) && !start.isAfter(dayEnd);
        return !start.isBefore(dayStart) && !start.isAfter(dayEnd);
      })
      .sort((a, b) => {
        const fa = a.allDay ? 0 : 1;
        const fb = b.allDay ? 0 : 1;
        if (fa !== fb) return fa - fb;
        return dayjs(a.start).valueOf() - dayjs(b.start).valueOf();
      });
  }, [shownEvents]);

  /** 接管那条红线：日/周按时间比例、日程列表按真实行位置，且都由自己的定时器驱动。 */
  const renderCurrentTimeIndicator = useCallback(
    (props: RenderCurrentTimeIndicatorProps) =>
      props.view === 'agenda' ? (
        <AgendaNowLine events={todayEvents} />
      ) : (
        <GridNowLine rangeStart={props.rangeStart} rangeEnd={props.rangeEnd} axis={props.axis} />
      ),
    [todayEvents],
  );

  const collectWarnings = (result: { warnings?: Array<{ code: string; message: string }> }) =>
    (result.warnings ?? [])
      .filter((w) => w.code !== 'NO_CHANGE')
      .map((w) => w.message);

  /** 新建时默认落在：当前选中分组 → 第一个可见分组 → 默认分组 */
  const defaultCalendarId = useMemo(() => {
    if (selectedCalendarId) return selectedCalendarId;
    const visible = calendars.find((c) => c.visible);
    return visible?.id ?? calendars[0]?.id ?? '';
  }, [selectedCalendarId, calendars]);

  /* ------------------------------------------------------------ CRUD */

  const handleCreate = useCallback(
    async (d: DialogDraft) => {
      const payload: CreateEventInput = {
        title: d.title.trim(),
        start: dayjs(d.start).format('YYYY-MM-DDTHH:mm:ssZ'),
        end: dayjs(d.end).format('YYYY-MM-DDTHH:mm:ssZ'),
        allDay: d.allDay,
        location: d.location.trim() || undefined,
        description: d.description.trim() || undefined,
        color: d.color,
        calendarId: d.calendarId || undefined,
      };
      const res = await api.create(payload);
      setWarnings(collectWarnings(res));
      setDraft(null);
      reload();
      notify('ok', '已创建日程');
    },
    [reload, notify],
  );

  const handleUpdate = useCallback(
    async (d: DialogDraft) => {
      const payload: UpdateEventInput = {
        title: d.title.trim(),
        start: dayjs(d.start).format('YYYY-MM-DDTHH:mm:ssZ'),
        end: dayjs(d.end).format('YYYY-MM-DDTHH:mm:ssZ'),
        allDay: d.allDay,
        location: d.location.trim() || undefined,
        description: d.description.trim() || undefined,
        color: d.color,
        calendarId: d.calendarId || undefined,
      };
      const res = await api.update(d.id!, payload);
      setWarnings(collectWarnings(res));
      setDraft(null);
      reload();
      notify('ok', '已保存修改');
    },
    [reload, notify],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      const target = events.find((e) => e.id === id);
      if (!target) return;
      if (!window.confirm(`确认删除「${target.title}」？\n它会先移到回收站，可以随时恢复。`)) return;
      try {
        await api.remove(id, 'soft');
        setDraft(null);
        reload();
        notify('ok', '已移入回收站');
      } catch (e) {
        notify('err', e instanceof ApiError ? e.message : '删除失败');
      }
    },
    [events, reload, notify],
  );

  /** 拖拽或拉伸日程后由日历回调，把新时间写回后端 */
  const handleDragUpdate = useCallback(
    async (event: CalendarEvent) => {
      const id = String(event.id);
      const before = events.find((e) => e.id === id);
      if (!before) return;
      const patch: UpdateEventInput = {
        start: event.start.format('YYYY-MM-DDTHH:mm:ssZ'),
        end: event.end.format('YYYY-MM-DDTHH:mm:ssZ'),
        allDay: event.allDay ?? before.allDay,
      };
      if (patch.start === before.start && patch.end === before.end) return;
      try {
        const res = await api.update(id, patch);
        reload();
        if (res.warnings?.length) notify('ok', `已移动（${res.warnings[0].message}）`);
      } catch (e) {
        reload();
        notify('err', e instanceof ApiError ? e.message : '移动失败');
      }
    },
    [events, reload, notify],
  );

  /* --------------------------------------------------------- 弹窗入口 */

  const openCreate = useCallback(
    (info: CellInfo) => {
      setWarnings([]);
      const end = info.end ?? info.start.add(1, 'hour');
      setDraft({
        title: '',
        allDay: info.allDay ?? false,
        start: info.start.format(LOCAL_FMT),
        end: end.format(LOCAL_FMT),
        location: '',
        description: '',
        color: 'blue',
        calendarId: defaultCalendarId,
      });
    },
    [defaultCalendarId],
  );

  const openEdit = useCallback((event: CalendarEvent) => {
    setWarnings([]);
    const raw = (event.data as { raw?: ScheduleEvent } | undefined)?.raw;
    setDraft({
      id: String(event.id),
      title: event.title,
      allDay: event.allDay ?? false,
      start: event.start.format(LOCAL_FMT),
      end: event.end.format(LOCAL_FMT),
      location: event.location ?? '',
      description: event.description ?? '',
      color: raw?.color ?? 'blue',
      calendarId: raw?.calendarId ?? '',
    });
  }, []);

  /** 工具栏「新建」没有格点信息，默认落在下一个整点、时长 1 小时 */
  const openCreateDefault = useCallback(() => {
    const start = dayjs().startOf('hour').add(1, 'hour');
    setWarnings([]);
    setDraft({
      title: '',
      allDay: false,
      start: start.format(LOCAL_FMT),
      end: start.add(1, 'hour').format(LOCAL_FMT),
      location: '',
      description: '',
      color: 'blue',
      calendarId: defaultCalendarId,
    });
  }, [defaultCalendarId]);

  /** 由 IlEventFormBridge 交回来的关闭函数，用来同步关掉组件内部那张表单 */
  const ilFormCloseRef = useRef<() => void>(() => ({}));
  const ilFormOpenedRef = useRef(false);

  const registerIlFormClose = useCallback((fn: () => void) => {
    ilFormCloseRef.current = fn;
  }, []);

  const markIlFormOpened = useCallback(() => {
    ilFormOpenedRef.current = true;
  }, []);

  /**
   * 从内置表单叫出来的草稿一旦关掉，就顺手把组件内部的表单状态也复位。
   * 否则 open 一直是 true，用户第二次点「新建」不会再触发。
   */
  useEffect(() => {
    if (draft || !ilFormOpenedRef.current) return;
    ilFormOpenedRef.current = false;
    ilFormCloseRef.current?.();
  }, [draft]);

  /**
   * 内置表单打开时给我们的事件：组件「新建」会塞一个模板事件（标题「新日程」）
   * 进来，不能光看有没有 id。只有确实命中我们已加载的日程才当编辑。
   */
  const openFromBuiltInForm = useCallback(
    (selected: CalendarEvent | null) => {
      const id = selected?.id == null ? '' : String(selected.id);
      if (id && events.some((e) => e.id === id)) openEdit(selected!);
      else openCreateDefault();
    },
    [events, openEdit, openCreateDefault],
  );

  const renderEventForm = useCallback(
    (props: EventFormProps) => (
      <IlEventFormBridge
        open={Boolean(props.open)}
        selectedEvent={props.selectedEvent ?? null}
        onClose={props.onClose}
        registerClose={registerIlFormClose}
        onOpened={markIlFormOpened}
        onOpen={openFromBuiltInForm}
      />
    ),
    [registerIlFormClose, markIlFormOpened, openFromBuiltInForm],
  );

  const handleDateChange = useCallback((_date: unknown, range: VisibleRange) => {    setVisibleRange({
      from: range.start.subtract(RANGE_BUFFER_DAYS, 'day').toISOString(),
      to: range.end.add(RANGE_BUFFER_DAYS, 'day').toISOString(),
    });
  }, []);

  /* ------------------------------------------------------------ 设置 */

  const saveSettings = useCallback(
    async (patch: Partial<AppSettings>) => {
      try {
        const next = await settingsApi.update(patch);
        setSettings(next);
        applyTheme(next.theme);
        writeLocalSettings(next);
        return true;
      } catch {
        return false;
      }
    },
    [],
  );

  const resetSettings = useCallback(async () => {
    try {
      const next = await settingsApi.reset();
      setSettings(next);
      applyTheme(next.theme);
      writeLocalSettings(next);
    } catch {
      notify('err', '恢复默认失败，请检查服务是否在运行');
    }
  }, [notify]);

  const handleLogout = useCallback(async () => {
    try {
      await authApi.logout();
    } catch {
      /* 会话可能已失效，忽略 */
    }
    clearLocalSettings();
    setShowSettings(false);
    setUser(null);
    setEvents([]);
    setCalendars([]);
    setAuthState('anon');
    setAuthNotice(null);
  }, []);

  const reloadCalendars = useCallback(async () => {
    try {
      const res = await calendarsApi.list();
      setCalendars(res.data);
      // 当前选中的分组被删掉了就回到「全部」
      setSelectedCalendarId((cur) => (cur && res.data.some((c) => c.id === cur) ? cur : null));
    } catch (e) {
      if (e instanceof ApiError && e.isAuthError) handleAuthExpired();
    }
  }, [handleAuthExpired]);

  /* ------------------------------------------------------------- 渲染 */

  if (authState === 'checking') {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="text-xs text-muted-foreground">正在检查登录状态…</span>
      </div>
    );
  }

  if (authState === 'setup') {
    return (
      <SetupScreen
        suggestedUsername={setupUsername}
        onSuccess={(u) => {
          setUser(u);
          setAuthNotice(null);
          setAuthState('authed');
          setLoading(true);
        }}
      />
    );
  }

  if (authState === 'anon') {
    return (
      <LoginScreen
        notice={authNotice}
        onSuccess={(u) => {
          setUser(u);
          setAuthNotice(null);
          setAuthState('authed');
          setLoading(true);
        }}
      />
    );
  }

  const sidebarCollapsed = !settings.sidebarOpen;

  /**
   * 手机上把默认的「周视图」换成「日视图」。
   *
   * 周视图是 7 列等宽 + 时间轴，390px 宽的手机上每列不到 50px，日程标题全被
   * 截成一个字 —— 不是排版难看，是根本读不了。只在挂载时生效（initialView），
   * 用户自己切回周视图不会被抢回来，服务端存的 defaultView 也不改。
   */
  const initialView = isMobile && settings.defaultView === 'week' ? 'day' : settings.defaultView;

  const closeMobileNav = () => setMobileNavOpen(false);

  return (
    <div className="flex h-full flex-col">
      <header className="app-header flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-3 sm:h-14 sm:gap-4 sm:px-5">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          {/* 手机端：侧栏入口。桌面端侧栏常驻，这个按钮不出现 */}
          <button
            type="button"
            aria-label="打开日历侧栏"
            aria-expanded={mobileNavOpen}
            onClick={() => setMobileNavOpen(true)}
            className="-ml-1 rounded-[var(--radius-sm)] p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:hidden"
          >
            <Icon name="menu" size={18} />
          </button>

          {/* 包豪斯式的几何标记：方 + 圆 + 方 */}
          <div className="flex items-center gap-1" aria-hidden="true">
            <span className="h-2.5 w-2.5 bg-primary" />
            <span className="h-2.5 w-2.5 rounded-full border border-primary" />
            <span className="h-2.5 w-2.5 bg-primary" />
          </div>
          <h1 className="truncate text-base font-medium tracking-tight">日程管理</h1>
          <span className="hidden truncate text-xs text-muted-foreground sm:inline">
            {loading ? '加载中…' : `${shownEvents.length} 条日程`}
            {selectedCalendarId &&
              ` · ${calendars.find((c) => c.id === selectedCalendarId)?.name ?? ''}`}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1 sm:gap-1.5">
          <Btn variant="ghost" size="sm" onClick={reload} title="重新拉取数据">
            <Icon name="refresh" size={14} />
            <span className="hidden sm:inline">刷新</span>
          </Btn>
          {sidebarCollapsed && !isMobile && (
            <Btn variant="ghost" size="sm" onClick={() => setShowTrash(true)} title="回收站">
              <Icon name="trash" size={14} />
              <span className="hidden sm:inline">回收站</span>
            </Btn>
          )}
          <Btn variant="ghost" size="sm" onClick={() => setShowSettings(true)} title="设置">
            <Icon name="settings" size={14} />
            <span className="hidden sm:inline">设置</span>
          </Btn>
          {user && (
            <span
              className="ml-1 hidden items-center gap-1.5 rounded-[var(--radius-md)] border border-border px-2.5 py-1 text-xs text-muted-foreground md:flex"
              title={`${user.username} · ${user.role === 'admin' ? '管理员' : '普通用户'}`}
            >
              <Icon name="user" size={13} />
              {user.displayName}
            </span>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* 桌面：与日历并排的常驻侧栏 */}
        {!isMobile && (
          <CalendarSidebar
            items={calendars}
            counts={counts}
            selectedId={selectedCalendarId}
            onSelect={setSelectedCalendarId}
            onChanged={() => {
              void reloadCalendars();
              reload();
            }}
            trashCount={trashCount}
            onOpenTrash={() => setShowTrash(true)}
            collapsed={sidebarCollapsed}
            onToggleCollapse={() => void saveSettings({ sidebarOpen: sidebarCollapsed })}
          />
        )}

        {/* 手机：抽屉。遮罩与面板都常驻，用位移做动画，避免每次开合都重挂组件 */}
        {isMobile && (
          <>
            <div
              aria-hidden="true"
              onClick={closeMobileNav}
              className={`fixed inset-0 z-40 bg-[var(--overlay)] transition-opacity duration-200 ${
                mobileNavOpen ? 'opacity-100' : 'pointer-events-none opacity-0'
              }`}
            />
            <div
              role="dialog"
              aria-modal={mobileNavOpen}
              aria-label="日历分组"
              className={`app-drawer fixed inset-y-0 left-0 z-50 w-[80%] max-w-[300px] border-r border-border bg-sidebar shadow-2xl transition-transform duration-200 ease-out ${
                mobileNavOpen ? 'translate-x-0' : '-translate-x-full'
              }`}
            >
              <CalendarSidebar
                items={calendars}
                counts={counts}
                selectedId={selectedCalendarId}
                onSelect={(id) => {
                  setSelectedCalendarId(id);
                  closeMobileNav();
                }}
                onChanged={() => {
                  void reloadCalendars();
                  reload();
                }}
                trashCount={trashCount}
                onOpenTrash={() => {
                  closeMobileNav();
                  setShowTrash(true);
                }}
                collapsed={false}
                docked={false}
                onToggleCollapse={closeMobileNav}
              />
            </div>
          </>
        )}

        <main className="min-h-0 flex-1 overflow-hidden p-2 sm:p-4">
          <IlamyCalendar
            key={`${settings.firstDayOfWeek}-${settings.timeFormat}-${isMobile ? 'm' : 'd'}`}
            events={calendarEvents}
            plugins={plugins}
            initialView={initialView}
            locale="zh-cn"
            translations={zhCN}
            timeFormat={settings.timeFormat}
            firstDayOfWeek={settings.firstDayOfWeek}
            timezone="Asia/Shanghai"
            scrollTime="08:00:00"
            scrollToNow
            onCellClick={openCreate}
            onEventClick={openEdit}
            onEventUpdate={handleDragUpdate}
            onDateChange={handleDateChange}
            renderEventForm={renderEventForm}
            renderCurrentTimeIndicator={renderCurrentTimeIndicator}
          />
        </main>
      </div>

      {draft && (
        <EventDialog
          draft={draft}
          calendars={calendars}
          warnings={warnings}
          onCancel={() => setDraft(null)}
          onSave={(d) => (d.id ? handleUpdate(d) : handleCreate(d))}
          onDelete={(id) => void handleDelete(id)}
        />
      )}

      <SettingsPanel
        open={showSettings}
        settings={settings}
        user={user!}
        onClose={() => setShowSettings(false)}
        onSave={saveSettings}
        onReset={resetSettings}
        onUserChange={setUser}
        onLogout={() => void handleLogout()}
      />

      <TrashPanel
        open={showTrash}
        onClose={() => setShowTrash(false)}
        onChanged={() => {
          reload();
          void reloadCalendars();
          void reloadTrashCount();
        }}
      />

      {toast && (
        <div
          className={`fixed bottom-5 left-1/2 z-[60] -translate-x-1/2 rounded-[var(--radius-md)] px-4 py-2 text-xs shadow-lg ${
            toast.kind === 'ok' ? 'bg-accent text-foreground' : 'bg-destructive text-destructive-foreground'
          }`}
          role="status"
        >
          {toast.text}
        </div>
      )}
    </div>
  );
}
