/**
 * Unit test: the interviewer-policy apply engine (F18.8).
 *
 * Mirrors `scope-evaluation-apply.test.ts`, and pins the three rules this panel inherited from
 * F17.21's gate pass — each of which is MORE load-bearing here than it was there:
 *
 *   - **Fork-lineage convergence.** A second apply from a run that already forked reuses that
 *     draft rather than forking again. One policy run routinely yields many
 *     `set_question_fidelity` findings, so multi-apply-per-run is the normal path.
 *   - **One transaction.** The op write and the finding stamp go through a single
 *     `prisma.$transaction`, and `writePolicyOp` receives the transaction client — `add_house_rule`
 *     appends unconditionally, so a crash between two separate writes would duplicate a rule while
 *     the finding still read `pending`.
 *   - **`previousValue` in the audit metadata.** There is no provenance column to stamp on the rows
 *     this panel edits, so the audit log is the ONLY record that an AI suggestion chose a value.
 *     Without the previous value, an enum change is unreconstructible from history.
 *
 * Plus the two apply-time refusals, which exist so an apply cannot create a conflict the mechanical
 * checker would then warn about.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  appQuestionnairePolicyEvaluationFinding: { findFirst: vi.fn(), update: vi.fn() },
  appQuestionnaireVersion: { findFirst: vi.fn() },
  appQuestionnaireConfig: { findUnique: vi.fn(), upsert: vi.fn() },
  appQuestionSlot: { findUnique: vi.fn(), update: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

const auditMock = vi.hoisted(() => ({ logAdminAction: vi.fn() }));
vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => auditMock);

const forkMock = vi.hoisted(() => ({ forkVersionIfLaunched: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaires/_lib/fork', () => forkMock);

const configMock = vi.hoisted(() => ({
  loadVersionConfigBlocks: vi.fn(),
  patchVersionConfigBlocks: vi.fn(),
}));
vi.mock('@/app/api/v1/app/questionnaires/_lib/config-routes', () => configMock);

import {
  applyPolicyFinding,
  findRunReviewDraft,
  resolvePolicyEffectiveOp,
} from '@/app/api/v1/app/questionnaires/_lib/policy-evaluation-apply';
import { forkVersionIfLaunched } from '@/app/api/v1/app/questionnaires/_lib/fork';
import {
  loadVersionConfigBlocks,
  patchVersionConfigBlocks,
} from '@/app/api/v1/app/questionnaires/_lib/config-routes';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { DEFAULT_QUESTIONNAIRE_CONFIG } from '@/lib/app/questionnaire/types';
import type { PolicyStructureInput } from '@/lib/app/questionnaire/policy-evaluation';

type Mock = ReturnType<typeof vi.fn>;

const scoped = { id: 'v1', questionnaireId: 'qn-1', versionNumber: 1, status: 'draft' as const };
const audit = { userId: 'admin-1', clientIp: null };

const RULE = { id: 'r1', kind: 'never' as const, enabled: true, text: 'Never use humour.' };

function blocks(over: Partial<ReturnType<typeof baseBlocks>> = {}) {
  return { ...baseBlocks(), ...over };
}
function baseBlocks() {
  return {
    houseRules: { enabled: true, rules: [RULE] },
    interviewerStrategy: { ...DEFAULT_QUESTIONNAIRE_CONFIG.interviewerStrategy },
    questionFidelity: { enabled: true, defaultFidelity: 0.5 as const },
    tone: { ...DEFAULT_QUESTIONNAIRE_CONFIG.tone },
  };
}

function structure(): PolicyStructureInput {
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
    houseRules: { enabled: true, rules: [{ ...RULE, trigger: null }] },
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
          prompt: 'How satisfied?',
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
      conditionalTopicsEnabled: false,
      maxConditionalTopics: 3,
      limitOpeningProbes: false,
      maxOpeningProbes: 1,
      mustAskByTopic: [],
    },
    knownIssues: [],
  };
}

const finding = (over: Record<string, unknown> = {}) => ({
  id: 'f1',
  targetKey: 'strategy',
  proposedEdit: { op: 'set_pace', pace: 'brisk' },
  editedOverride: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  // No prior apply on this run → no draft to reuse.
  (prismaMock.appQuestionnairePolicyEvaluationFinding.findFirst as Mock).mockResolvedValue(null);
  (forkVersionIfLaunched as Mock).mockResolvedValue({
    versionId: 'v1',
    forked: false,
    versionNumber: 1,
  });
  (loadVersionConfigBlocks as Mock).mockResolvedValue(blocks());
  (patchVersionConfigBlocks as Mock).mockResolvedValue(undefined);
  (prismaMock.appQuestionnaireConfig.findUnique as Mock).mockResolvedValue({
    personaSelection: { enabled: false },
  });
  (prismaMock.appQuestionSlot.findUnique as Mock).mockResolvedValue({
    id: 'slot-1',
    fidelity: 0.5,
  });
  // Run the transaction body against the same mock client.
  // Run the transaction body against the same mock client, so a write that used the bare `prisma`
  // singleton instead of `tx` would be indistinguishable here — which is why the "passes the
  // transaction client" test asserts on the argument rather than on the write landing.
  // The transaction runner executes the callback with a tx proxy backed by the same mock — so a
  // write that used the bare `prisma` singleton instead of `tx` would be indistinguishable here,
  // which is why the "passes the transaction client" test asserts on the ARGUMENT rather than on
  // the write landing.
  prismaMock.$transaction.mockImplementation(async (cb: (tx: typeof prismaMock) => unknown) =>
    cb(prismaMock)
  );
});

describe('applyPolicyFinding — the early guards', () => {
  it('refuses a prose-only finding as needing authoring', () => {
    return expect(
      applyPolicyFinding({
        finding: finding({ proposedEdit: null }),
        runId: 'run-1',
        scoped,
        snapshot: structure(),
        current: structure(),
        audit,
      })
    ).resolves.toMatchObject({ status: 'unapplicable', reason: 'needs_authoring' });
  });

  it('refuses a stale finding at apply time, not just at read time', async () => {
    // The read-time flag may be minutes old. With this panel's same-field collisions, this
    // re-check is the only thing stopping a second finding overwriting the first.
    const current = structure();
    current.strategy.pace = 'gradual';
    const out = await applyPolicyFinding({
      finding: finding(),
      runId: 'run-1',
      scoped,
      snapshot: structure(),
      current,
      audit,
    });
    expect(out).toMatchObject({ status: 'unapplicable', reason: 'stale' });
    expect(patchVersionConfigBlocks).not.toHaveBeenCalled();
  });

  it('refuses when the targeted house rule is gone', async () => {
    (loadVersionConfigBlocks as Mock).mockResolvedValue(
      blocks({ houseRules: { enabled: true, rules: [] } })
    );
    const out = await applyPolicyFinding({
      finding: finding({
        targetKey: 'house_rule:r1',
        proposedEdit: { op: 'delete_house_rule' },
      }),
      runId: 'run-1',
      scoped,
      snapshot: structure(),
      current: structure(),
      audit,
    });
    expect(out).toMatchObject({ status: 'unapplicable', reason: 'target_gone' });
  });
});

describe('applyPolicyFinding — the two apply-time refusals', () => {
  it('refuses to switch on example openings when none are written', async () => {
    // It would make the setting inert — the exact conflict the mechanical checker warns about.
    const out = await applyPolicyFinding({
      finding: finding({ proposedEdit: { op: 'set_opening_mode', openingMode: 'examples' } }),
      runId: 'run-1',
      scoped,
      snapshot: structure(),
      current: structure(),
      audit,
    });
    expect(out).toMatchObject({ status: 'unapplicable', reason: 'op_invalid' });
    expect(patchVersionConfigBlocks).not.toHaveBeenCalled();
  });

  it('refuses a tone-dial edit when a chosen persona has replaced the dials', async () => {
    (prismaMock.appQuestionnaireConfig.findUnique as Mock).mockResolvedValue({
      personaSelection: { enabled: true },
    });
    const out = await applyPolicyFinding({
      finding: finding({
        targetKey: 'tone',
        proposedEdit: { op: 'set_tone_dimension', dimension: 'humour', enabled: false },
      }),
      runId: 'run-1',
      scoped,
      snapshot: structure(),
      current: structure(),
      audit,
    });
    expect(out).toMatchObject({ status: 'unapplicable', reason: 'op_invalid' });
  });
});

describe('applyPolicyFinding — writing', () => {
  it('writes the op and stamps the finding inside ONE transaction', async () => {
    const out = await applyPolicyFinding({
      finding: finding(),
      runId: 'run-1',
      scoped,
      snapshot: structure(),
      current: structure(),
      audit,
    });
    expect(out).toMatchObject({ status: 'applied', appliedToVersionId: 'v1', forked: false });
    // One transaction, and both writes inside it. `add_house_rule` appends unconditionally, so a
    // crash between two separate writes would duplicate a rule while the finding read pending.
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(patchVersionConfigBlocks).toHaveBeenCalledWith(
      'v1',
      { interviewerStrategy: expect.objectContaining({ pace: 'brisk' }) },
      prismaMock
    );
    expect(prismaMock.appQuestionnairePolicyEvaluationFinding.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'applied' }) })
    );
  });

  it('passes the transaction client to the config write, never the bare singleton', async () => {
    await applyPolicyFinding({
      finding: finding(),
      runId: 'run-1',
      scoped,
      snapshot: structure(),
      current: structure(),
      audit,
    });
    // The third argument IS the tx client. Using `prisma` here would escape the transaction and
    // defeat the point of opening one.
    const [, , client] = (patchVersionConfigBlocks as Mock).mock.calls[0];
    expect(client).toBe(prismaMock);
  });

  it('preserves a rule’s id and enabled flag when rewording it', async () => {
    await applyPolicyFinding({
      finding: finding({
        targetKey: 'house_rule:r1',
        proposedEdit: { op: 'edit_house_rule', kind: 'never', text: 'Never joke.' },
      }),
      runId: 'run-1',
      scoped,
      snapshot: structure(),
      current: structure(),
      audit,
    });
    const [, patch] = (patchVersionConfigBlocks as Mock).mock.calls[0];
    // A judge proposes the authored fields only — an apply must never re-key a rule or silently
    // re-enable a parked one.
    expect(patch.houseRules.rules[0]).toMatchObject({
      id: 'r1',
      enabled: true,
      text: 'Never joke.',
    });
  });

  it('writes a question’s fidelity by (versionId, key), never by row id', async () => {
    await applyPolicyFinding({
      finding: finding({
        targetKey: 'question:q1',
        proposedEdit: { op: 'set_question_fidelity', fidelity: 1 },
      }),
      runId: 'run-1',
      scoped,
      snapshot: structure(),
      current: structure(),
      audit,
    });
    // After a fork the ids are new but `copyVersionGraph` preserves the key 1:1.
    expect(prismaMock.appQuestionSlot.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { versionId_key: { versionId: 'v1', key: 'q1' } },
        data: { fidelity: 1 },
      })
    );
  });
});

describe('applyPolicyFinding — fork lineage', () => {
  it('reuses the draft this run already forked instead of forking again', async () => {
    // Multi-apply-per-run is the NORMAL path here: one run easily yields many question-fidelity
    // findings. Forking per apply would scatter them across versions.
    (prismaMock.appQuestionnairePolicyEvaluationFinding.findFirst as Mock).mockResolvedValue({
      appliedToVersionId: 'v2',
    });
    (prismaMock.appQuestionnaireVersion.findFirst as Mock).mockResolvedValue({
      id: 'v2',
      versionNumber: 2,
    });

    const out = await applyPolicyFinding({
      finding: finding(),
      runId: 'run-1',
      scoped: { ...scoped, status: 'launched' },
      snapshot: structure(),
      current: structure(),
      audit,
    });

    expect(out).toMatchObject({ status: 'applied', appliedToVersionId: 'v2', forked: false });
    expect(forkVersionIfLaunched).not.toHaveBeenCalled();
  });

  it('forks a launched version on the first apply', async () => {
    (forkVersionIfLaunched as Mock).mockResolvedValue({
      versionId: 'v9',
      forked: true,
      versionNumber: 2,
    });
    const out = await applyPolicyFinding({
      finding: finding(),
      runId: 'run-1',
      scoped: { ...scoped, status: 'launched' },
      snapshot: structure(),
      current: structure(),
      audit,
    });
    expect(out).toMatchObject({ status: 'applied', appliedToVersionId: 'v9', forked: true });
  });
});

describe('applyPolicyFinding — the audit trail', () => {
  it('records what the value was changed FROM', async () => {
    // Load-bearing, not decorative: neither `AppQuestionSlot` nor a house rule carries the
    // provenance column `AppQuestionnaireTopic` has, so this log is the only record that an AI
    // suggestion — not a human — chose this value. Without `previousValue` an enum change is
    // unreconstructible from history.
    await applyPolicyFinding({
      finding: finding(),
      runId: 'run-1',
      scoped,
      snapshot: structure(),
      current: structure(),
      audit,
    });
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'questionnaire_policy_evaluation_finding.apply',
        metadata: expect.objectContaining({ op: 'set_pace', previousValue: 'balanced' }),
      })
    );
  });

  it('records the prior fidelity for a question edit', async () => {
    (prismaMock.appQuestionSlot.findUnique as Mock).mockResolvedValue({
      id: 'slot-1',
      fidelity: 0.25,
    });
    await applyPolicyFinding({
      finding: finding({
        targetKey: 'question:q1',
        proposedEdit: { op: 'set_question_fidelity', fidelity: 1 },
      }),
      runId: 'run-1',
      scoped,
      snapshot: structure(),
      current: structure(),
      audit,
    });
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ previousValue: 0.25 }) })
    );
  });
});

describe('resolvePolicyEffectiveOp', () => {
  it('prefers the admin’s edited override over the judge’s draft', () => {
    expect(
      resolvePolicyEffectiveOp({
        id: 'f1',
        targetKey: 'strategy',
        proposedEdit: { op: 'set_pace', pace: 'brisk' },
        editedOverride: { op: 'set_pace', pace: 'gradual' },
      })
    ).toEqual({ op: 'set_pace', pace: 'gradual' });
  });

  it('degrades a malformed op to null rather than handing it to the writer', () => {
    expect(
      resolvePolicyEffectiveOp({
        id: 'f1',
        targetKey: 'strategy',
        proposedEdit: { op: 'set_pace', pace: 'instant' },
        editedOverride: null,
      })
    ).toBeNull();
  });
});

describe('findRunReviewDraft', () => {
  it('returns null when the run has never been applied', async () => {
    (prismaMock.appQuestionnairePolicyEvaluationFinding.findFirst as Mock).mockResolvedValue(null);
    expect(await findRunReviewDraft('run-1', 'qn-1')).toBeNull();
  });

  it('only reuses a DRAFT of the same questionnaire', async () => {
    (prismaMock.appQuestionnairePolicyEvaluationFinding.findFirst as Mock).mockResolvedValue({
      appliedToVersionId: 'v2',
    });
    (prismaMock.appQuestionnaireVersion.findFirst as Mock).mockResolvedValue(null);
    expect(await findRunReviewDraft('run-1', 'qn-1')).toBeNull();
    expect(prismaMock.appQuestionnaireVersion.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'v2', questionnaireId: 'qn-1', status: 'draft' },
      })
    );
  });
});

/**
 * Every op's write path.
 *
 * Each writes a DIFFERENT field of a different block, so a wrong target here is silent config
 * corruption that no type would catch — `set_pace` writing `approach` compiles perfectly.
 */
describe('writePolicyOp — one field per op', () => {
  async function applyOp(op: Record<string, unknown>, targetKey = 'strategy') {
    await applyPolicyFinding({
      finding: finding({ targetKey, proposedEdit: op }),
      runId: 'run-1',
      scoped,
      snapshot: structure(),
      current: structure(),
      audit,
    });
    const calls = (patchVersionConfigBlocks as Mock).mock.calls;
    return calls.length > 0 ? calls[0][1] : null;
  }

  it('set_approach writes only the approach', async () => {
    const patch = await applyOp({ op: 'set_approach', approach: 'open' });
    expect(patch.interviewerStrategy).toMatchObject({ approach: 'open', pace: 'balanced' });
  });

  it('set_opening_mode writes only the opening mode', async () => {
    (loadVersionConfigBlocks as Mock).mockResolvedValue(
      blocks({
        interviewerStrategy: {
          ...baseBlocks().interviewerStrategy,
          openingMode: 'examples',
          openingExamples: ['Tell me about your year'],
        },
      })
    );
    const patch = await applyOp({ op: 'set_opening_mode', openingMode: 'auto' });
    expect(patch.interviewerStrategy.openingMode).toBe('auto');
  });

  it('set_tactics writes only the tactics it names', async () => {
    const patch = await applyOp({ op: 'set_tactics', reflect: true });
    expect(patch.interviewerStrategy).toMatchObject({
      reflect: true,
      // Untouched — a finding about one tactic must not reset the others.
      probeDepth: baseBlocks().interviewerStrategy.probeDepth,
      batchRelated: baseBlocks().interviewerStrategy.batchRelated,
    });
  });

  it('set_fidelity_enabled writes only the gate', async () => {
    const patch = await applyOp({ op: 'set_fidelity_enabled', enabled: false }, 'fidelity');
    expect(patch.questionFidelity).toMatchObject({ enabled: false, defaultFidelity: 0.5 });
  });

  it('set_default_fidelity clamps onto the five-stop grid', async () => {
    const patch = await applyOp({ op: 'set_default_fidelity', defaultFidelity: 0.75 }, 'fidelity');
    expect(patch.questionFidelity.defaultFidelity).toBe(0.75);
  });

  it('set_tone_dimension writes only that dial, keeping its level when none is given', async () => {
    const patch = await applyOp(
      { op: 'set_tone_dimension', dimension: 'humour', enabled: false },
      'tone'
    );
    expect(patch.tone.humour).toMatchObject({
      enabled: false,
      level: baseBlocks().tone.humour.level,
    });
    // Every other dial is carried through untouched.
    expect(patch.tone.empathy).toEqual(baseBlocks().tone.empathy);
  });

  it('add_house_rule appends and mints an id server-side', async () => {
    const patch = await applyOp(
      { op: 'add_house_rule', kind: 'always', text: 'Confirm the timeframe.' },
      'house_rules'
    );
    expect(patch.houseRules.rules).toHaveLength(2);
    const added = patch.houseRules.rules[1];
    // A judge never chooses an id — one it picked could collide with a real rule.
    expect(added.id).toEqual(expect.any(String));
    expect(added).toMatchObject({ kind: 'always', text: 'Confirm the timeframe.', enabled: true });
  });

  it('delete_house_rule removes exactly the targeted rule', async () => {
    const patch = await applyOp({ op: 'delete_house_rule' }, 'house_rule:r1');
    expect(patch.houseRules.rules).toHaveLength(0);
  });

  it('set_house_rule_enabled parks a rule without touching its text', async () => {
    const patch = await applyOp({ op: 'set_house_rule_enabled', enabled: false }, 'house_rule:r1');
    expect(patch.houseRules.rules[0]).toMatchObject({ enabled: false, text: RULE.text });
  });

  it('drops a stale trigger when a rule is rewritten to a kind that cannot have one', async () => {
    // A rule that changed kind in the editor can leave an orphaned trigger behind; carrying it
    // forward would render a dangling clause.
    const patch = await applyOp(
      { op: 'edit_house_rule', kind: 'always', text: 'Always confirm.' },
      'house_rule:r1'
    );
    expect(patch.houseRules.rules[0]).not.toHaveProperty('trigger');
  });
});
