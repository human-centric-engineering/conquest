/**
 * Read-time staleness for policy-evaluation findings.
 *
 * The whole point of this module is that it compares ONLY the field an op writes, and that matters
 * more here than on either sibling panel: this one has no reconciler *and* a real collision case —
 * three of its four dimensions can target the same field. So per-op comparison is the only thing
 * stopping the second of two colliding findings from silently overwriting the first.
 *
 * The trap these tests exist to catch: a `default:` branch that stringifies a whole block would
 * mark EVERY finding on that block stale the moment any one of them applied. A reviewer would apply
 * one strategy finding, watch the other three grey out for no visible reason, and conclude the
 * panel was broken.
 *
 * @see app/api/v1/app/questionnaires/_lib/policy-evaluation-staleness.ts
 */

import { describe, it, expect } from 'vitest';

import {
  derivePolicyApplicability,
  derivePolicyFindingState,
} from '@/app/api/v1/app/questionnaires/_lib/policy-evaluation-staleness';
import type { PolicyStructureInput } from '@/lib/app/questionnaire/policy-evaluation';

function structure(over: Partial<PolicyStructureInput> = {}): PolicyStructureInput {
  return {
    meta: {
      title: 'T',
      goal: null,
      audienceSummary: null,
      sectionCount: 1,
      questionCount: 2,
    },
    context: {
      presentationMode: 'both',
      anonymousMode: false,
      sensitivityAwareness: false,
      hasSupportMessage: false,
      answerConfidenceFloor: 0.5,
    },
    tone: {
      personaSelectionEnabled: false,
      personaText: null,
      dials: [
        { key: 'humour', label: 'Humour', displayLevel: 2 },
        { key: 'verbosity', label: 'Verbosity', displayLevel: 1 },
      ],
    },
    houseRules: {
      enabled: true,
      rules: [{ id: 'r1', kind: 'never', enabled: true, text: 'Never use humour.', trigger: null }],
    },
    strategy: {
      enabled: true,
      approach: 'funnel',
      pace: 'balanced',
      openingMode: 'auto',
      openingExamples: [],
      probeDepth: true,
      reflect: false,
      batchRelated: true,
      paceProfile: {
        openingWindow: 2,
        openBelow: 0.4,
        targetedAbove: 0.75,
        openRounds: 3,
        targetedRounds: 8,
      },
      guidedOpeningActive: false,
    },
    fidelity: {
      enabled: true,
      defaultFidelity: 0.5,
      defaultLevel: 'balanced',
      distribution: { free: 0, loose: 0, balanced: 1, close: 0, must_ask: 1 },
      satisfactionFloors: { free: 0.5, loose: 0.5, balanced: 0.5, close: 0.65, must_ask: 0.85 },
      questions: [
        {
          key: 'q1',
          prompt: 'How satisfied are you?',
          type: 'likert',
          required: true,
          weight: 1,
          sectionTitle: 'S',
          level: 'must_ask',
          storedLevel: 'must_ask',
          topicKeys: [],
        },
      ],
      questionsShown: 1,
      questionsTotal: 2,
      truncated: false,
    },
    routing: {
      adaptiveScopeEnabled: false,
      maxConditionalTopics: 3,
      limitOpeningProbes: false,
      maxOpeningProbes: 1,
      mustAskByTopic: [],
    },
    knownIssues: [],
    ...over,
  };
}

const SNAP = structure();

const stale = (
  targetKey: string,
  op: Parameters<typeof derivePolicyFindingState>[0]['op'],
  current: PolicyStructureInput
) => derivePolicyFindingState({ targetKey, op }, SNAP, current).stale;

describe('derivePolicyFindingState — the strategy blob is never compared whole', () => {
  it('does not stale a tactics finding when the PACE changed', () => {
    // The trap this whole module is shaped around. Apply one strategy finding, and the others must
    // not grey out for no visible reason.
    const current = structure({ strategy: { ...SNAP.strategy, pace: 'brisk' } });
    expect(stale('strategy', { op: 'set_tactics', reflect: true }, current)).toBe(false);
  });

  it('does not stale an approach finding when a TACTIC changed', () => {
    const current = structure({ strategy: { ...SNAP.strategy, reflect: true } });
    expect(stale('strategy', { op: 'set_approach', approach: 'open' }, current)).toBe(false);
  });

  it('stales an approach finding when the approach itself changed', () => {
    const current = structure({ strategy: { ...SNAP.strategy, approach: 'targeted' } });
    expect(stale('strategy', { op: 'set_approach', approach: 'open' }, current)).toBe(true);
  });

  it('only compares the tactics the op actually names', () => {
    // A finding turning `reflect` on is not obsoleted by someone toggling `batchRelated`.
    const current = structure({ strategy: { ...SNAP.strategy, batchRelated: false } });
    expect(stale('strategy', { op: 'set_tactics', reflect: true }, current)).toBe(false);
    expect(stale('strategy', { op: 'set_tactics', batchRelated: true }, current)).toBe(true);
  });
});

describe('derivePolicyFindingState — house rules', () => {
  const withRule = (over: Partial<PolicyStructureInput['houseRules']['rules'][number]>) =>
    structure({
      houseRules: { enabled: true, rules: [{ ...SNAP.houseRules.rules[0], ...over }] },
    });

  it('stales an edit when the rule text moved', () => {
    expect(
      stale(
        'house_rule:r1',
        { op: 'edit_house_rule', kind: 'never', text: 'x' },
        withRule({ text: 'Reworded by hand.' })
      )
    ).toBe(true);
  });

  it('does not stale an enable/disable finding when only the TEXT moved', () => {
    expect(
      stale(
        'house_rule:r1',
        { op: 'set_house_rule_enabled', enabled: false },
        withRule({ text: 'Reworded.' })
      )
    ).toBe(false);
  });

  it('treats a deleted rule as gone', () => {
    const current = structure({ houseRules: { enabled: true, rules: [] } });
    expect(stale('house_rule:r1', { op: 'set_house_rule_enabled', enabled: false }, current)).toBe(
      true
    );
  });

  it('never stales a delete of a rule that is still there', () => {
    expect(
      stale('house_rule:r1', { op: 'delete_house_rule' }, withRule({ text: 'Reworded.' }))
    ).toBe(false);
  });

  it('never stales an add — there is nothing existing to have drifted', () => {
    const current = structure({ houseRules: { enabled: true, rules: [] } });
    expect(stale('house_rules', { op: 'add_house_rule', kind: 'always', text: 'x' }, current)).toBe(
      false
    );
  });
});

describe('derivePolicyFindingState — tone', () => {
  it('only compares the dial the op names', () => {
    // Someone turning humour down does not obsolete a finding about verbosity.
    const current = structure({
      tone: { ...SNAP.tone, dials: [{ key: 'humour', label: 'Humour', displayLevel: 0 }] },
    });
    expect(
      stale('tone', { op: 'set_tone_dimension', dimension: 'verbosity', enabled: false }, current)
    ).toBe(true); // verbosity dial disappeared entirely
    const onlyVerbosityMoved = structure({
      tone: {
        ...SNAP.tone,
        dials: [
          { key: 'humour', label: 'Humour', displayLevel: 2 },
          { key: 'verbosity', label: 'Verbosity', displayLevel: -1 },
        ],
      },
    });
    expect(
      stale(
        'tone',
        { op: 'set_tone_dimension', dimension: 'humour', enabled: false },
        onlyVerbosityMoved
      )
    ).toBe(false);
  });
});

describe('derivePolicyFindingState — question fidelity', () => {
  it('stales when the question’s stored level moved', () => {
    const current = structure({
      fidelity: {
        ...SNAP.fidelity,
        questions: [{ ...SNAP.fidelity.questions[0], storedLevel: 'close' }],
      },
    });
    expect(stale('question:q1', { op: 'set_question_fidelity', fidelity: 1 }, current)).toBe(true);
  });

  it('does NOT claim stale when the question merely dropped out of a truncated sample', () => {
    // The loader caps its list at 150 and prefers non-Balanced questions, so a question can leave
    // the sample while still existing. Reporting that as stale would block a perfectly good apply;
    // the apply engine re-checks against the real row anyway.
    const current = structure({
      fidelity: { ...SNAP.fidelity, questions: [], truncated: true },
    });
    expect(stale('question:q1', { op: 'set_question_fidelity', fidelity: 1 }, current)).toBe(false);
  });
});

describe('derivePolicyFindingState — degradation', () => {
  it('cannot derive staleness without a snapshot, and says so by not claiming it', () => {
    const out = derivePolicyFindingState(
      { targetKey: 'strategy', op: { op: 'set_pace', pace: 'brisk' } },
      null,
      structure()
    );
    expect(out.stale).toBe(false);
    expect(out.applicable).toBe('apply');
  });

  it('marks a prose-only finding manual, never applicable', () => {
    expect(derivePolicyApplicability(null)).toBe('manual');
    expect(derivePolicyApplicability({ op: 'set_pace', pace: 'brisk' })).toBe('apply');
  });
});
