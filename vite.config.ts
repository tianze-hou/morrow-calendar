import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const API_PORT = process.env.PORT ?? '8787';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${API_PORT}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    cssMinify: 'lightningcss',
    // 关闭 sourcemap：生产产物不含源码映射，体积更小
    sourcemap: false,
    rollupOptions: {
      output: {
        // 按依赖稳定性分包：react 与日历组件很少变动，可长期命中浏览器缓存
        manualChunks: {
          calendar: ['@ilamy/calendar', '@ilamy/calendar/plugins/agenda', 'dayjs'],
        },
      },
    },
    // 单块超过 600 kB 才告警：日历本身较大，属于预期内
    chunkSizeWarningLimit: 600,
  },
});
