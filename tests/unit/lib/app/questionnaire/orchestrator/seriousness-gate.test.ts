/**
 * Unit tests for the seriousness / abuse gate inside the pure per-turn orchestrator.
 *
 * Stub invokers (no capability, no DB): the extractor's `suspectedNonGenuine` flag gates the
 * judge; a non-serious verdict disregards the answer, strikes the session, escalates, and
 * abandons at the threshold. Covers the suspicion gate, the flag/threshold gates, the
 * disregard-and-re-ask path, and abandonment.
 */

import { describe, expect, it } from 'vitest';

import { ASSESS_SERIOUSNESS_TOOL_SLUG, runTurn } from '@/lib/app/questionnaire/orchestrator';
import { abuseAbortMessage } from '@/lib/app/questionnaire/seriousness';
import {
  intent,
  state,
  stubInvokers,
  q,
} from '@/tests/unit/lib/app/questionnaire/orchestrator/_fixtures';

const Q = [q({ id: 'a', prompt: 'How long have you worked here?' })];

describe('runTurn — seriousness / abuse gate', () => {
  it('judges a suspicious answer; a non-serious verdict is disregarded, strikes, warns, and re-asks', async () => {
    const { invokers, calls } = stubInvokers({
      extract: {
        intents: [intent({ slotKey: 'a', value: '543 years' })],
        suspectedNonGenuine: true,
      },
      serious: { verdict: { serious: false, reason: 'That tenure is not possible.' } },
    });

    const result = await runTurn(
      state({
        userMessage: '543 years',
        questions: Q,
        config: { abuseThreshold: 4 },
        abuseStrikes: 0,
      }),
      invokers
    );

    expect(calls.serious).toHaveLength(1);
    // Disregarded — the bogus answer is never handed to persistence.
    expect(result.sideEffects.answerUpserts).toHaveLength(0);
    expect(result.abuse).toEqual({
      flagged: true,
      newStrikeCount: 1,
      abandon: false,
      reason: 'That tenure is not possible.',
    });
    expect(result.events.some((e) => e.type === 'warning' && e.code === 'seriousness')).toBe(true);
    expect(result.toolCalls.map((t) => t.slug)).toContain(ASSESS_SERIOUSNESS_TOOL_SLUG);
    // The slot is still unanswered, so selection re-asks a question (not an offer/terminal).
    expect(result.response.kind).toBe('question');
  });

  it('emits the distinct `seriousness_final` code on the last warning before abandonment', async () => {
    const { invokers } = stubInvokers({
      extract: { intents: [intent({ slotKey: 'a' })], suspectedNonGenuine: true },
      serious: { verdict: { serious: false, reason: 'still not genuine' } },
    });

    const result = await runTurn(
      state({
        userMessage: 'garbage',
        questions: Q,
        config: { abuseThreshold: 4 },
        abuseStrikes: 2, // the next strike is the 3rd → one left → final warning
      }),
      invokers
    );

    expect(result.abuse).toMatchObject({ newStrikeCount: 3, abandon: false });
    // The final warning gets the firmer (red) code; earlier strikes stay `seriousness`.
    expect(result.events.some((e) => e.type === 'warning' && e.code === 'seriousness_final')).toBe(
      true
    );
    expect(result.events.some((e) => e.type === 'warning' && e.code === 'seriousness')).toBe(false);
    expect(result.response.kind).toBe('question');
  });

  it('abandons the session on the threshold strike', async () => {
    const { invokers } = stubInvokers({
      extract: { intents: [intent({ slotKey: 'a' })], suspectedNonGenuine: true },
      serious: { verdict: { serious: false, reason: 'nope' } },
    });

    const result = await runTurn(
      state({
        userMessage: 'garbage',
        questions: Q,
        config: { abuseThreshold: 4 },
        abuseStrikes: 3, // the next strike is the 4th → abandon
      }),
      invokers
    );

    expect(result.abuse).toEqual({
      flagged: true,
      newStrikeCount: 4,
      abandon: true,
      reason: 'nope',
    });
    expect(result.sideEffects.answerUpserts).toHaveLength(0);
    expect(result.response).toEqual({ kind: 'complete', text: abuseAbortMessage(4) });
  });

  it('keeps a serious answer (judge ran, no strike, answer persisted)', async () => {
    const { invokers, calls } = stubInvokers({
      extract: {
        intents: [intent({ slotKey: 'a', value: 'about 2 years' })],
        suspectedNonGenuine: true,
      },
      serious: { verdict: { serious: true, reason: '' } },
    });

    const result = await runTurn(
      state({ userMessage: 'about 2 years', questions: Q, abuseStrikes: 0 }),
      invokers
    );

    expect(calls.serious).toHaveLength(1);
    expect(result.abuse).toBeUndefined();
    expect(result.sideEffects.answerUpserts).toHaveLength(1);
  });

  it('runs the judge on every answered turn (no suspicion pre-gate); a genuine answer passes', async () => {
    const { invokers, calls } = stubInvokers({
      extract: { intents: [intent({ slotKey: 'a' })] }, // no suspicion flag — judge still runs
      // stub judge defaults to a serious verdict
    });

    const result = await runTurn(state({ userMessage: 'fine', questions: Q }), invokers);

    expect(calls.serious).toHaveLength(1); // judged regardless of the (absent) suspicion flag
    expect(result.abuse).toBeUndefined();
    expect(result.sideEffects.answerUpserts).toHaveLength(1);
  });

  it('does not run the judge when the gate flag is off', async () => {
    const { invokers, calls } = stubInvokers({
      extract: { intents: [intent({ slotKey: 'a' })], suspectedNonGenuine: true },
      serious: { verdict: { serious: false, reason: 'x' } },
    });

    const result = await runTurn(
      state({ userMessage: 'x', questions: Q, flags: { seriousnessGate: false } }),
      invokers
    );

    expect(calls.serious).toHaveLength(0);
    expect(result.abuse).toBeUndefined();
    expect(result.sideEffects.answerUpserts).toHaveLength(1);
  });

  it('does not run the judge when abuseThreshold is 0 (off for this questionnaire)', async () => {
    const { invokers, calls } = stubInvokers({
      extract: { intents: [intent({ slotKey: 'a' })], suspectedNonGenuine: true },
      serious: { verdict: { serious: false, reason: 'x' } },
    });

    const result = await runTurn(
      state({ userMessage: 'x', questions: Q, config: { abuseThreshold: 0 } }),
      invokers
    );

    expect(calls.serious).toHaveLength(0);
    expect(result.abuse).toBeUndefined();
  });
});
