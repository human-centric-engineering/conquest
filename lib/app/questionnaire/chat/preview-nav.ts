/**
 * Resolve the admin "Exit preview" target for the no-login respondent surface (`/q/[versionId]`).
 *
 * When an admin previews a launched questionnaire (`?preview=1`) the surface has only a
 * `versionId`; to send them back to the admin workspace we need the owning questionnaire id.
 * This is the one extra lookup the preview banner needs — it runs only in preview mode.
 *
 * Server-only. A fork that strips the demo respondent surfaces drops this file with them.
 *
 * @see app/(public)/q/[versionId]/page.tsx
 */

import { prisma } from '@/lib/db/client';
import { workspaceVersionBase } from '@/lib/app/questionnaire/workspace-nav';

/**
 * Admin workspace URL for a version (`/admin/questionnaires/:id/v/:vid`), or `null` if the
 * version no longer exists — in which case the preview banner simply omits the exit link.
 */
export async function resolveAdminPreviewExitHref(versionId: string): Promise<string | null> {
  const version = await prisma.appQuestionnaireVersion.findUnique({
    where: { id: versionId },
    select: { questionnaireId: true },
  });
  if (!version) return null;
  return workspaceVersionBase(version.questionnaireId, versionId);
}
