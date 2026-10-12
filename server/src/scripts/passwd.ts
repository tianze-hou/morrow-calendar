/**
 * 命令行重置口令。服务器上忘记管理员口令时用这个，不需要先登录。
 * 用法：npm run passwd -- --user admin --password '新口令'
 *      省略 --password 则自动生成一个强口令并打印。
 */
import { config } from '../config';
import { closeDb } from '../db/index';
import { checkPasswordStrength } from '../lib/password';
import { generatePassword } from '../lib/tokens';
import { listUsers, updateUser } from '../repository/users';
import { deleteUserSessions } from '../repository/sessions';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const username = arg('user');
  const provided = arg('password');

  if (!username) {
    const users = await listUsers();
    console.error('缺少 --user。现有用户：');
    for (const u of users) console.error(`  ${u.username}（${u.role}${u.disabled ? '，已停用' : ''}）`);
    console.error('\n例：npm run passwd -- --user admin --password "新口令"');
    await closeDb();
    process.exit(1);
  }

  const user = (await listUsers()).find((u) => u.username.toLowerCase() === username.toLowerCase());
  if (!user) {
    console.error(`用户不存在：${username}`);
    await closeDb();
    process.exit(1);
  }

  const password = provided ?? generatePassword();
  const reason = checkPasswordStrength(password);
  if (reason) {
    console.error(reason);
    await closeDb();
    process.exit(1);
  }

  await updateUser(user.id, { password });
  // 改完口令把该用户的旧会话全部踢掉，避免旧 cookie 继续可用
  await deleteUserSessions(user.id);

  console.log('───────────────────────────────────────────────');
  console.log(`  已重置「${user.username}」的口令`);
  console.log(`  口令      ${password}`);
  console.log('  该用户的所有登录会话已失效，需要重新登录。');
  if (!config.auth.enabled) {
    console.log('  提示：当前 AUTH_ENABLED=false，登录页不会出现，此口令暂时用不上。');
  }
  console.log('───────────────────────────────────────────────');

  await closeDb();
}

main().catch(async (err) => {
  console.error(err);
  await closeDb().catch(() => undefined);
  process.exit(1);
});
