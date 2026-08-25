/**
 * Turn-evaluator prompt-builder tests.
 *
 * The prompt is what makes the evaluation honest: the system rubric must carry the
 * only-calls-that-ran and judge-against-the-prompt rules, and the user message must serialize
 * the dump and weave in whatever context was supplied (degrading gracefully when it's absent).
 *
 * @see lib/app/questionnaire/turn-evaluation/prompt.ts
 */

import { describe, it, expect } from 'vitest';

import {
  buildTurnEvaluatorPrompt,
  TURN_RUBRIC_VERSION,
} from '@/lib/app/questionnaire/turn-evaluation/prompt';
import type { TurnEvaluationInput } from '@/lib/app/questionnaire/turn-evaluation/types';
import type { TurnInspectorData } from '@/lib/app/questionnaire/inspector';

const turn: TurnInspectorData = {
  turnIndex: 0,
  calls: [
    {
      label: 'Answer extraction',
      model: 'gpt-4o-mini',
      provider: 'openai',
      latencyMs: 400,
      costUsd: 0.001,
      prompt: [{ role: 'input', content: '{"userMessage":"I rent a flat"}' }],
      response: '{"intents":[{"slotKey":"housing"}]}',
    },
  ],
};

/** The first system message content. */
function systemOf(messages: ReturnType<typeof buildTurnEvaluatorPrompt>): string {
  const sys = messages.find((m) => m.role === 'system');
  return typeof sys?.content === 'string' ? sys.content : '';
}

function userOf(messages: ReturnType<typeof buildTurnEvaluatorPrompt>): string {
  const u = messages.find((m) => m.role === 'user');
  return typeof u?.content === 'string' ? u.content : '';
}

describe('buildTurnEvaluatorPrompt', () => {
  it('emits a system rubric and a user message', () => {
    const messages = buildTurnEvaluatorPrompt({ turn });
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
  });

  it('carries the load-bearing honesty rules in the system rubric', () => {
    const sys = systemOf(buildTurnEvaluatorPrompt({ turn }));
    // Only-calls-that-ran rule.
    expect(sys).toMatch(/only the calls actually present/i);
    expect(sys).toMatch(/never invent a stage/i);
    // Judge against the prompt, not outputs alone.
    expect(sys).toMatch(/compare each output against the prompt/i);
    // JSON-only output discipline.
    expect(sys).toMatch(/single JSON object/i);
  });

  it('serializes the turn dump into the user message', () => {
    const user = userOf(buildTurnEvaluatorPrompt({ turn }));
    expect(user).toContain('Answer extraction');
    expect(user).toContain('I rent a flat');
    expect(user).toContain('<turn_dump>');
  });

  it('weaves supplied context into the user message', () => {
    const input: TurnEvaluationInput = {
      turn,
      context: {
        goal: 'Understand housing security',
        audience: 'UK renters',
        selectionStrategy: 'adaptive',
        tone: 'warm, plain-spoken',
        respondentMessage: 'I rent a flat',
        interviewerMessage: 'And whereabouts is that?',
        recentMessages: ['Hi there', 'Tell me about your home'],
      },
    };
    const user = userOf(buildTurnEvaluatorPrompt(input));
    expect(user).toContain('Understand housing security');
    expect(user).toContain('UK renters');
    expect(user).toContain('adaptive');
    expect(user).toContain('warm, plain-spoken');
    expect(user).toContain('And whereabouts is that?');
    expect(user).toContain('Tell me about your home');
  });

  it('degrades gracefully when no context is supplied', () => {
    const user = userOf(buildTurnEvaluatorPrompt({ turn }));
    expect(user).toMatch(/no questionnaire context was supplied/i);
  });
});

/**
 * The interviewer-policy context. These four blocks plus the per-turn fidelity level exist so the
 * judge scores a turn against the behaviour the admin CONFIGURED rather than against a generic
 * ideal — without them a `must_ask` question, required to be put verbatim with its options
 * recited, reads to the rubric as closed and leading and is marked down for complying.
 */
describe('buildTurnEvaluatorPrompt — interviewer policy context', () => {
  it('tells the judge that configured policy is the standard, not a fault', () => {
    const sys = systemOf(buildTurnEvaluatorPrompt({ turn }));
    expect(sys).toMatch(/configured policy is the standard, not a fault/i);
    // The specific trap: a must-ask question must not lose openness points for being verbatim.
    expect(sys).toMatch(/must ask/i);
    expect(sys).toMatch(/openEndedness/);
    // Obeying a house rule is compliance, so it is never a violation.
    expect(sys).toMatch(/never a `?violations`? entry/i);
  });

  it('renders each policy block when supplied', () => {
    const user = userOf(
      buildTurnEvaluatorPrompt({
        turn,
        context: {
          houseRules: 'House rules: 2 x always, 1 x never',
          interviewerStrategy: 'Questioning approach: Funnel; Funnel pace: Narrow quickly',
          questionFidelity: 'Question fidelity: On - new questions start Balanced',
          conditionalTopics:
            'Conditional topics: Enabled; Conditional topics per interview: Up to 3',
          questionFidelityLevel: 'Must ask - Put it to them as written.',
        },
      })
    );
    expect(user).toContain('2 x always, 1 x never');
    expect(user).toContain('Funnel pace: Narrow quickly');
    expect(user).toContain('new questions start Balanced');
    expect(user).toContain('Conditional topics per interview: Up to 3');
    expect(user).toContain('Must ask - Put it to them as written.');
  });

  it('omits every policy field when nothing is configured, leaving the block unchanged', () => {
    // The off-is-silent invariant, at the context layer: a questionnaire that never enabled any of
    // these must produce exactly the context block it produced before the fields existed.
    const before = userOf(
      buildTurnEvaluatorPrompt({ turn, context: { goal: 'Understand housing security' } })
    );
    const after = userOf(
      buildTurnEvaluatorPrompt({
        turn,
        context: {
          goal: 'Understand housing security',
          houseRules: undefined,
          interviewerStrategy: undefined,
          questionFidelity: undefined,
          conditionalTopics: undefined,
          questionFidelityLevel: undefined,
        },
      })
    );
    expect(after).toBe(before);
    expect(after).not.toMatch(/house rules/i);
    expect(after).not.toMatch(/conditional topics/i);
  });

  it('drops a policy field that is present but blank', () => {
    const user = userOf(
      buildTurnEvaluatorPrompt({ turn, context: { goal: 'A goal', houseRules: '   ' } })
    );
    expect(user).not.toMatch(/house rules/i);
  });

  /**
   * The rubric version is stamped onto every persisted verdict and is what makes two scores
   * comparable. Editing the rubric without bumping it silently mixes incomparable verdicts under
   * one label, so the value is pinned here: a future rubric edit has to change this test
   * deliberately rather than drift past review.
   */
  it('pins the rubric version, so a rubric edit must bump it deliberately', () => {
    expect(TURN_RUBRIC_VERSION).toBe('1.1.0');
  });
});
