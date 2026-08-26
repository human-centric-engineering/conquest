/**
 * Ingestion-time Conditional Topics candidacy check's structured-output contract (P17.19).
 *
 * A cheap triage, not the Routing Analyst — these tests pin the shape it must accept (confidence
 * bounds, the signal cap, a non-empty summary) so a malformed model response fails loudly at the
 * contract rather than silently corrupting the ingest response/version cache downstream.
 *
 * @see lib/app/questionnaire/scope/candidacy-schema.ts
 */

import { describe, it, expect } from 'vitest';

import {
  CANDIDACY_LIMITS,
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

  // The three tests below used to assert REJECTION on each cap, and that is what made the caps
  // dangerous: candidacy is fail-soft, so a verdict thrown away for being twenty characters too
  // long takes the whole Conditional Topics chain with it, silently. Measured over the routing
  // corpus, every model overflowed one cap or another and corpus doc 05 failed 3/3 on all of them.
  // Clipping is the deliberate replacement — do not restore the rejecting assertions.
  it('clips to the maximum number of signals rather than rejecting the verdict', () => {
    // MAX_CANDIDACY_SIGNALS is 8 — construct one over the cap. `gpt-5.4` really does return nine
    // on a richly-signposted document.
    const tooMany = Array.from({ length: 9 }, (_, i) => ({ note: `Signal ${i}` }));
    const result = validateScopeCandidacy(candidacy({ signals: tooMany }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.signals).toHaveLength(8);
    // The ones kept are the first eight, in order — not an arbitrary subset.
    expect(result.value.signals[7].note).toBe('Signal 7');
  });

  it('accepts exactly the maximum number of signals', () => {
    const atCap = Array.from({ length: 8 }, (_, i) => ({ note: `Signal ${i}` }));
    const result = validateScopeCandidacy(candidacy({ signals: atCap }));
    expect(result.ok).toBe(true);
  });

  it('clips an over-long sourceQuote rather than rejecting the verdict', () => {
    const result = validateScopeCandidacy(
      candidacy({ signals: [{ note: 'x', sourceQuote: 'a'.repeat(501) }] })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.signals[0].sourceQuote).toHaveLength(500);
  });

  it('clips an over-long note rather than rejecting the verdict', () => {
    const result = validateScopeCandidacy(candidacy({ signals: [{ note: 'a'.repeat(301) }] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.signals[0].note).toHaveLength(300);
  });

  it('clips an over-long summary rather than rejecting the verdict', () => {
    const result = validateScopeCandidacy(candidacy({ summary: 'a'.repeat(501) }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.summary).toHaveLength(500);
  });

  // Leniency has a floor: a reply carrying no verdict at all is still a failure. Clipping must not
  // become "accept anything".
  it('still rejects a summary that is only whitespace', () => {
    expect(validateScopeCandidacy(candidacy({ summary: '   ' })).ok).toBe(false);
  });

  it('still rejects a signal whose note is only whitespace', () => {
    expect(validateScopeCandidacy(candidacy({ signals: [{ note: '  ' }] })).ok).toBe(false);
  });

  it('scopeCandidacyJsonSchema is a non-empty object exposing properties for the core fields', () => {
    expect(scopeCandidacyJsonSchema).toBeTypeOf('object');
    expect(Object.keys(scopeCandidacyJsonSchema).length).toBeGreaterThan(0);

    const properties = scopeCandidacyJsonSchema.properties;
    expect(properties).toBeTypeOf('object');
    const propertyKeys = Object.keys(properties as Record<string, unknown>);
    expect(propertyKeys).toEqual(expect.arrayContaining(['isCandidate', 'confidence', 'summary']));
  });

  // The serialised schema is what constrains the provider, so it must carry the SIGNAL ITEM shape —
  // and that is exactly what a naive serialisation loses. Zod cannot represent a `.transform()`, so
  // pointing `z.toJSONSchema` at the lenient parse schema silently emitted `"signals": {"default":
  // []}` — no item type, no properties — at the one field where malformed output was actually
  // observed. Hence the separate un-transformed wire schema. If this assertion ever fails, the two
  // schemas have been collapsed back into one and the provider is being sent a shape that
  // constrains nothing.
  it('serialises the signal item shape, not a bare default', () => {
    const properties = scopeCandidacyJsonSchema.properties as Record<string, unknown>;
    const signals = properties.signals as Record<string, unknown>;

    expect(signals.type).toBe('array');
    const items = signals.items as Record<string, unknown>;
    expect(Object.keys(items.properties as Record<string, unknown>)).toEqual(
      expect.arrayContaining(['note', 'sourceQuote'])
    );
    expect(signals.maxItems).toBe(8);
  });

  // The prompt now states every cap to the model (`candidacy-prompt.ts`). These must stay in step
  // with the schema, or the model is once again being held to a limit it was never told about —
  // the root cause of the deterministic doc-05 failure.
  it('exposes the caps the prompt quotes to the model', () => {
    expect(CANDIDACY_LIMITS).toEqual({
      maxSignals: 8,
      noteChars: 300,
      sourceQuoteChars: 500,
      summaryChars: 500,
    });
  });
});
