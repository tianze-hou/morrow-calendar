# 服务器部署指南

从环境依赖到构建、运行、配置、备份和排障的完整说明。

多用户与鉴权（口令登录 + API 令牌）已实现且默认开启，配置方法见第 5 节。
只有当服务跑在本机、不对外时，才建议用 `AUTH_ENABLED=false` 把它关掉。

## 1. 环境依赖

| 依赖 | 版本要求 | 说明 |
| --- | --- | --- |
| Node.js | ≥ 22 | 用到原生 `fetch`、`node:sqlite` 回退路径、`crypto.randomUUID`。推荐 22 LTS |
| npm | ≥ 10 | 随 Node 一起装 |
| SQLite 驱动 | 二选一 | 默认优先 `better-sqlite3`（原生，Node 22 有预编译包，通常无需工具链）；装不上会打印中文警告并自动回退 `node-sqlite3-wasm`（纯 WASM，零编译） |
| curl | 任意 | 部署脚本用它做健康检查 |
| rsync | 任意 | 部署脚本用它同步产物 |
| systemd 或 pm2 | 二选一 | 进程守护，脚本默认走 systemd |
| Caddy（可选） | 2.x | 反向代理 + 自动 HTTPS |

关于驱动的选择：留空 `DB_DRIVER` 即自动（原生优先、WASM 兜底），这是推荐配置。两者写入路径都走同一份 SQL 与事务，业务代码不用改。

想要确定性（比如容器里只想装一个），明确写 `DB_DRIVER=better-sqlite3`：此时装不上会直接启动失败，不会静默降级，免得线上"以为在用原生、其实在跑 WASM"。写 `DB_DRIVER=wasm` 则完全跳过原生加载。

WASM 驱动使用 `journal_mode = DELETE` 而不是 WAL，因为 WAL 在该 VFS 实现下会间歇抛 `disk I/O error`。所以升级或迁移时若发现 `calendar.db-journal`、`calendar.db.lock` 残留文件，直接删掉即可，它们是异常退出留下的陈旧回滚日志。

## 2. 目录约定

| 路径 | 用途 | 备注 |
| --- | --- | --- |
| `/opt/morrow-calendar` | 应用目录（`dist/`、`dist-server/`、`node_modules/`） | 每次部署整体覆盖 |
| `/var/lib/morrow-calendar` | 数据目录（`calendar.db`） | 必须在代码目录之外，否则部署会被覆盖 |
| `/etc/morrow-calendar.env` | 环境变量文件 | 权限 0600 |
| `/var/backups/morrow-calendar` | 数据库备份 | 建议另机异地保存 |

## 3. 构建

```bash
# 在开发机上（或直接在服务器上）
npm ci                 # 严格按 lockfile 安装
npm run build          # = 前端 vite build + 后端 esbuild 打包
```

产物：

| 产物 | 内容 |
| --- | --- |
| `dist/` | 前端静态资源（HTML + CSS + JS，已按 react / calendar 分包） |
| `dist-server/index.mjs` | 后端单文件产物（约 47 KB，`--packages=external`，运行时依赖 `node_modules`） |

后端同时托管前端静态资源：只要 `dist/` 存在，访问根路径就是完整页面，不需要额外配 nginx 静态目录。

只构建其中一侧：

```bash
npm run build:web      # 只出 dist/
npm run build:server   # 只出 dist-server/
```

## 4. 运行

### 4.1 一键部署（推荐，systemd）

```bash
sudo bash deploy/deploy.sh
```

脚本按顺序完成：环境检查（Node ≥ 22）→ `npm ci --omit=dev` + `npm run build` → 同步产物到 `/opt/morrow-calendar` → 创建 `morrow` 系统用户 → 生成 `/etc/morrow-calendar.env` → 安装并启动 systemd 服务 → 健康检查。可重复执行。

常用运维命令：

```bash
systemctl status morrow-calendar
journalctl -u morrow-calendar -f
systemctl restart morrow-calendar
```

### 4.2 手动运行（调试用）

```bash
PORT=8787 DB_PATH=/var/lib/morrow-calendar/calendar.db node dist-server/index.mjs
```

### 4.3 pm2（不用 systemd 时）

```bash
npm i -g pm2
pm2 start deploy/ecosystem.config.cjs
pm2 save && pm2 startup     # 开机自启
pm2 logs morrow-calendar
```

注意：SQLite 是单文件写入，不能开 cluster 多实例。配置里 `instances: 1 / exec_mode: fork` 不要改。

## 5. 配置项

全部走环境变量（见 `deploy/morrow-calendar.env.example`）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 监听端口 |
| `DB_PATH` | `./data/calendar.db` | 数据库绝对路径，生产务必指向 `/var/lib/morrow-calendar/calendar.db` |
| `TZ_NAME` | `Asia/Shanghai` | 服务端默认时区，影响不带偏移的时间串解析 |
| `DB_DRIVER` | 自动（原生优先，回退 WASM） | `wasm` / `better-sqlite3` |
| `MAX_BATCH_SIZE` | `50` | 批量接口单次上限 |
| `AUTH_ENABLED` | `true` | 是否强制鉴权。`false` 时免登录，所有请求算作本地用户 |
| `ADMIN_USERNAME` | `admin` | 初始化引导预填的管理员用户名（自动建号时也用它） |
| `ADMIN_PASSWORD` | 空 | 留空则不在服务端建号，改由浏览器初始化引导创建首个管理员；设了则自动建号（口令不再随机生成、也不打印）。无浏览器环境务必设上 |
| `SESSION_DAYS` | `30` | 会话有效期（天） |
| `SESSION_COOKIE` | `morrow_session` | 会话 cookie 名 |
| `COOKIE_SECURE` | `NODE_ENV=production` 时为 `true` | 走 HTTPS 时保持 `true`；HTTP 直连必须置 `false`，否则浏览器不回传 cookie |
| `MAX_CALENDARS` | `20` | 每用户日历分组上限 |
| `MAX_TOKENS` | `10` | 每用户有效 API 令牌上限 |
| `CORS_ORIGINS` | 空 | 逗号分隔的跨域白名单。留空即不启用跨域（前端同源部署时不需要） |
| `NODE_ENV` | — | 设为 `production` |

### 5.1 首次启动：管理员与历史数据

首次启动（库里没有 `users` 行）时走哪条路，取决于有没有给初始口令：

| 情况 | 行为 |
| --- | --- |
| 多用户模式（默认）且**没有**设 `ADMIN_PASSWORD` | 服务端不建号，前端显示「初始化」向导，由人在浏览器里创建首个管理员。`GET /api/setup/status` 返回 `needsSetup: true`，启动横幅会打印一行提示。够不到浏览器的环境请改用下一行。 |
| 多用户模式且**设了** `ADMIN_PASSWORD` | 自动建号并把口令打进启动横幅。容器、CI、纯 SSH 部署建议走这条。 |
| `AUTH_ENABLED=false`（本机单人） | 自动建号，仍然打印口令；免登录模式下还有一个隐式的 `local` 账号兜底。 |

无论哪条路径，建号时都会顺带做三件事：

1. 为管理员建 `id='default'` 的默认日历分组；
2. 接管历史数据：把 v2 时代 `user_id IS NULL` 的日程与无归属的设置划归管理员；
3. 建好之后 `POST /api/setup/admin` 立刻封口（再调用返回 `409 ALREADY_EXISTS`），不会变成开账号的后门。

走自动建号时，启动横幅长这样：

```
  存储      better-sqlite3（better-sqlite3）→ /var/lib/morrow-calendar/calendar.db
  鉴权      已开启
  ── 首次启动，已创建管理员账号 ──
  用户名    admin
  口令      xxxxxxxxxxxxxxxx
  注意：这是口令唯一一次明文显示，请立即保存并尽快修改。
```

口令只打印这一次。忘了就跑 `npm run passwd -- --user admin` 重置（会同时踢掉该用户全部会话）。管理员也可以在网页「设置 → 用户」里重置他人口令。

### 5.2 运维脚本

```bash
npm run passwd -- --user admin              # 重置某用户口令（交互式输入新口令）
npm run token -- --user admin --name "Agent" # 为该用户签发 API 令牌，明文只显示一次
npm run seed                                 # 灌演示数据（会自动建「工作/学习/生活」分组）
```

### 5.3 给 AI Agent 发令牌

多用户下 Agent 不再用登录口令，改用令牌：

1. 管理员执行 `npm run token -- --user admin --name "Agent"`，或在前端「设置 → API 令牌」里创建；
2. 把明文令牌交给 Agent，请求头带 `Authorization: Bearer <令牌>`（也支持 `X-API-Token`）；
3. 令牌可随时吊销，且不影响当前登录状态。

### 5.4 反向代理（Caddy）

见 `deploy/Caddyfile.example`。因为后端已托管静态资源，整站反代到 `127.0.0.1:8787` 即可。

```caddyfile
schedule.example.com {
	encode gzip
	reverse_proxy 127.0.0.1:8787
}
```

```bash
caddy fmt --overwrite /etc/caddy/Caddyfile && systemctl reload caddy
```

关于 Caddy 前置认证：现在应用自己就有登录与令牌，不需要再叠一层 `basic_auth`。如果仍要加，注意 `basic_auth` 会连 `/api` 一起拦，AI Agent 将调不动接口，届时应把 `/api*` 单独放行。更简单的做法是直接用应用自己的 `AUTH_ENABLED=true` 加令牌。

## 6. 数据与备份

```bash
sudo bash deploy/backup.sh
```

- 用 SQLite 官方的 `.backup` / `VACUUM INTO`，服务运行中也能安全备份，不需要停机。
- 默认保留 30 天（`KEEP_DAYS` 可改）。
- 定时备份：`0 3 * * * /usr/bin/bash /opt/morrow-calendar/deploy/backup.sh >> /var/log/morrow-calendar/backup.log 2>&1`

恢复：

```bash
systemctl stop morrow-calendar
gunzip -c /var/backups/morrow-calendar/calendar-20261012-030000.db.gz > /var/lib/morrow-calendar/calendar.db
chown morrow:morrow /var/lib/morrow-calendar/calendar.db
systemctl start morrow-calendar
```

## 7. 升级与回滚

一次性做完「备份 → 拉版本 → 构建 → 重启 → 健康检查」，失败会自动切回上一个版本：

```bash
cd /path/to/source
sudo bash deploy/update.sh              # 升级到当前分支的远端最新
sudo bash deploy/update.sh v0.3.0       # 或指定 tag / 分支 / commit
sudo bash deploy/update.sh --no-pull    # 不拉代码，只按当前代码重新部署
```

脚本在动手前会先体检并拦住三类问题：Node 版本过低、工作副本有未提交改动、**数据库文件落在代码目录里**（后者会让 git 操作有覆盖数据的风险，必须先移到 `DATA_DIR`）。升级前的数据库备份落在 `/var/backups/morrow-calendar/calendar-preupdate-<时间戳>.db.gz`。

手动分步做也可以（`update.sh` 只是把下面这几步串起来）：

```bash
cd /path/to/source && git pull
sudo bash deploy/backup.sh          # 先备份
sudo bash deploy/deploy.sh          # 重建产物并 restart

# 回滚：切回上一个提交重新执行部署即可（数据目录独立，不受影响）
git checkout <上一个版本> && sudo bash deploy/deploy.sh
```

数据库 schema 变更由 `user_version` 迁移机制自动处理。当前版本是 3：新增 `users` / `sessions` / `api_tokens` / `calendars` 四张表，`events` 补了 `user_id`、`deleted_at` 列与索引。旧库升级无需手工干预，升级到 v3 后第一次启动会自动创建管理员并接管历史数据。升级前建议先跑一次 `deploy/backup.sh`。

> 三处环境怎么对齐：代码只有一份真相源（GitHub），本地写、推远端、服务器拉取，三处都不手改线上文件。数据（`calendar.db`）不进 git、也不进服务器上的代码目录，因此「同步代码」永远不会碰数据。想让线上固定某个版本，就在本地 `git tag v0.3.0 && git push --tags`，服务器上 `update.sh v0.3.0` 即可；要回退就 `update.sh v0.2.0`。

## 8. 健康检查与验收

```bash
curl -fsS http://127.0.0.1:8787/api/health      # 应返回 status: ok、driver、eventCount、trashCount、userCount、authRequired、setupRequired
curl -fsS http://127.0.0.1:8787/api/setup/status # 空库时 needsSetup: true，表示还没初始化
curl -fsS http://127.0.0.1:8787/api/meta        # 自描述，含 authentication、onboarding、quickstart 与全部端点（每个端点带 auth 标记）
curl -fsS http://127.0.0.1:8787/api/agent.md    # 面向 Agent 的一页式简报（Markdown）
curl -fsS http://127.0.0.1:8787/                # 前端页面
```

鉴权开启后，业务接口要先登录拿会话 cookie：

```bash
# 1) 登录，把会话 cookie 存到 jar
curl -s -c /tmp/jar.txt -X POST http://127.0.0.1:8787/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"<口令>"}'

# 2) 带上 cookie 访问
curl -fsS -b /tmp/jar.txt 'http://127.0.0.1:8787/api/events?window=today'

# 或改用令牌（免登录）
curl -fsS -H "Authorization: Bearer <令牌>" 'http://127.0.0.1:8787/api/events?window=today'
```

上线后建议跑一遍本地冒烟，把服务地址指到服务器即可（冒烟脚本会自行处理登录与令牌）：

```bash
SCHEDULE_API_BASE=https://你的域名/api npm run smoke
```

## 9. 排障速查

| 现象 | 排查 |
| --- | --- |
| 启动报 `Cannot find module 'better-sqlite3'` | 留空 `DB_DRIVER` 会自动回退 WASM；若显式写了 `better-sqlite3` 则改为 `wasm`，或装编译工具链后 `npm ci` |
| 日志出现「未能加载 better-sqlite3，回退到 node-sqlite3-wasm」 | 属于预期兜底，不是错误；想确认真实驱动看启动横幅的「存储」行或 `/api/health` 的 `storage.driver` |
| WASM 驱动间歇报 `disk I/O error` | 删掉 `calendar.db-journal` / `calendar.db.lock` 残留后重启；根治方式是启用 `better-sqlite3` |
| 日志报 `Dynamic require of "path"` | 用了旧构建命令；确认 `build:server` 带 `--packages=external` |
| 页面 404 但 `/api` 正常 | `dist/` 不存在，先跑 `npm run build:web` |
| 所有接口都返回 401 `UNAUTHORIZED` | 鉴权已开但没带 cookie/令牌；或 `COOKIE_SECURE=true` 却在 HTTP 下访问（浏览器不回传 cookie） |
| 登录成功但刷新后掉线 | 同样是 `COOKIE_SECURE` 与访问协议不匹配，HTTP 场景置 `false` |
| 时间差 8 小时 | 检查 `TZ_NAME`，并确保接口时间串带偏移 |
| 数据库被锁 | 不要开多实例；确认只有一个进程持有 `DB_PATH` |
| 改了设置刷新后复原 | 检查 `DB_PATH` 指向的库文件是否可写（`morrow` 用户权限） |
| 第二个管理员无法降级 | 设计如此：最后一个管理员不可降级/删除（`LAST_ADMIN`） |

## 10. 能力状态

| 能力 | 状态 |
| --- | --- |
| 初始化引导（浏览器创建首个管理员） | 已启用；设了 `ADMIN_PASSWORD` 或 `AUTH_ENABLED=false` 时改为服务端自动建号 |
| 多用户 / 权限（管理员、普通成员） | 已启用，数据按用户隔离 |
| 鉴权（口令登录 + API 令牌） | 已启用，默认 `AUTH_ENABLED=true` |
| 回收站（软删除 / 恢复 / 清空） | 已启用 |
| 多日历分组（配色、显隐、改名、删除迁移） | 已启用 |
| 白日 / 黑夜两套配色 | 已启用 |
| 日历分组共享给他人 | 未实现，表结构已留扩展余地（见 `docs/roadmap.md` #12） |
| 重复日程（RRULE） | 字段预留且恒为空，见 `docs/roadmap.md` #1 |
| Caddy 前置登录 | 不再需要（应用自带鉴权）；`deploy/Caddyfile.example` 留有注释占位 |
