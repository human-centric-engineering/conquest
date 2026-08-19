/**
 * Unit Tests: a core artifact that reads a fork seam has to say so
 *
 * The recurring defect behind #480, #525, #530 and #533 is one shape: **a core
 * artifact measures something a `lib/app/*` seam contributes to, so filling the
 * seam correctly turns the suite red.** #480 closed it for one file with the
 * `SEAM_DEFAULTS` pin table, and v0.8.0 then shipped a brand-new instance in
 * `scripts/smoke/export.ts`. A fix to one file is not a rule anyone can check,
 * so the next artifact re-derives the same wrong assumption and the next fork
 * finds it.
 *
 * This is the checkable part of that rule: any file under `tests/` or
 * `scripts/` that reads a `lib/app/*` module **without mocking it** must carry
 * a `FORK NOTE` saying what a fork should expect. Reading the real seam is
 * often right — that is what `defaults.test.ts` is for — but it makes the file
 * a fork's problem, and the note is what turns a mystifying failure into an
 * instruction.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES NOT CATCH — measured, not assumed
 * ---------------------------------------------------------------------------
 * The four artifacts that motivated the rule were checked against it. It would
 * have caught **one**:
 *
 *   • `defaults.test.ts` (#480) — imports the seams directly. CAUGHT.
 *   • `registry.test.ts` (#525) — counts registrations through
 *     `registerBuiltInCapabilities()`, which calls the seam. No reference here
 *     at all: the coupling is transitive. MISSED.
 *   • `export-sources.test.ts` (#533) — scans `prisma/schema/`, a fork-reserved
 *     *directory*, and never imports a seam. MISSED.
 *   • `scripts/smoke/export.ts` (#530) — asserts on `bundle.app`, a key the
 *     seam fills two calls away. MISSED.
 *   • The eleven `/dashboard` assertions (#530) — restate a seam's default
 *     *value*, with no reference to anything. MISSED.
 *
 * A grep cannot see "this assertion's value depends on what a fork
 * contributes", because that is a semantic property with no syntax. What does
 * see it is filling every seam and running the suite — the failures are the
 * roster, exactly, with no false positives. That sweep is worth building and is
 * filed separately; this file is the cheap half, and it is documented here so
 * nobody mistakes it for the whole rule.
 *
 * @see tests/unit/lib/app/defaults.test.ts — the pin table this generalises
 * @see CUSTOMIZATION.md §4
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = process.cwd();
const ROOTS = ['tests', 'scripts'] as const;
const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.mjs'] as const;

/**
 * A quoted `@/lib/app/<module>` specifier.
 *
 * Anchored on the closing `/` after `app` so `@/lib/app-version` — a real
 * module with nothing to do with the seams — cannot match. An earlier draft of
 * this scanner matched on the `lib/app` prefix and reported it.
 */
const SEAM_SPECIFIER = /['"](@\/lib\/app\/[A-Za-z0-9_.-]+)['"]/g;

/**
 * A Vitest mock of a specific seam module.
 *
 * `doUnmock` counts as mocking: a file that unmocks inside one test has a
 * `doMock` elsewhere and is driving the seam deliberately, which is the
 * fork-safe pattern this rule wants.
 *
 * Case matters — an earlier draft wrote `(?:Mock|Unmock)`, which does not match
 * `vi.mock`, and it reported 23 coupled files instead of 4. The list looked
 * entirely plausible.
 */
const SEAM_MOCK = /vi\.(?:mock|doMock|unmock|doUnmock)\(\s*['"](@\/lib\/app\/[A-Za-z0-9_.-]+)['"]/g;

/** The marker a coupled file must carry. */
const FORK_NOTE = /FORK NOTE/;

/**
 * How much text has to follow the marker before it counts as a note.
 *
 * `// FORK NOTE: none` satisfies a bare presence check and tells a fork
 * nothing, which is the failure mode of every marker convention.
 */
const MIN_NOTE_CHARS = 60;

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(REPO_ROOT, rel))) {
      const childRel = join(rel, entry);
      if (statSync(join(REPO_ROOT, childRel)).isDirectory()) walk(childRel);
      else if (SCANNED_EXTENSIONS.some((ext) => childRel.endsWith(ext))) out.push(childRel);
    }
  };
  walk(dir);
  return out;
}

/** Seam modules a source references but does not mock. */
export function unmockedSeams(source: string): string[] {
  const referenced = new Set([...source.matchAll(SEAM_SPECIFIER)].map((m) => m[1]));
  const mocked = new Set([...source.matchAll(SEAM_MOCK)].map((m) => m[1]));
  return [...referenced].filter((spec) => !mocked.has(spec)).sort();
}

/**
 * Whether a source carries a `FORK NOTE` with something after it.
 *
 * The text is taken from the marker to the end of the comment it sits in, and
 * no further. An earlier version of this function read a fixed window of
 * characters from the marker, which ran straight past the comment into the
 * file's own code — so `// FORK NOTE: none` at the top of any file passed,
 * padded by the imports below it. Found by sabotage-testing this check with
 * exactly that string.
 */
function hasSubstantiveForkNote(source: string): boolean {
  const at = source.search(FORK_NOTE);
  if (at === -1) return false;

  const [markerLine, ...rest] = source.slice(at + 'FORK NOTE'.length).split('\n');
  const commentLines = [markerLine];
  for (const line of rest) {
    const trimmed = line.trim();
    // `*/` ends the block and contributes nothing; a blank line inside a
    // JSDoc block is written ` *`, so bare blanks end a `//` run.
    if (trimmed.startsWith('*/')) break;
    if (!trimmed.startsWith('*') && !trimmed.startsWith('//')) break;
    commentLines.push(trimmed.replace(/^(\*|\/\/)/, ''));
  }

  // Strip comment furniture so a box of asterisks and dashes cannot pad the
  // count up to the threshold.
  const note = commentLines
    .join(' ')
    .replace(/[*/\-—\s]+/g, ' ')
    .trim();
  return note.length >= MIN_NOTE_CHARS;
}

describe('core artifacts coupled to a lib/app seam', () => {
  const coupled = ROOTS.flatMap(filesUnder)
    .map((file) => ({ file, source: readFileSync(join(REPO_ROOT, file), 'utf8') }))
    .map(({ file, source }) => ({ file, source, seams: unmockedSeams(source) }))
    .filter(({ seams }) => seams.length > 0);

  it('finds the coupled files at all', () => {
    // Guard on the guard. Both regexes above have been wrong once already, and
    // a scanner that matches nothing reports a clean sweep while checking
    // nothing — the failure mode that made the outbound-fetch guard need the
    // same row (#628). Four is the count as of this commit; the assertion is
    // deliberately a floor, not an equality, so adding a legitimate reader is
    // not a chore.
    expect(coupled.length).toBeGreaterThanOrEqual(4);
    expect(coupled.map(({ file }) => file)).toContain('tests/unit/lib/app/defaults.test.ts');
  });

  it('every one of them carries a FORK NOTE', () => {
    const silent = coupled
      .filter(({ source }) => !hasSubstantiveForkNote(source))
      .map(({ file, seams }) => `${file} (reads ${seams.join(', ')})`)
      .sort();

    expect(
      silent,
      silent.length === 0
        ? ''
        : `These read a lib/app/* seam for real — no vi.mock — so filling that seam ` +
            `changes what they measure, and a fork hits the failure with nothing to ` +
            `read: ${silent.join('; ')}. Add a FORK NOTE comment saying what a fork ` +
            `should expect and what to pin. If the file does not actually need the ` +
            `real seam, mock it instead — that is usually the better fix and makes ` +
            `the assertion stricter. See tests/unit/lib/app/defaults.test.ts.`
    ).toEqual([]);
  });
});

/**
 * The scanner, against fixtures.
 *
 * The suite above is a survey of a tree that currently satisfies it, so it
 * passes whether or not `unmockedSeams` works. These cases are where the
 * predicate is actually observed doing something.
 *
 * Fixture specifiers are interpolated rather than written out, so this file
 * does not match its own scanner and needs no self-exemption — a path
 * exemption would be a hole in exactly the file that must not have one.
 */
describe('unmockedSeams', () => {
  const SEAM = '@/lib/app';

  it('flags a real import of a seam', () => {
    expect(unmockedSeams(`import { emailOverrides } from '${SEAM}/emails';`)).toEqual([
      `${SEAM}/emails`,
    ]);
  });

  it('ignores a seam the file mocks', () => {
    const src = [
      `vi.mock('${SEAM}/capabilities', () => ({ initAppCapabilities: vi.fn() }));`,
      `import { initAppCapabilities } from '${SEAM}/capabilities';`,
    ].join('\n');
    expect(unmockedSeams(src)).toEqual([]);
  });

  it('ignores a seam driven through doMock / doUnmock', () => {
    const src = [
      `vi.doUnmock('${SEAM}/footer');`,
      `vi.doMock('${SEAM}/footer', () => ({ footerCopyright: false }));`,
    ].join('\n');
    expect(unmockedSeams(src)).toEqual([]);
  });

  it('flags the unmocked one when a file mocks a different seam', () => {
    const src = [
      `vi.mock('${SEAM}/csp', () => ({ appFrameSrc: [] }));`,
      `import { appProtectedRoutes } from '${SEAM}/protected-routes';`,
    ].join('\n');
    expect(unmockedSeams(src)).toEqual([`${SEAM}/protected-routes`]);
  });

  it('does not mistake lib/app-version for a seam', () => {
    // The prefix collision that made an earlier draft of this scanner report a
    // module with nothing to do with the fork tier.
    expect(unmockedSeams(`import { APP_VERSION } from '@/lib/app-version';`)).toEqual([]);
  });

  it('matches a .mjs seam, which the eslint config is', () => {
    expect(unmockedSeams(`import config from '${SEAM}/eslint.config.mjs';`)).toEqual([
      `${SEAM}/eslint.config.mjs`,
    ]);
  });
});

describe('the FORK NOTE substance check', () => {
  it('accepts a note that explains itself', () => {
    const src = [
      '/**',
      ' * FORK NOTE — filling this seam is expected to fail the row below. Pin the',
      ' * new value rather than deleting it, so the seams you have not filled keep',
      ' * their protection.',
      ' */',
    ].join('\n');
    expect(hasSubstantiveForkNote(src)).toBe(true);
  });

  it('rejects a marker with nothing after it', () => {
    // The whole point of the length floor: a bare marker satisfies a presence
    // check and leaves the fork exactly where it started.
    expect(hasSubstantiveForkNote('// FORK NOTE: none')).toBe(false);
  });

  it('rejects a marker padded out with comment furniture', () => {
    expect(hasSubstantiveForkNote(`// FORK NOTE ${'-'.repeat(200)}`)).toBe(false);
  });

  it('rejects a file with no marker', () => {
    expect(hasSubstantiveForkNote('// nothing to declare here')).toBe(false);
  });
});
