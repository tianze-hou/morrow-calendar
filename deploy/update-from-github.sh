#!/usr/bin/env bash
#
# 从 GitHub 拉最新版本并在服务器上重新部署 —— 不需要本地打包上传，也不需要 git 工作副本。
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
#   sudo morrow-update                  # 升到默认分支最新（短命令由本脚本自己维护）
#   sudo morrow-update --check          # 只看有没有新版本，不装
#   sudo morrow-update --status         # 看当前版本 / 服务状态 / 最近备份
#   sudo morrow-update --rollback       # 回到上一个装过的版本
#   sudo morrow-update v0.3.0           # 升到指定 tag / 分支 / commit
#   sudo morrow-update --force          # 版本没变也重装一遍
#   sudo morrow-update --no-backup      # 跳过升级前备份（不建议）
#   sudo morrow-update --no-cache       # 不复用构建缓存，强制重新装依赖
#
# 没有短命令时直接跑本文件：sudo bash /opt/morrow-calendar/deploy/update-from-github.sh
#
set -euo pipefail

GITHUB_REPO="${GITHUB_REPO:-tianze-hou/morrow-calendar}"
APP_DIR="${APP_DIR:-/opt/morrow-calendar}"
DATA_DIR="${DATA_DIR:-/var/lib/morrow-calendar}"
PREV_DIR="${PREV_DIR:-/opt/morrow-calendar.prev}"
ENV_FILE="${ENV_FILE:-/etc/morrow-calendar.env}"
SERVICE_NAME="${SERVICE_NAME:-morrow-calendar}"
BIN_PATH="${BIN_PATH:-/usr/local/bin/morrow-update}"
WORK_DIR="${WORK_DIR:-/var/cache/morrow-calendar/work}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/morrow-calendar}"
LOCK_FILE="${LOCK_FILE:-/var/lock/morrow-update.lock}"
VERSION_FILE="$APP_DIR/.deploy-version"

TARGET_REF=""
DO_CHECK=0
DO_FORCE=0
DO_BACKUP=1
DO_STATUS=0
DO_ROLLBACK=0
DO_CACHE=1
for arg in "$@"; do
  case "$arg" in
    --check)     DO_CHECK=1 ;;
    --force)     DO_FORCE=1 ;;
    --no-backup) DO_BACKUP=0 ;;
    --no-cache)  DO_CACHE=0 ;;
    --status)    DO_STATUS=1 ;;
    --rollback)  DO_ROLLBACK=1 ;;
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

api() { curl -fsS --max-time 20 "$1" 2>/dev/null; }

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

# ── 2. 互斥锁 ──────────────────────────────────────────────────
# 两个终端同时敲 morrow-update 会把代码目录写花，这里直接拒绝后来者。
# 只在真正要动文件的分支里取锁：--status / --check 是只读的，不该被挡住。
take_lock() {
  mkdir -p "$(dirname "$LOCK_FILE")"
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    die "已经有一个更新在跑（锁文件：$LOCK_FILE）。等它结束再试"
  fi
}

service_state() {
  systemctl is-active "$SERVICE_NAME" 2>/dev/null || echo unknown
}

health() {
  local port
  port="$(grep -E '^PORT=' "$ENV_FILE" 2>/dev/null | cut -d= -f2 | tail -1)"
  port="${port:-8787}"
  if curl -fsS --max-time 4 "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1; then
    echo "正常（127.0.0.1:${port}）"
  else
    echo "异常（127.0.0.1:${port} 无响应）"
  fi
}

# ── 3. 当前版本 ────────────────────────────────────────────────
CURRENT_SHA=""
[ -f "$VERSION_FILE" ] && CURRENT_SHA="$(sed -n 1p "$VERSION_FILE" 2>/dev/null || true)"

# ── 4. --status：一眼看清现状 ──────────────────────────────────
if [ "$DO_STATUS" -eq 1 ]; then
  echo
  echo "morrow calendar 现状"
  echo "  代码目录   $APP_DIR"
  echo "  当前版本   ${CURRENT_SHA:-未记录}"
  [ -f "$VERSION_FILE" ] && sed -n '2,3p' "$VERSION_FILE" | sed 's/^/             /'
  echo "  服务状态   $(service_state)"
  echo "  健康检查   $(health)"
  echo "  数据库     $DB_PATH"
  [ -f "$DB_PATH" ] && echo "  库文件大小 $(du -h "$DB_PATH" | cut -f1)"
  echo "  回滚点     $([ -f "$PREV_DIR/deploy/deploy.sh" ] && echo "$PREV_DIR" || echo 无)"
  echo "  最近备份   $(ls -t "$BACKUP_DIR" 2>/dev/null | head -1 || true)"
  echo "  构建目录   $([ -f "$WORK_DIR/node_modules/.morrow-deps" ] && echo "$WORK_DIR（依赖已就位）" || echo "$WORK_DIR（下次会重新装依赖）")"
  echo
  exit 0
fi

# ── 5. --rollback：回到上一个装过的版本 ────────────────────────
if [ "$DO_ROLLBACK" -eq 1 ]; then
  take_lock
  [ -f "$PREV_DIR/deploy/deploy.sh" ] || die "没有可用的回滚点（$PREV_DIR/deploy/deploy.sh 不存在）"
  log "从 $PREV_DIR 重新部署"
  bash "$PREV_DIR/deploy/deploy.sh" || die "回滚部署失败。查看：journalctl -u $SERVICE_NAME -n 100"
  rsync -a --delete --exclude 'node_modules' --exclude 'data' --exclude '.deploy-version' --exclude '.prev-version' \
    "$PREV_DIR/" "$APP_DIR/"
  PREV_SHA="$(cat "$PREV_DIR/.prev-version" 2>/dev/null || true)"
  if [ -n "$PREV_SHA" ]; then
    printf '%s\nref: rollback\nupdated: %s\n' "$PREV_SHA" "$(date '+%Y-%m-%d %H:%M:%S')" > "$VERSION_FILE"
  fi
  log "已回滚${PREV_SHA:+到 ${PREV_SHA:0:7}}。数据库未改动"
  exit 0
fi

# ── 6. 解析远端版本 ────────────────────────────────────────────
log "查询 GitHub 上的版本（$GITHUB_REPO）"

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
log "远端版本：${TARGET_SHA:0:7}（${COMMIT_MSG:-无提交信息}）"

# ── 7. 与本机版本比对 ──────────────────────────────────────────
if [ "$CURRENT_SHA" = "$TARGET_SHA" ] && [ "$DO_FORCE" -eq 0 ]; then
  log "本机已是该版本，无需更新"
  log "服务状态：$(service_state)　健康检查：$(health)"
  exit 0
fi

if [ -n "$CURRENT_SHA" ]; then
  log "本机版本：${CURRENT_SHA:0:7} → 将更新到 ${TARGET_SHA:0:7}"
  # 光看两个 sha 看不出这次更新改了什么，顺手把中间那串提交列出来
  if [ "${CURRENT_SHA:0:7}" != "${TARGET_SHA:0:7}" ]; then
    api "https://api.github.com/repos/$GITHUB_REPO/compare/${CURRENT_SHA}...${TARGET_SHA}" | node -e '
      let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
        try{
          const j=JSON.parse(s);
          if(j.status!=="ahead")return;
          const list=(j.commits||[]).slice(-10);
          if(!list.length)return;
          console.log(`  中间 ${j.total_commits} 个提交：`);
          for(const c of list) console.log(`  · ${c.sha.slice(0,7)} ${(c.commit.message||"").split("\n")[0]}`);
        }catch{}
      })' || true
  fi
else
  warn "本机未记录版本号（$VERSION_FILE 不存在），将直接部署远端版本"
fi

if [ "$DO_CHECK" -eq 1 ]; then
  log "（--check：只检查，不安装）"
  exit 0
fi

# ── 8. 备份数据库 ──────────────────────────────────────────────
take_lock
if [ "$DO_BACKUP" -eq 1 ] && [ -f "$DB_PATH" ]; then
  log "备份数据库"
  if [ -f "$APP_DIR/deploy/backup.sh" ]; then
    bash "$APP_DIR/deploy/backup.sh" || die "备份失败，已中止升级（不冒险动生产数据）"
  else
    STAMP="$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$BACKUP_DIR"
    cp -a "$DB_PATH" "$BACKUP_DIR/calendar.db.$STAMP"
    log "已备份到 $BACKUP_DIR/calendar.db.$STAMP"
  fi
fi

# ── 9. 下载源码包 ──────────────────────────────────────────────
TMP="$(mktemp -d /tmp/morrow-update.XXXXXX)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

log "下载 ${TARGET_SHA:0:7} 的源码包"
if ! curl -fsSL --max-time 180 -o "$TMP/src.tgz" \
     "https://codeload.github.com/$GITHUB_REPO/tar.gz/$TARGET_SHA"; then
  die "下载失败。检查服务器能否访问 codeload.github.com"
fi
[ -s "$TMP/src.tgz" ] || die "下载到的源码包是空的"
tar tzf "$TMP/src.tgz" >/dev/null 2>&1 || die "源码包损坏（tar 解不开）"

mkdir -p "$TMP/src"
tar xzf "$TMP/src.tgz" -C "$TMP/src" --strip-components=1
[ -f "$TMP/src/deploy/deploy.sh" ] || die "源码包结构不对：缺少 deploy/deploy.sh"

# ── 10. 持久构建目录与依赖复用 ─────────────────────────────────
# 在哪儿构建？放在固定的工作目录里，而不是每次新建的临时目录。
# 原因是 node_modules 有 280MB：每版都重新 npm ci，再把它拷来拷去，这部分
# 开销比构建本身还大。固定目录下依赖就一直在原地，只有源码需要同步。
mkdir -p "$WORK_DIR"
rsync -a --delete --exclude 'node_modules' --exclude 'dist' --exclude 'dist-server' \
  "$TMP/src/" "$WORK_DIR/"

LOCK_SHA="$(sha256sum "$TMP/src/package-lock.json" | cut -d' ' -f1)"
NODE_V="$(node -v)"
DEPS_MARK="$WORK_DIR/node_modules/.morrow-deps"
DEPS_REUSED=0
# 标记文件故意放在 node_modules 里面：npm ci 会清空这个目录，标记随之消失，
# 不会出现「装了一半却仍被判定为可复用」的情况。
# （也别放在工作目录顶层——上面那句 rsync --delete 会把它当多余文件删掉。）
if [ "$DO_CACHE" -eq 1 ] && [ -f "$DEPS_MARK" ] \
   && [ "$(cat "$DEPS_MARK")" = "$(printf '%s\n%s' "$LOCK_SHA" "$NODE_V")" ]; then
  log "依赖未变（package-lock 与 Node 版本一致），跳过 npm ci 与依赖同步"
  export SKIP_INSTALL=1
  export SYNC_DEPS=0
  DEPS_REUSED=1
else
  export SYNC_DEPS=1
fi

# ── 11. 保存回滚点 ─────────────────────────────────────────────
# 只存源码，不存 node_modules（上百 MB，且可由 package-lock 重建）
if [ -d "$APP_DIR" ]; then
  log "保存回滚点到 $PREV_DIR"
  rm -rf "$PREV_DIR"
  mkdir -p "$PREV_DIR"
  rsync -a --exclude 'node_modules' --exclude 'data' "$APP_DIR/" "$PREV_DIR/"
  [ -n "$CURRENT_SHA" ] && printf '%s\n' "$CURRENT_SHA" > "$PREV_DIR/.prev-version"
fi

# ── 12. 构建并安装 ─────────────────────────────────────────────
sync_source() { # $1 = 源目录
  rsync -a --delete \
    --exclude 'node_modules' --exclude 'data' --exclude '.deploy-version' --exclude '.prev-version' \
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
  # 回滚点里没有 node_modules，必须让 deploy.sh 老老实实装一遍并把依赖同步过去，
  # 不能继承上面为「复用依赖」设的环境变量。
  if ( export SKIP_INSTALL=0 SYNC_DEPS=1; bash "$PREV_DIR/deploy/deploy.sh" ); then
    sync_source "$PREV_DIR" || true
    [ -n "$CURRENT_SHA" ] && write_version "$CURRENT_SHA" "rollback"
    log "已回滚到 ${CURRENT_SHA:0:7}"
  else
    die "回滚也失败了。请手动执行：bash $PREV_DIR/deploy/deploy.sh，并查看 journalctl -u $SERVICE_NAME -n 100"
  fi
}

log "构建并安装（依赖已就位则跳过 npm ci）"
if bash "$WORK_DIR/deploy/deploy.sh"; then
  log "新版本部署完成"
else
  warn "部署失败"
  rollback
  die "已回滚到上一版本，服务应已恢复。失败原因请看上面的输出"
fi

# 这一轮真的装过依赖，才写下「可现在复用」的标记
if [ "$DEPS_REUSED" -eq 0 ] && [ -d "$WORK_DIR/node_modules" ]; then
  printf '%s\n%s\n' "$LOCK_SHA" "$NODE_V" > "$DEPS_MARK"
fi

# ── 13. 收尾：源码同步到安装目录、写版本、修属主 ───────────────
log "同步源码并记录版本"
sync_source "$WORK_DIR"
write_version "$TARGET_SHA" "$TARGET_REF"

# 代码目录归运行用户，避免下次以 root 部署后服务读不到
SERVICE_USER="$(systemctl show -p User --value "$SERVICE_NAME" 2>/dev/null || echo morrow)"
[ -n "$SERVICE_USER" ] || SERVICE_USER=morrow
if id -u "$SERVICE_USER" >/dev/null 2>&1; then
  find "$APP_DIR" -mindepth 1 -maxdepth 1 ! -name 'node_modules' ! -name 'data' \
    -exec chown -R "$SERVICE_USER":"$SERVICE_USER" {} + 2>/dev/null || true
  [ -f "$VERSION_FILE" ] && chown "$SERVICE_USER":"$SERVICE_USER" "$VERSION_FILE" 2>/dev/null || true
fi

# ── 14. 维护短命令 ─────────────────────────────────────────────
# 让 morrow-update 始终指向这套脚本，不需要人工装一次、也不会指向旧路径。
WANT_BIN="#!/usr/bin/env bash
# 由 update-from-github.sh 自动维护，请勿手改（要改就改脚本本身）。
# 把 morrow-calendar 更新到 GitHub 上的最新版本，参数原样透传。
exec bash $APP_DIR/deploy/update-from-github.sh \"\$@\""
if [ "$(cat "$BIN_PATH" 2>/dev/null || true)" != "$WANT_BIN" ]; then
  printf '%s\n' "$WANT_BIN" > "$BIN_PATH"
  chmod 0755 "$BIN_PATH"
  log "已更新短命令：$BIN_PATH"
fi

log "完成：${TARGET_SHA:0:7}　服务：$(service_state)　健康检查：$(health)"
log "查看日志：journalctl -u $SERVICE_NAME -f"
