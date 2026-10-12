#!/usr/bin/env bash
#
# morrow calendar 服务器部署脚本（systemd 版）
#
# 作用：把当前目录的代码构建并安装到 /opt/morrow-calendar，
#       配置 systemd 服务并启动。可重复执行（幂等）。
#
# 用法：sudo bash deploy/deploy.sh
#       PORT=8787 bash deploy/deploy.sh   # 覆盖端口
#
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/morrow-calendar}"
DATA_DIR="${DATA_DIR:-/var/lib/morrow-calendar}"
SERVICE_USER="${SERVICE_USER:-morrow}"
ENV_FILE=/etc/morrow-calendar.env
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log() { printf '\033[36m[部署]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[失败]\033[0m %s\n' "$*" >&2; exit 1; }

# ── 1. 环境检查 ────────────────────────────────────────────────
log "检查运行环境"
command -v node >/dev/null 2>&1 || die "未找到 node，请先安装 Node.js 22 或更高版本"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "Node 版本过低（当前 $(node -v)），需要 22 或更高"
command -v npm >/dev/null 2>&1 || die "未找到 npm"
log "Node $(node -v) / npm $(npm -v)"

# ── 2. 构建 ────────────────────────────────────────────────────
log "安装依赖并构建"
cd "$SRC_DIR"
# 这里必须装「全量」依赖：构建要用到 devDependencies（vite / tsc / esbuild），
# 先 --omit=dev 再 build 会直接失败。所以顺序是：全量装 → 构建 → 剪掉 dev，
# 只把运行时依赖带到安装目录。显式写 --include=dev，避免部署 shell 里带着
# NODE_ENV=production 时 npm 自动省略 dev 依赖。
npm ci --include=dev --no-audit --no-fund
npm run build
npm prune --omit=dev
[ -f dist-server/index.mjs ] || die "后端构建产物缺失"
[ -f dist/index.html ] || die "前端构建产物缺失"

# ── 3. 安装到目标目录 ──────────────────────────────────────────
log "安装到 $APP_DIR"
mkdir -p "$APP_DIR" "$DATA_DIR"
rsync -a --delete --exclude 'data' --exclude 'node_modules' "$SRC_DIR/dist" "$APP_DIR/"
rsync -a --delete "$SRC_DIR/dist-server" "$APP_DIR/"
install -m 0644 "$SRC_DIR/package.json" "$APP_DIR/package.json"
rsync -a --delete "$SRC_DIR/node_modules" "$APP_DIR/node_modules"

# ── 4. 运行用户 ────────────────────────────────────────────────
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  log "创建运行用户 $SERVICE_USER"
  useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
fi
chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"
# 数据库可能由旧版本以 root 建过，这里统一归属
[ -f "$DATA_DIR/calendar.db" ] && chown "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"/calendar.db*

# ── 5. 环境变量文件 ────────────────────────────────────────────
if [ ! -f "$ENV_FILE" ]; then
  log "生成配置文件 $ENV_FILE"
  cat > "$ENV_FILE" <<EOF
PORT=${PORT:-8787}
DB_PATH=${DATA_DIR}/calendar.db
TZ_NAME=${TZ_NAME:-Asia/Shanghai}
DB_DRIVER=${DB_DRIVER:-wasm}
MAX_BATCH_SIZE=${MAX_BATCH_SIZE:-50}
NODE_ENV=production
EOF
  chmod 0600 "$ENV_FILE"
else
  log "配置文件已存在，保持不变：$ENV_FILE"
fi

# ── 6. systemd 服务 ────────────────────────────────────────────
log "安装并启动 systemd 服务"
install -m 0644 "$SRC_DIR/deploy/morrow-calendar.service" /etc/systemd/system/morrow-calendar.service
systemctl daemon-reload
systemctl enable morrow-calendar
systemctl restart morrow-calendar

# ── 7. 健康检查 ────────────────────────────────────────────────
sleep 2
PORT_NOW="$(grep -E '^PORT=' "$ENV_FILE" | cut -d= -f2)"
log "等待服务就绪（端口 ${PORT_NOW}）"
for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:${PORT_NOW}/api/health" >/dev/null 2>&1; then
    log "服务已就绪："
    curl -fsS "http://127.0.0.1:${PORT_NOW}/api/health"
    echo
    log "完成。查看日志：journalctl -u morrow-calendar -f"
    exit 0
  fi
  sleep 1
done

die "服务启动后健康检查未通过，请查看：journalctl -u morrow-calendar -n 100"
