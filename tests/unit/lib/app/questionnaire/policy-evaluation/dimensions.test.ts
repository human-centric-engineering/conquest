/**
 * The dimension registry and the op describer.
 *
 * @see lib/app/questionnaire/policy-evaluation/dimensions.ts
 */

import { describe, it, expect } from 'vitest';

import {
  POLICY_EVALUATION_DIMENSIONS,
  POLICY_EVALUATION_DIMENSION_SPECS,
  POLICY_EVALUATION_JUDGE_SLUGS,
  policyDimensionForSlug,
  POLICY_PROPOSED_EDIT_OPS,
  describePolicyProposedEdit,
  type PolicyProposedEdit,
} from '@/lib/app/questionnaire/policy-evaluation';

describe('the dimension registry', () => {
  it('has a spec for every dimension, with a distinct slug', () => {
    const slugs = POLICY_EVALUATION_DIMENSIONS.map(
      (d) => POLICY_EVALUATION_DIMENSION_SPECS[d].slug
    );
    expect(slugs).toHaveLength(POLICY_EVALUATION_DIMENSIONS.length);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('namespaces its slugs apart from the other two panels', () => {
    // Three panels seed judge agents into one table; a shared slug would have one silently
    // overwrite another on seed.
    for (const slug of POLICY_EVALUATION_JUDGE_SLUGS) {
      expect(slug.startsWith('app-questionnaire-policy-judge-')).toBe(true);
    }
  });

  it('round-trips slug → dimension', () => {
    for (const dimension of POLICY_EVALUATION_DIMENSIONS) {
      expect(policyDimensionForSlug(POLICY_EVALUATION_DIMENSION_SPECS[dimension].slug)).toBe(
        dimension
      );
    }
    expect(
      policyDimensionForSlug('app-questionnaire-scope-judge-criteria-quality')
    ).toBeUndefined();
  });
});

describe('describePolicyProposedEdit', () => {
  const EDITS: PolicyProposedEdit[] = [
    { op: 'edit_house_rule', kind: 'never', text: 'x' },
    { op: 'set_house_rule_enabled', enabled: false },
    { op: 'delete_house_rule' },
    { op: 'add_house_rule', kind: 'always', text: 'x' },
    { op: 'set_approach', approach: 'funnel' },
    { op: 'set_pace', pace: 'brisk' },
    { op: 'set_opening_mode', openingMode: 'examples' },
    { op: 'set_tactics', reflect: true },
    { op: 'set_fidelity_enabled', enabled: true },
    { op: 'set_default_fidelity', defaultFidelity: 0.75 },
    { op: 'set_question_fidelity', fidelity: 1 },
    { op: 'set_tone_dimension', dimension: 'humour', enabled: false },
  ];

  it('describes every op in the union', () => {
    // The switch is exhaustive by type, but a missing case would return undefined at runtime — this
    // catches that, and pins that no op is left without a sentence a reviewer can read.
    expect(EDITS).toHaveLength(POLICY_PROPOSED_EDIT_OPS.length);
    for (const edit of EDITS) {
      const sentence = describePolicyProposedEdit(edit);
      expect(typeof sentence).toBe('string');
      expect(sentence.length).toBeGreaterThan(0);
    }
  });

  it('speaks plainly, without implementation vocabulary', () => {
    expect(describePolicyProposedEdit({ op: 'set_question_fidelity', fidelity: 1 })).toBe(
      'Set this question to Must ask'
    );
    expect(describePolicyProposedEdit({ op: 'set_pace', pace: 'brisk' })).toContain(
      'Narrow quickly'
    );
  });

  it('names the direction of a boolean, never just the field', () => {
    expect(describePolicyProposedEdit({ op: 'set_house_rule_enabled', enabled: false })).toContain(
      'off'
    );
    expect(describePolicyProposedEdit({ op: 'set_house_rule_enabled', enabled: true })).toContain(
      'on'
    );
  });
});

describe('describePolicyProposedEdit — the branches that vary per op', () => {
  it('names each tactic being changed, and its direction', () => {
    expect(
      describePolicyProposedEdit({
        op: 'set_tactics',
        probeDepth: false,
        reflect: true,
        batchRelated: false,
      })
    ).toBe(
      'Change tactics: turn off probing shallow answers, turn on reflecting answers back, turn off inviting related gaps together'
    );
  });

  it('falls back to a generic sentence when a tactics op names nothing', () => {
    // The schema rejects this shape, but the describer is also fed `editedOverride` blobs and must
    // never return an empty string to the review card.
    expect(describePolicyProposedEdit({ op: 'set_tactics' })).toBe('Change the tactics');
  });

  it('distinguishes the two opening sources', () => {
    expect(describePolicyProposedEdit({ op: 'set_opening_mode', openingMode: 'examples' })).toBe(
      'Use your example openings'
    );
    expect(describePolicyProposedEdit({ op: 'set_opening_mode', openingMode: 'auto' })).toBe(
      'Let the interviewer choose its own opening'
    );
  });

  it('mentions a tone level only when one is given', () => {
    expect(
      describePolicyProposedEdit({
        op: 'set_tone_dimension',
        dimension: 'humour',
        enabled: true,
        level: 2,
      })
    ).toContain('to level 2');
    expect(
      describePolicyProposedEdit({ op: 'set_tone_dimension', dimension: 'humour', enabled: true })
    ).not.toContain('level');
  });

  it('names the rule kind on both rule-authoring ops', () => {
    expect(
      describePolicyProposedEdit({
        op: 'edit_house_rule',
        kind: 'if_asked',
        text: 'x',
        trigger: 't',
      })
    ).toContain('say if asked');
    expect(
      describePolicyProposedEdit({ op: 'add_house_rule', kind: 'never', text: 'x' })
    ).toContain('never do');
  });

  it('names each fidelity stop by its label, not its number', () => {
    expect(
      describePolicyProposedEdit({ op: 'set_default_fidelity', defaultFidelity: 0 })
    ).toContain('Free');
    expect(describePolicyProposedEdit({ op: 'set_question_fidelity', fidelity: 0.25 })).toContain(
      'Loose'
    );
  });

  it('names the direction of the fidelity gate', () => {
    expect(describePolicyProposedEdit({ op: 'set_fidelity_enabled', enabled: true })).toContain(
      'Switch on'
    );
    expect(describePolicyProposedEdit({ op: 'set_fidelity_enabled', enabled: false })).toContain(
      'Switch off'
    );
  });
});
