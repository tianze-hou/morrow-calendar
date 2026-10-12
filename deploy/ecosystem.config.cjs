/** pm2 进程配置：不用 systemd 时用这个。用法见 docs/deployment.md */
module.exports = {
  apps: [
    {
      name: 'morrow-calendar',
      script: './dist-server/index.mjs',
      cwd: '/opt/morrow-calendar',
      interpreter: 'node',
      env: {
        NODE_ENV: 'production',
        PORT: 8787,
        DB_PATH: '/var/lib/morrow-calendar/calendar.db',
        TZ_NAME: 'Asia/Shanghai',
        DB_DRIVER: 'wasm',
      },
      instances: 1,
      exec_mode: 'fork',
      // SQLite 单文件写入，绝不能开 cluster 多实例
      autorestart: true,
      max_restarts: 5,
      min_uptime: '60s',
      max_memory_restart: '300M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      out_file: '/var/log/morrow-calendar/out.log',
      error_file: '/var/log/morrow-calendar/error.log',
    },
  ],
};
