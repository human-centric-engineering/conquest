/**
 * Streaming map-reduce data-slot generator — unit tests.
 *
 * The LLM chain (resolveAgentProviderAndModel → getProvider → runStructuredCompletion) and
 * cost logging are mocked at the module boundary. The runStructuredCompletion mock branches on
 * the system prompt: a "RECONCILING" prompt is the merge call, anything else is a per-section
 * group call returning one slot per question key in that group. Tests verify the event sequence,
 * grouping/chunking, the merge step (and its single-group skip), and every failure path.
 *
 * @see lib/app/questionnaire/data-slots/generate-stream.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/orchestration/llm/agent-resolver', () => ({
  resolveAgentProviderAndModel: vi.fn(),
}));
vi.mock('@/lib/orchestration/llm/provider-manager', () => ({
  getProvider: vi.fn(),
}));
vi.mock('@/lib/orchestration/evaluations/parse-structured', () => ({
  tryParseJson: vi.fn(),
}));
vi.mock('@/lib/orchestration/llm/structured-completion', () => ({
  runStructuredCompletion: vi.fn(),
}));
vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({
  logCost: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { resolveAgentProviderAndModel } = await import('@/lib/orchestration/llm/agent-resolver');
const { getProvider } = await import('@/lib/orchestration/llm/provider-manager');
const { runStructuredCompletion } = await import('@/lib/orchestration/llm/structured-completion');
const { streamDataSlotGeneration, groupQuestionsForGeneration, dedupeSlots } =
  await import('@/lib/app/questionnaire/data-slots/generate-stream');
import type { DataSlotGenEvent } from '@/lib/app/questionnaire/data-slots';

type Mock = ReturnType<typeof vi.fn>;

// Typed mock preserves runStructuredCompletion's Promise-returning signature so an async
// mockImplementation doesn't trip no-misused-promises.
const mockRSC = vi.mocked(runStructuredCompletion);

const AGENT = { provider: 'openai', model: 'gpt-4o', fallbackProviders: [] };

/** Two sections (A: q1,q2 / B: q3) → two groups → triggers a merge. */
const MULTI_SECTION = {
  goal: 'Understand experience',
  questions: [
    { key: 'q1', prompt: 'p1', type: 'scale', sectionTitle: 'Setup' },
    { key: 'q2', prompt: 'p2', type: 'text', sectionTitle: 'Setup' },
    { key: 'q3', prompt: 'p3', type: 'nps', sectionTitle: 'Feedback' },
  ],
};

const SINGLE_SECTION = {
  goal: 'g',
  questions: [
    { key: 'q1', prompt: 'p1', type: 'scale', sectionTitle: 'Only' },
    { key: 'q2', prompt: 'p2', type: 'text', sectionTitle: 'Only' },
  ],
};

function keysIn(text: string): string[] {
  return [...text.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]);
}

/** Default mock: group calls yield one slot per question key; merge consolidates to one slot. */
function wireDefaultCompletion() {
  mockRSC.mockImplementation(async (opts) => {
    const sys = opts.messages[0].content as string;
    const user = opts.messages[1].content as string;
    const keys = keysIn(user);
    if (sys.includes('RECONCILING')) {
      return {
        value: {
          slots: [
            { name: 'Merged', description: 'd', theme: 't', questionKeys: keys, confidence: 0.9 },
          ],
        },
        tokenUsage: { input: 10, output: 20 },
        costUsd: 0.001,
      };
    }
    return {
      value: {
        slots: keys.map((k) => ({
          name: `Slot ${k}`,
          description: 'd',
          theme: 't',
          questionKeys: [k],
          confidence: 0.8,
        })),
      },
      tokenUsage: { input: 5, output: 10 },
      costUsd: 0.0005,
    };
  });
}

async function drain(gen: AsyncGenerator<DataSlotGenEvent, unknown>) {
  const events: DataSlotGenEvent[] = [];
  let res = await gen.next();
  while (!res.done) {
    events.push(res.value);
    res = await gen.next();
  }
  return { events, value: res.value };
}

beforeEach(() => {
  vi.clearAllMocks();
  (resolveAgentProviderAndModel as Mock).mockResolvedValue({
    providerSlug: 'openai',
    model: 'gpt-4o',
  });
  (getProvider as Mock).mockResolvedValue({ name: 'openai' });
  wireDefaultCompletion();
});

describe('groupQuestionsForGeneration', () => {
  it('groups questions by section, preserving first-seen order', () => {
    const groups = groupQuestionsForGeneration(MULTI_SECTION.questions);
    expect(groups.map((g) => g.title)).toEqual(['Setup', 'Feedback']);
    expect(groups[0].questions.map((q) => q.key)).toEqual(['q1', 'q2']);
    expect(groups[1].questions.map((q) => q.key)).toEqual(['q3']);
  });

  it('buckets questions with no section under "General"', () => {
    const groups = groupQuestionsForGeneration([{ key: 'q1', prompt: 'p', type: 'text' }]);
    expect(groups[0].title).toBe('General');
  });

  it('splits an oversized section into labelled parts', () => {
    const big = Array.from({ length: 27 }, (_, i) => ({
      key: `q${i}`,
      prompt: 'p',
      type: 'text',
      sectionTitle: 'Big',
    }));
    const groups = groupQuestionsForGeneration(big, 12);
    expect(groups).toHaveLength(3); // 12 + 12 + 3
    expect(groups.map((g) => g.title)).toEqual([
      'Big (part 1/3)',
      'Big (part 2/3)',
      'Big (part 3/3)',
    ]);
    expect(groups[2].questions).toHaveLength(3);
  });
});

describe('dedupeSlots', () => {
  it('merges by case-insensitive name and unions question keys', () => {
    const merged = dedupeSlots([
      { name: 'Onboarding', description: 'a', theme: 't', questionKeys: ['q1'], confidence: 0.8 },
      { name: 'onboarding', description: 'b', theme: 't', questionKeys: ['q2'], confidence: 0.7 },
      { name: 'Other', description: 'c', theme: 't', questionKeys: ['q3'], confidence: 0.9 },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0].questionKeys.sort()).toEqual(['q1', 'q2']);
  });
});

describe('streamDataSlotGeneration — happy path (multi-section)', () => {
  it('emits start → group_done×2 → merge_start, and returns the merged set', async () => {
    const { events, value } = await drain(
      streamDataSlotGeneration({ structure: MULTI_SECTION, agent: AGENT })
    );
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('start');
    expect(types.filter((t) => t === 'group_done')).toHaveLength(2);
    expect(types).toContain('merge_start');
    // Final value is the merge output covering every question key.
    expect(value).toEqual([
      expect.objectContaining({
        name: 'Merged',
        questionKeys: expect.arrayContaining(['q1', 'q2', 'q3']),
      }),
    ]);
  });

  it('advertises both sections with their question counts in the start event', async () => {
    const { events } = await drain(
      streamDataSlotGeneration({ structure: MULTI_SECTION, agent: AGENT })
    );
    const start = events.find((e) => e.type === 'start');
    expect(start).toMatchObject({
      totalQuestions: 3,
      groups: [
        { title: 'Setup', questionCount: 2 },
        { title: 'Feedback', questionCount: 1 },
      ],
    });
  });

  it('runs the merge call once (groups > 1)', async () => {
    await drain(streamDataSlotGeneration({ structure: MULTI_SECTION, agent: AGENT }));
    const calls = mockRSC.mock.calls;
    const mergeCalls = calls.filter((c) =>
      (c[0].messages[0].content as string).includes('RECONCILING')
    );
    expect(mergeCalls).toHaveLength(1);
  });
});

describe('streamDataSlotGeneration — single section', () => {
  it('skips the merge step and returns the group slots directly', async () => {
    const { events, value } = await drain(
      streamDataSlotGeneration({ structure: SINGLE_SECTION, agent: AGENT })
    );
    expect(events.map((e) => e.type)).not.toContain('merge_start');
    expect(value).toEqual([
      expect.objectContaining({ name: 'Slot q1' }),
      expect.objectContaining({ name: 'Slot q2' }),
    ]);
    const calls = mockRSC.mock.calls;
    expect(calls.every((c) => !(c[0].messages[0].content as string).includes('RECONCILING'))).toBe(
      true
    );
  });
});

describe('streamDataSlotGeneration — failures', () => {
  it('emits group_error but still merges the surviving section', async () => {
    mockRSC.mockImplementation(async (opts) => {
      const sys = opts.messages[0].content as string;
      const user = opts.messages[1].content as string;
      if (sys.includes('RECONCILING')) {
        return {
          value: {
            slots: [
              {
                name: 'Merged',
                description: 'd',
                theme: 't',
                questionKeys: ['q3'],
                confidence: 0.9,
              },
            ],
          },
          tokenUsage: { input: 1, output: 1 },
          costUsd: 0,
        };
      }
      // Fail the "Setup" group (contains q1), succeed for "Feedback" (q3).
      if (keysIn(user).includes('q1')) throw new Error('socket hang up');
      return {
        value: {
          slots: [
            {
              name: 'Slot q3',
              description: 'd',
              theme: 't',
              questionKeys: ['q3'],
              confidence: 0.8,
            },
          ],
        },
        tokenUsage: { input: 1, output: 1 },
        costUsd: 0,
      };
    });

    const { events, value } = await drain(
      streamDataSlotGeneration({ structure: MULTI_SECTION, agent: AGENT })
    );
    expect(events.some((e) => e.type === 'group_error')).toBe(true);
    expect(events.some((e) => e.type === 'merge_start')).toBe(true);
    expect((value as unknown[]).length).toBeGreaterThan(0);
  });

  it('emits a fatal error when every section fails', async () => {
    mockRSC.mockRejectedValue(new Error('boom'));
    const { events, value } = await drain(
      streamDataSlotGeneration({ structure: MULTI_SECTION, agent: AGENT })
    );
    const err = events.find((e) => e.type === 'error');
    expect(err).toMatchObject({ type: 'error', code: 'generation_failed' });
    expect(value).toEqual([]);
  });

  it('falls back to a deduped union with a merge_warning when the merge call fails', async () => {
    mockRSC.mockImplementation(async (opts) => {
      const sys = opts.messages[0].content as string;
      if (sys.includes('RECONCILING')) throw new Error('merge boom');
      const keys = keysIn(opts.messages[1].content as string);
      return {
        value: {
          slots: keys.map((k) => ({
            name: `Slot ${k}`,
            description: 'd',
            theme: 't',
            questionKeys: [k],
            confidence: 0.8,
          })),
        },
        tokenUsage: { input: 1, output: 1 },
        costUsd: 0,
      };
    });

    const { events, value } = await drain(
      streamDataSlotGeneration({ structure: MULTI_SECTION, agent: AGENT })
    );
    expect(events.some((e) => e.type === 'merge_warning')).toBe(true);
    // Fallback union keeps all three section slots.
    expect((value as unknown[]).length).toBe(3);
  });

  it('emits no_provider_configured when provider resolution fails', async () => {
    (resolveAgentProviderAndModel as Mock).mockRejectedValue(new Error('no provider'));
    const { events, value } = await drain(
      streamDataSlotGeneration({ structure: MULTI_SECTION, agent: AGENT })
    );
    expect(events).toEqual([
      expect.objectContaining({ type: 'error', code: 'no_provider_configured' }),
    ]);
    expect(value).toEqual([]);
    expect(runStructuredCompletion).not.toHaveBeenCalled();
  });

  it('emits provider_unavailable when getProvider fails', async () => {
    (getProvider as Mock).mockRejectedValue(new Error('offline'));
    const { events, value } = await drain(
      streamDataSlotGeneration({ structure: MULTI_SECTION, agent: AGENT })
    );
    expect(events).toEqual([
      expect.objectContaining({ type: 'error', code: 'provider_unavailable' }),
    ]);
    expect(value).toEqual([]);
  });
});
