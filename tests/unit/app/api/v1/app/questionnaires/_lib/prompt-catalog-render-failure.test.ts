/**
 * A prompt builder that throws must not take down the Prompt Library.
 *
 * The catalog calls every questionnaire agent's REAL builder with a fixed sample context, eagerly,
 * at module load. `specimen()` wraps each call in a try/catch for that reason: the library is an
 * admin debugging surface, and the moment one builder's input contract drifts past its sample, an
 * uncaught throw would take the whole page with it — hiding the forty prompts that still render
 * along with the one that does not.
 *
 * The sibling test (`prompt-catalog.test.ts`) asserts the happy path: with real builders, no
 * specimen carries an error. This one forces the other branch, because a rescue path nothing ever
 * exercises is a rescue path nobody knows is broken.
 *
 * Its own file, not a case in the sibling: the builders run at import, so the mock has to be in
 * place before the catalog module is loaded. Two builders are broken rather than one, in two
 * different ways — an `Error` and a bare string — because the catch reports them through different
 * expressions and a builder is ordinary code that can throw either.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({ prisma: {} }));

// The design judges' builder throws an Error.
vi.mock('@/lib/app/questionnaire/evaluation/judge-prompt', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('@/lib/app/questionnaire/evaluation/judge-prompt')>();
  return {
    ...real,
    buildJudgePrompt: () => {
      throw new Error('sample no longer satisfies the builder');
    },
  };
});

// The scope judges' builder throws a bare string — the `String(err)` arm of the same catch.
vi.mock('@/lib/app/questionnaire/scope-evaluation/judge-prompt', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('@/lib/app/questionnaire/scope-evaluation/judge-prompt')>();
  return {
    ...real,
    buildScopeJudgePrompt: () => {
      // A non-Error throw IS the subject here: `specimen()`'s `String(err)` arm exists for exactly
      // this and has no other way to be reached. The lint rule is right about production code and
      // wrong about this one test.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'thrown without an Error wrapper';
    },
  };
});

import { buildPromptCatalog } from '@/app/api/v1/app/questionnaires/_lib/prompt-catalog';
import { EVALUATION_JUDGE_SLUGS } from '@/lib/app/questionnaire/evaluation/dimensions';
import { SCOPE_EVALUATION_JUDGE_SLUGS } from '@/lib/app/questionnaire/scope-evaluation/dimensions';

const catalog = buildPromptCatalog();
const designJudges = catalog.filter((e) => EVALUATION_JUDGE_SLUGS.includes(e.slug));
const scopeJudges = catalog.filter((e) => SCOPE_EVALUATION_JUDGE_SLUGS.includes(e.slug));

describe('a specimen whose builder throws', () => {
  it('still produces the entry, flagged rather than missing', () => {
    expect(designJudges.length).toBeGreaterThan(0);
    for (const judge of designJudges) {
      for (const specimen of judge.specimens) {
        expect(specimen.error).toBe(true);
      }
    }
  });

  it('says what went wrong, in the specimen itself', () => {
    // The admin is looking at this page precisely because something is off; the thrown message is
    // the one piece of evidence they cannot get anywhere else.
    const [specimen] = designJudges[0].specimens;
    expect(specimen.messages).toHaveLength(1);
    expect(specimen.messages[0].role).toBe('system');
    expect(specimen.messages[0].content).toContain('Sample prompt failed to render');
    expect(specimen.messages[0].content).toContain('sample no longer satisfies the builder');
  });

  it('reports a throw that was never an Error, rather than rendering "undefined"', () => {
    expect(scopeJudges.length).toBeGreaterThan(0);
    const [specimen] = scopeJudges[0].specimens;
    expect(specimen.error).toBe(true);
    expect(specimen.messages[0].content).toContain('thrown without an Error wrapper');
  });

  it('keeps the entry’s own identity — a broken sample is not an anonymous one', () => {
    const [specimen] = designJudges[0].specimens;
    expect(specimen.id).toBeTruthy();
    expect(specimen.label).toBeTruthy();
    expect(specimen.description).toBeTruthy();
    expect(specimen.conditions).toEqual(expect.any(Array));
  });

  it('leaves every other agent in the catalog rendering normally', () => {
    // The whole point of catching per specimen rather than per catalog.
    const broken = new Set([...EVALUATION_JUDGE_SLUGS, ...SCOPE_EVALUATION_JUDGE_SLUGS]);
    const others = catalog.filter((e) => !broken.has(e.slug));
    expect(others.length).toBeGreaterThan(0);
    expect(others.flatMap((e) => e.specimens).every((s) => !s.error)).toBe(true);
  });
});
