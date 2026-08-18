/**
 * Ingestion-time Adaptive Scope candidacy check's structured-output contract (P17.19).
 *
 * A cheap triage, not the Routing Analyst — these tests pin the shape it must accept (confidence
 * bounds, the signal cap, a non-empty summary) so a malformed model response fails loudly at the
 * contract rather than silently corrupting the ingest response/version cache downstream.
 *
 * @see lib/app/questionnaire/scope/candidacy-schema.ts
 */

import { describe, it, expect } from 'vitest';

import {
  scopeCandidacyJsonSchema,
  validateScopeCandidacy,
} from '@/lib/app/questionnaire/scope/candidacy-schema';

/** A minimal, well-formed candidacy result. */
function candidacy(overrides: Record<string, unknown> = {}) {
  return {
    isCandidate: true,
    confidence: 0.8,
    signals: [{ note: 'Mentions a Routing tab.', sourceQuote: 'See the Routing tab.' }],
    summary: 'The document names a routing page.',
    ...overrides,
  };
}

describe('validateScopeCandidacy', () => {
  it('accepts a well-formed result and preserves signals with and without sourceQuote', () => {
    const result = validateScopeCandidacy(
      candidacy({
        signals: [
          { note: 'Explicit routing page found.', sourceQuote: 'See the Routing tab.' },
          { note: 'Inferred from repeated screener language.' },
        ],
      })
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.isCandidate).toBe(true);
    expect(result.value.confidence).toBe(0.8);
    expect(result.value.signals).toEqual([
      { note: 'Explicit routing page found.', sourceQuote: 'See the Routing tab.' },
      { note: 'Inferred from repeated screener language.' },
    ]);
    expect(result.value.summary).toBe('The document names a routing page.');
  });

  it('defaults signals to an empty array when omitted', () => {
    const { signals: _signals, ...withoutSignals } = candidacy();
    void _signals;

    const result = validateScopeCandidacy(withoutSignals);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.signals).toEqual([]);
  });

  it.each([1.5, -0.1])('rejects a confidence of %s outside [0, 1]', (confidence) => {
    const result = validateScopeCandidacy(candidacy({ confidence }));
    expect(result.ok).toBe(false);
  });

  it('accepts confidence at the inclusive bounds of 0 and 1', () => {
    expect(validateScopeCandidacy(candidacy({ confidence: 0 })).ok).toBe(true);
    expect(validateScopeCandidacy(candidacy({ confidence: 1 })).ok).toBe(true);
  });

  it('rejects a missing summary', () => {
    const { summary: _summary, ...withoutSummary } = candidacy();
    void _summary;

    const result = validateScopeCandidacy(withoutSummary);

    expect(result.ok).toBe(false);
  });

  it('rejects an empty summary', () => {
    const result = validateScopeCandidacy(candidacy({ summary: '' }));
    expect(result.ok).toBe(false);
  });

  it('rejects more than the maximum number of signals', () => {
    // MAX_CANDIDACY_SIGNALS is 8 — construct one over the cap.
    const tooMany = Array.from({ length: 9 }, (_, i) => ({ note: `Signal ${i}` }));
    const result = validateScopeCandidacy(candidacy({ signals: tooMany }));
    expect(result.ok).toBe(false);
  });

  it('accepts exactly the maximum number of signals', () => {
    const atCap = Array.from({ length: 8 }, (_, i) => ({ note: `Signal ${i}` }));
    const result = validateScopeCandidacy(candidacy({ signals: atCap }));
    expect(result.ok).toBe(true);
  });

  it('rejects a sourceQuote exceeding its max length', () => {
    const result = validateScopeCandidacy(
      candidacy({ signals: [{ note: 'x', sourceQuote: 'a'.repeat(501) }] })
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a note exceeding its max length', () => {
    const result = validateScopeCandidacy(candidacy({ signals: [{ note: 'a'.repeat(301) }] }));
    expect(result.ok).toBe(false);
  });

  it('scopeCandidacyJsonSchema is a non-empty object exposing properties for the core fields', () => {
    expect(scopeCandidacyJsonSchema).toBeTypeOf('object');
    expect(Object.keys(scopeCandidacyJsonSchema).length).toBeGreaterThan(0);

    const properties = scopeCandidacyJsonSchema.properties;
    expect(properties).toBeTypeOf('object');
    const propertyKeys = Object.keys(properties as Record<string, unknown>);
    expect(propertyKeys).toEqual(expect.arrayContaining(['isCandidate', 'confidence', 'summary']));
  });
});
