/**
 * Round Additional Context ("interviewer briefing") — the per-turn DB read.
 *
 * Loads a round's briefing entries for the bundled version the session is running, in author order.
 * Route-local seam (the `lib/app/**` boundary is Prisma-free); the pure selection/formatting lives in
 * `lib/app/questionnaire/rounds/briefing.ts`. Returns `null` when the round is gone or its per-round
 * `contextEnabled` toggle is off — so the caller treats "no briefing" and "briefing disabled"
 * identically (no injection).
 */

import { prisma } from '@/lib/db/client';
import type { BriefingEntryLite } from '@/lib/app/questionnaire/rounds/briefing';

/**
 * The round's briefing entries for `versionId`, ordered by `ordinal` then creation, or `null` when
 * the round no longer exists or has `contextEnabled = false`. One indexed query
 * (`app_round_context_entry_roundId_versionId_questionSlotId_idx`).
 */
export async function loadRoundBriefing(
  roundId: string,
  versionId: string
): Promise<BriefingEntryLite[] | null> {
  const round = await prisma.appQuestionnaireRound.findUnique({
    where: { id: roundId },
    select: {
      contextEnabled: true,
      contextEntries: {
        where: { versionId },
        orderBy: [{ ordinal: 'asc' }, { createdAt: 'asc' }],
        select: { questionSlotId: true, title: true, content: true },
      },
    },
  });
  if (!round || !round.contextEnabled) return null;
  return round.contextEntries;
}
