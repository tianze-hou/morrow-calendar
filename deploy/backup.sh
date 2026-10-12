#!/usr/bin/env bash
#
# 数据库备份脚本。SQLite 推荐用 .backup 命令，可在服务运行中安全复制。
#
# 用法：sudo bash deploy/backup.sh
# 定时任务（每天 3 点）：
#   0 3 * * * /usr/bin/bash /opt/morrow-calendar/deploy/backup.sh >> /var/log/morrow-calendar/backup.log 2>&1
#
set -euo pipefail

DATA_DIR="${DATA_DIR:-/var/lib/morrow-calendar}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/morrow-calendar}"
KEEP_DAYS="${KEEP_DAYS:-30}"
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$BACKUP_DIR"

if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DATA_DIR/calendar.db" ".backup '${BACKUP_DIR}/calendar-${STAMP}.db'"
else
  # 没有 sqlite3 时用 VACUUM INTO（SQLite 3.27+），由 Node 侧驱动执行
  node -e "
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync('$DATA_DIR/calendar.db');
    db.exec(\"VACUUM INTO '$BACKUP_DIR/calendar-$STAMP.db'\");
    db.close();
  "
fi

gzip -f "${BACKUP_DIR}/calendar-${STAMP}.db"
find "$BACKUP_DIR" -name 'calendar-*.db.gz' -mtime "+${KEEP_DAYS}" -delete

echo "$(date '+%Y-%m-%d %H:%M:%S') 备份完成：${BACKUP_DIR}/calendar-${STAMP}.db.gz"
