/**
 * F7.1 respondent chat surface — end-to-end.
 *
 * The sales-critical happy path: a respondent completes a branded questionnaire with no
 * account, through the streaming conversation. This protects the demo flow against
 * regressions. It needs a provisioned environment (see `tests/e2e/README.md`); when the
 * seeded version id isn't supplied it skips rather than failing, so CI stays green until the
 * fixture is wired.
 */

import { test, expect } from '@playwright/test';

/** A launched questionnaire version with `anonymousMode = true`. See tests/e2e/README.md. */
const VERSION_ID = process.env.E2E_VERSION_ID;

/** Set when the running env has the live-sessions flag ON (so the 404 gate test is skipped). */
const LIVE_SESSIONS_ON = process.env.E2E_LIVE_SESSIONS_ENABLED === 'true';

test.describe('Questionnaire chat surface (F7.1)', () => {
  test('the no-login surface 404s when live sessions are disabled', async ({ page }) => {
    test.skip(LIVE_SESSIONS_ON, 'live sessions are enabled in this environment');
    // A dark-launched surface must look like a missing route — no leak that anonymous mode exists.
    const res = await page.goto('/q/any-version-id');
    expect(res?.status()).toBe(404);
  });

  test('a respondent completes the no-login demo happy path', async ({ page }) => {
    test.skip(
      !VERSION_ID,
      'set E2E_VERSION_ID to a launched anonymousMode version (see tests/e2e/README.md)'
    );

    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await page.goto(`/q/${VERSION_ID}`);

    // The anonymous session boots client-side and the composer becomes available.
    const composer = page.getByLabel('Your answer');
    await expect(composer).toBeVisible({ timeout: 15_000 });

    // First reply kicks the turn loop.
    await composer.fill('Hello, I am ready to begin.');
    await page.getByRole('button', { name: 'Send' }).click();

    // The optimistic user bubble appears immediately.
    await expect(page.getByText('Hello, I am ready to begin.')).toBeVisible();

    // The composer re-enables once the assistant's reply finishes streaming (turn complete).
    await expect(composer).toBeEnabled({ timeout: 30_000 });

    // A second turn advances the conversation.
    await composer.fill('Here is my answer to the first question.');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText('Here is my answer to the first question.')).toBeVisible();
    await expect(composer).toBeEnabled({ timeout: 30_000 });

    expect(consoleErrors, `unexpected console errors:\n${consoleErrors.join('\n')}`).toEqual([]);
  });
});
