/**
 * Session PDF export — pure model builder (F7.4).
 *
 * Assembles the {@link SessionExportModel} the React-PDF document renders from the rows
 * the DB seam (`_lib/session-export.ts`) loads. Pure: deterministic in its inputs, no
 * Prisma / Next / clock — the completion + generation timestamps are passed in, so the
 * builder unit-tests exhaustively.
 *
 * Two domain rules live here:
 *   - **Full coverage.** It calls {@link buildAnswerPanelView} with `full_progress`
 *     scope unconditionally, so every slot is present (the document marks unanswered
 *     ones "Not answered") regardless of the version's `answerSlotPanelScope`.
 *   - **Anonymous redaction.** When `anonymous` is set, `respondent` is dropped to null
 *     so no identity can reach the PDF — the F8.3 anonymous-mode contract honoured at
 *     the export boundary, not just the UI.
 *
 * `// DEMO-ONLY (F7.4):` questionnaire-domain shape — a fork strips this module.
 */

import type { AudienceShape, SessionStatus } from '@/lib/app/questionnaire/types';
import {
  buildAnswerPanelView,
  type PanelAnswerInput,
  type PanelSectionInput,
} from '@/lib/app/questionnaire/panel/answer-panel';
import { resolveTheme, type DemoClientTheme } from '@/lib/app/questionnaire/theming';
import type { ProfileValues } from '@/lib/app/questionnaire/profile/profile-values';
import type { SessionExportModel } from '@/lib/app/questionnaire/export/types';

/** The plain inputs the DB seam hands the builder. */
export interface SessionExportInput {
  questionnaireTitle: string;
  versionNumber: number;
  goal: string | null;
  /** Structured audience (or null); summarised to one line for the header. */
  audience: AudienceShape | null;
  /** Version `anonymousMode` — when true, identity is redacted. */
  anonymous: boolean;
  /** Respondent display name (or null); dropped when `anonymous`. */
  respondentName: string | null;
  /** Collected profile values (or null); dropped when `anonymous`, same as the name. */
  profile: ProfileValues | null;
  /** ISO completion timestamp (or null when the session isn't completed). */
  completedAt: string | null;
  /** ISO generation timestamp (the seam stamps it; the builder has no clock). */
  generatedAt: string;
  /** Demo-client theme columns (or null for the Sunrise default). */
  theme: DemoClientTheme | null;
  status: SessionStatus;
  sections: PanelSectionInput[];
  answers: PanelAnswerInput[];
}

/**
 * Condense an {@link AudienceShape} into a single header line. Prefers the free-text
 * description; falls back to the role; returns null when neither is present (the rest
 * of the structured fields are too granular for a one-line PDF header).
 */
function summariseAudience(audience: AudienceShape | null): string | null {
  if (!audience) return null;
  const description = audience.description?.trim();
  if (description) return description;
  const role = audience.role?.trim();
  if (role) return role;
  return null;
}

/** Assemble the export model. Pure. */
export function buildSessionExportModel(input: SessionExportInput): SessionExportModel {
  // Always full coverage: the export shows every slot, unanswered ones included.
  const panel = buildAnswerPanelView({
    status: input.status,
    scope: 'full_progress',
    sections: input.sections,
    answers: input.answers,
  });

  const respondent =
    input.anonymous || !input.respondentName ? null : { name: input.respondentName };
  // Profile is identity — dropped in anonymous mode, same rule as the respondent name.
  const profile = input.anonymous ? null : input.profile;

  return {
    questionnaireTitle: input.questionnaireTitle,
    versionNumber: input.versionNumber,
    goal: input.goal,
    audienceSummary: summariseAudience(input.audience),
    respondent,
    profile,
    anonymous: input.anonymous,
    completedAt: input.completedAt,
    generatedAt: input.generatedAt,
    theme: resolveTheme(input.theme),
    sections: panel.sections,
    answeredCount: panel.answeredCount,
    totalCount: panel.totalCount,
  };
}
