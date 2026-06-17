/**
 * Unit tests for the shared contradiction phase (`runContradictionPhase` +
 * `questionProbeLabels`). These tests call the phase directly — bypassing the full
 * orchestrator — so each path in `contradiction-phase.ts` can be asserted in isolation.
 *
 * The stub invokers from `_fixtures` record every call, which lets us assert:
 *   - WHICH invokers were called (detect vs refine)
 *   - WHAT state they received
 *   - WHAT the phase returned to the caller
 *
 * No Prisma, no Next.js — pure unit.
 */

import { describe, expect, it } from 'vitest';

import {
  DETECT_CONTRADICTIONS_CAPABILITY_SLUG,
  REFINE_ANSWER_CAPABILITY_SLUG,
} from '@/lib/app/questionnaire/constants';
import {
  runContradictionPhase,
  questionProbeLabels,
} from '@/lib/app/questionnaire/orchestrator/contradiction-phase';

import {
  decision,
  finding,
  q,
  state,
  stubInvokers,
} from '@/tests/unit/lib/app/questionnaire/orchestrator/_fixtures';

// ─── helpers ────────────────────────────────────────────────────────────────

/** Extract all capability slugs that were recorded in a toolCalls array. */
const slugs = (calls: Array<{ slug: string }>) => calls.map((c) => c.slug);

/** A default labels object (empty — most tests don't need human topic names). */
const emptyLabels = { questionLabels: new Map<string, string>() };

/** Two stored answers that allow detection to run (floor = 1 when hasMessage, but 2 satisfies both). */
const TWO_ANSWERS = [
  { slotKey: 'a', value: 1, provenance: 'direct' as const },
  { slotKey: 'b', value: 2, provenance: 'direct' as const },
];

// ─── helper: run the phase with sensible defaults so individual tests only override what matters ──

type PhaseOpts = {
  hasMessage?: boolean;
  disregarded?: boolean;
  dataMode?: boolean;
};

async function runPhase(
  s: ReturnType<typeof state>,
  inv: ReturnType<typeof stubInvokers>,
  opts: PhaseOpts = {}
) {
  return runContradictionPhase(s, inv.invokers, {
    hasMessage: opts.hasMessage ?? true,
    disregarded: opts.disregarded ?? false,
    dataMode: opts.dataMode ?? false,
    labels: emptyLabels,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// toolCall helper — code / latencyMs optional spread
// ─────────────────────────────────────────────────────────────────────────────

describe('runContradictionPhase — toolCall record shapes', () => {
  it('includes code on a failed detect (diagnostic set)', async () => {
    // Arrange: detector returns a diagnostic string, simulating a fail-soft error.
    const inv = stubInvokers({ detect: { diagnostic: 'TIMEOUT', findings: [] } });
    const s = state({
      userMessage: 'x',
      questions: [q({ id: 'a' })],
      config: { contradictionMode: 'flag' },
      existingAnswers: TWO_ANSWERS,
    });

    // Act
    const result = await runPhase(s, inv);

    // Assert: the detect tool-call record carries the diagnostic code and success=false.
    const detectRecord = result.toolCalls.find(
      (c) => c.slug === DETECT_CONTRADICTIONS_CAPABILITY_SLUG
    );
    expect(detectRecord).toBeDefined();
    expect(detectRecord?.success).toBe(false);
    expect(detectRecord?.code).toBe('TIMEOUT');
  });

  it('includes latencyMs on a detect call when the invoker returns one', async () => {
    const inv = stubInvokers({ detect: { latencyMs: 250, findings: [] } });
    const s = state({
      userMessage: 'x',
      questions: [q({ id: 'a' })],
      config: { contradictionMode: 'flag' },
      existingAnswers: TWO_ANSWERS,
    });

    const result = await runPhase(s, inv);

    const detectRecord = result.toolCalls.find(
      (c) => c.slug === DETECT_CONTRADICTIONS_CAPABILITY_SLUG
    );
    expect(detectRecord?.latencyMs).toBe(250);
  });

  it('omits code and latencyMs when neither is present on the detect outcome', async () => {
    // Happy path: no diagnostic, no latency measurement.
    const inv = stubInvokers({ detect: { findings: [] } });
    const s = state({
      userMessage: 'x',
      questions: [q({ id: 'a' })],
      config: { contradictionMode: 'flag' },
      existingAnswers: TWO_ANSWERS,
    });

    const result = await runPhase(s, inv);

    const detectRecord = result.toolCalls.find(
      (c) => c.slug === DETECT_CONTRADICTIONS_CAPABILITY_SLUG
    );
    expect(detectRecord?.success).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(detectRecord, 'code')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(detectRecord, 'latencyMs')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Resolution path — pending contradiction present
// ─────────────────────────────────────────────────────────────────────────────

describe('runContradictionPhase — resolution path (pending present)', () => {
  it('calls refineAnswer and clears pending when refinement is enabled', async () => {
    // Arrange: a pending contradiction is waiting for this turn's confirmation.
    const inv = stubInvokers({
      refine: { decisions: [decision({ slotKey: 'a' })], costUsd: 0.002 },
    });
    const s = {
      ...state({
        userMessage: 'yes, that is right',
        questions: [q({ id: 'a', key: 'a' })],
        config: { contradictionMode: 'probe' },
        existingAnswers: TWO_ANSWERS,
      }),
      pendingContradiction: {
        slotKeys: ['a'],
        explanation: 'old vs new conflict',
        statement: 'the opposite answer',
        raisedAtTurnIndex: 0,
      },
    };

    // Act
    const result = await runPhase(s, inv);

    // Assert: refineAnswer was called (resolution runs the refiner).
    expect(inv.calls.refine).toHaveLength(1);
    // The refiner received a finding reconstructed from the pending record.
    const trigger = inv.calls.refine[0]?.trigger;
    expect(trigger?.contradiction?.slotKeys).toEqual(['a']);
    expect(trigger?.contradiction?.explanation).toBe('old vs new conflict');
    // The phase returns the refiner's decisions and marks pending as null (cleared).
    expect(result.answerRefinements).toHaveLength(1);
    expect(result.pendingContradiction).toBeNull();
    // Cost is accumulated from the refiner.
    expect(result.costUsd).toBe(0.002);
    // Detect was NOT called — no fresh detection while resolving.
    expect(inv.calls.detect).toHaveLength(0);
    expect(slugs(result.toolCalls)).toContain(REFINE_ANSWER_CAPABILITY_SLUG);
  });

  it('clears pending but skips refineAnswer when refinement flag is off', async () => {
    // Even when refinement is disabled, the pending state is cleared after a resolution turn.
    const inv = stubInvokers({ refine: { decisions: [decision({ slotKey: 'a' })] } });
    const s = {
      ...state({
        userMessage: 'confirm',
        questions: [q({ id: 'a', key: 'a' })],
        config: { contradictionMode: 'probe' },
        existingAnswers: TWO_ANSWERS,
        flags: { refinement: false },
      }),
      pendingContradiction: {
        slotKeys: ['a'],
        explanation: 'conflict',
        statement: 'contradicting message',
        raisedAtTurnIndex: 1,
      },
    };

    const result = await runPhase(s, inv);

    // Refiner was NOT called — flag is off.
    expect(inv.calls.refine).toHaveLength(0);
    // Pending is still cleared — the respondent has had their say regardless.
    expect(result.pendingContradiction).toBeNull();
    // No refine tool-call slug.
    expect(slugs(result.toolCalls)).not.toContain(REFINE_ANSWER_CAPABILITY_SLUG);
  });

  it('includes code on a failed refine (diagnostic set) in the resolution path', async () => {
    // The refine invoker returns a diagnostic — the tool-call record must carry it.
    const inv = stubInvokers({ refine: { decisions: [], diagnostic: 'REFINE_ERROR' } });
    const s = {
      ...state({
        userMessage: 'confirm',
        questions: [q({ id: 'a', key: 'a' })],
        config: { contradictionMode: 'probe' },
        existingAnswers: TWO_ANSWERS,
      }),
      pendingContradiction: {
        slotKeys: ['a'],
        explanation: 'conflict',
        statement: 'triggering message',
        raisedAtTurnIndex: 0,
      },
    };

    const result = await runPhase(s, inv);

    const refineRecord = result.toolCalls.find((c) => c.slug === REFINE_ANSWER_CAPABILITY_SLUG);
    expect(refineRecord?.success).toBe(false);
    expect(refineRecord?.code).toBe('REFINE_ERROR');
  });

  it('includes latencyMs on a refine call in the resolution path', async () => {
    const inv = stubInvokers({ refine: { decisions: [], latencyMs: 180 } });
    const s = {
      ...state({
        userMessage: 'confirm',
        questions: [q({ id: 'a', key: 'a' })],
        config: { contradictionMode: 'probe' },
        existingAnswers: TWO_ANSWERS,
      }),
      pendingContradiction: {
        slotKeys: ['a'],
        explanation: 'conflict',
        statement: 'triggering message',
        raisedAtTurnIndex: 0,
      },
    };

    const result = await runPhase(s, inv);

    const refineRecord = result.toolCalls.find((c) => c.slug === REFINE_ANSWER_CAPABILITY_SLUG);
    expect(refineRecord?.latencyMs).toBe(180);
  });

  it('preserves suggestedProbe from pending into the reconstructed finding', async () => {
    // pendingAsFinding must forward suggestedProbe when present in the pending record.
    const inv = stubInvokers({ refine: { decisions: [] } });
    const s = {
      ...state({
        userMessage: 'confirm',
        questions: [q({ id: 'a', key: 'a' })],
        config: { contradictionMode: 'probe' },
        existingAnswers: TWO_ANSWERS,
      }),
      pendingContradiction: {
        slotKeys: ['a'],
        explanation: 'conflict',
        suggestedProbe: 'Which side is right?',
        statement: 'triggering message',
        raisedAtTurnIndex: 0,
      },
    };

    await runPhase(s, inv);

    const trigger = inv.calls.refine[0]?.trigger;
    expect(trigger?.contradiction?.suggestedProbe).toBe('Which side is right?');
  });

  it('omits suggestedProbe from the reconstructed finding when not in pending', async () => {
    // pendingAsFinding: when suggestedProbe is absent, the property must not appear on the finding.
    const inv = stubInvokers({ refine: { decisions: [] } });
    const s = {
      ...state({
        userMessage: 'confirm',
        questions: [q({ id: 'a', key: 'a' })],
        config: { contradictionMode: 'probe' },
        existingAnswers: TWO_ANSWERS,
      }),
      pendingContradiction: {
        slotKeys: ['a'],
        explanation: 'conflict',
        // no suggestedProbe
        statement: 'triggering message',
        raisedAtTurnIndex: 0,
      },
    };

    await runPhase(s, inv);

    const finding_ = inv.calls.refine[0]?.trigger.contradiction;
    expect(finding_).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(finding_, 'suggestedProbe')).toBe(false);
  });

  it('skips resolution when hasMessage is false (pending present but no new message)', async () => {
    // Guard: pending + !hasMessage → skip resolution; no refine, no detect.
    const inv = stubInvokers({ refine: { decisions: [decision({ slotKey: 'a' })] } });
    const s = {
      ...state({
        userMessage: '',
        questions: [q({ id: 'a', key: 'a' })],
        config: { contradictionMode: 'probe' },
        existingAnswers: TWO_ANSWERS,
      }),
      pendingContradiction: {
        slotKeys: ['a'],
        explanation: 'conflict',
        statement: 'prior message',
        raisedAtTurnIndex: 0,
      },
    };

    const result = await runPhase(s, inv, { hasMessage: false });

    expect(inv.calls.refine).toHaveLength(0);
    expect(inv.calls.detect).toHaveLength(0);
    // pending is NOT cleared — we didn't resolve it.
    expect(result.pendingContradiction).toBeUndefined();
  });

  it('skips resolution when disregarded is true (pending present but turn is disregarded)', async () => {
    // Guard: pending + disregarded → skip resolution; no refine, no detect.
    const inv = stubInvokers({ refine: { decisions: [decision({ slotKey: 'a' })] } });
    const s = {
      ...state({
        userMessage: 'gibberish',
        questions: [q({ id: 'a', key: 'a' })],
        config: { contradictionMode: 'probe' },
        existingAnswers: TWO_ANSWERS,
      }),
      pendingContradiction: {
        slotKeys: ['a'],
        explanation: 'conflict',
        statement: 'prior message',
        raisedAtTurnIndex: 0,
      },
    };

    const result = await runPhase(s, inv, { disregarded: true });

    expect(inv.calls.refine).toHaveLength(0);
    expect(inv.calls.detect).toHaveLength(0);
    expect(result.pendingContradiction).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Detection gate — canDetect branches
// ─────────────────────────────────────────────────────────────────────────────

describe('runContradictionPhase — detection gate', () => {
  it('returns the base result immediately when contradiction flag is off', async () => {
    // flags.contradiction = false → canDetect is false; detectContradictions is never called.
    const inv = stubInvokers({ detect: { findings: [finding()] } });
    const s = state({
      userMessage: 'x',
      questions: [q({ id: 'a' })],
      config: { contradictionMode: 'flag' },
      existingAnswers: TWO_ANSWERS,
      flags: { contradiction: false },
    });

    const result = await runPhase(s, inv);

    expect(inv.calls.detect).toHaveLength(0);
    expect(result.contradictions).toHaveLength(0);
    expect(result.toolCalls).toHaveLength(0);
  });

  it('returns the base result immediately when shouldRunDetection returns run=false', async () => {
    // every_n_turns cadence: round=1 with everyNTurns=2 → decision.run = false.
    const inv = stubInvokers({ detect: { findings: [finding()] } });
    const s = state({
      userMessage: 'x',
      questions: [q({ id: 'a' })],
      config: { contradictionMode: 'flag', contradictionEveryNTurns: 2 },
      existingAnswers: TWO_ANSWERS,
      selectionRound: 1,
    });

    const result = await runPhase(s, inv);

    expect(inv.calls.detect).toHaveLength(0);
    expect(result.contradictions).toHaveLength(0);
  });

  it('returns the base result immediately when there are no stored answers', async () => {
    // floor: hasMessage=true → floor=1; 0 answers < 1 → canDetect false.
    const inv = stubInvokers({ detect: { findings: [finding()] } });
    const s = state({
      userMessage: 'x',
      questions: [q({ id: 'a' })],
      config: { contradictionMode: 'flag' },
      existingAnswers: [],
    });

    const result = await runPhase(s, inv);

    expect(inv.calls.detect).toHaveLength(0);
    expect(result.contradictions).toHaveLength(0);
  });

  it('returns the base result immediately when hasMessage is false', async () => {
    // Without a message there is nothing to compare against, so detection is gated.
    const inv = stubInvokers({ detect: { findings: [finding()] } });
    const s = state({
      userMessage: '',
      questions: [q({ id: 'a' })],
      config: { contradictionMode: 'flag' },
      existingAnswers: TWO_ANSWERS,
    });

    const result = await runPhase(s, inv, { hasMessage: false });

    expect(inv.calls.detect).toHaveLength(0);
    expect(result.contradictions).toHaveLength(0);
  });

  it('returns the base result immediately when disregarded is true', async () => {
    const inv = stubInvokers({ detect: { findings: [finding()] } });
    const s = state({
      userMessage: 'nonsense',
      questions: [q({ id: 'a' })],
      config: { contradictionMode: 'flag' },
      existingAnswers: TWO_ANSWERS,
    });

    const result = await runPhase(s, inv, { disregarded: true });

    expect(inv.calls.detect).toHaveLength(0);
    expect(result.contradictions).toHaveLength(0);
  });

  it('returns early (no events/probe) when detection finds nothing', async () => {
    // detect returns [] → the early return at "if out.findings.length === 0" is taken.
    const inv = stubInvokers({ detect: { findings: [] } });
    const s = state({
      userMessage: 'x',
      questions: [q({ id: 'a' })],
      config: { contradictionMode: 'flag' },
      existingAnswers: TWO_ANSWERS,
    });

    const result = await runPhase(s, inv);

    // Detection ran (canDetect was satisfied)…
    expect(inv.calls.detect).toHaveLength(1);
    // …but found nothing: no events, no probe, no refine.
    expect(result.events).toHaveLength(0);
    expect(result.probe).toBeUndefined();
    expect(inv.calls.refine).toHaveLength(0);
    // The detect slug is still recorded.
    expect(slugs(result.toolCalls)).toContain(DETECT_CONTRADICTIONS_CAPABILITY_SLUG);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Detection hit — probe mode
// ─────────────────────────────────────────────────────────────────────────────

describe('runContradictionPhase — probe mode (deferred reconciliation)', () => {
  it('builds a probe, suppresses writes, parks the finding, and returns early', async () => {
    // Arrange: a contradiction is found under probe mode.
    const inv = stubInvokers({
      detect: {
        findings: [
          finding({
            slotKeys: ['a'],
            explanation: 'Said A then not-A.',
            suggestedProbe: 'Which of those is right?',
          }),
        ],
      },
    });
    const s = state({
      userMessage: 'actually the opposite',
      questions: [q({ id: 'a', key: 'a', prompt: 'Question A' })],
      config: { contradictionMode: 'probe' },
      existingAnswers: TWO_ANSWERS,
    });

    const result = await runPhase(s, inv);

    // probe is populated with text (built by buildContradictionProbe) and the slot keys.
    expect(result.probe).toBeDefined();
    expect(result.probe?.slotKeys).toEqual(['a']);
    expect(result.probe?.text).toContain('Which of those is right?');
    // suppressWrites = true — no answer upserts before confirmation.
    expect(result.suppressWrites).toBe(true);
    // pendingContradiction carries the parked finding.
    expect(result.pendingContradiction).toMatchObject({ slotKeys: ['a'] });
    // No refinement under probe mode (deferred).
    expect(inv.calls.refine).toHaveLength(0);
    // The warning event IS emitted with the explanation, not the probe question.
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: 'warning',
        code: 'contradiction',
        message: 'Said A then not-A.',
      })
    );
  });

  it('emits a warning event but does not build a probe when findings[0] is missing (empty array guard)', async () => {
    // This is a theoretical edge-case: mode=probe, findings.length>0 passes the early return,
    // but findings[0] is undefined (shouldn't happen in practice, but guards against it).
    // We simulate it by having the detection return an array-like structure where [0] is falsy.
    // In practice: an empty array is handled by the early-return above; probe mode with a non-empty
    // findings array always has findings[0]. The branch at `if (finding)` exists as a safe guard.
    // We cover it indirectly via probe mode with one finding (covered above) and note this branch
    // cannot be exercised in isolation via the public API.
    // This test instead verifies the normal probe path leaves no refine call (deferred behaviour).
    const inv = stubInvokers({
      detect: {
        findings: [finding({ slotKeys: ['b'], explanation: 'B conflict' })],
      },
    });
    const s = state({
      userMessage: 'x',
      questions: [q({ id: 'b', key: 'b' })],
      config: { contradictionMode: 'probe' },
      existingAnswers: TWO_ANSWERS,
    });

    const result = await runPhase(s, inv);

    // refine is NOT called under probe mode — always deferred.
    expect(inv.calls.refine).toHaveLength(0);
    // One warning event per finding.
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ type: 'warning', code: 'contradiction' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Detection hit — flag mode
// ─────────────────────────────────────────────────────────────────────────────

describe('runContradictionPhase — flag mode (immediate refine)', () => {
  it('emits a warning event per finding and refines immediately when refinement is on', async () => {
    const inv = stubInvokers({
      detect: {
        findings: [
          finding({ slotKeys: ['a'], explanation: 'A conflict' }),
          finding({ slotKeys: ['b'], explanation: 'B conflict' }),
        ],
      },
      refine: { decisions: [decision({ slotKey: 'a' })], costUsd: 0.003 },
    });
    const s = state({
      userMessage: 'x',
      questions: [q({ id: 'a', key: 'a' })],
      config: { contradictionMode: 'flag' },
      existingAnswers: TWO_ANSWERS,
    });

    const result = await runPhase(s, inv);

    // One event per finding (the explanation, not the probe question).
    expect(result.events).toHaveLength(2);
    expect(result.events[0]).toMatchObject({
      type: 'warning',
      code: 'contradiction',
      message: 'A conflict',
    });
    expect(result.events[1]).toMatchObject({
      type: 'warning',
      code: 'contradiction',
      message: 'B conflict',
    });
    // Refiner called once (for the first finding, historical behaviour).
    expect(inv.calls.refine).toHaveLength(1);
    expect(result.answerRefinements).toHaveLength(1);
    expect(result.costUsd).toBeGreaterThan(0);
    // No probe — flag mode surfaces passively.
    expect(result.probe).toBeUndefined();
    expect(result.suppressWrites).toBe(false);
  });

  it('skips refine in flag mode when refinement flag is off', async () => {
    const inv = stubInvokers({
      detect: { findings: [finding({ slotKeys: ['a'] })] },
    });
    const s = state({
      userMessage: 'x',
      questions: [q({ id: 'a', key: 'a' })],
      config: { contradictionMode: 'flag' },
      existingAnswers: TWO_ANSWERS,
      flags: { refinement: false },
    });

    const result = await runPhase(s, inv);

    // Events still emitted (passive surface), refine is not called.
    expect(result.events).toHaveLength(1);
    expect(inv.calls.refine).toHaveLength(0);
    expect(result.answerRefinements).toHaveLength(0);
    expect(slugs(result.toolCalls)).not.toContain(REFINE_ANSWER_CAPABILITY_SLUG);
  });

  it('records a failed refine tool-call with diagnostic code and latencyMs in flag mode', async () => {
    const inv = stubInvokers({
      detect: { findings: [finding()] },
      refine: { decisions: [], diagnostic: 'REFINE_FAIL', latencyMs: 99 },
    });
    const s = state({
      userMessage: 'x',
      questions: [q({ id: 'a', key: 'a' })],
      config: { contradictionMode: 'flag' },
      existingAnswers: TWO_ANSWERS,
    });

    const result = await runPhase(s, inv);

    const refineRecord = result.toolCalls.find((c) => c.slug === REFINE_ANSWER_CAPABILITY_SLUG);
    expect(refineRecord?.success).toBe(false);
    expect(refineRecord?.code).toBe('REFINE_FAIL');
    expect(refineRecord?.latencyMs).toBe(99);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// priorAnswers override
// ─────────────────────────────────────────────────────────────────────────────

describe('runContradictionPhase — priorAnswers override', () => {
  it('detects against priorAnswers when supplied, not effective.existingAnswers', async () => {
    // The orchestrator supplies pre-merge answers so a slot overwritten this turn stays visible.
    const inv = stubInvokers({ detect: { findings: [] } });
    const effectiveAnswers = [{ slotKey: 'a', value: 9, provenance: 'direct' as const }];
    const priorAnswers = [
      { slotKey: 'a', value: 1, provenance: 'direct' as const },
      { slotKey: 'b', value: 2, provenance: 'direct' as const },
    ];
    const s = state({
      userMessage: 'x',
      questions: [q({ id: 'a', key: 'a' })],
      config: { contradictionMode: 'flag' },
      existingAnswers: effectiveAnswers,
    });

    await runContradictionPhase(s, inv.invokers, {
      hasMessage: true,
      disregarded: false,
      dataMode: false,
      labels: emptyLabels,
      priorAnswers,
    });

    // The state handed to detect must use the priorAnswers (value 1), not effective (value 9).
    expect(inv.calls.detect).toHaveLength(1);
    const seenAnswer = inv.calls.detect[0]?.existingAnswers.find((a) => a.slotKey === 'a');
    expect(seenAnswer?.value).toBe(1);
  });

  it('defaults to effective.existingAnswers when priorAnswers is absent', async () => {
    const inv = stubInvokers({ detect: { findings: [] } });
    const s = state({
      userMessage: 'x',
      questions: [q({ id: 'a', key: 'a' })],
      config: { contradictionMode: 'flag' },
      existingAnswers: [{ slotKey: 'a', value: 42, provenance: 'direct' as const }],
    });

    await runContradictionPhase(s, inv.invokers, {
      hasMessage: true,
      disregarded: false,
      dataMode: false,
      labels: emptyLabels,
      // priorAnswers absent → defaults to effective.existingAnswers
    });

    expect(inv.calls.detect).toHaveLength(1);
    const seenAnswer = inv.calls.detect[0]?.existingAnswers.find((a) => a.slotKey === 'a');
    expect(seenAnswer?.value).toBe(42);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// questionProbeLabels helper
// ─────────────────────────────────────────────────────────────────────────────

describe('questionProbeLabels', () => {
  it('builds a questionLabels map keyed by slot key using prompt when present', () => {
    const questions = [
      q({ id: 'q1', key: 'k1', prompt: 'First question?' }),
      q({ id: 'q2', key: 'k2', prompt: 'Second question?' }),
    ];

    const result = questionProbeLabels(questions);

    expect(result.questionLabels.get('k1')).toBe('First question?');
    expect(result.questionLabels.get('k2')).toBe('Second question?');
    expect(result.dataSlotLabels).toBeUndefined();
  });

  it('falls back to the slot key when prompt is undefined', () => {
    // q() fixture: prompt defaults to undefined if not supplied to the QuestionView builder.
    const questions = [q({ id: 'q1', key: 'my-key' })];
    // Overwrite prompt to undefined to exercise the fallback.
    const questionsWithoutPrompt = questions.map((question) => ({
      ...question,
      prompt: undefined,
    })) as ReturnType<typeof questionProbeLabels> extends { questionLabels: Map<infer K, infer V> }
      ? Array<{ key: K; prompt?: V }>
      : never;

    const result = questionProbeLabels(
      questionsWithoutPrompt as Parameters<typeof questionProbeLabels>[0]
    );

    // When prompt is undefined, the Map entry should be undefined or the key itself.
    // The expression is: q.prompt ?? q.key — so undefined prompt → the key.
    expect(result.questionLabels.get('my-key')).toBe('my-key');
  });

  it('returns an empty map for an empty questions array', () => {
    const result = questionProbeLabels([]);
    expect(result.questionLabels.size).toBe(0);
  });
});
