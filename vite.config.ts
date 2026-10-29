import { defineConfig, loadEnv } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { rendererCompat } from './tools/renderer-compat.ts';
import { createSearchHandler } from './server/search.ts';
import { createCacheHandler } from './server/cache.ts';

export default defineConfig(({ mode }) => ({
  plugins: [svelte(), rendererCompat(), {
    name: 'local-search-api',
    configureServer(server) {
      const handler = createSearchHandler({ ...loadEnv(mode, process.cwd(), ''), ...process.env }, false);
      server.middlewares.use('/api/search', (req, res) => { void handler(req, res); });
      const cache = createCacheHandler({ ...loadEnv(mode, process.cwd(), ''), ...process.env });
      server.middlewares.use('/api/cache', (req, res) => { void cache(req, res); });
    },
  }],
  // Keep the pinned renderer's scheduling fix active in the dev server as well.
  optimizeDeps: { exclude: ['w-gl'] },
  server: { port: 8080 },
  build: { outDir: 'dist', emptyOutDir: true },
}));
