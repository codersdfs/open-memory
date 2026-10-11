import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The built console is served from `/` and `/app/`, so every asset path is relative.
// The API routes are absolute on purpose: one origin in dev, one origin in production.
const TARGET = 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 5173,
    proxy: {
      '/memories': { target: TARGET, changeOrigin: true },
      '/graph': { target: TARGET, changeOrigin: true },
      '/positions': { target: TARGET, changeOrigin: true },
      '/stats': { target: TARGET, changeOrigin: true },
      '/health': { target: TARGET, changeOrigin: true },
      '/extract': { target: TARGET, changeOrigin: true },
      '/decay': { target: TARGET, changeOrigin: true },
      '/sessions': { target: TARGET, changeOrigin: true },
      '/namespaces': { target: TARGET, changeOrigin: true },
      '/app': { target: TARGET, changeOrigin: true },
    },
  },
});
