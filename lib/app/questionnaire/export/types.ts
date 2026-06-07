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
}
