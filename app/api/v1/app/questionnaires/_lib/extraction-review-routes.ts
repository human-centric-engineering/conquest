/**
 * Shared glue for the extraction-change review routes (F2.3).
 *
 * The DB seam behind the list + revert endpoints — the `lib/app/questionnaire/**`
 * module stays Prisma-free (the pure planner lives there; the writes live here):
 *
 *   - `loadScopedChange` — scope-and-404 a change to its version.
 *   - `buildGraphSnapshot` — project the editable version into the planner's pure
 *     `GraphSnapshot`.
 *   - `listVersionChanges` — the list serializer; enriches each row with a dry-run
 *     revert verdict (`revertable` / `revertBlockedReason` / `revertSummary`).
 *   - `executeRevert` — apply a `RevertPlan` to the editable version and flip the
 *     (source-version) change row to `reverted`, in one transaction.
 */

import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db/client';
import { executeTransaction } from '@/lib/db/utils';
import {
  FIELD_PROVENANCES,
  type AudienceProvenance,
  type AudienceShape,
  type FieldProvenance,
  type QuestionType,
} from '@/lib/app/questionnaire/types';
import { nextAvailableKey, slugifyKey } from '@/lib/app/questionnaire/authoring/key';
import {
  planRevert,
  type ExtractionChangeListResponse,
  type ExtractionChangeStatus,
  type ExtractionChangeView,
  type GraphSnapshot,
  type ListChangesQuery,
  type NewQuestionSpec,
  type QuestionUpdateFields,
  type RevertableChange,
  type RevertOp,
  type RevertPlan,
  type SectionUpdateFields,
} from '@/lib/app/questionnaire/extraction-review';
import type { ChangeType, TargetEntityType } from '@/lib/app/questionnaire/ingestion/types';
import { jsonInput } from '@/app/api/v1/app/_lib/prisma-json';

/** The change-row fields the review surface reads / reverts. */
export const CHANGE_SELECT = {
  id: true,
  changeType: true,
  targetEntityType: true,
  targetEntityId: true,
  sourceQuote: true,
  beforeJson: true,
  afterJson: true,
  rationale: true,
  confidence: true,
  status: true,
  revertedAt: true,
  supersededAt: true,
  createdAt: true,
} as const;

/** A change row scoped to its version (what `loadScopedChange` returns). */
export interface ScopedChange {
  id: string;
  changeType: string;
  targetEntityType: string;
  targetEntityId: string | null;
  sourceQuote: string | null;
  beforeJson: Prisma.JsonValue;
  afterJson: Prisma.JsonValue;
  rationale: string | null;
  confidence: number | null;
  status: string;
  revertedAt: Date | null;
  supersededAt: Date | null;
  createdAt: Date;
}

/**
 * Load a change scoped to its version. Returns `null` (→ route 404) when the
 * vid/changeId pair doesn't resolve, so a change can't leak across versions (the
 * same scoping discipline as `loadScopedVersion` / `loadScopedTag`).
 */
export async function loadScopedChange(
  versionId: string,
  changeId: string
): Promise<ScopedChange | null> {
  return prisma.appQuestionnaireExtractionChange.findFirst({
    where: { id: changeId, versionId },
    select: CHANGE_SELECT,
  });
}

/** Narrow a stored `goalProvenance` string to FieldProvenance (mirrors detail.ts). */
function asFieldProvenance(value: string | null): FieldProvenance | null {
  return value !== null && (FIELD_PROVENANCES as readonly string[]).includes(value)
    ? (value as FieldProvenance)
    : null;
}

const EMPTY_SNAPSHOT: GraphSnapshot = {
  goal: null,
  goalProvenance: null,
  audience: null,
  audienceProvenance: null,
  sections: [],
};

/**
 * Project the editable version into the pure `GraphSnapshot` the planner reads.
 * The audience/provenance JSON columns are cast back to our own shapes — we wrote
 * them (same storage-boundary cast as `detail.ts`). Returns `EMPTY_SNAPSHOT` when
 * the version is absent (the route has already scoped it, so this is defensive).
 */
export async function buildGraphSnapshot(versionId: string): Promise<GraphSnapshot> {
  const version = await prisma.appQuestionnaireVersion.findUnique({
    where: { id: versionId },
    select: {
      goal: true,
      goalProvenance: true,
      audience: true,
      audienceProvenance: true,
      sections: {
        orderBy: { ordinal: 'asc' },
        select: {
          id: true,
          ordinal: true,
          title: true,
          description: true,
          questions: {
            orderBy: { ordinal: 'asc' },
            select: {
              id: true,
              sectionId: true,
              ordinal: true,
              key: true,
              prompt: true,
              guidelines: true,
              rationale: true,
              type: true,
              typeConfig: true,
              required: true,
              weight: true,
            },
          },
        },
      },
    },
  });
  if (!version) return EMPTY_SNAPSHOT;

  return {
    goal: version.goal,
    goalProvenance: asFieldProvenance(version.goalProvenance),
    // We wrote these JSON columns, so the cast is a storage-boundary narrow.
    audience: (version.audience ?? null) as AudienceShape | null,
    audienceProvenance: (version.audienceProvenance ?? null) as AudienceProvenance | null,
    sections: version.sections.map((s) => ({
      id: s.id,
      ordinal: s.ordinal,
      title: s.title,
      description: s.description,
      questions: s.questions.map((q) => ({
        id: q.id,
        sectionId: q.sectionId,
        ordinal: q.ordinal,
        key: q.key,
        prompt: q.prompt,
        guidelines: q.guidelines,
        rationale: q.rationale,
        type: q.type as QuestionType,
        typeConfig: q.typeConfig ?? null,
        required: q.required,
        weight: q.weight,
      })),
    })),
  };
}

/** Build the planner's pure change projection from a loaded row. */
export function toRevertableChange(change: ScopedChange): RevertableChange {
  return {
    id: change.id,
    changeType: change.changeType as ChangeType,
    targetEntityType: change.targetEntityType as TargetEntityType,
    targetEntityId: change.targetEntityId,
    sourceQuote: change.sourceQuote,
    beforeJson: change.beforeJson ?? null,
    afterJson: change.afterJson ?? null,
  };
}

/** Derive a short target label from a plan's first op (for the list view). */
function planTargetLabel(plan: RevertPlan, snapshot: GraphSnapshot): string | null {
  const op = plan.ops[0];
  if (!op) return null;
  const questionKey = (id: string) =>
    snapshot.sections.flatMap((s) => s.questions).find((q) => q.id === id)?.key ?? null;
  const sectionTitle = (id: string) => snapshot.sections.find((s) => s.id === id)?.title ?? null;
  switch (op.op) {
    case 'set-goal':
      return 'Goal';
    case 'set-audience':
      return 'Audience';
    case 'create-section':
      return op.title;
    case 'create-question':
      return sectionTitle(op.sectionId);
    case 'update-question':
    case 'delete-question':
      return questionKey(op.questionId);
    case 'update-section':
    case 'delete-section':
      return sectionTitle(op.sectionId);
  }
}

/** Project one change row to its enriched read view (dry-run revert verdict). */
function toChangeView(change: ScopedChange, snapshot: GraphSnapshot): ExtractionChangeView {
  const base: ExtractionChangeView = {
    id: change.id,
    changeType: change.changeType as ChangeType,
    targetEntityType: change.targetEntityType as TargetEntityType,
    sourceQuote: change.sourceQuote,
    beforeJson: change.beforeJson ?? null,
    afterJson: change.afterJson ?? null,
    rationale: change.rationale,
    confidence: change.confidence,
    status: change.status as ExtractionChangeStatus,
    revertedAt: change.revertedAt?.toISOString() ?? null,
    supersededAt: change.supersededAt?.toISOString() ?? null,
    createdAt: change.createdAt.toISOString(),
    resolvedTargetLabel: null,
    revertable: false,
    revertBlockedReason: null,
    revertSummary: null,
  };
  // Only an applied change is a revert candidate; `reverted` and `superseded` are
  // both terminal. A dry-run plan sets the verdict for the rest.
  if (change.status !== 'applied') return base;
  const result = planRevert(toRevertableChange(change), snapshot);
  if (result.ok) {
    base.revertable = true;
    base.revertSummary = result.plan.summary;
    base.resolvedTargetLabel = planTargetLabel(result.plan, snapshot);
  } else {
    base.revertBlockedReason = result.reason;
  }
  return base;
}

/**
 * List a version's change records (newest-first), filtered, each enriched with a
 * dry-run revert verdict. One findMany + one snapshot + one status groupBy.
 */
export async function listVersionChanges(
  versionId: string,
  filters: ListChangesQuery
): Promise<ExtractionChangeListResponse> {
  const where: Prisma.AppQuestionnaireExtractionChangeWhereInput = { versionId };
  if (filters.status) where.status = filters.status;
  if (filters.changeType) where.changeType = filters.changeType;
  if (filters.targetEntityType) where.targetEntityType = filters.targetEntityType;

  const [rows, snapshot, statusGroups] = await Promise.all([
    prisma.appQuestionnaireExtractionChange.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      select: CHANGE_SELECT,
    }),
    buildGraphSnapshot(versionId),
    prisma.appQuestionnaireExtractionChange.groupBy({
      by: ['status'],
      where: { versionId },
      _count: { _all: true },
    }),
  ]);

  const counts = { applied: 0, reverted: 0, superseded: 0 };
  for (const g of statusGroups) {
    if (g.status === 'applied') counts.applied = g._count._all;
    else if (g.status === 'reverted') counts.reverted = g._count._all;
    else if (g.status === 'superseded') counts.superseded = g._count._all;
  }

  return { changes: rows.map((row) => toChangeView(row, snapshot)), counts };
}

// ─── Revert executor ──────────────────────────────────────────────────────────

/** The interactive transaction client `executeTransaction` hands its callback. */
type Tx = Parameters<Parameters<typeof executeTransaction>[0]>[0];

/** Next append ordinal for a new section in the version. */
async function nextSectionOrdinal(tx: Tx, versionId: string): Promise<number> {
  const last = await tx.appQuestionnaireSection.findFirst({
    where: { versionId },
    orderBy: { ordinal: 'desc' },
    select: { ordinal: true },
  });
  return (last?.ordinal ?? -1) + 1;
}

/**
 * Prisma `create` data for a re-created question (key already resolved). Uses the
 * unchecked (scalar `versionId` + `sectionId`) shape, matching `persist.ts` —
 * `versionId` is a denormalised scalar with no relation, so it can't be `connect`ed.
 */
function newQuestionData(
  versionId: string,
  sectionId: string,
  ordinal: number,
  key: string,
  spec: NewQuestionSpec
): Prisma.AppQuestionSlotUncheckedCreateInput {
  return {
    versionId,
    sectionId,
    ordinal,
    key,
    prompt: spec.prompt,
    type: spec.type,
    required: spec.required,
    weight: spec.weight,
    ...(spec.guidelines !== null ? { guidelines: spec.guidelines } : {}),
    ...(spec.rationale !== null ? { rationale: spec.rationale } : {}),
    ...(spec.typeConfig !== null && spec.typeConfig !== undefined
      ? { typeConfig: jsonInput(spec.typeConfig) }
      : {}),
  };
}

/** Prisma `update` data for a question field restore. */
function questionUpdateData(fields: QuestionUpdateFields): Prisma.AppQuestionSlotUpdateInput {
  const data: Prisma.AppQuestionSlotUpdateInput = {};
  if (fields.prompt !== undefined) data.prompt = fields.prompt;
  if (fields.guidelines !== undefined) data.guidelines = fields.guidelines;
  if (fields.rationale !== undefined) data.rationale = fields.rationale;
  if (fields.type !== undefined) data.type = fields.type;
  if (fields.typeConfig !== undefined) data.typeConfig = jsonInput(fields.typeConfig);
  if (fields.required !== undefined) data.required = fields.required;
  if (fields.weight !== undefined) data.weight = fields.weight;
  return data;
}

/** Prisma `update` data for a section field restore. */
function sectionUpdateData(fields: SectionUpdateFields): Prisma.AppQuestionnaireSectionUpdateInput {
  const data: Prisma.AppQuestionnaireSectionUpdateInput = {};
  if (fields.title !== undefined) data.title = fields.title;
  if (fields.description !== undefined) data.description = fields.description;
  return data;
}

export interface ExecuteRevertInput {
  /** The editable version the inverse mutation applies to (draft after a fork). */
  editVersionId: string;
  /** The (source-version) change row id to flip to `reverted`. */
  changeId: string;
  plan: RevertPlan;
  revertedByUserId: string | null;
  /** Stable timestamp for the revert (the route stamps it — `new Date()`). */
  revertedAt: Date;
}

/**
 * Apply the plan's primitive ops to the editable version and mark the change row
 * `reverted`, in a single transaction. Re-created questions get fresh
 * per-version-unique keys via `nextAvailableKey`, seeded from the version's
 * current keys and extended as we go so a multi-question restore can't self-collide.
 */
export async function executeRevert(input: ExecuteRevertInput): Promise<void> {
  const { editVersionId, changeId, plan, revertedByUserId, revertedAt } = input;
  await executeTransaction(async (tx) => {
    const existing = await tx.appQuestionSlot.findMany({
      where: { versionId: editVersionId },
      select: { key: true },
    });
    const taken = new Set(existing.map((e) => e.key));

    for (const op of plan.ops) {
      await applyOp(tx, editVersionId, op, taken);
    }

    await tx.appQuestionnaireExtractionChange.update({
      where: { id: changeId },
      data: { status: 'reverted', revertedAt, revertedByUserId },
    });
  });
}

/** Apply one primitive op within the transaction. */
async function applyOp(tx: Tx, versionId: string, op: RevertOp, taken: Set<string>): Promise<void> {
  switch (op.op) {
    case 'set-goal':
      await tx.appQuestionnaireVersion.update({
        where: { id: versionId },
        data: { goal: op.goal, goalProvenance: op.provenance },
      });
      return;
    case 'set-audience':
      await tx.appQuestionnaireVersion.update({
        where: { id: versionId },
        data: {
          audience: op.audience === null ? Prisma.JsonNull : jsonInput(op.audience),
          audienceProvenance: op.provenance === null ? Prisma.JsonNull : jsonInput(op.provenance),
        },
      });
      return;
    case 'create-section': {
      const ordinal = await nextSectionOrdinal(tx, versionId);
      const section = await tx.appQuestionnaireSection.create({
        data: {
          version: { connect: { id: versionId } },
          ordinal,
          title: op.title,
          ...(op.description !== null ? { description: op.description } : {}),
        },
        select: { id: true },
      });
      let childOrdinal = 0;
      for (const spec of op.questions) {
        const key = nextAvailableKey(slugifyKey(spec.prompt), taken);
        taken.add(key);
        await tx.appQuestionSlot.create({
          data: newQuestionData(versionId, section.id, childOrdinal, key, spec),
        });
        childOrdinal += 1;
      }
      return;
    }
    case 'create-question': {
      const ordinal = await tx.appQuestionSlot.count({ where: { sectionId: op.sectionId } });
      const key = nextAvailableKey(slugifyKey(op.question.prompt), taken);
      taken.add(key);
      await tx.appQuestionSlot.create({
        data: newQuestionData(versionId, op.sectionId, ordinal, key, op.question),
      });
      return;
    }
    case 'update-question':
      await tx.appQuestionSlot.update({
        where: { id: op.questionId },
        data: questionUpdateData(op.fields),
      });
      return;
    case 'update-section':
      await tx.appQuestionnaireSection.update({
        where: { id: op.sectionId },
        data: sectionUpdateData(op.fields),
      });
      return;
    case 'delete-question':
      await tx.appQuestionSlot.delete({ where: { id: op.questionId } });
      return;
    case 'delete-section':
      await tx.appQuestionnaireSection.delete({ where: { id: op.sectionId } });
      return;
  }
}
