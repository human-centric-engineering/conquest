/**
 * Respondent-facing "this version is archived" signal.
 *
 * A version soft-archived via `archivedAt` (see `.context/app/questionnaire/archiving.md`) is
 * **retired from respondents** even while its `status` is still `launched`: every respondent
 * entry point (session create, in-flight turns, cross-device resume) refuses with this code so
 * the surface can show a clear "the questionnaire has been archived" notice instead of running.
 *
 * Client-safe (no server-only imports): both the API routes and the `'use client'` boot component
 * import the same code/message contract. `410 Gone` is the HTTP status — the questionnaire was
 * available and no longer is.
 */

/** Error code returned by every respondent path when the target version is archived. */
export const VERSION_ARCHIVED_CODE = 'VERSION_ARCHIVED';

/** Respondent-facing copy shown in the archived notice. */
export const VERSION_ARCHIVED_MESSAGE =
  'This questionnaire has been archived and is no longer available.';
