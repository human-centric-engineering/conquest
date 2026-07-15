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
  ANSWER_FIT_MODES,
  ANSWER_SLOT_PANEL_SCOPES,
  CAPTURE_MODES,
  CONTRADICTION_MODES,
  DEFAULT_QUESTIONNAIRE_CONFIG,
  ACCESS_MODES,
  FIELD_PROVENANCES,
  PRESENTATION_MODES,
  REASONING_PLACEMENTS,
  SELECTION_STRATEGIES,
  type AccessMode,
  type AnswerFitMode,
  type AnswerSlotPanelScope,
  type CaptureMode,
  type AudienceProvenance,
  type AppQuestionnaireStatus,
  type AudienceShape,
  type ContradictionMode,
  type FieldProvenance,
  type PresentationMode,
  type ProfileFieldConfig,
  type ReasoningPlacement,
  type SelectionStrategy,
} from '@/lib/app/questionnaire/types';
import { parseInviteeFields } from '@/lib/app/questionnaire/invitations/invitee-fields';
import { parseProfileFields } from '@/lib/app/questionnaire/profile/profile-values';
import { narrowToneSettings } from '@/lib/app/questionnaire/chat/tone';
import { narrowInterviewerStrategy } from '@/lib/app/questionnaire/chat/interviewer-strategy';
import { narrowPersonas, narrowPersonaSelection } from '@/lib/app/questionnaire/persona/settings';
import { narrowRespondentReportSettings } from '@/lib/app/questionnaire/report/settings';
import { narrowCohortReportSettings } from '@/lib/app/questionnaire/cohort-report/settings';
import { narrowIntroSettings } from '@/lib/app/questionnaire/intro/settings';
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
  answerConfidenceFloor: true,
  allowEarlyFinish: true,
  earlyFinishMinCoverage: true,
  earlyFinishMinQuestions: true,
  costBudgetUsd: true,
  maxQuestionsPerSession: true,
  voiceEnabled: true,
  attachmentsEnabled: true,
  contradictionMode: true,
  contradictionWindowN: true,
  contradictionEveryNTurns: true,
  answerFitMode: true,
  extractionPrefilter: true,
  anonymousMode: true,
  accessMode: true,
  inviteeFields: true,
  abuseThreshold: true,
  maxDataSlotAttempts: true,
  sensitivityAwareness: true,
  supportMessage: true,
  supportResourceUrl: true,
  profileFields: true,
  captureMode: true,
  answerSlotPanelScope: true,
  presentationMode: true,
  inlineCorrectionEnabled: true,
  reasoningStreamEnabled: true,
  reasoningStreamPlacement: true,
  reasoningStreamDwellMs: true,
  reasoningStreamPerItemMs: true,
  reasoningStreamPersist: true,
  previewInspectorEnabled: true,
  tone: true,
  personas: true,
  personaSelection: true,
  interviewerStrategy: true,
  respondentReport: true,
  cohortReport: true,
  intro: true,
} as const;

type ConfigRow = {
  selectionStrategy: string;
  minQuestionsAnswered: number;
  coverageThreshold: number;
  answerConfidenceFloor: number;
  allowEarlyFinish: boolean;
  earlyFinishMinCoverage: number;
  earlyFinishMinQuestions: number;
  costBudgetUsd: number | null;
  maxQuestionsPerSession: number | null;
  voiceEnabled: boolean;
  attachmentsEnabled: boolean;
  contradictionMode: string;
  contradictionWindowN: number;
  contradictionEveryNTurns: number;
  answerFitMode: string;
  extractionPrefilter: boolean;
  anonymousMode: boolean;
  accessMode: string;
  inviteeFields: Prisma.JsonValue;
  abuseThreshold: number;
  maxDataSlotAttempts: number;
  sensitivityAwareness: boolean;
  supportMessage: string;
  supportResourceUrl: string;
  profileFields: Prisma.JsonValue;
  captureMode: string;
  answerSlotPanelScope: string;
  presentationMode: string;
  inlineCorrectionEnabled: boolean;
  reasoningStreamEnabled: boolean;
  reasoningStreamPlacement: string;
  reasoningStreamDwellMs: number;
  reasoningStreamPerItemMs: number;
  reasoningStreamPersist: boolean;
  previewInspectorEnabled: boolean;
  tone: Prisma.JsonValue;
  personas: Prisma.JsonValue;
  personaSelection: Prisma.JsonValue;
  interviewerStrategy: Prisma.JsonValue;
  respondentReport: Prisma.JsonValue;
  cohortReport: Prisma.JsonValue;
  intro: Prisma.JsonValue;
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

/** Narrow a stored `answerFitMode` to the enum (default when unknown). */
function asAnswerFitMode(value: string): AnswerFitMode {
  return (ANSWER_FIT_MODES as readonly string[]).includes(value)
    ? (value as AnswerFitMode)
    : DEFAULT_QUESTIONNAIRE_CONFIG.answerFitMode;
}

/**
 * Parse a stored `profileFields` Json column back to typed configs. Routed through
 * `parseProfileFields` (not a blind cast) so every field resolves its `validation` default —
 * legacy rows written before that key existed read back as `deterministic`.
 */
function asProfileFields(value: Prisma.JsonValue): ProfileFieldConfig[] {
  return parseProfileFields(value);
}

/** Narrow a stored `captureMode` to the enum (default when unknown). */
function asCaptureMode(value: string): CaptureMode {
  return (CAPTURE_MODES as readonly string[]).includes(value)
    ? (value as CaptureMode)
    : DEFAULT_QUESTIONNAIRE_CONFIG.captureMode;
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

/** Narrow a stored `accessMode` to the enum (default when unknown). */
function asAccessMode(value: string): AccessMode {
  return (ACCESS_MODES as readonly string[]).includes(value)
    ? (value as AccessMode)
    : DEFAULT_QUESTIONNAIRE_CONFIG.accessMode;
}

/** Narrow a stored `reasoningStreamPlacement` to the enum (default when unknown). */
function asReasoningPlacement(value: string): ReasoningPlacement {
  return (REASONING_PLACEMENTS as readonly string[]).includes(value)
    ? (value as ReasoningPlacement)
    : DEFAULT_QUESTIONNAIRE_CONFIG.reasoningStreamPlacement;
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
    answerConfidenceFloor: row.answerConfidenceFloor,
    allowEarlyFinish: row.allowEarlyFinish,
    earlyFinishMinCoverage: row.earlyFinishMinCoverage,
    earlyFinishMinQuestions: row.earlyFinishMinQuestions,
    costBudgetUsd: row.costBudgetUsd,
    maxQuestionsPerSession: row.maxQuestionsPerSession,
    voiceEnabled: row.voiceEnabled,
    attachmentsEnabled: row.attachmentsEnabled,
    contradictionMode: asContradictionMode(row.contradictionMode),
    answerFitMode: asAnswerFitMode(row.answerFitMode),
    extractionPrefilter: row.extractionPrefilter,
    contradictionWindowN: row.contradictionWindowN,
    contradictionEveryNTurns: row.contradictionEveryNTurns,
    anonymousMode: row.anonymousMode,
    accessMode: asAccessMode(row.accessMode),
    inviteeFields: parseInviteeFields(row.inviteeFields),
    abuseThreshold: row.abuseThreshold,
    maxDataSlotAttempts: row.maxDataSlotAttempts,
    sensitivityAwareness: row.sensitivityAwareness,
    supportMessage: row.supportMessage,
    supportResourceUrl: row.supportResourceUrl,
    profileFields: asProfileFields(row.profileFields),
    captureMode: asCaptureMode(row.captureMode),
    answerSlotPanelScope: asAnswerSlotPanelScope(row.answerSlotPanelScope),
    presentationMode: asPresentationMode(row.presentationMode),
    inlineCorrectionEnabled: row.inlineCorrectionEnabled,
    reasoningStreamEnabled: row.reasoningStreamEnabled,
    reasoningStreamPlacement: asReasoningPlacement(row.reasoningStreamPlacement),
    reasoningStreamDwellMs: row.reasoningStreamDwellMs,
    reasoningStreamPerItemMs: row.reasoningStreamPerItemMs,
    reasoningStreamPersist: row.reasoningStreamPersist,
    previewInspectorEnabled: row.previewInspectorEnabled,
    tone: narrowToneSettings(row.tone),
    personas: narrowPersonas(row.personas),
    personaSelection: narrowPersonaSelection(row.personaSelection),
    interviewerStrategy: narrowInterviewerStrategy(row.interviewerStrategy),
    respondentReport: narrowRespondentReportSettings(row.respondentReport),
    cohortReport: narrowCohortReportSettings(row.cohortReport),
    intro: narrowIntroSettings(row.intro),
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
    questions: s.questions.map((qn): QuestionSlotView => ({
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
    })),
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
