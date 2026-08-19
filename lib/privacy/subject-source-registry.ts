/**
 * App subject-data source registry (GDPR Art. 15) — the fork half of the
 * coverage guard.
 *
 * `lib/privacy/export-sources.ts` answers "which tables count as this person's
 * data?" for core, and `tests/unit/lib/privacy/export-sources.test.ts` holds it
 * level with `prisma/schema/*.prisma` so a new core table cannot quietly narrow
 * an export. That guard scanned **every** schema file — including the
 * fork-reserved `app.prisma` and `framework-*.prisma` — while checking against a
 * manifest only core can write to. So a fork that filled `collectAppSubjectData`
 * exactly as documented still had a red core test, and the only way to green it
 * was to edit a Sunrise-owned file (#533).
 *
 * This registry is where a fork declares instead. Core folds what is registered
 * here into the same guard, so fork tables keep the protection rather than being
 * skipped — the alternative fix, exempting the fork namespaces from the scan,
 * would have turned a noisy false positive into a *silent false negative*, and
 * silence is the one failure mode an access request cannot survive.
 *
 * **Why a registry and not one exported constant.** `CLAUDE.md` reserves two
 * fork tiers, `/app` for a leaf fork and `/framework` for a tier sitting between
 * Sunrise and its own leaf forks. A single constant is one slot: a framework
 * tier filling it consumes the seam its leaves are entitled to, which is exactly
 * the collision the reservation exists to prevent. Each tier registers its own
 * contribution here and neither locks the other out.
 *
 * ```ts
 * // lib/framework/privacy/export-sources.ts — called from initFramework()
 * registerAppSubjectSources({
 *   tier: 'framework',
 *   sources: [
 *     {
 *       model: 'FrameworkTask',
 *       section: 'tasks',
 *       disposition: 'export',
 *       description: 'Tasks you created or were assigned.',
 *     },
 *   ],
 *   excluded: [{ model: 'FrameworkTaskTag', reason: 'Join table — holds two ids and no personal data.' }],
 * });
 * ```
 *
 * **Declaring is a promise the export keeps.** Every declared `section` must
 * appear in what `collectAppSubjectData()` returns — `exportUserData()` throws
 * if one is missing, because a bundle short by a section reads exactly like a
 * complete answer to the person receiving it. Return the key with an empty
 * array when the subject has no rows; do not omit it.
 *
 * **Realm.** Declarations are plain data, so this module imports no Prisma and
 * is safe for `lib/app/**` to reach. The check that a declaration does not
 * collide with a *core* model deliberately lives in the guard test rather than
 * here: doing it at registration would mean importing the core manifest, which
 * imports the Prisma client, and would drag the database into the extension
 * surface. The guard is where a collision has to be loud anyway.
 *
 * @see lib/app/data-export.ts — the fork-owned scaffold that calls this
 * @see lib/privacy/export-sources.ts — the core manifest this parallels
 * @see .context/privacy/data-export.md — the guide
 */

import { logger } from '@/lib/logging';
import { initAppSubjectSources } from '@/lib/app/data-export';
import type { SourceDisposition } from '@/lib/privacy/export-sources';

/**
 * One fork-owned model and how it is represented in a subject export.
 *
 * The core {@link import('@/lib/privacy/export-sources').SubjectDataSource}
 * minus its `fetch`: the rows still come from `collectAppSubjectData()`, which
 * stays a static import precisely so an unregistered *collector* is impossible.
 * This declares what that collector is expected to produce.
 */
export interface AppSubjectDataSource {
  /** Prisma model name, exactly as written in your tier's `.prisma` file. */
  model: string;
  /** Key this source lands under inside the bundle's `app` section. */
  section: string;
  /** `export` for the subject's own data; `attribution` for config they created. */
  disposition: SourceDisposition;
  /** One line on why this is the subject's data. Shown to a reader of the manifest. */
  description: string;
}

/** A fork-owned model deliberately left out of the export, with the reason. */
export interface AppExcludedSubjectSource {
  model: string;
  reason: string;
}

/** One tier's contribution. */
export interface AppSubjectSourceContribution {
  /**
   * Which tier is declaring — `'app'` for a leaf fork, `'framework'` for a
   * framework tier, or whatever names yours. Used only in diagnostics, so that
   * a rejected row says who tried to register it.
   */
  tier: string;
  sources?: readonly AppSubjectDataSource[];
  excluded?: readonly AppExcludedSubjectSource[];
}

/** Registered sources, keyed by model so a repeat registration is idempotent. */
const sources = new Map<string, AppSubjectDataSource>();
/** Registered exclusions, keyed by model. */
const excluded = new Map<string, AppExcludedSubjectSource>();
/** Which tier registered each model, for the duplicate-across-tiers message. */
const owners = new Map<string, string>();

/** Whether the auto-wired app declaration init has run. */
let appInited = false;

/** Mirrors the core manifest's own guard on `description`. */
const MIN_DESCRIPTION = 10;
/** Mirrors the core manifest's own guard on an exclusion `reason`. */
const MIN_REASON = 20;

function reject(tier: string, model: string, why: string): void {
  // Rejected rows are not silently absorbed: the model stays undeclared, so the
  // coverage guard fails naming it. This log says *why* it was dropped, which
  // the guard cannot know.
  logger.error('subject-sources: declaration rejected', { tier, model, reason: why });
}

/**
 * Declare the models your tier holds about a data subject.
 *
 * Call at module-import time from `lib/app/data-export.ts`'s
 * `initAppSubjectSources()` (leaf tier), or from your framework tier's own init
 * that the leaf's seam invokes. Idempotent by model, so a repeated import
 * re-registers rather than duplicating.
 *
 * A malformed row is dropped with a log rather than throwing: throwing would
 * abort the whole contribution and lose the tier's valid declarations too. The
 * dropped model is then unaccounted for, which fails the coverage guard by
 * name — loud, and at build time.
 */
export function registerAppSubjectSources(contribution: AppSubjectSourceContribution): void {
  const { tier } = contribution;

  for (const source of contribution.sources ?? []) {
    const model = source.model?.trim() ?? '';
    const section = source.section?.trim() ?? '';

    if (model === '') {
      reject(tier, String(source.model), 'model is empty');
      continue;
    }
    if (section === '') {
      reject(tier, model, 'section is empty');
      continue;
    }
    if (source.disposition !== 'export' && source.disposition !== 'attribution') {
      reject(tier, model, `disposition must be 'export' or 'attribution'`);
      continue;
    }
    if ((source.description ?? '').trim().length < MIN_DESCRIPTION) {
      reject(tier, model, `description must be at least ${MIN_DESCRIPTION} characters`);
      continue;
    }
    if (excluded.has(model)) {
      reject(tier, model, 'already declared as an exclusion — a model is one or the other');
      continue;
    }

    const owner = owners.get(model);
    if (owner !== undefined && owner !== tier) {
      reject(tier, model, `already declared by tier '${owner}'`);
      continue;
    }

    // A section collision would have one source overwrite the other inside the
    // bundle's `app` key — silent loss, with both models still accounted for.
    const collision = [...sources.values()].find(
      (existing) => existing.section === section && existing.model !== model
    );
    if (collision) {
      reject(tier, model, `section '${section}' is already used by ${collision.model}`);
      continue;
    }

    sources.set(model, { ...source, model, section });
    owners.set(model, tier);
  }

  for (const entry of contribution.excluded ?? []) {
    const model = entry.model?.trim() ?? '';

    if (model === '') {
      reject(tier, String(entry.model), 'model is empty');
      continue;
    }
    if ((entry.reason ?? '').trim().length < MIN_REASON) {
      // The reason is the whole value of an exclusion — it is what a reader
      // (and, through the manifest, a regulator) is shown in place of the data.
      reject(tier, model, `reason must be at least ${MIN_REASON} characters`);
      continue;
    }
    if (sources.has(model)) {
      reject(tier, model, 'already declared as a source — a model is one or the other');
      continue;
    }

    const owner = owners.get(model);
    if (owner !== undefined && owner !== tier) {
      reject(tier, model, `already declared by tier '${owner}'`);
      continue;
    }

    excluded.set(model, { ...entry, model });
    owners.set(model, tier);
  }
}

/**
 * Run the fork's auto-wired declaration init exactly once, lazily. Latch BEFORE
 * running so a throwing init neither retries nor propagates.
 *
 * On a throw the registry is rolled back to what it held before, rather than
 * keeping the declarations made up to the throw. Half a tier's declarations
 * would leave the coverage guard green for the models that registered and red
 * for the rest — a failure list that changes with the position of a bug, which
 * is worse than the whole contribution being absent and the guard naming every
 * model in the file.
 */
function ensureAppSubjectSourcesInited(): void {
  if (appInited) return;
  appInited = true;

  const beforeSources = new Map(sources);
  const beforeExcluded = new Map(excluded);
  const beforeOwners = new Map(owners);

  try {
    initAppSubjectSources();
  } catch (err) {
    sources.clear();
    for (const [model, source] of beforeSources) sources.set(model, source);
    excluded.clear();
    for (const [model, entry] of beforeExcluded) excluded.set(model, entry);
    owners.clear();
    for (const [model, tier] of beforeOwners) owners.set(model, tier);

    logger.error(
      'subject-sources: initAppSubjectSources threw — app declarations rolled back and disabled',
      { error: err instanceof Error ? err.message : String(err) }
    );
  }
}

/** Every declared app-owned source, in registration order. */
export function getAppSubjectSources(): AppSubjectDataSource[] {
  ensureAppSubjectSourcesInited();
  return [...sources.values()];
}

/** Every app-owned model declared as deliberately excluded, with its reason. */
export function getAppExcludedSubjectSources(): AppExcludedSubjectSource[] {
  ensureAppSubjectSourcesInited();
  return [...excluded.values()];
}

/**
 * Every app-owned model that some tier has accounted for — exported or
 * excluded. This is what the coverage guard diffs the fork-reserved schema
 * files against.
 */
export function getAccountedAppModels(): Set<string> {
  ensureAppSubjectSourcesInited();
  return new Set([...sources.keys(), ...excluded.keys()]);
}

/** Test-only: clear the registry and re-arm the one-shot app init. */
export function __resetAppSubjectSourceRegistryForTests(): void {
  sources.clear();
  excluded.clear();
  owners.clear();
  appInited = false;
}
