/**
 * Unit tests for the pure per-turn orchestrator (F6.1).
 *
 * Exhaustive over the pipeline's branch matrix with stub invokers (no capability, no DB):
 * which steps run given the message/flags/config, how extracted intents merge into the
 * downstream state, the offer-vs-question response, terminal branches, fail-soft warnings,
 * and cost summing. The capabilities themselves and the live wiring are tested elsewhere.
 */

import { describe, expect, it } from 'vitest';

import {
  COMPOSE_COMPLETION_OFFER_CAPABILITY_SLUG,
  DETECT_CONTRADICTIONS_CAPABILITY_SLUG,
  EXTRACT_ANSWER_SLOTS_CAPABILITY_SLUG,
  REFINE_ANSWER_CAPABILITY_SLUG,
} from '@/lib/app/questionnaire/constants';
import {
  applyIntents,
  COMPLETE_MESSAGE,
  NONE_MESSAGE,
  runTurn,
  SELECTION_TOOL_SLUG,
} from '@/lib/app/questionnaire/orchestrator';
import {
  decision,
  finding,
  intent,
  state,
  stubInvokers,
  q,
} from '@/tests/unit/lib/app/questionnaire/orchestrator/_fixtures';

const slugs = (calls: { slug: string }[]): string[] => calls.map((c) => c.slug);

/** Two captured answers — the floor the detector capability needs (`answers.min(2)`). */
const TWO_ANSWERS = [
  { slotKey: 'a', value: 1, provenance: 'direct' as const },
  { slotKey: 'b', value: 2, provenance: 'direct' as const },
];

describe('runTurn — opening turn (empty message)', () => {
  it('skips extract/detect/refine and selects the first question', async () => {
    const { invokers, calls } = stubInvokers({
      select: { decision: { kind: 'ask', questionId: 'a', rationale: 'first', costUsd: 0 } },
    });
    const result = await runTurn(
      state({ userMessage: '', questions: [q({ id: 'a', prompt: 'What is your role?' })] }),
      invokers
    );

    expect(calls.extract).toHaveLength(0);
    expect(calls.detect).toHaveLength(0);
    expect(calls.refine).toHaveLength(0);
    expect(calls.select).toHaveLength(1);
    expect(result.response).toEqual({
      kind: 'question',
      questionId: 'a',
      text: 'What is your role?',
    });
    expect(result.targetedQuestionId).toBe('a');
    expect(slugs(result.toolCalls)).toEqual([SELECTION_TOOL_SLUG]);
  });
});

describe('runTurn — extraction', () => {
  it('extracts on a non-empty message and carries intents to answerUpserts', async () => {
    const { invokers, calls } = stubInvokers({
      extract: { intents: [intent({ slotKey: 'a', value: 'marketing' })], costUsd: 0.002 },
    });
    const result = await runTurn(
      state({
        userMessage: 'I do marketing',
        questions: [q({ id: 'a', key: 'a' }), q({ id: 'b', key: 'b' })],
      }),
      invokers
    );

    expect(calls.extract).toHaveLength(1);
    expect(result.sideEffects.answerUpserts).toHaveLength(1);
    expect(slugs(result.toolCalls)).toContain(EXTRACT_ANSWER_SLOTS_CAPABILITY_SLUG);
  });

  it('skips extraction when the flag is off, even with a message', async () => {
    const { invokers, calls } = stubInvokers();
    const result = await runTurn(
      state({ userMessage: 'hi', questions: [q({ id: 'a' })], flags: { extraction: false } }),
      invokers
    );
    expect(calls.extract).toHaveLength(0);
    expect(result.sideEffects.answerUpserts).toHaveLength(0);
  });

  it('emits a warning and a failed tool-call when extraction returns a diagnostic', async () => {
    const { invokers } = stubInvokers({ extract: { diagnostic: 'extraction_failed' } });
    const result = await runTurn(
      state({ userMessage: 'hi', questions: [q({ id: 'a' })] }),
      invokers
    );
    expect(result.events).toContainEqual(
      expect.objectContaining({ type: 'warning', code: 'extraction_failed' })
    );
    const extractCall = result.toolCalls.find(
      (t) => t.slug === EXTRACT_ANSWER_SLOTS_CAPABILITY_SLUG
    );
    expect(extractCall).toMatchObject({ success: false, code: 'extraction_failed' });
  });

  it('feeds the just-extracted answer into completion + selection (effective state)', async () => {
    // Two questions; one already answered, the message answers the second → both covered →
    // assessment should offer (default coverageThreshold 1), so selection never runs.
    const { invokers, calls } = stubInvokers({
      extract: { intents: [intent({ slotKey: 'b' })] },
    });
    const result = await runTurn(
      state({
        userMessage: 'the second answer',
        questions: [q({ id: 'a', key: 'a' }), q({ id: 'b', key: 'b' })],
        answered: [{ questionId: 'a', confidence: null }],
        config: { minQuestionsAnswered: 2 },
      }),
      invokers
    );
    expect(result.assessment.kind).toBe('offer');
    expect(result.assessment.answeredCount).toBe(2);
    expect(calls.select).toHaveLength(0);
    expect(result.response.kind).toBe('offer');
  });
});

describe('runTurn — contradiction detection', () => {
  it('does not detect when the config mode is off', async () => {
    const { invokers, calls } = stubInvokers();
    await runTurn(
      state({
        userMessage: 'x',
        questions: [q({ id: 'a' })],
        config: { contradictionMode: 'off' },
      }),
      invokers
    );
    expect(calls.detect).toHaveLength(0);
  });

  it('detects under flag mode and emits a warning per finding', async () => {
    const { invokers, calls } = stubInvokers({
      detect: {
        findings: [finding({ explanation: 'conflict!', suggestedProbe: 'which is right?' })],
      },
      refine: { decisions: [] },
    });
    const result = await runTurn(
      state({
        userMessage: 'x',
        questions: [q({ id: 'a' })],
        config: { contradictionMode: 'flag' },
        existingAnswers: TWO_ANSWERS,
      }),
      invokers
    );
    expect(calls.detect).toHaveLength(1);
    expect(result.contradictions).toHaveLength(1);
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: 'warning',
        code: 'contradiction',
        message: 'which is right?',
      })
    );
    expect(slugs(result.toolCalls)).toContain(DETECT_CONTRADICTIONS_CAPABILITY_SLUG);
  });

  it('skips detection when the contradiction flag is off (config on)', async () => {
    const { invokers, calls } = stubInvokers();
    await runTurn(
      state({
        userMessage: 'x',
        questions: [q({ id: 'a' })],
        config: { contradictionMode: 'flag' },
        flags: { contradiction: false },
        existingAnswers: TWO_ANSWERS,
      }),
      invokers
    );
    expect(calls.detect).toHaveLength(0);
  });

  it('skips detection below the two-answer floor (the detector capability needs ≥2)', async () => {
    const { invokers, calls } = stubInvokers({ detect: { findings: [finding()] } });
    const result = await runTurn(
      state({
        userMessage: 'x',
        questions: [q({ id: 'a' })],
        config: { contradictionMode: 'flag' },
        existingAnswers: [{ slotKey: 'a', value: 1, provenance: 'direct' }],
      }),
      invokers
    );
    // Only one answer → detection would fail the capability's args validation, so skip it.
    expect(calls.detect).toHaveLength(0);
    expect(result.contradictions).toHaveLength(0);
    expect(slugs(result.toolCalls)).not.toContain(DETECT_CONTRADICTIONS_CAPABILITY_SLUG);
  });
});

describe('runTurn — refinement', () => {
  it('refines when a contradiction was flagged and refinement is on', async () => {
    const { invokers, calls } = stubInvokers({
      detect: { findings: [finding()] },
      refine: { decisions: [decision({ slotKey: 'a' })], costUsd: 0.001 },
    });
    const result = await runTurn(
      state({
        userMessage: 'x',
        questions: [q({ id: 'a' })],
        config: { contradictionMode: 'probe' },
        existingAnswers: TWO_ANSWERS,
      }),
      invokers
    );
    expect(calls.refine).toHaveLength(1);
    expect(calls.refine[0]?.trigger.contradiction).toBeDefined();
    expect(result.sideEffects.answerRefinements).toHaveLength(1);
    expect(slugs(result.toolCalls)).toContain(REFINE_ANSWER_CAPABILITY_SLUG);
  });

  it('does not refine when contradictions exist but refinement is off', async () => {
    const { invokers, calls } = stubInvokers({ detect: { findings: [finding()] } });
    const result = await runTurn(
      state({
        userMessage: 'x',
        questions: [q({ id: 'a' })],
        config: { contradictionMode: 'flag' },
        flags: { refinement: false },
        existingAnswers: TWO_ANSWERS,
      }),
      invokers
    );
    expect(calls.refine).toHaveLength(0);
    expect(result.sideEffects.answerRefinements).toHaveLength(0);
  });

  it('does not refine when no contradiction was found', async () => {
    const { invokers, calls } = stubInvokers({ detect: { findings: [] } });
    await runTurn(
      state({
        userMessage: 'x',
        questions: [q({ id: 'a' })],
        config: { contradictionMode: 'flag' },
        existingAnswers: TWO_ANSWERS,
      }),
      invokers
    );
    expect(calls.refine).toHaveLength(0);
  });
});

describe('runTurn — completion offer', () => {
  const offerState = () =>
    state({
      userMessage: '',
      questions: [q({ id: 'a', key: 'a', prompt: 'Q A' }), q({ id: 'b', key: 'b', prompt: 'Q B' })],
      answered: [
        { questionId: 'a', confidence: null },
        { questionId: 'b', confidence: null },
      ],
      config: { minQuestionsAnswered: 2 },
    });

  it('returns an offer with composer input (covered/remaining) when completion is on', async () => {
    const { invokers, calls } = stubInvokers();
    const result = await runTurn(offerState(), invokers);

    expect(result.response.kind).toBe('offer');
    if (result.response.kind === 'offer') {
      expect(result.response.input.coveredSlots.map((s) => s.key)).toEqual(['a', 'b']);
      expect(result.response.input.remainingSlots).toEqual([]);
      expect(result.response.input.answeredCount).toBe(2);
    }
    expect(result.targetedQuestionId).toBeNull();
    expect(calls.select).toHaveLength(0);
    expect(slugs(result.toolCalls)).toContain(COMPOSE_COMPLETION_OFFER_CAPABILITY_SLUG);
  });

  it('falls back to a plain completion message when offer phrasing is disabled', async () => {
    const { invokers, calls } = stubInvokers();
    const s = offerState();
    s.flags.completion = false;
    const result = await runTurn(s, invokers);

    expect(result.response).toEqual({ kind: 'complete', text: COMPLETE_MESSAGE });
    expect(calls.select).toHaveLength(0);
    expect(slugs(result.toolCalls)).not.toContain(COMPOSE_COMPLETION_OFFER_CAPABILITY_SLUG);
  });
});

describe('runTurn — selection terminal branches', () => {
  it('maps a selection complete decision to a completion response', async () => {
    const { invokers, calls } = stubInvokers({
      select: { decision: { kind: 'complete', rationale: 'done' } },
    });
    // An unanswered required question → blocked_on_required (not offer) → selection runs,
    // and here it returns `complete`.
    const result = await runTurn(
      state({
        userMessage: '',
        questions: [q({ id: 'a', required: true })],
        config: { coverageThreshold: 0, minQuestionsAnswered: 0 },
      }),
      invokers
    );
    expect(result.assessment.kind).toBe('blocked_on_required');
    expect(calls.select).toHaveLength(1);
    expect(result.response).toEqual({ kind: 'complete', text: COMPLETE_MESSAGE });
    expect(result.targetedQuestionId).toBeNull();
  });

  it('maps a selection none decision to a none response', async () => {
    const { invokers } = stubInvokers({
      select: { decision: { kind: 'none', rationale: 'nothing left' } },
    });
    const result = await runTurn(
      state({
        userMessage: '',
        questions: [q({ id: 'a', required: true })],
        // required unanswered → blocked_on_required (not offer) → selection runs
        config: { coverageThreshold: 0, minQuestionsAnswered: 0 },
      }),
      invokers
    );
    expect(result.response).toEqual({ kind: 'none', text: NONE_MESSAGE });
    expect(result.targetedQuestionId).toBeNull();
  });
});

describe('runTurn — cost summing', () => {
  it('sums invoker costs and the selection ask cost', async () => {
    const { invokers } = stubInvokers({
      extract: { intents: [intent({ slotKey: 'a' })], costUsd: 0.002 },
      detect: { findings: [finding()], costUsd: 0.003 },
      refine: { decisions: [decision({ slotKey: 'a' })], costUsd: 0.001 },
      select: { decision: { kind: 'ask', questionId: 'b', rationale: 'next', costUsd: 0.004 } },
    });
    const result = await runTurn(
      state({
        userMessage: 'x',
        questions: [q({ id: 'a', key: 'a' }), q({ id: 'b', key: 'b' })],
        config: { contradictionMode: 'flag', coverageThreshold: 1, minQuestionsAnswered: 5 },
        existingAnswers: TWO_ANSWERS,
      }),
      invokers
    );
    expect(result.costUsd).toBeCloseTo(0.002 + 0.003 + 0.001 + 0.004);
  });
});

describe('applyIntents (pure merge)', () => {
  it('adds a newly answered question to coverage and its value to existingAnswers', () => {
    const s = state({
      questions: [q({ id: 'a', key: 'a' }), q({ id: 'b', key: 'b' })],
      answered: [{ questionId: 'a', confidence: 0.5 }],
      existingAnswers: [{ slotKey: 'a', value: 'old', provenance: 'direct' }],
    });
    const next = applyIntents(s, [intent({ slotKey: 'b', value: 'new', confidence: 0.9 })]);

    expect(next.answered).toContainEqual({ questionId: 'b', confidence: 0.9 });
    expect(next.existingAnswers.find((e) => e.slotKey === 'b')?.value).toBe('new');
    // pure — original untouched
    expect(s.answered).toHaveLength(1);
    expect(s.existingAnswers).toHaveLength(1);
  });

  it('updates an existing answer value/provenance in place (no duplicate slot)', () => {
    const s = state({
      questions: [q({ id: 'a', key: 'a' })],
      answered: [{ questionId: 'a', confidence: 0.4 }],
      existingAnswers: [{ slotKey: 'a', value: 'old', provenance: 'direct' }],
    });
    const next = applyIntents(s, [
      intent({ slotKey: 'a', value: 'corrected', provenance: 'refined' }),
    ]);

    const a = next.existingAnswers.filter((e) => e.slotKey === 'a');
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ value: 'corrected', provenance: 'refined' });
    // already-answered question stays a single coverage entry
    expect(next.answered.filter((e) => e.questionId === 'a')).toHaveLength(1);
  });

  it('returns the same state reference when there are no intents', () => {
    const s = state({ questions: [q({ id: 'a' })] });
    expect(applyIntents(s, [])).toBe(s);
  });
});
