/**
 * Resolve the admin preview banner's metadata for the no-login respondent surface
 * (`/q/[versionId]`).
 *
 * When an admin previews a launched questionnaire (`?preview=1`) the surface has only a
 * `versionId`; the banner names which version is being previewed (number + status) and
 * links back to the admin workspace, both of which need the owning version row. This is
 * the one extra lookup the preview banner needs — it runs only in preview mode.
 *
 * Server-only. A fork that strips the demo respondent surfaces drops this file with them.
 *
 * @see app/(public)/q/[versionId]/page.tsx
 */

import { prisma } from '@/lib/db/client';
import { workspaceVersionBase } from '@/lib/app/questionnaire/workspace-nav';
import type { AppQuestionnaireStatus } from '@/lib/app/questionnaire/types';

/** What the admin preview banner needs to identify the version it's previewing. */
export interface AdminPreviewMeta {
  /** Admin workspace URL for the version (`/admin/questionnaires/:id/v/:vid`). */
  exitHref: string;
  /** 1-based version number shown to the admin (e.g. "v3"). */
  versionNumber: number;
  /** Version lifecycle status (`draft` | `launched` | `archived`). */
  status: AppQuestionnaireStatus;
}

/**
 * Version metadata for the admin preview banner, or `null` if the version no longer exists —
 * in which case the banner simply renders without the exit link or version detail.
 */
export async function resolveAdminPreviewMeta(versionId: string): Promise<AdminPreviewMeta | null> {
  const version = await prisma.appQuestionnaireVersion.findUnique({
    where: { id: versionId },
    select: { questionnaireId: true, versionNumber: true, status: true },
  });
  if (!version) return null;
  return {
    exitHref: workspaceVersionBase(version.questionnaireId, versionId),
    versionNumber: version.versionNumber,
    status: version.status as AppQuestionnaireStatus,
  };
}
