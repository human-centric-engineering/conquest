/**
 * Unit tests for sensitivity awareness / safeguarding inside the pure per-turn orchestrator
 * (both `runTurn` and `runDataSlotTurn`).
 *
 * Stub invokers (no capability, no DB): the extractor's `sensitivity` assessment becomes a
 * `TurnResult.sensitivity` outcome with a running-max level; the support frame fires once on the
 * first high disclosure and only when a support message is configured; nothing happens when the
 * flag is off or when the abuse gate disregarded the turn.
 */

import { describe, expect, it } from 'vitest';

import { runTurn, runDataSlotTurn } from '@/lib/app/questionnaire/orchestrator';
import type { SensitivityAssessment } from '@/lib/app/questionnaire/sensitivity/types';
import { DEFAULT_SUPPORT_MESSAGE } from '@/lib/app/questionnaire/sensitivity';
import {
  intent,
  state,
  stubInvokers,
  q,
} from '@/tests/unit/lib/app/questionnaire/orchestrator/_fixtures';

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

  it('produces no sensitivity outcome when the feature flag is off', async () => {
    const { invokers } = stubInvokers({ extract: { sensitivity: HIGH } });
    const result = await runTurn(
      state({ userMessage: 'x', questions: Q, flags: { sensitivityAwareness: false } }),
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
});
