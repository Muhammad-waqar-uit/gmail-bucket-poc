import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 4571);
const baseURL = `http://127.0.0.1:${PORT}`;

/**
 * Browser to test with. Defaults to Playwright's bundled Chromium (what CI uses).
 * On a locked-down machine that refuses to run unsigned Chromium builds, set
 * PW_CHANNEL=chrome or PW_CHANNEL=msedge to use an installed browser instead.
 */
const requested = process.env.PW_CHANNEL;
const channel = requested === 'chrome' || requested === 'msedge' ? requested : undefined;

/**
 * End-to-end tests run against a real server on :4571 using the in-memory
 * backend, so no Google credentials are needed and nothing is written to Drive.
 */
export default defineConfig({
  testDir: './e2e',
  outputDir: 'test-results',
  // The in-memory backend is shared by every test in a run.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: channel ?? 'chromium', use: { ...devices['Desktop Chrome'], ...(channel ? { channel } : {}) } },
  ],
  webServer: {
    command: 'npm run build && node dist/main.js',
    url: `${baseURL}/api/status`,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
    env: { STORAGE: 'memory', PORT: String(PORT), HOST: '127.0.0.1' },
  },
});
