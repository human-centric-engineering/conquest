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

/** One captured data-slot value in the "Captured information" appendix (respondent-facing). */
export interface ExportDataSlotEntry {
  /** The slot's short name (the label shown to the respondent). */
  name: string;
  /** The slot's description, or null. */
  description: string | null;
  /**
   * The captured position — the agent's respondent-facing paraphrase — or null when the slot was
   * never filled (the document renders "Not captured"). Never the raw underlying question answers:
   * the data-slot layer is the respondent's abstraction, mirroring the live panel.
   */
  value: string | null;
  /**
   * The agent's rationale for the captured position, or null/absent. Loaded for the report writer's
   * data-slot context block (Feature: data-slot influence); the respondent-facing "Captured
   * information" appendix ignores it.
   */
  rationale?: string | null;
  /**
   * The agent's 0–1 confidence in the captured position, or null/absent. Surfaced to the report writer
   * when `discountLowConfidence` is on; the respondent-facing appendix ignores it.
   */
  confidence?: number | null;
}

/** Data slots grouped by theme, as rendered in the PDF's "Captured information" appendix. */
export interface ExportDataSlotGroup {
  /** The theme heading (may be empty — the document then renders the slots without a sub-heading). */
  theme: string;
  slots: ExportDataSlotEntry[];
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
   * True when `insights` was laid out by the Report Formatter second pass — the PDF then honours its
   * paragraphs/bullets verbatim instead of applying the deterministic `splitReportParagraphs` split.
   */
  insightsFormatted?: boolean;
  /**
   * Questionnaire completion % at generation (answered / total slots). Below the partial-report
   * threshold the PDF renders a caveat subtitle under the report title. Null = no caveat.
   */
  insightsCompletionPct?: number | null;
  /**
   * True when the report mode is `narrative` — drives the report title ("Your personalised report"
   * vs "Your insights"). Independent of whether the questionnaire-data appendix is included: a
   * narrative report can now carry the appendix and still be titled as the personalised report.
   */
  narrative: boolean;
  /**
   * Include the questions-and-answers listing (the per-section slot record). Driven by the config's
   * `rawIncludes.questionsAsPresented`. When false the answer listing (and the answered-count line)
   * is omitted — e.g. a woven narrative report with no appended Q&A. The admin audit PDF forces this
   * on regardless of config (admins keep the full answer record).
   */
  includeQuestions: boolean;
  /**
   * Include the captured data-slot values as a "Captured information" appendix. Driven by the
   * config's `rawIncludes.dataSlots` (and only meaningful when the version runs in a data-slot mode).
   */
  includeDataSlots: boolean;
  /** The captured data-slot values, grouped by theme — rendered when {@link includeDataSlots}. */
  dataSlots: ExportDataSlotGroup[];
}
