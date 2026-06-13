/**
 * Resolve a version's `anonymousMode` for the respondent opening turn — does the surface get
 * to promise "your name and details won't be passed on"? (See {@link buildWelcomeTurns}.)
 *
 * Config is 1:1 and lazy: an absent config row means the default, not anonymous. The
 * authenticated surface reads the flag straight off its session-ownership query and does not
 * need this helper; the no-login (`/q/[versionId]`) surface has only a versionId, so it calls
 * here. A fork that strips the demo respondent surfaces drops both call sites and this file.
 *
 * Server-only.
 *
 * @see lib/app/questionnaire/chat/greeting.ts
 */

import { prisma } from '@/lib/db/client';

/** Resolve `anonymousMode` for a launched version (no-login / preview respondent surface). */
export async function resolveAnonymousForVersion(versionId: string): Promise<boolean> {
  const version = await prisma.appQuestionnaireVersion.findUnique({
    where: { id: versionId },
    select: { config: { select: { anonymousMode: true } } },
  });
  return version?.config?.anonymousMode ?? false;
}
