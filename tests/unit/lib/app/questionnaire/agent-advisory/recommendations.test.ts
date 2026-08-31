/**
 * Unit test: the curated agent-advisory recommendation table.
 *
 * Guards the invariants the evaluation engine and UI rely on: every agent the
 * app declares is covered (including all three judge panels), every entry is
 * well-formed, slugs are unique, per-agent model pins stay the rare exception,
 * and the task-tier defaults are the agreed OpenAI ids.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

import {
  AGENT_RECOMMENDATIONS,
  AGENT_RECOMMENDATION_BY_SLUG,
  TASK_TIER_RECOMMENDATIONS,
  INFRA_DEFAULT_RECOMMENDATIONS,
  TURN_EVALUATOR_AGENT_SLUG,
} from '@/lib/app/questionnaire/agent-advisory/recommendations';
import { AGENT_SETTINGS_ADVISOR_SLUG } from '@/lib/app/questionnaire/agent-advisory/explain-schema';
import { EVALUATION_DIMENSION_SPECS } from '@/lib/app/questionnaire/evaluation/dimensions';
import { SCOPE_EVALUATION_DIMENSION_SPECS } from '@/lib/app/questionnaire/scope-evaluation/dimensions';
import { POLICY_EVALUATION_DIMENSION_SPECS } from '@/lib/app/questionnaire/policy-evaluation/dimensions';

const TIERS = ['reasoning', 'chat', 'routing'] as const;
const EFFORTS = ['minimal', 'low', 'medium', 'high'] as const;

describe('AGENT_RECOMMENDATIONS', () => {
  it('has unique slugs', () => {
    const slugs = AGENT_RECOMMENDATIONS.map((r) => r.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  /**
   * Drift guard. The advisor is only useful if it covers every agent the app
   * actually runs, so this parses the app's own slug constants rather than
   * trusting a hand-kept count: add an agent to `constants.ts` (or a sibling
   * constants module) and this fails until it has a recommendation.
   */
  it('covers every agent slug the app declares', () => {
    const sources = [
      'lib/app/questionnaire/constants.ts',
      'lib/app/questionnaire/experiences/constants.ts',
      'lib/app/questionnaire/scope/constants.ts',
    ];
    const declared = new Set<string>();
    for (const file of sources) {
      const src = readFileSync(resolve(process.cwd(), file), 'utf8');
      for (const match of src.matchAll(
        /export const [A-Z0-9_]*AGENT_SLUG\s*(?::[^=]*)?=\s*\n?\s*'([^']+)'/g
      )) {
        declared.add(match[1]);
      }
    }
    expect(declared.size).toBeGreaterThan(30);

    const uncovered = [...declared].filter((slug) => !AGENT_RECOMMENDATION_BY_SLUG.has(slug));
    expect(uncovered).toEqual([]);
    expect(AGENT_RECOMMENDATION_BY_SLUG.has(AGENT_SETTINGS_ADVISOR_SLUG)).toBe(true);
  });

  it('covers every judge in the three design-time panels', () => {
    for (const specs of [
      EVALUATION_DIMENSION_SPECS,
      SCOPE_EVALUATION_DIMENSION_SPECS,
      POLICY_EVALUATION_DIMENSION_SPECS,
    ]) {
      for (const spec of Object.values(specs)) {
        const rec = AGENT_RECOMMENDATION_BY_SLUG.get(spec.slug);
        expect(rec, `${spec.slug} has no recommendation`).toBeDefined();
        expect(rec?.panel).not.toBeNull();
      }
    }
  });

  it('includes the turn-evaluator judge', () => {
    expect(AGENT_RECOMMENDATION_BY_SLUG.has(TURN_EVALUATOR_AGENT_SLUG)).toBe(true);
  });

  it('includes the report research agent (web-search rounds)', () => {
    expect(AGENT_RECOMMENDATION_BY_SLUG.has('app-report-researcher')).toBe(true);
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

  it('pins a per-agent model only where the job differs from the rest of its tier', () => {
    // Inheritance is the default so a tier move carries every agent with it. The
    // candidacy check is the one deliberate exception (see its rationale) — any
    // new pin should be a considered decision, not a drift.
    const overridden = AGENT_RECOMMENDATIONS.filter((r) => r.overrideModel !== null);
    expect(overridden.map((r) => r.slug)).toEqual(['app-questionnaire-scope-candidacy']);
  });

  it('chat-tier agents carry no reasoning effort', () => {
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
