---
name: morrow-calendar
description: 操作日程系统 morrow calendar（@ilamy/calendar 前端 + AI-native REST 后端）。当用户要求查看/创建/修改/删除日程、恢复已删日程、管理日历分组、安排会议、查询某天或某周安排、批量整理日程、检查时间冲突、调整界面配色或显示偏好时使用。所有读写一律走 HTTP 接口，绝不通过打开前端页面或解析网页内容来获取数据。
---

# morrow calendar · AI Agent 协作规则

这份规则用来约束 AI Agent 与人类一起操作日程系统。目标很简单：读得快，改得准，动手之前一定让人看得到。

本文件不含任何本机路径或个人化假设，本地开发、服务器部署、别人的机器上都能直接用。

## 1. 连接信息与环境探测

**先判断有没有 MCP。** 本服务内置了 MCP 端点（`POST {BASE}/mcp`，去掉 `/api` 就是——例 `https://example.com/api` 对应 `https://example.com/api/mcp`）。
如果你的客户端支持 MCP，**优先用它**：连上就会自己列出工具与入参说明，不用读下面这些 REST 路径。
MCP 与 REST 能力完全相同、共用同一份业务实现和同一枚令牌；下面所有规则（风险分级、dry_run、回收站、时间处理）在 MCP 里一样适用，只是参数从 query 变成工具入参。
注意 MCP 的写操作**默认是试运行**，必须显式传 `dry_run: false` 才会真的写入。

确认方式：`GET {BASE}/meta` 返回的 `mcp.enabled` 为 `true` 就说明可用，`mcp.tools` 是全部工具名。

客户端不支持 MCP 时，按下面这套 REST 走：

- 服务地址由环境变量 `SCHEDULE_API_BASE` 指定。
  - 已设置就直接用它，后面所有路径都拼在它后面。
  - 没设置就依次试 `http://127.0.0.1:8787/api`、`http://localhost:8787/api`。
- 部署到服务器后通常是 `https://<域名>/api`（反代把 `/api` 指到后端进程）。不要假设端口，先探测。
- 每次会话开始先执行一次 `GET {BASE}/meta`，确认鉴权方式、能力开关、限制与端点清单，不要凭记忆调用。
- `GET {BASE}/agent.md` 是一页式简报，与 `/meta` 同源：把 `?window=` 语义化时间、风险分级、确认流程压缩成一页。不想通读这份规则时，先拉它。
- 协议文档可以直接从服务端取：`GET {BASE}/openapi.yaml`。这是权威来源，优先于任何本地副本。
- 如果连接被拒，告诉人类服务没启动，并说明要在服务所在目录执行 `npm run dev`（本地）或 `npm start`（服务器）。不要自行改端口，也不要自行改动部署配置。

## 2. 鉴权（先做这一步，否则后面全是 401）

`GET /meta` 的 `authentication.required` 会告诉你这个实例要不要鉴权。

- `required: false`（本地单人模式）：不用带任何凭据，直接调用，下面的鉴权内容可以跳过。
- `required: true`（多用户模式）：每个请求都要带令牌，否则返回 `401 UNAUTHORIZED`。

还要看一眼 `GET /meta` 的 `onboarding.required`。它为 `true` 时说明这个实例还没有任何用户，`POST /setup/admin` 尚未使用过——这时候所有业务接口都调不通。正确做法是请人类打开网页完成初始化（首页会显示「初始化」向导），不要试图代它创建首个管理员：那个账号的凭据只应出自人类之手，也不该经过你。

带上令牌的方式，任选其一，推荐第一种：

```
Authorization: Bearer <令牌>
X-API-Token: <令牌>
```

令牌从哪来（都需要人类配合，Agent 不应自行创建账号或绕过鉴权）：

1. 人类在网页「设置 → API 令牌」里生成，把明文复制给你；
2. 或由管理员在服务器上执行 `npm run token -- --user <用户名> --name "<备注>"`。

几条规则：

- 令牌通常长期有效。不要把它写进代码、日志、提交记录，也不要输出给别人，只在请求头里用。
- 收到 `401` 就停下来，向人类索要有效令牌，不要重试、不要猜测、不要绕过。
- 收到 `403 FORBIDDEN`，说明该资源不属于当前令牌对应的用户（比如用了别人的 `calendarId`），不要改用其他令牌硬试。
- 每个令牌只属于一个用户，看到的数据就是这个用户的全部数据。不要尝试列举或访问其他用户的数据。

## 3. 标准工作流

```
① 探测服务地址 + GET /meta      → 确认能力与鉴权方式   （safe，自主执行）
② GET /events ...               → 拿到现状             （safe，自主执行）
③ dry_run=true 试运行           → 得到 changes + warnings（confirm 类必做）
④ 向人类展示将要发生什么        → 等待明确同意
⑤ 去掉 dry_run 真正执行         → 创建时带 Idempotency-Key
⑥ 回报结果：改了什么、产生了哪些警告
```

第 ④ 步不能跳过，也不能假设同意。"帮我安排一下"这类模糊指令不等于授权删除或改时间。

## 4. 自然语言意图 → 接口映射

| 人类说法 | 动作 | 调用 |
| --- | --- | --- |
| 我今天/明天/这周有什么安排 | 读 | `GET /events?window=today` → `tomorrow` → `this_week` |
| 下周有哪些会 | 读 | `GET /events?window=next_week` |
| 最近七天 / 这个月 | 读 | `GET /events?window=next_7_days` / `this_month` |
| 某天下午干嘛 | 读 | `GET /events?from=<当日零点>&to=<次日零点>` |
| 找一下关于「论文」的日程 | 读 | `GET /events?q=论文` |
| 只看工作日历的安排 | 读 | `GET /calendars` 取 id → `GET /events?calendar_ids=<id>` |
| 我这几天的安排有没有撞车 | 读 | `GET /events/conflicts?window=next_7_days` |
| 帮我加个会/加个提醒/排个事 | 写 | `POST /events`（先 `dry_run=true`） |
| 把周三的会挪到周四 / 改时间 | 写 | `PATCH /events/{id}`（只传 `start`/`end`） |
| 改个标题 / 改地点 / 换个颜色 / 换个分组 | 写 | `PATCH /events/{id}`（只传该字段） |
| 把那条会删了 | 写 | `DELETE /events/{id}`（默认进回收站，必须逐条确认） |
| 把这几条一起改了 / 批量整理 | 写 | `POST /events/batch`（danger） |
| 我刚删错了，恢复一下 | 写 | `GET /events/trash` 找 id → `POST /events/{id}/restore` |
| 回收站里有什么 | 读 | `GET /events/trash` |
| 彻底删掉回收站里那条 | 写 | `DELETE /events/{id}/purge`（danger，不可恢复） |
| 清空回收站 | 写 | `POST /events/trash/empty`（danger，不可恢复） |
| 建个「工作」分组 / 把某分组隐藏 | 写 | `POST /calendars` / `PATCH /calendars/{id}` |
| 删掉某个分组 | 写 | `DELETE /calendars/{id}`（组内日程会迁入默认分组，不会一起消失） |
| 换个配色 / 用 12 小时制 / 周日起始 / 默认打开月视图 | 写 | `PUT /settings`（低风险，改完要告诉人类） |
| 重复日程 / 每周例会 | 不支持 | 当前没有重复规则，明确告知并建议替代方案（创建多条） |

映射原则：

- 能用 `window` 就不要自己算日期；必须给绝对区间时，用半开区间 `[from, to)`。
- 局部改动一律用 `PATCH`，不要用 `PUT`——`PUT` 要求 title/start/end 全传，容易误清空其他字段。
- 一次人类指令里含多个独立日程改动时才考虑 `batch`；否则逐个 `PATCH`，出错好定位。
- 需要分组信息时先 `GET /calendars`，用返回的 `meta.visibleIds` 判断哪些分组当前可见。

## 5. 写操作确认流程（按风险分级）

风险等级可以从 `GET /meta` 的 `endpoints[].riskLevel` 读到，这里是固定口径：

| 风险等级 | 接口 | 要求 |
| --- | --- | --- |
| safe | 所有 GET；`PUT /settings`；`POST /events/{id}/restore`；`POST /calendars`、`PATCH /calendars/{id}` | 自主执行，执行后回报即可 |
| confirm | `POST /events`、`PATCH`、`PUT /events/{id}`、`DELETE /events/{id}`、`DELETE /calendars/{id}` | 必须先 `dry_run=true`，把 `changes.before→after` 与 `warnings` 展示给人类，得到明确同意后再执行 |
| danger | `POST /events/batch`、`DELETE /events/{id}/purge`、`POST /events/trash/empty`、`DELETE /users/{id}` | 除 dry_run 外，还要逐条列出将受影响的对象（标题 + 时间 + id），说明"不可恢复"，等人类明确说"确认/可以/删吧" |

确认时用这样的格式展示：

```
准备执行 1 项改动：
· 新建「导师例会」2026-10-12 14:00–15:30（Asia/Shanghai）
⚠ 与「论文讨论」重叠 30 分钟
是否执行？
```

人类回答"再等等 / 先别 / 改一下"时，回到步骤 ③ 重新试运行，不要沿用上一次的 dry_run 结果直接写库。

## 6. 时间冲突处理

1. 写操作前（dry_run）与写操作后都会返回 `warnings`。出现 `TIME_CONFLICT` 时必须如实告知人类，包括冲突对象标题、时间与重叠分钟数，不要省略，也不要淡化成"可能有点冲突"。
2. 默认策略 `on_conflict=allow`：照写加警告。只有人类明确要求"撞车就不要建"时才用 `on_conflict=reject`（此时服务端返回 409 `CONFLICT_REJECTED`）。
3. 不要为了消除冲突而自行移动、缩短或删除任何既有日程。把可选方案交给人类选：
   - 换个不冲突的时间（给出 2–3 个候选）
   - 照原计划创建，接受重叠
   - 先不动，等人类决定

## 7. 重复日程处理

- 出现 `DUPLICATE_SUSPECTED`（同标题加同起止）时，先 `GET /events?q=<标题>` 核实，把候选列给人类，由人类判断是重复创建还是确需两条。
- 不要自行合并、去重或删除疑似重复项。
- 人类确认是误重复后，走单条 `DELETE` 并逐条确认（confirm / danger 流程）。
- 幂等键（`Idempotency-Key`）是用来防止自己重试造成重复的，不用于人类确认过的重复创建；每次新意图生成新键。

## 8. 回收站规则

删除默认是软删除：日程移入回收站，`deletedAt` 有值，不再出现在正常列表与冲突检测里。

- `GET /events` 只看正常日程；`GET /events/trash` 只看回收站；`GET /events?deleted=true` 等价于后者。
- 恢复用 `POST /events/{id}/restore`（safe，自主执行，但执行后要回报）。
- 彻底删除用 `DELETE /events/{id}/purge`；清空用 `POST /events/trash/empty`。二者不可恢复，按 danger 流程处理，且必须先用 `?dry_run=true` 拿到将删除的条数并展示给人类。
- 人类没明确要求时，不要清空回收站或彻底删除任何条目。
- 人类说"删掉"时默认理解为软删除（进回收站）；不要自作主张改成彻底删除，除非他明确说"彻底删掉/清空/不要了"。
- 人类说"我删错了"时，第一步永远是查回收站，而不是重新创建一条。

## 9. 日历分组规则

- 每个用户至少有且仅有一个 `isDefault: true` 的分组（默认名为「默认日历」），它不可删除。
- 新建日程时的 `calendarId`：人类指定了就用；没指定就省略该字段，让服务端落到默认分组。不要自己猜一个 id。
- `calendarId` 必须属于当前令牌对应的用户，否则返回 `403 FORBIDDEN`。（当前版本不支持共享日历，看到别的用户的 id 时不要尝试使用。）
- `visible: false` 的分组只是界面隐藏，数据还在。不要因为"看不见"就认为该分组可以删除。
- 删除分组时组内日程会自动迁入默认分组，返回的 `meta` 里带 `movedEvents` 条数，要把这个数字如实告诉人类。

## 10. 批量操作限制

- 单次最多 50 条（以 `/meta` 返回的 `limits.maxBatchSize` 为准）。超出必须拆批，并告知人类分几批。
- 批量必须先整批 `dry_run=true`，展示逐条结果后取得同意。
- 需要"要么全成功要么全不改"时加 `atomic: true`（先全量预检，失败整批回滚）；否则默认逐条执行、逐条返回结果。
- 批量里的 `delete` 默认也是软删除；需要彻底删除时显式传 `mode: "hard"`，并按 danger 处理。
- 执行后必须汇报 `succeeded / failed`。有失败项要逐条给出 `error.code` 与 `error.hint`，并询问是否重试失败项。

## 11. 高风险操作（必须先征询人类同意，无例外）

1. 删除任何日程（含批量删除）。彻底删除或清空回收站属于最高风险。
2. 一次改动 5 条以上日程的批量操作。
3. 把日程移动到过去的时间，或修改已发生的日程。
4. 跨多日的时间调整（如整周平移）。
5. 人类未明确指定时间时，自行"挑一个合适的时间"并写入——必须先给出候选让人选。
6. 覆盖人类此前明确给定的字段（标题、地点、分组）；不确定就问，不要猜。
7. 任何删除全部日程、清空日历、重建数据库的请求——一律拒绝，并提醒先备份数据库文件。
8. 删除用户的请求——一律先要求人类明确二次确认。
9. 修改部署相关的一切（端口、反向代理、鉴权开关、进程管理、代码结构）——属于待确认范围，先问。
10. 创建/修改/删除用户、签发或吊销令牌——只报告方法，由人类自己操作。

## 12. 时间处理规则

- 一律输出带偏移的 RFC 3339：`2026-10-12T14:00:00+08:00`。不带偏移时由服务端按配置时区解释，具体值可在 `/meta` 的 `timezone` 读到，不要假设。
- 人类说"下午三点"就写 `15:00:00+08:00`；说"周三"就先算准日期，再在回执里复述完整日期让人核对。
- 全天日程传 `allDay: true`，`end` 只写日期即可（服务端会归一化为 00:00:00–23:59:59）。
- `end` 必须晚于 `start`；不跨天时不要把 `end` 写成次日。
- 跨时区日程显式传 `timezone`（IANA 名，如 `America/Sao_Paulo`）。
- 查询参数同时接受 `snake_case` 与 `camelCase`（`dry_run` 与 `dryRun` 等价）。

## 13. 错误处理

| code | 处理方式 |
| --- | --- |
| `UNAUTHORIZED` | 停止调用，向人类索要有效令牌；不要重试、不要绕过 |
| `FORBIDDEN` | 操作用到了不属于自己的资源（如他人的 `calendarId`）或权限不足；说明原因，不要换令牌硬试 |
| `VALIDATION_FAILED` | 读 `error.details` 逐项修正请求体后重试（最多 2 次，仍失败则报告人类） |
| `INVALID_REQUEST` | 按 `error.hint` 修正（常见：`end <= start`、删默认分组） |
| `NOT_FOUND` | 重新 `GET /events` 或 `GET /events/trash` 取最新 id，不要用记忆中的 id |
| `ALREADY_EXISTS` | 用户名重复之类；换一个值 |
| `VERSION_CONFLICT` | 重新读取取最新 `version` 重试，或去掉 `If-Match`；并发改动要提示人类 |
| `CONFLICT_REJECTED` | 回到第 6 节，把冲突项交给人类 |
| `LAST_ADMIN` | 不允许移除最后一个管理员；提示人类先提升另一个账号 |
| `BATCH_TOO_LARGE` | 拆批 |
| 连接失败 | 提示人类服务未启动，并给出本地/服务器各自的启动方式 |

重试写操作时必须携带相同的 `Idempotency-Key`，避免网络重试造成重复创建。

## 14. 界面设置接口（人类提出外观偏好时用）

`GET /settings` 读取，`PUT /settings` 局部更新。字段如下：

- `theme`：`day` 白日 / `night` 黑夜，只有这两套，其余值会被拒
- `timeFormat`：`24-hour` / `12-hour`
- `firstDayOfWeek`：`monday` / `sunday`
- `defaultView`：`day` / `week` / `month` / `agenda`
- `sidebarOpen`：是否默认展开日历侧栏

这套设置按用户持久化在服务端，改完人类刷新页面即可生效。属于 safe 级，改完回报一下即可，不用逐步确认。

有一点容易混：日程的颜色（`color` 字段）和界面主题不是一回事。主题决定底板，`color` 决定单个日程块的颜色。人类说"这个块换成红色"时改的是日程的 `color`，不是 `theme`。

## 15. 回执要求

执行完向人类汇报时，要包含：

1. 做了什么（动作 + 对象标题 + 最终时间 + 分组）
2. `warnings` 里的全部提示（有冲突就写冲突）
3. 失败项与原因（如有）
4. 下一步建议（如需人类再确认的点）

不要只说"已帮你安排好了"。

## 16. 禁止事项

- 不要通过打开前端页面、截图或解析 DOM 获取日程数据，一律走接口。
- 不要在未经确认的情况下连续执行多个写操作。
- 不要为了让"看起来没冲突"而静默修改既有日程。
- 不要修改端口、部署配置、鉴权相关文件或数据库结构（属于待确认范围）。
- 不要把 `dryrun_` 前缀的临时 id 当作真实 id 使用或回写。
- 不要推测人类未说明的字段值；缺字段就问。
- 不要在任何输出里回显完整令牌。
