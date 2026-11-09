import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The built console is served from `/` and `/app/`, so every asset path is relative.
// The API routes are absolute on purpose: one origin in dev, one origin in production.
const TARGET = 'http://127.0.0.1:3000';

// P7 (ADR-0049): the daemon serves its principal token to nobody, so there is no dev
// injection to keep in sync — an earlier plugin that embedded the key file's token into
// the dev page was removed by review, because any unauthenticated delivery of the token
// to a browser is equally readable by a same-machine process. The console authenticates
// through its own 401 gate (PrincipalGate), which works identically in dev and prod.

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
      '/settings': { target: TARGET, changeOrigin: true },
      '/embedding': { target: TARGET, changeOrigin: true },
      '/projects': { target: TARGET, changeOrigin: true },
      '/agent': { target: TARGET, changeOrigin: true },
      '/app': { target: TARGET, changeOrigin: true },
    },
  },
});
