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

/** Two captured answers — comfortably above the detector floor (≥1 with a message, else ≥2). */
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
    // The blue notice is purely INFORMATIONAL — it shows the explanation, never the probe question
    // (under `probe` mode the question is asked separately; flag mode never asks).
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: 'warning',
        code: 'contradiction',
        message: 'conflict!',
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

  it('honours the every_n_turns cadence — skips an off-boundary turn, runs on a boundary', async () => {
    // every_n_turns = 2 → run on rounds 0, 2, 4; skip odd rounds.
    const skipped = stubInvokers();
    await runTurn(
      state({
        userMessage: 'x',
        questions: [q({ id: 'a' })],
        config: { contradictionMode: 'flag', contradictionEveryNTurns: 2 },
        existingAnswers: TWO_ANSWERS,
        selectionRound: 1,
      }),
      skipped.invokers
    );
    expect(skipped.calls.detect).toHaveLength(0);

    const ran = stubInvokers();
    await runTurn(
      state({
        userMessage: 'x',
        questions: [q({ id: 'a' })],
        config: { contradictionMode: 'flag', contradictionEveryNTurns: 2 },
        existingAnswers: TWO_ANSWERS,
        selectionRound: 2,
      }),
      ran.invokers
    );
    expect(ran.calls.detect).toHaveLength(1);
  });

  it('detects with a SINGLE stored answer + a message (it can contradict the latest message)', async () => {
    // The reversal floor: one stored answer is enough when there's a latest message to weigh it
    // against (the detector receives it as `currentStatement`). This is the fix for the case where
    // only `satisfaction` was answered before the contradicting "I love my job" turn.
    const { invokers, calls } = stubInvokers({
      detect: { findings: [finding({ slotKeys: ['a'] })] },
    });
    const result = await runTurn(
      state({
        userMessage: 'x',
        questions: [q({ id: 'a' })],
        config: { contradictionMode: 'flag' },
        existingAnswers: [{ slotKey: 'a', value: 1, provenance: 'direct' }],
      }),
      invokers
    );
    expect(calls.detect).toHaveLength(1);
    expect(result.contradictions).toHaveLength(1);
    expect(slugs(result.toolCalls)).toContain(DETECT_CONTRADICTIONS_CAPABILITY_SLUG);
  });

  it('skips detection with NO stored answers (nothing to contradict yet)', async () => {
    const { invokers, calls } = stubInvokers({ detect: { findings: [finding()] } });
    await runTurn(
      state({
        userMessage: 'x',
        questions: [q({ id: 'a' })],
        config: { contradictionMode: 'flag' },
        existingAnswers: [],
      }),
      invokers
    );
    expect(calls.detect).toHaveLength(0);
  });

  it('detects against the PRE-merge answers — a value overwritten this turn stays visible', async () => {
    // This turn's extraction overwrites `a` (1 → 9); detection must still see the OLD value (1),
    // so it runs against the pre-merge answers, not the merged effective state.
    const { invokers, calls } = stubInvokers({
      extract: { intents: [intent({ slotKey: 'a', value: 9 })] },
      detect: { findings: [finding({ slotKeys: ['a'] })] },
    });
    await runTurn(
      state({
        userMessage: 'actually the opposite',
        questions: [q({ id: 'a', key: 'a' })],
        config: { contradictionMode: 'flag' },
        existingAnswers: [{ slotKey: 'a', value: 1, provenance: 'direct' }],
      }),
      invokers
    );
    expect(calls.detect).toHaveLength(1);
    // The detector saw the pre-merge value (1), not this turn's overwrite (9).
    const detectedAnswers = calls.detect[0]?.existingAnswers.find((a) => a.slotKey === 'a');
    expect(detectedAnswers?.value).toBe(1);
  });
});

describe('runTurn — refinement', () => {
  it('refines immediately under flag mode when a contradiction is found and refinement is on', async () => {
    // Flag mode keeps the historical behaviour: surface the explanation AND refine the same turn.
    // (Probe mode now DEFERS — see the probe-confirm flow tests below.)
    const { invokers, calls } = stubInvokers({
      detect: { findings: [finding()] },
      refine: { decisions: [decision({ slotKey: 'a' })], costUsd: 0.001 },
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

describe('runTurn — probe-confirm contradiction flow (probe mode)', () => {
  it('DEFERS on a fresh contradiction: asks the reconciliation question, suppresses writes, parks it', async () => {
    const { invokers, calls } = stubInvokers({
      detect: {
        findings: [
          finding({
            slotKeys: ['a'],
            explanation: 'Said A then not-A.',
            suggestedProbe: 'Which of those is right?',
          }),
        ],
      },
      // This turn's extraction captured a value — it must be suppressed until the respondent confirms.
      extract: { intents: [intent({ slotKey: 'a', value: 9 })] },
    });
    const result = await runTurn(
      state({
        userMessage: 'actually the opposite',
        questions: [q({ id: 'a', key: 'a', prompt: 'Question A' })],
        config: { contradictionMode: 'probe', contradictionWindowN: 1 },
        existingAnswers: TWO_ANSWERS,
      }),
      invokers
    );
    expect(result.response.kind).toBe('contradiction_probe');
    if (result.response.kind === 'contradiction_probe') {
      expect(result.response.text).toContain('Which of those is right?');
      expect(result.response.text.toLowerCase()).toContain('update your earlier answer');
    }
    // Informational notice = explanation, not the question.
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: 'warning',
        code: 'contradiction',
        message: 'Said A then not-A.',
      })
    );
    // No write, no refine, no selection this turn; the finding is parked.
    expect(result.sideEffects.answerUpserts).toHaveLength(0);
    expect(calls.refine).toHaveLength(0);
    expect(calls.select).toHaveLength(0);
    expect(result.sideEffects.pendingContradiction).toMatchObject({ slotKeys: ['a'] });
  });

  it('RESOLVES a parked pending contradiction with the refiner and clears it (no fresh detection)', async () => {
    const { invokers, calls } = stubInvokers({
      refine: { decisions: [decision({ slotKey: 'a' })] },
      detect: { findings: [finding({ slotKeys: ['a'] })] }, // must NOT be called on a resolution turn
    });
    const result = await runTurn(
      {
        ...state({
          userMessage: 'yes, confirm the new one',
          questions: [q({ id: 'a', key: 'a' })],
          config: { contradictionMode: 'probe', contradictionWindowN: 1 },
          existingAnswers: TWO_ANSWERS,
        }),
        pendingContradiction: {
          slotKeys: ['a'],
          explanation: 'A vs not-A',
          statement: 'actually the opposite',
          raisedAtTurnIndex: 0,
        },
      },
      invokers
    );
    expect(calls.refine).toHaveLength(1);
    expect(calls.detect).toHaveLength(0);
    expect(result.sideEffects.answerRefinements).toHaveLength(1);
    expect(result.sideEffects.pendingContradiction).toBeNull();
    // Proceeds to normal selection (not another probe).
    expect(result.response.kind).not.toBe('contradiction_probe');
    expect(calls.select).toHaveLength(1);
  });

  it('leaves the session pending state untouched when there is nothing to do', async () => {
    // No pending, no contradiction → the side effect is omitted (undefined), so the route leaves the
    // column as-is rather than clearing a (non-existent) pending state.
    const { invokers } = stubInvokers({ detect: { findings: [] } });
    const result = await runTurn(
      state({
        userMessage: 'x',
        questions: [q({ id: 'a' })],
        config: { contradictionMode: 'probe', contradictionWindowN: 1 },
        existingAnswers: TWO_ANSWERS,
      }),
      invokers
    );
    expect(result.sideEffects.pendingContradiction).toBeUndefined();
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

describe('runTurn — soft cost cap (F6.3)', () => {
  it('biases a not_ready turn into an offer when costPressure is soft and ≥1 answered', async () => {
    // Two questions, one answered → coverage 0.5 < default threshold → not_ready, answeredCount 1.
    const { invokers, calls } = stubInvokers();
    const result = await runTurn(
      state({
        questions: [q({ id: 'a', key: 'a' }), q({ id: 'b', key: 'b' })],
        answered: [{ questionId: 'a', confidence: null }],
        costPressure: 'soft',
      }),
      invokers
    );

    // The deterministic assessment is unchanged (honest), but the response is an early offer.
    expect(result.assessment.kind).toBe('not_ready');
    expect(result.response.kind).toBe('offer');
    expect(calls.select).toHaveLength(0);
    expect(slugs(result.toolCalls)).toEqual([COMPOSE_COMPLETION_OFFER_CAPABILITY_SLUG]);
    // The composer input carries the wrap-up flag so the prose nudges submission.
    if (result.response.kind === 'offer') {
      expect(result.response.input.costWrapUp).toBe(true);
    }
  });

  it('does NOT force an offer on an empty session (answeredCount 0) — selection still runs', async () => {
    const { invokers, calls } = stubInvokers({
      select: { decision: { kind: 'ask', questionId: 'a', rationale: 'first', costUsd: 0 } },
    });
    const result = await runTurn(
      state({
        questions: [q({ id: 'a', key: 'a' }), q({ id: 'b', key: 'b' })],
        costPressure: 'soft',
      }),
      invokers
    );

    expect(result.assessment.answeredCount).toBe(0);
    expect(result.response.kind).toBe('question');
    expect(calls.select).toHaveLength(1);
  });

  it('does NOT bypass the required-questions gate (blocked_on_required stays authoritative)', async () => {
    // `a` is required + unanswered → blocked_on_required even though `b` is answered.
    const { invokers } = stubInvokers({
      select: { decision: { kind: 'ask', questionId: 'a', rationale: 'ask required', costUsd: 0 } },
    });
    const result = await runTurn(
      state({
        questions: [q({ id: 'a', key: 'a', required: true }), q({ id: 'b', key: 'b' })],
        answered: [{ questionId: 'b', confidence: null }],
        costPressure: 'soft',
      }),
      invokers
    );

    expect(result.assessment.kind).toBe('blocked_on_required');
    expect(result.response.kind).toBe('question');
  });

  it('tags an already-eligible offer with costWrapUp under soft pressure', async () => {
    // Both answered → offer regardless; soft pressure should still set the wrap-up flag.
    const { invokers } = stubInvokers();
    const result = await runTurn(
      state({
        questions: [q({ id: 'a', key: 'a' }), q({ id: 'b', key: 'b' })],
        answered: [
          { questionId: 'a', confidence: null },
          { questionId: 'b', confidence: null },
        ],
        config: { minQuestionsAnswered: 2 },
        costPressure: 'soft',
      }),
      invokers
    );

    expect(result.assessment.kind).toBe('offer');
    expect(result.response.kind).toBe('offer');
    if (result.response.kind === 'offer') {
      expect(result.response.input.costWrapUp).toBe(true);
    }
  });

  it('omits costWrapUp when there is no cost pressure', async () => {
    const { invokers } = stubInvokers();
    const result = await runTurn(
      state({
        questions: [q({ id: 'a', key: 'a' }), q({ id: 'b', key: 'b' })],
        answered: [
          { questionId: 'a', confidence: null },
          { questionId: 'b', confidence: null },
        ],
        config: { minQuestionsAnswered: 2 },
      }),
      invokers
    );

    expect(result.response.kind).toBe('offer');
    if (result.response.kind === 'offer') {
      expect(result.response.input.costWrapUp).toBeUndefined();
    }
  });
});
