import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { browserOptions } from './tests/support/browser-options.ts';

export default defineConfig({
  testDir: './tests/browser',
  workers: 1,
  timeout: 30_000,
  forbidOnly: !!process.env.CI,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    ...browserOptions(),
  },
  webServer: { command: 'node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4173 --strictPort', cwd: fileURLToPath(new URL('.', import.meta.url)), url: 'http://127.0.0.1:4173/', reuseExistingServer: !process.env.CI },
});
