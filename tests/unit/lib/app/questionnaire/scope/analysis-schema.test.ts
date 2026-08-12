/**
 * The Routing Analyst's structured-output contract (P17.4).
 *
 * This schema is the only thing standing between a model's free-form answer and a proposal an
 * admin will accept as authoritative, so the tests pin the refusals rather than the happy path:
 * duplicate keys, a conditional topic with nothing to judge it on, and an invented topic key
 * format. Each of those, accepted, produces a review queue the admin has to finish themselves.
 */

import { describe, it, expect } from 'vitest';

import {
  ROUTING_ANALYSIS_MAX_TOPICS,
  validateRoutingAnalysis,
} from '@/lib/app/questionnaire/scope/analysis-schema';

/** A minimal valid proposal. */
function proposal(overrides: Record<string, unknown> = {}) {
  return {
    topics: [
      {
        key: 'growth_ambition',
        label: 'Growth ambition',
        phase: 'opening',
        criteria: null,
        depth: 'full',
        questionKeys: ['q_growth'],
        dataSlotKeys: [],
        rationale: 'The document opens by asking what they want to change.',
        sourceQuote: 'Start every session with the ambition question.',
      },
    ],
    rules: [],
    summary: 'Read from the routing tab.',
    fromDocument: true,
    ...overrides,
  };
}

describe('validateRoutingAnalysis', () => {
  it('accepts a grounded proposal and defaults the optional arrays', () => {
    const result = validateRoutingAnalysis({
      topics: [
        {
          key: 'pipeline',
          label: 'Pipeline',
          phase: 'core',
          rationale: 'Every respondent answers this.',
        },
      ],
      summary: 'Inferred from headings.',
      fromDocument: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rules).toEqual([]);
    expect(result.value.topics[0]?.questionKeys).toEqual([]);
    expect(result.value.topics[0]?.criteria).toBeNull();
    expect(result.value.topics[0]?.depth).toBe('full');
  });

  it('refuses a conditional topic with no criteria', () => {
    // The planner would have nothing to judge it on and the admin nothing to correct — so this is
    // refused at the contract rather than landing in the queue as unfinished work.
    const result = validateRoutingAnalysis(
      proposal({
        topics: [
          {
            key: 'channel_conflict',
            label: 'Channel conflict',
            phase: 'conditional',
            criteria: null,
            rationale: 'Only relevant to partner-led businesses.',
          },
        ],
      })
    );
    expect(result.ok).toBe(false);
  });

  it('accepts a conditional topic that carries criteria', () => {
    const result = validateRoutingAnalysis(
      proposal({
        topics: [
          {
            key: 'channel_conflict',
            label: 'Channel conflict',
            phase: 'conditional',
            criteria: 'They sell through partners or resellers.',
            rationale: 'The guardrails tab restricts this to partner-led businesses.',
          },
        ],
      })
    );
    expect(result.ok).toBe(true);
  });

  it('refuses two topics sharing a key', () => {
    // Keys are how plans, rules and the blind-spot preference address a topic; two rows sharing one
    // means every reference is ambiguous.
    const result = validateRoutingAnalysis(
      proposal({
        topics: [
          { key: 'same', label: 'One', phase: 'core', rationale: 'a' },
          { key: 'same', label: 'Two', phase: 'core', rationale: 'b' },
        ],
      })
    );
    expect(result.ok).toBe(false);
  });

  it('refuses a key that is not a lowercase slug', () => {
    const result = validateRoutingAnalysis(
      proposal({
        topics: [{ key: 'Growth Ambition', label: 'X', phase: 'core', rationale: 'a' }],
      })
    );
    expect(result.ok).toBe(false);
  });

  it('refuses a topic with no rationale', () => {
    // The rationale is the admin's main review signal — a proposal without one is a bare assertion.
    const result = validateRoutingAnalysis(
      proposal({ topics: [{ key: 'x', label: 'X', phase: 'core' }] })
    );
    expect(result.ok).toBe(false);
  });

  it('caps the number of proposed topics', () => {
    const many = Array.from({ length: ROUTING_ANALYSIS_MAX_TOPICS + 1 }, (_, i) => ({
      key: `topic_${i}`,
      label: `Topic ${i}`,
      phase: 'core',
      rationale: 'x',
    }));
    expect(validateRoutingAnalysis(proposal({ topics: many })).ok).toBe(false);
  });

  it('refuses a breadth limit outside the settable range', () => {
    // The field exists to carry a number the DOCUMENT stated; one the settings surface could never
    // hold would be silently clamped later, which reads to an admin as the analyst being ignored.
    expect(validateRoutingAnalysis(proposal({ maxConditionalTopics: 0 })).ok).toBe(false);
    expect(validateRoutingAnalysis(proposal({ maxConditionalTopics: 999 })).ok).toBe(false);
    expect(validateRoutingAnalysis(proposal({ maxConditionalTopics: 3 })).ok).toBe(true);
  });

  it('requires fromDocument to be stated explicitly', () => {
    // "I read your rules" and "I guessed from your headings" are different claims, and a default
    // would let the weaker one pass as the stronger.
    const { fromDocument, ...withoutClaim } = proposal();
    void fromDocument;
    expect(validateRoutingAnalysis(withoutClaim).ok).toBe(false);
  });

  it('validates proposed rules against the operator and action vocabularies', () => {
    expect(
      validateRoutingAnalysis(
        proposal({
          rules: [
            {
              dataSlotKey: 'headcount',
              operator: 'gt',
              value: '50',
              action: 'include',
              topicKey: 'growth_ambition',
              rationale: 'The document says pricing applies over 50 staff.',
            },
          ],
        })
      ).ok
    ).toBe(true);

    expect(
      validateRoutingAnalysis(
        proposal({
          rules: [
            {
              dataSlotKey: 'headcount',
              operator: 'matches_regex',
              value: '50',
              action: 'include',
              topicKey: 'growth_ambition',
              rationale: 'x',
            },
          ],
        })
      ).ok
    ).toBe(false);
  });
});
