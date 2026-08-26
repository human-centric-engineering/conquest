/**
 * The Routing Analyst's structured-output contract (P17.4).
 *
 * This schema is the only thing standing between a model's free-form answer and a proposal an
 * admin will accept as authoritative, so the tests pin the refusals rather than the happy path:
 * duplicate keys, a conditional topic with nothing to judge it on, and an invented topic key
 * format. Each of those, accepted, produces a review queue the admin has to finish themselves.
 */

import { describe, it, expect } from 'vitest';

import { TOPIC_KEY_MAX_LENGTH } from '@/lib/app/questionnaire/scope/types';

import {
  ROUTING_ANALYSIS_MAX_GAPS,
  ROUTING_ANALYSIS_MAX_SETTING_KEYS,
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
    expect(result.value.gaps).toEqual([]);
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

  it('accepts a well-formed gap', () => {
    const result = validateRoutingAnalysis(
      proposal({
        gaps: [
          {
            sourceQuote: 'Use judgement for respondents outside these categories.',
            explanation: 'Too vague to test mechanically — no data slot captures "judgement".',
          },
        ],
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.gaps).toHaveLength(1);
  });

  it('refuses a gap with no source quote — a gap must be traceable to the document', () => {
    const result = validateRoutingAnalysis(
      proposal({ gaps: [{ sourceQuote: '', explanation: 'Something vague.' }] })
    );
    expect(result.ok).toBe(false);
  });

  it('refuses a gap with no explanation', () => {
    const result = validateRoutingAnalysis(
      proposal({ gaps: [{ sourceQuote: 'Some clause.', explanation: '' }] })
    );
    expect(result.ok).toBe(false);
  });

  it('caps the number of reported gaps', () => {
    const many = Array.from({ length: ROUTING_ANALYSIS_MAX_GAPS + 1 }, (_, i) => ({
      sourceQuote: `Clause ${i}.`,
      explanation: 'x',
    }));
    expect(validateRoutingAnalysis(proposal({ gaps: many })).ok).toBe(false);
  });
});

describe('validateRoutingAnalysis — the two settings the analyst may now propose (F17.23)', () => {
  it('accepts both lists', () => {
    const result = validateRoutingAnalysis(
      proposal({
        fallbackTopicKeys: ['growth_ambition'],
        checkTopicPreference: ['growth_ambition'],
      })
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fallbackTopicKeys).toEqual(['growth_ambition']);
    expect(result.value.checkTopicPreference).toEqual(['growth_ambition']);
  });

  it('leaves both undefined when the document said nothing about either', () => {
    const result = validateRoutingAnalysis(proposal());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Undefined, NOT an empty array — omitted means "the author was silent", and a default here
    // would sit where that silence was. Same discipline as maxConditionalTopics.
    expect(result.value.fallbackTopicKeys).toBeUndefined();
    expect(result.value.checkTopicPreference).toBeUndefined();
  });

  it('refuses more keys than a settings hint should carry', () => {
    const tooMany = Array.from(
      { length: ROUTING_ANALYSIS_MAX_SETTING_KEYS + 1 },
      (_, i) => `t${i}`
    );
    expect(validateRoutingAnalysis(proposal({ fallbackTopicKeys: tooMany })).ok).toBe(false);
  });

  it('does NOT refuse a key that names no proposed topic — that is dropped on the way out', () => {
    // Membership is enforced in narrowProposedTopicSet, deliberately: an unknown key is inert at
    // runtime, so refusing the whole response over one would throw away a good proposal and pay
    // for a retry to fix a hint.
    expect(validateRoutingAnalysis(proposal({ fallbackTopicKeys: ['not_a_topic'] })).ok).toBe(true);
  });

  /**
   * T13, found by corpus doc 08 — the only routing analysis of forty to fail outright.
   *
   * `questionKeys` are REFERENCES to keys the extractor minted, and the extractor bounds them at
   * nothing. Validating them against the *topic* key bound (64) rejected an analysis that had
   * faithfully echoed back two real question keys of 70 and 78 characters, and no retry could fix
   * it: satisfying the bound means shortening a key, and a shortened key matches no question. The
   * failure is durable — a failed routing_analysis is the "already tried" signal the Topics tab
   * reads — so the admin got no routing and no reason.
   */
  const LONG_QUESTION_KEY =
    'is_there_anything_about_your_circumstances_that_makes_dealing_with_this_harder';

  it('accepts a questionKey longer than a topic key may be — it is a reference, not a slug', () => {
    expect(LONG_QUESTION_KEY.length).toBeGreaterThan(TOPIC_KEY_MAX_LENGTH);
    const result = validateRoutingAnalysis(
      proposal({
        topics: [
          {
            key: 'vulnerability',
            label: 'Vulnerability',
            phase: 'closing',
            criteria: null,
            depth: 'full',
            questionKeys: [LONG_QUESTION_KEY],
            dataSlotKeys: [LONG_QUESTION_KEY],
            rationale: 'Every client, at the end, without exception.',
          },
        ],
      })
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Preserved whole. A truncated key does not resolve, which orphans the question, and an
    // orphaned question can never be asked.
    expect(result.value.topics[0]?.questionKeys).toEqual([LONG_QUESTION_KEY]);
  });

  it('still holds the TOPIC key to the shorter bound — that one the analyst mints', () => {
    const result = validateRoutingAnalysis(
      proposal({
        topics: [
          {
            key: 'k'.repeat(TOPIC_KEY_MAX_LENGTH + 1),
            label: 'Too long',
            phase: 'core',
            criteria: null,
            depth: 'full',
            questionKeys: [],
            dataSlotKeys: [],
            rationale: 'r',
          },
        ],
      })
    );
    expect(result.ok).toBe(false);
  });
});

// ── Mid-interview triggers (F17.31a) ─────────────────────────────────────────

describe('validateRoutingAnalysis — the trigger a document asks for but the opening cannot decide', () => {
  const triggeredTopic = {
    key: 'domestic_abuse',
    label: 'Domestic abuse',
    phase: 'conditional',
    criteria: 'The opening indicates the applicant is fleeing abuse.',
    depth: 'full',
    questionKeys: ['q_abuse'],
    dataSlotKeys: [],
    rationale: 'The document adds this block on disclosure.',
    trigger: {
      condition: 'The applicant discloses that they are fleeing abuse',
      cues: ['abuse', 'fleeing'],
      sourceQuote: 'If the applicant discloses, at any stage, that they are fleeing abuse',
    },
  };

  it('accepts a trigger alongside the criteria, not instead of it', () => {
    // Both, deliberately. The criteria is what the product runs; the trigger is what was asked for.
    // A topic that carried only the trigger would be selected by nothing and asked of nobody.
    const result = validateRoutingAnalysis(proposal({ topics: [triggeredTopic] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.topics[0]?.trigger?.condition).toBe(
      'The applicant discloses that they are fleeing abuse'
    );
    expect(result.value.topics[0]?.criteria).toBe(
      'The opening indicates the applicant is fleeing abuse.'
    );
  });

  it('still requires criteria on a conditional topic that carries a trigger', () => {
    // The trigger is inert, so a triggered topic with no criteria has nothing deciding it at all.
    const result = validateRoutingAnalysis(
      proposal({ topics: [{ ...triggeredTopic, criteria: null }] })
    );
    expect(result.ok).toBe(false);
  });

  it('defaults an omitted cue list rather than failing the whole analysis', () => {
    // T13 in the routing corpus: one over-strict bound on an analyst field cost a whole document
    // its proposal, with no retry that could fix it. An empty cue list is reported by
    // validateConditionalTopics instead, where it costs nothing.
    const result = validateRoutingAnalysis(
      proposal({
        topics: [{ ...triggeredTopic, trigger: { condition: 'They mention arrears' } }],
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.topics[0]?.trigger?.cues).toEqual([]);
  });

  it('refuses a trigger with no condition — cues with nothing to confirm record nothing', () => {
    const result = validateRoutingAnalysis(
      proposal({ topics: [{ ...triggeredTopic, trigger: { cues: ['abuse'] } }] })
    );
    expect(result.ok).toBe(false);
  });

  it('leaves the field absent on an ordinary topic', () => {
    const result = validateRoutingAnalysis(proposal());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.topics[0]?.trigger).toBeUndefined();
  });

  it('drops an over-long cue instead of failing the whole document', () => {
    // A rejecting bound here is the T13 mistake wearing a different hat. An over-long cue is the
    // DOCUMENTED failure mode — TRIGGER_CUE_MAX_LENGTH exists because "a long cue is a sign the
    // analyst quoted the rule instead of naming what to listen for" — and the retry message never
    // mentions cues, so the single retry is blind. Rejecting would lose every topic, rule and gap
    // for the document over a field nothing reads yet.
    const quotedRule =
      'the respondent discloses that they are fleeing domestic abuse from someone they live with';
    expect(quotedRule.length).toBeGreaterThan(80);

    const result = validateRoutingAnalysis(
      proposal({
        topics: [
          {
            ...triggeredTopic,
            trigger: { ...triggeredTopic.trigger, cues: [quotedRule, 'he hits me'] },
          },
        ],
      })
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The usable cue survives; the quoted rule is gone. The topic itself is untouched.
    expect(result.value.topics[0]?.trigger?.cues).toEqual(['he hits me']);
    expect(result.value.topics[0]?.key).toBe('domestic_abuse');
  });

  it('caps an over-long cue list instead of failing the whole document', () => {
    // Same reasoning as the length bound: `narrowTopicTrigger` slices to MAX_TRIGGER_CUES on the
    // read path, so refusing here would be the one place in the chain that turns "too many" into
    // "nothing at all".
    const cues = Array.from({ length: 20 }, (_, i) => `cue ${i}`);

    const result = validateRoutingAnalysis(
      proposal({ topics: [{ ...triggeredTopic, trigger: { ...triggeredTopic.trigger, cues } }] })
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.topics[0]?.trigger?.cues).toHaveLength(12);
    expect(result.value.topics[0]?.trigger?.cues[0]).toBe('cue 0');
  });
});
