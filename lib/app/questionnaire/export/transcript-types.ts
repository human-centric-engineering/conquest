/**
 * Chat-transcript export — pure, serialisable view contract (F7.6).
 *
 * The shape both transcript renderers (the themed React-PDF document and the plain-text
 * serialiser) consume for ONE session: an intro header that explains the questionnaire
 * context (title, goal, audience), the support reference, the run's key details
 * (anonymous / respondent / timing / status), then the conversation itself — every turn
 * labelled and timestamped.
 *
 * Sibling to {@link SessionExportModel} (the F7.4 *answers* export): that artefact renders
 * the captured slot values; this one renders the verbatim conversation the respondent had.
 *
 * Prisma-free and Next-free: the DB read seam
 * (`app/api/v1/app/questionnaire-sessions/_lib/transcript-export.ts`) loads the rows and
 * the pure {@link buildTranscriptExportModel} assembles this; the routes render it.
 *
 * `// DEMO-ONLY (F7.6):` questionnaire-domain shape — a fork strips this module alongside
 * the F7.4 answers export.
 */

import type { ResolvedTheme } from '@/lib/app/questionnaire/theming';
import type { SessionStatus } from '@/lib/app/questionnaire/types';

/** Who spoke a turn. `interviewer` = the questionnaire agent; `respondent` = the user. */
export type TranscriptSpeaker = 'interviewer' | 'respondent';

/** One rendered transcript line: a speaker, the text they contributed, and when. */
export interface TranscriptTurnView {
  /** Maps to {@link TranscriptExportModel.interviewerLabel} / `respondentLabel`. */
  speaker: TranscriptSpeaker;
  /** The verbatim message text. */
  text: string;
  /** ISO timestamp the underlying turn was recorded. */
  at: string;
}

/** Everything the transcript renderers need for one session, fully resolved. */
export interface TranscriptExportModel {
  /** Questionnaire title (the document heading). */
  questionnaireTitle: string;
  /** 1-based version number the session ran on. */
  versionNumber: number;
  /** The version's stated goal, or null when unset. */
  goal: string | null;
  /** A one-line audience summary derived from the version's `AudienceShape`, or null. */
  audienceSummary: string | null;
  /** Grouped support reference (`7F3K-9M2P`), or null when the session has none. */
  refDisplay: string | null;
  /** True when the version is configured `anonymousMode` (drives the respondent label). */
  anonymous: boolean;
  /**
   * The label shown against the respondent's turns: their display name when one is known
   * AND the session is not anonymous, otherwise the generic "Respondent". Resolved in the
   * builder so both renderers stay label-agnostic.
   */
  respondentLabel: string;
  /** The label shown against the agent's turns — always "Interviewer". */
  interviewerLabel: string;
  /** ISO timestamp the session began (when it was created), or null when unknown. */
  startedAt: string | null;
  /** ISO timestamp the session completed, or null when not yet completed. */
  completedAt: string | null;
  /** The session's current lifecycle status (header detail). */
  status: SessionStatus;
  /** ISO timestamp the transcript was generated (footer). */
  generatedAt: string;
  /** Resolved demo-client theme (accent colour + logo) for branding the PDF. */
  theme: ResolvedTheme;
  /** The conversation, oldest-first: each speaker turn with its timestamp. */
  turns: TranscriptTurnView[];
}
