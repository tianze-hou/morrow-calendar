import { useState } from 'react';
import { auth, ApiError } from '../api/client';
import type { User } from '../../shared/types';
import { Btn, Field, Icon, INPUT_CLS, Notice } from './ui';

/** 登录页。包豪斯式居中构图：一个方形标记 + 一条竖线 + 极简表单。 */
export function LoginScreen({
  onSuccess,
  notice,
}: {
  onSuccess: (user: User) => void;
  /** 服务端在别处产生的提示，例如「会话已过期」 */
  notice?: string | null;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!username.trim() || !password) {
      setError('请填写用户名与口令');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await auth.login(username.trim(), password);
      onSuccess(res.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '登录失败，请检查服务是否在运行');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center px-4">
      <div className="w-full max-w-[360px]">
        {/* 几何标记：方 + 圆 + 方，与顶栏同一套视觉语言 */}
        <div className="mb-6 flex items-center gap-1.5" aria-hidden="true">
          <span className="h-3 w-3 bg-primary" />
          <span className="h-3 w-3 rounded-full border-2 border-primary" />
          <span className="h-3 w-3 bg-primary" />
        </div>

        <h1 className="text-xl font-medium tracking-tight">日程管理</h1>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          请登录以读取与修改你自己的日程。AI Agent 请改用 API 令牌，无需登录页面。
        </p>

        <form onSubmit={submit} className="mt-6 space-y-4">
          {notice && <Notice tone="warn">{notice}</Notice>}
          {error && <Notice tone="danger">{error}</Notice>}

          <Field label="用户名">
            <input
              className={INPUT_CLS}
              value={username}
              autoFocus
              autoComplete="username"
              onChange={(e) => setUsername(e.target.value)}
              placeholder="admin"
            />
          </Field>

          <Field label="口令">
            <input
              className={INPUT_CLS}
              type="password"
              value={password}
              autoComplete="current-password"
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
          </Field>

          <Btn type="submit" variant="primary" size="lg" className="w-full" disabled={busy}>
            {busy ? '登录中…' : '登录'}
          </Btn>
        </form>

        <p className="mt-6 flex items-start gap-2 text-2xs leading-relaxed text-muted-foreground">
          <span className="mt-0.5">
            <Icon name="key" size={13} />
          </span>
          <span>
            首次部署时，服务端会在启动日志里打印管理员账号与一次性口令。若已遗忘，可在服务器上执行
            <code className="mx-1 rounded-[var(--radius-xs)] bg-muted px-1 py-0.5">npm run token</code>
            直接签发访问令牌。
          </span>
        </p>
      </div>
    </div>
  );
}
