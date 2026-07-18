/**
 * Per-version soft-archive writer.
 *
 * Sets/clears `AppQuestionnaireVersion.archivedAt` — the orthogonal-to-`status` marker
 * that hides a version from the default admin version list (selector + history) while
 * keeping it fully recoverable. Deliberately NEVER touches `status`: unlike the terminal
 * `status: 'archived'` lifecycle state (blocked while a launched version has live
 * sessions/invitations), this marker leaves the lifecycle — and any in-flight respondent
 * sessions pinned to the version — untouched.
 *
 * Single-sourced so both the standalone archive/restore routes and the archive-on-fork
 * path (`_lib/fork.ts`) write the marker + emit the audit event identically. Route-local
 * DB seam (uses `prisma`), mirroring `_lib/fork.ts`.
 */

import { prisma } from '@/lib/db/client';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

/** Audit attribution carried from the route (admin user + client IP). */
export interface VersionArchiveAudit {
  userId: string | null;
  clientIp?: string | null;
}

/** The archive state after a `setVersionArchived` call. `archivedAt` is ISO or null. */
export interface VersionArchiveResult {
  id: string;
  archivedAt: string | null;
}

/**
 * Archive (`archived: true`) or restore (`false`) a version by stamping/clearing
 * `archivedAt`. Idempotent: when the version is already in the requested state it returns
 * the current marker with no write and no duplicate audit. Returns `null` when no version
 * has that id (the caller 404s). Audited `questionnaire_version.archive` / `.restore`.
 */
export async function setVersionArchived(
  versionId: string,
  archived: boolean,
  audit?: VersionArchiveAudit
): Promise<VersionArchiveResult | null> {
  const before = await prisma.appQuestionnaireVersion.findUnique({
    where: { id: versionId },
    select: { id: true, archivedAt: true, questionnaireId: true, versionNumber: true },
  });
  if (!before) return null;

  // Already in the requested state → idempotent no-op (no re-stamp, no duplicate audit).
  if ((before.archivedAt !== null) === archived) {
    return { id: before.id, archivedAt: before.archivedAt?.toISOString() ?? null };
  }

  const updated = await prisma.appQuestionnaireVersion.update({
    where: { id: versionId },
    data: { archivedAt: archived ? new Date() : null },
    select: { archivedAt: true },
  });

  logAdminAction({
    userId: audit?.userId ?? null,
    action: archived ? 'questionnaire_version.archive' : 'questionnaire_version.restore',
    entityType: 'questionnaire_version',
    entityId: versionId,
    metadata: { questionnaireId: before.questionnaireId, versionNumber: before.versionNumber },
    clientIp: audit?.clientIp ?? null,
  });

  return { id: before.id, archivedAt: updated.archivedAt?.toISOString() ?? null };
}
