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

  it('throws when the model output cannot be parsed (no answers or fills)', async () => {
    // The real parse rejects an empty sample; the mocked completion surfaces the caller's error.
    (runStructuredCompletion as Mock).mockImplementation(
      async (opts: { parse: (raw: string) => unknown; onFinalFailure?: () => Error }) => {
        const value = opts.parse(JSON.stringify({ answers: [], dataSlots: [] }));
        if (value === null) throw opts.onFinalFailure?.() ?? new Error('parse failed');
        return { value, tokenUsage: { input: 1, output: 1 }, costUsd: 0 };
      }
    );
    await expect(
      synthesiseSampleReportInputs(structure, { includeConfidence: true })
    ).rejects.toThrow(/valid JSON/i);
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
