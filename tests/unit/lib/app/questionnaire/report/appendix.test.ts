/**
 * Report appendix synthesis — unit tests.
 *
 * Drives `synthesiseReportAppendix` with a mocked structured-completion runner: the short-circuit when
 * there are no findings, the happy path (an appendix is returned + cost summed), the legitimate
 * "no appendix" decision, graceful degradation on failure, and the prompt/parse wiring.
 *
 * @see lib/app/questionnaire/report/appendix.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { LlmMessage } from '@/lib/orchestration/llm/types';
import type { ReportResearchResult } from '@/lib/app/questionnaire/report/research';

const runStructuredCompletion = vi.fn();

vi.mock('@/lib/logging', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/orchestration/llm/structured-completion', () => ({
  runStructuredCompletion: (...a: unknown[]) => runStructuredCompletion(...a),
}));

import {
  synthesiseReportAppendix,
  hasResearchFindings,
} from '@/lib/app/questionnaire/report/appendix';
import { logger } from '@/lib/logging';

type Mock = ReturnType<typeof vi.fn>;

const FINDING = { title: 'Benchmark', url: 'https://bench.test', snippet: 'A stat' };
const BEFORE: ReportResearchResult = { findings: [FINDING], note: 'before note', costUsd: 0 };
const AFTER: ReportResearchResult = {
  findings: [{ title: 'New', url: 'https://new.test', snippet: 's' }],
  note: 'after note',
  costUsd: 0,
};

// A fake provider — appendix.ts passes it straight through to the (mocked) completion runner.
const provider = { chat: vi.fn() } as never;

function baseOpts(over: Partial<Parameters<typeof synthesiseReportAppendix>[0]> = {}) {
  return {
    provider,
    model: 'test-model',
    agentInstructions: 'You write reports.',
    temperature: 0.4,
    reportText: 'The finished report.',
    before: BEFORE,
    after: AFTER,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('hasResearchFindings', () => {
  it('is true when either phase has findings, false otherwise', () => {
    expect(hasResearchFindings(BEFORE, null)).toBe(true);
    expect(hasResearchFindings(null, AFTER)).toBe(true);
    expect(hasResearchFindings({ findings: [], costUsd: 0 }, null)).toBe(false);
    expect(hasResearchFindings(null, null)).toBe(false);
  });
});

describe('synthesiseReportAppendix', () => {
  it('short-circuits (no LLM call) when there are no findings', async () => {
    const result = await synthesiseReportAppendix(
      baseOpts({ before: { findings: [], costUsd: 0 }, after: null })
    );
    expect(runStructuredCompletion).not.toHaveBeenCalled();
    expect(result).toEqual({ appendix: null, costUsd: 0 });
  });

  it('returns the synthesized appendix and its cost on the happy path', async () => {
    runStructuredCompletion.mockResolvedValue({
      value: { appendix: { heading: 'Further context', body: 'Background.' } },
      costUsd: 0.02,
    });
    const result = await synthesiseReportAppendix(baseOpts());
    expect(result).toEqual({
      appendix: { heading: 'Further context', body: 'Background.' },
      costUsd: 0.02,
    });
  });

  it('returns a null appendix (but keeps the cost) when the writer declines', async () => {
    runStructuredCompletion.mockResolvedValue({ value: { appendix: null }, costUsd: 0.01 });
    const result = await synthesiseReportAppendix(baseOpts());
    expect(result).toEqual({ appendix: null, costUsd: 0.01 });
  });

  it('degrades to no appendix (never throws) when the completion fails', async () => {
    runStructuredCompletion.mockRejectedValue(new Error('provider down'));
    const result = await synthesiseReportAppendix(baseOpts());
    expect(result).toEqual({ appendix: null, costUsd: 0 });
    expect(logger.warn as Mock).toHaveBeenCalled();
  });

  it('builds a prompt with the persona, appendix directive, and fenced findings', async () => {
    runStructuredCompletion.mockResolvedValue({ value: { appendix: null }, costUsd: 0 });
    await synthesiseReportAppendix(baseOpts({ guidance: 'Look for benchmarks.' }));

    const opts = runStructuredCompletion.mock.calls[0][0] as { messages: LlmMessage[] };
    const system = opts.messages.find((m) => m.role === 'system')?.content as string;
    expect(system).toContain('You write reports.'); // persona
    expect(system).toContain('APPENDIX'); // directive
    expect(system).toContain('Look for benchmarks.'); // admin guidance
    expect(system).toContain('<<<EXTERNAL_WEB_RESEARCH>>>');
    expect(system).toContain('https://bench.test'); // before finding
    expect(system).toContain('https://new.test'); // after finding
    const user = opts.messages.find((m) => m.role === 'user')?.content as string;
    expect(user).toContain('The finished report.');
  });

  it('parses the model response: wrapper, bare object, "no appendix", and malformed', async () => {
    runStructuredCompletion.mockResolvedValue({ value: { appendix: null }, costUsd: 0 });
    await synthesiseReportAppendix(baseOpts());
    const parse = (runStructuredCompletion.mock.calls[0][0] as { parse: (raw: string) => unknown })
      .parse;

    expect(parse('{"appendix": {"heading": "H", "body": "B"}}')).toEqual({
      appendix: { heading: 'H', body: 'B' },
    });
    // A bare {heading, body} object is accepted too.
    expect(parse('{"body": "B"}')).toEqual({ appendix: { body: 'B' } });
    // An explicit null is a valid "no appendix" decision, not a parse failure.
    expect(parse('{"appendix": null}')).toEqual({ appendix: null });
    // An empty body normalizes to the null decision.
    expect(parse('{"appendix": {"body": "   "}}')).toEqual({ appendix: null });
    // Genuinely malformed → null (triggers the runner's retry).
    expect(parse('not json')).toBeNull();
  });
});
