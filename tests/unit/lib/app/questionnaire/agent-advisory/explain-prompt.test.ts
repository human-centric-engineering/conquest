/**
 * Unit test: the "Explain with AI" prompt builder.
 *
 * Asserts the user message serialises the agent's current settings, the
 * recommendation, and the cost trade-off, surfaces the temperature-ignored
 * caveat, and that the system message states the OpenAI / gpt-5 temperature rule.
 */

import { describe, it, expect } from 'vitest';

import {
  buildExplainPrompt,
  buildExplainRetryMessage,
} from '@/lib/app/questionnaire/agent-advisory/explain-prompt';
import type { AgentSettingEvaluation } from '@/lib/app/questionnaire/agent-advisory/evaluate';
import type { LlmMessage } from '@/lib/orchestration/llm/types';

/** Narrow a message's string-or-parts content to text (our prompts are always strings). */
function text(msg: LlmMessage): string {
  return typeof msg.content === 'string' ? msg.content : '';
}

function buildAgent(overrides: Partial<AgentSettingEvaluation> = {}): AgentSettingEvaluation {
  return {
    slug: 'app-questionnaire-selector',
    agentId: 'a-1',
    label: 'Question Selector',
    role: 'Picks the next question',
    taskTier: 'chat',
    current: {
      explicitModel: null,
      resolvedModel: 'gpt-5.4-mini',
      temperature: 0.2,
      maxTokens: 256,
      reasoningEffort: null,
    },
    recommended: {
      model: 'gpt-5.4-nano',
      isOverride: true,
      temperature: 0.2,
      maxTokens: 256,
      reasoningEffort: 'minimal',
    },
    cost: {
      currentModelPerMillionUsd: 2.625,
      recommendedModelPerMillionUsd: 0.725,
      currentEstPerCallUsd: 0.0007,
      recommendedEstPerCallUsd: 0.0002,
      deltaPerCallUsd: -0.0005,
      deltaPct: -72,
    },
    actuals: { windowDays: 30, spendUsd: 1.5, calls: 40 },
    flags: { temperatureIgnored: true, pricingUnknown: false, modelUnresolved: false },
    isOptimal: false,
    rationale: 'Override to nano on the hot path.',
    ...overrides,
  };
}

describe('buildExplainPrompt', () => {
  it('produces a system + user message pair', () => {
    const msgs = buildExplainPrompt(buildAgent());
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('system');
    expect(msgs[1].role).toBe('user');
  });

  it('serialises the agent, recommendation and cost into the user message', () => {
    const user = text(buildExplainPrompt(buildAgent())[1]);
    expect(user).toContain('Question Selector');
    expect(user).toContain('app-questionnaire-selector');
    expect(user).toContain('CURRENT:');
    expect(user).toContain('DETERMINISTIC RECOMMENDATION:');
    expect(user).toContain('COST:');
    expect(user).toContain('gpt-5.4-mini'); // current
    expect(user).toContain('gpt-5.4-nano'); // recommended
    expect(user).toContain('-72%'); // delta
  });

  it('surfaces the temperature-ignored caveat when the resolved model ignores it', () => {
    const user = text(buildExplainPrompt(buildAgent())[1]);
    expect(user).toContain('IGNORED');
  });

  it('omits the caveat when temperature is honoured', () => {
    const agent = buildAgent({
      flags: { temperatureIgnored: false, pricingUnknown: false, modelUnresolved: false },
    });
    const user = text(buildExplainPrompt(agent)[1]);
    expect(user).not.toContain('IGNORED');
  });

  it('states the OpenAI / gpt-5 temperature rule in the system message', () => {
    const system = text(buildExplainPrompt(buildAgent())[0]);
    expect(system).toContain('OpenAI');
    expect(system.toLowerCase()).toContain('temperature');
  });

  it('renders unknown/n-a fallbacks for a pinned, unresolved, cost-unknown agent', () => {
    const user = text(
      buildExplainPrompt(
        buildAgent({
          current: {
            explicitModel: 'gpt-custom',
            resolvedModel: null,
            temperature: 0.2,
            maxTokens: 256,
            reasoningEffort: null,
          },
          cost: {
            currentModelPerMillionUsd: null,
            recommendedModelPerMillionUsd: null,
            currentEstPerCallUsd: null,
            recommendedEstPerCallUsd: null,
            deltaPerCallUsd: null,
            deltaPct: null,
          },
          actuals: { windowDays: 30, spendUsd: null, calls: null },
          flags: { temperatureIgnored: false, pricingUnknown: true, modelUnresolved: true },
        })
      )[1]
    );
    expect(user).toContain('unresolved (tier default unset)');
    expect(user).toContain('pinned override');
    expect(user).toContain('unknown'); // fmtUsd(null)
    expect(user).toContain('n/a'); // deltaPct null
  });

  it('formats zero and large cost figures', () => {
    const user = text(
      buildExplainPrompt(
        buildAgent({
          cost: {
            currentModelPerMillionUsd: 0,
            recommendedModelPerMillionUsd: 12.5,
            currentEstPerCallUsd: 0,
            recommendedEstPerCallUsd: 1.25,
            deltaPerCallUsd: 1.25,
            deltaPct: 100,
          },
        })
      )[1]
    );
    expect(user).toContain('$0');
    expect(user).toContain('$12.50');
  });

  it('labels a non-override recommendation as the tier default', () => {
    const user = text(
      buildExplainPrompt(
        buildAgent({
          recommended: {
            model: 'gpt-5.4',
            isOverride: false,
            temperature: 0.2,
            maxTokens: 256,
            reasoningEffort: 'low',
          },
        })
      )[1]
    );
    expect(user).toContain('(tier default)');
    expect(user).not.toContain('(per-agent override)');
  });

  it('offers a retry message naming the required JSON keys', () => {
    const msg = buildExplainRetryMessage();
    expect(msg).toMatch(/JSON/);
    expect(msg).toContain('narrative');
    expect(msg).toContain('suggestion');
  });
});
