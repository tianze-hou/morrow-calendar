# 参与开发

欢迎提 issue 和 PR。在动手之前，有几条约定希望你先看一眼。

## 开发环境

需要 Node 22 或更高版本。

```bash
npm install
npm run dev      # 后端 8787 + 前端 5173
```

提交 PR 前请至少跑通：

```bash
npm run typecheck    # 全量类型检查
npm run smoke        # 端到端自测，会起一个临时库并把结果打印出来
```

## 代码约定

- 用 TypeScript，`strict` 已开，不要用 `any` 绕过去。确实需要时写明理由。
- 前端与后端共用的类型一律放进 `shared/types.ts`，不要各写一份。
- SQL 只写在 `server/src/repository/` 里；路由层不要直接碰数据库。
- 对外的字段、错误码、枚举以 `shared/types.ts` 和 `docs/openapi.yaml` 为准，改一处要同步另一处。
- 注释写「为什么」，不写「是什么」。一眼能看懂的代码就不用注释。

## 提交信息

用中文或英文都行，但一条提交只说一件事。格式建议：

```
模块: 做了什么

需要时补一句为什么这么做。关联的 issue 用 #123 引用。
```

## 数据库变更

表结构改动走 `server/src/db/index.ts` 里的迁移机制，按 `user_version` 递增。
不要直接改已有迁移，追加新版本；旧库升级要能自动跑通，不需要人工干预。

## 许可证

本项目采用 AGPL-3.0。提交 PR 即表示你同意以同一许可证发布你的贡献。
