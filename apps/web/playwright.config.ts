import { defineConfig, devices } from '@playwright/test';
import { join } from 'node:path';

const E2E_DB = process.env.E2E_DATABASE_NAME ?? 'acct_e2e';
const APP_DB_PASSWORD = process.env.APP_DB_PASSWORD ?? 'acct_app_dev_password';
export const OUTBOX_DIR = join(__dirname, 'test-results', 'outbox');

/**
 * Runs against the production builds (`pnpm build` first). The web build proxies /api to
 * http://localhost:4000, so the API must use that port.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
    viewport: { width: 1360, height: 860 },
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1360, height: 860 },
        launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH
          ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
          : {},
      },
    },
  ],
  webServer: [
    {
      command: 'node ../api/dist/main.js',
      url: 'http://localhost:4000/health',
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        NODE_ENV: 'development',
        DATABASE_URL: `postgres://acct_app:${APP_DB_PASSWORD}@localhost:5432/${E2E_DB}`,
        FIELD_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
        API_PORT: '4000',
        WEB_ORIGIN: 'http://localhost:3000',
        COOKIE_SECURE: 'false',
        MAIL_TRANSPORT: 'file',
        MAIL_OUTBOX_DIR: OUTBOX_DIR,
        RATE_LIMIT_AUTH_PER_MINUTE: '1000',
      },
    },
    {
      command: 'pnpm start',
      url: 'http://localhost:3000/login',
      reuseExistingServer: false,
      timeout: 60_000,
      env: { NEXT_TELEMETRY_DISABLED: '1' },
    },
  ],
});
