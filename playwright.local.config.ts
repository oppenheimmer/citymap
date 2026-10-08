import { defineConfig } from '@playwright/test';
import { browserOptions } from './tests/support/browser-options.ts';

export default defineConfig({
  testDir: './tests/local',
  // The fixture provider is mutable and reset before each test.
  workers: 1,
  timeout: 30_000,
  forbidOnly: true,
  outputDir: 'test-results/local',
  reporter: [['list'], ['html', { outputFolder: 'playwright-report/local', open: 'never' }]],
  use: { ...browserOptions(true), baseURL: 'http://127.0.0.1:8082', serviceWorkers: 'block' },
  webServer: [
    { command: 'node tests/support/provider-server.ts', url: 'http://127.0.0.1:8091/health', reuseExistingServer: false },
    {
      command: 'npm run dev -- --host 127.0.0.1 --port 8082 --strictPort --mode test',
      url: 'http://127.0.0.1:8082/',
      reuseExistingServer: false,
      // Override shell and .env.local values so the suite needs no accounts.
      env: {
        VITE_TEST_FIXTURES: '1',
        VITE_CITY_DATA_BASE_URL: '',
        VITE_AREA_SERVER: '',
        VITE_SEARCH_URL: '',
        VITE_OVERPASS_URL: 'http://127.0.0.1:8091/roads',
        SEARCH_PROVIDER_URL: 'http://127.0.0.1:8091/search',
        SEARCH_PROVIDER_API_KEY: '',
        APP_ORIGIN: 'http://127.0.0.1:8082',
        R2_SEARCH_BUCKET: '',
        R2_ACCOUNT_ID: '',
        R2_ACCESS_KEY_ID: '',
        R2_SECRET_ACCESS_KEY: '',
      },
    },
  ],
});
