/**
 * Session PDF export — pure, serialisable view contract (F7.4).
 *
 * The shape the React-PDF document (`components/app/questionnaire/export/`) renders for
 * a completed session: a branded header (questionnaire title, version, goal, audience,
 * completion date, respondent identity — unless anonymous), then the full section/slot
 * structure with each captured answer and its provenance/confidence/rationale and the
 * refinement audit trail. Unanswered slots are carried too (the document renders them
 * "Not answered"), so the export is always a complete record of the version regardless
 * of the panel's `answerSlotPanelScope`.
 *
 * Prisma-free and Next-free: the DB read seam
 * (`app/api/v1/app/questionnaire-sessions/_lib/session-export.ts`) loads the rows and
 * the pure {@link buildSessionExportModel} assembles this; the route renders it.
 *
 * `// DEMO-ONLY (F7.4):` the section/slot grouping, provenance vocabulary, and the
 * demo-client theme are questionnaire-domain assumptions — a non-questionnaire fork
 * strips this module alongside the F7.2 panel.
 */

import type { ResolvedTheme } from '@/lib/app/questionnaire/theming';
import type { PanelSectionView } from '@/lib/app/questionnaire/panel/types';
import type { ProfileValues } from '@/lib/app/questionnaire/profile/profile-values';
import type { RespondentReportContent } from '@/lib/app/questionnaire/report/content';

/** The respondent identity shown in the PDF header (name only — never email). */
export interface ExportRespondent {
  name: string;
}

/** Everything the PDF document needs for one session, fully resolved. */
export interface SessionExportModel {
  /** Questionnaire title (the document heading). */
  questionnaireTitle: string;
  /** 1-based version number the session ran on. */
  versionNumber: number;
  /**
   * The session's raw support reference (`publicRef`), or null for a row predating the column.
   * The document groups it for display (`formatSessionRef`) — the code a respondent quotes when
   * reporting a problem, so it belongs in the header of their downloaded record.
   */
  ref: string | null;
  /** The version's stated goal, or null when unset. */
  goal: string | null;
  /** A one-line audience summary derived from the version's `AudienceShape`, or null. */
  audienceSummary: string | null;
  /**
   * The respondent identity, or null when the session is anonymous OR no identity is
   * known. Anonymous redaction is applied in the builder — a null here always renders
   * "Anonymous respondent".
   */
  respondent: ExportRespondent | null;
  /**
   * The profile-field values the respondent supplied at session start (keyed by field
   * `key`), or null when anonymous OR none were collected. Identifying data — the
   * builder forces this to null in anonymous mode, the same as `respondent`.
   */
  profile: ProfileValues | null;
  /** True when the version is configured `anonymousMode` (drives the header copy). */
  anonymous: boolean;
  /** ISO timestamp the session completed, or null when not yet completed. */
  completedAt: string | null;
  /** ISO timestamp the PDF was generated (footer). */
  generatedAt: string;
  /** Resolved demo-client theme (accent colour + logo) for branding. */
  theme: ResolvedTheme;
  /** Full section/slot structure with answers, every slot present (oldest-first). */
  sections: PanelSectionView[];
  /** Count of answered slots across all sections. */
  answeredCount: number;
  /** Total slots in the version. */
  totalCount: number;
  /**
   * The AI report content (Respondent Report AI modes `raw_plus_insights` / `narrative`), or null
   * when the report is raw-only / disabled / not yet generated. Rendered above the answers in the PDF.
   */
  insights?: RespondentReportContent | null;
  /**
   * When true, the woven `narrative` report **is** the deliverable: the PDF renders the report
   * content alone (titled "Your personalised report") and omits the raw section/slot listing. The
   * respondent's PDF route sets this for a ready narrative report; the admin audit PDF never does
   * (admins keep the full answer record alongside the report).
   */
  narrativeOnly?: boolean;
}
