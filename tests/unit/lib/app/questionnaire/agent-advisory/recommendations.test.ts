/**
 * Unit test: the curated agent-advisory recommendation table.
 *
 * Guards the invariants the evaluation engine and UI rely on: every covered
 * agent has a well-formed recommendation, slugs are unique, no agent carries a
 * per-agent model override (all inherit their task tier), and the task-tier
 * defaults are the agreed OpenAI ids.
 */

import { describe, it, expect } from 'vitest';

import {
  AGENT_RECOMMENDATIONS,
  AGENT_RECOMMENDATION_BY_SLUG,
  TASK_TIER_RECOMMENDATIONS,
  INFRA_DEFAULT_RECOMMENDATIONS,
  TURN_EVALUATOR_AGENT_SLUG,
} from '@/lib/app/questionnaire/agent-advisory/recommendations';

const TIERS = ['reasoning', 'chat', 'routing'] as const;
const EFFORTS = ['minimal', 'low', 'medium', 'high'] as const;

describe('AGENT_RECOMMENDATIONS', () => {
  it('covers the expected 14 questionnaire agents with unique slugs', () => {
    expect(AGENT_RECOMMENDATIONS).toHaveLength(14);
    const slugs = AGENT_RECOMMENDATIONS.map((r) => r.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('includes the turn-evaluator judge', () => {
    expect(AGENT_RECOMMENDATION_BY_SLUG.has(TURN_EVALUATOR_AGENT_SLUG)).toBe(true);
  });

  it('has well-formed values for every entry', () => {
    for (const rec of AGENT_RECOMMENDATIONS) {
      expect(TIERS).toContain(rec.taskTier);
      expect(rec.recommendedTemperature).toBeGreaterThanOrEqual(0);
      expect(rec.recommendedTemperature).toBeLessThanOrEqual(2);
      expect(rec.recommendedMaxTokens).toBeGreaterThan(0);
      if (rec.recommendedReasoningEffort !== null) {
        expect(EFFORTS).toContain(rec.recommendedReasoningEffort);
      }
      expect(rec.rationale.length).toBeGreaterThan(0);
      expect(rec.label.length).toBeGreaterThan(0);
    }
  });

  it('carries no per-agent model overrides — every agent inherits its task tier', () => {
    // Conversational agents must NOT be pinned to a reasoning nano: the gpt-5
    // family ignores temperature and shares its token cap with hidden reasoning,
    // which produced tone-deaf, contradiction-spamming chat (session QXDNENKN).
    const overridden = AGENT_RECOMMENDATIONS.filter((r) => r.overrideModel !== null);
    expect(overridden).toEqual([]);
  });

  it('chat-tier agents carry no reasoning effort (gpt-4o ignores it)', () => {
    const chatAgents = AGENT_RECOMMENDATIONS.filter((r) => r.taskTier === 'chat');
    expect(chatAgents.length).toBeGreaterThan(0);
    for (const rec of chatAgents) {
      expect(rec.recommendedReasoningEffort).toBeNull();
    }
  });

  it('the lookup map matches the array', () => {
    expect(AGENT_RECOMMENDATION_BY_SLUG.size).toBe(AGENT_RECOMMENDATIONS.length);
  });
});

describe('TASK_TIER_RECOMMENDATIONS', () => {
  it('maps each tier to the agreed OpenAI default', () => {
    expect(TASK_TIER_RECOMMENDATIONS.reasoning.recommendedModel).toBe('gpt-5.4');
    expect(TASK_TIER_RECOMMENDATIONS.chat.recommendedModel).toBe('gpt-4o');
    expect(TASK_TIER_RECOMMENDATIONS.routing.recommendedModel).toBe('gpt-4.1-nano');
  });
});

describe('INFRA_DEFAULT_RECOMMENDATIONS', () => {
  it('recommends the OpenAI embedding + transcribe defaults', () => {
    expect(INFRA_DEFAULT_RECOMMENDATIONS.embeddings.recommendedModel).toBe(
      'text-embedding-3-small'
    );
    expect(INFRA_DEFAULT_RECOMMENDATIONS.audio.recommendedModel).toBe('gpt-4o-transcribe');
  });
});
