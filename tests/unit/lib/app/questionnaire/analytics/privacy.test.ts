/**
 * Analytics privacy primitives — k-anonymity floor + the temporary alpha dashboard bypass.
 *
 * `isCohortSuppressed` is the stable k-anonymity gate (unchanged). `isAnalyticsPanelSuppressed` is the
 * dashboard-only variant that bypasses the low-N floor while the product is in the `alpha` release
 * stage. Because the bypass is resolved from `NEXT_PUBLIC_RELEASE_STAGE` at module load (via
 * `lib/app/release-stage`), each case sets the env, resets the module registry, and re-imports to
 * observe the resolved behaviour.
 *
 * @see lib/app/questionnaire/analytics/privacy.ts
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

const ENV_KEY = 'NEXT_PUBLIC_RELEASE_STAGE';
const original = process.env[ENV_KEY];

async function loadPrivacy(stage: string | undefined) {
  if (stage === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = stage;
  vi.resetModules();
  return import('@/lib/app/questionnaire/analytics/privacy');
}

afterEach(() => {
  if (original === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = original;
  vi.resetModules();
});

describe('isCohortSuppressed (stable k-anonymity floor)', () => {
  it('suppresses a non-empty cohort below the threshold', async () => {
    const { isCohortSuppressed, K_ANONYMITY_THRESHOLD } = await loadPrivacy('alpha');
    expect(K_ANONYMITY_THRESHOLD).toBe(5);
    // The base seam is NOT affected by the alpha stage — cohort reports / safeguarding still gate on it.
    expect(isCohortSuppressed(1)).toBe(true);
    expect(isCohortSuppressed(4)).toBe(true);
    expect(isCohortSuppressed(5)).toBe(false);
    expect(isCohortSuppressed(0)).toBe(false);
  });
});

describe('isAnalyticsPanelSuppressed (dashboard, alpha-bypassable)', () => {
  it('bypasses the low-N floor in the alpha stage', async () => {
    const { isAnalyticsPanelSuppressed, ALPHA_ANALYTICS_ANONYMITY_DISABLED } =
      await loadPrivacy('alpha');
    expect(ALPHA_ANALYTICS_ANONYMITY_DISABLED).toBe(true);
    expect(isAnalyticsPanelSuppressed(1)).toBe(false);
    expect(isAnalyticsPanelSuppressed(4)).toBe(false);
    expect(isAnalyticsPanelSuppressed(0)).toBe(false);
  });

  it('enforces the low-N floor in the stable stage', async () => {
    const { isAnalyticsPanelSuppressed, ALPHA_ANALYTICS_ANONYMITY_DISABLED } =
      await loadPrivacy('stable');
    expect(ALPHA_ANALYTICS_ANONYMITY_DISABLED).toBe(false);
    expect(isAnalyticsPanelSuppressed(3)).toBe(true);
    expect(isAnalyticsPanelSuppressed(5)).toBe(false);
    expect(isAnalyticsPanelSuppressed(0)).toBe(false);
  });

  it('enforces the low-N floor in the beta stage (bypass is alpha-only)', async () => {
    const { isAnalyticsPanelSuppressed, ALPHA_ANALYTICS_ANONYMITY_DISABLED } =
      await loadPrivacy('beta');
    expect(ALPHA_ANALYTICS_ANONYMITY_DISABLED).toBe(false);
    expect(isAnalyticsPanelSuppressed(3)).toBe(true);
  });

  it('enforces the low-N floor when the stage is unset', async () => {
    const { isAnalyticsPanelSuppressed } = await loadPrivacy(undefined);
    expect(isAnalyticsPanelSuppressed(2)).toBe(true);
  });
});
