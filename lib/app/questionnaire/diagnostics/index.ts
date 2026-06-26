/**
 * Diagnostics — per-invitation telemetry + error capture (Diagnostics).
 *
 * Barrel for the error-capture seam and the diagnostics aggregation reads. The capture seam is
 * always-on (no feature flag) so a failure is never missed; the admin Diagnostics tab is gated on
 * `liveSessions` (it's meaningless without live respondent sessions).
 */

export {
  recordQuestionnaireError,
  ERROR_SCOPES,
  type ErrorScope,
  type ErrorSeverity,
  type RecordQuestionnaireErrorInput,
} from '@/lib/app/questionnaire/diagnostics/record-error';
