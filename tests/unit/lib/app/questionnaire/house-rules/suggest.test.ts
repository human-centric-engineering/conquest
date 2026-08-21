/**
 * Unit tests: house-rule suggestions — the prompt builder and the response narrower.
 *
 * Both are pure, so they are tested without a provider. What matters most here is that the
 * assistant's output can never produce a rule the rest of the system would reject: the narrower
 * enforces the same trigger-only-on-`if_asked` invariant the editor, the Zod schema, and the
 * read-path narrower all hold, and it drops what it cannot salvage rather than failing the call.
 *
 * @see lib/app/questionnaire/house-rules/suggest.ts
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
  suggestHouseRules,
  validateSuggestResult,
  type HouseRulesSuggestContext,
} from '@/lib/app/questionnaire/house-rules/suggest';
import { HOUSE_RULE_TEXT_MAX, HOUSE_RULE_TRIGGER_MAX } from '@/lib/app/questionnaire/types';

const CONTEXT: HouseRulesSuggestContext = {
  title: 'Employee experience review',
  goal: 'Understand how supported people feel by their manager.',
  audience: { role: 'Team members', expertiseLevel: 'novice', sensitivity: 'high' },
  questions: ['How supported do you feel?', 'What would make the biggest difference?'],
  glossaryTerms: ['line manager'],
  anonymousMode: false,
  sensitivityAwareness: false,
  hasSupportMessage: false,
  existingRules: [],
};

const ctx = (over: Partial<HouseRulesSuggestContext> = {}): HouseRulesSuggestContext => ({
  ...CONTEXT,
  ...over,
});

/** The system message — where the constraints live. */
const system = (context: HouseRulesSuggestContext): string => {
  const content = buildSuggestMessages(context)[0].content;
  if (typeof content !== 'string') throw new Error('expected string content');
  return content;
};

/** The user message — where this questionnaire's specifics live. */
const user = (context: HouseRulesSuggestContext): string => {
  const content = buildSuggestMessages(context)[1].content;
  if (typeof content !== 'string') throw new Error('expected string content');
  return content;
};

describe('buildSuggestMessages', () => {
  it('sends a system + user pair', () => {
    const messages = buildSuggestMessages(ctx());
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
  });

  it('forbids proposing rules the interviewer cannot act on', () => {
    // A suggester that proposes what the authoring lints immediately flag is worse than none —
    // it teaches the admin the AI and the warnings disagree.
    const s = system(ctx());
    expect(s).toMatch(/scoring or marking answers/i);
    expect(s).toMatch(/which questions get asked or in what order/i);
    expect(s).toMatch(/reply format/i);
    expect(s).toMatch(/more than one question in a turn/i);
  });

  it('asks for restraint rather than a full list', () => {
    // A long generic list is how an admin learns to stop reading suggestions.
    const s = system(ctx());
    expect(s).toMatch(/fewer is better than padding/i);
    expect(s).toMatch(/return an empty array/i);
  });

  it('requires a reason for every rule', () => {
    expect(system(ctx())).toMatch(/the admin is deciding, not you/i);
  });

  it('carries the questionnaire’s own goal, audience, questions and terms', () => {
    const u = user(ctx());
    expect(u).toContain('Employee experience review');
    expect(u).toContain('Understand how supported people feel by their manager.');
    expect(u).toContain('Team members');
    expect(u).toContain('How supported do you feel?');
    expect(u).toContain('line manager');
  });

  it('tells a non-anonymous questionnaire not to promise anonymity', () => {
    const u = user(ctx({ anonymousMode: false }));
    expect(u).toMatch(/do not propose a rule that tells respondents their answers are anonymous/i);
  });

  it('tells an anonymous questionnaire not to ask for identifying details', () => {
    const u = user(ctx({ anonymousMode: true }));
    expect(u).toMatch(/do not propose anything that asks for a name, email/i);
    expect(u).not.toMatch(/tells respondents their answers are anonymous/i);
  });

  it('suppresses support-signposting rules when no support message is configured', () => {
    expect(user(ctx({ sensitivityAwareness: false, hasSupportMessage: false }))).toMatch(
      /do not propose a rule that points respondents at a support line/i
    );
    expect(user(ctx({ sensitivityAwareness: true, hasSupportMessage: true }))).not.toMatch(
      /points respondents at a support line/i
    );
  });

  it('lists the existing rules and forbids restating them', () => {
    const u = user(ctx({ existingRules: [{ kind: 'never', text: 'Give advice.' }] }));
    expect(u).toContain('[never] Give advice.');
    expect(u).toMatch(/do not restate these/i);
  });

  it('omits the existing-rules block entirely when there are none', () => {
    expect(user(ctx({ existingRules: [] }))).not.toMatch(/do not restate these/i);
  });

  it('omits every optional block on a bare-bones questionnaire', () => {
    // A version with only a title — freshly created, nothing authored yet. The prompt must still be
    // coherent rather than carrying empty headings the model has to interpret.
    const u = user(
      ctx({ goal: '', audience: undefined, questions: [], glossaryTerms: [], existingRules: [] })
    );
    expect(u).not.toMatch(/Its goal/);
    expect(u).not.toMatch(/Who answers it/);
    expect(u).not.toMatch(/What it asks about/);
    expect(u).not.toMatch(/Terms this questionnaire defines/);
    // The constraint block and the closing instruction always survive.
    expect(u).toMatch(/Settings you must not contradict/);
    expect(u).toMatch(/Propose the house rules now\./);
  });

  it('includes a partial audience without inventing the missing fields', () => {
    const u = user(ctx({ audience: { role: 'Managers' } }));
    expect(u).toContain('Role: Managers');
    expect(u).not.toMatch(/Expertise:/);
    expect(u).not.toMatch(/Sensitivity of the subject:/);
  });

  it('caps how many questions reach the prompt', () => {
    // Every question is prompt cost; 40 is enough to characterise an instrument.
    const questions = Array.from({ length: 60 }, (_, i) => `Question number ${i}?`);
    const u = user(ctx({ questions }));
    expect(u).toContain('Question number 39?');
    expect(u).not.toContain('Question number 40?');
  });
});

describe('validateSuggestResult', () => {
  const ok = { kind: 'always', text: 'Ask for an example.', why: 'Turns vague answers concrete.' };

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

  it('keeps a well-formed suggestion of each kind', () => {
    const result = validateSuggestResult({
      suggestions: [
        ok,
        { kind: 'never', text: 'Give advice.', why: 'Keeps it collecting, not advising.' },
        {
          kind: 'if_asked',
          text: 'Only the research team.',
          trigger: 'who sees this',
          why: 'Asked constantly.',
        },
      ],
    });
    expect(result?.suggestions).toEqual([
      { kind: 'always', text: 'Ask for an example.', why: 'Turns vague answers concrete.' },
      { kind: 'never', text: 'Give advice.', why: 'Keeps it collecting, not advising.' },
      {
        kind: 'if_asked',
        text: 'Only the research team.',
        trigger: 'who sees this',
        why: 'Asked constantly.',
      },
    ]);
  });

  it.each([
    ['an unrecognised kind', { ...ok, kind: 'maybe' }],
    ['a non-object entry', 'a rule'],
    ['empty text', { ...ok, text: '  ' }],
    // Would fail the config save — the invariant the editor and Zod schema also hold.
    ['an if_asked rule with no trigger', { kind: 'if_asked', text: 'Yes.', why: 'x' }],
  ])('drops %s without failing the whole call', (_label, bad) => {
    // Four good suggestions and one malformed fifth is still a useful answer.
    const result = validateSuggestResult({ suggestions: [ok, bad] });
    expect(result?.suggestions).toHaveLength(1);
    expect(result?.suggestions[0]?.text).toBe('Ask for an example.');
  });

  it('strips a trigger the model attached to a non-if_asked rule', () => {
    const result = validateSuggestResult({ suggestions: [{ ...ok, trigger: 'stray' }] });
    expect(result?.suggestions[0]).not.toHaveProperty('trigger');
  });

  it('bounds over-long text and triggers to the stored limits', () => {
    const result = validateSuggestResult({
      suggestions: [
        {
          kind: 'if_asked',
          text: 't'.repeat(HOUSE_RULE_TEXT_MAX + 40),
          trigger: 'g'.repeat(HOUSE_RULE_TRIGGER_MAX + 40),
          why: 'w',
        },
      ],
    });
    expect(result?.suggestions[0]?.text).toHaveLength(HOUSE_RULE_TEXT_MAX);
    expect(result?.suggestions[0]?.trigger).toHaveLength(HOUSE_RULE_TRIGGER_MAX);
  });

  it('tolerates a missing reason rather than dropping an otherwise good rule', () => {
    const result = validateSuggestResult({
      suggestions: [{ kind: 'never', text: 'Give advice.' }],
    });
    expect(result?.suggestions[0]).toMatchObject({ kind: 'never', why: '' });
  });

  it('caps a runaway list', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ ...ok, text: `Rule ${i}.` }));
    expect(validateSuggestResult({ suggestions: many })?.suggestions.length).toBeLessThanOrEqual(
      10
    );
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

describe('suggestHouseRules', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.aiAgent.findUnique as Mock).mockResolvedValue({
      id: 'agent-1',
      provider: 'openai',
      model: 'test-model',
      fallbackProviders: [],
      systemInstructions: 'You are the house rules assistant.',
      temperature: 0.4,
      maxTokens: 2048,
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
        { kind: 'never', text: 'Give advice.', why: 'Keeps it collecting.' },
        // Unusable — dropped by the narrower rather than failing the call.
        { kind: 'if_asked', text: 'No trigger here.', why: 'x' },
      ],
    });
    (getProvider as Mock).mockResolvedValue(provider);

    const result = await suggestHouseRules({ context: ctx(), versionId: 'v1' });

    expect(result.suggestions).toEqual([
      { kind: 'never', text: 'Give advice.', why: 'Keeps it collecting.' },
    ]);
    // The binding is reported post-resolution so the caller can record what actually ran.
    expect(result.provider).toBe('openai');
    expect(result.model).toBe('test-model');
    // Not `typeof === 'number'` — TypeScript already guarantees that, so it can never fail.
    expect(result.costUsd).toBeGreaterThanOrEqual(0);

    // The composed prompt is what reaches the provider.
    const messages = chat.mock.calls[0][0] as Array<{ role: string; content: string }>;
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(messages[1]?.content).toContain('Employee experience review');
  });

  it('attributes the spend to this version and capability', async () => {
    const { provider } = fakeProvider({ suggestions: [] });
    (getProvider as Mock).mockResolvedValue(provider);

    await suggestHouseRules({ context: ctx(), versionId: 'v1' });

    // Every direct app LLM call must be attributable to the artifact it was spent on.
    expect(logAppLlmCost).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        provider: 'openai',
        model: 'test-model',
        capability: 'app_house_rules_suggest',
        versionId: 'v1',
        // The token counts must be the runner's summed total, not a fresh object — app cost
        // attribution is the whole reason this row exists.
        tokenUsage: { input: 30, output: 15 },
        extra: { suggestions: 0 },
      })
    );
  });

  it('falls back to its own token cap when the agent has none set', async () => {
    (prisma.aiAgent.findUnique as Mock).mockResolvedValue({
      id: 'agent-1',
      provider: 'openai',
      model: 'test-model',
      fallbackProviders: [],
      systemInstructions: '',
      temperature: 0.4,
      maxTokens: 0,
    });
    const { provider, chat } = fakeProvider({ suggestions: [] });
    (getProvider as Mock).mockResolvedValue(provider);

    await suggestHouseRules({ context: ctx(), versionId: 'v1' });

    // An unset cap must not reach the provider as 0, which would truncate every reply.
    const opts = chat.mock.calls[0][1] as { maxTokens?: number };
    expect(opts.maxTokens).toBeGreaterThan(0);
  });

  it('throws after the retry when the reply never parses, having tried twice', async () => {
    // The path the module docstring names and the route maps to a 502. The runner retries once at
    // temperature 0 before giving up, so a prose reply must cost exactly two attempts.
    const chat = vi.fn().mockResolvedValue({
      content: 'Sure! Here are some rules you might like:',
      usage: { inputTokens: 10, outputTokens: 5 },
      model: 'test-model',
      finishReason: 'stop',
    });
    (getProvider as Mock).mockResolvedValue({ chat });

    await expect(suggestHouseRules({ context: ctx(), versionId: 'v1' })).rejects.toThrow(
      /not valid JSON after retry/i
    );
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it('throws when the assistant agent is not seeded', async () => {
    (prisma.aiAgent.findUnique as Mock).mockResolvedValue(null);
    await expect(suggestHouseRules({ context: ctx(), versionId: 'v1' })).rejects.toThrow(
      /not seeded/i
    );
  });

  it('surfaces an empty proposal set rather than treating it as a failure', async () => {
    // "Nothing worth adding for this questionnaire" is a real answer the UI renders as such.
    const { provider } = fakeProvider({ suggestions: [] });
    (getProvider as Mock).mockResolvedValue(provider);

    const result = await suggestHouseRules({ context: ctx(), versionId: 'v1' });
    expect(result.suggestions).toEqual([]);
  });
});
