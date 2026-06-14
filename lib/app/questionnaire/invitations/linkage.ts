/**
 * Session ↔ invitation linkage + the COMPLETION-TRACKING-ONLY invariant.
 *
 * The frictionless invite flow stamps `AppQuestionnaireSession.invitationId` so admins can see who
 * was invited / started / completed. That linkage is powerful and dangerous: it joins a named
 * invitee to a session — and a session owns answer content. This module is the single source of
 * truth for the rule that keeps it safe, mirroring the `AppRespondentProfileSnapshot` anonymous
 * invariant.
 *
 * ⚠️ COMPLETION-TRACKING-ONLY INVARIANT ⚠️
 * When a version's config has `anonymousMode = true`, NO query or export may return invitee identity
 * (`email`, `name`, `profile`, `userId`) on the same record as answer content (`AppAnswerSlot`,
 * `AppDataSlotFill`, or transcript turns). The session↔invitation link may be read ONLY to compute
 * per-invitee STATUS (invited / started / completed) — NEVER to attribute answers to a person.
 *
 * Enforcement is at the read layer (this is a guarantee about what leaves the boundary, not a DB
 * constraint — the FK-less `invitationId` column is a residual DB-level join, acknowledged):
 *   - `analytics/funnel.ts` is counts-only by construction (safe).
 *   - The invitations management read (`_lib/read.ts`) projects STATUS only — identity + progress,
 *     never answers — and the UI omits any "view answers" affordance for an anonymous version.
 *   - Any answer/transcript export must drop invitee identity columns when the version is anonymous.
 *
 * Stricter cryptographic unlinkability (a content-free completion-marker row with no sessionId) is a
 * deferred later phase; see `.context/app/questionnaire/invitations.md`.
 *
 * Server-only (resolves config from the database).
 */

import { prisma } from '@/lib/db/client';

/**
 * Whether a version is anonymous (the identity axis) — the trigger for the completion-tracking-only
 * invariant. Config is 1:1 and lazy; an absent row means NOT anonymous (the default). Read paths
 * that join `invitationId` → invitee identity MUST call this and drop identity when it returns true.
 */
export async function isAnonymousVersion(versionId: string): Promise<boolean> {
  const version = await prisma.appQuestionnaireVersion.findUnique({
    where: { id: versionId },
    select: { config: { select: { anonymousMode: true } } },
  });
  return version?.config?.anonymousMode ?? false;
}
