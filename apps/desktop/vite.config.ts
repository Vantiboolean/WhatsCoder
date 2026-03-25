import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 6188,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 6189 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
    proxy: {
      '/ws': {
        target: 'ws://127.0.0.1:4500',
        ws: true,
        changeOrigin: true,
        rewrite: () => '/',
        configure: (proxy) => {
          proxy.on('proxyReqWs', (proxyReq) => {
            proxyReq.removeHeader('origin');
          });
        },
      },
      '/readyz': {
        target: 'http://127.0.0.1:4500',
        changeOrigin: true,
      },
      '/healthz': {
        target: 'http://127.0.0.1:4500',
        changeOrigin: true,
      },
    },
  },
});
