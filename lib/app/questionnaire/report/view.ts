/**
 * Respondent Report — the respondent-facing view (completion screen + report endpoint).
 *
 * Resolves what a respondent should see after completing: whether a report is enabled (config AND
 * platform flag), its mode + delivery, and — for the AI modes (`raw_plus_insights`, `narrative`) — the
 * generation status and content (from `AppRespondentReport`). Raw mode and disabled reports carry
 * `insights: null`. Pure data assembly behind a mockable seam; the endpoint adds access control.
 */

import { prisma } from '@/lib/db/client';
import { isFeatureEnabled } from '@/lib/feature-flags';
import {
  APP_QUESTIONNAIRES_FLAG,
  APP_QUESTIONNAIRES_RESPONDENT_REPORT_FLAG,
} from '@/lib/app/questionnaire/constants';
import {
  isAiRespondentReportMode,
  type AudienceShape,
  type RespondentReportMode,
  type RespondentReportStatus,
} from '@/lib/app/questionnaire/types';
import {
  narrowRespondentReportSettings,
  resolveReportRawIncludes,
} from '@/lib/app/questionnaire/report/settings';
import {
  validateRespondentReportContent,
  type RespondentReportContent,
} from '@/lib/app/questionnaire/report/content';
import { resolveTheme } from '@/lib/app/questionnaire/theming';
import { summariseAudience } from '@/lib/app/questionnaire/export/build-session-export-model';

/**
 * The branded header for the on-screen full-page ("A4") report preview — the same masthead the
 * downloadable PDF renders (logo + accent rule + metadata), so the preview reads as a true twin of the
 * PDF rather than a bare title. Only assembled for the AI report modes (the only ones with a preview);
 * `null` otherwise. Anonymous sessions surface "Anonymous respondent" and never query identity.
 */
export interface RespondentReportHeader {
  /** Brand logo URL from the attributed demo client, or null when none is configured. */
  logoUrl: string | null;
  /** Resolved accent colour (demo-client value or the Sunrise default) for the header rule. */
  accentColor: string;
  versionNumber: number;
  /** Raw support reference (`publicRef`); the UI groups it for display. */
  ref: string | null;
  goal: string | null;
  audienceSummary: string | null;
  /** Display label for the respondent — their name, or "Anonymous respondent". */
  respondentLabel: string;
  completedAt: string | null;
}

/** The respondent-facing report state for one session. */
export interface RespondentReportClientView {
  enabled: boolean;
  mode: RespondentReportMode;
  onScreen: boolean;
  download: boolean;
  /** The questionnaire's title — so the completion screen can name the PDF download after it. */
  questionnaireTitle: string;
  /**
   * Which questionnaire data the report includes alongside the AI content (config `rawIncludes`).
   * `questions` = the questions-and-answers recap; `dataSlots` = the captured data-slot values. The
   * completion screen renders the matching appendix below the report when a flag is on; both the
   * on-screen render and the downloadable PDF honour the same config.
   */
  includeData: { questions: boolean; dataSlots: boolean };
  /** Branded header for the on-screen preview (AI modes only); `null` for raw / disabled. */
  header: RespondentReportHeader | null;
  /** Insights state for the AI modes (`raw_plus_insights`, `narrative`); `null` for raw / disabled. */
  insights: {
    status: RespondentReportStatus;
    /**
     * Whether a report row actually exists yet. `status` reads as `'queued'` both when a row is
     * genuinely queued AND when no row exists yet (never enqueued / not yet claimed) — this flag
     * disambiguates so the UI can distinguish "starting" (no row) from "preparing" (row queued).
     */
    started: boolean;
    content: RespondentReportContent | null;
    /**
     * Whether the stored prose was laid out by the Report Formatter second pass. When true the
     * renderers honour its paragraphs/bullets verbatim; when false they apply the deterministic
     * `splitReportParagraphs` split. Legacy rows (pre-formatter) and un-formatted rows read false.
     */
    formatted: boolean;
    /**
     * Questionnaire completion % at generation (answered / total slots). Below
     * `PARTIAL_REPORT_THRESHOLD_PCT` the renderers show the partial-report caveat. Null for legacy
     * rows generated before this was captured (no caveat).
     */
    completionPct: number | null;
    generatedAt: string | null;
    error: string | null;
    /** Whether the respondent has opted in to an email when the report is ready. */
    notifyRequested: boolean;
  } | null;
}

/** Cast a stored `audience` Json column to the structured shape (null when absent). */
function asAudience(value: unknown): AudienceShape | null {
  return value && typeof value === 'object' ? value : null;
}

/**
 * Build the respondent-facing report view for a session. Returns `null` when the session doesn't
 * exist. `enabled` reflects both the per-version config AND the platform flag, so a respondent never
 * waits on a report the platform has turned off.
 */
export async function buildRespondentReportClientView(
  sessionId: string
): Promise<RespondentReportClientView | null> {
  const session = await prisma.appQuestionnaireSession.findUnique({
    where: { id: sessionId },
    select: {
      status: true,
      respondentUserId: true,
      publicRef: true,
      updatedAt: true,
      version: {
        select: {
          versionNumber: true,
          goal: true,
          audience: true,
          config: { select: { respondentReport: true, anonymousMode: true } },
          questionnaire: {
            select: {
              title: true,
              // The four required theme columns; `resolveTheme` fills accent/logo defaults.
              demoClient: {
                select: { ctaColor: true, accentColor: true, logoUrl: true, welcomeCopy: true },
              },
            },
          },
        },
      },
      respondentReport: {
        select: {
          status: true,
          content: true,
          formatted: true,
          completionPct: true,
          generatedAt: true,
          error: true,
          notifyEmail: true,
        },
      },
      // Latest completion event → the header's "Completed" date (mirrors the PDF builder).
      events: {
        where: { toStatus: 'completed' },
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { createdAt: true },
      },
    },
  });
  if (!session) return null;

  const [master, sub] = await Promise.all([
    isFeatureEnabled(APP_QUESTIONNAIRES_FLAG),
    isFeatureEnabled(APP_QUESTIONNAIRES_RESPONDENT_REPORT_FLAG),
  ]);
  const settings = narrowRespondentReportSettings(session.version?.config?.respondentReport);
  const enabled = master && sub && settings.enabled;

  const base = {
    enabled,
    mode: settings.mode,
    onScreen: settings.delivery.onScreen,
    download: settings.delivery.download,
    questionnaireTitle: session.version?.questionnaire?.title ?? 'questionnaire',
    // Narrative reports render woven-only (no appended Q&A recap) regardless of the stored flag; see
    // `resolveReportRawIncludes`. This is the single chokepoint feeding both respondent-facing surfaces.
    includeData: resolveReportRawIncludes(settings),
  };

  if (!enabled || !isAiRespondentReportMode(settings.mode)) {
    return { ...base, header: null, insights: null };
  }

  // Branded header — the on-screen preview's masthead, matching the downloadable PDF. Identity is
  // only ever looked up when the session is NOT anonymous (mirrors the export builder's redaction).
  const anonymous = session.version?.config?.anonymousMode ?? false;
  let respondentName: string | null = null;
  if (!anonymous && session.respondentUserId) {
    const user = await prisma.user.findUnique({
      where: { id: session.respondentUserId },
      select: { name: true },
    });
    respondentName = user?.name ?? null;
  }
  const theme = resolveTheme(session.version?.questionnaire?.demoClient ?? null);
  const completedAt =
    session.events[0]?.createdAt.toISOString() ??
    (session.status === 'completed' ? session.updatedAt.toISOString() : null);
  const header: RespondentReportHeader = {
    logoUrl: theme.logoUrl,
    accentColor: theme.accentColor,
    versionNumber: session.version?.versionNumber ?? 1,
    ref: session.publicRef ?? null,
    goal: session.version?.goal ?? null,
    audienceSummary: summariseAudience(asAudience(session.version?.audience)),
    respondentLabel: anonymous || !respondentName ? 'Anonymous respondent' : respondentName,
    completedAt,
  };

  const row = session.respondentReport;
  return {
    ...base,
    header,
    insights: {
      // No row yet (submitted, worker hasn't claimed it) reads as still-queued.
      status: (row?.status as RespondentReportStatus | undefined) ?? 'queued',
      started: row != null,
      content: row?.content ? validateRespondentReportContent(row.content) : null,
      formatted: Boolean(row?.formatted),
      completionPct: row?.completionPct ?? null,
      generatedAt: row?.generatedAt ? row.generatedAt.toISOString() : null,
      error: row?.error ?? null,
      notifyRequested: Boolean(row?.notifyEmail),
    },
  };
}
