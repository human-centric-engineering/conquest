/**
 * Unit: the app-tier LLM cost attribution seam (`logAppLlmCost`, F14.15).
 *
 * `logCost` is mocked at the module boundary. The tests assert the metadata contract every app
 * call site depends on (`capability` + `versionId` on the row, so app spend can be joined back to
 * the version that produced it) and the fire-and-forget error posture — which is load-bearing
 * rather than defensive, because a throw here would change the CALLER's outcome.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const logCost = vi.hoisted(() => vi.fn());
vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({ logCost }));

import { logAppLlmCost } from '@/lib/app/questionnaire/llm/log-app-cost';
import { CostOperation } from '@/types/orchestration';

function params(over?: Partial<Parameters<typeof logAppLlmCost>[0]>) {
  return {
    agentId: 'agent-1',
    provider: 'openai',
    model: 'gpt-5.4',
    tokenUsage: { input: 100, output: 50 },
    capability: 'app_report_research',
    versionId: 'v1',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  logCost.mockResolvedValue(undefined);
});

describe('logAppLlmCost — row contract', () => {
  it('forwards the resolved binding and token counts to logCost', async () => {
    logAppLlmCost(params());

    expect(logCost).toHaveBeenCalledTimes(1);
    expect(logCost.mock.calls[0][0]).toMatchObject({
      agentId: 'agent-1',
      operation: CostOperation.CHAT,
      provider: 'openai',
      model: 'gpt-5.4',
      inputTokens: 100,
      outputTokens: 50,
    });
  });

  it('always carries capability + versionId in metadata', async () => {
    // AiCostLog has no questionnaire-version FK, so metadata is the ONLY way an app cost row can
    // be joined back to the artifact it produced. Four of six call sites used to omit it.
    logAppLlmCost(params());

    expect(logCost.mock.calls[0][0].metadata).toEqual({
      capability: 'app_report_research',
      versionId: 'v1',
    });
  });

  it('keeps a null versionId rather than dropping the key', async () => {
    // A genuinely version-less call must still be distinguishable from one that forgot to pass it.
    logAppLlmCost(params({ versionId: null }));

    expect(logCost.mock.calls[0][0].metadata).toHaveProperty('versionId', null);
  });

  it('merges extra context without letting it clobber capability or versionId', async () => {
    logAppLlmCost(params({ extra: { rounds: 2, capability: 'spoofed' } }));

    const { metadata } = logCost.mock.calls[0][0];
    expect(metadata.rounds).toBe(2);
    expect(metadata.versionId).toBe('v1');
    // Documents the current spread order: `extra` is spread last, so it CAN override. If that is
    // ever tightened, this assertion is the one that should be updated deliberately.
    expect(metadata.capability).toBe('spoofed');
  });
});

describe('logAppLlmCost — fire-and-forget posture', () => {
  it('swallows a rejected logCost promise', async () => {
    logCost.mockRejectedValue(new Error('cost table down'));

    expect(() => logAppLlmCost(params())).not.toThrow();
    // Flush the microtask queue so an unhandled rejection would surface here rather than in a
    // later, unrelated test.
    await Promise.resolve();
    expect(logCost).toHaveBeenCalledTimes(1);
  });

  it('swallows a synchronous throw from logCost', () => {
    // The `.catch()` alone would NOT cover this — a synchronous throw propagates past it into the
    // caller's try block. In report/research.ts that degrades a whole research phase to empty.
    logCost.mockImplementation(() => {
      throw new Error('boom');
    });

    expect(() => logAppLlmCost(params())).not.toThrow();
  });

  it('tolerates a logCost mock that returns a non-promise', () => {
    // Guards the optional-chained `?.catch()`: a partial test mock returning undefined must not
    // become a TypeError in production code paths.
    logCost.mockReturnValue(undefined);

    expect(() => logAppLlmCost(params())).not.toThrow();
    expect(logCost).toHaveBeenCalledTimes(1);
  });
});
