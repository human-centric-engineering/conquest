import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the F7.1 respondent chat-surface end-to-end tests.
 *
 * Apps own their own e2e toolchain (per building-on-sunrise) — this is a ConQuest dev-dep,
 * not promoted to the platform. By default it boots `next dev` locally; point `E2E_BASE_URL`
 * at an already-running server (a preview deploy, or `next start`) to skip the managed server.
 *
 * See `tests/e2e/README.md` for the data + flag + provider prerequisites the demo happy path
 * needs (a launched `anonymousMode` version id in `E2E_VERSION_ID`, the live-sessions flag on,
 * and a configured LLM provider).
 */

const PORT = 3000;
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // When an external server is supplied, don't manage one.
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'npm run dev',
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
