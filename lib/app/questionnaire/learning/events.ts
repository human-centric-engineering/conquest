/**
 * Learning Mode — the per-session "learning was applied" audit marker.
 *
 * When the interviewer actually injects peer context into a turn, we record a one-off
 * `learning_applied` `AppQuestionnaireSessionEvent` on the session. This is the precise audit signal
 * for the bias caveat: not just "the round had learning on" (coarse) but "THIS session's answers were
 * influenced by peers". Idempotent (one row per session) and best-effort — it must never affect the
 * turn the respondent is taking.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';

export const LEARNING_APPLIED_EVENT = 'learning_applied';

/**
 * Record the `learning_applied` marker once for a session. Checks for an existing marker first, so a
 * later turn doesn't accrete duplicates. Fully fail-soft: a write failure is logged, never thrown.
 */
export async function recordLearningApplied(sessionId: string): Promise<void> {
  try {
    const existing = await prisma.appQuestionnaireSessionEvent.findFirst({
      where: { sessionId, eventType: LEARNING_APPLIED_EVENT },
      select: { id: true },
    });
    if (existing) return;
    await prisma.appQuestionnaireSessionEvent.create({
      data: { sessionId, eventType: LEARNING_APPLIED_EVENT },
    });
  } catch (err) {
    logger.warn('learning: failed to record learning_applied marker', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Whether a session's answers were influenced by Learning Mode (the bias-caveat signal). */
export async function wasLearningApplied(sessionId: string): Promise<boolean> {
  const row = await prisma.appQuestionnaireSessionEvent.findFirst({
    where: { sessionId, eventType: LEARNING_APPLIED_EVENT },
    select: { id: true },
  });
  return row !== null;
}
