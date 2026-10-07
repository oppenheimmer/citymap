import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  testDir: './tests/browser',
  workers: 1,
  timeout: 30_000,
  forbidOnly: !!process.env.CI,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    viewport: { width: 1000, height: 750 },
    deviceScaleFactor: 1,
    channel: 'chromium',
    trace: 'retain-on-failure',
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, args: ['--use-gl=angle', `--use-angle=${process.env.PLAYWRIGHT_CHROMIUM_BACKEND || 'swiftshader-webgl'}`, '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--ignore-gpu-blocklist'] },
  },
  webServer: { command: 'node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4173 --strictPort', cwd: fileURLToPath(new URL('.', import.meta.url)), url: 'http://127.0.0.1:4173/', reuseExistingServer: !process.env.CI },
});
