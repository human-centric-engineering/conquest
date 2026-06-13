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
    const med: SensitivityAssessment = { ...HIGH, severity: 'high' };
    const { invokers } = stubInvokers({ extract: { sensitivity: med } });
    const result = await runTurn(
      state({ userMessage: 'x', questions: Q, sensitivityLevel: 'medium' }),
      invokers
    );
    expect(result.sensitivity?.newLevel).toBe('high');
  });

  it('signposts support (once) only when a support message is configured', async () => {
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

  it('does NOT signpost when the support message is empty', async () => {
    const { invokers } = stubInvokers({ extract: { sensitivity: HIGH } });
    const result = await runTurn(
      state({ userMessage: 'x', questions: Q, config: { supportMessage: '' } }),
      invokers
    );
    expect(supportEvent(result.events)).toBeUndefined();
    expect(result.sensitivity?.signpost).toBe(true); // outcome still records it; just no copy to show
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

  it('drops the sensitivity outcome when the abuse gate disregards the turn', async () => {
    // A troll/abusive turn is not a genuine disclosure: the gate zeroes it, sensitivity is skipped.
    const { invokers } = stubInvokers({
      extract: { intents: [intent({ slotKey: 'a' })], sensitivity: HIGH },
      serious: { verdict: { serious: false, reason: 'Not genuine.' } },
    });
    const result = await runTurn(
      state({ userMessage: 'abuse', questions: Q, config: { abuseThreshold: 4 } }),
      invokers
    );
    expect(result.sensitivity).toBeUndefined();
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
});
