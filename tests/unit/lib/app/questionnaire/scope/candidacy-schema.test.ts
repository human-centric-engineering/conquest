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
  candidacyWireSchema,
  scopeCandidacyJsonSchema,
  scopeCandidacySchema,
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

  // The slice has to happen BEFORE the items are validated. Validating first and slicing after —
  // the obvious spelling — checks all ten and then discards two, so a malformed NINTH signal still
  // rejects the whole verdict. That is precisely the over-cap output the clipping exists to
  // tolerate, which makes the wrong order look fixed while leaving the original failure reachable.
  it('tolerates a malformed signal that sits beyond the cap', () => {
    const good = { note: 'A real signal' };
    const malformed = { note: '' };
    const res = validateScopeCandidacy(
      candidacy({ signals: [...Array.from({ length: 8 }, () => good), malformed, malformed] })
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.signals).toHaveLength(8);
  });

  // The floor still holds: leniency about what falls off the end is not leniency about what stays.
  it('still rejects a malformed signal INSIDE the cap', () => {
    expect(validateScopeCandidacy(candidacy({ signals: [{ note: '' }] })).ok).toBe(false);
  });

  // The prompt says to omit the key, but models routinely spell "no quote" as an explicit null.
  // A plain `.optional()` rejects that, taking the verdict — and the Conditional Topics chain —
  // down over a JSON idiom rather than anything wrong with the answer.
  it('reads an explicit null sourceQuote as absent rather than rejecting', () => {
    const res = validateScopeCandidacy(
      candidacy({ signals: [{ note: 'Inferred, not quoted', sourceQuote: null }] })
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Normalised to undefined so consumers keep ONE shape for "no quote".
    expect(res.value.signals[0].sourceQuote).toBeUndefined();
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

describe('the wire schema and the parse schema', () => {
  // The split is deliberate — strict going out, lenient coming back — but it creates one failure
  // the single-schema version could not have: the two drifting apart. A field added to the parse
  // schema and forgotten on the wire schema is invisible, because the provider is then never told
  // to produce it and nothing errors; the field just never arrives.
  it('both accept the same well-formed verdict', () => {
    const verdict = {
      isCandidate: true,
      confidence: 0.9,
      signals: [{ note: 'Part C is situational', sourceQuote: 'only complete a part where…' }],
      summary: 'Parts C to F are conditional on the school circumstance.',
    };

    expect(validateScopeCandidacy(verdict).ok).toBe(true);
    expect(candidacyWireSchema.safeParse(verdict).success).toBe(true);
  });

  it('describe the same field set', () => {
    const wireKeys = Object.keys(candidacyWireSchema.shape).sort();
    const parseKeys = Object.keys(scopeCandidacySchema.shape).sort();

    expect(wireKeys).toEqual(parseKeys);
  });

  // The one asymmetry that IS intended, pinned so it reads as a decision rather than an oversight:
  // the wire schema rejects what the parse schema clips. That is the whole point — constrain the
  // model tightly, then accept generously whatever it actually sends.
  it('differ only in strictness: the wire schema rejects what the parse schema clips', () => {
    const overCap = {
      isCandidate: true,
      confidence: 1,
      signals: [{ note: 'x', sourceQuote: 'a'.repeat(501) }],
      summary: 'ok',
    };

    expect(candidacyWireSchema.safeParse(overCap).success).toBe(false);
    expect(validateScopeCandidacy(overCap).ok).toBe(true);
  });
});
