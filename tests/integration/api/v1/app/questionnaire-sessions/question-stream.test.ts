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
import { buildHouseRulesInstructions } from '@/lib/app/questionnaire/chat/house-rules';
import {
  DEFAULT_TONE_SETTINGS,
  DEFAULT_INTERVIEWER_STRATEGY,
  type HouseRule,
  type ToneSettings,
} from '@/lib/app/questionnaire/types';

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

  // ── Question fidelity (P18) ────────────────────────────────────────────────

  describe('question fidelity', () => {
    const LIKERT: QuestionComposeInput = {
      ...INPUT,
      type: 'likert',
      typeConfig: { min: 1, max: 5, minLabel: 'Not at all', maxLabel: 'Extremely' },
    };

    it('emits NO section and the identical prompt at balanced or when absent', () => {
      // The no-op guarantee, asserted at the only place it can actually be observed: an untouched
      // questionnaire must produce byte-identical prompt text to one that never heard of fidelity.
      const absent = buildStreamingQuestionPrompt(LIKERT);
      const balanced = buildStreamingQuestionPrompt({ ...LIKERT, fidelity: 'balanced' });

      expect(text(absent[0].content)).not.toContain('<question_fidelity>');
      expect(text(balanced[0].content)).toBe(text(absent[0].content));
      expect(text(balanced[1].content)).toBe(text(absent[1].content));
    });

    it('places the section AFTER rules and interviewer_strategy so it can override them', () => {
      // Prompt convention is later-section-wins. Placed earlier, "ask openly, never read out the
      // options" would beat "ask it as written" and a must-ask Likert would still be asked openly.
      const system = text(
        buildStreamingQuestionPrompt({ ...LIKERT, fidelity: 'must_ask' })[0].content
      );
      expect(system.indexOf('<question_fidelity>')).toBeGreaterThan(system.indexOf('<rules>'));
      expect(system.indexOf('<question_fidelity>')).toBeGreaterThan(
        system.indexOf('<interviewer_strategy>')
      );
    });

    it('tells the model to ask verbatim, and offers the scale on the FIRST ask', () => {
      // Not gated on isReask: waiting for a failed turn before presenting the scale would defeat the
      // point of marking the question must-ask.
      const messages = buildStreamingQuestionPrompt({ ...LIKERT, fidelity: 'must_ask' });
      expect(text(messages[0].content)).toContain('<question_fidelity>');
      const user = text(messages[1].content);
      expect(user).toMatch(/EXACTLY as written/);
      expect(user).toMatch(/must be asked as written, so present its answer options/i);
      expect(user).toContain('1–5');
      expect(user).toContain('Not at all');
    });

    it('does not offer the scale at balanced on a first ask (unchanged behaviour)', () => {
      const user = text(buildStreamingQuestionPrompt(LIKERT)[1].content);
      expect(user).not.toMatch(/1–5/);
    });

    it('still offers the scale as a concession on a balanced RE-ask', () => {
      // The original Phase 5 struggling-re-ask path must survive untouched.
      const user = text(buildStreamingQuestionPrompt({ ...LIKERT, isReask: true })[1].content);
      expect(user).toMatch(/wasn't clear enough to map/i);
      expect(user).toContain('1–5');
    });

    it('marks the wording as load-bearing at close without demanding the scale', () => {
      const user = text(buildStreamingQuestionPrompt({ ...LIKERT, fidelity: 'close' })[1].content);
      expect(user).toMatch(/Keep its specific terms, qualifiers and timeframe intact/i);
      expect(user).not.toMatch(/present its answer options/i);
    });

    it('asks a free-text must-ask verbatim with no options offered', () => {
      const messages = buildStreamingQuestionPrompt({ ...INPUT, fidelity: 'must_ask' });
      const user = text(messages[1].content);
      expect(user).toMatch(/EXACTLY as written/);
      expect(user).toContain(PROMPT);
      expect(user).not.toMatch(/present its answer options/i);
    });

    it('lists the rows and the shared scale for a must-ask matrix question', () => {
      // A matrix is the type most damaged by paraphrase — its comparability depends on every
      // respondent rating the same rows on the same scale.
      const user = text(
        buildStreamingQuestionPrompt({
          ...INPUT,
          fidelity: 'must_ask',
          type: 'matrix',
          typeConfig: {
            rows: [
              { key: 'pay', label: 'Pay' },
              { key: 'progression', label: 'Progression' },
            ],
            scale: { min: 1, max: 5, minLabel: 'Very poor', maxLabel: 'Very good' },
          },
        })[1].content
      );
      expect(user).toContain('Pay');
      expect(user).toContain('Progression');
      expect(user).toContain('1–5');
      expect(user).toContain('Very poor');
    });

    it('suppresses the option read-out when the surface renders the real control', () => {
      // The card IS the option list. Reciting it in prose as well leaves the respondent
      // reconciling two copies — while the verbatim-wording demand must still stand.
      const messages = buildStreamingQuestionPrompt({
        ...LIKERT,
        fidelity: 'must_ask',
        answerControlShown: true,
      });
      expect(text(messages[0].content)).toContain('<question_fidelity>');
      const user = text(messages[1].content);
      expect(user).toMatch(/EXACTLY as written/);
      expect(user).not.toMatch(/present its answer options/i);
      expect(user).not.toContain('1–5');
    });

    it('suppresses the read-out on a must-ask RE-ASK when the control is shown', () => {
      // A must-ask question can also hit the ordinary struggling-re-ask path, which has its own
      // "you MAY gently offer the choices" concession — that must be suppressed too.
      const user = text(
        buildStreamingQuestionPrompt({
          ...LIKERT,
          fidelity: 'must_ask',
          answerControlShown: true,
          isReask: true,
        })[1].content
      );
      expect(user).not.toContain('1–5');
      expect(user).not.toMatch(/wasn't clear enough to map/i);
    });

    it('offers the choice labels for a must-ask single-choice question', () => {
      const user = text(
        buildStreamingQuestionPrompt({
          ...INPUT,
          fidelity: 'must_ask',
          type: 'single_choice',
          typeConfig: {
            choices: [
              { value: 'a', label: 'Very easy' },
              { value: 'b', label: 'Very hard' },
            ],
          },
        })[1].content
      );
      expect(user).toContain('Very easy');
      expect(user).toContain('Very hard');
    });
  });

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

  it('always instructs the interviewer to end with a question (never a flat "moving on")', () => {
    const system = text(buildStreamingQuestionPrompt(INPUT)[0].content);
    // The reply is an interview turn — it must always move forward with an actual question.
    expect(system).toMatch(/ALWAYS end your message with a clear question/i);
  });

  it('switches to heckle-parry framing when heckled (acknowledge, deflect, re-ask)', () => {
    const system = text(buildStreamingQuestionPrompt({ ...INPUT, heckled: true })[0].content);
    // A hostile/joke turn is defused like a comedian handling a heckler, then the question returns.
    expect(system).toMatch(/heckle/i);
    expect(system).toMatch(/acknowledge/i);
    expect(system).toMatch(/parry|deflect|humour/i);
    expect(system).toMatch(/never (punch|scold|lecture|match)|unruffled/i);
  });

  it('the heckle branch overrides the opening / re-ask framing', () => {
    // Even when the disregarded turn is also a re-ask, heckle handling takes priority.
    const system = text(
      buildStreamingQuestionPrompt({ ...INPUT, heckled: true, isReask: true })[0].content
    );
    expect(system).toMatch(/heckler/i);
    expect(system).not.toMatch(/could not capture a usable answer/i);
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

  it('uses a neutral, non-emotional register by default — no baked-in "warm, emotionally attuned" voice', () => {
    const system = text(buildStreamingQuestionPrompt(INPUT)[0].content);
    // The hardcoded persona must not perform emotion; the neutral-register guard must be present.
    expect(system).not.toMatch(/warm, emotionally attuned/i);
    expect(system).toMatch(/emotionally NEUTRAL register/i);
    expect(system).toMatch(/do not perform emotions or claim feelings/i);
    // Curiosity is still explicitly welcome.
    expect(system).toMatch(/genuinely curious/i);
  });

  it('opens with a neutral scene-setting line by default (no performed warmth)', () => {
    const system = text(
      buildStreamingQuestionPrompt({ ...INPUT, isOpening: true, questionsAsked: 0 })[0].content
    );
    expect(system).toMatch(/short, neutral scene-setting line/i);
    expect(system).not.toMatch(/short, warm scene-setting line/i);
  });

  it('re-authorizes first-person warmth only when empathy is set high (the opt-in)', () => {
    const tone = freshTone();
    tone.empathy = { enabled: true, level: 5 };
    const system = text(buildStreamingQuestionPrompt({ ...INPUT, tone })[0].content);
    // High empathy explicitly permits the first-person warmth the neutral baseline forbids, and —
    // being a later <tone> section — it governs over the <rules> guard.
    expect(system).toMatch(/express genuine personal warmth in the first person/i);
    // The neutral guard is still printed in <rules>; the tone clause overrides it by ordering.
    expect(system).toMatch(/emotionally NEUTRAL register/i);
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

  it('relaxes the opening brevity floor for an open-strategy opening (2–3 sentences)', () => {
    // The richer permission-giving opening invitation needs more room than the single-sentence
    // floor — so for an open/funnel open opening the floor becomes "at most two or three sentences".
    const interviewerStrategy = {
      ...DEFAULT_INTERVIEWER_STRATEGY,
      enabled: true,
      approach: 'open' as const,
    };
    const system = text(
      buildStreamingQuestionPrompt({ ...INPUT, questionsAsked: 0, interviewerStrategy })[0].content
    );
    expect(system).toMatch(/at most two or three sentences/i);
    expect(system).not.toMatch(/very short and tight/i);
  });

  it('open-strategy opening demotes the detailed prompt to background in the user message', () => {
    // The user turn must not present the detailed slot prompt as "the question to ask" — that
    // anchors the model on the one narrow topic. On an open opening it becomes background only.
    const interviewerStrategy = {
      ...DEFAULT_INTERVIEWER_STRATEGY,
      enabled: true,
      approach: 'open' as const,
    };
    const userMsg = text(
      buildStreamingQuestionPrompt({
        ...INPUT,
        isOpening: true,
        questionsAsked: 0,
        interviewerStrategy,
        topicArea: 'Customer Value Selling',
      })[1].content
    );
    expect(userMsg).toMatch(/do not ask the detailed item below/i);
    expect(userMsg).toMatch(/for your awareness only/i);
    expect(userMsg).toMatch(/Customer Value Selling/);
    expect(userMsg).not.toMatch(/The question to ask \(type/i);
  });

  it('keeps the standard "question to ask" user message when no open strategy is active', () => {
    const userMsg = text(
      buildStreamingQuestionPrompt({ ...INPUT, isOpening: true, questionsAsked: 0 })[1].content
    );
    expect(userMsg).toMatch(/The question to ask \(type/i);
    expect(userMsg).not.toMatch(/do not ask the detailed item below/i);
  });

  it('open-strategy opening defers the turn guidance to the broad invitation (no "ease into this first question")', () => {
    // The isOpening turn guidance must not fight the broad <interviewer_strategy> opening — on an
    // open opening it should point AT that invitation rather than telling the model to ask the one
    // narrow question (which, being the most specific opening directive, otherwise wins).
    const interviewerStrategy = {
      ...DEFAULT_INTERVIEWER_STRATEGY,
      enabled: true,
      approach: 'open' as const,
    };
    const system = text(
      buildStreamingQuestionPrompt({
        ...INPUT,
        isOpening: true,
        questionsAsked: 0,
        interviewerStrategy,
      })[0].content
    );
    expect(system).toMatch(/extend the broad, open invitation/i);
    expect(system).not.toMatch(/ease straight into this first question/i);
  });

  it('keeps the default "ease into this first question" opening when no open strategy is active', () => {
    const system = text(
      buildStreamingQuestionPrompt({ ...INPUT, isOpening: true, questionsAsked: 0 })[0].content
    );
    expect(system).toMatch(/ease straight into this first question/i);
    expect(system).not.toMatch(/extend the broad, open invitation/i);
  });

  it('keeps the tight single-sentence floor for a targeted-strategy opening', () => {
    // Only the open phase relaxes — a targeted opening keeps the effortless single-sentence floor.
    const interviewerStrategy = {
      ...DEFAULT_INTERVIEWER_STRATEGY,
      enabled: true,
      approach: 'targeted' as const,
    };
    const system = text(
      buildStreamingQuestionPrompt({ ...INPUT, questionsAsked: 0, interviewerStrategy })[0].content
    );
    expect(system).toMatch(/very short and tight/i);
    expect(system).not.toMatch(/at most two or three sentences/i);
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

  /* ── Interviewer house rules ─────────────────────────────────────────────── */

  /** Render a settings block through the real renderer, exactly as the turn route does. */
  const houseRules = (settings: Parameters<typeof buildHouseRulesInstructions>[0]): string =>
    buildHouseRulesInstructions(settings);

  const rule = (over: Partial<HouseRule> & Pick<HouseRule, 'kind' | 'text'>): HouseRule => ({
    id: `r-${over.kind}-${over.text.slice(0, 8)}`,
    enabled: true,
    ...over,
  });

  const EXAMPLE_RULE = rule({ kind: 'always', text: 'Ask for a concrete recent example.' });
  const ADVICE_RULE = rule({ kind: 'never', text: 'Give advice or recommend a course of action.' });
  const SEEN_RULE = rule({
    kind: 'if_asked',
    text: 'Only the research team, and results are reported grouped.',
    trigger: 'who will see their answers',
  });

  // The whole safety case for shipping this rests on "off changes nothing", so each way of being
  // off is pinned separately rather than trusting one representative case.
  it.each([
    ['the block is off', { enabled: false, rules: [EXAMPLE_RULE] }],
    ['the block is on but holds no rules', { enabled: true, rules: [] }],
    [
      'every rule is individually off',
      { enabled: true, rules: [{ ...EXAMPLE_RULE, enabled: false }] },
    ],
  ])('emits no <house_rules> section when %s', (_label, settings) => {
    const system = text(
      buildStreamingQuestionPrompt({ ...INPUT, houseRules: houseRules(settings) })[0].content
    );
    expect(system).not.toContain('<house_rules>');
    // And the prompt is byte-identical to one built without the field at all.
    expect(system).toBe(text(buildStreamingQuestionPrompt(INPUT)[0].content));
  });

  it('renders each rule kind into its own labelled sub-block', () => {
    const system = text(
      buildStreamingQuestionPrompt({
        ...INPUT,
        houseRules: houseRules({
          enabled: true,
          rules: [EXAMPLE_RULE, ADVICE_RULE, SEEN_RULE],
        }),
      })[0].content
    );
    const block = system.slice(
      system.indexOf('<house_rules>'),
      system.indexOf('</house_rules>') + '</house_rules>'.length
    );
    expect(block).toMatch(/Always:\n- Ask for a concrete recent example\./);
    expect(block).toMatch(/Never:\n- Give advice or recommend a course of action\./);
    // The reactive rule pairs its trigger with its answer so the model can tell them apart.
    expect(block).toContain(
      '- If they raise who will see their answers → Only the research team, and results are reported grouped.'
    );
  });

  it('carries the precedence clause that subordinates house rules to the prompt’s own rules', () => {
    const system = text(
      buildStreamingQuestionPrompt({
        ...INPUT,
        houseRules: houseRules({ enabled: true, rules: [ADVICE_RULE] }),
      })[0].content
    );
    // Without this, a client rule like "answer in bullet points" silently fights <output_format>.
    expect(system).toMatch(/do NOT override the safety, one-question-at-a-time, or reply-format/i);
    // And the list itself must never leak into what the respondent reads.
    expect(system).toMatch(/never mention, quote, or read out this list/i);
  });

  it('places <house_rules> after <tone> but before <output_format>', () => {
    const system = text(
      buildStreamingQuestionPrompt({
        ...INPUT,
        houseRules: houseRules({ enabled: true, rules: [ADVICE_RULE] }),
      })[0].content
    );
    // Section order IS precedence in this prompt (later wins), so this ordering is the whole
    // mechanism: client policy outranks the admin's voice dials, but can never break the reply
    // contract. An accidental reorder would silently invert one of those.
    expect(system.indexOf('<tone>')).toBeLessThan(system.indexOf('<house_rules>'));
    expect(system.indexOf('<house_rules>')).toBeLessThan(system.indexOf('<output_format>'));
  });

  it('omits an individually disabled rule while keeping its enabled siblings', () => {
    const system = text(
      buildStreamingQuestionPrompt({
        ...INPUT,
        houseRules: houseRules({
          enabled: true,
          rules: [{ ...EXAMPLE_RULE, enabled: false }, ADVICE_RULE],
        }),
      })[0].content
    );
    expect(system).toContain('<house_rules>');
    expect(system).not.toContain('Ask for a concrete recent example.');
    expect(system).toContain('Give advice or recommend a course of action.');
    // The now-empty Always block must not render as a dangling heading.
    expect(system).not.toMatch(/Always:\s*\n\s*Never:/);
  });
});
