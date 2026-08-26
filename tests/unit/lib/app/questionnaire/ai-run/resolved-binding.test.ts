import { describe, it, expect } from 'vitest';

import {
  UNRESOLVED_BINDING,
  normaliseBinding,
  readResolvedBinding,
  readResolvedCost,
} from '@/lib/app/questionnaire/ai-run/resolved-binding';

/**
 * `AppAiRun.provider` / `.model` are documented as the binding that served a call, and did not
 * hold it: callers passed the AGENT ROW's configured values, and the app's agents deliberately
 * ship with empty provider/model so they bind to a tier at call time. Rows read `''`, `'n/a'` or
 * `'resolved-at-runtime'` for calls that had really run on `openai/gpt-5.4`.
 *
 * This module is the read side. Its whole job is to be defensive: a provenance write must never
 * throw, and must never silently record a blank it could have filled.
 */

describe('readResolvedBinding', () => {
  it('reads the binding a capability returned beside its result', () => {
    expect(readResolvedBinding({ result: {}, provider: 'openai', model: 'gpt-5.4' })).toEqual({
      provider: 'openai',
      model: 'gpt-5.4',
    });
  });

  it('falls back to the sentinel when the capability carried no binding', () => {
    // A capability predating the wider data type — degrade, never throw inside a provenance write.
    expect(readResolvedBinding({ result: {} })).toEqual({
      provider: UNRESOLVED_BINDING,
      model: UNRESOLVED_BINDING,
    });
  });

  it('keeps the half it has when only one field arrived', () => {
    // Knowing the provider but not the model still beats recording neither.
    expect(readResolvedBinding({ provider: 'openai' })).toEqual({
      provider: 'openai',
      model: UNRESOLVED_BINDING,
    });
  });

  it('treats an empty or whitespace string as unresolved, not as a value', () => {
    expect(readResolvedBinding({ provider: '', model: '   ' })).toEqual({
      provider: UNRESOLVED_BINDING,
      model: UNRESOLVED_BINDING,
    });
  });

  it('survives a non-object payload rather than throwing', () => {
    for (const payload of [undefined, null, 'nope', 42, []]) {
      expect(readResolvedBinding(payload)).toEqual({
        provider: UNRESOLVED_BINDING,
        model: UNRESOLVED_BINDING,
      });
    }
  });

  it('ignores non-string provider/model values', () => {
    expect(readResolvedBinding({ provider: 7, model: { name: 'gpt' } })).toEqual({
      provider: UNRESOLVED_BINDING,
      model: UNRESOLVED_BINDING,
    });
  });
});

describe('normaliseBinding', () => {
  it('passes a real binding through', () => {
    expect(normaliseBinding('openai', 'gpt-5.4')).toEqual({
      provider: 'openai',
      model: 'gpt-5.4',
    });
  });

  /**
   * The exact bug this replaces. `verification.provider ?? 'n/a'` looked correct, but an agent
   * that resolves at call time reports an EMPTY STRING — which is not nullish — so the fallback
   * never fired and the column stored `''`. That is why `extraction_verify` rows came back blank
   * rather than reading `n/a`.
   */
  it('fires on an empty string, which `??` did not', () => {
    expect(normaliseBinding('', '')).toEqual({
      provider: UNRESOLVED_BINDING,
      model: UNRESOLVED_BINDING,
    });
  });

  it('fires on null and undefined too', () => {
    expect(normaliseBinding(null, undefined)).toEqual({
      provider: UNRESOLVED_BINDING,
      model: UNRESOLVED_BINDING,
    });
  });

  it('uses the codebase-wide sentinel spelling, so grouping by provider is not split', () => {
    // run-worker.ts and the edit-agent apply seam already write 'n/a'; a second spelling
    // ('resolved-at-runtime') would fragment any "runs by provider" rollup.
    expect(UNRESOLVED_BINDING).toBe('n/a');
  });
});

describe('readResolvedCost', () => {
  it('reads the cost a capability reported', () => {
    expect(readResolvedCost({ provider: 'openai', model: 'gpt-5.4-mini', costUsd: 0.0009 })).toBe(
      0.0009
    );
  });

  // `null`, not `0`. Zero is a real answer meaning "this call was free", and a provenance row that
  // cannot price itself must say so rather than under-report the bill as nothing. This is the
  // whole reason the return type is nullable.
  it('returns null when the dispatch reported no cost', () => {
    expect(readResolvedCost({ provider: 'openai', model: 'gpt-5.4-mini' })).toBeNull();
  });

  it('preserves a genuine zero rather than flattening it to null', () => {
    expect(readResolvedCost({ costUsd: 0 })).toBe(0);
  });

  // A capability that predates the wider data type, or a malformed one, must degrade to "unknown"
  // inside a provenance write rather than throw — the same defensive posture as readResolvedBinding.
  it.each([
    ['a non-object', 'nope'],
    ['null', null],
    ['undefined', undefined],
    ['a numeric string', { costUsd: '0.0009' }],
    ['NaN', { costUsd: Number.NaN }],
    ['Infinity', { costUsd: Number.POSITIVE_INFINITY }],
    ['a negative cost', { costUsd: -1 }],
  ])('returns null for %s', (_label, input) => {
    expect(readResolvedCost(input)).toBeNull();
  });
});
