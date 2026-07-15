/**
 * Respondent profile snapshot — shared upsert (F-capture).
 *
 * One `AppRespondentProfileSnapshot` row per session (1:1, `sessionId @unique`). Three writers land
 * here so they never race on the unique constraint or disagree on shape:
 *   - session-create seam (`questionnaire-sessions/_lib/create.ts`) — legacy pre-session capture;
 *   - the in-flow capture endpoint (`[id]/profile` PUT) — the form-mode gate;
 *   - the conversational-capture extraction pass — maps a transcript to the fields.
 *
 * `upsert` (not `create`) makes a re-submit / resume / late conversational fill idempotent. Never
 * called for an anonymous session — the callers guard on `anonymousMode` (the PII-free invariant).
 * Server-only (Prisma).
 */

import type { Prisma } from '@prisma/client';

import type { ProfileValues } from '@/lib/app/questionnaire/profile/profile-values';

/** A Prisma client or an interactive-transaction client — both expose the model delegate. */
type ProfileSnapshotDb = Pick<Prisma.TransactionClient, 'appRespondentProfileSnapshot'>;

/**
 * Idempotently write the collected profile values for a session. `respondentUserId` is the authed
 * owner (denormalised for the GDPR cascade) or `null` for a non-anonymous no-login respondent.
 */
export async function upsertProfileSnapshot(
  db: ProfileSnapshotDb,
  sessionId: string,
  respondentUserId: string | null,
  values: ProfileValues
): Promise<void> {
  await db.appRespondentProfileSnapshot.upsert({
    where: { sessionId },
    create: { sessionId, respondentUserId, values },
    update: { values, respondentUserId },
  });
}
