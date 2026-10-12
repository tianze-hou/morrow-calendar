#!/usr/bin/env bash
#
# morrow calendar 安全升级脚本（systemd 版）。
#
# 前提是这套项目从一开始就守着一条线：**代码归 git，数据归数据目录**。
#   - 代码：本脚本所在的工作副本（可随时 git pull / checkout）
#   - 数据：DATA_DIR 下的 calendar.db（在代码目录之外，升级永远不碰）
# 因此「同步代码」和「保住数据」是两件互不干扰的事，升级才可能做到既简单又安全。
#
# 脚本按顺序做这些事：
#   1. 体检：node / npm / git 版本、工作副本是否干净、数据库是否确实在代码目录之外
#   2. 记下当前版本，作为回滚点
#   3. 先备份数据库（SQLite .backup，服务运行中执行也安全）
#   4. 拉取目标版本（tag / 分支 / commit；缺省 = 当前分支的远端最新）
#   5. 调 deploy/deploy.sh：装依赖、构建、安装、重启、健康检查
#   6. 第 4 步之后任一步失败 → 自动切回上一个版本重新部署一次；数据全程不动
#
# 用法（在仓库工作副本里执行）：
#   sudo bash deploy/update.sh                # 升级到当前分支的远端最新
#   sudo bash deploy/update.sh v0.3.0         # 升级到指定 tag / 分支 / commit
#   sudo bash deploy/update.sh --no-pull      # 不拉代码，只按当前代码重新部署
#   sudo bash deploy/update.sh --no-backup    # 跳过升级前备份（不建议）
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${DATA_DIR:-/var/lib/morrow-calendar}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/morrow-calendar}"
ENV_FILE="${ENV_FILE:-/etc/morrow-calendar.env}"

TARGET_REF=""
DO_PULL=1
DO_BACKUP=1
for arg in "$@"; do
  case "$arg" in
    --no-pull)   DO_PULL=0 ;;
    --no-backup) DO_BACKUP=0 ;;
    -h|--help)   sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*)          printf '未知参数：%s\n' "$arg" >&2; exit 2 ;;
    *)           TARGET_REF="$arg" ;;
  esac
done

log()  { printf '\033[36m[升级]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[注意]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m[失败]\033[0m %s\n' "$*" >&2; exit 1; }

# ── 0. 数据库路径（优先读部署配置，保证与运行中的服务一致） ──────
DB_PATH="${DB_PATH:-$DATA_DIR/calendar.db}"
if [ -r "$ENV_FILE" ]; then
  ENV_DB="$(grep -E '^DB_PATH=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)"
  [ -n "${ENV_DB:-}" ] && DB_PATH="$ENV_DB"
fi

# ── 1. 体检 ────────────────────────────────────────────────────
log "体检"
command -v node >/dev/null 2>&1 || die "未找到 node"
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] || die "Node 需 22 或更高（当前 $(node -v)）"
command -v npm >/dev/null 2>&1 || die "未找到 npm"
command -v git >/dev/null 2>&1 || die "未找到 git"
[ -f "$REPO_DIR/deploy/deploy.sh" ] || die "找不到 deploy/deploy.sh，请在仓库工作副本里运行本脚本"

# 最关键的一条断言：数据文件绝不能落在代码目录里。
# 只要它在外面，git 怎么折腾都伤不到数据。
case "$(cd "$(dirname "$DB_PATH")" 2>/dev/null && pwd)/$(basename "$DB_PATH")" in
  "$REPO_DIR"/*) die "数据库位于代码目录内（$DB_PATH）。请先把它移到 $DATA_DIR，否则升级有丢数据的风险" ;;
esac
log "数据库：$DB_PATH（在代码目录之外，升级不会改动）"

if [ -d "$REPO_DIR/.git" ]; then
  # 工作副本有未提交改动时拒绝升级：否则 checkout 会失败，或把改动带进生产
  if [ -n "$(git -C "$REPO_DIR" status --porcelain)" ]; then
    die "工作副本有未提交的改动，请先提交或 git stash 后再升级"
  fi
else
  warn "$REPO_DIR 不是 git 工作副本，将只做构建部署（等同 --no-pull）"
  DO_PULL=0
fi

# ── 2. 回滚点 ──────────────────────────────────────────────────
PREV_REF=""
if [ "$DO_PULL" = 1 ]; then
  PREV_REF="$(git -C "$REPO_DIR" rev-parse HEAD)"
  log "当前版本：$(git -C "$REPO_DIR" describe --tags --always 2>/dev/null || echo "$PREV_REF")"
fi

# ── 3. 升级前备份 ──────────────────────────────────────────────
if [ "$DO_BACKUP" = 1 ] && [ -f "$DB_PATH" ]; then
  log "备份数据库"
  mkdir -p "$BACKUP_DIR"
  STAMP="$(date +%Y%m%d-%H%M%S)"
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$DB_PATH" ".backup '${BACKUP_DIR}/calendar-preupdate-${STAMP}.db'"
  else
    node -e "
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec(\"VACUUM INTO '\" + process.argv[2] + \"'\");
      db.close();
    " "$DB_PATH" "${BACKUP_DIR}/calendar-preupdate-${STAMP}.db"
  fi
  gzip -f "${BACKUP_DIR}/calendar-preupdate-${STAMP}.db"
  log "备份完成：${BACKUP_DIR}/calendar-preupdate-${STAMP}.db.gz"
elif [ "$DO_BACKUP" = 1 ]; then
  warn "还没有数据库文件（首次部署？），跳过备份"
fi

# ── 4. 拉取目标版本 ────────────────────────────────────────────
if [ "$DO_PULL" = 1 ]; then
  log "拉取代码"
  git -C "$REPO_DIR" fetch --tags --prune origin
  if [ -n "$TARGET_REF" ]; then
    git -C "$REPO_DIR" checkout --quiet "$TARGET_REF" || die "找不到目标版本：$TARGET_REF"
    log "已切到 $TARGET_REF"
  else
    BRANCH="$(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD)"
    git -C "$REPO_DIR" merge --ff-only "origin/$BRANCH" \
      || die "无法快进到 origin/$BRANCH（本地与远端已分叉，请先人工处理）"
    log "已快进到 origin/$BRANCH"
  fi
fi

# ── 5. 部署（含构建、重启、健康检查） ──────────────────────────
run_deploy() { bash "$REPO_DIR/deploy/deploy.sh"; }

if run_deploy; then
  log "升级完成：$(git -C "$REPO_DIR" describe --tags --always 2>/dev/null || echo '当前代码')"
  log "数据库未改动；如需回退，可执行：sudo bash deploy/update.sh ${PREV_REF:-<上一个版本>}"
  exit 0
fi

# ── 6. 失败回滚 ────────────────────────────────────────────────
if [ -z "$PREV_REF" ]; then
  die "部署失败，且没有可回滚的版本记录。请查看：journalctl -u morrow-calendar -n 100"
fi

warn "新版本部署失败，回滚到上一个版本 $PREV_REF"
set +e
git -C "$REPO_DIR" checkout --quiet "$PREV_REF"
run_deploy
ROLLBACK_STATUS=$?
set -e
if [ "$ROLLBACK_STATUS" -eq 0 ]; then
  die "已回滚到上一个版本并恢复服务。数据未受影响，升级前备份见 $BACKUP_DIR"
fi
die "回滚也没能成功，需要人工介入：journalctl -u morrow-calendar -n 200"
