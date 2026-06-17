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

import { buildTurnEvaluatorPrompt } from '@/lib/app/questionnaire/turn-evaluation/prompt';
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
