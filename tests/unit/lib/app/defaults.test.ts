/**
 * Tests: lib/app/ seams — Sunrise no-op defaults vs ConQuest's fills
 *
 * Every `lib/app/*` file is a fork-owned scaffold that Sunrise ships EMPTY. This
 * file exercises the REAL values to lock in that contract — a stray default
 * registration would silently apply to every install (a lint rule every fork
 * inherits, an auth email swapped out, a restricted agent's document access
 * widened).
 *
 * ConQuest is an application fork, so it fills some of them. Following the
 * upstream instruction, a filled seam **pins its new value** here rather than
 * deleting the row — that keeps the protection on every seam still unfilled.
 * The ConQuest fills are marked `FORK FILL` below: `admin-nav`, `public-nav`,
 * `capabilities`, `jobs`, `csp` and `data-export`.
 *
 * Content is deliberately NOT asserted for the nav seams — links and copy change
 * routinely and a unit test should not break on a copy edit. The override
 * *behaviour* (replace-vs-fallback) is covered content-agnostically in
 * `public-nav.test.tsx` and `protected-nav.test.tsx`.
 *
 * @see lib/app/ · CUSTOMIZATION.md §4
 */

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { registerAppRateLimits } from '@/lib/app/rate-limit';
import { initAppCapabilities } from '@/lib/app/capabilities';
import { initAppContextContributors } from '@/lib/app/context-contributors';
import { initAppNav } from '@/lib/app/admin-nav';
import { publicNavItems, footerNavItems, footerLegalItems } from '@/lib/app/public-nav';
import { protectedNavItems } from '@/lib/app/protected-nav';
import { appAuthLandingRoute, appAuthLandingLabel } from '@/lib/app/auth-landing';
import { emailOverrides } from '@/lib/app/emails';
import { initApp } from '@/lib/app/bootstrap';
import { initAppKnowledgeAccessContributors } from '@/lib/app/knowledge-access-contributors';
import { initAppGuardFloorContributors } from '@/lib/app/guard-floor-contributors';
import { initAppGuardEventContributors } from '@/lib/app/guard-event-contributors';
import { appAgentFields } from '@/lib/app/agent-fields';
import { appProtectedRoutes } from '@/lib/app/protected-routes';
import { appEnvSchema } from '@/lib/app/env';
import appEslintConfig from '@/lib/app/eslint.config.mjs';
import { appFrameSrc } from '@/lib/app/csp';
import { initAppUserCreatedHooks } from '@/lib/app/user-created';
import { collectAppSubjectData } from '@/lib/app/data-export';
import { APP_SUBJECT_DATA_SOURCES } from '@/lib/app/questionnaire/privacy/export-sources';
import { appConfigHealthChecks } from '@/lib/app/config-health';
import { getAppJobs, __resetAppJobsForTests } from '@/lib/orchestration/maintenance/app-jobs';
import { getEffectiveRateLimitPolicy, RATE_LIMIT_POLICY } from '@/lib/security/rate-limit-policy';
import { getRegisteredNavSections, __resetNavRegistryForTests } from '@/lib/admin-nav/registry';

/**
 * One row per `lib/app/*` seam.
 *
 * - `seam` — the file a fork edits, and the test name.
 * - `risk` — what a stray default here would do to every install. This is the
 *   reason the row exists; keep it accurate if you pin a fork value.
 * - `assert` — runs the REAL default and asserts it registers/overrides nothing.
 *   May be async.
 */
interface SeamDefault {
  seam: string;
  risk: string;
  assert: () => void | Promise<void>;
}

/**
 * Seam files deliberately absent from the table below, with the reason. The
 * drift guard at the bottom of this file allows exactly these two.
 */
const UNASSERTED_SEAMS = new Set([
  // Asserted behaviourally instead — see tests/unit/lib/db/drift-probes.test.ts.
  'lib/app/db-drift.ts',
  // The one seam that ships real logic (a classifier) rather than an empty
  // value, so "registers nothing" is not the contract. Covered by its own tests.
  'lib/app/surface.ts',
  // ConQuest-only seam that ships real logic: reads RELEASE_STAGE from the
  // environment and derives IS_PRERELEASE / IS_ALPHA, so "registers nothing" is
  // not the contract here either. Covered by its own tests.
  'lib/app/release-stage.ts',
]);

const SEAM_DEFAULTS: SeamDefault[] = [
  {
    seam: 'lib/app/rate-limit.ts',
    risk: 'a stray tier or rule would re-cap every install',
    assert: () => {
      registerAppRateLimits();
      // No app rules → the effective policy is the base policy BY IDENTITY.
      expect(getEffectiveRateLimitPolicy()).toBe(RATE_LIMIT_POLICY);
    },
  },
  {
    seam: 'lib/app/capabilities.ts',
    risk: 'a stray capability would be dispatchable on every install',
    // Behavioural reach into the dispatcher is covered by bootstrap-wiring.test.ts.
    assert: () => expect(initAppCapabilities()).toBeUndefined(),
  },
  {
    seam: 'lib/app/context-contributors.ts',
    risk: 'a stray contributor would inject prompt context into every chat turn',
    // Behavioural reach into buildContext is covered by context-builder.test.ts.
    assert: () => expect(initAppContextContributors()).toBeUndefined(),
  },
  {
    // FORK FILL — ConQuest registers the questionnaire surface (P2 / F2.1).
    seam: 'lib/app/admin-nav.ts',
    risk: 'an extra section, or a dropped one, would silently reshape the admin sidebar',
    assert: () => {
      __resetNavRegistryForTests();
      initAppNav();
      // Exactly one section: catches both an accidental extra registration and
      // a regression that drops the app nav. Its *contents* are not asserted.
      expect(getRegisteredNavSections()).toHaveLength(1);
    },
  },
  {
    // FORK FILL — ConQuest replaces the marketing nav and the footer nav; the
    // legal footer still tracks the platform default.
    seam: 'lib/app/public-nav.ts',
    risk: 'reverting either list to null would silently restore Sunrise’s marketing nav',
    assert: () => {
      expect(publicNavItems).not.toBeNull();
      expect(footerNavItems).not.toBeNull();
      expect(footerLegalItems).toBeNull();
    },
  },
  {
    seam: 'lib/app/protected-nav.ts',
    risk: 'a stray non-null list would silently REPLACE the authenticated nav',
    assert: () => expect(protectedNavItems).toBeNull(),
  },
  {
    seam: 'lib/app/auth-landing.ts',
    risk: 'a stray value would send every install somewhere else after login',
    assert: () => {
      expect(appAuthLandingRoute).toBeNull();
      expect(appAuthLandingLabel).toBeNull();
    },
  },
  {
    seam: 'lib/app/emails.ts',
    risk: 'a stray override would swap an auth email for every install',
    assert: () => expect(emailOverrides).toEqual({}),
  },
  {
    // FORK FILL — ConQuest collects its questionnaire tables through
    // APP_SUBJECT_DATA_SOURCES (Sunrise 0.8.0 / #467).
    //
    // Asserted structurally rather than by running the collector: the real one
    // issues ~15 Prisma queries, and this file deliberately has no database.
    // The collector's behaviour is covered by its own guard,
    // tests/unit/lib/app/privacy/export-sources.test.ts, which holds the
    // manifest level with prisma/schema/app*.prisma.
    seam: 'lib/app/data-export.ts',
    risk: 'dropping a source silently ships a short answer to a data subject',
    assert: () => {
      expect(typeof collectAppSubjectData).toBe('function');
      // Every source names a distinct bundle section and says what it holds.
      expect(APP_SUBJECT_DATA_SOURCES.length).toBeGreaterThan(0);
      expect(new Set(APP_SUBJECT_DATA_SOURCES.map((s) => s.section)).size).toBe(
        APP_SUBJECT_DATA_SOURCES.length
      );
    },
  },
  {
    seam: 'lib/app/bootstrap.ts',
    risk: 'a stray default would run one-time work on every install boot',
    // That instrumentation calls this in all envs, try/catch-isolated, is
    // covered by tests/unit/instrumentation.test.ts.
    assert: async () => {
      await expect(initApp()).resolves.toBeUndefined();
    },
  },
  {
    seam: 'lib/app/knowledge-access-contributors.ts',
    risk: 'a stray contributor would widen every restricted agent’s document access',
    // Behavioural reach into the resolver is covered by resolveAgentDocumentAccess.test.ts.
    assert: () => expect(initAppKnowledgeAccessContributors()).toBeUndefined(),
  },
  {
    seam: 'lib/app/guard-floor-contributors.ts',
    risk: 'a stray contributor would raise the guard floor on every install',
    assert: () => expect(initAppGuardFloorContributors()).toBeUndefined(),
  },
  {
    seam: 'lib/app/guard-event-contributors.ts',
    risk: 'a stray observer would receive every install’s inline-chat guard events',
    assert: () => expect(initAppGuardEventContributors()).toBeUndefined(),
  },
  {
    seam: 'lib/app/agent-fields.ts',
    risk: 'a stray descriptor would add a field to every install’s agent form',
    assert: () => expect(appAgentFields).toEqual([]),
  },
  {
    seam: 'lib/app/protected-routes.ts',
    risk: 'a stray path would put a public route behind auth on every install',
    assert: () => expect(appProtectedRoutes).toEqual([]),
  },
  {
    seam: 'lib/app/env.ts',
    risk: 'a stray key would make an unset env var fail boot on every install',
    // An empty z.object() accepts (and strips) anything → parses {} to {}.
    assert: () => expect(appEnvSchema.parse({})).toEqual({}),
  },
  {
    seam: 'lib/app/eslint.config.mjs',
    risk: 'a stray flat-config block would apply lint rules to every fork',
    // The root eslint.config.mjs spreads this array last; that spread itself is
    // exercised by every `npm run lint` run.
    assert: () => expect(appEslintConfig).toEqual([]),
  },
  {
    // FORK FILL \u2014 ConQuest runs the two report-queue workers and the app-owned
    // retention prune on the platform tick (moved here from run-tick.ts on the
    // Sunrise 0.8.0 sync, when #469 opened this seam).
    seam: 'lib/app/jobs.ts',
    risk: 'a dropped job silently stops respondent reports or the app-owned prune',
    assert: () => {
      __resetAppJobsForTests();
      // getAppJobs() triggers the lazy init, so this exercises the REAL seam.
      expect(
        getAppJobs()
          .map((j) => j.name)
          .sort()
      ).toEqual(['app:appRetention', 'app:respondentReportRevisions', 'app:respondentReports']);
    },
  },
  {
    seam: 'lib/app/user-created.ts',
    risk: 'a stray hook would run on every signup on every install',
    assert: () => expect(initAppUserCreatedHooks()).toBeUndefined(),
  },
  {
    // ConQuest-only seam (no upstream counterpart yet).
    seam: 'lib/app/config-health.ts',
    risk: 'a stray check would fire on every install’s config-health panel',
    assert: () => expect(appConfigHealthChecks).toEqual([]),
  },
  {
    // FORK FILL — the two video-embed hosts ConQuest's intro-video feature can
    // produce (moved off lib/security/headers.ts on the Sunrise 0.8.0 sync,
    // when #450 opened this seam).
    seam: 'lib/app/csp.ts',
    risk: 'an extra origin here widens the iframe policy — a security change, not a cosmetic one',
    // These values are spliced straight into a response header, so the list is
    // pinned exactly rather than merely checked non-empty.
    assert: () =>
      expect(appFrameSrc).toEqual(['https://www.youtube-nocookie.com', 'https://player.vimeo.com']),
  },
];

afterEach(() => {
  __resetNavRegistryForTests();
});

describe('lib/app/ seams ship empty', () => {
  it.each(SEAM_DEFAULTS)('$seam registers nothing by default', async ({ assert }) => {
    await assert();
  });

  it('has a row for every seam file in lib/app/', () => {
    // Drift guard: adding a `lib/app/*` seam without adding a row above would
    // leave it silently unprotected. Reads the directory rather than trusting
    // the table to be complete.
    const dir = path.join(process.cwd(), 'lib/app');
    const onDisk = readdirSync(dir)
      .filter((f) => /\.(ts|mjs)$/.test(f) && !f.endsWith('.d.ts'))
      .map((f) => `lib/app/${f}`);

    const covered = new Set(SEAM_DEFAULTS.map((s) => s.seam));
    const missing = onDisk.filter((f) => !covered.has(f) && !UNASSERTED_SEAMS.has(f));
    const stale = [...covered].filter((f) => !onDisk.includes(f));

    expect(missing, 'lib/app/ seam with no row in SEAM_DEFAULTS').toEqual([]);
    expect(stale, 'SEAM_DEFAULTS row for a file that no longer exists').toEqual([]);
  });
});
