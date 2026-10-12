/**
 * 命令行签发 API 令牌。
 * 用法：npm run token -- --user admin --name "Claude Agent" [--ttl 365]
 * ttl 单位为天，省略表示长期有效。
 *
 * 适合在服务器上给 AI Agent 开一个凭据，不必先打开浏览器登录。
 */
import { closeDb } from '../db/index';
import { getUserByUsername } from '../repository/users';
import { createToken } from '../repository/tokens';
import { config } from '../config';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const username = arg('user');
  const name = arg('name') ?? 'CLI 令牌';
  const ttlRaw = arg('ttl');
  const ttlDays = ttlRaw ? Number(ttlRaw) : null;

  if (!username) {
    console.error('缺少 --user。例：npm run token -- --user admin --name "Agent"');
    process.exit(1);
  }
  if (ttlRaw && (!Number.isFinite(ttlDays) || (ttlDays as number) <= 0)) {
    console.error('--ttl 需为正整数（天）');
    process.exit(1);
  }

  const user = await getUserByUsername(username);
  if (!user) {
    console.error(`用户不存在：${username}`);
    process.exit(1);
  }

  const created = await createToken(user.id, name, ttlDays);

  console.log('───────────────────────────────────────────────');
  console.log(`  已为「${user.username}」签发令牌：${created.name}`);
  console.log(`  前缀      ${created.prefix}…`);
  console.log(`  有效期    ${created.expiresAt ?? '长期有效'}`);
  console.log('');
  console.log('  令牌明文（唯一一次显示，请立即保存）：');
  console.log('');
  console.log(`  ${created.token}`);
  console.log('');
  console.log('  调用时带上：');
  console.log(`  Authorization: Bearer ${created.token.slice(0, 20)}…`);
  console.log('───────────────────────────────────────────────');

  if (!config.auth.enabled) {
    console.log('提示：当前 AUTH_ENABLED=false，所有请求已自动归属本机账号，令牌暂不会被校验。');
  }
  await closeDb();
}

main().catch(async (err) => {
  console.error(err);
  await closeDb().catch(() => undefined);
  process.exit(1);
});
