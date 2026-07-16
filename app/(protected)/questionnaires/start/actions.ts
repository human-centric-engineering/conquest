'use server';

/**
 * Server actions for the authenticated respondent start flow (session resume).
 *
 * `startFreshAuthedSession` backs the "Start a new questionnaire" choice on the resume chooser:
 * abandon the respondent's in-progress session (so it isn't left dangling) and mint a fresh one,
 * then redirect into it. Kept out of the page component so the chooser (a client component) can
 * invoke it directly.
 */

import { redirect } from 'next/navigation';

import { prisma } from '@/lib/db/client';
import { getServerSession } from '@/lib/auth/utils';
import { clearInvalidSession } from '@/lib/auth/clear-session';
import { logger } from '@/lib/logging';
import { abandonSession } from '@/app/api/v1/app/questionnaires/_lib/sessions';
import { createSessionForVersion } from '@/app/api/v1/app/questionnaire-sessions/_lib/create';

/**
 * Abandon the caller's current in-progress session for a version and start a fresh one. The abandon
 * is best-effort and ownership-checked (a mismatched or already-terminal session is simply skipped)
 * so it can never wedge the fresh start. Redirects to the new session's chat surface.
 */
export async function startFreshAuthedSession(
  versionId: string,
  oldSessionId: string
): Promise<void> {
  const session = await getServerSession();
  if (!session) {
    clearInvalidSession(`/questionnaires/start?versionId=${encodeURIComponent(versionId)}`);
    return; // unreachable — clearInvalidSession redirects
  }

  // Only abandon a still-open session that actually belongs to this respondent.
  const old = await prisma.appQuestionnaireSession.findUnique({
    where: { id: oldSessionId },
    select: { respondentUserId: true, status: true },
  });
  if (
    old?.respondentUserId === session.user.id &&
    (old.status === 'active' || old.status === 'paused')
  ) {
    try {
      await abandonSession(oldSessionId, { reason: 'respondent_start_new' });
    } catch (err) {
      // Best-effort — a failed abandon just leaves the old session to age out via retention.
      logger.warn('startFreshAuthedSession: abandon failed', {
        oldSessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // With the prior session abandoned, the idempotent create finds nothing resumable and mints fresh.
  const result = await createSessionForVersion(versionId, session.user.id);
  if (!result.ok) {
    // Bounce back to the start page, which re-resolves and surfaces the friendly failure screen.
    redirect(`/questionnaires/start?versionId=${encodeURIComponent(versionId)}`);
  }

  redirect(`/questionnaires/${result.session.id}`);
}
