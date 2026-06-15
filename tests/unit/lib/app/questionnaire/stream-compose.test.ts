/**
 * Unit test for the streaming two-phase questionnaire composer
 * (`stream-compose.ts`).
 *
 * Drives the async generator with a mocked provider that branches on the prompt
 * (outline vs per-section) and the real `runStructuredCompletion`. Asserts the
 * event lifecycle (`outline` → `section_done`*), cross-section key de-duplication,
 * a non-fatal section failure (`section_error`), and the fatal paths (outline
 * failure, no provider) — each surfacing an `error` event + an empty structure.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({
  logCost: vi.fn().mockResolvedValue(null),
  calculateCost: vi.fn(() => ({ totalCostUsd: 0.001, isLocal: false })),
}));
vi.mock('@/lib/orchestration/llm/provider-manager', () => ({ getProvider: vi.fn() }));
vi.mock('@/lib/orchestration/llm/agent-resolver', () => ({
  resolveAgentProviderAndModel: vi.fn(),
}));

const { getProvider } = await import('@/lib/orchestration/llm/provider-manager');
const { resolveAgentProviderAndModel } = await import('@/lib/orchestration/llm/agent-resolver');
const { streamComposeQuestionnaire } =
  await import('@/lib/app/questionnaire/ingestion/stream-compose');
import type { ComposeGenEvent } from '@/lib/app/questionnaire/ingestion/compose-events';

type Mock = ReturnType<typeof vi.fn>;

const OUTLINE = JSON.stringify({
  sections: [
    { ordinal: 0, title: 'A' },
    { ordinal: 1, title: 'B' },
  ],
  inferredGoal: 'Goal',
});

/** Every section returns the SAME key, to exercise cross-section de-duplication. */
const SECTION_QS = JSON.stringify({
  questions: [
    {
      sectionOrdinal: 0,
      key: 'shared',
      prompt: 'A question?',
      suggestedType: 'free_text',
      extractionConfidence: 0.8,
    },
  ],
});

/**
 * Provider whose `chat` branches on the joined prompt text: outline prompts get the
 * outline JSON, section prompts get questions — or, for a section whose title is in
 * `failTitles`, garbage (so it fails schema validation after the retry).
 */
function makeProvider(opts: { outline?: string; failTitles?: string[] } = {}) {
  const outline = opts.outline ?? OUTLINE;
  const failTitles = opts.failTitles ?? [];
  return {
    chat: vi.fn(async (messages: { content: string }[]) => {
      const all = messages.map((m) => String(m.content)).join('\n');
      let content: string;
      if (all.includes("Plan the questionnaire's SHAPE")) {
        content = outline;
      } else if (failTitles.some((t) => all.includes(`"${t}"`))) {
        content = 'not valid json';
      } else {
        content = SECTION_QS;
      }
      return {
        content,
        usage: { inputTokens: 10, outputTokens: 5 },
        model: 'm',
        finishReason: 'stop' as const,
      };
    }),
  };
}

async function collect(gen: AsyncGenerator<ComposeGenEvent, unknown>) {
  const events: ComposeGenEvent[] = [];
  let res = await gen.next();
  while (!res.done) {
    events.push(res.value);
    res = await gen.next();
  }
  return { events, structure: res.value as { sections: unknown[]; questions: { key: string }[] } };
}

const agent = { provider: '', model: '', fallbackProviders: [] };

beforeEach(() => {
  vi.clearAllMocks();
  (resolveAgentProviderAndModel as Mock).mockResolvedValue({
    providerSlug: 'test-provider',
    model: 'test-model',
    fallbacks: [],
  });
});

describe('streamComposeQuestionnaire', () => {
  it('emits outline then a section_done per section and returns the assembled structure', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider());

    const { events, structure } = await collect(streamComposeQuestionnaire({ brief: 'b', agent }));

    expect(events[0]?.type).toBe('outline');
    const sectionDone = events.filter((e) => e.type === 'section_done');
    expect(sectionDone).toHaveLength(2);
    expect(structure.sections).toHaveLength(2);
    expect(structure.questions).toHaveLength(2);
    // No error event on the happy path.
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('de-duplicates colliding question keys across sections', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider());

    const { structure } = await collect(streamComposeQuestionnaire({ brief: 'b', agent }));

    const keys = structure.questions.map((q) => q.key);
    expect(new Set(keys).size).toBe(keys.length); // all unique
    expect(keys).toContain('shared');
  });

  it('reports a failed section as section_error without aborting the others', async () => {
    // Distinctive titles: the section-question prompt's type-config example mentions
    // "A"/"B", so a fail-title must be unique to avoid matching every section.
    const outline = JSON.stringify({
      sections: [
        { ordinal: 0, title: 'KeepSection' },
        { ordinal: 1, title: 'FailSection' },
      ],
    });
    (getProvider as Mock).mockResolvedValue(makeProvider({ outline, failTitles: ['FailSection'] }));

    const { events, structure } = await collect(streamComposeQuestionnaire({ brief: 'b', agent }));

    expect(events.some((e) => e.type === 'section_error')).toBe(true);
    // Section A still produced its question; the run is not fatal.
    expect(structure.questions).toHaveLength(1);
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('emits a fatal error and an empty structure when the outline never validates', async () => {
    (getProvider as Mock).mockResolvedValue(makeProvider({ outline: 'garbage' }));

    const { events, structure } = await collect(streamComposeQuestionnaire({ brief: 'b', agent }));

    const err = events.find((e) => e.type === 'error');
    expect(err).toMatchObject({ type: 'error', code: 'outline_failed' });
    expect(structure.sections).toHaveLength(0);
  });

  it('emits no_provider_configured and never calls the provider when resolution fails', async () => {
    (resolveAgentProviderAndModel as Mock).mockRejectedValueOnce(new Error('no provider'));

    const { events, structure } = await collect(streamComposeQuestionnaire({ brief: 'b', agent }));

    expect(events).toEqual([
      { type: 'error', code: 'no_provider_configured', message: expect.any(String) },
    ]);
    expect(getProvider).not.toHaveBeenCalled();
    expect(structure.sections).toHaveLength(0);
  });

  it('emits provider_unavailable when getProvider throws', async () => {
    (getProvider as Mock).mockRejectedValueOnce(new Error('provider down'));

    const { events, structure } = await collect(streamComposeQuestionnaire({ brief: 'b', agent }));

    expect(events).toEqual([
      { type: 'error', code: 'provider_unavailable', message: expect.any(String) },
    ]);
    expect(structure.sections).toHaveLength(0);
  });

  it('emits composition_failed when every section fails', async () => {
    const outline = JSON.stringify({
      sections: [{ ordinal: 0, title: 'OnlyFail' }],
    });
    (getProvider as Mock).mockResolvedValue(makeProvider({ outline, failTitles: ['OnlyFail'] }));

    const { events, structure } = await collect(streamComposeQuestionnaire({ brief: 'b', agent }));

    const sectionErr = events.find((e) => e.type === 'section_error');
    expect(sectionErr).toMatchObject({ type: 'section_error', ordinal: 0 });
    const fatalErr = events.find((e) => e.type === 'error');
    expect(fatalErr).toMatchObject({ type: 'error', code: 'composition_failed' });
    expect(structure.sections).toHaveLength(0);
  });

  it('includes the inferred goal in the outline event when the model returns one', async () => {
    const outline = JSON.stringify({
      sections: [{ ordinal: 0, title: 'Intro' }],
      inferredGoal: 'Understand engagement',
    });
    (getProvider as Mock).mockResolvedValue(makeProvider({ outline }));

    const { events } = await collect(streamComposeQuestionnaire({ brief: 'b', agent }));

    const outlineEvent = events.find((e) => e.type === 'outline');
    expect(outlineEvent).toMatchObject({ goal: 'Understand engagement' });
  });

  it('includes inferredAudience in the outline event when the model returns one', async () => {
    const outline = JSON.stringify({
      sections: [{ ordinal: 0, title: 'Intro' }],
      inferredAudience: { role: 'HR manager', expertiseLevel: 'intermediate' },
    });
    (getProvider as Mock).mockResolvedValue(makeProvider({ outline }));

    const { events } = await collect(streamComposeQuestionnaire({ brief: 'b', agent }));

    const outlineEvent = events.find((e) => e.type === 'outline');
    expect(outlineEvent).toMatchObject({
      audience: { role: 'HR manager', expertiseLevel: 'intermediate' },
    });
  });

  it('omits goal and audience from the outline event when neither is inferred', async () => {
    const outline = JSON.stringify({
      sections: [{ ordinal: 0, title: 'Intro' }],
      // No inferredGoal or inferredAudience.
    });
    (getProvider as Mock).mockResolvedValue(makeProvider({ outline }));

    const { events } = await collect(streamComposeQuestionnaire({ brief: 'b', agent }));

    const outlineEvent = events.find((e) => e.type === 'outline');
    expect(outlineEvent).not.toHaveProperty('goal');
    expect(outlineEvent).not.toHaveProperty('audience');
  });

  it('passes adminSupplied through to the prompt builder (no provider error)', async () => {
    // adminSupplied is an input path — verify the run still succeeds with it set.
    const outline = JSON.stringify({
      sections: [{ ordinal: 0, title: 'AdminSection' }],
      inferredGoal: 'Admin goal',
    });
    (getProvider as Mock).mockResolvedValue(makeProvider({ outline }));

    const { events } = await collect(
      streamComposeQuestionnaire({
        brief: 'b',
        agent,
        adminSupplied: { goal: 'Pre-set goal', audience: { role: 'manager' } },
        agentId: 'agent-123',
      })
    );

    // The run still succeeds — adminSupplied shapes the prompt, not the event stream.
    expect(events[0]?.type).toBe('outline');
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('forces each question onto its section ordinal, overriding the model self-report', async () => {
    const outline = JSON.stringify({
      sections: [
        { ordinal: 0, title: 'KeepSection' },
        { ordinal: 1, title: 'OtherSection' },
      ],
    });
    // Both sections return a question claiming sectionOrdinal: 99 (the model's self-report).
    const sectionQs = JSON.stringify({
      questions: [
        {
          sectionOrdinal: 99,
          key: 'q_a',
          prompt: 'A question?',
          suggestedType: 'free_text',
          extractionConfidence: 0.8,
        },
      ],
    });
    const provider = {
      chat: vi.fn(async (messages: { content: string }[]) => {
        const all = messages.map((m) => String(m.content)).join('\n');
        return {
          content: all.includes("Plan the questionnaire's SHAPE") ? outline : sectionQs,
          usage: { inputTokens: 10, outputTokens: 5 },
          model: 'm',
          finishReason: 'stop' as const,
        };
      }),
    };
    (getProvider as Mock).mockResolvedValue(provider);

    const { structure } = await collect(streamComposeQuestionnaire({ brief: 'b', agent }));

    // The assembler forces section ordinals — no question should carry ordinal 99.
    for (const q of structure.questions as unknown as { sectionOrdinal: number }[]) {
      expect(q.sectionOrdinal).not.toBe(99);
    }
  });

  it('de-duplicates an empty-key question by slugifying the prompt', async () => {
    const outline = JSON.stringify({ sections: [{ ordinal: 0, title: 'SectionX' }] });
    // Key is blank — the deduper should derive one from the prompt.
    const sectionQs = JSON.stringify({
      questions: [
        {
          sectionOrdinal: 0,
          key: '   ',
          prompt: 'What is your name?',
          suggestedType: 'free_text',
          extractionConfidence: 0.9,
        },
      ],
    });
    const provider = {
      chat: vi.fn(async (messages: { content: string }[]) => {
        const all = messages.map((m) => String(m.content)).join('\n');
        return {
          content: all.includes("Plan the questionnaire's SHAPE") ? outline : sectionQs,
          usage: { inputTokens: 5, outputTokens: 3 },
          model: 'm',
          finishReason: 'stop' as const,
        };
      }),
    };
    (getProvider as Mock).mockResolvedValue(provider);

    const { structure } = await collect(streamComposeQuestionnaire({ brief: 'b', agent }));

    // Non-empty, derived from the prompt.
    const keys = structure.questions.map((q) => q.key);
    expect(keys[0]).toBeTruthy();
    expect(keys[0]).not.toMatch(/^\s*$/);
  });

  it('handles more sections than concurrency cap (launches additional tasks mid-loop)', async () => {
    // SECTION_CONCURRENCY is 4 — create 5 sections to exercise the launch()
    // call inside the while loop (the branch taken when next < items.length after
    // an item resolves while others are still in-flight).
    const sections = Array.from({ length: 5 }, (_, i) => ({ ordinal: i, title: `S${i}` }));
    const outlineJson = JSON.stringify({ sections });
    const sectionQsJson = JSON.stringify({
      questions: [
        {
          sectionOrdinal: 0,
          key: 'q',
          prompt: 'A question?',
          suggestedType: 'free_text',
          extractionConfidence: 0.8,
        },
      ],
    });
    const provider = {
      chat: vi.fn(async (messages: { content: string }[]) => {
        const all = messages.map((m) => String(m.content)).join('\n');
        return {
          content: all.includes("Plan the questionnaire's SHAPE") ? outlineJson : sectionQsJson,
          usage: { inputTokens: 5, outputTokens: 3 },
          model: 'm',
          finishReason: 'stop' as const,
        };
      }),
    };
    (getProvider as Mock).mockResolvedValue(provider);

    const { events, structure } = await collect(streamComposeQuestionnaire({ brief: 'b', agent }));

    // All 5 sections should produce section_done events and one question each.
    const sectionDone = events.filter((e) => e.type === 'section_done');
    expect(sectionDone).toHaveLength(5);
    expect(structure.sections).toHaveLength(5);
    // 5 questions total (one per section); keys may be de-duplicated.
    expect(structure.questions).toHaveLength(5);
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('emits outline_failed when outline JSON is valid but fails composeOutlineSchema', async () => {
    // Valid JSON that is not a valid composeOutlineSchema (no "sections" key).
    // This exercises issuePaths lines 206-209 in stream-compose.ts.
    const badOutline = JSON.stringify({ wrong: 'no sections here' });
    (getProvider as Mock).mockResolvedValue(makeProvider({ outline: badOutline }));

    const { events, structure } = await collect(streamComposeQuestionnaire({ brief: 'b', agent }));

    // The outline never validated — outline_failed error must be emitted.
    const err = events.find((e) => e.type === 'error');
    expect(err).toMatchObject({ type: 'error', code: 'outline_failed' });
    expect(structure.sections).toHaveLength(0);
  });

  it('sets issuePaths from schema-invalid (but valid JSON) section response before retrying', async () => {
    // The section response is valid JSON but missing required fields — validation
    // fails on first attempt, setting issuePaths. The retry returns 'also invalid'
    // so the section ends up as section_error (not a test pass, but covers the branch).
    const outline = JSON.stringify({ sections: [{ ordinal: 0, title: 'OnlySection' }] });
    // Valid JSON that doesn't match composeQuestionsSchema (no "questions" key).
    const badJson = JSON.stringify({ wrong: 'shape' });
    const provider = {
      chat: vi.fn(async (messages: { content: string }[]) => {
        const all = messages.map((m) => String(m.content)).join('\n');
        return {
          content: all.includes("Plan the questionnaire's SHAPE") ? outline : badJson,
          usage: { inputTokens: 5, outputTokens: 3 },
          model: 'm',
          finishReason: 'stop' as const,
        };
      }),
    };
    (getProvider as Mock).mockResolvedValue(provider);

    const { events } = await collect(streamComposeQuestionnaire({ brief: 'b', agent }));

    // The section failed (validation never passed) — section_error is emitted, not section_done.
    expect(events.some((e) => e.type === 'section_error')).toBe(true);
    // The outer composition_failed follows (all sections failed).
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  it('silently absorbs a logCost rejection without surfacing an error event', async () => {
    const { logCost } = await import('@/lib/orchestration/llm/cost-tracker');
    (logCost as Mock).mockRejectedValueOnce(new Error('cost-tracker down'));

    const outline = JSON.stringify({ sections: [{ ordinal: 0, title: 'S' }] });
    const sectionQs = JSON.stringify({
      questions: [
        {
          sectionOrdinal: 0,
          key: 'q',
          prompt: 'Q?',
          suggestedType: 'free_text',
          extractionConfidence: 0.9,
        },
      ],
    });
    const provider = {
      chat: vi.fn(async (messages: { content: string }[]) => {
        const all = messages.map((m) => String(m.content)).join('\n');
        return {
          content: all.includes("Plan the questionnaire's SHAPE") ? outline : sectionQs,
          usage: { inputTokens: 5, outputTokens: 3 },
          model: 'm',
          finishReason: 'stop' as const,
        };
      }),
    };
    (getProvider as Mock).mockResolvedValue(provider);

    const { events, structure } = await collect(streamComposeQuestionnaire({ brief: 'b', agent }));

    // The cost failure must not leak into the event stream.
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(structure.sections).toHaveLength(1);
  });
});
