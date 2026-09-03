import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

/**
 * The Conditional Topics leak guard.
 *
 * Scope is applied by FILTERING the lists a session-serving loader hands downstream. That makes it
 * invisible: a new loader that queries a version's questions and forgets to filter produces no
 * error, no warning and no failing assertion anywhere — just a respondent who is asked something
 * their interview was never meant to include, or a panel reading "12 of 70 answered" after a
 * complete run.
 *
 * So this test does what nothing else can: it reads the source and insists that every module which
 * loads a version's questions or data slots FOR A SESSION either applies scope or is explicitly
 * listed here as not needing to. Adding a loader means adding a line — which is the point. A guard
 * you have to acknowledge is a guard that works.
 *
 * Sibling in spirit to the cross-version import guard in `synthesis.test.ts`.
 */

const ROOTS = ['app/api/v1/app', 'lib/app/questionnaire'];

/** Applying scope means importing one of these. */
const SCOPE_MARKERS = [
  'buildSessionScope',
  'loadSessionScope',
  'isQuestionInScope',
  'isDataSlotInScope',
  'resolveScope',
];

/** A file is a candidate when it loads a version's structure from the DB. */
const STRUCTURE_QUERIES = [
  'appQuestionSlot.findMany',
  'appDataSlot.findMany',
  'sections: {',
  'dataSlots: {',
];

/**
 * Loaders that legitimately read a version's whole structure.
 *
 * Every entry is a claim: "this reads the AUTHORED questionnaire, not one respondent's interview."
 * Authoring, admin analysis and cohort surfaces are all in that category — an admin editing a
 * questionnaire must see all of it, and a cohort report aggregates across respondents whose scopes
 * differ, so narrowing it to any one of them would be meaningless.
 */
const ALLOWED: Array<{ file: string; because: string }> = [
  // ── Authoring: the admin edits the instrument, not an interview ──────────────────────────────
  { file: 'questionnaires/_lib/detail.ts', because: 'admin authoring read of the whole version' },
  { file: 'questionnaires/_lib/persist.ts', because: 'writes the structure; nothing to scope' },
  { file: 'questionnaires/_lib/reingest.ts', because: 'rewrites the structure' },
  {
    file: 'questionnaires/_lib/copy-version-graph.ts',
    because: 'forks the whole version, scope included',
  },
  { file: 'questionnaires/_lib/topic-routes.ts', because: 'authoring surface FOR scope itself' },
  { file: 'questionnaires/_lib/seed-topics.ts', because: 'creates the topics scope is built from' },
  {
    file: 'questionnaires/_lib/session-scope.ts',
    because: 'IS the scope loader — cannot depend on itself',
  },
  {
    file: 'questionnaires/_lib/data-slot-routes.ts',
    because: 'authoring surface for data slots',
  },
  {
    file: 'questionnaires/_lib/generate-data-slots.ts',
    because: 'generates data slots over the whole version',
  },
  {
    file: 'questionnaires/_lib/import-definition.ts',
    because: 'writes an imported structure',
  },
  {
    file: 'questionnaires/_lib/data-slot-embeddings.ts',
    because: 'embeds every slot; embeddings are version-scoped, not session-scoped',
  },
  {
    file: 'questionnaires/_lib/extraction-review-routes.ts',
    because: 'admin review of the extraction',
  },
  {
    file: 'questionnaires/_lib/authoring-routes.ts',
    because: 'shared authoring helpers',
  },
  {
    file: 'questionnaires/_lib/launch-blockers.ts',
    because: 'pre-launch checks over the authored version',
  },
  {
    file: 'questionnaires/_lib/fork.ts',
    because: 'forks the whole version',
  },

  // ── Analysis across respondents: one session's scope would be the wrong lens ─────────────────
  {
    file: 'cohort-report',
    because: 'aggregates across respondents whose scopes differ; narrowing to one is meaningless',
  },
  {
    file: 'analytics',
    because: 'reports on the instrument across all sessions',
  },
  {
    file: 'evaluation',
    because: 'judges the authored questionnaire, not one interview',
  },
  {
    file: 'export/results-loader.ts',
    because: 'cross-respondent results grid; every column must exist for every row',
  },

  // ── Reads that PRECEDE the scope they would be filtered by ──────────────────────────────────
  {
    file: 'questionnaire-sessions/_lib/plan-scope.ts',
    because:
      'runs BEFORE the plan exists and reads question KEYS only, to tell an unanswered opening ' +
      'question from a member key that no longer resolves; scoping it would be circular',
  },
  {
    file: 'questionnaire-sessions/_lib/seat-early-topics.ts',
    because:
      'the same circularity as plan-scope.ts, one stage earlier (F17.36): it runs while the plan ' +
      'is still null and its whole job is to DECIDE what is in scope, so filtering its inputs by ' +
      'the scope it is about to widen would make the decision unreachable. Reads question KEYS ' +
      'only, plus the topics that are the decision material',
  },

  // ── Write seams whose scope enforcement lives in the route that calls them ───────────────────
  {
    file: 'questionnaire-sessions/_lib/form-answers.ts',
    because:
      'resolves submitted keys to slots; the answers route refuses out-of-scope keys before writing',
  },
];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/** True when the file both reads a session AND loads version structure — i.e. serves one interview. */
function isSessionServingLoader(source: string): boolean {
  const readsSession =
    source.includes('appQuestionnaireSession.findUnique') ||
    source.includes('appQuestionnaireSession.findFirst');
  const readsStructure = STRUCTURE_QUERIES.some((q) => source.includes(q));
  return readsSession && readsStructure;
}

describe('Conditional Topics leak guard', () => {
  const files = ROOTS.flatMap((r) => walk(r));

  it('finds source files to check (the guard itself is not silently a no-op)', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('every session-serving loader applies scope, or is listed with a reason', () => {
    const offenders: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      if (!isSessionServingLoader(source)) continue;
      if (SCOPE_MARKERS.some((m) => source.includes(m))) continue;
      if (ALLOWED.some((a) => file.includes(a.file))) continue;
      offenders.push(file);
    }

    // If this fails: the named file loads a version's questions or data slots for ONE session and
    // does not filter them. Either route it through `buildSessionScope` (see turn-context.ts,
    // answer-panel.ts, session-export.ts) or add it to ALLOWED above with the reason it reads the
    // whole authored instrument rather than one respondent's interview.
    expect(offenders).toEqual([]);
  });

  it('the three known session-serving loaders really do apply scope', () => {
    // Belt and braces: the scan above only catches files it recognises as session-serving. These
    // three are the ones that matter most, so assert them by name rather than by heuristic.
    const mustScope = [
      'app/api/v1/app/questionnaires/_lib/turn-context.ts',
      'app/api/v1/app/questionnaire-sessions/_lib/answer-panel.ts',
      'app/api/v1/app/questionnaire-sessions/_lib/session-export.ts',
    ];

    for (const file of mustScope) {
      const source = readFileSync(file, 'utf8');
      expect(
        SCOPE_MARKERS.some((m) => source.includes(m)),
        `${file} must apply Conditional Topics`
      ).toBe(true);
    }
  });

  it('no allowlist entry is stale', () => {
    // An entry naming a file that no longer exists is a claim nobody can check, and it will quietly
    // start excusing some future file whose path happens to contain the same substring.
    const stale = ALLOWED.filter((a) => !files.some((f) => f.includes(a.file))).map((a) => a.file);
    expect(stale).toEqual([]);
  });
});
