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
  ANSWER_SLOT_PANEL_SCOPES,
  CONTRADICTION_MODES,
  DEFAULT_QUESTIONNAIRE_CONFIG,
  FIELD_PROVENANCES,
  PRESENTATION_MODES,
  SELECTION_STRATEGIES,
  type AnswerSlotPanelScope,
  type AudienceProvenance,
  type AppQuestionnaireStatus,
  type AudienceShape,
  type ContradictionMode,
  type FieldProvenance,
  type PresentationMode,
  type ProfileFieldConfig,
  type SelectionStrategy,
} from '@/lib/app/questionnaire/types';
import type {
  ConfigView,
  QuestionnaireDetail,
  QuestionnaireVersionSummary,
  QuestionSlotView,
  SectionView,
  TagView,
  VersionGraphView,
} from '@/lib/app/questionnaire/views';
import { TAG_COLORS, type TagColor } from '@/lib/app/questionnaire/types';

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

/** Narrow a stored tag `color` string to TagColor (null if unset/off-allowlist). */
function asTagColor(value: string | null): TagColor | null {
  return value !== null && (TAG_COLORS as readonly string[]).includes(value)
    ? (value as TagColor)
    : null;
}

/** Project an `AppQuestionTag` row (id/label/color) to the client-safe TagView. */
function toTagView(tag: { id: string; label: string; color: string | null }): TagView {
  return { id: tag.id, label: tag.label, color: asTagColor(tag.color) };
}

/** The config columns the read view projects (F3.1). */
export const CONFIG_SELECT = {
  selectionStrategy: true,
  minQuestionsAnswered: true,
  coverageThreshold: true,
  costBudgetUsd: true,
  maxQuestionsPerSession: true,
  voiceEnabled: true,
  attachmentsEnabled: true,
  contradictionMode: true,
  contradictionWindowN: true,
  contradictionEveryNTurns: true,
  anonymousMode: true,
  abuseThreshold: true,
  maxDataSlotAttempts: true,
  sensitivityAwareness: true,
  supportMessage: true,
  supportResourceUrl: true,
  profileFields: true,
  answerSlotPanelScope: true,
  presentationMode: true,
} as const;

type ConfigRow = {
  selectionStrategy: string;
  minQuestionsAnswered: number;
  coverageThreshold: number;
  costBudgetUsd: number | null;
  maxQuestionsPerSession: number | null;
  voiceEnabled: boolean;
  attachmentsEnabled: boolean;
  contradictionMode: string;
  contradictionWindowN: number;
  contradictionEveryNTurns: number;
  anonymousMode: boolean;
  abuseThreshold: number;
  maxDataSlotAttempts: number;
  sensitivityAwareness: boolean;
  supportMessage: string;
  supportResourceUrl: string;
  profileFields: Prisma.JsonValue;
  answerSlotPanelScope: string;
  presentationMode: string;
};

/** Narrow a stored `selectionStrategy` to the enum (default when unknown). */
function asSelectionStrategy(value: string): SelectionStrategy {
  return (SELECTION_STRATEGIES as readonly string[]).includes(value)
    ? (value as SelectionStrategy)
    : DEFAULT_QUESTIONNAIRE_CONFIG.selectionStrategy;
}

/** Narrow a stored `contradictionMode` to the enum (default when unknown). */
function asContradictionMode(value: string): ContradictionMode {
  return (CONTRADICTION_MODES as readonly string[]).includes(value)
    ? (value as ContradictionMode)
    : DEFAULT_QUESTIONNAIRE_CONFIG.contradictionMode;
}

/** Cast a stored `profileFields` Json column back to our own array (we wrote it). */
function asProfileFields(value: Prisma.JsonValue): ProfileFieldConfig[] {
  return Array.isArray(value) ? (value as unknown as ProfileFieldConfig[]) : [];
}

/** Narrow a stored `answerSlotPanelScope` to the enum (default when unknown). */
function asAnswerSlotPanelScope(value: string): AnswerSlotPanelScope {
  return (ANSWER_SLOT_PANEL_SCOPES as readonly string[]).includes(value)
    ? (value as AnswerSlotPanelScope)
    : DEFAULT_QUESTIONNAIRE_CONFIG.answerSlotPanelScope;
}

/** Narrow a stored `presentationMode` to the enum (default when unknown). */
function asPresentationMode(value: string): PresentationMode {
  return (PRESENTATION_MODES as readonly string[]).includes(value)
    ? (value as PresentationMode)
    : DEFAULT_QUESTIONNAIRE_CONFIG.presentationMode;
}

/**
 * Project a config row (or its absence) to the client-safe {@link ConfigView}.
 * Lazy materialization: a `null` row resolves to `DEFAULT_QUESTIONNAIRE_CONFIG`
 * with `saved: false`, so the UI always renders a complete config and the launch
 * gate can distinguish a never-saved version (`saved: false`) from a deliberate
 * default-config save.
 */
export function toConfigView(row: ConfigRow | null): ConfigView {
  if (!row) return { ...DEFAULT_QUESTIONNAIRE_CONFIG, saved: false };
  return {
    selectionStrategy: asSelectionStrategy(row.selectionStrategy),
    minQuestionsAnswered: row.minQuestionsAnswered,
    coverageThreshold: row.coverageThreshold,
    costBudgetUsd: row.costBudgetUsd,
    maxQuestionsPerSession: row.maxQuestionsPerSession,
    voiceEnabled: row.voiceEnabled,
    attachmentsEnabled: row.attachmentsEnabled,
    contradictionMode: asContradictionMode(row.contradictionMode),
    contradictionWindowN: row.contradictionWindowN,
    contradictionEveryNTurns: row.contradictionEveryNTurns,
    anonymousMode: row.anonymousMode,
    abuseThreshold: row.abuseThreshold,
    maxDataSlotAttempts: row.maxDataSlotAttempts,
    sensitivityAwareness: row.sensitivityAwareness,
    supportMessage: row.supportMessage,
    supportResourceUrl: row.supportResourceUrl,
    profileFields: asProfileFields(row.profileFields),
    answerSlotPanelScope: asAnswerSlotPanelScope(row.answerSlotPanelScope),
    presentationMode: asPresentationMode(row.presentationMode),
    saved: true,
  };
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
      // DEMO-ONLY (F2.5.1): attributed demo client, or null for a generic demo.
      demoClient: { select: { id: true, slug: true, name: true } },
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
  const [sectionGroups, questionGroups, dataSlotGroups, changeCountByVersion] = await Promise.all([
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
    versionIds.length > 0
      ? prisma.appDataSlot.groupBy({
          by: ['versionId'],
          where: { versionId: { in: versionIds } },
          _count: { _all: true },
        })
      : Promise.resolve([]),
    countAppliedChanges(versionIds),
  ]);

  const sectionCountByVersion = new Map(sectionGroups.map((g) => [g.versionId, g._count._all]));
  const questionCountByVersion = new Map(questionGroups.map((g) => [g.versionId, g._count._all]));
  const dataSlotCountByVersion = new Map(dataSlotGroups.map((g) => [g.versionId, g._count._all]));

  const versions: QuestionnaireVersionSummary[] = questionnaire.versions.map((v) => ({
    id: v.id,
    versionNumber: v.versionNumber,
    status: v.status as AppQuestionnaireStatus,
    goal: v.goal,
    audience: asAudience(v.audience),
    sectionCount: sectionCountByVersion.get(v.id) ?? 0,
    questionCount: questionCountByVersion.get(v.id) ?? 0,
    dataSlotCount: dataSlotCountByVersion.get(v.id) ?? 0,
    changeCount: changeCountByVersion.get(v.id) ?? 0,
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
  }));

  return {
    id: questionnaire.id,
    title: questionnaire.title,
    status: questionnaire.status as AppQuestionnaireStatus,
    demoClient: questionnaire.demoClient,
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
      config: { select: CONFIG_SELECT },
      tags: {
        orderBy: { normalizedLabel: 'asc' },
        select: { id: true, label: true, color: true },
      },
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
              tags: {
                orderBy: { tag: { normalizedLabel: 'asc' } },
                select: { tag: { select: { id: true, label: true, color: true } } },
              },
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
        tags: qn.tags.map((t) => toTagView(t.tag)),
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
    tags: version.tags.map(toTagView),
    config: toConfigView(version.config),
  };
}
