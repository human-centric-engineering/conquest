/**
 * Chat-transcript export — pure model builder (F7.6).
 *
 * Assembles the {@link TranscriptExportModel} both transcript renderers consume from the
 * rows the DB seam (`_lib/transcript-export.ts`) loads. Pure: deterministic in its inputs,
 * no Prisma / Next / clock — the generation timestamp is passed in, so the builder
 * unit-tests exhaustively.
 *
 * Two domain rules live here:
 *   - **Speaker labels.** The agent is always "Interviewer". The respondent is their
 *     display name when one is known AND the session is not anonymous; otherwise the
 *     generic "Respondent". Anonymous mode therefore never leaks identity into the label,
 *     mirroring the F7.4 answers-export redaction.
 *   - **Turn flattening.** Each persisted turn yields an optional respondent line (skipped
 *     for the empty-message kickoff turn) followed by the interviewer's reply — the same
 *     rule the live transcript replay (`_lib/transcript.ts`) uses, so the export matches
 *     what the respondent saw on screen.
 *
 * `// DEMO-ONLY (F7.6):` questionnaire-domain shape — a fork strips this module.
 */

import type { AudienceShape, SessionStatus } from '@/lib/app/questionnaire/types';
import { resolveTheme, type DemoClientTheme } from '@/lib/app/questionnaire/theming';
import { formatSessionRef } from '@/lib/app/questionnaire/session-ref';
import { summariseAudience } from '@/lib/app/questionnaire/export/build-session-export-model';
import type {
  TranscriptExportModel,
  TranscriptTurnView,
} from '@/lib/app/questionnaire/export/transcript-types';

/** One persisted turn as the seam hands it to the builder (oldest-first). */
export interface TranscriptTurnInput {
  /** The respondent's message; empty for the opening kickoff turn (skipped). */
  userMessage: string;
  /** The agent's reply. */
  agentResponse: string;
  /** ISO timestamp the turn was recorded. */
  at: string;
}

/** The plain inputs the DB seam hands the builder. */
export interface TranscriptExportInput {
  questionnaireTitle: string;
  versionNumber: number;
  goal: string | null;
  /** Structured audience (or null); summarised to one line for the header. */
  audience: AudienceShape | null;
  /** Raw `publicRef` (8-char, no dash), or null when the session has none. */
  refRaw: string | null;
  /** Version `anonymousMode` — when true, the respondent label stays generic. */
  anonymous: boolean;
  /** Respondent display name (or null); used as the label only when not anonymous. */
  respondentName: string | null;
  /** ISO timestamp the session began (when it was created), or null when unknown. */
  startedAt: string | null;
  /** ISO timestamp the session completed, or null when not yet completed. */
  completedAt: string | null;
  status: SessionStatus;
  /** ISO timestamp the export was generated (footer). */
  generatedAt: string;
  /** Raw demo-client theme columns (or null when unattributed); resolved here. */
  theme: DemoClientTheme | null;
  /** The persisted turns, oldest-first. */
  turns: TranscriptTurnInput[];
}

/** The label always shown against the agent's turns. */
const INTERVIEWER_LABEL = 'Interviewer';
/** The fallback respondent label when no name is usable (anonymous or unknown). */
const RESPONDENT_LABEL = 'Respondent';

/**
 * Flatten persisted turns into rendered lines. The empty-message kickoff turn contributes
 * only its interviewer reply; an empty agent reply (shouldn't happen) is likewise skipped,
 * so the transcript never renders a blank line.
 */
function flattenTurns(turns: TranscriptTurnInput[]): TranscriptTurnView[] {
  const lines: TranscriptTurnView[] = [];
  for (const turn of turns) {
    if (turn.userMessage.trim().length > 0) {
      lines.push({ speaker: 'respondent', text: turn.userMessage, at: turn.at });
    }
    if (turn.agentResponse.trim().length > 0) {
      lines.push({ speaker: 'interviewer', text: turn.agentResponse, at: turn.at });
    }
  }
  return lines;
}

/** Assemble the transcript export model. Pure. */
export function buildTranscriptExportModel(input: TranscriptExportInput): TranscriptExportModel {
  const name = input.respondentName?.trim();
  const respondentLabel = !input.anonymous && name ? name : RESPONDENT_LABEL;

  return {
    questionnaireTitle: input.questionnaireTitle,
    versionNumber: input.versionNumber,
    goal: input.goal,
    audienceSummary: summariseAudience(input.audience),
    refDisplay: input.refRaw ? formatSessionRef(input.refRaw) : null,
    anonymous: input.anonymous,
    respondentLabel,
    interviewerLabel: INTERVIEWER_LABEL,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    status: input.status,
    generatedAt: input.generatedAt,
    theme: resolveTheme(input.theme),
    turns: flattenTurns(input.turns),
  };
}
