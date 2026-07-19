/**
 * Apply engine for design-evaluation findings (F5.3).
 *
 * Turns a finding's structured `proposedEdit` (or the admin's `editedOverride`) into a real
 * edit on the draft version, forking a launched version first — the same fork-if-launched seam
 * every authoring mutation uses. The judge's op is an **accelerator, not a trust boundary**: it
 * was prompt-guided, never provider-enforced, so every op is re-validated here exactly like a
 * hand authoring edit (`validateTypeConfig`, target resolution, ordinal bounds) before anything
 * is written. Ops are validated against the ORIGINAL version *before* forking, so a doomed op
 * never leaves an orphan draft (the `assertKeyAvailable` posture from the question route).
 *
 * Reuses the authoring leaf helpers (`validateTypeConfig`, `forkVersionIfLaunched`, the
 * provenance stamps, `jsonInput`) rather than the F2.1 HTTP handlers — the load-bearing
 * validation is shared; only the targetKey→entity resolution is apply-specific (a finding
 * addresses its target by key/title, not by a URL id).
 *
 * Route-local DB seam: uses `prisma`. The pure staleness/applicability logic lives in
 * `evaluation-staleness.ts`; this file is the I/O.
 */

import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import {
  defaultTypeConfig,
  nextAvailableKey,
  slugifyKey,
  validateTypeConfig,
} from '@/lib/app/questionnaire/authoring';
import {
  coerceProposedEdit,
  parseAudienceShape,
  type ProposedEdit,
  type VersionStructureInput,
} from '@/lib/app/questionnaire/evaluation';
import type {
  AudienceProvenance,
  AudienceShape,
  FieldProvenance,
} from '@/lib/app/questionnaire/types';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { forkVersionIfLaunched } from '@/app/api/v1/app/questionnaires/_lib/fork';
import {
  audienceProvenanceForEdit,
  goalProvenanceForEdit,
  type ScopedVersion,
} from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import { jsonInput } from '@/app/api/v1/app/_lib/prisma-json';
import { deriveFindingState } from '@/app/api/v1/app/questionnaires/_lib/evaluation-staleness';

/** The finding fields the apply engine needs (a row subset). */
export interface ApplyFindingRow {
  id: string;
  targetKey: string;
  proposedEdit: unknown;
  editedOverride: unknown;
}

/**
 * Find the draft this run is already editing, if any — the most recently applied finding's
 * `appliedToVersionId`, when it still resolves to a `draft` version of this questionnaire. This
 * is what makes repeated applies from one run converge on a SINGLE draft instead of re-forking
 * the launched original each time (the F5.3 fork-lineage rule). Returns `null` when no prior
 * apply has a live draft target — the first apply then forks (launched) or edits in place (draft).
 */
async function findRunReviewDraft(
  runId: string,
  questionnaireId: string
): Promise<{ id: string; versionNumber: number } | null> {
  const applied = await prisma.appQuestionnaireEvaluationFinding.findFirst({
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
 * Validate an op against a concrete version (slot exists, type config valid, section
 * unambiguous). Returns the blocking reason or `null` when the op is applyable there. Version
 * ops (`edit_goal`/`edit_audience`) always pass — they target the version row itself.
 */
async function validateOpAgainst(
  versionId: string,
  op: Exclude<ProposedEdit, { op: 'add_question' }>,
  targetKey: string
): Promise<UnapplicableReason | null> {
  if (op.op === 'edit_goal' || op.op === 'edit_audience') return null;

  const slot = await prisma.appQuestionSlot.findFirst({
    where: { versionId, key: targetKey },
    select: { id: true },
  });
  if (!slot) return 'target_gone';

  if (op.op === 'change_type' && !validateTypeConfig(op.type, op.typeConfig).ok) {
    return 'op_invalid';
  }
  if (op.op === 'reorder' && op.targetSectionKey) {
    const matches = await prisma.appQuestionnaireSection.count({
      where: { versionId, title: op.targetSectionKey },
    });
    if (matches === 0) return 'target_gone';
    if (matches > 1) return 'op_invalid';
  }
  return null;
}

/** Why an apply couldn't proceed (each maps to a 409 with a UI-actionable message). */
export type UnapplicableReason = 'stale' | 'target_gone' | 'op_invalid' | 'needs_authoring';

/** The outcome of an apply attempt. */
export type ApplyOutcome =
  | { status: 'applied'; appliedToVersionId: string; forked: boolean; versionNumber: number }
  | { status: 'unapplicable'; reason: UnapplicableReason; detail?: string };

/** Resolve the op to apply — the admin's edited override wins over the judge's draft. */
export function resolveEffectiveOp(row: ApplyFindingRow): ProposedEdit | null {
  return coerceProposedEdit(row.editedOverride) ?? coerceProposedEdit(row.proposedEdit);
}

/** Audit attribution from the route. */
export interface ApplyAuditContext {
  userId: string;
  clientIp?: string | null;
}

/**
 * Apply one finding to the (possibly forked) draft version. The caller has already scoped the
 * version and loaded the run's `snapshot` + the live `current` structure (for the apply-time
 * staleness re-check). Returns a discriminated outcome — never throws for an expected
 * unapplicable case (stale / target gone / invalid op / needs authoring).
 */
export async function applyFinding(args: {
  finding: ApplyFindingRow;
  runId: string;
  scoped: ScopedVersion;
  snapshot: VersionStructureInput | null;
  current: VersionStructureInput;
  audit: ApplyAuditContext;
}): Promise<ApplyOutcome> {
  const { finding, runId, scoped, snapshot, current, audit } = args;
  const op = resolveEffectiveOp(finding);

  // 1. Prose-only → needs authoring (the UI deep-links the editor with the prose suggestion).
  if (!op)
    return { status: 'unapplicable', reason: 'needs_authoring', detail: 'No structured edit' };

  // An `add_question` draft is created (not edited in place), so it has its own apply path: it
  // resolves a *section* target rather than a slot, and derives a fresh key. The "Open in editor"
  // deep-link routes to the same draft when the admin wants to refine the wording first.
  if (op.op === 'add_question') {
    return applyAddQuestion({ finding, op, runId, scoped, audit });
  }

  // 2. Apply-time staleness re-check (optimistic concurrency) — the read-time flag may be minutes old.
  const derived = deriveFindingState({ targetKey: finding.targetKey, op }, snapshot, current);
  if (derived.stale) return { status: 'unapplicable', reason: 'stale' };

  // 3. Resolve the editable version. If a prior apply from THIS run already forked (or edited) a
  //    live draft, keep editing it — repeated applies converge on one draft rather than re-forking
  //    the launched original each time. Otherwise fork-if-launched (validating against the original
  //    BEFORE forking, so a doomed op never strands an orphan draft).
  let editVersionId: string;
  let forked: boolean;
  let editVersionNumber: number;

  const reuseDraft = await findRunReviewDraft(runId, scoped.questionnaireId);
  if (reuseDraft) {
    const reason = await validateOpAgainst(reuseDraft.id, op, finding.targetKey);
    if (reason) return { status: 'unapplicable', reason };
    editVersionId = reuseDraft.id;
    forked = false;
    editVersionNumber = reuseDraft.versionNumber;
  } else {
    const reason = await validateOpAgainst(scoped.id, op, finding.targetKey);
    if (reason) return { status: 'unapplicable', reason };
    const fork = await forkVersionIfLaunched(scoped, {
      userId: audit.userId,
      clientIp: audit.clientIp,
    });
    editVersionId = fork.versionId;
    forked = fork.forked;
    editVersionNumber = fork.versionNumber;
  }

  // 4. Retarget the slot on the editable version (keys are preserved 1:1 across a fork).
  const isVersionOp = op.op === 'edit_goal' || op.op === 'edit_audience';
  let editSlotId: string | null = null;
  if (!isVersionOp) {
    const slot = await prisma.appQuestionSlot.findFirst({
      where: { versionId: editVersionId, key: finding.targetKey },
      select: { id: true },
    });
    if (!slot) {
      logger.error('evaluation apply: slot not on editable version', {
        findingId: finding.id,
        editVersionId,
        key: finding.targetKey,
      });
      return { status: 'unapplicable', reason: 'target_gone' };
    }
    editSlotId = slot.id;
  }

  // 5. Execute the op + stamp the finding applied, in one transaction.
  await prisma.$transaction(async (tx) => {
    await writeOp(tx, op, { editVersionId, editSlotId });
    await tx.appQuestionnaireEvaluationFinding.update({
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

  logAdminAction({
    userId: audit.userId,
    action: 'questionnaire_evaluation_finding.apply',
    entityType: 'questionnaire_evaluation_finding',
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

/** The `section:` prefix a finding's `targetKey` uses to address a section by title. */
const SECTION_PREFIX = 'section:';

/** The section title an `add_question` targets, from the op's `sectionKey` or a `section:` target. */
function resolveTargetSectionTitle(
  op: Extract<ProposedEdit, { op: 'add_question' }>,
  targetKey: string
): string | null {
  if (op.sectionKey) return op.sectionKey;
  return targetKey.startsWith(SECTION_PREFIX) ? targetKey.slice(SECTION_PREFIX.length) : null;
}

/**
 * Validate the section an `add_question` will land in, on a concrete version. A named title must
 * resolve to exactly one section (gone → `target_gone`, ambiguous → `op_invalid`); an unnamed draft
 * appends to the last section and only fails when the version has no sections at all (→ needs
 * authoring: the admin must add a section first). Returns the blocking reason, or `null` when clear.
 */
async function validateSectionTarget(
  versionId: string,
  title: string | null
): Promise<UnapplicableReason | null> {
  if (title !== null) {
    const matches = await prisma.appQuestionnaireSection.count({ where: { versionId, title } });
    if (matches === 0) return 'target_gone';
    if (matches > 1) return 'op_invalid';
    return null;
  }
  const any = await prisma.appQuestionnaireSection.count({ where: { versionId } });
  return any === 0 ? 'needs_authoring' : null;
}

/**
 * Apply an `add_question` finding: create the drafted question on the (possibly forked) draft and
 * stamp the finding applied. Unlike the in-place ops, the judge's draft carries no ids — the
 * section is resolved by title (or the last section), the `key` is derived from the prompt, and the
 * `typeConfig` falls back to the type's default when the judge's draft omitted/botched it (so a
 * one-click add of a choice question lands with placeholder options the admin refines in the
 * editor). Same fork-lineage convergence + validate-before-fork discipline as {@link applyFinding}.
 */
async function applyAddQuestion(args: {
  finding: ApplyFindingRow;
  op: Extract<ProposedEdit, { op: 'add_question' }>;
  runId: string;
  scoped: ScopedVersion;
  audit: ApplyAuditContext;
}): Promise<ApplyOutcome> {
  const { finding, op, runId, scoped, audit } = args;

  // Validate (and default) the drafted type config before any write — the question-route boundary.
  let tc = validateTypeConfig(op.type, op.typeConfig);
  if (!tc.ok) tc = validateTypeConfig(op.type, defaultTypeConfig(op.type));
  if (!tc.ok) return { status: 'unapplicable', reason: 'op_invalid' };

  const title = resolveTargetSectionTitle(op, finding.targetKey);

  // Resolve the editable version: reuse this run's existing review draft, else fork-if-launched.
  // Validate the section target on the pre-fork version first, so a doomed add never strands a draft.
  const reuseDraft = await findRunReviewDraft(runId, scoped.questionnaireId);
  const reason = await validateSectionTarget(reuseDraft?.id ?? scoped.id, title);
  if (reason) return { status: 'unapplicable', reason };

  let editVersionId: string;
  let forked: boolean;
  let editVersionNumber: number;
  if (reuseDraft) {
    editVersionId = reuseDraft.id;
    forked = false;
    editVersionNumber = reuseDraft.versionNumber;
  } else {
    const fork = await forkVersionIfLaunched(scoped, {
      userId: audit.userId,
      clientIp: audit.clientIp,
    });
    editVersionId = fork.versionId;
    forked = fork.forked;
    editVersionNumber = fork.versionNumber;
  }

  // Resolve the concrete section on the editable version (by title — fork-stable — or the last one).
  const section = title
    ? await prisma.appQuestionnaireSection.findFirst({
        where: { versionId: editVersionId, title },
        select: { id: true },
      })
    : await prisma.appQuestionnaireSection.findFirst({
        where: { versionId: editVersionId },
        orderBy: { ordinal: 'desc' },
        select: { id: true },
      });
  if (!section) return { status: 'unapplicable', reason: 'target_gone' };

  // Prefer the judge's concise `key` (slugified so "Work morale" → `work_morale`); fall back to the
  // prompt. Either way it's collision-suffixed against the version's keys — a suggestion, never an
  // admin-chosen explicit key, so we disambiguate rather than 409 on clash.
  const existingKeys = await prisma.appQuestionSlot.findMany({
    where: { versionId: editVersionId },
    select: { key: true },
  });
  const key = nextAvailableKey(
    slugifyKey(op.key ?? op.prompt),
    new Set(existingKeys.map((e) => e.key))
  );
  const ordinal = await prisma.appQuestionSlot.count({ where: { sectionId: section.id } });
  const typeConfigData = tc.value == null ? Prisma.JsonNull : jsonInput(tc.value);

  await prisma.$transaction(async (tx) => {
    await tx.appQuestionSlot.create({
      data: {
        versionId: editVersionId,
        sectionId: section.id,
        ordinal,
        key,
        prompt: op.prompt,
        type: op.type,
        required: false,
        weight: 0.5,
        typeConfig: typeConfigData,
        ...(op.guidelines != null ? { guidelines: op.guidelines } : {}),
      },
    });
    await tx.appQuestionnaireEvaluationFinding.update({
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

  logAdminAction({
    userId: audit.userId,
    action: 'questionnaire_evaluation_finding.apply',
    entityType: 'questionnaire_evaluation_finding',
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

/** Execute one validated op against the editable version. Slot ops use the retargeted slot id. */
async function writeOp(
  tx: Prisma.TransactionClient,
  op: Exclude<ProposedEdit, { op: 'add_question' }>,
  ctx: { editVersionId: string; editSlotId: string | null }
): Promise<void> {
  switch (op.op) {
    case 'replace_prompt':
      await tx.appQuestionSlot.update({
        where: { id: ctx.editSlotId! },
        data: { prompt: op.prompt },
      });
      return;
    case 'edit_guidelines':
      await tx.appQuestionSlot.update({
        where: { id: ctx.editSlotId! },
        data: { guidelines: op.guidelines },
      });
      return;
    case 'change_type': {
      // Re-validate here too (cheap) so the write path is self-contained; reset config to the
      // new type's default when the op carries none (the question route's reset semantics).
      const tc = validateTypeConfig(op.type, op.typeConfig);
      const typeConfigData = !tc.ok || tc.value == null ? Prisma.JsonNull : jsonInput(tc.value);
      await tx.appQuestionSlot.update({
        where: { id: ctx.editSlotId! },
        data: { type: op.type, typeConfig: typeConfigData },
      });
      return;
    }
    case 'delete_question':
      await tx.appQuestionSlot.delete({ where: { id: ctx.editSlotId! } });
      return;
    case 'reorder': {
      const data: Prisma.AppQuestionSlotUpdateInput = { ordinal: op.ordinal };
      if (op.targetSectionKey) {
        const section = await tx.appQuestionnaireSection.findFirst({
          where: { versionId: ctx.editVersionId, title: op.targetSectionKey },
          select: { id: true },
        });
        if (section) data.section = { connect: { id: section.id } };
      }
      await tx.appQuestionSlot.update({ where: { id: ctx.editSlotId! }, data });
      return;
    }
    case 'edit_goal': {
      const version = await tx.appQuestionnaireVersion.findUniqueOrThrow({
        where: { id: ctx.editVersionId },
        select: { goal: true, goalProvenance: true },
      });
      await tx.appQuestionnaireVersion.update({
        where: { id: ctx.editVersionId },
        data: {
          goal: op.goal,
          goalProvenance: goalProvenanceForEdit(
            op.goal,
            version.goal,
            version.goalProvenance as FieldProvenance | null
          ),
        },
      });
      return;
    }
    case 'edit_audience': {
      const version = await tx.appQuestionnaireVersion.findUniqueOrThrow({
        where: { id: ctx.editVersionId },
        select: { audience: true, audienceProvenance: true },
      });
      const prevAudience = parseAudienceShape(version.audience);
      // Merge-patch: only the named sub-fields change; the rest of the stored audience is kept.
      const nextAudience: AudienceShape = { ...(prevAudience ?? {}), ...op.audience };
      const prevProvenance = (version.audienceProvenance as AudienceProvenance | null) ?? null;
      await tx.appQuestionnaireVersion.update({
        where: { id: ctx.editVersionId },
        data: {
          audience: jsonInput(nextAudience),
          audienceProvenance: jsonInput(
            audienceProvenanceForEdit(nextAudience, prevAudience, prevProvenance)
          ),
        },
      });
      return;
    }
  }
}
