/**
 * Questionnaire detail + version-graph read models (P2 / F2.1a).
 *
 * Two read-only serializers behind the detail routes:
 *   - `getQuestionnaireDetail(id)`        → questionnaire + version summaries
 *   - `getVersionGraph(id, versionId)`    → one version's full section/question tree
 *
 * `getVersionGraph` surfaces the **stored** per-field provenance columns
 * (`goalProvenance` / `audienceProvenance`) read straight off the version row — no
 * change-record derivation. `getQuestionnaireDetail` rolls up an applied-change
 * count per version (`countAppliedChanges`) for the summary. Both return `null`
 * when the entity is absent so the route maps to a 404. Route-local DB seam — the
 * `lib/app/questionnaire/**` module is Prisma-free.
 */

import type { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db/client';
import {
  FIELD_PROVENANCES,
  type AudienceProvenance,
  type AppQuestionnaireStatus,
  type AudienceShape,
  type FieldProvenance,
} from '@/lib/app/questionnaire/types';
import type {
  QuestionnaireDetail,
  QuestionnaireVersionSummary,
  QuestionSlotView,
  SectionView,
  VersionGraphView,
} from '@/lib/app/questionnaire/views';

/** Cast a stored Json column back to our own AudienceShape (we wrote it). */
function asAudience(value: Prisma.JsonValue): AudienceShape | null {
  if (value === null || value === undefined) return null;
  return value as AudienceShape;
}

/** Narrow a stored `goalProvenance` string to FieldProvenance (null if unset/unknown). */
function asFieldProvenance(value: string | null): FieldProvenance | null {
  return value !== null && (FIELD_PROVENANCES as readonly string[]).includes(value)
    ? (value as FieldProvenance)
    : null;
}

/** Cast a stored `audienceProvenance` Json column back to our own map. */
function asAudienceProvenance(value: Prisma.JsonValue): AudienceProvenance | null {
  if (value === null || value === undefined) return null;
  return value as AudienceProvenance;
}

/**
 * Count applied (not-yet-reverted) change records per version in one grouped
 * query (no per-version N+1). Returns a versionId → count map.
 */
async function countAppliedChanges(versionIds: string[]): Promise<Map<string, number>> {
  if (versionIds.length === 0) return new Map();
  const totals = await prisma.appQuestionnaireExtractionChange.groupBy({
    by: ['versionId'],
    where: { versionId: { in: versionIds }, status: 'applied' },
    _count: { _all: true },
  });
  return new Map(totals.map((t) => [t.versionId, t._count._all]));
}

/**
 * The questionnaire plus a newest-first summary of each version. Returns `null`
 * when no questionnaire has that id.
 */
export async function getQuestionnaireDetail(id: string): Promise<QuestionnaireDetail | null> {
  const questionnaire = await prisma.appQuestionnaire.findUnique({
    where: { id },
    select: {
      id: true,
      title: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      versions: {
        orderBy: { versionNumber: 'desc' },
        select: {
          id: true,
          versionNumber: true,
          status: true,
          goal: true,
          audience: true,
          createdAt: true,
          updatedAt: true,
        },
      },
    },
  });
  if (!questionnaire) return null;

  const versionIds = questionnaire.versions.map((v) => v.id);
  const [sectionGroups, questionGroups, changeCountByVersion] = await Promise.all([
    versionIds.length > 0
      ? prisma.appQuestionnaireSection.groupBy({
          by: ['versionId'],
          where: { versionId: { in: versionIds } },
          _count: { _all: true },
        })
      : Promise.resolve([]),
    versionIds.length > 0
      ? prisma.appQuestionSlot.groupBy({
          by: ['versionId'],
          where: { versionId: { in: versionIds } },
          _count: { _all: true },
        })
      : Promise.resolve([]),
    countAppliedChanges(versionIds),
  ]);

  const sectionCountByVersion = new Map(sectionGroups.map((g) => [g.versionId, g._count._all]));
  const questionCountByVersion = new Map(questionGroups.map((g) => [g.versionId, g._count._all]));

  const versions: QuestionnaireVersionSummary[] = questionnaire.versions.map((v) => ({
    id: v.id,
    versionNumber: v.versionNumber,
    status: v.status as AppQuestionnaireStatus,
    goal: v.goal,
    audience: asAudience(v.audience),
    sectionCount: sectionCountByVersion.get(v.id) ?? 0,
    questionCount: questionCountByVersion.get(v.id) ?? 0,
    changeCount: changeCountByVersion.get(v.id) ?? 0,
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
  }));

  return {
    id: questionnaire.id,
    title: questionnaire.title,
    status: questionnaire.status as AppQuestionnaireStatus,
    createdAt: questionnaire.createdAt.toISOString(),
    updatedAt: questionnaire.updatedAt.toISOString(),
    versions,
  };
}

/**
 * One version's full structural graph (sections → questions), scoped to its
 * parent questionnaire so a mismatched `id`/`versionId` pair 404s rather than
 * leaking a version from another questionnaire. Returns `null` when absent.
 */
export async function getVersionGraph(
  questionnaireId: string,
  versionId: string
): Promise<VersionGraphView | null> {
  const version = await prisma.appQuestionnaireVersion.findFirst({
    where: { id: versionId, questionnaireId },
    select: {
      id: true,
      questionnaireId: true,
      versionNumber: true,
      status: true,
      goal: true,
      audience: true,
      goalProvenance: true,
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
              ordinal: true,
              key: true,
              prompt: true,
              guidelines: true,
              rationale: true,
              type: true,
              typeConfig: true,
              required: true,
              weight: true,
              extractionConfidence: true,
            },
          },
        },
      },
    },
  });
  if (!version) return null;

  const sections: SectionView[] = version.sections.map((s) => ({
    id: s.id,
    ordinal: s.ordinal,
    title: s.title,
    description: s.description,
    questions: s.questions.map(
      (qn): QuestionSlotView => ({
        id: qn.id,
        ordinal: qn.ordinal,
        key: qn.key,
        prompt: qn.prompt,
        guidelines: qn.guidelines,
        rationale: qn.rationale,
        type: qn.type as QuestionSlotView['type'],
        typeConfig: qn.typeConfig ?? null,
        required: qn.required,
        weight: qn.weight,
        extractionConfidence: qn.extractionConfidence,
      })
    ),
  }));

  return {
    id: version.id,
    questionnaireId: version.questionnaireId,
    versionNumber: version.versionNumber,
    status: version.status as AppQuestionnaireStatus,
    goal: version.goal,
    audience: asAudience(version.audience),
    goalProvenance: asFieldProvenance(version.goalProvenance),
    audienceProvenance: asAudienceProvenance(version.audienceProvenance),
    sections,
  };
}
