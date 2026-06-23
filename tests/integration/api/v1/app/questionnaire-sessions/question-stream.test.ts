/**
 * Integration test: the streaming conversational question phraser.
 *
 * The agent lookup, provider resolution, provider stream, and cost tracker are mocked. Pins
 * the streamed prose (content frames + returned message + cost), the fail-soft fallback to the
 * VERBATIM prompt (no agent, no provider, mid-stream error before any text), the option/scale
 * extraction, and the prompt assembly (acknowledge / re-ask / opening + audience calibration).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatEvent } from '@/types/orchestration';

const prismaMock = vi.hoisted(() => ({ aiAgent: { findUnique: vi.fn() } }));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

const resolverMock = vi.hoisted(() => ({ resolveAgentProviderAndModel: vi.fn() }));
vi.mock('@/lib/orchestration/llm/agent-resolver', () => resolverMock);

const providerMgrMock = vi.hoisted(() => ({ getProvider: vi.fn() }));
vi.mock('@/lib/orchestration/llm/provider-manager', () => providerMgrMock);

const costMock = vi.hoisted(() => ({
  calculateCost: vi.fn(() => ({ totalCostUsd: 0.0007 })),
  logCost: vi.fn(() => Promise.resolve(null)),
}));
vi.mock('@/lib/orchestration/llm/cost-tracker', () => costMock);

import {
  buildStreamingQuestionPrompt,
  extractOptionLabels,
  streamQuestionMessage,
  type QuestionComposeInput,
} from '@/app/api/v1/app/questionnaire-sessions/_lib/question-stream';
import { narrowToneSettings } from '@/lib/app/questionnaire/chat/tone';
import { DEFAULT_TONE_SETTINGS, type ToneSettings } from '@/lib/app/questionnaire/types';

type Mock = ReturnType<typeof vi.fn>;

const PROMPT = 'How easy was it to set up your account during onboarding?';

const INPUT: QuestionComposeInput = {
  prompt: PROMPT,
  type: 'free_text',
  recentMessages: [],
  lastUserMessage: 'it was a nightmare',
  isReask: false,
  isOpening: false,
  questionsAsked: 4,
};

/** Drain the generator into its yielded content deltas + its return value. */
async function drain(
  gen: AsyncGenerator<ChatEvent, { message: string; costUsd: number }, undefined>
): Promise<{ deltas: string[]; ret: { message: string; costUsd: number } }> {
  const deltas: string[] = [];
  let next = await gen.next();
  while (!next.done) {
    if (next.value.type === 'content') deltas.push(next.value.delta);
    next = await gen.next();
  }
  return { deltas, ret: next.value };
}

/** A provider whose chatStream yields the given text chunks then a done usage. */
function streamingProvider(chunks: string[]) {
  return {
    chatStream: async function* () {
      for (const content of chunks) yield { type: 'text', content };
      yield { type: 'done', usage: { inputTokens: 40, outputTokens: 15 }, finishReason: 'stop' };
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.aiAgent.findUnique.mockResolvedValue({
    id: 'agent-int',
    provider: 'openai',
    model: 'gpt',
    fallbackProviders: [],
  });
  resolverMock.resolveAgentProviderAndModel.mockResolvedValue({
    providerSlug: 'openai',
    model: 'gpt-x',
    fallbacks: [],
  });
});

describe('streamQuestionMessage — success', () => {
  it('streams conversational prose and returns the accumulated message + cost', async () => {
    providerMgrMock.getProvider.mockResolvedValue(
      streamingProvider(['Sorry to hear that — ', 'how easy was setup, ', 'roughly?'])
    );

    const { deltas, ret } = await drain(
      streamQuestionMessage({ input: INPUT, userId: 'u', sessionId: 's1' })
    );

    expect(deltas).toEqual(['Sorry to hear that — ', 'how easy was setup, ', 'roughly?']);
    expect(ret.message).toBe('Sorry to hear that — how easy was setup, roughly?');
    expect(ret.costUsd).toBe(0.0007);
    expect(costMock.calculateCost).toHaveBeenCalledWith('gpt-x', 40, 15);
    expect(costMock.logCost).toHaveBeenCalledTimes(1);
  });
});

describe('streamQuestionMessage — fail-soft to the verbatim prompt', () => {
  it('falls back to the verbatim prompt when the interviewer agent is unconfigured', async () => {
    prismaMock.aiAgent.findUnique.mockResolvedValue(null);
    const { deltas, ret } = await drain(
      streamQuestionMessage({ input: INPUT, userId: 'u', sessionId: 's1' })
    );
    expect(deltas).toEqual([PROMPT]);
    expect(ret).toEqual({ message: PROMPT, costUsd: 0 });
    expect(providerMgrMock.getProvider).not.toHaveBeenCalled();
  });

  it('falls back to the verbatim prompt when no provider resolves', async () => {
    (resolverMock.resolveAgentProviderAndModel as Mock).mockRejectedValue(new Error('no provider'));
    const { deltas, ret } = await drain(
      streamQuestionMessage({ input: INPUT, userId: 'u', sessionId: 's1' })
    );
    expect(deltas).toEqual([PROMPT]);
    expect(ret.message).toBe(PROMPT);
  });

  it('falls back to the verbatim prompt when the stream throws before any text', async () => {
    providerMgrMock.getProvider.mockResolvedValue({
      chatStream: async function* () {
        throw new Error('stream boom');

        yield { type: 'text', content: 'x' };
      },
    });
    const { deltas, ret } = await drain(
      streamQuestionMessage({ input: INPUT, userId: 'u', sessionId: 's1' })
    );
    expect(deltas).toEqual([PROMPT]);
    expect(ret.costUsd).toBe(0);
  });

  it('keeps the partial phrasing when the stream throws after some text arrived', async () => {
    providerMgrMock.getProvider.mockResolvedValue({
      chatStream: async function* () {
        yield { type: 'text', content: 'Got it — ' };
        throw new Error('mid-stream boom');
      },
    });
    const { deltas, ret } = await drain(
      streamQuestionMessage({ input: INPUT, userId: 'u', sessionId: 's1' })
    );
    expect(deltas).toEqual(['Got it — ']);
    expect(ret.message).toBe('Got it — ');
    expect(ret.costUsd).toBe(0);
  });

  it('uses the verbatim prompt when the stream completes empty', async () => {
    providerMgrMock.getProvider.mockResolvedValue({
      chatStream: async function* () {
        // yields nothing and never errors — empty completion
      },
    });
    const { deltas, ret } = await drain(
      streamQuestionMessage({ input: INPUT, userId: 'u', sessionId: 's1' })
    );
    expect(deltas).toEqual([]);
    expect(ret).toEqual({ message: PROMPT, costUsd: 0 });
  });

  it('still returns the message when cost logging rejects (fire-and-forget)', async () => {
    providerMgrMock.getProvider.mockResolvedValue(streamingProvider(['How did setup go?']));
    (costMock.logCost as Mock).mockRejectedValue(new Error('cost write failed'));
    const { ret } = await drain(
      streamQuestionMessage({ input: INPUT, userId: 'u', sessionId: 's1' })
    );
    expect(ret.message).toBe('How did setup go?');
    expect(ret.costUsd).toBe(0.0007);
  });
});

describe('extractOptionLabels', () => {
  it('pulls a string array from `options`', () => {
    expect(extractOptionLabels({ options: ['easy', 'okay', 'difficult'] })).toEqual([
      'easy',
      'okay',
      'difficult',
    ]);
  });

  it('pulls `label` fields from an array of objects (scale)', () => {
    expect(
      extractOptionLabels({
        scale: [
          { label: 'Low', value: 1 },
          { label: 'High', value: 5 },
        ],
      })
    ).toEqual(['Low', 'High']);
  });

  it('returns undefined for missing / non-array / empty config', () => {
    expect(extractOptionLabels(null)).toBeUndefined();
    expect(extractOptionLabels({})).toBeUndefined();
    expect(extractOptionLabels({ options: [] })).toBeUndefined();
    expect(extractOptionLabels('nope')).toBeUndefined();
  });
});

describe('buildStreamingQuestionPrompt', () => {
  const text = (content: string | unknown[]): string => {
    if (typeof content !== 'string') throw new Error('expected string content');
    return content;
  };

  it('instructs to acknowledge the prior answer on a normal turn and includes the prompt + last message', () => {
    const messages = buildStreamingQuestionPrompt(INPUT);
    expect(messages).toHaveLength(2);
    const system = text(messages[0].content);
    expect(system).toMatch(/acknowledge what they just said/i);
    expect(system).toMatch(/no JSON/i);
    const user = text(messages[1].content);
    expect(user).toContain(PROMPT);
    expect(user).toContain('it was a nightmare');
  });

  it('renders the prior-answers block (background only) when priorAnswers is supplied', () => {
    const user = text(
      buildStreamingQuestionPrompt({
        ...INPUT,
        priorAnswers: ['Housing: rents a flat in Leeds', 'Budget: around £1200/month'],
      })[1].content
    );
    expect(user).toMatch(/already shared this session/i);
    expect(user).toContain('Housing: rents a flat in Leeds');
    expect(user).toContain('Budget: around £1200/month');
    // The guidance must mark it background-only so the interviewer doesn't recap or re-ask it.
    expect(user).toMatch(/do NOT recap/i);
    expect(user).toMatch(/do NOT re-ask/i);
  });

  it('omits the prior-answers block entirely when there are none', () => {
    const withNone = text(buildStreamingQuestionPrompt(INPUT)[1].content);
    expect(withNone).not.toMatch(/already shared this session/i);
    const withEmpty = text(buildStreamingQuestionPrompt({ ...INPUT, priorAnswers: [] })[1].content);
    expect(withEmpty).not.toMatch(/already shared this session/i);
  });

  it('renders the briefing block (for-you-only) when briefing is supplied', () => {
    const system = text(
      buildStreamingQuestionPrompt({
        ...INPUT,
        briefing: ['Revenue: £4m ARR last year', 'Headcount: 32 staff across 3 offices'],
      })[0].content
    );
    expect(system).toContain('<briefing>');
    expect(system).toContain('£4m ARR last year');
    expect(system).toContain('32 staff across 3 offices');
    // Must be framed as the interviewer's own briefing, never read out or attributed to the respondent.
    expect(system).toMatch(/do NOT read these out|for YOU only/i);
    expect(system).toMatch(/attribute them to the respondent/i);
  });

  it('omits the briefing block entirely when there is none', () => {
    expect(text(buildStreamingQuestionPrompt(INPUT)[0].content)).not.toContain('<briefing>');
    expect(text(buildStreamingQuestionPrompt({ ...INPUT, briefing: [] })[0].content)).not.toContain(
      '<briefing>'
    );
  });

  it('renders the peer_context block (anonymised, light-touch) when peerContext is supplied', () => {
    const system = text(
      buildStreamingQuestionPrompt({
        ...INPUT,
        peerContext: ['Several respondents mentioned workload pressure around month-end.'],
      })[0].content
    );
    expect(system).toContain('<peer_context>');
    expect(system).toContain('workload pressure around month-end');
    // Must enforce aggregate-only, non-leading, never-name-or-quote framing.
    expect(system).toMatch(/NEVER name or quote an individual/i);
    expect(system).toMatch(/never present\b.*\bas fact|expected answer/i);
  });

  it('omits the peer_context block entirely when there is none', () => {
    expect(text(buildStreamingQuestionPrompt(INPUT)[0].content)).not.toContain('<peer_context>');
    expect(
      text(buildStreamingQuestionPrompt({ ...INPUT, peerContext: [] })[0].content)
    ).not.toContain('<peer_context>');
  });

  it('switches to opening framing (no acknowledgement) when isOpening', () => {
    const system = text(buildStreamingQuestionPrompt({ ...INPUT, isOpening: true })[0].content);
    expect(system).toMatch(/first question/i);
    expect(system).not.toMatch(/acknowledge what they just said/i);
  });

  it('switches to re-ask framing when isReask', () => {
    const system = text(buildStreamingQuestionPrompt({ ...INPUT, isReask: true })[0].content);
    expect(system).toMatch(/could not capture a usable answer|re-ask/i);
  });

  it('names WHY it is circling back on a re-ask with a current understanding (deepening probe)', () => {
    const system = text(
      buildStreamingQuestionPrompt({
        ...INPUT,
        isReask: true,
        currentUnderstanding: 'They feel pay is the main issue',
      })[0].content
    );
    // The deepening probe should be explicit about why it's returning, grounded in what they said.
    expect(system).toMatch(/circling back/i);
    expect(system).toMatch(/They feel pay is the main issue/);
    expect(system).toMatch(/SHARPER, narrower follow-up/i);
  });

  it('keeps choices/scale OPEN on a first ask — infers rather than reciting (Phase 5)', () => {
    const messages = buildStreamingQuestionPrompt({
      ...INPUT,
      isReask: false,
      type: 'single_choice',
      typeConfig: {
        choices: [
          { value: 'a', label: 'Engineering' },
          { value: 'b', label: 'Sales' },
        ],
      },
    });
    const system = text(messages[0].content);
    const user = text(messages[1].content);
    // Standing rule: ask openly, infer from natural language, don't read out the option list.
    expect(system).toMatch(/do NOT read out the list of/i);
    expect(system).toMatch(/rating SCALE/i);
    // First ask does not enumerate the options.
    expect(user).not.toContain('Engineering, Sales');
  });

  it('offers the options explicitly only on a struggling re-ask (last resort)', () => {
    const user = text(
      buildStreamingQuestionPrompt({
        ...INPUT,
        isReask: true,
        type: 'single_choice',
        typeConfig: {
          choices: [
            { value: 'a', label: 'Engineering' },
            { value: 'b', label: 'Sales' },
          ],
        },
      })[1].content
    );
    expect(user).toMatch(/wasn't clear enough to map/i);
    expect(user).toContain('Engineering, Sales');
  });

  it('offers the numeric likert scale only on a re-ask, derived from min/max', () => {
    const first = text(
      buildStreamingQuestionPrompt({
        ...INPUT,
        isReask: false,
        type: 'likert',
        typeConfig: { min: 1, max: 5 },
      })[1].content
    );
    // No explicit numeric-scale offer on the first ask (the "Rating scale" type label is fine).
    expect(first).not.toContain('1–5 scale');
    expect(first).not.toMatch(/wasn't clear enough to map/i);
    const reask = text(
      buildStreamingQuestionPrompt({
        ...INPUT,
        isReask: true,
        type: 'likert',
        typeConfig: { min: 1, max: 5 },
      })[1].content
    );
    expect(reask).toMatch(/1–5 scale/);
  });

  it('calibrates tone to a novice audience and a non-English locale', () => {
    const system = text(
      buildStreamingQuestionPrompt({
        ...INPUT,
        audience: { expertiseLevel: 'novice', locale: 'fr' },
      })[0].content
    );
    expect(system).toMatch(/plain language/i);
    expect(system).toMatch(/locale "fr"/i);
  });

  it('does not force a language switch for an English locale', () => {
    const system = text(
      buildStreamingQuestionPrompt({ ...INPUT, audience: { locale: 'en-GB' } })[0].content
    );
    expect(system).not.toMatch(/Respond entirely/i);
  });

  it('always instructs to ask one thing at a time and not bundle sub-questions', () => {
    const system = text(buildStreamingQuestionPrompt(INPUT)[0].content);
    expect(system).toMatch(/ONE thing at a time/i);
    expect(system).toMatch(/do not bundle/i);
  });

  it('keeps early questions VERY tight (first few of the session)', () => {
    const system = text(buildStreamingQuestionPrompt({ ...INPUT, questionsAsked: 0 })[0].content);
    expect(system).toMatch(/very short and tight/i);
    expect(system).not.toMatch(/rapport has built/i);
  });

  it('relaxes length once rapport has built (later in the session)', () => {
    const system = text(buildStreamingQuestionPrompt({ ...INPUT, questionsAsked: 6 })[0].content);
    expect(system).toMatch(/concise/i);
    expect(system).toMatch(/rapport has built/i);
    expect(system).not.toMatch(/very short and tight/i);
  });

  it('prods for nuance on a normal deepen turn instead of bundling more questions', () => {
    const system = text(buildStreamingQuestionPrompt(INPUT)[0].content);
    expect(system).toMatch(/brief or surface-level/i);
    expect(system).toMatch(/one light follow-up/i);
  });

  it('does not add the nuance prod on an opening or transition turn', () => {
    const opening = text(buildStreamingQuestionPrompt({ ...INPUT, isOpening: true })[0].content);
    const transition = text(
      buildStreamingQuestionPrompt({ ...INPUT, isTransition: true })[0].content
    );
    expect(opening).not.toMatch(/brief or surface-level/i);
    expect(transition).not.toMatch(/brief or surface-level/i);
  });

  it('adds a tread-carefully block (with the latest note) when a sensitivity level is set', () => {
    const system = text(
      buildStreamingQuestionPrompt({
        ...INPUT,
        sensitivityLevel: 'high',
        sensitivityNotes: ['Reports mistreatment by a senior colleague.'],
      })[0].content
    );
    expect(system).toMatch(/sensitive or difficult/i);
    expect(system).toContain('Reports mistreatment by a senior colleague.');
  });

  it('omits the tread-carefully block when no sensitivity level is set', () => {
    const system = text(buildStreamingQuestionPrompt(INPUT)[0].content);
    expect(system).not.toMatch(/sensitive or difficult/i);
  });

  // ── Interviewer tone & persona (F-tone) ──
  const freshTone = (): ToneSettings => narrowToneSettings(DEFAULT_TONE_SETTINGS);

  it('keeps the default "match their tone" line and no tone clauses when no tone is configured', () => {
    const system = text(buildStreamingQuestionPrompt(INPUT)[0].content);
    expect(system).toMatch(/match the respondent/i);
    expect(system).not.toMatch(/adopt this persona/i);
  });

  it('drops the default "match their tone" line and injects the mimicry clause when mimicry is enabled', () => {
    const tone = freshTone();
    tone.mimicry = { enabled: true, level: 5 };
    const system = text(buildStreamingQuestionPrompt({ ...INPUT, tone })[0].content);
    expect(system).not.toMatch(/match the respondent/i);
    expect(system.toLowerCase()).toMatch(/adopt the respondent's own words/i);
  });

  it('keeps the default "match their tone" line when tone is configured but mimicry is off', () => {
    const tone = freshTone();
    tone.warmth = { enabled: true, level: 4 };
    const system = text(buildStreamingQuestionPrompt({ ...INPUT, tone })[0].content);
    expect(system).toMatch(/match the respondent/i);
    expect(system.toLowerCase()).toContain('encouraging');
  });

  it('leads the tone block with the persona clause when persona is enabled', () => {
    const tone = freshTone();
    tone.persona = { enabled: true, text: 'You are a supportive career coach' };
    const system = text(buildStreamingQuestionPrompt({ ...INPUT, tone })[0].content);
    expect(system).toMatch(/adopt this persona/i);
    expect(system).toContain('You are a supportive career coach.');
  });

  it('replaces the default concise-length line with the verbosity clause on a later turn', () => {
    const tone = freshTone();
    tone.verbosity = { enabled: true, level: 5 };
    const system = text(
      buildStreamingQuestionPrompt({ ...INPUT, questionsAsked: 6, tone })[0].content
    );
    expect(system).not.toMatch(/rapport has built/i);
    expect(system.toLowerCase()).toContain('expansive');
  });

  it('still keeps opening questions VERY tight even when verbosity is set high', () => {
    const tone = freshTone();
    tone.verbosity = { enabled: true, level: 5 };
    const system = text(
      buildStreamingQuestionPrompt({ ...INPUT, questionsAsked: 0, tone })[0].content
    );
    expect(system).toMatch(/very short and tight/i);
  });

  it('frames the system prompt with XML sections and surfaces a visible <tone> block when a dimension is on', () => {
    const tone = freshTone();
    tone.warmth = { enabled: true, level: 4 };
    const system = text(buildStreamingQuestionPrompt({ ...INPUT, tone })[0].content);
    // The prompt is now structured into XML-tagged sections (readability + LLM framing).
    expect(system).toContain('<role>');
    expect(system).toContain('<rules>');
    expect(system).toContain('<output_format>');
    // The admin-configured voice is injected inside an explicit <tone> section, so it's obvious
    // in the inspector that tone is actually being applied.
    expect(system).toMatch(/<tone>[\s\S]*encouraging[\s\S]*<\/tone>/i);
  });

  it('keeps a <tone> section with the default voice but no admin clauses when no tone is configured', () => {
    const system = text(buildStreamingQuestionPrompt(INPUT)[0].content);
    // The tone section holds the always-on voice baseline ("match their tone")…
    expect(system).toMatch(/<tone>[\s\S]*match the respondent[\s\S]*<\/tone>/i);
    // …but none of the admin-configured dimension/persona clauses.
    expect(system).not.toMatch(/adopt this persona/i);
    expect(system).not.toContain('encouraging');
  });
});
