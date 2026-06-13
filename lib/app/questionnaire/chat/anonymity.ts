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
import {
  narrowToEnum,
  PRESENTATION_MODES,
  type PresentationMode,
} from '@/lib/app/questionnaire/types';

/** Resolve `anonymousMode` for a launched version (no-login / preview respondent surface). */
export async function resolveAnonymousForVersion(versionId: string): Promise<boolean> {
  const version = await prisma.appQuestionnaireVersion.findUnique({
    where: { id: versionId },
    select: { config: { select: { anonymousMode: true } } },
  });
  return version?.config?.anonymousMode ?? false;
}

/**
 * Resolve `presentationMode` (chat | form | both) for a launched version (no-login / preview
 * respondent surface). Config is 1:1 and lazy — an absent row defaults to `chat`. The
 * authenticated surface reads it off its session-ownership query instead.
 */
export async function resolvePresentationModeForVersion(
  versionId: string
): Promise<PresentationMode> {
  const version = await prisma.appQuestionnaireVersion.findUnique({
    where: { id: versionId },
    select: { config: { select: { presentationMode: true } } },
  });
  return narrowToEnum(version?.config?.presentationMode ?? 'chat', PRESENTATION_MODES, 'chat');
}
