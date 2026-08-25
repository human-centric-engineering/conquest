/**
 * Apply engine for scope-evaluation findings (F17.21).
 *
 * Turns a finding's structured `proposedEdit` (or the admin's `editedOverride`) into a real edit
 * on the draft version, forking a launched version first — the same fork-if-launched seam every
 * authoring mutation uses (`evaluation-apply.ts`'s posture, mirrored here). The judge's op is an
 * accelerator, not a trust boundary: re-validated here before anything is written. Ops are
 * validated against the ORIGINAL version *before* forking, so a doomed op never strands an
 * orphan draft.
 *
 * Reuses the authoring leaf helpers — `forkVersionIfLaunched`, and the Topics tab's own
 * `patchConditionalTopicsSettings` for every rule/settings op (never the wholesale `replaceTopics`,
 * which would rewrite the whole topic set for a one-field change). A topic-field op writes
 * directly via `appQuestionnaireTopic.update` keyed on `(versionId, key)` — no per-topic writer
 * existed before this; adding one to `topic-routes.ts` would have coupled the bulk-save contract
 * to a single-field write it was never meant to serve.
 *
 * Route-local DB seam: uses `prisma`. The pure staleness/applicability logic lives in
 * `scope-evaluation-staleness.ts`; this file is the I/O.
 */

import type { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import type {
  ScopeProposedEdit,
  ScopeStructureInput,
} from '@/lib/app/questionnaire/scope-evaluation';
import { coerceScopeProposedEdit } from '@/lib/app/questionnaire/scope-evaluation';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { forkVersionIfLaunched } from '@/app/api/v1/app/questionnaires/_lib/fork';
import type { ScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import {
  loadConditionalTopicsSettings,
  patchConditionalTopicsSettings,
} from '@/app/api/v1/app/questionnaires/_lib/topic-routes';
import { deriveScopeFindingState } from '@/app/api/v1/app/questionnaires/_lib/scope-evaluation-staleness';

type DbClient = Prisma.TransactionClient;

/** The finding fields the apply engine needs (a row subset). */
export interface ApplyScopeFindingRow {
  id: string;
  targetKey: string;
  proposedEdit: unknown;
  editedOverride: unknown;
}

/**
 * Find the draft this run is already editing, if any — the same fork-lineage convergence
 * `findRunReviewDraft` gives the design-evaluation panel: repeated applies from one run land on
 * ONE draft rather than re-forking the launched original each time.
 *
 * Exported so the apply route can resolve the correct version to build `current` against
 * *before* calling {@link applyScopeFinding} — see that function's doc for why the route can't
 * just use its own `vid`.
 */
export async function findRunReviewDraft(
  runId: string,
  questionnaireId: string
): Promise<{ id: string; versionNumber: number } | null> {
  const applied = await prisma.appQuestionnaireScopeEvaluationFinding.findFirst({
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

/** Why an apply couldn't proceed (each maps to a 409 with a UI-actionable message). */
export type UnapplicableScopeReason = 'stale' | 'target_gone' | 'op_invalid' | 'needs_authoring';

/** The outcome of an apply attempt. */
export type ApplyScopeOutcome =
  | { status: 'applied'; appliedToVersionId: string; forked: boolean; versionNumber: number }
  | { status: 'unapplicable'; reason: UnapplicableScopeReason; detail?: string };

/** Resolve the op to apply — the admin's edited override wins over the judge's draft. */
export function resolveScopeEffectiveOp(row: ApplyScopeFindingRow): ScopeProposedEdit | null {
  return coerceScopeProposedEdit(row.editedOverride) ?? coerceScopeProposedEdit(row.proposedEdit);
}

/** Audit attribution from the route. */
export interface ApplyScopeAuditContext {
  userId: string;
  clientIp?: string | null;
}

const TOPIC_PREFIX = 'topic:';
const RULE_PREFIX = 'rule:';

/**
 * Validate an op against a concrete version before it is written. Topic ops need the topic to
 * still exist; rule ops need the rule id to still exist. Settings-level additions
 * (`add_rule`/`adjust_budget`/`edit_planner_instructions`/`add_fallback_topic`) always pass — the
 * `settings` blob always exists on a version, and the authoring surface itself is permissive
 * about a rule naming a topic/slot it can't yet see (`validate.ts` warns, never blocks).
 */
async function validateScopeOpAgainst(
  versionId: string,
  op: ScopeProposedEdit,
  targetKey: string
): Promise<UnapplicableScopeReason | null> {
  if (targetKey.startsWith(TOPIC_PREFIX)) {
    const key = targetKey.slice(TOPIC_PREFIX.length);
    const topic = await prisma.appQuestionnaireTopic.findUnique({
      where: { versionId_key: { versionId, key } },
      select: { id: true },
    });
    if (!topic) return 'target_gone';
    return null;
  }
  if (targetKey.startsWith(RULE_PREFIX)) {
    if (op.op !== 'edit_rule' && op.op !== 'delete_rule') return null;
    const id = targetKey.slice(RULE_PREFIX.length);
    const settings = await loadConditionalTopicsSettings(versionId);
    return settings.rules.some((r) => r.id === id) ? null : 'target_gone';
  }
  return null;
}

/**
 * Apply one finding to the (possibly forked) draft version. The caller has already scoped the
 * version and loaded the run's `snapshot` + the live `current` structure (for the apply-time
 * staleness re-check). Returns a discriminated outcome — never throws for an expected
 * unapplicable case.
 *
 * **`current` MUST be built against the version this apply will actually write to** — the run's
 * existing review draft (via {@link findRunReviewDraft}) when one exists, the route's own `vid`
 * only when it doesn't. Building it from `vid` unconditionally would compare the staleness check
 * against the never-touched original every time a launched version has already been forked,
 * silently blinding it to an earlier finding from the SAME run that already edited the draft —
 * a second finding on the same topic/rule would then overwrite the first with no staleness
 * signal. The route resolves this before calling in; see its own comment at the call site.
 */
export async function applyScopeFinding(args: {
  finding: ApplyScopeFindingRow;
  runId: string;
  scoped: ScopedVersion;
  snapshot: ScopeStructureInput | null;
  current: ScopeStructureInput;
  audit: ApplyScopeAuditContext;
}): Promise<ApplyScopeOutcome> {
  const { finding, runId, scoped, snapshot, current, audit } = args;
  const op = resolveScopeEffectiveOp(finding);

  // 1. Prose-only → needs authoring (the admin edits the Topics tab by hand).
  if (!op)
    return { status: 'unapplicable', reason: 'needs_authoring', detail: 'No structured edit' };

  // 2. Apply-time staleness re-check (optimistic concurrency) — the read-time flag may be minutes old.
  const derived = deriveScopeFindingState({ targetKey: finding.targetKey, op }, snapshot, current);
  if (derived.stale) return { status: 'unapplicable', reason: 'stale' };

  // 3. Resolve the editable version: reuse this run's existing review draft, else fork-if-launched
  //    (validating against the pre-fork version first, so a doomed op never strands a draft).
  let editVersionId: string;
  let forked: boolean;
  let editVersionNumber: number;

  const reuseDraft = await findRunReviewDraft(runId, scoped.questionnaireId);
  if (reuseDraft) {
    const reason = await validateScopeOpAgainst(reuseDraft.id, op, finding.targetKey);
    if (reason) return { status: 'unapplicable', reason };
    editVersionId = reuseDraft.id;
    forked = false;
    editVersionNumber = reuseDraft.versionNumber;
  } else {
    const reason = await validateScopeOpAgainst(scoped.id, op, finding.targetKey);
    if (reason) return { status: 'unapplicable', reason };
    const fork = await forkVersionIfLaunched(scoped, {
      userId: audit.userId,
      clientIp: audit.clientIp,
    });
    editVersionId = fork.versionId;
    forked = fork.forked;
    editVersionNumber = fork.versionNumber;
  }

  // 4. Execute the op + stamp the finding applied, in one transaction — mirrors
  //    `evaluation-apply.ts`'s posture exactly, so a crash or client retry between the two writes
  //    can never leave a non-idempotent op (`add_rule` appends unconditionally) applied twice
  //    while the finding still reads as pending.
  let written: UnapplicableScopeReason | null = null;
  await prisma.$transaction(async (tx) => {
    written = await writeScopeOp(tx, editVersionId, op, finding.targetKey);
    if (written) return;
    await tx.appQuestionnaireScopeEvaluationFinding.update({
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
    action: 'questionnaire_scope_evaluation_finding.apply',
    entityType: 'questionnaire_scope_evaluation_finding',
    entityId: finding.id,
    metadata: {
      op: op.op,
      targetKey: finding.targetKey,
      appliedToVersionId: editVersionId,
      forked,
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

/**
 * Write one validated op to the editable version. Returns an {@link UnapplicableScopeReason} when
 * the write can't proceed (a race removed the target between validation and write), or `null` on
 * success. `tx` is the transaction client the caller opened around this write + the finding stamp
 * (see {@link applyScopeFinding}) — every Prisma call in here MUST go through it, never the bare
 * `prisma` singleton, or it would run outside the transaction and defeat the point of opening one.
 */
async function writeScopeOp(
  tx: DbClient,
  editVersionId: string,
  op: ScopeProposedEdit,
  targetKey: string
): Promise<UnapplicableScopeReason | null> {
  switch (op.op) {
    case 'edit_topic_criteria':
    case 'edit_topic_depth': {
      const key = targetKey.slice(TOPIC_PREFIX.length);
      try {
        await tx.appQuestionnaireTopic.update({
          where: { versionId_key: { versionId: editVersionId, key } },
          // `source: 'manual'` — same rule `replaceTopics` follows: once an admin-approved apply
          // has touched this topic, calling it an untouched auto-seed would be a lie.
          data:
            op.op === 'edit_topic_criteria'
              ? { criteria: op.criteria, source: 'manual' }
              : { depth: op.depth, source: 'manual' },
        });
      } catch (err) {
        logger.error('apply_scope_finding: topic write failed', {
          editVersionId,
          key,
          error: err instanceof Error ? err.message : String(err),
        });
        return 'target_gone';
      }
      return null;
    }

    case 'add_rule': {
      const settings = await loadConditionalTopicsSettings(editVersionId, tx);
      await patchConditionalTopicsSettings(
        editVersionId,
        {
          rules: [
            ...settings.rules,
            {
              dataSlotKey: op.dataSlotKey,
              operator: op.operator,
              value: op.value,
              action: op.action,
              topicKey: op.topicKey,
            },
          ],
        },
        tx
      );
      return null;
    }

    case 'edit_rule':
    case 'delete_rule': {
      const id = targetKey.slice(RULE_PREFIX.length);
      const settings = await loadConditionalTopicsSettings(editVersionId, tx);
      const exists = settings.rules.some((r) => r.id === id);
      if (!exists) return 'target_gone';
      const rules =
        op.op === 'delete_rule'
          ? settings.rules.filter((r) => r.id !== id)
          : settings.rules.map((r) =>
              r.id === id
                ? {
                    id: r.id,
                    dataSlotKey: op.dataSlotKey,
                    operator: op.operator,
                    value: op.value,
                    action: op.action,
                    topicKey: op.topicKey,
                  }
                : r
            );
      await patchConditionalTopicsSettings(editVersionId, { rules }, tx);
      return null;
    }

    case 'adjust_budget': {
      await patchConditionalTopicsSettings(
        editVersionId,
        {
          ...(op.sessionBudgetSeconds !== undefined
            ? { sessionBudgetSeconds: op.sessionBudgetSeconds }
            : {}),
          ...(op.maxOpeningProbes !== undefined ? { maxOpeningProbes: op.maxOpeningProbes } : {}),
          ...(op.maxConditionalTopics !== undefined
            ? { maxConditionalTopics: op.maxConditionalTopics }
            : {}),
        },
        tx
      );
      return null;
    }

    case 'edit_planner_instructions': {
      await patchConditionalTopicsSettings(
        editVersionId,
        { plannerInstructions: op.plannerInstructions },
        tx
      );
      return null;
    }

    case 'add_fallback_topic': {
      const settings = await loadConditionalTopicsSettings(editVersionId, tx);
      if (settings.fallbackTopicKeys.includes(op.topicKey)) return null; // already there
      await patchConditionalTopicsSettings(
        editVersionId,
        { fallbackTopicKeys: [...settings.fallbackTopicKeys, op.topicKey] },
        tx
      );
      return null;
    }
  }
}
