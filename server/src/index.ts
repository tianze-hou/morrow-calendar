import { createApp } from './app';
import { bootstrap } from './bootstrap';
import { config } from './config';
import { getDb } from './db/index';
import { chosenDriver } from './db/driver';
import { purgeExpiredSessions } from './repository/sessions';

async function main() {
  const db = await getDb();
  const result = await bootstrap();
  const purged = await purgeExpiredSessions();
  const app = createApp();

  app.listen(config.port, () => {
    const line = '─'.repeat(58);
    // eslint-disable-next-line no-console
    console.log(line);
    console.log('  morrow calendar 已启动');
    console.log(`  接口      http://127.0.0.1:${config.port}/api`);
    console.log(`  自描述    http://127.0.0.1:${config.port}/api/meta`);
    console.log(`  健康检查  http://127.0.0.1:${config.port}/api/health`);
    console.log(`  存储      ${db.name}（${chosenDriver}）→ ${config.dbPath}`);
    console.log(`  时区      ${config.timezone}`);
    console.log(`  鉴权      ${config.auth.enabled ? '已开启' : '已关闭（AUTH_ENABLED=false，免登录）'}`);

    if (result.created) {
      console.log('');
      console.log('  ── 首次启动，已创建管理员账号 ──');
      console.log(`  用户名    ${result.username}`);
      if (result.generatedPassword) {
        console.log(`  口令      ${result.generatedPassword}`);
        console.log('  注意：这是口令唯一一次明文显示，请立即保存并尽快修改。');
        console.log('  也可以在启动前设置 ADMIN_PASSWORD 环境变量来自行指定。');
      } else {
        console.log('  口令      取自环境变量 ADMIN_PASSWORD');
      }
    }
    if (result.setupPending) {
      console.log('');
      console.log('  ── 待初始化 ──');
      console.log('  库里还没有任何用户。请用浏览器打开本服务，按页面提示创建管理员账号。');
      console.log('  （不想在浏览器里创建：设置 ADMIN_PASSWORD 后重启，会自动建号并打印口令。）');
    }
    if (result.adopted.events || result.adopted.settings) {
      console.log(`  已接管历史数据：日程 ${result.adopted.events} 条、设置 ${result.adopted.settings} 项`);
    }
    if (purged > 0) console.log(`  已清理过期会话 ${purged} 条`);
    console.log(line);

    // 提示如何在多用户环境下给 AI Agent 发一个令牌
    if (config.auth.enabled && result.created) {
      console.log('  给 AI Agent 签发令牌：npm run token -- --user <用户名> --name "Agent"');
      console.log(line);
    }
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
