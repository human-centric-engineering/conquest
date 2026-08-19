/**
 * Unit tests for the grader registry module.
 *
 * Drives the registry directly without going through the barrel —
 * `__resetGraderRegistryForTests()` is invoked in `beforeEach` so each
 * test starts from a known-empty state. Two tiny fixture graders (one
 * heuristic, one pairwise) cover the type-narrow lookup branches without
 * pulling in real grader modules that would self-register on import.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

// The fork seam ships empty; the tests below fill it explicitly.
vi.mock('@/lib/app/evaluations', () => ({ initAppGraders: vi.fn() }));
vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import {
  __resetGraderRegistryForTests,
  getGrader,
  getPairwiseGrader,
  getRegisteredSlugs,
  hasGrader,
  listGraders,
  registerGrader,
} from '@/lib/orchestration/evaluations/graders/registry';
import type { Grader, PairwiseGrader } from '@/lib/orchestration/evaluations/graders/types';
import { initAppGraders } from '@/lib/app/evaluations';
import { logger } from '@/lib/logging';

function makeHeuristicGrader(slug: string, description = `desc-${slug}`): Grader<{ x: number }> {
  return {
    slug,
    family: 'heuristic',
    referenceRequired: false,
    configSchema: z.object({ x: z.number() }),
    grade: async () => ({ score: 1 }),
    description,
  };
}

function makePairwiseGrader(slug: string): PairwiseGrader<{ y: string }> {
  return {
    slug,
    family: 'pairwise',
    configSchema: z.object({ y: z.string() }),
    grade: async () => ({ verdict: 'tie', reasoning: 'fixture' }),
    description: `pair-${slug}`,
  };
}

beforeEach(() => {
  __resetGraderRegistryForTests();
});

describe('grader registry', () => {
  it('registers a grader and round-trips it via getGrader', () => {
    const g = makeHeuristicGrader('alpha');
    registerGrader(g);

    const fetched = getGrader('alpha');
    expect(fetched).toBe(g);
    expect(fetched.slug).toBe('alpha');
    expect(fetched.family).toBe('heuristic');
  });

  it('hasGrader returns true after register, false for unknown slug', () => {
    expect(hasGrader('alpha')).toBe(false);
    registerGrader(makeHeuristicGrader('alpha'));
    expect(hasGrader('alpha')).toBe(true);
    expect(hasGrader('beta')).toBe(false);
  });

  it('listGraders returns entries in registration order', () => {
    const a = makeHeuristicGrader('alpha');
    const b = makeHeuristicGrader('beta');
    const c = makePairwiseGrader('charlie');
    registerGrader(a);
    registerGrader(b);
    registerGrader(c);

    const list = listGraders();
    expect(list).toEqual([a, b, c]);
  });

  it('getRegisteredSlugs returns slugs in registration order', () => {
    registerGrader(makeHeuristicGrader('alpha'));
    registerGrader(makePairwiseGrader('beta'));
    registerGrader(makeHeuristicGrader('gamma'));

    expect(getRegisteredSlugs()).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('getGrader throws when the slug is not registered', () => {
    expect(() => getGrader('ghost')).toThrow(/No grader registered for slug "ghost"/);
  });

  it('getGrader throws when the slug names a pairwise grader', () => {
    registerGrader(makePairwiseGrader('pair-1'));
    expect(() => getGrader('pair-1')).toThrow(/Grader "pair-1" is pairwise; use getPairwiseGrader/);
  });

  it('getPairwiseGrader returns the pairwise entry', () => {
    const p = makePairwiseGrader('pair-1');
    registerGrader(p);

    const fetched = getPairwiseGrader('pair-1');
    expect(fetched).toBe(p);
    expect(fetched.family).toBe('pairwise');
  });

  it('getPairwiseGrader throws when the slug is not registered', () => {
    expect(() => getPairwiseGrader('ghost')).toThrow(/No grader registered for slug "ghost"/);
  });

  it('getPairwiseGrader throws when the slug names a single-output grader', () => {
    registerGrader(makeHeuristicGrader('alpha'));
    expect(() => getPairwiseGrader('alpha')).toThrow(/Grader "alpha" is not pairwise/);
  });

  it('re-registering the same slug overrides the previous entry (idempotent on slug)', () => {
    const first = makeHeuristicGrader('alpha', 'first');
    const second = makeHeuristicGrader('alpha', 'second');
    registerGrader(first);
    registerGrader(second);

    expect(getGrader('alpha')).toBe(second);
    expect(getGrader('alpha').description).toBe('second');
    // Slug count must not double — Map semantics on the slug key.
    expect(getRegisteredSlugs()).toEqual(['alpha']);
    expect(listGraders()).toHaveLength(1);
  });

  it('__resetGraderRegistryForTests clears all entries', () => {
    registerGrader(makeHeuristicGrader('alpha'));
    registerGrader(makeHeuristicGrader('beta'));
    expect(listGraders()).toHaveLength(2);

    __resetGraderRegistryForTests();

    expect(listGraders()).toEqual([]);
    expect(getRegisteredSlugs()).toEqual([]);
    expect(hasGrader('alpha')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The #541 fork seam — a grader the batch worker can actually see
// ---------------------------------------------------------------------------

describe('app grader registrations', () => {
  beforeEach(() => {
    __resetGraderRegistryForTests();
    vi.clearAllMocks();
  });

  it('ships with no app graders', () => {
    expect(listGraders()).toEqual([]);
  });

  it.each([
    ['getGrader', () => getGrader('app_triage_accuracy')],
    ['hasGrader', () => hasGrader('app_triage_accuracy')],
    ['listGraders', () => listGraders()],
    ['getRegisteredSlugs', () => getRegisteredSlugs()],
  ])('%s sees an app grader registered from the seam', (_name, read) => {
    // Every one of these backs a different route-realm caller: the batch
    // worker's dispatch, the run-creation validator, the metric picker, the
    // parity check. #541's failure was that only SOME of them could ever have
    // seen a fork registration, so all four are asserted.
    const grader = makeHeuristicGrader('app_triage_accuracy');
    vi.mocked(initAppGraders).mockImplementation(() => registerGrader(grader));

    read();

    expect(hasGrader('app_triage_accuracy')).toBe(true);
    expect(getGrader('app_triage_accuracy')).toBe(grader);
  });

  it('runs the fork init exactly once across many lookups', () => {
    vi.mocked(initAppGraders).mockImplementation(() =>
      registerGrader(makeHeuristicGrader('app_triage_accuracy'))
    );

    hasGrader('app_triage_accuracy');
    listGraders();
    getRegisteredSlugs();
    getGrader('app_triage_accuracy');

    expect(initAppGraders).toHaveBeenCalledTimes(1);
  });

  it('degrades to no app graders when the fork init throws', () => {
    vi.mocked(initAppGraders).mockImplementation(() => {
      throw new Error('fork boom');
    });

    // A thrown init must not become a 500 on the metric picker...
    expect(listGraders()).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('initAppGraders threw'),
      expect.objectContaining({ error: 'fork boom' })
    );

    // ...and the latch means it is not retried on every case of a drain.
    listGraders();
    expect(initAppGraders).toHaveBeenCalledTimes(1);
  });

  it('lets an app grader replace a built-in slug, but says so', () => {
    // Overwrite-by-slug is the documented behaviour and swapping in a mock is
    // why. Silence is the part that was wrong: a replaced `exact_match` changes
    // every score an admin reads while changing nothing they can see.
    const builtIn = makeHeuristicGrader('exact_match', 'core');
    registerGrader(builtIn);

    const replacement = makeHeuristicGrader('exact_match', 'fork');
    vi.mocked(initAppGraders).mockImplementation(() => registerGrader(replacement));

    expect(getGrader('exact_match')).toBe(replacement);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('replaced a built-in slug'), {
      slug: 'exact_match',
    });
  });

  it('does not warn when an app grader adds a slug nothing used', () => {
    registerGrader(makeHeuristicGrader('exact_match'));
    vi.mocked(initAppGraders).mockImplementation(() =>
      registerGrader(makeHeuristicGrader('app_triage_accuracy'))
    );

    listGraders();

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('re-arms the one-shot init on reset so a test cannot inherit a stale latch', () => {
    vi.mocked(initAppGraders).mockImplementation(() =>
      registerGrader(makeHeuristicGrader('app_triage_accuracy'))
    );

    listGraders();
    __resetGraderRegistryForTests();
    listGraders();

    expect(initAppGraders).toHaveBeenCalledTimes(2);
  });
});
