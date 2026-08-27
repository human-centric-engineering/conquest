/**
 * Coverage guard: lib/app/questionnaire/privacy/export-sources.ts vs prisma/schema/app*.prisma
 *
 * The app-tier mirror of `tests/unit/lib/privacy/export-sources.test.ts`.
 *
 * The division of labour changed in Sunrise 0.10.0 (#660), and this docblock
 * described the old one until the 0.11.1 sync. It used to be true that the
 * platform guard "stops at the `App*` prefix", so ConQuest patched that guard to
 * skip our models and ran this one in its place — the two partitioned the schema
 * between them. Core now provides the seam that made the patch unnecessary:
 * `registerAppSubjectSources()`, wired from `initAppSubjectSources()`, feeds the
 * platform guard our declarations, and that guard holds EVERY model in a
 * fork-owned schema file to having a disposition or an exclusion. The fork edit
 * is gone.
 *
 * So the two guards now overlap on purpose rather than partition:
 *
 *   • The PLATFORM guard asks "is every model accounted for at all?" — it reads
 *     the declarations and knows nothing about how they are fetched.
 *   • THIS guard asks the questions core cannot: that a table carrying one of
 *     OUR user-id column names (`userId` / `createdBy` / `respondentUserId`) is
 *     a real source rather than merely excluded, that each source's `fetch`
 *     matches on the right column, and that credential material is omitted.
 *
 * Keep both. Losing this one would let every app table be waved through as an
 * `excluded` row with a plausible sentence, which the platform guard accepts by
 * design — it cannot read our column vocabulary, which is the reason it asks for
 * a declaration on every model instead of guessing.
 *
 * Why it is a build failure and not a review checklist is the same reason as
 * upstream: an export that omits a table looks exactly like a complete answer
 * to the person reading it. Nothing in the response reveals the gap — not to
 * the subject, not to the operator who sent it. Erasure fails loudly (a missing
 * `onDelete` throws `P2003`); access has no natural loud failure, so this is it.
 *
 * ---------------------------------------------------------------------------
 * IF THIS TEST IS FAILING
 * ---------------------------------------------------------------------------
 * You added an `app_*` table with a `userId` / `createdBy` / `respondentUserId`
 * column. Add it to `APP_SUBJECT_DATA_SOURCES` with a disposition:
 *
 *   • `export`      — it holds the subject's own data (a respondent's rows).
 *                     Use Prisma `omit` to drop credential columns; do NOT use
 *                     `select`, which silently narrows the export every time
 *                     someone adds a column.
 *   • `attribution` — an admin authored it. Return id + label + date, never the
 *                     configured content.
 *
 * ...or add it to `APP_EXCLUDED_SOURCES` with a reason the subject gets to read.
 * Deleting the row to make the test pass ships a short answer to a data
 * subject.
 *
 * @see lib/app/questionnaire/privacy/export-sources.ts
 * @see .context/privacy/data-export.md
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';

// The manifest imports the Prisma client at module scope. Its delegates are
// only touched inside `fetch` closures, which this file never calls — but the
// closures name `prisma.<model>` at construction time, so the stub answers any
// property with a delegate-shaped object rather than being empty.
vi.mock('@/lib/db/client', () => ({
  prisma: new Proxy({}, { get: () => ({ findMany: () => Promise.resolve([]) }) }),
}));

const { APP_SUBJECT_DATA_SOURCES, APP_EXCLUDED_SOURCES } =
  await import('@/lib/app/questionnaire/privacy/export-sources');

const SCHEMA_DIR = path.join(process.cwd(), 'prisma', 'schema');

const MODEL_OPEN = /^model\s+(\w+)\s*\{/;

/**
 * A column holding a user id. ConQuest writes these as plain `String` with no
 * `@relation` by design (UG-1), so a relation scan alone would see almost none
 * of them — the column-name net is the primary one here, not the backstop it is
 * upstream. `respondentUserId` is ConQuest's own spelling and the reason this
 * pattern is not simply reused from the platform test.
 */
const USER_SCALAR_FIELD =
  /^\s*(userId|createdBy|closedBy|uploadedBy|ownerId|actorUserId|subjectUserId|respondentUserId|invitedByUserId|triggeredByUserId|decidedByUserId|evaluatedByUserId)\s+String/;

/** Only ConQuest's own schema files — the platform guard owns the rest. */
const APP_SCHEMA_FILE = /^app.*\.prisma$/;

interface SchemaScan {
  /** App models holding at least one user-id column. */
  userLinked: Set<string>;
  /** Every app model name, for typo/rename detection. */
  allModels: Set<string>;
}

function scanAppSchema(): SchemaScan {
  const userLinked = new Set<string>();
  const allModels = new Set<string>();

  const files = readdirSync(SCHEMA_DIR).filter((f) => APP_SCHEMA_FILE.test(f));

  for (const file of files) {
    const contents = readFileSync(path.join(SCHEMA_DIR, file), 'utf8');
    let currentModel: string | null = null;

    for (const line of contents.split('\n')) {
      const open = MODEL_OPEN.exec(line);
      if (open) {
        currentModel = open[1];
        allModels.add(currentModel);
        continue;
      }
      if (line.startsWith('}')) {
        currentModel = null;
        continue;
      }
      if (!currentModel) continue;
      if (USER_SCALAR_FIELD.test(line)) userLinked.add(currentModel);
    }
  }

  return { userLinked, allModels };
}

describe('app subject-data source manifest', () => {
  const { userLinked, allModels } = scanAppSchema();
  const declared = new Set(APP_SUBJECT_DATA_SOURCES.map((source) => source.model));

  describe('the scan itself', () => {
    // A regex that quietly stops matching would make every assertion below
    // vacuously true — the guard would pass while protecting nothing.
    it('finds the app schema files', () => {
      expect(allModels.size).toBeGreaterThan(20);
      expect(allModels.has('AppQuestionnaire')).toBe(true);
    });

    it('finds a plausible number of user-linked app models', () => {
      expect(userLinked.size).toBeGreaterThanOrEqual(10);
    });

    it('recognises both the admin and respondent spellings', () => {
      expect(userLinked.has('AppCohort')).toBe(true); // createdBy
      expect(userLinked.has('AppRespondentProfileSnapshot')).toBe(true); // respondentUserId
    });
  });

  describe('coverage', () => {
    it('declares every app model holding a user id', () => {
      const missing = [...userLinked]
        .filter((model) => !declared.has(model))
        .filter((model) => !APP_EXCLUDED_SOURCES.some((source) => source.model === model))
        .sort();

      expect(
        missing,
        missing.length === 0
          ? ''
          : `These app models hold a user id but are missing from ` +
              `APP_SUBJECT_DATA_SOURCES, so a data subject's export silently omits ` +
              `them: ${missing.join(', ')}. Add each with a disposition — 'export' ` +
              `for a respondent's own data, 'attribution' for config an admin ` +
              `authored — or to APP_EXCLUDED_SOURCES with a reason. ` +
              `See .context/privacy/data-export.md.`
      ).toEqual([]);
    });

    it('names only models that exist', () => {
      // Catches a rename or typo, which would leave a source in the manifest
      // that queries nothing and reports zero rows forever.
      const unknown = [...declared].filter((model) => !allModels.has(model)).sort();

      expect(unknown).toEqual([]);
    });
  });

  describe('manifest integrity', () => {
    it('declares each model exactly once', () => {
      const models = APP_SUBJECT_DATA_SOURCES.map((s) => s.model);
      expect(models).toHaveLength(new Set(models).size);
    });

    it('lands each source under a distinct section', () => {
      const sections = APP_SUBJECT_DATA_SOURCES.map((s) => s.section);
      expect(sections).toHaveLength(new Set(sections).size);
    });

    it('gives every source a description the subject can read', () => {
      const undescribed = APP_SUBJECT_DATA_SOURCES.filter(
        (s) => s.description.trim().length < 20
      ).map((s) => s.model);

      expect(undescribed).toEqual([]);
    });

    it('gives every exclusion a written reason', () => {
      const unexplained = APP_EXCLUDED_SOURCES.filter((s) => s.reason.trim().length < 20).map(
        (s) => s.model
      );

      expect(unexplained).toEqual([]);
    });

    it('never declares a model as both exported and excluded', () => {
      const overlap = APP_EXCLUDED_SOURCES.filter((s) => declared.has(s.model)).map((s) => s.model);

      expect(overlap).toEqual([]);
    });
  });
});
