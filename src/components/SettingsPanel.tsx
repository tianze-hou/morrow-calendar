import { useCallback, useEffect, useState } from 'react';
import dayjs from 'dayjs';
import {
  DEFAULT_SETTINGS,
  VIEWS,
  type ApiToken,
  type AppSettings,
  type User,
  type ViewKey,
} from '../../shared/types';
import { ApiError, auth, tokens as tokensApi, users as usersApi } from '../api/client';
import { THEME_OPTIONS } from '../theme';
import { Btn, Empty, Field, Icon, INPUT_CLS, Notice, Segmented, Switch } from './ui';
import { Modal } from './ui';

export interface SettingsPanelProps {
  open: boolean;
  settings: AppSettings;
  user: User;
  onClose: () => void;
  /** 保存回调；返回 true 表示已落库 */
  onSave: (patch: Partial<AppSettings>) => Promise<boolean>;
  onReset: () => Promise<void>;
  onUserChange: (user: User) => void;
  onLogout: () => void;
}

const VIEW_LABEL: Record<ViewKey, string> = {
  day: '日视图',
  week: '周视图',
  month: '月视图',
  agenda: '日程列表',
};

type Tab = 'appearance' | 'account' | 'tokens' | 'users';

export function SettingsPanel({
  open,
  settings,
  user,
  onClose,
  onSave,
  onReset,
  onUserChange,
  onLogout,
}: SettingsPanelProps) {
  const [tab, setTab] = useState<Tab>('appearance');
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setDraft(settings);
      setSaved(false);
      setError(null);
    }
  }, [open, settings]);

  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setSaved(false);
  };

  async function submit() {
    setSaving(true);
    setError(null);
    const ok = await onSave(draft);
    setSaving(false);
    if (ok) {
      setSaved(true);
    } else {
      setError('保存失败，请检查服务是否在运行');
    }
  }

  const tabs: Array<{ key: Tab; label: string }> = [
    { key: 'appearance', label: '外观' },
    { key: 'account', label: '账号' },
    { key: 'tokens', label: 'API 令牌' },
    ...(user.role === 'admin' ? [{ key: 'users' as Tab, label: '用户' }] : []),
  ];

  return (
    <Modal
      open={open}
      onClose={onClose}
      width="lg"
      title="设置"
      description="外观与偏好按账号保存在服务端，换设备也一致。"
      footer={
        tab === 'appearance' ? (
          <>
            <Btn
              variant="quiet"
              size="sm"
              onClick={async () => {
                await onReset();
                setDraft({ ...DEFAULT_SETTINGS });
                setSaved(false);
              }}
            >
              恢复默认
            </Btn>
            <div className="flex items-center gap-2">
              {saved && <span className="text-xs text-muted-foreground">已保存 ✓</span>}
              <Btn variant="ghost" size="sm" onClick={onClose}>
                关闭
              </Btn>
              <Btn variant="primary" size="sm" disabled={saving} onClick={submit}>
                {saving ? '保存中…' : '保存'}
              </Btn>
            </div>
          </>
        ) : (
          <>
            <span />
            <Btn variant="ghost" size="sm" onClick={onClose}>
              关闭
            </Btn>
          </>
        )
      }
    >
      {/* 标签栏 */}
      <div className="mb-5 flex gap-1 border-b border-border">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
              tab === t.key
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-4">
          <Notice tone="danger">{error}</Notice>
        </div>
      )}

      {tab === 'appearance' && (
        <div className="space-y-6">
          <section>
            <div className="mb-2.5 flex items-baseline justify-between">
              <h3 className="text-sm font-medium">配色</h3>
              <span className="text-2xs text-muted-foreground">
                日程块的颜色在每条日程里单独设置
              </span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {THEME_OPTIONS.map((opt) => {
                const active = draft.theme === opt.key;
                return (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => set('theme', opt.key)}
                    className={`rounded-[var(--radius-md)] border p-3 text-left transition-colors ${
                      active ? 'border-primary bg-accent' : 'border-border hover:bg-accent/50'
                    }`}
                  >
                    <div className="mb-2.5 flex gap-1">
                      {opt.swatch.map((c, i) => (
                        <span
                          key={i}
                          className="h-7 w-7 border border-black/15"
                          style={{ background: c, borderRadius: 'var(--radius-xs)' }}
                        />
                      ))}
                    </div>
                    <div className="text-sm font-medium">{opt.label}</div>
                    <div className="mt-1 text-2xs leading-relaxed text-muted-foreground">{opt.note}</div>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="grid gap-5 sm:grid-cols-2">
            <div>
              <h3 className="mb-2 text-sm font-medium">时间格式</h3>
              <Segmented
                value={draft.timeFormat}
                onChange={(v) => set('timeFormat', v)}
                options={[
                  { value: '24-hour', label: '24 小时' },
                  { value: '12-hour', label: '12 小时' },
                ]}
              />
            </div>
            <div>
              <h3 className="mb-2 text-sm font-medium">一周起始</h3>
              <Segmented
                value={draft.firstDayOfWeek}
                onChange={(v) => set('firstDayOfWeek', v)}
                options={[
                  { value: 'monday', label: '周一' },
                  { value: 'sunday', label: '周日' },
                ]}
              />
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-sm font-medium">打开时的默认视图</h3>
            <div className="grid grid-cols-4 gap-2">
              {VIEWS.map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => set('defaultView', v)}
                  className={`rounded-[var(--radius-md)] border px-2 py-1.5 text-sm transition-colors ${
                    draft.defaultView === v
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground'
                  }`}
                >
                  {VIEW_LABEL[v]}
                </button>
              ))}
            </div>
          </section>

          <section>
            <Switch
              checked={draft.sidebarOpen}
              onChange={(v) => set('sidebarOpen', v)}
              label="默认展开日历侧栏"
            />
          </section>
        </div>
      )}

      {tab === 'account' && <AccountTab user={user} onUserChange={onUserChange} onLogout={onLogout} />}
      {tab === 'tokens' && <TokensTab />}
      {tab === 'users' && user.role === 'admin' && <UsersTab me={user} />}
    </Modal>
  );
}

/* ───────────────────────────── 账号 ───────────────────────────── */

function AccountTab({
  user,
  onUserChange,
  onLogout,
}: {
  user: User;
  onUserChange: (u: User) => void;
  onLogout: () => void;
}) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);

  async function submit() {
    setBusy(true);
    setMsg(null);
    try {
      const updated = await auth.changePassword(current, next);
      onUserChange(updated);
      setCurrent('');
      setNext('');
      setMsg({ tone: 'ok', text: '口令已更新' });
    } catch (e) {
      setMsg({ tone: 'danger', text: e instanceof ApiError ? e.message : '修改失败' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className="rounded-[var(--radius-md)] border border-border p-4">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Icon name="user" size={18} />
          </span>
          <div className="min-w-0">
            <div className="text-sm font-medium">{user.displayName}</div>
            <div className="text-2xs text-muted-foreground">
              {user.username} · {user.role === 'admin' ? '管理员' : '普通用户'}
            </div>
          </div>
        </div>
        <div className="mt-3 text-2xs text-muted-foreground">
          创建于 {dayjs(user.createdAt).format('YYYY-MM-DD HH:mm')}
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-medium">修改口令</h3>
        {msg && <Notice tone={msg.tone === 'ok' ? 'ok' : 'danger'}>{msg.text}</Notice>}
        <Field label="当前口令">
          <input
            type="password"
            className={INPUT_CLS}
            value={current}
            autoComplete="current-password"
            onChange={(e) => setCurrent(e.target.value)}
          />
        </Field>
        <Field label="新口令" hint="至少 8 位">
          <input
            type="password"
            className={INPUT_CLS}
            value={next}
            autoComplete="new-password"
            onChange={(e) => setNext(e.target.value)}
          />
        </Field>
        <Btn
          variant="primary"
          size="sm"
          disabled={busy || !current || next.length < 8}
          onClick={() => void submit()}
        >
          {busy ? '提交中…' : '更新口令'}
        </Btn>
      </section>

      <section className="border-t border-border pt-4">
        <Btn variant="outline" size="sm" onClick={onLogout}>
          <Icon name="logout" size={14} />
          退出登录
        </Btn>
      </section>
    </div>
  );
}

/* ─────────────────────────── API 令牌 ─────────────────────────── */

function TokensTab() {
  const [items, setItems] = useState<ApiToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [ttl, setTtl] = useState<'long' | '365' | '90' | '30'>('long');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await tokensApi.list());
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '读取令牌失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const result = await tokensApi.create(name.trim() || '未命名令牌', ttl === 'long' ? null : Number(ttl));
      setCreated(result.token);
      setName('');
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '创建失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <Notice tone="info">
        AI Agent 用令牌访问接口，不必也不能用你的登录口令。请求时带上
        <code className="mx-1 rounded-[var(--radius-xs)] bg-card px-1 py-0.5">Authorization: Bearer &lt;令牌&gt;</code>
        。令牌可以随时吊销，且不会影响你当前的登录状态。
      </Notice>

      {error && <Notice tone="danger">{error}</Notice>}

      {created && (
        <Notice tone="ok">
          <div className="font-medium">令牌已创建 —— 这是唯一一次显示明文，请立刻复制保存。</div>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-[var(--radius-xs)] bg-card px-2 py-1.5 text-2xs">
              {created}
            </code>
            <Btn
              size="sm"
              variant="outline"
              onClick={() => {
                void navigator.clipboard?.writeText(created);
              }}
            >
              复制
            </Btn>
            <Btn size="sm" variant="ghost" onClick={() => setCreated(null)}>
              知道了
            </Btn>
          </div>
        </Notice>
      )}

      <section className="rounded-[var(--radius-md)] border border-border p-3">
        <h3 className="mb-2.5 text-sm font-medium">新建令牌</h3>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="备注名" className="min-w-[160px] flex-1">
            <input
              className={INPUT_CLS}
              value={name}
              maxLength={64}
              placeholder="例：Claude Agent"
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="有效期" className="w-[140px]">
            <select className={INPUT_CLS} value={ttl} onChange={(e) => setTtl(e.target.value as typeof ttl)}>
              <option value="long">长期有效</option>
              <option value="365">1 年</option>
              <option value="90">90 天</option>
              <option value="30">30 天</option>
            </select>
          </Field>
          <Btn variant="primary" size="md" disabled={busy} onClick={() => void create()}>
            <Icon name="plus" size={14} />
            创建
          </Btn>
        </div>
      </section>

      <section>
        <div className="mb-2 flex items-baseline justify-between">
          <h3 className="text-sm font-medium">已有令牌</h3>
          <span className="text-2xs text-muted-foreground">{items.length} 个</span>
        </div>
        {loading ? (
          <Empty text="读取中…" />
        ) : items.length === 0 ? (
          <Empty text="还没有任何令牌" />
        ) : (
          <ul className="divide-y divide-border rounded-[var(--radius-md)] border border-border">
            {items.map((t) => (
              <li key={t.id} className="flex items-center gap-3 px-3 py-2.5">
                <span className="text-muted-foreground">
                  <Icon name="key" size={15} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className={`truncate text-sm ${t.revoked ? 'text-muted-foreground line-through' : ''}`}>
                      {t.name}
                    </span>
                    {t.revoked && (
                      <span className="rounded-[var(--radius-xs)] bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">
                        已吊销
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 text-2xs text-muted-foreground">
                    <code>{t.prefix}…</code>
                    <span>创建 {dayjs(t.createdAt).format('YYYY-MM-DD')}</span>
                    <span>{t.expiresAt ? `到期 ${dayjs(t.expiresAt).format('YYYY-MM-DD')}` : '长期有效'}</span>
                    <span>最近使用 {t.lastUsedAt ? dayjs(t.lastUsedAt).format('MM-DD HH:mm') : '从未'}</span>
                  </div>
                </div>
                {!t.revoked && (
                  <Btn
                    variant="outline"
                    size="sm"
                    onClick={async () => {
                      await tokensApi.revoke(t.id);
                      await load();
                    }}
                  >
                    吊销
                  </Btn>
                )}
                <Btn
                  variant="ghost"
                  size="sm"
                  title="彻底删除记录"
                  onClick={async () => {
                    await tokensApi.remove(t.id);
                    await load();
                  }}
                >
                  <Icon name="trash" size={14} />
                </Btn>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/* ───────────────────────────── 用户 ───────────────────────────── */

function UsersTab({ me }: { me: User }) {
  const [items, setItems] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ username: '', password: '', displayName: '', role: 'member' as 'admin' | 'member' });
  const [busy, setBusy] = useState(false);
  /** 正在重置口令的用户 id；同时只允许一个 */
  const [resetFor, setResetFor] = useState<string | null>(null);
  const [resetPw, setResetPw] = useState('');
  const [resetting, setResetting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await usersApi.list());
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '读取用户失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      await usersApi.create({
        username: form.username.trim(),
        password: form.password,
        displayName: form.displayName.trim() || undefined,
        role: form.role,
      });
      setForm({ username: '', password: '', displayName: '', role: 'member' });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '创建失败');
    } finally {
      setBusy(false);
    }
  }

  /** 重置他人口令。重置后对方所有登录会话会被服务端一并踢掉。 */
  async function resetPassword(id: string) {
    setResetting(true);
    setError(null);
    try {
      await usersApi.update(id, { password: resetPw });
      setResetFor(null);
      setResetPw('');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '重置口令失败');
    } finally {
      setResetting(false);
    }
  }

  return (
    <div className="space-y-5">
      <Notice tone="info">
        每个用户的日程与日历分组完全独立，彼此不可见。管理员可以重置他人口令，但不能删除自己。
      </Notice>

      {error && <Notice tone="danger">{error}</Notice>}

      <section className="rounded-[var(--radius-md)] border border-border p-3">
        <h3 className="mb-2.5 text-sm font-medium">新建用户</h3>
        <div className="grid gap-2.5 sm:grid-cols-2">
          <Field label="用户名">
            <input
              className={INPUT_CLS}
              value={form.username}
              placeholder="字母数字，3–32 位"
              onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
            />
          </Field>
          <Field label="显示名">
            <input
              className={INPUT_CLS}
              value={form.displayName}
              onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))}
            />
          </Field>
          <Field label="初始口令" hint="至少 8 位">
            <input
              type="password"
              className={INPUT_CLS}
              value={form.password}
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
            />
          </Field>
          <Field label="角色">
            <select
              className={INPUT_CLS}
              value={form.role}
              onChange={(e) => setForm((f) => ({ ...f, role: e.target.value as 'admin' | 'member' }))}
            >
              <option value="member">普通用户</option>
              <option value="admin">管理员</option>
            </select>
          </Field>
        </div>
        <div className="mt-3">
          <Btn
            variant="primary"
            size="sm"
            disabled={busy || form.username.trim().length < 3 || form.password.length < 8}
            onClick={() => void create()}
          >
            <Icon name="plus" size={14} />
            创建用户
          </Btn>
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-medium">所有用户</h3>
        {loading ? (
          <Empty text="读取中…" />
        ) : (
          <ul className="divide-y divide-border rounded-[var(--radius-md)] border border-border">
            {items.map((u) => (
              <li key={u.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm">{u.displayName}</span>
                    <span className="text-2xs text-muted-foreground">{u.username}</span>
                    {u.role === 'admin' && (
                      <span className="rounded-[var(--radius-xs)] bg-primary px-1.5 py-0.5 text-2xs text-primary-foreground">
                        管理员
                      </span>
                    )}
                    {u.disabled && (
                      <span className="rounded-[var(--radius-xs)] bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">
                        已停用
                      </span>
                    )}
                    {u.id === me.id && <span className="text-2xs text-muted-foreground">（我）</span>}
                  </div>
                </div>
                {resetFor === u.id ? (
                  <div className="flex items-center gap-1.5">
                    <input
                      type="password"
                      autoFocus
                      className={`${INPUT_CLS} w-[170px]`}
                      value={resetPw}
                      placeholder="新口令（至少 8 位）"
                      autoComplete="new-password"
                      onChange={(e) => setResetPw(e.target.value)}
                    />
                    <Btn
                      variant="primary"
                      size="sm"
                      disabled={resetting || resetPw.length < 8}
                      onClick={() => void resetPassword(u.id)}
                    >
                      {resetting ? '提交中…' : '确认'}
                    </Btn>
                    <Btn
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setResetFor(null);
                        setResetPw('');
                      }}
                    >
                      取消
                    </Btn>
                  </div>
                ) : (
                  <div className="flex gap-1.5">
                    <Btn
                      variant="outline"
                      size="sm"
                      disabled={u.id === me.id}
                      onClick={async () => {
                        await usersApi.update(u.id, { role: u.role === 'admin' ? 'member' : 'admin' });
                        await load();
                      }}
                    >
                      {u.role === 'admin' ? '降为普通' : '升为管理员'}
                    </Btn>
                    <Btn
                      variant="outline"
                      size="sm"
                      disabled={u.id === me.id}
                      onClick={async () => {
                        await usersApi.update(u.id, { disabled: !u.disabled });
                        await load();
                      }}
                    >
                      {u.disabled ? '启用' : '停用'}
                    </Btn>
                    <Btn
                      variant="outline"
                      size="sm"
                      disabled={u.id === me.id}
                      title="为该用户设置一个新口令，其全部登录会话会被踢掉"
                      onClick={() => {
                        setResetFor(u.id);
                        setResetPw('');
                        setError(null);
                      }}
                    >
                      重置口令
                    </Btn>
                    <Btn
                      variant="danger"
                      size="sm"
                      disabled={u.id === me.id}
                      onClick={async () => {
                        if (!window.confirm(`删除用户「${u.username}」及其全部日程？此操作不可撤销。`)) return;
                        await usersApi.remove(u.id);
                        await load();
                      }}
                    >
                      <Icon name="trash" size={14} />
                    </Btn>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
