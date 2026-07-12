/**
 * Tests: lib/app/ bootstrap seams — Sunrise no-op defaults vs ConQuest's fills
 *
 * The auto-wired bootstrap hooks (`lib/app/rate-limit.ts`, `lib/app/capabilities.ts`,
 * `lib/app/context-contributors.ts`, `lib/app/admin-nav.ts`) ship empty in the Sunrise
 * template and forks fill them in. This is an **application fork** (ConQuest), so it fills
 * some of them: the `admin-nav` seam registers the questionnaire surface (P2 / F2.1),
 * asserted below. The `public-nav` seam (issue #347) is also filled, but its content is
 * deliberately NOT asserted here — nav links are content that changes routinely,
 * and a unit test should not break on a copy/route edit. The override *behaviour*
 * (replace-vs-fallback) is covered content-agnostically in `public-nav.test.tsx`.
 * `rate-limit` stays a true no-op (F1.1 uses an in-handler `ingestLimiter`, not
 * `registerAppRateLimits`); `capabilities` still returns void by contract;
 * `context-contributors` stays a no-op (ConQuest does not register prompt-context
 * loaders); `emails` ships no overrides (platform templates).
 *
 * @see lib/app/rate-limit.ts · lib/app/capabilities.ts · lib/app/admin-nav.ts
 */

import { describe, it, expect, afterEach } from 'vitest';
import { registerAppRateLimits } from '@/lib/app/rate-limit';
import { initAppCapabilities } from '@/lib/app/capabilities';
import { initAppContextContributors } from '@/lib/app/context-contributors';
import { initAppNav } from '@/lib/app/admin-nav';
import { emailOverrides } from '@/lib/app/emails';
import { initApp } from '@/lib/app/bootstrap';
import { initAppKnowledgeAccessContributors } from '@/lib/app/knowledge-access-contributors';
import appEslintConfig from '@/lib/app/eslint.config.mjs';
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

  it('initAppContextContributors is a no-op by default', () => {
    // The real default registers no prompt-context loaders and returns void;
    // forks add registerContextContributor() calls. (Behavioural reach into
    // buildContext is covered by context-builder.test.ts.)
    expect(initAppContextContributors()).toBeUndefined();
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

  it('email overrides are empty by default (= use platform templates)', () => {
    // A stray override here would silently swap an auth email for every install.
    expect(emailOverrides).toEqual({});
  });

  it('initApp does no boot work by default (resolves to undefined)', async () => {
    // The real default is an empty async fn; forks fill it. A stray default
    // would run one-time work on every install boot. (The instrumentation
    // wiring — that register() calls this in all envs, isolated in try/catch —
    // is covered by tests/unit/instrumentation.test.ts.)
    await expect(initApp()).resolves.toBeUndefined();
  });

  it('initAppKnowledgeAccessContributors is a no-op by default', () => {
    // The real default registers no access contributors and returns void; forks
    // add registerAgentAccessContributor() calls. A stray default would silently
    // widen every restricted agent's document access on every install.
    // (Behavioural reach into the resolver is covered by
    // resolveAgentDocumentAccess.test.ts.)
    expect(initAppKnowledgeAccessContributors()).toBeUndefined();
  });

  it('the ESLint config seam is an empty array by default', () => {
    // A stray flat-config block here would silently apply lint rules to every
    // fork (the root eslint.config.mjs spreads this array last). Forks fill it;
    // vanilla Sunrise ships it empty. The root spread itself is exercised by
    // every `npm run lint` run.
    expect(appEslintConfig).toEqual([]);
  });
});
