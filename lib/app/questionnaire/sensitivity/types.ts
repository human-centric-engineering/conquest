/**
 * Sensitivity awareness / safeguarding — pure in-memory shapes.
 *
 * A respondent may disclose something sensitive or contentious mid-conversation (abuse, distress,
 * a safeguarding concern). This module owns the pure, DB-free shapes for that capture. Like the
 * seriousness gate and contradiction detection, the orchestrator never persists here: it returns a
 * {@link SensitivityOutcome} and the route writes the session memory + event.
 *
 * It is **best-effort awareness, not a hard safeguarding guarantee** — detection rides on the
 * answer-extractor's structured output (the `suspectedNonGenuine` precedent showed those side
 * signals can be missed). A miss simply means that turn isn't softened.
 */

import type { SensitivitySeverity } from '@/lib/app/questionnaire/types';

/**
 * The extractor's per-turn assessment of a sensitive/contentious disclosure. Absent when the
 * message contains no genuine disclosure. `summary` is a CAREFUL, NON-GRAPHIC one-line restatement
 * — it is the only field allowed to carry disclosure content, and it never enters provenance,
 * event metadata, or analytics (PII discipline).
 */
export interface SensitivityAssessment {
  detected: true;
  severity: SensitivitySeverity;
  /** Short category label, e.g. "harassment", "self-harm", "bereavement". */
  category: string;
  /** A careful, non-graphic one-line restatement of what was disclosed. */
  summary: string;
}

/**
 * One remembered disclosure, persisted (append-only) on `AppQuestionnaireSession.sensitivityNotes`.
 * The pure core produces `{ severity, category, summary }`; the route stamps `turnOrdinal` +
 * `createdAt` (the clock lives in the route, never the pure core).
 */
export interface SensitivityNote {
  severity: SensitivitySeverity;
  category: string;
  summary: string;
  /** The selection round (0-based turn index) the disclosure was made on. */
  turnOrdinal: number;
  /** ISO timestamp stamped at the persistence seam. */
  createdAt: string;
}

/**
 * The pure orchestrator's sensitivity outcome for one turn, returned on `TurnResult.sensitivity`
 * (present only when a disclosure was detected this turn). The route appends a note, persists
 * `newLevel`, writes a `sensitivity_flagged` event, and — when `signpost` — has already had the
 * support frame streamed by the core.
 */
export interface SensitivityOutcome {
  detected: true;
  severity: SensitivitySeverity;
  category: string;
  summary: string;
  /** Running-max severity across the session after folding this turn in. */
  newLevel: SensitivitySeverity;
  /** True the first time the session reaches `high` — drives the once-per-session support signpost. */
  signpost: boolean;
}
