#!/usr/bin/env bash
#
# 从 GitHub 拉最新版本并在本机重新部署 —— 不需要本地上传，也不需要 git 工作副本。
#
# 为什么不用 git pull：
#   github.com 的 HTTPS 在很多网络环境里不通（git clone / git ls-remote 会超时），
#   但 api.github.com 与 codeload.github.com 通常是通的。所以这里改成：
#     1. 用 api.github.com 把「分支名 / tag / commit」解析成确切的 commit sha
#     2. 用 codeload.github.com 下载该 sha 的源码包
#     3. 交给 deploy/deploy.sh 走原有的构建安装流程
#   仓库公开时全程免鉴权，不需要在服务器上放任何密钥。
#
# 安全方面沿用了 update.sh 的前提：**代码归代码目录，数据归数据目录**
#   - 代码：APP_DIR（本脚本整体替换）
#   - 数据：DATA_DIR 下的 calendar.db（在代码目录之外，升级全程不碰，只备份）
#   任一步失败都会自动回滚到上一版本的代码。
#
# 用法（在服务器上执行，需 root）：
#   sudo bash /opt/morrow-calendar/deploy/update-from-github.sh          # 升到默认分支最新
#   sudo bash .../update-from-github.sh v0.3.0                           # 升到指定 tag / 分支 / commit
#   sudo bash .../update-from-github.sh --check                          # 只看有没有新版本，不装
#   sudo bash .../update-from-github.sh --force                          # 版本没变也重装一遍
#   sudo bash .../update-from-github.sh --no-backup                      # 跳过升级前备份（不建议）
#
# 装好之后可以用短命令（由本脚本配套安装）：
#   sudo morrow-update            # 等价于上面第一条
#   sudo morrow-update --check
#
set -euo pipefail

GITHUB_REPO="${GITHUB_REPO:-tianze-hou/morrow-calendar}"
APP_DIR="${APP_DIR:-/opt/morrow-calendar}"
DATA_DIR="${DATA_DIR:-/var/lib/morrow-calendar}"
PREV_DIR="${PREV_DIR:-/opt/morrow-calendar.prev}"
ENV_FILE="${ENV_FILE:-/etc/morrow-calendar.env}"
SERVICE_NAME="${SERVICE_NAME:-morrow-calendar}"
VERSION_FILE="$APP_DIR/.deploy-version"

TARGET_REF=""
DO_CHECK=0
DO_FORCE=0
DO_BACKUP=1
for arg in "$@"; do
  case "$arg" in
    --check)     DO_CHECK=1 ;;
    --force)     DO_FORCE=1 ;;
    --no-backup) DO_BACKUP=0 ;;
    -h|--help)   sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*)          printf '未知参数：%s\n' "$arg" >&2; exit 2 ;;
    *)           TARGET_REF="$arg" ;;
  esac
done

log()  { printf '\033[36m[更新]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[注意]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m[失败]\033[0m %s\n' "$*" >&2; exit 1; }

# 从 stdin 的 JSON 里取一个字段；服务器一定有 node，比依赖 jq / python 稳。
json_field() {
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const v=process.argv[1].split(".").reduce((o,k)=>o?.[k],j);console.log(v??"")})' "$1"
}

# ── 0. 数据库路径（优先读部署配置，保证与运行中的服务一致） ──────────
DB_PATH="${DB_PATH:-$DATA_DIR/calendar.db}"
if [ -r "$ENV_FILE" ]; then
  ENV_DB="$(grep -E '^DB_PATH=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)"
  [ -n "${ENV_DB:-}" ] && DB_PATH="$ENV_DB"
fi

# ── 1. 体检 ────────────────────────────────────────────────────
log "体检"
[ "$(id -u)" -eq 0 ] || die "需要 root 权限，请用 sudo 执行"
for c in node npm curl tar rsync; do
  command -v "$c" >/dev/null 2>&1 || die "未找到命令：$c"
done
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] || die "Node 需 22 或更高（当前 $(node -v)）"

# 数据文件绝不能落在代码目录里，否则替换代码目录时会把数据一起带走
case "$(cd "$(dirname "$DB_PATH")" 2>/dev/null && pwd)/$(basename "$DB_PATH")" in
  "$APP_DIR"/*) die "数据库位于代码目录内（$DB_PATH）。请先移到 $DATA_DIR，否则升级有丢数据风险" ;;
esac
log "数据库：$DB_PATH（在代码目录之外，升级不会改动）"

# ── 2. 解析远端版本 ────────────────────────────────────────────
log "查询 GitHub 上的版本（$GITHUB_REPO）"
api() { curl -fsS --max-time 20 "$1" 2>/dev/null; }

if [ -z "$TARGET_REF" ]; then
  # 未指定就跟随仓库的默认分支
  TARGET_REF="$(api "https://api.github.com/repos/$GITHUB_REPO" | json_field default_branch)"
  [ -n "$TARGET_REF" ] || die "无法从 api.github.com 读取仓库信息，请检查服务器到 GitHub 的连通性"
fi

if printf '%s' "$TARGET_REF" | grep -qE '^[0-9a-f]{40}$'; then
  TARGET_SHA="$TARGET_REF"
else
  TARGET_SHA="$(api "https://api.github.com/repos/$GITHUB_REPO/commits/$TARGET_REF" | json_field sha)"
fi
[ -n "$TARGET_SHA" ] || die "解析版本失败：$TARGET_REF（不存在，或无法访问 api.github.com）"

COMMIT_MSG="$(api "https://api.github.com/repos/$GITHUB_REPO/commits/$TARGET_SHA" | json_field commit.message)"
COMMIT_MSG="$(printf '%s' "$COMMIT_MSG" | head -1)"
log "远端版本：$TARGET_SHA（${COMMIT_MSG:-无提交信息}）"

# ── 3. 与本机版本比对 ──────────────────────────────────────────
CURRENT_SHA=""
[ -f "$VERSION_FILE" ] && CURRENT_SHA="$(sed -n 1p "$VERSION_FILE" 2>/dev/null || true)"

if [ "$CURRENT_SHA" = "$TARGET_SHA" ] && [ "$DO_FORCE" -eq 0 ]; then
  log "本机已是该版本，无需更新"
  exit 0
fi

if [ -n "$CURRENT_SHA" ]; then
  log "本机版本：$CURRENT_SHA → 将更新到 $TARGET_SHA"
else
  warn "本机未记录版本号（$VERSION_FILE 不存在），将直接部署远端版本"
fi

if [ "$DO_CHECK" -eq 1 ]; then
  log "（--check：只检查，不安装）"
  exit 0
fi

# ── 4. 备份数据库 ──────────────────────────────────────────────
if [ "$DO_BACKUP" -eq 1 ] && [ -f "$DB_PATH" ]; then
  log "备份数据库"
  if [ -f "$APP_DIR/deploy/backup.sh" ]; then
    bash "$APP_DIR/deploy/backup.sh" || die "备份失败，已中止升级（不冒险动生产数据）"
  else
    STAMP="$(date +%Y%m%d-%H%M%S)"
    mkdir -p /var/backups/morrow-calendar
    cp -a "$DB_PATH" "/var/backups/morrow-calendar/calendar.db.$STAMP"
    log "已备份到 /var/backups/morrow-calendar/calendar.db.$STAMP"
  fi
fi

# ── 5. 下载源码包 ──────────────────────────────────────────────
TMP="$(mktemp -d /tmp/morrow-update.XXXXXX)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

log "下载 $TARGET_SHA 的源码包"
if ! curl -fsSL --max-time 180 -o "$TMP/src.tgz" \
     "https://codeload.github.com/$GITHUB_REPO/tar.gz/$TARGET_SHA"; then
  die "下载失败。检查服务器能否访问 codeload.github.com"
fi
[ -s "$TMP/src.tgz" ] || die "下载到的源码包是空的"
tar tzf "$TMP/src.tgz" >/dev/null 2>&1 || die "源码包损坏（tar 解不开）"

mkdir -p "$TMP/src"
tar xzf "$TMP/src.tgz" -C "$TMP/src" --strip-components=1
[ -f "$TMP/src/deploy/deploy.sh" ] || die "源码包结构不对：缺少 deploy/deploy.sh"

# ── 6. 保存回滚点 ──────────────────────────────────────────────
# 只存源码，不存 node_modules（143M，且可由 package-lock 重建）
if [ -d "$APP_DIR" ]; then
  log "保存回滚点到 $PREV_DIR"
  rm -rf "$PREV_DIR"
  mkdir -p "$PREV_DIR"
  rsync -a --exclude 'node_modules' --exclude 'data' "$APP_DIR/" "$PREV_DIR/"
fi

# ── 7. 构建并安装 ──────────────────────────────────────────────
sync_source() { # $1 = 源目录
  rsync -a --delete \
    --exclude 'node_modules' --exclude 'data' --exclude '.deploy-version' \
    "$1/" "$APP_DIR/"
}

write_version() { # $1 = sha, $2 = ref
  mkdir -p "$APP_DIR"
  cat > "$VERSION_FILE" <<EOF
$1
ref: $2
updated: $(date '+%Y-%m-%d %H:%M:%S')
EOF
}

rollback() {
  warn "正在回滚到上一版本"
  if [ ! -f "$PREV_DIR/deploy/deploy.sh" ]; then
    die "回滚点不完整（$PREV_DIR/deploy/deploy.sh 缺失）。服务可能处于停止状态，请立即检查：journalctl -u $SERVICE_NAME -n 50"
  fi
  if bash "$PREV_DIR/deploy/deploy.sh"; then
    sync_source "$PREV_DIR" || true
    [ -n "$CURRENT_SHA" ] && write_version "$CURRENT_SHA" "rollback"
    log "已回滚到 $CURRENT_SHA"
  else
    die "回滚也失败了。请手动执行：bash $PREV_DIR/deploy/deploy.sh，并查看 journalctl -u $SERVICE_NAME -n 100"
  fi
}

log "构建并安装（npm ci + build，需要几分钟）"
if bash "$TMP/src/deploy/deploy.sh"; then
  log "新版本部署完成"
else
  warn "部署失败"
  rollback
  die "已回滚到上一版本，服务应已恢复。失败原因请看上面的输出"
fi

# ── 8. 收尾：源码同步到安装目录、写版本、修属主 ────────────────
log "同步源码并记录版本"
sync_source "$TMP/src"
write_version "$TARGET_SHA" "$TARGET_REF"

# 代码目录归运行用户，避免下次以 root 部署后服务读不到
SERVICE_USER="$(systemctl show -p User --value "$SERVICE_NAME" 2>/dev/null || echo morrow)"
[ -n "$SERVICE_USER" ] || SERVICE_USER=morrow
if id -u "$SERVICE_USER" >/dev/null 2>&1; then
  find "$APP_DIR" -mindepth 1 -maxdepth 1 ! -name 'node_modules' ! -name 'data' \
    -exec chown -R "$SERVICE_USER":"$SERVICE_USER" {} + 2>/dev/null || true
  [ -f "$VERSION_FILE" ] && chown "$SERVICE_USER":"$SERVICE_USER" "$VERSION_FILE" 2>/dev/null || true
fi

log "完成：$TARGET_SHA"
log "查看日志：journalctl -u $SERVICE_NAME -f"
