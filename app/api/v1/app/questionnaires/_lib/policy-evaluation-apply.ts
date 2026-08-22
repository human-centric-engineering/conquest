/**
 * Apply one interviewer-policy finding to a version (F18.8).
 *
 * Mirrors `scope-evaluation-apply.ts` in posture, and inherits its three hard-won rules:
 *
 * 1. **`current` is built against the version this apply will actually write to** — the run's
 *    existing review draft when one exists, the route's `vid` only when it does not. This matters
 *    MORE here than on either sibling: one run routinely yields many `set_question_fidelity`
 *    findings, so multi-apply-per-run is the normal path, and three of the four dimensions can
 *    target the same field. Compare against the untouched original and the staleness check is blind
 *    to an earlier finding from the same run — the second apply silently overwrites the first.
 * 2. **The op write and the `applied` stamp share one transaction.** `writePolicyOp` takes the
 *    transaction client as its FIRST parameter so the mistake is hard to write. The named
 *    non-idempotent op is `add_house_rule`, which appends unconditionally: a crash between the two
 *    writes would leave a duplicate rule while the finding still read `pending`.
 * 3. **There is no provenance column to stamp, and that is the trap.** The scope panel could set
 *    `source: 'manual'` on an applied topic; neither `AppQuestionSlot` nor a house rule carries an
 *    equivalent. So the audit log is the ONLY record that an AI suggestion — not a human — chose
 *    this value, which makes `logAdminAction` load-bearing rather than decorative, and makes
 *    `previousValue` in its metadata mandatory: for the enum and number ops the change is otherwise
 *    unreconstructible from history (you can see a fidelity was set, not what it was set *from*).
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import {
  coercePolicyProposedEdit,
  type PolicyProposedEdit,
  type PolicyStructureInput,
} from '@/lib/app/questionnaire/policy-evaluation';
import {
  clampQuestionFidelity,
  TONE_LEVEL_MAX,
  TONE_LEVEL_MIN,
} from '@/lib/app/questionnaire/types';
import { narrowPersonaSelection } from '@/lib/app/questionnaire/persona/settings';
import { forkVersionIfLaunched } from '@/app/api/v1/app/questionnaires/_lib/fork';
import type { ScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import {
  loadVersionConfigBlocks,
  patchVersionConfigBlocks,
} from '@/app/api/v1/app/questionnaires/_lib/config-routes';
import { derivePolicyFindingState } from '@/app/api/v1/app/questionnaires/_lib/policy-evaluation-staleness';

/** Any Prisma client — the base one, or a transaction client. */
type DbClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

const HOUSE_RULE_PREFIX = 'house_rule:';
const QUESTION_PREFIX = 'question:';

/** The finding row fields the apply engine needs. */
export interface ApplyPolicyFindingRow {
  id: string;
  targetKey: string;
  proposedEdit: unknown;
  editedOverride: unknown;
}

/** Why an apply could not proceed (each maps to a 409 with a UI-actionable message). */
export type UnapplicablePolicyReason = 'stale' | 'target_gone' | 'op_invalid' | 'needs_authoring';

export type ApplyPolicyOutcome =
  | { status: 'applied'; appliedToVersionId: string; forked: boolean; versionNumber: number }
  | { status: 'unapplicable'; reason: UnapplicablePolicyReason; detail?: string };

export interface ApplyPolicyAuditContext {
  userId: string;
  clientIp?: string | null;
}

/** Resolve the op to apply — the admin's edited override wins over the judge's draft. */
export function resolvePolicyEffectiveOp(row: ApplyPolicyFindingRow): PolicyProposedEdit | null {
  return coercePolicyProposedEdit(row.editedOverride) ?? coercePolicyProposedEdit(row.proposedEdit);
}

/**
 * Find the draft this run has already been applied into, so a second apply lands on the same
 * version rather than forking again. Ported verbatim from the scope panel — see rule 1 above for
 * why it is more load-bearing here.
 */
export async function findRunReviewDraft(
  runId: string,
  questionnaireId: string
): Promise<{ id: string; versionNumber: number } | null> {
  const applied = await prisma.appQuestionnairePolicyEvaluationFinding.findFirst({
    where: { runId, appliedToVersionId: { not: null } },
    orderBy: { appliedAt: 'desc' },
    select: { appliedToVersionId: true },
  });
  if (!applied?.appliedToVersionId) return null;
  return prisma.appQuestionnaireVersion.findFirst({
    where: { id: applied.appliedToVersionId, questionnaireId, status: 'draft' },
    select: { id: true, versionNumber: true },
  });
}

/**
 * Validate an op against a concrete version BEFORE the fork, so a doomed op never strands an
 * orphan draft. Two classes are checked:
 *
 * - the target must still exist (a rule id, a question key);
 * - two ops would deterministically CREATE a conflict the mechanical checker already warns about,
 *   and are refused rather than applied. Text edits are deliberately NOT blocked — the conflict
 *   checker's own governing rules are "never emit error" and "prefer a missed warning to a noisy
 *   one", so a blocking gate driven by keyword matching would violate both.
 */
async function validatePolicyOpAgainst(
  versionId: string,
  op: PolicyProposedEdit,
  targetKey: string
): Promise<{ reason: UnapplicablePolicyReason; detail?: string } | null> {
  if (targetKey.startsWith(HOUSE_RULE_PREFIX)) {
    const id = targetKey.slice(HOUSE_RULE_PREFIX.length);
    const blocks = await loadVersionConfigBlocks(versionId);
    if (!blocks.houseRules.rules.some((r) => r.id === id)) return { reason: 'target_gone' };
  }

  if (op.op === 'set_question_fidelity') {
    const key = targetKey.startsWith(QUESTION_PREFIX)
      ? targetKey.slice(QUESTION_PREFIX.length)
      : null;
    if (!key) return { reason: 'op_invalid', detail: 'This change needs a question to apply to' };
    const slot = await prisma.appQuestionSlot.findUnique({
      where: { versionId_key: { versionId, key } },
      select: { id: true },
    });
    if (!slot) return { reason: 'target_gone' };
  }

  if (op.op === 'set_opening_mode' && op.openingMode === 'examples') {
    const blocks = await loadVersionConfigBlocks(versionId);
    const usable = blocks.interviewerStrategy.openingExamples.filter((e) => e.trim() !== '');
    if (usable.length === 0) {
      return {
        reason: 'op_invalid',
        detail: 'There are no example openings written, so this setting would have no effect',
      };
    }
  }

  if (op.op === 'set_tone_dimension') {
    const config = await prisma.appQuestionnaireConfig.findUnique({
      where: { versionId },
      select: { personaSelection: true },
    });
    // Through the shared narrower, not a hand-rolled shape check — it is the one definition of
    // what this opaque Json column means, and it repairs a partial or legacy blob rather than
    // reading `undefined` off it.
    if (narrowPersonaSelection(config?.personaSelection).enabled) {
      return {
        reason: 'op_invalid',
        detail: 'A chosen persona replaces this version’s tone dials, so this would have no effect',
      };
    }
  }

  return null;
}

/**
 * Apply one finding to the (possibly forked) draft version. Returns a discriminated outcome — it
 * never throws for an expected unapplicable case.
 */
export async function applyPolicyFinding(args: {
  finding: ApplyPolicyFindingRow;
  runId: string;
  scoped: ScopedVersion;
  snapshot: PolicyStructureInput | null;
  current: PolicyStructureInput;
  audit: ApplyPolicyAuditContext;
}): Promise<ApplyPolicyOutcome> {
  const { finding, runId, scoped, snapshot, current, audit } = args;
  const op = resolvePolicyEffectiveOp(finding);

  // 1. Prose-only → the admin makes the change by hand on the Settings tab.
  if (!op) {
    return { status: 'unapplicable', reason: 'needs_authoring', detail: 'No structured edit' };
  }

  // 2. Apply-time staleness re-check — the read-time flag may be minutes old, and with this panel's
  //    same-field collisions it is the only thing stopping a silent overwrite.
  const derived = derivePolicyFindingState({ targetKey: finding.targetKey, op }, snapshot, current);
  if (derived.stale) return { status: 'unapplicable', reason: 'stale' };

  // 3. Resolve the editable version: reuse this run's existing review draft, else fork-if-launched.
  let editVersionId: string;
  let forked: boolean;
  let editVersionNumber: number;

  const reuseDraft = await findRunReviewDraft(runId, scoped.questionnaireId);
  if (reuseDraft) {
    const invalid = await validatePolicyOpAgainst(reuseDraft.id, op, finding.targetKey);
    if (invalid) return { status: 'unapplicable', ...invalid };
    editVersionId = reuseDraft.id;
    forked = false;
    editVersionNumber = reuseDraft.versionNumber;
  } else {
    const invalid = await validatePolicyOpAgainst(scoped.id, op, finding.targetKey);
    if (invalid) return { status: 'unapplicable', ...invalid };
    const fork = await forkVersionIfLaunched(scoped, {
      userId: audit.userId,
      clientIp: audit.clientIp,
    });
    editVersionId = fork.versionId;
    forked = fork.forked;
    editVersionNumber = fork.versionNumber;
  }

  // The value being replaced, captured before the write. There is no provenance column on the rows
  // this panel edits, so this is the only record of what an applied AI suggestion changed FROM.
  const previousValue = await readPreviousValue(editVersionId, op, finding.targetKey);

  // 4. Write the op and stamp the finding, in one transaction. See rule 2 in the module doc.
  let written: UnapplicablePolicyReason | null = null;
  await prisma.$transaction(async (tx) => {
    written = await writePolicyOp(tx, editVersionId, op, finding.targetKey);
    if (written) return;
    await tx.appQuestionnairePolicyEvaluationFinding.update({
      where: { id: finding.id },
      data: {
        status: 'applied',
        appliedAt: new Date(),
        appliedToVersionId: editVersionId,
        decidedByUserId: audit.userId,
        decidedAt: new Date(),
      },
    });
  });
  if (written) return { status: 'unapplicable', reason: written };

  logAdminAction({
    userId: audit.userId,
    action: 'questionnaire_policy_evaluation_finding.apply',
    entityType: 'questionnaire_policy_evaluation_finding',
    entityId: finding.id,
    metadata: {
      op: op.op,
      targetKey: finding.targetKey,
      appliedToVersionId: editVersionId,
      forked,
      // Mandatory, not decorative — see rule 3 in the module doc.
      previousValue,
    },
    clientIp: audit.clientIp ?? null,
  });

  return {
    status: 'applied',
    appliedToVersionId: editVersionId,
    forked,
    versionNumber: editVersionNumber,
  };
}

/** Read the value an op is about to replace, for the audit trail. Best-effort; never throws. */
async function readPreviousValue(
  versionId: string,
  op: PolicyProposedEdit,
  targetKey: string
): Promise<unknown> {
  try {
    const blocks = await loadVersionConfigBlocks(versionId);
    switch (op.op) {
      case 'set_approach':
        return blocks.interviewerStrategy.approach;
      case 'set_pace':
        return blocks.interviewerStrategy.pace;
      case 'set_opening_mode':
        return blocks.interviewerStrategy.openingMode;
      case 'set_tactics':
        return {
          probeDepth: blocks.interviewerStrategy.probeDepth,
          reflect: blocks.interviewerStrategy.reflect,
          batchRelated: blocks.interviewerStrategy.batchRelated,
        };
      case 'set_fidelity_enabled':
        return blocks.questionFidelity.enabled;
      case 'set_default_fidelity':
        return blocks.questionFidelity.defaultFidelity;
      case 'set_tone_dimension':
        return blocks.tone[op.dimension];
      case 'set_question_fidelity': {
        const key = targetKey.slice(QUESTION_PREFIX.length);
        const slot = await prisma.appQuestionSlot.findUnique({
          where: { versionId_key: { versionId, key } },
          select: { fidelity: true },
        });
        return slot?.fidelity ?? null;
      }
      case 'edit_house_rule':
      case 'set_house_rule_enabled':
      case 'delete_house_rule': {
        const id = targetKey.slice(HOUSE_RULE_PREFIX.length);
        return blocks.houseRules.rules.find((r) => r.id === id) ?? null;
      }
      case 'add_house_rule':
        return null; // nothing is being replaced
    }
  } catch (err) {
    logger.error('apply_policy_finding: previous-value read failed', {
      versionId,
      op: op.op,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Write one validated op to the editable version.
 *
 * `tx` is FIRST, and every Prisma call in here must go through it — using the bare `prisma`
 * singleton would run the write outside the transaction the caller opened and defeat the point.
 */
async function writePolicyOp(
  tx: DbClient,
  editVersionId: string,
  op: PolicyProposedEdit,
  targetKey: string
): Promise<UnapplicablePolicyReason | null> {
  // The one op writing outside the config JSON.
  if (op.op === 'set_question_fidelity') {
    const key = targetKey.slice(QUESTION_PREFIX.length);
    try {
      // By `(versionId, key)`, never by row id: after a fork the ids are new but `copyVersionGraph`
      // preserves the key 1:1 (and copies `fidelity` with it).
      await tx.appQuestionSlot.update({
        where: { versionId_key: { versionId: editVersionId, key } },
        data: { fidelity: clampQuestionFidelity(op.fidelity) },
      });
    } catch (err) {
      logger.error('apply_policy_finding: question fidelity write failed', {
        editVersionId,
        key,
        error: err instanceof Error ? err.message : String(err),
      });
      return 'target_gone';
    }
    return null;
  }

  const blocks = await loadVersionConfigBlocks(editVersionId, tx);

  switch (op.op) {
    case 'edit_house_rule':
    case 'set_house_rule_enabled':
    case 'delete_house_rule': {
      const id = targetKey.slice(HOUSE_RULE_PREFIX.length);
      const index = blocks.houseRules.rules.findIndex((r) => r.id === id);
      if (index === -1) return 'target_gone';
      const rules = [...blocks.houseRules.rules];
      if (op.op === 'delete_house_rule') {
        rules.splice(index, 1);
      } else if (op.op === 'set_house_rule_enabled') {
        rules[index] = { ...rules[index], enabled: op.enabled };
      } else {
        // `id` and `enabled` are preserved from the live rule — a judge proposes the authored
        // fields only, so an apply can never silently re-key or re-enable a parked rule.
        rules[index] = {
          id: rules[index].id,
          enabled: rules[index].enabled,
          kind: op.kind,
          text: op.text,
          ...(op.kind === 'if_asked' && op.trigger ? { trigger: op.trigger } : {}),
        };
      }
      await patchVersionConfigBlocks(
        editVersionId,
        { houseRules: { ...blocks.houseRules, rules } },
        tx
      );
      return null;
    }

    case 'add_house_rule': {
      // Non-idempotent: this appends. It is why the write and the stamp share a transaction.
      const rules = [
        ...blocks.houseRules.rules,
        {
          id: `rule-${Date.now()}-${blocks.houseRules.rules.length}`,
          kind: op.kind,
          enabled: true,
          text: op.text,
          ...(op.kind === 'if_asked' && op.trigger ? { trigger: op.trigger } : {}),
        },
      ];
      await patchVersionConfigBlocks(
        editVersionId,
        { houseRules: { ...blocks.houseRules, rules } },
        tx
      );
      return null;
    }

    case 'set_approach':
      await patchVersionConfigBlocks(
        editVersionId,
        { interviewerStrategy: { ...blocks.interviewerStrategy, approach: op.approach } },
        tx
      );
      return null;

    case 'set_pace':
      await patchVersionConfigBlocks(
        editVersionId,
        { interviewerStrategy: { ...blocks.interviewerStrategy, pace: op.pace } },
        tx
      );
      return null;

    case 'set_opening_mode':
      await patchVersionConfigBlocks(
        editVersionId,
        { interviewerStrategy: { ...blocks.interviewerStrategy, openingMode: op.openingMode } },
        tx
      );
      return null;

    case 'set_tactics':
      await patchVersionConfigBlocks(
        editVersionId,
        {
          interviewerStrategy: {
            ...blocks.interviewerStrategy,
            ...(op.probeDepth !== undefined ? { probeDepth: op.probeDepth } : {}),
            ...(op.reflect !== undefined ? { reflect: op.reflect } : {}),
            ...(op.batchRelated !== undefined ? { batchRelated: op.batchRelated } : {}),
          },
        },
        tx
      );
      return null;

    case 'set_fidelity_enabled':
      await patchVersionConfigBlocks(
        editVersionId,
        { questionFidelity: { ...blocks.questionFidelity, enabled: op.enabled } },
        tx
      );
      return null;

    case 'set_default_fidelity':
      await patchVersionConfigBlocks(
        editVersionId,
        {
          questionFidelity: {
            ...blocks.questionFidelity,
            defaultFidelity: clampQuestionFidelity(op.defaultFidelity),
          },
        },
        tx
      );
      return null;

    case 'set_tone_dimension': {
      const current = blocks.tone[op.dimension];
      await patchVersionConfigBlocks(
        editVersionId,
        {
          tone: {
            ...blocks.tone,
            [op.dimension]: {
              enabled: op.enabled,
              level:
                op.level !== undefined
                  ? Math.min(TONE_LEVEL_MAX, Math.max(TONE_LEVEL_MIN, op.level))
                  : current.level,
            },
          },
        },
        tx
      );
      return null;
    }

    default:
      return 'op_invalid';
  }
}
