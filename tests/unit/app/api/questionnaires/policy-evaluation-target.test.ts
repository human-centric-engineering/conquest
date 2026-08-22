/**
 * Resolving a policy finding's `targetKey` into the subject a reviewer reads.
 *
 * The `question:` case carries real weight: the question-design panel also targets questions, and
 * labelling this panel's findings `Fidelity — "<prompt>"` is one of the four things that stops one
 * question flagged by both panels reading as one subject in two queues.
 *
 * @see app/api/v1/app/questionnaires/_lib/policy-evaluation-target.ts
 */

import { describe, it, expect } from 'vitest';

import { resolvePolicyFindingTarget } from '@/app/api/v1/app/questionnaires/_lib/policy-evaluation-target';
import type { PolicyStructureInput } from '@/lib/app/questionnaire/policy-evaluation';

function structure(over: Partial<PolicyStructureInput> = {}): PolicyStructureInput {
  return {
    meta: { title: 'T', goal: null, audienceSummary: null, sectionCount: 1, questionCount: 1 },
    context: {
      presentationMode: 'both',
      anonymousMode: false,
      sensitivityAwareness: false,
      hasSupportMessage: false,
      answerConfidenceFloor: 0.5,
    },
    tone: { personaSelectionEnabled: false, personaText: null, dials: [] },
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
      distribution: { free: 0, loose: 0, balanced: 1, close: 0, must_ask: 0 },
      satisfactionFloors: { free: 0.5, loose: 0.5, balanced: 0.5, close: 0.65, must_ask: 0.85 },
      questions: [
        {
          key: 'q1',
          prompt: 'How satisfied are you with your revenue engine?',
          type: 'likert',
          required: true,
          weight: 1,
          sectionTitle: 'S',
          level: 'balanced',
          storedLevel: 'balanced',
          topicKeys: [],
        },
      ],
      questionsShown: 1,
      questionsTotal: 1,
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

const LIVE = structure();

describe('resolvePolicyFindingTarget — the whole-block targets', () => {
  it('names each block in plain English', () => {
    const cases: [string, string, string][] = [
      ['house_rules', 'house_rules', 'House rules'],
      ['strategy', 'strategy', 'Questioning approach'],
      ['fidelity', 'fidelity', 'Asking questions as written'],
      ['tone', 'tone', 'Interviewer tone'],
    ];
    for (const [key, kind, label] of cases) {
      expect(resolvePolicyFindingTarget(key, LIVE, null)).toEqual({
        kind,
        key,
        label,
        removed: false,
      });
    }
  });
});

describe('resolvePolicyFindingTarget — house rules', () => {
  it('names a live rule by its text', () => {
    expect(resolvePolicyFindingTarget('house_rule:r1', LIVE, null)).toMatchObject({
      kind: 'house_rule',
      label: 'Never use humour.',
      removed: false,
    });
  });

  it('falls back to the snapshot and marks a deleted rule removed', () => {
    const gone = structure({ houseRules: { enabled: true, rules: [] } });
    expect(resolvePolicyFindingTarget('house_rule:r1', gone, LIVE)).toMatchObject({
      label: 'Never use humour.',
      removed: true,
    });
  });

  it('degrades to the bare id when neither structure knows the rule', () => {
    const gone = structure({ houseRules: { enabled: true, rules: [] } });
    expect(resolvePolicyFindingTarget('house_rule:zzz', gone, gone)).toMatchObject({
      label: 'Rule zzz',
      removed: true,
    });
  });
});

describe('resolvePolicyFindingTarget — questions', () => {
  it('prefixes the label so it can never be read as a question-design finding', () => {
    // The design-evaluation panel targets the same question by its bare key. This prefix is what
    // tells a reader which subject is being judged before they read the finding.
    const out = resolvePolicyFindingTarget('question:q1', LIVE, null);
    expect(out?.kind).toBe('question');
    expect(out?.label).toContain('Fidelity —');
    expect(out?.label).toContain('revenue engine');
  });

  it('does NOT claim removed when the question merely fell out of a truncated sample', () => {
    // The loader caps at 150 and prefers non-Balanced questions, so a question whose slider moved
    // to Balanced legitimately leaves the list while still existing. A phantom "removed" would tell
    // the reviewer a question was deleted when it was not.
    const trimmed = structure({
      fidelity: { ...LIVE.fidelity, questions: [], truncated: true },
    });
    expect(resolvePolicyFindingTarget('question:q1', trimmed, LIVE)).toMatchObject({
      removed: false,
      label: expect.stringContaining('Fidelity —'),
    });
  });

  it('claims removed only when the snapshot cannot name it either', () => {
    const empty = structure({ fidelity: { ...LIVE.fidelity, questions: [] } });
    expect(resolvePolicyFindingTarget('question:gone', empty, empty)).toMatchObject({
      label: 'Question gone',
      removed: true,
    });
  });
});

describe('resolvePolicyFindingTarget — degradation', () => {
  it('returns null with nothing to resolve against', () => {
    expect(resolvePolicyFindingTarget('strategy', null, null)).toBeNull();
  });

  it('passes an unrecognised key through rather than guessing', () => {
    expect(resolvePolicyFindingTarget('something:else', LIVE, null)).toMatchObject({
      kind: 'unknown',
      label: 'something:else',
    });
  });

  it('clips a very long rule so a list row stays one line', () => {
    const long = structure({
      houseRules: {
        enabled: true,
        rules: [{ id: 'r1', kind: 'never', enabled: true, text: 'x'.repeat(400), trigger: null }],
      },
    });
    const label = resolvePolicyFindingTarget('house_rule:r1', long, null)?.label ?? '';
    expect(label.length).toBeLessThanOrEqual(120);
    expect(label.endsWith('…')).toBe(true);
  });
});
