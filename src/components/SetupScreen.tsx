import { useState } from 'react';
import { setup as setupApi, ApiError } from '../api/client';
import type { User } from '../../shared/types';
import { Btn, Field, Icon, INPUT_CLS, Notice } from './ui';

/**
 * 初始化引导页。
 *
 * 库里一个用户都没有时顶替登录页出现：首个管理员在这里创建，而不是去服务器
 * 控制台抄一次性口令。创建成功后服务端直接下发会话，不需要再登录一次。
 */
export function SetupScreen({
  suggestedUsername,
  onSuccess,
}: {
  suggestedUsername: string;
  onSuccess: (user: User) => void;
}) {
  const [username, setUsername] = useState(suggestedUsername || 'admin');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tooShort = password.length > 0 && password.length < 8;
  const mismatch = confirm.length > 0 && confirm !== password;
  const canSubmit = username.trim().length >= 3 && password.length >= 8 && confirm === password;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) {
      setError(tooShort ? '口令至少 8 位' : mismatch ? '两次输入的口令不一致' : '请填写用户名与口令');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await setupApi.createAdmin({
        username: username.trim(),
        password,
        displayName: displayName.trim() || undefined,
      });
      onSuccess(res.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '创建失败，请检查服务是否在运行');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center px-4">
      <div className="w-full max-w-[400px]">
        <div className="mb-6 flex items-center gap-1.5" aria-hidden="true">
          <span className="h-3 w-3 bg-primary" />
          <span className="h-3 w-3 rounded-full border-2 border-primary" />
          <span className="h-3 w-3 bg-primary" />
        </div>

        <h1 className="text-xl font-medium tracking-tight">初始化</h1>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          这个实例还没有任何用户。创建第一个管理员账号即可开始使用，之后可以在「设置 → 用户」里添加其他人。
        </p>

        <form onSubmit={submit} className="mt-6 space-y-4">
          {error && <Notice tone="danger">{error}</Notice>}

          <Field label="用户名" hint="字母、数字、点、下划线或短横线，3–32 位">
            <input
              className={INPUT_CLS}
              value={username}
              autoFocus
              autoComplete="username"
              onChange={(e) => setUsername(e.target.value)}
              placeholder="admin"
            />
          </Field>

          <Field label="显示名" hint="留空则与用户名相同">
            <input
              className={INPUT_CLS}
              value={displayName}
              autoComplete="nickname"
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="例：管理员"
            />
          </Field>

          <Field label="口令" hint="至少 8 位">
            <input
              className={INPUT_CLS}
              type="password"
              value={password}
              autoComplete="new-password"
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>

          <Field label="确认口令">
            <input
              className={INPUT_CLS}
              type="password"
              value={confirm}
              autoComplete="new-password"
              onChange={(e) => setConfirm(e.target.value)}
            />
          </Field>

          <Btn type="submit" variant="primary" size="lg" className="w-full" disabled={busy || !canSubmit}>
            {busy ? '创建中…' : '创建管理员并进入'}
          </Btn>
        </form>

        <p className="mt-6 flex items-start gap-2 text-2xs leading-relaxed text-muted-foreground">
          <span className="mt-0.5">
            <Icon name="key" size={13} />
          </span>
          <span>
            这个账号是管理员。建好后到「设置 → API 令牌」签发一个令牌，AI Agent 就能用
            <code className="mx-1 rounded-[var(--radius-xs)] bg-muted px-1 py-0.5">Authorization: Bearer</code>
            读写日程，不需要你的登录口令。
          </span>
        </p>
      </div>
    </div>
  );
}
