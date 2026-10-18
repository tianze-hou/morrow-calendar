# morrow calendar API 协议（面向 AI Agent）

> 版本 0.2.0。本文档以服务端 `GET /api/meta` 与 `GET /api/openapi.yaml` 为准，
> 下面是它们的展开版。第一次接触本服务的 Agent，只读 `/api/meta` 就能建立起完整心智模型；
> 只想要一份能直接贴进对话的简报，拉 `GET /api/agent.md` 即可。

## 0. 三十秒上手

```bash
BASE=https://<域名>/api

# 0) 想要一页式简报（Markdown，可直接贴给模型）
curl -s $BASE/agent.md

# 1) 先看服务怎么鉴权、有哪些能力
curl -s $BASE/meta

# 2) 带令牌调用（多用户模式必需；本地单人模式可省略）
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/events?window=today"

# 3) 写之前先试运行，确认没问题再真写
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  "$BASE/events?dry_run=true" \
  -d '{"title":"导师例会","start":"2026-10-12T14:00:00+08:00","end":"2026-10-12T15:30:00+08:00"}'
```

## 1. 鉴权

`GET /api/meta` 的 `authentication.required` 有两种取值：

| 值 | 含义 |
| --- | --- |
| `false` | 服务以 `AUTH_ENABLED=false` 运行（本机单人），无需任何凭据，所有数据归属内置的 `local` 账号。 |
| `true` | 多用户模式。除下列公开端点外，所有请求都必须带凭据，否则返回 `401 UNAUTHORIZED`。 |

公开端点（无需鉴权）：`GET /api`、`GET /api/meta`、`GET /api/agent.md`、`GET /api/health`、`GET /api/openapi.yaml`、`GET /api/auth/status`、`POST /api/auth/login`、`POST /api/auth/logout`、`GET /api/setup/status`、`POST /api/setup/admin`。

后两个属于初始化引导，只在实例还没有任何用户时真正可用；详见 4.7。

带凭据的两种方式：

| 方式 | 写法 | 适用 |
| --- | --- | --- |
| API 令牌 | `Authorization: Bearer <token>`（也接受 `X-API-Token: <token>`） | 推荐给 AI Agent。长期有效、可单独吊销、与浏览器会话互不影响。 |
| 会话 cookie | 登录后服务端自动下发 `morrow_session`（HttpOnly） | 浏览器。 |

令牌的来源有两种：人类在网页「设置 → API 令牌」里创建后把明文复制给你，或由管理员在服务器执行 `npm run token -- --user <用户名> --name "<备注>" [--ttl 365]`。

明文只在创建那一刻返回一次，服务端只存 SHA-256。收到 `401` 时向人类索要新令牌，不要重试或绕过。

## 2. 响应信封与错误

成功：

```json
{ "ok": true, "data": <结果>, "meta": { "...": "计数、范围、来源等上下文" } }
```

失败：

```json
{
  "ok": false,
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "请求体校验失败",
    "details": [{ "field": "end", "message": "时间不能为空" }],
    "hint": "按 details 里的字段修正后重试。"
  }
}
```

`code` 是可以分支处理的稳定枚举（见 `/meta` 的 `enums.errorCodes`）：

| code | HTTP | 含义与处置 |
| --- | --- | --- |
| `UNAUTHORIZED` | 401 | 未登录 / 令牌无效 / 已吊销。索要令牌，不要重试。 |
| `FORBIDDEN` | 403 | 权限不足，或引用了不属于自己的资源（如他人的 `calendarId`）。 |
| `NOT_FOUND` | 404 | 目标不存在（含"存在但不属于你"的情况，不泄漏他人数据是否存在）。 |
| `ALREADY_EXISTS` | 409 | 唯一约束冲突（用户名重复等）。 |
| `VALIDATION_FAILED` | 400 | 字段级校验失败，按 `details` 逐个改。 |
| `INVALID_REQUEST` | 400 | 语义错误（`end <= start`、删默认分组等），看 `hint`。 |
| `VERSION_CONFLICT` | 409 | 乐观锁失败，重取最新 `version`。 |
| `CONFLICT_REJECTED` | 409 | `on_conflict=reject` 且检出了时间冲突。 |
| `LAST_ADMIN` | 409 | 不允许移除最后一个管理员。 |
| `BATCH_TOO_LARGE` | 400 | 批量超限，拆批。 |
| `IDEMPOTENCY_KEY_REUSED` | 409 | 幂等键被用于不同内容。 |
| `INTERNAL_ERROR` | 500 | 服务端异常，看服务日志。 |

## 3. 核心概念

### 3.1 身份与数据隔离

多用户模式下，每个令牌绑定一个用户，所有数据（日程、日历分组、界面设置）按用户隔离。
访问他人资源的 id 一律返回 `404` 而不是 `403`，避免接口被拿来枚举他人数据。

### 3.2 时间

- 一律用带时区偏移的 RFC 3339：`2026-10-12T14:00:00+08:00`。
- 不带偏移时按服务端时区解释，具体值见 `/meta` 的 `timezone`，不要凭空假设。
- 全天日程传 `allDay: true`，`end` 只写日期，服务端会归一化为 `00:00:00 – 23:59:59`。
- 查询区间是半开区间 `[from, to)`，判定条件是"日程与区间有交集"。

### 3.3 相对时间窗口 `window`

不用自己算日期边界：

| 值 | 含义 |
| --- | --- |
| `today` / `tomorrow` / `yesterday` | 当天 / 次日 / 前一日 00:00–24:00 |
| `this_week` / `next_week` | 本周 / 下周（周一为一周起点） |
| `this_month` | 本月 |
| `next_7_days` / `next_30_days` | 从今天起 7 / 30 天 |

`from`/`to` 与 `window` 同时出现时，以 `from`/`to` 为准。响应里的 `meta.resolvedRange` 会回显最终生效的区间与来源（`explicit` / `window` / `none`）。

### 3.4 软删除与回收站

删除默认是软删除：日程打上 `deletedAt`，从正常列表与冲突检测中消失，但仍可恢复。

- `GET /events` → 只看正常日程
- `GET /events/trash`（等价 `GET /events?deleted=true`）→ 只看回收站
- `POST /events/{id}/restore` → 恢复
- `DELETE /events/{id}?mode=hard`、`DELETE /events/{id}/purge`、`POST /events/trash/empty` → 不可恢复

### 3.5 日历分组

每个用户恰有一个 `isDefault: true` 的分组，不可删除。日程通过 `calendarId` 归属分组。

- 新建日程不传 `calendarId` 就会落到默认分组，这是推荐写法。
- 传了不属于自己的 id 会返回 `403 FORBIDDEN`，不会静默改写，免得 AI 误判写入位置。
- 删除分组时组内日程迁入默认分组，响应里的 `meta.movedEvents` 给出条数。

## 4. 接口清单

风险等级来自 `/meta` 的 `endpoints[].riskLevel`：`safe` 可直接执行；`confirm` 需先 dry_run 并经人类同意；`danger` 需逐条列出影响并经人类明确确认。

### 4.1 服务自描述

| 方法 | 路径 | 说明 | 风险 | 需鉴权 |
| --- | --- | --- | --- | --- |
| GET | `/meta` | 鉴权方式 + 能力 + 枚举 + 限制 + 端点清单 + 上手序列 + `agentPrompt` | safe | 否 |
| GET | `/agent.md` | 一页式简报（Markdown），由 `/meta` 同源生成 | safe | 否 |
| GET | `/health` | 健康检查与存储信息（含 `setupRequired`） | safe | 否 |
| GET | `/openapi.yaml` | OpenAPI 3 文档 | safe | 否 |

`/meta` 里几处专为 Agent 准备的字段：

| 字段 | 用途 |
| --- | --- |
| `quickstart[]` | 最小上手序列，`{ step, request, note }`。照抄即可跑通一次读写，省去通读文档。 |
| `agentPrompt` | 一段可直接塞进系统提示的自描述文本，语气与措辞已经调好。 |
| `onboarding` | `{ required, endpoint, description }`。`required: true` 表示该实例尚未初始化，Agent 不能也不会代劳。 |
| `endpoints[].riskLevel` | `safe` / `confirm` / `danger`，让 Agent 决定哪些自主执行、哪些必须问人。 |

### 4.2 鉴权与账号

| 方法 | 路径 | 说明 | 风险 | 需鉴权 |
| --- | --- | --- | --- | --- |
| GET | `/auth/status` | 是否已登录、当前身份 | safe | 否 |
| POST | `/auth/login` | 口令登录，下发会话 cookie | safe | 否 |
| POST | `/auth/logout` | 退出登录 | safe | 否 |
| GET | `/auth/me` | 读取当前用户 | safe | 是 |
| PUT | `/auth/password` | 修改本人口令 | confirm | 是 |
| GET | `/users` | 用户列表（管理员看全部，普通用户只看自己） | safe | 是 |
| POST | `/users` | 创建用户（仅管理员） | confirm | 是 |
| PATCH | `/users/{id}` | 改资料 / 口令 / 角色 / 停用（仅管理员） | danger | 是 |
| DELETE | `/users/{id}` | 删除用户及其全部数据（仅管理员，不能删自己） | danger | 是 |

### 4.3 API 令牌

| 方法 | 路径 | 说明 | 风险 | 需鉴权 |
| --- | --- | --- | --- | --- |
| GET | `/tokens` | 列出本人的令牌（永不含明文） | safe | 是 |
| POST | `/tokens` | 创建令牌，明文仅此一次 | confirm | 是 |
| POST | `/tokens/{id}/revoke` | 吊销（保留审计记录） | confirm | 是 |
| DELETE | `/tokens/{id}` | 彻底删除记录 | danger | 是 |

### 4.4 日历分组

| 方法 | 路径 | 说明 | 风险 | 需鉴权 |
| --- | --- | --- | --- | --- |
| GET | `/calendars` | 列出本人的分组 | safe | 是 |
| POST | `/calendars` | 新建分组 | safe | 是 |
| PATCH | `/calendars/{id}` | 改名 / 换色 / 切换可见性 / 排序 | safe | 是 |
| DELETE | `/calendars/{id}` | 删除分组（组内日程迁入默认分组） | confirm | 是 |

### 4.5 界面设置

| 方法 | 路径 | 说明 | 风险 | 需鉴权 |
| --- | --- | --- | --- | --- |
| GET | `/settings` | 读取本人设置 | safe | 是 |
| PUT | `/settings` | 局部更新 | safe | 是 |
| POST | `/settings/reset` | 恢复出厂设置（只影响本人） | safe | 是 |

### 4.6 日程

| 方法 | 路径 | 说明 | 风险 | 需鉴权 |
| --- | --- | --- | --- | --- |
| GET | `/events` | 按时间 / 分组 / 关键词查询 | safe | 是 |
| GET | `/events/trash` | 回收站列表 | safe | 是 |
| GET | `/events/conflicts` | 扫描区间内互相重叠的日程 | safe | 是 |
| GET | `/events/{id}` | 读取单条 | safe | 是 |
| POST | `/events` | 创建 | confirm | 是 |
| PATCH | `/events/{id}` | 局部更新 | confirm | 是 |
| PUT | `/events/{id}` | 完整替换（title/start/end 必填） | confirm | 是 |
| POST | `/events/{id}/restore` | 从回收站恢复 | safe | 是 |
| DELETE | `/events/{id}` | 删除（默认软删除，`?mode=hard` 彻底删除） | confirm | 是 |
| DELETE | `/events/{id}/purge` | 从回收站彻底删除 | danger | 是 |
| POST | `/events/trash/empty` | 清空回收站 | danger | 是 |
| POST | `/events/batch` | 批量增改删（≤50，支持 dry_run / atomic） | danger | 是 |

### 4.7 初始化引导

只在「库里一个用户都没有」时可用。首个管理员由人在浏览器里创建，服务端不擅自建号，也不打印一次性口令。两个接口都是公开端点——它们服务的对象本来就是「还没有任何身份」的人，真正的闸门是服务端那道「零用户才放行」的判定。

| 方法 | 路径 | 说明 | 风险 | 需鉴权 |
| --- | --- | --- | --- | --- |
| GET | `/setup/status` | `{ needsSetup, authRequired, suggestedUsername, service, version }` | safe | 否 |
| POST | `/setup/admin` | 创建首个管理员，成功即下发会话 cookie（等同登录） | confirm | 否 |

- 入参：`{ username, password, displayName? }`，与创建用户同一套校验（用户名 3–32 位、口令 ≥ 8 位）。
- 一旦库里存在任何用户，`POST /setup/admin` 返回 `409 ALREADY_EXISTS`；已初始化的实例上 `/meta` 的 `onboarding.required` 为 `false`。
- Agent 遇到 `onboarding.required: true` 时，正确做法是提示人类去打开网页完成初始化，而不是尝试代劳——首个管理员的凭据只应来自人。

### 4.8 导出

| 方法 | 路径 | 说明 | 风险 | 需鉴权 |
| --- | --- | --- | --- | --- |
| GET | `/export/events.ics` | 导出为 iCalendar，返回 `text/calendar` | safe | 是 |

参数与 `/events` 的查询一致，另外多一个 `ids`：

| 参数 | 说明 |
| --- | --- |
| `from` / `to` / `window` | 导出区间；都不传就是全部 |
| `calendar_id` | 只导某个分组。日历名与文件名会跟着用分组名，导进手机后能看出这是哪一组 |
| `ids` | 逗号分隔的日程 id。传了就只导这几条，区间参数被忽略 |

两个响应头值得注意：`X-Event-Count` 直接给出条数（不必解析文件就能核对），`Content-Disposition` 同时写了 ASCII 兜底的 `filename=` 与 RFC 5987 的 `filename*=UTF-8''`，所以中文分组名不会变成乱码。

文件本身有几处是刻意这么写的：

- **定时日程一律 UTC**，不带 `TZID`。带时区名的写法则要求客户端认得那个名字，认不出就整条落错位置；UTC 是绝对时刻，没有这个前提。`X-WR-TIMEZONE` 只影响客户端默认按哪个时区展示，不参与换算。
- **全天日程用 `VALUE=DATE`**，`DTEND` 是开区间（不含当天）。库里存的是 `00:00:00–23:59:59` 的闭区间，导出时已自动加一天，否则导进别家日历会少一天。
- **按 75 个八位组折行**，切点按码点算。按字节切会把一个汉字劈成两半，客户端解出来就是乱码。
- 颜色写在非标准的 `X-MORROW-COLOR` 里，分组名写在 `CATEGORIES` 里。别家日历会忽略前者，将来自己做导入时可以原样还原。

## 5. 写操作的三个通用开关

任意写接口（POST/PATCH/PUT/DELETE）都支持这些查询参数：

| 参数 | 取值 | 作用 |
| --- | --- | --- |
| `dry_run` / `dryRun` | `true` / `false` | 试运行：走完整逻辑（含校验、冲突检测、越权检查），但不落库。返回体里 `dryRun: true`，`result` 是投影对象（id 以 `dryrun_` 开头）。 |
| `on_conflict` | `allow`（默认）/ `reject` | `allow` 照写并返回 `TIME_CONFLICT` 警告；`reject` 检出冲突直接返回 `409 CONFLICT_REJECTED`。 |
| `mode` | `soft`（默认）/ `hard` | 仅删除类接口：进回收站 / 彻底删除。 |

幂等：`POST /events` 支持 `Idempotency-Key` 请求头（也接受 `X-Idempotency-Key`）。同用户加同键重复提交会直接返回首次结果，并在 `meta.idempotentReplay: true` 标出。网络重试必须复用同一个键。

查询参数命名：`snake_case` 与 `camelCase` 都接受（`dry_run` ≡ `dryRun`，`calendar_ids` ≡ `calendarIds`）。

写操作返回体（`WriteResult`）：

```json
{
  "dryRun": false,
  "result": { "id": "evt_…", "…": "…" },
  "changes": { "before": null, "after": { "…": "…" } },
  "warnings": [
    { "code": "TIME_CONFLICT", "message": "与 1 条日程时间重叠",
      "conflicts": [{ "eventId": "evt_…", "title": "论文讨论", "start": "…", "end": "…", "overlapMinutes": 30 }] }
  ]
}
```

`warnings[].code` 取值：`TIME_CONFLICT`、`DUPLICATE_SUSPECTED`、`NO_CHANGE`、`NOT_DELETED`、`DELETE_MODE`。

## 6. 字段参考

### 6.1 `ScheduleEvent`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 服务端生成，`evt_` 前缀 |
| `ownerId` | string | 归属用户 |
| `title` | string | 必填，≤200 字 |
| `start` / `end` | string | RFC 3339 带偏移；`end` 必须晚于 `start` |
| `allDay` | boolean | 全天日程 |
| `description` / `location` | string? | 备注 ≤4000 / 地点 ≤200 |
| `color` | enum? | `blue green red yellow purple pink indigo gray` |
| `calendarId` | string | 归属分组 |
| `timezone` | string | IANA 名 |
| `rrule` / `exdates` | null / array | 预留字段，当前恒为 `null` / `[]`，重复日程尚未实现 |
| `deletedAt` | string? | 非空表示在回收站 |
| `version` | number | 乐观锁版本，每次写入 +1 |
| `createdAt` / `updatedAt` | string | 服务端维护 |

### 6.2 `CalendarGroup`

`id` · `ownerId` · `name`(≤40) · `color` · `visible` · `sortOrder` · `isDefault` · `memberCount`(预留) · `createdAt` · `updatedAt`

### 6.3 `AppSettings`

| 字段 | 取值 |
| --- | --- |
| `theme` | `day`（白日）/ `night`（黑夜），只有这两套 |
| `timeFormat` | `24-hour` / `12-hour` |
| `firstDayOfWeek` | `monday` / `sunday` |
| `defaultView` | `day` / `week` / `month` / `agenda` |
| `sidebarOpen` | boolean |

### 6.4 `ApiToken`

`id` · `name` · `prefix`（可展示的前 12 位） · `createdAt` · `lastUsedAt` · `expiresAt` · `revoked`
创建响应额外带 `token` 字段（明文，仅此一次）。

## 7. 查询日程

`GET /api/events`

| 参数 | 说明 |
| --- | --- |
| `from` / `to` | 绝对区间（半开），优先级高于 `window` |
| `window` | 相对窗口，见 3.3 |
| `q` | 标题 / 备注 / 地点模糊搜索 |
| `calendarId` | 单个分组 |
| `calendar_ids` | 逗号分隔的多个分组；显式传空串表示"没有可见分组"，返回空集 |
| `deleted` | `true` 只看回收站 |
| `limit` / `offset` | 分页，`limit` 上限 500，默认 200 |
| `order` | `asc`（默认，按开始时间）/ `desc` |

响应 `meta` 含：`count`、`total`、`limit`、`offset`、`timezone`、`scope.ownerId`、`scope.deleted`、`resolvedRange`。

## 8. 批量操作

`POST /api/events/batch`

```json
{
  "dryRun": true,
  "atomic": false,
  "onConflict": "allow",
  "operations": [
    { "op": "create", "idempotencyKey": "batch-1", "data": { "title": "A", "start": "…", "end": "…" } },
    { "op": "update", "id": "evt_…", "data": { "location": "图书馆" } },
    { "op": "delete", "id": "evt_…", "mode": "soft" }
  ]
}
```

- `operations` 上限 50（`/meta` 的 `limits.maxBatchSize`）。
- `atomic: true` → 先全量预检，任一不通过则整批回滚（返回错误，不执行任何一条）。
- `atomic: false`（默认）→ 逐条执行，逐条返回 `{ index, op, ok, data | error }`。
- 响应 `meta`：`requested` / `succeeded` / `failed` / `dryRun` / `atomic`。

## 9. 典型调用序列

```bash
BASE=https://<域名>/api
H="Authorization: Bearer $TOKEN"

# 看今天
curl -s -H "$H" "$BASE/events?window=today"

# 建一条：先试运行
curl -s -X POST -H "$H" -H 'content-type: application/json' "$BASE/events?dry_run=true" \
  -d '{"title":"选题会","start":"2026-10-15T10:00:00+08:00","end":"2026-10-15T12:00:00+08:00"}'

# 确认无误后正式创建（带幂等键防重试重复）
curl -s -X POST -H "$H" -H 'content-type: application/json' -H 'Idempotency-Key: pick-topic-1' \
  "$BASE/events" -d '{"title":"选题会","start":"2026-10-15T10:00:00+08:00","end":"2026-10-15T12:00:00+08:00"}'

# 改到下午（只传要改的字段）
curl -s -X PATCH -H "$H" -H 'content-type: application/json' "$BASE/events/evt_xxx" \
  -d '{"start":"2026-10-15T14:00:00+08:00","end":"2026-10-15T16:00:00+08:00"}'

# 删了（进回收站）
curl -s -X DELETE -H "$H" "$BASE/events/evt_xxx"

# 删错了 → 从回收站找回来
curl -s -H "$H" "$BASE/events/trash"
curl -s -X POST -H "$H" "$BASE/events/evt_xxx/restore"

# 分组
curl -s -H "$H" "$BASE/calendars"
curl -s -X POST -H "$H" -H 'content-type: application/json' "$BASE/calendars" -d '{"name":"工作","color":"green"}'
```

## 10. 当前不提供的能力

| 能力 | 状态 |
| --- | --- |
| 重复日程（RRULE） | 未实现，`rrule` / `exdates` 字段已预留且恒为空。需要重复日程时先创建多条。 |
| 日历共享 / 团队成员 | 未实现，每个用户的日历彼此不可见；数据模型已为将来的成员表留位。 |
| 日程提醒 / 通知 | 未实现 |
| 附件 | 未实现 |
| .ics 导入 | 未实现。导出已支持（见 4.8）；导入要先定字段映射与重复判定，打算走 `dry_run` 先给预览。 |
| 用户自行注册 | 未实现，账号只能由管理员创建。首个管理员经初始化引导产生，不属于自助注册。 |
