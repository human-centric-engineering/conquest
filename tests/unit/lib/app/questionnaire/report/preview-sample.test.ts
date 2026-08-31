/**
 * Report preview sample synthesis — pure unit tests.
 *
 * Mocks the LLM seams (agent lookup, provider resolution, structured completion) and asserts the
 * synthesised sample is mapped through the SAME content builders production uses, so a preview's
 * transcript + data-slot block match a live report's shape.
 *
 * @see lib/app/questionnaire/report/preview-sample.ts
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';

import {
  synthesiseSampleReportInputs,
  type PreviewStructure,
} from '@/lib/app/questionnaire/report/preview-sample';
import { prisma } from '@/lib/db/client';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { getProviderWithFallbacks } from '@/lib/orchestration/llm/provider-manager';
import { runStructuredCompletion } from '@/lib/orchestration/llm/structured-completion';

vi.mock('@/lib/db/client', () => ({ prisma: { aiAgent: { findUnique: vi.fn() } } }));
vi.mock('@/lib/orchestration/llm/agent-resolver', () => ({
  resolveAgentProviderAndModel: vi.fn(),
}));
vi.mock('@/lib/orchestration/llm/provider-manager', () => ({
  getProviderWithFallbacks: vi.fn(),
}));
vi.mock('@/lib/orchestration/llm/structured-completion', () => ({
  runStructuredCompletion: vi.fn(),
}));

const structure: PreviewStructure = {
  questionnaireTitle: 'Pulse',
  goal: 'Understand engagement',
  audience: { description: 'Employees', role: 'Manager' },
  sections: [
    {
      sectionId: 's1',
      title: 'Wellbeing',
      questions: [{ key: 'q1', prompt: 'Mood?', required: true }],
    },
  ],
  dataSlots: [
    { key: 'ds1', name: 'Driver', description: 'What motivates them', theme: 'Motivation' },
  ],
};

const SAMPLE = {
  answers: [
    { key: 'q1', value: 'Feeling positive lately', confidence: 0.66, rationale: 'Recent wins' },
  ],
  dataSlots: [
    { key: 'ds1', value: 'Career growth', confidence: 0.8, rationale: 'Mentioned a promotion' },
  ],
};

/** Make the mocked completion run the real `parse` on our sample JSON, as the provider path would. */
function mockCompletion(sample: object, costUsd = 0.02) {
  (runStructuredCompletion as Mock).mockImplementation(
    async (opts: { parse: (raw: string) => unknown }) => ({
      value: opts.parse(JSON.stringify(sample)),
      tokenUsage: { input: 1, output: 1 },
      costUsd,
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.aiAgent.findUnique as Mock).mockResolvedValue({
    provider: 'openai',
    model: 'test-model',
    fallbackProviders: [],
    temperature: 0.7,
  });
  (resolveAgentProviderAndModel as Mock).mockResolvedValue({
    providerSlug: 'openai',
    model: 'test-model',
    fallbacks: [],
  });
  (getProviderWithFallbacks as Mock).mockResolvedValue({ provider: { chat: vi.fn() } });
});

describe('synthesiseSampleReportInputs', () => {
  it('maps the sample through the transcript + data-slot builders, annotating confidence', async () => {
    mockCompletion(SAMPLE);

    const result = await synthesiseSampleReportInputs(structure, { includeConfidence: true });

    // The Q&A transcript carries the sample answer with its confidence.
    expect(result.transcript).toContain('Q: Mood?');
    expect(result.transcript).toContain('A: Feeling positive lately (confidence 0.66)');
    // The data-slot context block carries the themed fill with rationale + confidence.
    expect(result.dataSlotContext).toContain('## Motivation');
    expect(result.dataSlotContext).toContain('Driver: Career growth (confidence 0.80)');
    expect(result.dataSlotContext).toContain('Why: Mentioned a promotion');
    // Cost flows through.
    expect(result.costUsd).toBe(0.02);
  });

  it('omits confidence annotations when includeConfidence is off', async () => {
    mockCompletion(SAMPLE);

    const result = await synthesiseSampleReportInputs(structure, { includeConfidence: false });

    expect(result.transcript).toContain('A: Feeling positive lately');
    expect(result.transcript).not.toContain('confidence');
    expect(result.dataSlotContext).toContain('Driver: Career growth');
    expect(result.dataSlotContext).not.toContain('confidence');
  });

  it('throws when the report agent is not seeded', async () => {
    (prisma.aiAgent.findUnique as Mock).mockResolvedValue(null);
    await expect(
      synthesiseSampleReportInputs(structure, { includeConfidence: true })
    ).rejects.toThrow(/not seeded/i);
  });

  it('throws when every batch fails, leaving no usable sample', async () => {
    // The real parse rejects an empty sample; the mocked completion surfaces the caller's error.
    // Individual batch failures are tolerated, so this only throws once nothing at all survived.
    (runStructuredCompletion as Mock).mockImplementation(
      async (opts: { parse: (raw: string) => unknown; onFinalFailure?: () => Error }) => {
        const value = opts.parse(JSON.stringify({ answers: [], dataSlots: [] }));
        if (value === null) throw opts.onFinalFailure?.() ?? new Error('parse failed');
        return { value, tokenUsage: { input: 1, output: 1 }, costUsd: 0 };
      }
    );
    await expect(
      synthesiseSampleReportInputs(structure, { includeConfidence: true })
    ).rejects.toThrow(/no usable answers/i);
  });

  it('defaults confidence to 0.8 and omits the rationale line when the model leaves them out', async () => {
    mockCompletion({
      answers: [{ key: 'q1', value: 'Positive' }],
      dataSlots: [{ key: 'ds1', value: 'Career growth' }],
    });

    const result = await synthesiseSampleReportInputs(structure, { includeConfidence: true });

    expect(result.transcript).toContain('A: Positive (confidence 0.80)');
    expect(result.dataSlotContext).toContain('Driver: Career growth (confidence 0.80)');
    // No rationale supplied → no "Why:" line.
    expect(result.dataSlotContext).not.toContain('Why:');
  });

  it('drops malformed entries (missing key or value, or not an object)', async () => {
    mockCompletion({
      answers: [
        { key: 'q1', value: 'Positive' },
        { value: 'no key' },
        { key: 'q1' }, // no value
        'not an object',
      ],
      dataSlots: [{ key: 'ds1' }], // no value → dropped → empty block
    });

    const result = await synthesiseSampleReportInputs(structure, { includeConfidence: false });

    expect(result.transcript).toContain('A: Positive');
    expect(result.transcript).not.toContain('no key');
    expect(result.dataSlotContext).toBe('');
  });

  it('accepts keys the model echoed back wrapped in the prompt brackets', async () => {
    // The prompt lists items as `- [q1] Mood?`, and models routinely copy the brackets into the
    // response. Before normalisation these matched no question and were silently dropped, so a
    // preview lost most of its answers and rendered them as unanswered.
    mockCompletion({
      answers: [{ key: '[q1]', value: 'Positive', confidence: 0.5, rationale: 'x' }],
      dataSlots: [{ key: '[ds1]', value: 'Career growth', confidence: 0.5, rationale: 'y' }],
    });

    const result = await synthesiseSampleReportInputs(structure, { includeConfidence: false });

    expect(result.transcript).toContain('A: Positive');
    expect(result.dataSlotContext).toContain('Driver: Career growth');
    expect(result.coverage).toEqual({ answered: 1, total: 1, unansweredBlock: '' });
  });

  describe('batching', () => {
    /** A structure with `count` questions in one section — enough to force a fan-out. */
    function wideStructure(count: number): PreviewStructure {
      return {
        questionnaireTitle: 'Wide',
        goal: null,
        audience: null,
        sections: [
          {
            sectionId: 's1',
            title: 'Section',
            questions: Array.from({ length: count }, (_, i) => ({
              key: `q${i}`,
              prompt: `Prompt ${i}?`,
              required: false,
            })),
          },
        ],
        dataSlots: [],
      };
    }

    /**
     * Answer exactly the items the batch was asked about, by reading the keys back out of the
     * prompt. This is what makes the test prove the fan-out covers every question rather than
     * just that some call happened.
     */
    function mockPerBatchCompletion(opts: { failBatchesMatching?: RegExp } = {}) {
      (runStructuredCompletion as Mock).mockImplementation(
        async (callOpts: {
          messages: { role: string; content: string }[];
          parse: (raw: string) => unknown;
          onFinalFailure?: () => Error;
        }) => {
          const userMessage = callOpts.messages.find((m) => m.role === 'user')?.content ?? '';
          if (opts.failBatchesMatching?.test(userMessage)) throw new Error('batch blew up');
          const keys = [...userMessage.matchAll(/^- \[([^\]]+)\]/gm)].map((m) => m[1]);
          const value = callOpts.parse(
            JSON.stringify({
              answers: keys.map((key) => ({ key, value: `Answer for ${key}` })),
              dataSlots: [],
            })
          );
          if (value === null) throw callOpts.onFinalFailure?.() ?? new Error('parse failed');
          return { value, tokenUsage: { input: 1, output: 1 }, costUsd: 0.01 };
        }
      );
    }

    it('splits a large questionnaire across several calls and answers every question', async () => {
      mockPerBatchCompletion();

      const result = await synthesiseSampleReportInputs(wideStructure(71), {
        includeConfidence: false,
      });

      // Fanned out rather than asking one call for all 71 — the single call truncated and timed out.
      expect((runStructuredCompletion as Mock).mock.calls.length).toBeGreaterThan(1);
      // Every question is answered: no item is lost between batching and the merge.
      expect(result.coverage.answered).toBe(71);
      expect(result.coverage.total).toBe(71);
      expect(result.coverage.unansweredBlock).toBe('');
      expect(result.transcript).toContain('A: Answer for q0');
      expect(result.transcript).toContain('A: Answer for q70');
    });

    it('gives each batch a disjoint slice, so no question is asked for twice', async () => {
      mockPerBatchCompletion();

      await synthesiseSampleReportInputs(wideStructure(71), { includeConfidence: false });

      const asked = (runStructuredCompletion as Mock).mock.calls.flatMap((call) => {
        const opts = call[0] as { messages: { role: string; content: string }[] };
        const user = opts.messages.find((m) => m.role === 'user')?.content ?? '';
        return [...user.matchAll(/^- \[([^\]]+)\]/gm)].map((m) => m[1]);
      });

      expect(asked).toHaveLength(71);
      expect(new Set(asked).size).toBe(71);
    });

    it('degrades to a partial sample when one batch fails rather than failing the preview', async () => {
      // Only the batch containing q0 fails; the rest still produce a usable preview.
      mockPerBatchCompletion({ failBatchesMatching: /^- \[q0\]/m });

      const result = await synthesiseSampleReportInputs(wideStructure(71), {
        includeConfidence: false,
      });

      expect(result.coverage.total).toBe(71);
      expect(result.coverage.answered).toBeGreaterThan(0);
      expect(result.coverage.answered).toBeLessThan(71);
      // The questions the failed batch owned are reported as gaps, not passed off as answered.
      expect(result.coverage.unansweredBlock).toContain('Prompt 0?');
      expect(result.transcript).not.toContain('Answer for q0');
    });

    it('fixes one persona up front and gives it to every batch', async () => {
      // Batches are independent calls, so without a shared persona each invents its own respondent
      // and the preview reads as several different people.
      const chat = vi.fn().mockResolvedValue({
        content: 'Dana Reyes, ops lead at a 40-person logistics firm.',
        usage: { inputTokens: 10, outputTokens: 20 },
      });
      (getProviderWithFallbacks as Mock).mockResolvedValue({ provider: { chat } });
      mockPerBatchCompletion();

      await synthesiseSampleReportInputs(wideStructure(71), { includeConfidence: false });

      // Exactly one persona call, regardless of how many batches followed.
      expect(chat).toHaveBeenCalledTimes(1);
      const batchCalls = (runStructuredCompletion as Mock).mock.calls;
      expect(batchCalls.length).toBeGreaterThan(1);
      for (const call of batchCalls) {
        const opts = call[0] as { messages: { role: string; content: string }[] };
        const system = opts.messages.find((m) => m.role === 'system')?.content ?? '';
        expect(system).toContain('Dana Reyes, ops lead at a 40-person logistics firm.');
      }
    });

    it('still produces a sample when the persona pass fails', async () => {
      const chat = vi.fn().mockRejectedValue(new Error('persona provider down'));
      (getProviderWithFallbacks as Mock).mockResolvedValue({ provider: { chat } });
      mockPerBatchCompletion();

      const result = await synthesiseSampleReportInputs(wideStructure(71), {
        includeConfidence: false,
      });

      expect(result.coverage.answered).toBe(71);
    });

    it('reports batch progress on completion, ending at total-of-total', async () => {
      mockPerBatchCompletion();
      const events: Array<{ type: string; batchesDone?: number; batchesTotal?: number }> = [];

      await synthesiseSampleReportInputs(wideStructure(71), {
        includeConfidence: false,
        onProgress: (event) => events.push(event),
      });

      const sampling = events.filter((e) => e.type === 'sampling');
      const total = sampling[0]?.batchesTotal ?? 0;
      expect(total).toBeGreaterThan(1);
      // Opens at 0 and closes at total — a counter that stopped short reads as a stalled preview.
      expect(sampling[0]?.batchesDone).toBe(0);
      expect(sampling[sampling.length - 1]).toEqual({
        type: 'sampling',
        batchesDone: total,
        batchesTotal: total,
      });
      // Announced only once the persona is fixed, since that is the pass actually running first.
      expect(events[0]).toEqual({ type: 'persona' });
    });

    it('still advances the counter past a failed batch, so the wait never strands', async () => {
      mockPerBatchCompletion({ failBatchesMatching: /q0\]/ });
      const events: Array<{ type: string; batchesDone?: number; batchesTotal?: number }> = [];

      await synthesiseSampleReportInputs(wideStructure(71), {
        includeConfidence: false,
        onProgress: (event) => events.push(event),
      });

      const sampling = events.filter((e) => e.type === 'sampling');
      const last = sampling[sampling.length - 1];
      expect(last?.batchesDone).toBe(last?.batchesTotal);
    });

    it('sums cost across the persona pass and every batch', async () => {
      mockPerBatchCompletion();

      const result = await synthesiseSampleReportInputs(wideStructure(71), {
        includeConfidence: false,
      });

      const batchCalls = (runStructuredCompletion as Mock).mock.calls.length;
      expect(result.costUsd).toBeCloseTo(0.01 * batchCalls, 6);
    });
  });

  it('handles a minimal structure with no goal, audience, or data slots', async () => {
    const minimal = {
      questionnaireTitle: 'Pulse',
      goal: null,
      audience: null,
      sections: [
        {
          sectionId: 's1',
          title: 'Wellbeing',
          questions: [{ key: 'q1', prompt: 'Mood?', required: true }],
        },
      ],
      dataSlots: [],
    };
    mockCompletion({
      answers: [{ key: 'q1', value: 'Fine', confidence: 0.5, rationale: 'x' }],
      dataSlots: [],
    });

    const result = await synthesiseSampleReportInputs(minimal, { includeConfidence: true });

    expect(result.transcript).toContain('A: Fine');
    expect(result.dataSlotContext).toBe('');
  });
});
