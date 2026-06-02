/**
 * Tests: lib/app/ bootstrap seams — Sunrise no-op defaults vs ConQuest's fills
 *
 * The auto-wired bootstrap hooks (`lib/app/rate-limit.ts`, `lib/app/capabilities.ts`,
 * `lib/app/admin-nav.ts`) ship empty in the Sunrise template and forks fill them
 * in. This is an **application fork** (ConQuest), so it fills some of them: the
 * `admin-nav` seam now registers the questionnaire surface (P2 / F2.1). This file
 * locks in the EXACT app-level registration so a stray/missing registration is
 * caught — `rate-limit` stays a true no-op (F1.1 uses an in-handler `ingestLimiter`,
 * not `registerAppRateLimits`); `capabilities` still returns void by contract.
 *
 * @see lib/app/rate-limit.ts · lib/app/capabilities.ts · lib/app/admin-nav.ts
 */

import { describe, it, expect, afterEach } from 'vitest';
import { registerAppRateLimits } from '@/lib/app/rate-limit';
import { initAppCapabilities } from '@/lib/app/capabilities';
import { initAppNav } from '@/lib/app/admin-nav';
import { getEffectiveRateLimitPolicy, RATE_LIMIT_POLICY } from '@/lib/security/rate-limit-policy';
import { getRegisteredNavSections, __resetNavRegistryForTests } from '@/lib/admin-nav/registry';

afterEach(() => {
  __resetNavRegistryForTests();
});

describe('lib/app/ bootstrap seams', () => {
  it('registerAppRateLimits registers no tiers or rules by default', () => {
    // Act — run the real (empty) hook
    registerAppRateLimits();

    // Assert — no app rules → the effective policy is the base policy by identity
    expect(getEffectiveRateLimitPolicy()).toBe(RATE_LIMIT_POLICY);
  });

  it('initAppCapabilities is a no-op by default', () => {
    // The real default does nothing and returns void; forks add
    // registerAppCapability() calls. (Behavioural reach into the dispatcher is
    // covered by bootstrap-wiring.test.ts.)
    expect(initAppCapabilities()).toBeUndefined();
  });

  it('initAppNav registers exactly the ConQuest questionnaire nav section', () => {
    // Arrange — clean registry
    __resetNavRegistryForTests();

    // Act — run the real app hook (ConQuest fills this seam; Sunrise ships it empty)
    initAppNav();

    // Assert — exactly the questionnaire section, nothing more. Catches both an
    // accidental extra registration and a regression that drops the app nav.
    expect(getRegisteredNavSections().map((s) => s.title)).toEqual(['Questionnaires']);
  });
});
