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
 * `capabilities`, `jobs`, `csp`, `data-export`, `brand` and `reserved-tiers`.
 *
 * Content is deliberately NOT asserted for the nav seams — links and copy change
 * routinely and a unit test should not break on a copy edit. The override
 * *behaviour* (replace-vs-fallback) is covered content-agnostically in
 * `public-nav.test.tsx` and `protected-nav.test.tsx`.
 *
 * @see lib/app/ · CUSTOMIZATION.md §4
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';
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
import { footerCopyright } from '@/lib/app/footer';
import { APP_API_KEY_SCOPES } from '@/lib/app/api-key-scopes';
import { listValidApiKeyScopes, CORE_API_KEY_SCOPES } from '@/lib/auth/api-key-scopes';
import appEslintConfig from '@/lib/app/eslint.config.mjs';
import { appFrameSrc } from '@/lib/app/csp';
import { occupiedTiers } from '@/lib/app/reserved-tiers';
import { initAppUserCreatedHooks } from '@/lib/app/user-created';
import { collectAppSubjectData } from '@/lib/app/data-export';
import {
  APP_SUBJECT_DATA_SOURCES,
  APP_EXCLUDED_SOURCES,
} from '@/lib/app/questionnaire/privacy/export-sources';
import { appConfigHealthChecks } from '@/lib/app/config-health';
import {
  getAppSubjectSources,
  getAppExcludedSubjectSources,
  __resetAppSubjectSourceRegistryForTests,
} from '@/lib/privacy/subject-source-registry';
import { getAppJobs, __resetAppJobsForTests } from '@/lib/orchestration/maintenance/app-jobs';
import { getEffectiveRateLimitPolicy, RATE_LIMIT_POLICY } from '@/lib/security/rate-limit-policy';
import { getRegisteredNavSections, __resetNavRegistryForTests } from '@/lib/admin-nav/registry';
import {
  listAppMcpResourceTypes,
  listAllowedMcpResourceUriSchemes,
  __resetAppMcpResourcesForTests,
} from '@/lib/orchestration/mcp/resource-registry';
import {
  listGraders,
  __resetGraderRegistryForTests,
} from '@/lib/orchestration/evaluations/graders/registry';
import {
  ACCOUNT_SURFACES,
  getRegisteredAccountSections,
  __resetAccountSectionRegistryForTests,
} from '@/lib/account-sections/registry';

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
/** This file's own repo-relative path — the one place importActual is allowed. */
const THIS_FILE = path.join('tests', 'unit', 'lib', 'app', 'defaults.test.ts');

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
    seam: 'lib/app/footer.ts',
    risk: 'a stray value would rewrite — or silently remove — the attribution line on every install, on both the public and authenticated footers',
    assert: () => expect(footerCopyright).toBeNull(),
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
    // FORK FILL — ConQuest exports app-tier questionnaire data, so the upstream
    // "seam is empty" row is replaced by its mirror image: the seam must be
    // FILLED, and its two halves must agree. Sunrise 0.10.0 (#660) added the
    // declaration half; before it, ConQuest patched the platform coverage guard
    // to skip `App*` models, and that fork edit is now gone.
    risk: 'dropping a source silently ships a short answer to a data subject; dropping a declaration hides a table from the coverage guard that would have named it',
    assert: () => {
      expect(typeof collectAppSubjectData).toBe('function');
      // Every source names a distinct bundle section and says what it holds.
      expect(APP_SUBJECT_DATA_SOURCES.length).toBeGreaterThan(0);
      expect(new Set(APP_SUBJECT_DATA_SOURCES.map((s) => s.section)).size).toBe(
        APP_SUBJECT_DATA_SOURCES.length
      );
      // The declaration half. The read triggers the lazy init, so this exercises
      // the REAL seam — and proves `initAppSubjectSources()` is actually wired,
      // which is what the platform guard reads.
      __resetAppSubjectSourceRegistryForTests();
      expect(getAppSubjectSources().map((source) => source.model).sort()).toEqual(
        APP_SUBJECT_DATA_SOURCES.map((source) => source.model).sort()
      );
      expect(getAppExcludedSubjectSources().map((entry) => entry.model).sort()).toEqual(
        APP_EXCLUDED_SOURCES.map((entry) => entry.model).sort()
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
    seam: 'lib/app/mcp-resources.ts',
    risk: 'a stray handler would expose app data over MCP to every install\u2019s connected clients',
    assert: () => {
      __resetAppMcpResourcesForTests();
      // Both readers trigger the lazy init, so this exercises the REAL seam.
      expect(listAppMcpResourceTypes()).toEqual([]);
      // Core's own scheme, and nothing else.
      expect(listAllowedMcpResourceUriSchemes()).toEqual(['sunrise']);
    },
  },
  {
    seam: 'lib/app/evaluations.ts',
    risk: 'a stray grader would appear in every install\u2019s metric picker \u2014 and, on a slug core already uses, would silently rescore every run',
    assert: () => {
      // The registry module is driven directly, so core's barrel has not
      // side-effect-registered anything: whatever listGraders() returns here
      // came from the seam. The read triggers the lazy init, so this exercises
      // the REAL file.
      __resetGraderRegistryForTests();
      expect(listGraders()).toEqual([]);
    },
  },
  {
    seam: 'lib/app/account-sections.ts',
    risk: 'a stray section would appear on every install\u2019s /profile and /settings',
    assert: () => {
      __resetAccountSectionRegistryForTests();
      // The read triggers the lazy init, so this exercises the REAL seam.
      for (const surface of ACCOUNT_SURFACES) {
        expect(getRegisteredAccountSections(surface)).toEqual([]);
      }
    },
  },
  {
    seam: 'lib/app/api-key-scopes.ts',
    risk: 'a stray scope would be mintable on every install \u2014 and a name colliding with a core scope would change what an existing key satisfies',
    assert: () => {
      expect(APP_API_KEY_SCOPES).toEqual([]);
      // …and the union it feeds is exactly core, by value not just by length.
      expect(listValidApiKeyScopes()).toEqual([...CORE_API_KEY_SCOPES]);
    },
  },
  {
    seam: 'lib/app/reserved-tiers.ts',
    // FORK FILL — ConQuest is a leaf fork and really does fill both of these
    // (117 files under components/app, 219 under .context/app), so the upstream
    // emptiness rows for them are unsatisfiable here. Pinned exactly rather than
    // merely non-empty: each name switches a live guard OFF, and the three tiers
    // NOT listed must stay guarded. `lib/framework`, `.context/framework` and
    // `components/framework` are deliberately absent — ConQuest is not a
    // framework-layer fork, and components/framework holds only its .gitkeep.
    risk: 'a stray entry would switch OFF the guard that keeps a reserved tier empty — the three tiers not listed here are still core-owned promises',
    assert: () => expect([...occupiedTiers].sort()).toEqual(['.context/app', 'components/app']),
  },
  {
    seam: 'lib/app/brand.ts',
    risk: 'a stray value would rebrand every install — page titles, both footers’ copyright line, the root meta description and every transactional email — and the legal-entity field is a legal-attribution surface, not a cosmetic one',
    // `importActual`, NOT a plain import: tests/setup.ts pins this seam to null
    // for the whole suite so that no core test reads a fork's brand. Importing
    // it normally here would therefore assert the MOCK ships null, which is true
    // by construction and would keep passing in a fork that had filled the real
    // file — turning the one row that tells a fork to pin its value into a row
    // that can never fail.
    //
    // FORK FILL — ConQuest sets all three. These moved out of `.env` on the
    // Sunrise 0.11.0 sync, when #661 deleted `NEXT_PUBLIC_APP_NAME`,
    // `NEXT_PUBLIC_LEGAL_NAME` and `NEXT_PUBLIC_APP_DESCRIPTION`; on a container
    // build the env vars had never reached the bundle at all, so the fork was
    // shipping "© <year> Sunrise" while believing itself configured. Pinned
    // exactly, because the legal-entity field is a legal-attribution surface.
    assert: async () => {
      const seam = await vi.importActual<typeof import('@/lib/app/brand')>('@/lib/app/brand');
      expect(seam.appBrandName).toBe('ConQuest');
      expect(seam.appBrandLegalName).toBe('All Too Human Ltd');
      expect(seam.appBrandDescription).toBe(
        'Answer a questionnaire in conversation, not in form fields.'
      );
    },
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
  __resetAccountSectionRegistryForTests();
});

describe('lib/app/ seams ship empty', () => {
  it.each(SEAM_DEFAULTS)('$seam registers nothing by default', async ({ assert }) => {
    await assert();
  });

  it('nothing but this file escapes the suite-wide brand-seam pin', () => {
    // tests/setup.ts mocks `@/lib/app/brand` to null for EVERY test file, so
    // that no core test can read a fork's brand and fail for a reason the fork
    // cannot fix (#660/#661). That guarantee holds across all ~1095 test files
    // by construction, but only while nothing escapes the mock.
    //
    // `vi.importActual` is legitimate here and nowhere else: it is what makes
    // the brand row above assert the REAL scaffold rather than the mock, which
    // is what keeps "seams ship empty" able to fail in a fork.
    //
    // `vi.doUnmock` is never right. It REMOVES the pin instead of restoring it,
    // so every later case in that file sees the real seam. That is not
    // hypothetical: it shipped twice during this change — once in this suite's
    // own brand tests (13 cases failed against a filled seam) and once in
    // layout-metadata, where it was invisible only because every remaining case
    // happened to re-stub first. To go back to the null default mid-file,
    // re-`doMock` it; do not unmock it.
    //
    // Matched by REGEX over vitest's whole unmocking surface, not by two string
    // literals. The literal version missed `vi.unmock` — a third escape route —
    // and was also defeated by double quotes or a line-wrapped call. That is the
    // enumerating-guard failure mode this repo keeps meeting: it fails one
    // instance per round. vitest exposes exactly `unmock` and `doUnmock` for
    // removing a mock, so anchoring on `(?:do)?unmock` is exhaustive over the API
    // rather than over the spellings someone happened to think of.
    const seamPath = String.raw`['"\`]@/lib/app/brand['"\`]`;
    const unmockRe = new RegExp(String.raw`\bvi\s*\.\s*(?:do)?[Uu]nmock\s*\(\s*` + seamPath);
    const actualRe = new RegExp(String.raw`importActual[\s\S]{0,80}?` + seamPath);

    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;
        const src = readFileSync(full, 'utf8');
        const rel = path.relative(process.cwd(), full);
        if (unmockRe.test(src)) {
          offenders.push(`${rel}: unmocks the pin instead of restoring it`);
        }
        if (actualRe.test(src) && rel !== THIS_FILE) {
          offenders.push(`${rel}: reads the real seam past the pin`);
        }
      }
    };
    walk(path.join(process.cwd(), 'tests'));

    expect(
      offenders,
      'These test files escape the brand-seam pin in tests/setup.ts. A fork that ' +
        'fills lib/app/brand.ts would see its own brand here and fail a core test ' +
        'it cannot fix — the exact class #660 is about. Re-doMock the null values ' +
        'instead of unmocking, and leave importActual to this file.'
    ).toEqual([]);
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
