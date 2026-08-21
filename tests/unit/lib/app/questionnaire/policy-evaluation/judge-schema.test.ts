/**
 * The interviewer-policy judge output contract.
 *
 * Two things matter here and both are about NOT trusting a model's structured output:
 *
 * 1. `coercePolicyProposedEdit` must degrade a malformed edit to `null` — prose-only — rather than
 *    hand the apply engine something the config route would reject. The single most likely mistake
 *    is the house-rule trigger invariant, which is why the schema borrows the config PATCH's own
 *    `houseRuleBodySchema` instead of re-declaring one.
 * 2. A finding is still worth showing when its structured edit is broken. Losing the observation
 *    because a judge mis-shaped one field would be worse than losing the one-click fix.
 *
 * @see lib/app/questionnaire/policy-evaluation/judge-schema.ts
 */

import { describe, it, expect } from 'vitest';

import {
  coercePolicyProposedEdit,
  policyJudgeFindingSchema,
  validatePolicyJudgeVerdict,
  MAX_POLICY_FINDINGS_PER_JUDGE,
} from '@/lib/app/questionnaire/policy-evaluation/judge-schema';

describe('coercePolicyProposedEdit — the house-rule trigger invariant', () => {
  it('rejects an if_asked rule with no trigger', () => {
    // It would render as an answer to a question that is never identified — it can never fire.
    expect(
      coercePolicyProposedEdit({
        op: 'add_house_rule',
        kind: 'if_asked',
        text: 'We never share names.',
      })
    ).toBeNull();
  });

  it('rejects a trigger on a rule kind that cannot have one', () => {
    expect(
      coercePolicyProposedEdit({
        op: 'edit_house_rule',
        kind: 'always',
        text: 'Confirm the timeframe.',
        trigger: 'how answers are scored',
      })
    ).toBeNull();
  });

  it('accepts a well-formed if_asked rule', () => {
    const out = coercePolicyProposedEdit({
      op: 'add_house_rule',
      kind: 'if_asked',
      text: 'We never share names.',
      trigger: 'anonymity',
    });
    expect(out).toMatchObject({ op: 'add_house_rule', kind: 'if_asked', trigger: 'anonymity' });
  });

  it('never lets a judge choose a rule id', () => {
    // Ids are preserved from the live rule or minted server-side. A judge-chosen id could collide
    // with a real one and silently overwrite it.
    expect(
      coercePolicyProposedEdit({
        op: 'add_house_rule',
        kind: 'always',
        text: 'Confirm the timeframe.',
        id: 'rule-1',
      })
    ).toBeNull();
  });
});

describe('coercePolicyProposedEdit — the other ops', () => {
  it('holds fidelity to the five-stop grid', () => {
    // The runtime clamps on read, so an off-grid value would apply as something other than what the
    // finding claimed.
    expect(coercePolicyProposedEdit({ op: 'set_question_fidelity', fidelity: 0.37 })).toBeNull();
    expect(coercePolicyProposedEdit({ op: 'set_question_fidelity', fidelity: 1 })).toMatchObject({
      fidelity: 1,
    });
  });

  it('rejects a tactics edit that changes nothing', () => {
    expect(coercePolicyProposedEdit({ op: 'set_tactics' })).toBeNull();
    expect(coercePolicyProposedEdit({ op: 'set_tactics', reflect: false })).toMatchObject({
      reflect: false,
    });
  });

  it('rejects an unknown enum value rather than passing it through', () => {
    expect(coercePolicyProposedEdit({ op: 'set_approach', approach: 'sideways' })).toBeNull();
    expect(coercePolicyProposedEdit({ op: 'set_pace', pace: 'instant' })).toBeNull();
  });

  it('rejects an op that does not exist', () => {
    expect(coercePolicyProposedEdit({ op: 'delete_question' })).toBeNull();
    // Master switches are deliberately absent — flipping one voids a client's whole policy.
    expect(coercePolicyProposedEdit({ op: 'set_house_rules_enabled', enabled: false })).toBeNull();
  });

  it('accepts the gate op in both directions', () => {
    // The one master switch that IS allowed: flipping it destroys nothing, and "sliders set but the
    // feature is off" is the best finding this panel can produce.
    expect(coercePolicyProposedEdit({ op: 'set_fidelity_enabled', enabled: true })).toMatchObject({
      enabled: true,
    });
    expect(coercePolicyProposedEdit({ op: 'set_fidelity_enabled', enabled: false })).toMatchObject({
      enabled: false,
    });
  });
});

describe('policyJudgeFindingSchema', () => {
  const finding = {
    targetKey: 'house_rule:r1',
    severity: 'minor',
    proposedChange: 'Say what "appropriate" means here.',
    rationale: 'As written no turn would behave differently.',
  };

  it('accepts a finding with no structured edit', () => {
    expect(policyJudgeFindingSchema.safeParse(finding).success).toBe(true);
  });

  it('rejects a finding with no actionable content', () => {
    expect(policyJudgeFindingSchema.safeParse({ ...finding, proposedChange: '   ' }).success).toBe(
      false
    );
  });
});

describe('validatePolicyJudgeVerdict', () => {
  it('accepts an empty findings array, which is often the correct answer', () => {
    const out = validatePolicyJudgeVerdict({ score: 1, findings: [] });
    expect(out.ok).toBe(true);
  });

  it('rejects a score outside [0,1]', () => {
    expect(validatePolicyJudgeVerdict({ score: 1.5, findings: [] }).ok).toBe(false);
  });

  it('rejects a dimension the judge tried to label itself with', () => {
    // The caller stamps the dimension from the dispatch it made, so a judge can never mislabel its
    // own verdict — `.strict()` is what enforces that.
    expect(validatePolicyJudgeVerdict({ score: 1, findings: [], dimension: 'arc_fit' }).ok).toBe(
      false
    );
  });

  it('caps a runaway verdict rather than flooding the review queue', () => {
    const findings = Array.from({ length: MAX_POLICY_FINDINGS_PER_JUDGE + 1 }, () => ({
      targetKey: 'strategy',
      severity: 'info' as const,
      proposedChange: 'x',
      rationale: 'y',
    }));
    expect(validatePolicyJudgeVerdict({ score: 0.5, findings }).ok).toBe(false);
  });

  it('reports the failing paths so a retry message can name them', () => {
    const out = validatePolicyJudgeVerdict({ score: 'high', findings: [] });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.issues.length).toBeGreaterThan(0);
  });
});
