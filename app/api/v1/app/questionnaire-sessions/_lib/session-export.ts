/**
 * Session PDF export — DB read seam + model assembly (F7.4).
 *
 * Loads everything the PDF needs for one session in a single query — the version's
 * section/slot structure, the captured answers, the per-turn ordinals (so refinement
 * history can resolve a turn index), plus the export-only header metadata the panel
 * read doesn't need: questionnaire title, version number, goal/audience, the
 * `anonymousMode` config, and the demo-client theme columns. The respondent's display
 * name is looked up only when the session is NOT anonymous — anonymous mode never even
 * queries identity.
 *
 * {@link buildSessionExportPdfModel} runs after the route authorises: it best-effort
 * fetches the brand logo (so a flaky remote image can't break rendering) and hands the
 * plain rows to the pure {@link buildSessionExportModel}.
 *
 * Route-local DB seam — the `lib/app/questionnaire/export/**` module is Prisma-free.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import {
  SESSION_STATUSES,
  narrowToEnum,
  type AudienceShape,
  type SessionStatus,
} from '@/lib/app/questionnaire/types';
import type {
  PanelAnswerInput,
  PanelSectionInput,
} from '@/lib/app/questionnaire/panel/answer-panel';
import type { PanelRefinementEntry } from '@/lib/app/questionnaire/panel/types';
import {
  buildSessionExportModel,
  type SessionExportInput,
} from '@/lib/app/questionnaire/export/build-session-export-model';
import {
  asProfileValues,
  type ProfileValues,
} from '@/lib/app/questionnaire/profile/profile-values';
import type { ExportDataSlotGroup, SessionExportModel } from '@/lib/app/questionnaire/export/types';
import type { RespondentReportContent } from '@/lib/app/questionnaire/report/content';
import { fetchLogoDataUri } from '@/app/api/v1/app/questionnaire-sessions/_lib/fetch-logo-data-uri';

/** Raw demo-client theme columns (or null when the questionnaire is unattributed). */
interface RawTheme {
  ctaColor: string | null;
  accentColor: string | null;
  logoUrl: string | null;
  welcomeCopy: string | null;
}

/** The access fields + everything the pure builder needs, minus the fetched logo. */
export interface LoadedSessionExport {
  /** Access fields for `resolveTurnAccess` (respondent) / ownership (admin). */
  session: { id: string; respondentUserId: string | null };
  /** The questionnaire id the session's version belongs to (admin ownership check). */
  questionnaireId: string;
  questionnaireTitle: string;
  versionNumber: number;
  /** The session's support reference (`publicRef`), or null for a row predating the column. */
  ref: string | null;
  goal: string | null;
  audience: AudienceShape | null;
  anonymous: boolean;
  respondentName: string | null;
  /** Collected profile values, or null when anonymous / none collected (identifying). */
  profile: ProfileValues | null;
  completedAt: string | null;
  theme: RawTheme;
  status: SessionStatus;
  sections: PanelSectionInput[];
  answers: PanelAnswerInput[];
  /**
   * Captured data-slot values grouped by theme (Data Slots feature), in version order. Empty when
   * the version has no data slots. Rendered in the PDF's "Captured information" appendix only when
   * the report config includes data slots; loaded unconditionally so the pure builder stays simple.
   */
  dataSlotGroups: ExportDataSlotGroup[];
}

/** Cast a stored `refinementHistory` Json column back to our entry array. */
function asRefinementHistory(value: unknown): PanelRefinementEntry[] {
  return Array.isArray(value) ? (value as PanelRefinementEntry[]) : [];
}

/** Cast a stored `audience` Json column to the structured shape (null when absent). */
function asAudience(value: unknown): AudienceShape | null {
  return value && typeof value === 'object' ? value : null;
}

/**
 * Load a session's export state. `null` when the session doesn't exist. Mirrors the
 * answer-panel loader's query and extends it with the export-only header metadata.
 */
export async function loadSessionExport(sessionId: string): Promise<LoadedSessionExport | null> {
  const row = await prisma.appQuestionnaireSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      status: true,
      respondentUserId: true,
      publicRef: true,
      updatedAt: true,
      version: {
        select: {
          versionNumber: true,
          goal: true,
          audience: true,
          questionnaireId: true,
          config: { select: { anonymousMode: true } },
          questionnaire: {
            select: {
              title: true,
              demoClient: {
                select: { ctaColor: true, accentColor: true, logoUrl: true, welcomeCopy: true },
              },
            },
          },
          sections: {
            orderBy: { ordinal: 'asc' },
            select: {
              id: true,
              title: true,
              questions: {
                orderBy: { ordinal: 'asc' },
                select: { key: true, prompt: true, type: true, required: true, typeConfig: true },
              },
            },
          },
          // Data slots (Data Slots feature) — the respondent-facing abstraction layer. Loaded for the
          // optional "Captured information" appendix; empty for versions not in a data-slot mode.
          dataSlots: {
            orderBy: { ordinal: 'asc' },
            select: { id: true, name: true, description: true, theme: true },
          },
        },
      },
      // Identifying — surfaced only when NOT anonymous (gated below); an anonymous
      // session never has a snapshot row, but the output gate is the hard guarantee.
      profileSnapshot: { select: { values: true } },
      answers: {
        select: {
          value: true,
          confidence: true,
          provenanceLabel: true,
          rationale: true,
          lastUpdatedTurnId: true,
          refinementHistory: true,
          questionSlot: { select: { key: true } },
        },
      },
      turns: { select: { id: true, ordinal: true } },
      // Captured data-slot positions for the appendix (paraphrase = respondent-facing restatement).
      dataSlotFills: { select: { dataSlotId: true, paraphrase: true } },
      // Latest completion event → the completion timestamp for the header.
      events: {
        where: { toStatus: 'completed' },
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { createdAt: true },
      },
    },
  });
  if (!row) return null;

  const status = narrowToEnum(row.status, SESSION_STATUSES, 'active');
  const anonymous = row.version.config?.anonymousMode ?? false;

  // Identity is only ever queried when NOT anonymous — anonymous mode never touches it.
  let respondentName: string | null = null;
  if (!anonymous && row.respondentUserId) {
    const user = await prisma.user.findUnique({
      where: { id: row.respondentUserId },
      select: { name: true },
    });
    respondentName = user?.name ?? null;
  }

  // Profile snapshot is identifying — dropped entirely in anonymous mode.
  const profile = anonymous ? null : asProfileValues(row.profileSnapshot?.values);

  // Completion timestamp: the latest `completed` event, else the row's updatedAt when the
  // session is completed, else null (an in-progress session has no completion date).
  const completedAt =
    row.events[0]?.createdAt.toISOString() ??
    (status === 'completed' ? row.updatedAt.toISOString() : null);

  const turnOrdinal = new Map(row.turns.map((t) => [t.id, t.ordinal]));

  const sections: PanelSectionInput[] = row.version.sections.map((s) => ({
    sectionId: s.id,
    title: s.title,
    slots: s.questions.map((q) => ({
      slotKey: q.key,
      prompt: q.prompt,
      type: q.type,
      typeConfig: q.typeConfig,
      required: q.required,
    })),
  }));

  const answers: PanelAnswerInput[] = row.answers.map((a) => ({
    slotKey: a.questionSlot.key,
    value: a.value,
    provenance: a.provenanceLabel,
    confidence: a.confidence,
    rationale: a.rationale,
    answeredAtTurnIndex:
      a.lastUpdatedTurnId != null ? (turnOrdinal.get(a.lastUpdatedTurnId) ?? null) : null,
    refinementHistory: asRefinementHistory(a.refinementHistory),
  }));

  // Captured data-slot values grouped by theme, in version (ordinal) order — the same grouping the
  // live panel shows. `value` is the respondent-facing paraphrase, or null (rendered "Not captured").
  const paraphraseBySlotId = new Map(
    row.dataSlotFills.map((f) => [f.dataSlotId, f.paraphrase ?? null])
  );
  const dataSlotGroups: ExportDataSlotGroup[] = [];
  const groupByTheme = new Map<string, ExportDataSlotGroup>();
  for (const ds of row.version.dataSlots) {
    let group = groupByTheme.get(ds.theme);
    if (!group) {
      group = { theme: ds.theme, slots: [] };
      groupByTheme.set(ds.theme, group);
      dataSlotGroups.push(group);
    }
    group.slots.push({
      name: ds.name,
      description: ds.description,
      value: paraphraseBySlotId.get(ds.id) ?? null,
    });
  }

  const demoClient = row.version.questionnaire.demoClient;

  return {
    session: { id: row.id, respondentUserId: row.respondentUserId },
    questionnaireId: row.version.questionnaireId,
    questionnaireTitle: row.version.questionnaire.title,
    versionNumber: row.version.versionNumber,
    ref: row.publicRef ?? null,
    goal: row.version.goal,
    audience: asAudience(row.version.audience),
    anonymous,
    respondentName,
    profile,
    completedAt,
    theme: {
      ctaColor: demoClient?.ctaColor ?? null,
      accentColor: demoClient?.accentColor ?? null,
      logoUrl: demoClient?.logoUrl ?? null,
      welcomeCopy: demoClient?.welcomeCopy ?? null,
    },
    status,
    sections,
    answers,
    dataSlotGroups,
  };
}

/**
 * The report-derived fields a caller embeds in the export PDF. Grouped into one options object (rather
 * than trailing positional params) so the several booleans/values can't be silently transposed at a
 * call site — all default to "no report" when omitted.
 */
export interface SessionReportEmbed {
  /** The AI report content, or null/absent for raw-only / not-yet-ready. */
  insights?: RespondentReportContent | null;
  /** True when the report mode is `narrative` (drives the report title). */
  narrative?: boolean;
  /** Include the questions-and-answers listing (config `rawIncludes.questionsAsPresented`). */
  includeQuestions?: boolean;
  /** Include the captured data-slot appendix (config `rawIncludes.dataSlots`). */
  includeDataSlots?: boolean;
  /** The report was laid out by the Report Formatter — trust its paragraphs verbatim. */
  formatted?: boolean;
  /** Questionnaire completion % at generation — drives the partial-report caveat. Null = no caveat. */
  completionPct?: number | null;
}

/**
 * Assemble the export model from loaded rows — fetches the brand logo (best-effort) and
 * stamps the generation time, then delegates to the pure builder. Call after the route
 * authorises, so the logo fetch never runs for an unauthorised request.
 */
export async function buildSessionExportPdfModel(
  loaded: LoadedSessionExport,
  report: SessionReportEmbed = {}
): Promise<SessionExportModel> {
  const logoDataUri = await fetchLogoDataUri(loaded.theme.logoUrl);
  if (loaded.theme.logoUrl && !logoDataUri) {
    logger.warn('Session export: brand logo unavailable, rendering without it', {
      sessionId: loaded.session.id,
    });
  }

  const input: SessionExportInput = {
    questionnaireTitle: loaded.questionnaireTitle,
    versionNumber: loaded.versionNumber,
    ref: loaded.ref,
    goal: loaded.goal,
    audience: loaded.audience,
    anonymous: loaded.anonymous,
    respondentName: loaded.respondentName,
    profile: loaded.profile,
    completedAt: loaded.completedAt,
    generatedAt: new Date().toISOString(),
    // Carry the (possibly null) logo data URI through as the theme's logoUrl — the
    // document renders `<Image src={logoUrl}>` only when present.
    theme: { ...loaded.theme, logoUrl: logoDataUri },
    status: loaded.status,
    sections: loaded.sections,
    answers: loaded.answers,
    dataSlotGroups: loaded.dataSlotGroups,
    insights: report.insights ?? null,
    insightsFormatted: report.formatted ?? false,
    insightsCompletionPct: report.completionPct ?? null,
    narrative: report.narrative ?? false,
    includeQuestions: report.includeQuestions ?? true,
    includeDataSlots: report.includeDataSlots ?? false,
  };

  return buildSessionExportModel(input);
}
