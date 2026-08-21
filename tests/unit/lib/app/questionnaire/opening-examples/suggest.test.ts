/**
 * Unit tests: opening-question suggestions — the prompt builder and the response narrower.
 *
 * Both are pure, so they are tested without a provider. Two things matter most:
 *
 *  - **The narrower can never propose something the save would reject.** It bounds text to the same
 *    `OPENING_EXAMPLE_MAX` the Zod schema and the editor enforce, and drops what it cannot salvage
 *    rather than failing the whole call.
 *  - **The prompt carries the decisions that make the openers usable.** That the examples are
 *    guidance rather than a script, that they anchor on the subject rather than an individual
 *    question, and that they must vary — those are the difference between a useful answer and five
 *    rephrasings of a generic opener, so they are asserted rather than assumed.
 *
 * @see lib/app/questionnaire/opening-examples/suggest.ts
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({ prisma: { aiAgent: { findUnique: vi.fn() } } }));
vi.mock('@/lib/orchestration/llm/agent-resolver', () => ({
  resolveAgentProviderAndModel: vi.fn(),
}));
vi.mock('@/lib/orchestration/llm/provider-manager', () => ({ getProvider: vi.fn() }));
vi.mock('@/lib/app/questionnaire/llm/log-app-cost', () => ({ logAppLlmCost: vi.fn() }));

import { prisma } from '@/lib/db/client';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { logAppLlmCost } from '@/lib/app/questionnaire/llm/log-app-cost';
import {
  buildSuggestMessages,
  suggestOpeningExamples,
  validateSuggestResult,
  MAX_QUESTIONS_IN_PROMPT,
  MAX_SECTIONS_IN_PROMPT,
  type OpeningExamplesSuggestContext,
} from '@/lib/app/questionnaire/opening-examples/suggest';
import { OPENING_EXAMPLE_MAX } from '@/lib/app/questionnaire/types';

const CONTEXT: OpeningExamplesSuggestContext = {
  title: 'Employee experience review',
  goal: 'Understand how supported people feel by their manager.',
  audience: { role: 'Team members', expertiseLevel: 'novice', sensitivity: 'high' },
  sectionTitles: ['Day to day', 'Support and development'],
  questions: ['How supported do you feel?', 'What would make the biggest difference?'],
  glossaryTerms: ['line manager'],
  sensitivityAwareness: false,
  existingExamples: [],
};

const ctx = (over: Partial<OpeningExamplesSuggestContext> = {}): OpeningExamplesSuggestContext => ({
  ...CONTEXT,
  ...over,
});

/** The system message — where the craft guidance and constraints live. */
const system = (context: OpeningExamplesSuggestContext): string => {
  const content = buildSuggestMessages(context)[0].content;
  if (typeof content !== 'string') throw new Error('expected string content');
  return content;
};

/** The user message — where this questionnaire's specifics live. */
const user = (context: OpeningExamplesSuggestContext): string => {
  const content = buildSuggestMessages(context)[1].content;
  if (typeof content !== 'string') throw new Error('expected string content');
  return content;
};

describe('buildSuggestMessages', () => {
  it('sends a system + user pair', () => {
    expect(buildSuggestMessages(ctx()).map((m) => m.role)).toEqual(['system', 'user']);
  });

  /**
   * Told the interviewer will riff on its examples rather than recite them, the model writes better
   * models of a register. Told nothing, it writes safe ready-to-read lines.
   */
  it('tells the model its examples are guidance, not a script', () => {
    const s = system(ctx());
    expect(s).toMatch(/GUIDANCE, not as a script/);
    expect(s).toMatch(/never to read one out/);
  });

  it('demands variety rather than rephrasings of one question', () => {
    const s = system(ctx());
    expect(s).toMatch(/VARY them/);
    expect(s).toMatch(/rephrasings of one question is a failure/);
  });

  /**
   * The core tension of the feature: the opener must be unmistakably about THIS questionnaire, but
   * must not ask any of its questions — the opening deliberately comes before all of them.
   */
  it('anchors on the subject while forbidding an individual question', () => {
    const s = system(ctx());
    expect(s).toMatch(/Anchor every opener on the SUBJECT/);
    expect(s).toMatch(/do NOT name, quote or paraphrase an individual question/);
    // The same warning rides the question list itself, where it is hardest to ignore.
    expect(user(ctx())).toMatch(/do not ask any of these/i);
  });

  it('names the failure modes that survive a plausible first draft', () => {
    const s = system(ctx());
    for (const quality of ['BROAD', 'EASY', 'OPEN', 'NEUTRAL', 'SINGLE', 'PLAIN']) {
      expect(s).toContain(quality);
    }
    expect(s).toMatch(/impossible to answer with yes, no, or a number/);
  });

  /** The interviewer already covers these separately; an opener that repeats them says it twice. */
  it('forbids covering ground the interviewer handles elsewhere', () => {
    expect(system(ctx())).toMatch(/who sees them, how long it takes/);
  });

  it('asks for a reason per opener, framed as the admin’s decision', () => {
    expect(system(ctx())).toMatch(/the admin is choosing, not you/);
  });

  it('carries the questionnaire’s subject, goal, audience, ground and terms', () => {
    const u = user(ctx());
    expect(u).toContain('Employee experience review');
    expect(u).toContain('Understand how supported people feel by their manager.');
    expect(u).toContain('Team members');
    expect(u).toContain('Day to day');
    expect(u).toContain('line manager');
  });

  it('omits absent context rather than emitting an empty heading', () => {
    const u = user(
      ctx({ goal: '', audience: {}, sectionTitles: [], questions: [], glossaryTerms: [] })
    );
    expect(u).not.toMatch(/Its goal/);
    expect(u).not.toMatch(/Who answers it/);
    expect(u).not.toMatch(/The ground it covers/);
    expect(u).not.toMatch(/Terms this questionnaire defines/);
    // The title and the closing instruction always survive, so the prompt is still coherent.
    expect(u).toContain('Employee experience review');
    expect(u).toMatch(/Propose the opening questions now/);
  });

  it('warns the model to tread gently when the subject is sensitive', () => {
    expect(user(ctx({ sensitivityAwareness: true }))).toMatch(/must not lead with the difficult/);
    expect(user(ctx({ sensitivityAwareness: false }))).not.toMatch(
      /must not lead with the difficult/
    );
  });

  it('pitches language at the audience’s expertise when it is known', () => {
    expect(user(ctx())).toMatch(/expertise \(novice\) — never above it/);
    expect(user(ctx({ audience: {} }))).not.toMatch(/never above it/);
  });

  it('lists the openers already written so it proposes alternatives', () => {
    const u = user(ctx({ existingExamples: ['Tell me about your week.'] }));
    expect(u).toMatch(/do not restate these/i);
    expect(u).toContain('Tell me about your week.');
    expect(user(ctx())).not.toMatch(/do not restate these/i);
  });

  it('caps how many questions and sections reach the prompt', () => {
    // Every question is prompt cost; enough to characterise the subject is enough.
    const questions = Array.from({ length: 60 }, (_, i) => `Question number ${i}?`);
    const sectionTitles = Array.from({ length: 30 }, (_, i) => `Section number ${i}`);
    const u = user(ctx({ questions, sectionTitles }));
    expect(u).toContain(`Question number ${MAX_QUESTIONS_IN_PROMPT - 1}?`);
    expect(u).not.toContain(`Question number ${MAX_QUESTIONS_IN_PROMPT}?`);
    expect(u).toContain(`Section number ${MAX_SECTIONS_IN_PROMPT - 1}`);
    expect(u).not.toContain(`Section number ${MAX_SECTIONS_IN_PROMPT}`);
  });
});

describe('validateSuggestResult', () => {
  const ok = { text: 'Tell me about your week.', why: 'Easy to answer, opens several threads.' };

  it.each([
    ['null', null],
    ['a string', 'nope'],
    ['an object with no suggestions array', { suggestions: 'lots' }],
    ['an empty object', {}],
  ])('returns null for %s so the runner retries', (_label, value) => {
    expect(validateSuggestResult(value)).toBeNull();
  });

  it('accepts an empty suggestion list as a real answer', () => {
    // "Nothing worth adding for this questionnaire" is a legitimate result, not a failure.
    expect(validateSuggestResult({ suggestions: [] })).toEqual({ suggestions: [] });
  });

  it('keeps well-formed suggestions in order', () => {
    const second = { text: 'What stands out, good and bad?', why: 'Invites both sides.' };
    expect(validateSuggestResult({ suggestions: [ok, second] })?.suggestions).toEqual([ok, second]);
  });

  it.each([
    ['a non-object entry', 'an opener'],
    ['empty text', { ...ok, text: '   ' }],
    ['missing text', { why: 'no question here' }],
    ['non-string text', { text: 42, why: 'x' }],
  ])('drops %s without failing the whole call', (_label, bad) => {
    const result = validateSuggestResult({ suggestions: [ok, bad] });
    expect(result?.suggestions).toHaveLength(1);
    expect(result?.suggestions[0]?.text).toBe(ok.text);
  });

  /**
   * The same bound the Zod schema and the editor enforce, so the assistant can never propose an
   * opener the config PATCH would reject.
   */
  it('bounds over-long text to the stored limit', () => {
    const result = validateSuggestResult({
      suggestions: [{ text: 't'.repeat(OPENING_EXAMPLE_MAX + 40), why: 'w' }],
    });
    expect(result?.suggestions[0]?.text).toHaveLength(OPENING_EXAMPLE_MAX);
  });

  it('trims surrounding whitespace', () => {
    expect(
      validateSuggestResult({ suggestions: [{ text: '  Tell me.  ', why: 'x' }] })?.suggestions[0]
        ?.text
    ).toBe('Tell me.');
  });

  /** Two identical openers in the panel read as a UI bug rather than a model quirk. */
  it('drops duplicates, case-insensitively', () => {
    const result = validateSuggestResult({
      suggestions: [ok, { ...ok, why: 'said twice' }, { ...ok, text: ok.text.toUpperCase() }],
    });
    expect(result?.suggestions).toHaveLength(1);
  });

  it('tolerates a missing reason rather than dropping an otherwise good opener', () => {
    const result = validateSuggestResult({ suggestions: [{ text: 'Tell me about your week.' }] });
    expect(result?.suggestions[0]).toEqual({ text: 'Tell me about your week.', why: '' });
  });

  it('caps a runaway list', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ ...ok, text: `Opener ${i}?` }));
    expect(validateSuggestResult({ suggestions: many })?.suggestions.length).toBeLessThanOrEqual(6);
  });
});

type Mock = ReturnType<typeof vi.fn>;

/** A provider whose one `chat` call returns `responseJson` serialised, matching LlmResponse. */
function fakeProvider(responseJson: object) {
  const chat = vi.fn().mockResolvedValue({
    content: JSON.stringify(responseJson),
    usage: { inputTokens: 30, outputTokens: 15 },
    model: 'test-model',
    finishReason: 'stop',
  });
  return { provider: { chat }, chat };
}

describe('suggestOpeningExamples', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.aiAgent.findUnique as Mock).mockResolvedValue({
      id: 'agent-1',
      provider: 'openai',
      model: 'test-model',
      fallbackProviders: [],
      systemInstructions: 'You are the opening questions assistant.',
      temperature: 0.7,
      maxTokens: 1024,
    });
    (resolveAgentProviderAndModel as Mock).mockResolvedValue({
      providerSlug: 'openai',
      model: 'test-model',
      fallbacks: [],
    });
  });

  it('returns the narrowed suggestions plus the resolved binding and cost', async () => {
    const { provider, chat } = fakeProvider({
      suggestions: [
        { text: 'Tell me about your week.', why: 'Easy to answer.' },
        // Unusable — dropped by the narrower rather than failing the call.
        { why: 'no question here' },
      ],
    });
    (getProvider as Mock).mockResolvedValue(provider);

    const result = await suggestOpeningExamples({ context: ctx(), versionId: 'v1' });

    expect(result.suggestions).toEqual([
      { text: 'Tell me about your week.', why: 'Easy to answer.' },
    ]);
    // The binding is reported post-resolution so the caller can record what actually ran.
    expect(result.provider).toBe('openai');
    expect(result.model).toBe('test-model');
    expect(result.costUsd).toBeGreaterThanOrEqual(0);

    // The composed prompt is what reaches the provider.
    const messages = chat.mock.calls[0][0] as Array<{ role: string; content: string }>;
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(messages[1]?.content).toContain('Employee experience review');
  });

  it('attributes the spend to this version and capability', async () => {
    const { provider } = fakeProvider({ suggestions: [] });
    (getProvider as Mock).mockResolvedValue(provider);

    await suggestOpeningExamples({ context: ctx(), versionId: 'v1' });

    // Every direct app LLM call must be attributable to the artifact it was spent on.
    expect(logAppLlmCost).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        provider: 'openai',
        model: 'test-model',
        capability: 'app_opening_examples_suggest',
        versionId: 'v1',
        tokenUsage: { input: 30, output: 15 },
        extra: { suggestions: 0 },
      })
    );
  });

  it('throws a named error when the assistant agent is not seeded', async () => {
    (prisma.aiAgent.findUnique as Mock).mockResolvedValue(null);
    await expect(suggestOpeningExamples({ context: ctx(), versionId: 'v1' })).rejects.toThrow(
      /not seeded/
    );
  });

  it('retries once, then throws a named error when the reply never parses', async () => {
    // A model that answers in prose is the realistic failure here, and the narrower cannot salvage
    // it — there is no envelope to narrow. One retry with the JSON-only nudge, then a named error
    // the route turns into its 502; without this the caller would surface a raw parse error.
    const chat = vi.fn().mockResolvedValue({
      content: 'Here are some great opening questions you could use!',
      usage: { inputTokens: 30, outputTokens: 15 },
      model: 'test-model',
      finishReason: 'stop',
    });
    (getProvider as Mock).mockResolvedValue({ chat });

    await expect(suggestOpeningExamples({ context: ctx(), versionId: 'v1' })).rejects.toThrow(
      /not valid JSON after retry/
    );
    // Retried rather than failing on the first bad reply — a one-shot give-up wastes the call.
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it('uses the seeded agent’s temperature so the variety knob is operator-tunable', async () => {
    const { provider } = fakeProvider({ suggestions: [] });
    (getProvider as Mock).mockResolvedValue(provider);

    await suggestOpeningExamples({ context: ctx(), versionId: 'v1' });

    // A low temperature returns five rephrasings of one question, so the seed sets it deliberately
    // and the runner must not override it.
    const options = (provider.chat as Mock).mock.calls[0][1] as { temperature?: number };
    expect(options.temperature).toBe(0.7);
  });
});
