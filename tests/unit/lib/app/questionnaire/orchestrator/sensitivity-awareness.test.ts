/**
 * Unit tests for sensitivity awareness / safeguarding inside the pure per-turn orchestrator
 * (both `runTurn` and `runDataSlotTurn`).
 *
 * Stub invokers (no capability, no DB): the extractor's `sensitivity` assessment becomes a
 * `TurnResult.sensitivity` outcome with a running-max level; the support frame fires once on the
 * first high disclosure and only when a support message is configured; nothing happens when
 * `config.sensitivityAwareness` is off or when the abuse gate disregarded the turn.
 */

import { describe, expect, it } from 'vitest';

import { runTurn, runDataSlotTurn } from '@/lib/app/questionnaire/orchestrator';
import type { SensitivityAssessment } from '@/lib/app/questionnaire/sensitivity/types';
import { DEFAULT_SUPPORT_MESSAGE } from '@/lib/app/questionnaire/sensitivity';
import {
  intent,
  state as configState,
  stubInvokers,
  q,
} from '@/tests/unit/lib/app/questionnaire/orchestrator/_fixtures';

// Sensitivity awareness is off by default in the version config; this whole file exercises it ON, so
// default it on and let any per-case `config` (e.g. the explicit "feature off" tests) override.
const state = (input: Parameters<typeof configState>[0]) =>
  configState({ ...input, config: { sensitivityAwareness: true, ...input.config } });

const Q = [q({ id: 'a', prompt: 'How is work going?' })];
const HIGH: SensitivityAssessment = {
  detected: true,
  severity: 'high',
  category: 'harassment',
  summary: 'Reports mistreatment by a senior colleague.',
};

/** A support frame this turn, if any (the chat renders `code: 'support'`). */
function supportEvent(events: { type: string; code?: string; message?: string }[]) {
  return events.find((e) => e.type === 'warning' && e.code === 'support');
}

/** A sincerity ("Let's keep it genuine") frame this turn, if any. */
function seriousnessEvent(events: { type: string; code?: string; message?: string }[]) {
  return events.find((e) => e.type === 'warning' && e.code === 'seriousness');
}

describe('runTurn — sensitivity awareness', () => {
  it('returns a sensitivity outcome with the running-max level when the extractor flags a disclosure', async () => {
    const { invokers } = stubInvokers({
      extract: { intents: [intent({ slotKey: 'a', value: 'hard' })], sensitivity: HIGH },
    });
    const result = await runTurn(
      state({ userMessage: 'it has been hard', questions: Q, config: { supportMessage: '' } }),
      invokers
    );
    expect(result.sensitivity).toMatchObject({
      detected: true,
      severity: 'high',
      category: 'harassment',
      newLevel: 'high',
      signpost: true,
    });
  });

  it('escalates the running-max level from a prior level (medium → high)', async () => {
    // Prior session level is 'medium'; this turn discloses HIGH → running max must rise to 'high'.
    const highDisclosure: SensitivityAssessment = { ...HIGH, severity: 'high' };
    const { invokers } = stubInvokers({ extract: { sensitivity: highDisclosure } });
    const result = await runTurn(
      state({ userMessage: 'x', questions: Q, sensitivityLevel: 'medium' }),
      invokers
    );
    expect(result.sensitivity?.newLevel).toBe('high');
  });

  it('signposts the authored support message (once) when one is configured', async () => {
    const { invokers } = stubInvokers({ extract: { sensitivity: HIGH } });
    const withMsg = await runTurn(
      state({
        userMessage: 'x',
        questions: Q,
        config: { supportMessage: 'Support is available.', supportResourceUrl: 'https://help.x' },
      }),
      invokers
    );
    const ev = supportEvent(withMsg.events);
    expect(ev?.message).toBe('Support is available. https://help.x');
  });

  it('signposts a default message when the support message is empty (no silent footgun)', async () => {
    const { invokers } = stubInvokers({ extract: { sensitivity: HIGH } });
    const result = await runTurn(
      state({ userMessage: 'x', questions: Q, config: { supportMessage: '' } }),
      invokers
    );
    const ev = supportEvent(result.events);
    expect(ev?.message).toBe(DEFAULT_SUPPORT_MESSAGE);
    expect(result.sensitivity?.signpost).toBe(true);
  });

  it('does NOT signpost again once the session has already reached high', async () => {
    const { invokers } = stubInvokers({ extract: { sensitivity: HIGH } });
    const result = await runTurn(
      state({
        userMessage: 'x',
        questions: Q,
        sensitivityLevel: 'high',
        config: { supportMessage: 'Support is available.' },
      }),
      invokers
    );
    expect(result.sensitivity?.signpost).toBe(false);
    expect(supportEvent(result.events)).toBeUndefined();
  });

  it('produces no sensitivity outcome when the feature is off for this questionnaire', async () => {
    const { invokers } = stubInvokers({ extract: { sensitivity: HIGH } });
    const result = await runTurn(
      state({ userMessage: 'x', questions: Q, config: { sensitivityAwareness: false } }),
      invokers
    );
    expect(result.sensitivity).toBeUndefined();
  });

  it('SAFEGUARDING OUTRANKS THE SINCERITY GATE: a detected disclosure is never disregarded, struck, or warned — even if the judge would call it non-genuine', async () => {
    // The reported bug: "I'm being abused by the CEO" read as implausible by the sincerity judge,
    // which disregarded the answer + showed "Let's keep it genuine" AND suppressed the signpost.
    // With the extractor flagging a disclosure, the gate must be skipped entirely.
    const { invokers, calls } = stubInvokers({
      extract: { intents: [intent({ slotKey: 'a', value: 'abuse by ceo' })], sensitivity: HIGH },
      // Even a hostile non-serious verdict must NOT be acted on when a disclosure is present.
      serious: { verdict: { serious: false, reason: 'Sounds implausible.' } },
    });
    const result = await runTurn(
      state({
        userMessage: "i'm being abused by the ceo",
        questions: Q,
        config: { abuseThreshold: 4, supportMessage: 'Support is available.' },
      }),
      invokers
    );

    // The sincerity judge is never even called (skipped because a disclosure was detected).
    expect(calls.serious).toHaveLength(0);
    // No strike / abandon, no sincerity warning.
    expect(result.abuse).toBeUndefined();
    expect(seriousnessEvent(result.events)).toBeUndefined();
    // The answer is KEPT (not set aside).
    expect(result.sideEffects.answerUpserts).toHaveLength(1);
    // Safeguarding is handled: outcome recorded AND the support signpost fires.
    expect(result.sensitivity?.signpost).toBe(true);
    expect(supportEvent(result.events)?.message).toBe('Support is available.');
  });
});

describe('runTurn — dedicated sensitivity detector + keyword net (defence-in-depth)', () => {
  it('DETECTS via the dedicated detector even when the extractor MISSED the disclosure (the bug)', async () => {
    // The reported failure: the extractor's optional `sensitivity` field was dropped, so a real
    // disclosure went unflagged and the seriousness gate ran instead. The dedicated detector must
    // catch it: a sensitivity outcome IS produced and the gate is skipped.
    const { invokers, calls } = stubInvokers({
      extract: { intents: [] }, // extractor emits NO sensitivity field
      sensitivity: { assessment: HIGH }, // the dedicated detector catches it
      serious: { verdict: { serious: false, reason: 'hostile' } },
    });
    const result = await runTurn(
      state({
        userMessage: "i'm being abused by my manager",
        questions: Q,
        config: { abuseThreshold: 4, supportMessage: 'Support is available.' },
      }),
      invokers
    );
    expect(result.sensitivity?.detected).toBe(true);
    expect(result.sensitivity?.signpost).toBe(true);
    // Gate skipped — the detector signal set extractedSensitivity, so the judge never ran.
    expect(calls.serious).toHaveLength(0);
    expect(result.abuse).toBeUndefined();
  });

  it('DETECTS via the deterministic keyword net when BOTH the extractor and detector miss', async () => {
    // Both LLM signals empty; the keyword floor alone catches the first-person harm disclosure.
    const { invokers, calls } = stubInvokers({
      extract: { intents: [] },
      sensitivity: { assessment: null },
      serious: { verdict: { serious: false, reason: 'hostile' } },
    });
    const result = await runTurn(
      state({
        userMessage: 'I am being harassed at work',
        questions: Q,
        config: { abuseThreshold: 4 },
      }),
      invokers
    );
    expect(result.sensitivity?.detected).toBe(true);
    expect(result.sensitivity?.severity).toBe('high');
    expect(calls.serious).toHaveLength(0);
  });

  it('records an app_detect_sensitivity tool call when the feature is on', async () => {
    const { invokers } = stubInvokers({ sensitivity: { assessment: null } });
    const result = await runTurn(state({ userMessage: 'work is fine', questions: Q }), invokers);
    expect(result.toolCalls.some((t) => t.slug === 'app_detect_sensitivity')).toBe(true);
  });

  it('does NOT run the detector (no call, no tool record) when the feature is off', async () => {
    const { invokers, calls } = stubInvokers({ sensitivity: { assessment: HIGH } });
    const result = await runTurn(
      state({ userMessage: 'x', questions: Q, config: { sensitivityAwareness: false } }),
      invokers
    );
    expect(calls.sensitivity).toHaveLength(0);
    expect(result.toolCalls.some((t) => t.slug === 'app_detect_sensitivity')).toBe(false);
    expect(result.sensitivity).toBeUndefined();
  });

  it('strikes pure hostility ("go fuck yourself") DETERMINISTICALLY — even when the LLM judge would keep it', async () => {
    // The recurring bug: with a disclosure in context the judge intermittently returns serious:true
    // for plain abuse, so it went unstruck. The deterministic abuse floor strikes it WITHOUT calling
    // the judge at all — here the judge is even stubbed to keep it, proving the floor doesn't depend
    // on the judge.
    const { invokers, calls } = stubInvokers({
      extract: { intents: [] },
      sensitivity: { assessment: null },
      serious: { verdict: { serious: true, reason: '' } }, // judge would KEEP it
    });
    const result = await runTurn(
      state({
        userMessage: 'go fuck yourself',
        questions: Q,
        config: { abuseThreshold: 4 },
      }),
      invokers
    );
    // No disclosure detected; the deterministic floor struck it without consulting the judge.
    expect(result.sensitivity).toBeUndefined();
    expect(calls.serious).toHaveLength(0);
    expect(result.abuse?.flagged).toBe(true);
    expect(result.abuse?.newStrikeCount).toBe(1);
  });

  it('strikes plain abuse even when an over-eager LLM detector flagged it sensitive', async () => {
    // The other failure mode: the dedicated detector reads "oh just fuck off" (after a disclosure) as
    // distress and flags it, which would skip the gate. The deterministic abuse floor overrides that
    // LLM false-positive (suppressed only by the deterministic HARM floor, which is silent here).
    const { invokers } = stubInvokers({
      extract: { intents: [] },
      sensitivity: {
        assessment: { detected: true, severity: 'high', category: 'x', summary: 'y' },
      },
    });
    const result = await runTurn(
      state({
        userMessage: 'oh just fuck off',
        questions: Q,
        sensitivityLevel: 'high', // a prior disclosure already raised the level
        config: { abuseThreshold: 4, supportMessage: 'Support is available.' },
      }),
      invokers
    );
    expect(result.abuse?.flagged).toBe(true);
    // Struck → no sensitivity outcome / signpost this turn despite the detector's flag.
    expect(result.sensitivity).toBeUndefined();
  });

  it('does NOT strike abuse paired with a genuine harm disclosure (harm floor suppresses the abuse floor)', async () => {
    // "fuck off, my manager abuses me" — the deterministic HARM floor fires (first-person + "abuses"),
    // so the abuse floor is suppressed and the disclosure is protected.
    const { invokers, calls } = stubInvokers({
      extract: { intents: [] },
      sensitivity: { assessment: null },
    });
    const result = await runTurn(
      state({
        userMessage: 'fuck off, my manager abuses me',
        questions: Q,
        config: { abuseThreshold: 4, supportMessage: 'Support is available.' },
      }),
      invokers
    );
    expect(result.abuse).toBeUndefined();
    expect(calls.serious).toHaveLength(0); // protected: neither struck nor judged
    expect(result.sensitivity?.detected).toBe(true);
  });
});

describe('runDataSlotTurn — sensitivity awareness', () => {
  const withSlots = (over: Parameters<typeof state>[0]) =>
    state({
      ...over,
      // a single data slot so data-slot mode has something to target
      // (the orchestrator reads state.dataSlots)
    });

  it('returns a sensitivity outcome + signposts in data-slot mode', async () => {
    const { invokers } = stubInvokers({ extract: { sensitivity: HIGH } });
    const s = withSlots({ userMessage: 'x', questions: Q, config: { supportMessage: 'Help.' } });
    s.dataSlots = [
      {
        id: 'd1',
        key: 'ds',
        name: 'Wellbeing',
        description: 'how they feel',
        theme: 'WB',
        ordinal: 0,
        weight: 1,
      },
    ];
    const result = await runDataSlotTurn(s, invokers);
    expect(result.sensitivity?.newLevel).toBe('high');
    expect(supportEvent(result.events)?.message).toBe('Help.');
  });

  it('SAFEGUARDING OUTRANKS THE SINCERITY GATE in data-slot mode too', async () => {
    const { invokers, calls } = stubInvokers({
      extract: { sensitivity: HIGH },
      serious: { verdict: { serious: false, reason: 'Sounds implausible.' } },
    });
    const s = withSlots({
      userMessage: "i'm being abused by the ceo",
      questions: Q,
      config: { abuseThreshold: 4, supportMessage: 'Help.' },
    });
    s.dataSlots = [
      {
        id: 'd1',
        key: 'ds',
        name: 'Wellbeing',
        description: 'how they feel',
        theme: 'WB',
        ordinal: 0,
        weight: 1,
      },
    ];
    const result = await runDataSlotTurn(s, invokers);
    expect(calls.serious).toHaveLength(0);
    expect(result.abuse).toBeUndefined();
    expect(seriousnessEvent(result.events)).toBeUndefined();
    expect(result.sensitivity?.signpost).toBe(true);
    expect(supportEvent(result.events)?.message).toBe('Help.');
  });

  it('produces no sensitivity outcome and skips the detector when the feature is off', async () => {
    const { invokers, calls } = stubInvokers({ extract: { sensitivity: HIGH } });
    const s = withSlots({
      userMessage: 'x',
      questions: Q,
      config: { sensitivityAwareness: false },
    });
    s.dataSlots = [
      {
        id: 'd1',
        key: 'ds',
        name: 'Wellbeing',
        description: 'how they feel',
        theme: 'WB',
        ordinal: 0,
        weight: 1,
      },
    ];
    const result = await runDataSlotTurn(s, invokers);
    expect(result.sensitivity).toBeUndefined();
    expect(calls.sensitivity).toHaveLength(0);
    expect(result.toolCalls.some((t) => t.slug === 'app_detect_sensitivity')).toBe(false);
  });
});
