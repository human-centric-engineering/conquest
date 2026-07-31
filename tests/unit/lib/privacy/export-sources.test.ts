/**
 * Coverage guard: lib/privacy/export-sources.ts vs prisma/schema/*.prisma
 *
 * This is the test issue #467 asks for. It holds the subject-access manifest
 * level with the schema, so a table that relates to `User` cannot be added
 * without someone deciding what a data subject receives from it.
 *
 * Why it has to be a *build* failure rather than a review checklist: an export
 * that omits a table looks exactly like a complete answer to the person reading
 * it. Nothing about the response reveals the gap — not to the subject, not to
 * the operator who sent it. Erasure has the mirror-image rule (a missing
 * `onDelete` throws `P2003` and breaks erasure loudly); access has no natural
 * loud failure, so this test is it.
 *
 * ---------------------------------------------------------------------------
 * IF THIS TEST IS FAILING
 * ---------------------------------------------------------------------------
 * You added a model with a `userId` / `createdBy` FK to `User`. Add it to
 * `SUBJECT_DATA_SOURCES` with a disposition:
 *
 *   • `export`      — it holds the subject's own data. Use Prisma `omit` to
 *                     drop credential columns; do NOT use `select`, which
 *                     silently narrows the export every time a column is added.
 *   • `attribution` — it is org config they created. Return id + label + date.
 *
 * Deleting the row to make the test pass ships a short answer to a data
 * subject. See `.context/privacy/data-export.md`.
 *
 * @see lib/privacy/export-sources.ts
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';

// The manifest imports the Prisma client at module scope. Its delegates are
// only touched inside `fetch` closures, which this file never calls — the stub
// just keeps the import from standing up a real client.
vi.mock('@/lib/db/client', () => ({ prisma: {} }));

const { SUBJECT_DATA_SOURCES, EXCLUDED_SOURCES } = await import('@/lib/privacy/export-sources');

const SCHEMA_DIR = path.join(process.cwd(), 'prisma', 'schema');

/** A field declaring an FK to `User` — `creator User? @relation(...)`. */
const USER_RELATION_FIELD = /^\s*\w+\s+User\??\s+@relation\(/;
const MODEL_OPEN = /^model\s+(\w+)\s*\{/;

interface SchemaScan {
  /** Models that declare at least one FK to `User`. */
  userLinked: Set<string>;
  /** Every model name in the schema, for typo/rename detection. */
  allModels: Set<string>;
}

function scanSchema(): SchemaScan {
  const userLinked = new Set<string>();
  const allModels = new Set<string>();

  const files = readdirSync(SCHEMA_DIR).filter((file) => file.endsWith('.prisma'));

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
      // `model User` itself holds the back-relations (`AiAgent[]`), whose field
      // type is the other model — they never match the User-typed pattern, so
      // User is excluded naturally rather than by special case.
      if (currentModel && USER_RELATION_FIELD.test(line)) {
        userLinked.add(currentModel);
      }
    }
  }

  return { userLinked, allModels };
}

describe('subject-data source manifest', () => {
  const { userLinked, allModels } = scanSchema();
  const declared = new Set(SUBJECT_DATA_SOURCES.map((source) => source.model));

  describe('the scan itself', () => {
    // A regex that quietly stops matching would make every assertion below
    // vacuously true — the guard would pass while protecting nothing. These two
    // rows are the guard on the guard.
    it('finds the schema files', () => {
      expect(allModels.size).toBeGreaterThan(40);
      expect(allModels.has('User')).toBe(true);
    });

    it('finds a plausible number of User-linked models', () => {
      expect(userLinked.size).toBeGreaterThanOrEqual(25);
    });

    it('recognises both FK spellings', () => {
      // `userId` (Cascade, personal data) and `createdBy` (SetNull, retained).
      expect(userLinked.has('Session')).toBe(true);
      expect(userLinked.has('AiAgent')).toBe(true);
    });
  });

  describe('coverage', () => {
    it('declares every User-linked model', () => {
      const missing = [...userLinked].filter((model) => !declared.has(model)).sort();

      expect(
        missing,
        missing.length === 0
          ? ''
          : `These models relate to User but are missing from SUBJECT_DATA_SOURCES, so a ` +
              `data subject's export silently omits them: ${missing.join(', ')}. ` +
              `Add each with a disposition — 'export' for the subject's own data ` +
              `(use Prisma \`omit\` for credential columns), 'attribution' for org ` +
              `config they created. See .context/privacy/data-export.md.`
      ).toEqual([]);
    });

    it('names only models that exist', () => {
      // Catches a rename or typo, which would otherwise leave a source in the
      // manifest that queries nothing and reports zero rows forever.
      const unknown = SUBJECT_DATA_SOURCES.map((source) => source.model)
        .filter((model) => !allModels.has(model))
        .sort();

      expect(unknown).toEqual([]);
    });

    it('covers ContactSubmission, which has no User FK', () => {
      // The public contact form takes an address, not a session, so this table
      // is matched by email and is invisible to the scan above. It is in the
      // manifest by hand — this row is what stops a tidy-up from dropping it.
      expect(declared.has('ContactSubmission')).toBe(true);
      expect(userLinked.has('ContactSubmission')).toBe(false);
    });
  });

  describe('manifest integrity', () => {
    it('lists each model once', () => {
      const models = SUBJECT_DATA_SOURCES.map((source) => source.model);
      expect(models).toHaveLength(new Set(models).size);
    });

    it('gives each source its own section key', () => {
      // A collision would have one source overwrite another in the bundle —
      // silent data loss with a passing coverage check.
      const sections = SUBJECT_DATA_SOURCES.map((source) => source.section);
      expect(sections).toHaveLength(new Set(sections).size);
    });

    it('describes every source for the subject', () => {
      // The descriptions are echoed in the export's `meta`; a blank one leaves
      // the reader guessing what a section is.
      const undescribed = SUBJECT_DATA_SOURCES.filter(
        (source) => source.description.trim().length < 10
      ).map((source) => source.model);

      expect(undescribed).toEqual([]);
    });

    it('uses only the two known dispositions', () => {
      const dispositions = new Set(SUBJECT_DATA_SOURCES.map((source) => source.disposition));
      expect([...dispositions].sort()).toEqual(['attribution', 'export']);
    });
  });

  describe('documented exclusions', () => {
    it('gives a reason for each', () => {
      const unexplained = EXCLUDED_SOURCES.filter((source) => source.reason.trim().length < 20).map(
        (source) => source.model
      );

      expect(unexplained).toEqual([]);
    });

    it('refers to models that exist', () => {
      const unknown = EXCLUDED_SOURCES.map((source) => source.model)
        .filter((model) => !allModels.has(model))
        .sort();

      expect(unknown).toEqual([]);
    });

    it('never excludes a model that is also exported', () => {
      const both = EXCLUDED_SOURCES.map((source) => source.model).filter((model) =>
        declared.has(model)
      );

      expect(both).toEqual([]);
    });

    it('never excludes a User-linked model', () => {
      // The exclusion list is for tables a reader would wonder about, not an
      // escape hatch from the coverage rule above. A model with a User FK must
      // be exported or attributed — not written off with a reason.
      const escaped = EXCLUDED_SOURCES.map((source) => source.model).filter((model) =>
        userLinked.has(model)
      );

      expect(escaped).toEqual([]);
    });
  });
});
