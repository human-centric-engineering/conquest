/**
 * Right-of-access service (GDPR Art. 15) — the other half of `eraseUser()`.
 *
 * Assembles one data subject's record into a single JSON bundle: their account
 * row, every core table that holds their data, the config they authored, any
 * erasure receipts naming them, and whatever the app declares through
 * `lib/app/data-export.ts`.
 *
 * The hard part of an access request is not serialising rows, it is knowing
 * *which* rows — so this service owns none of that decision. It walks
 * {@link SUBJECT_DATA_SOURCES}, the manifest that a build-breaking test holds
 * level with `prisma/schema/*.prisma`. Adding a table here is not a thing you
 * can forget to do; the test fails until the manifest names it.
 *
 * **A partial export is worse than no export.** A bundle that silently dropped
 * one source would still look like a complete answer to the subject receiving
 * it, so nothing here is best-effort: any source that throws fails the whole
 * export. That is the opposite of the erasure path, where hook failures are
 * swallowed so app trouble can never block a deletion — the asymmetry is
 * deliberate, and it follows from which failure the subject can detect.
 *
 * @see lib/privacy/export-sources.ts — the manifest and its coverage guard
 * @see lib/privacy/erase-user.ts — the Art. 17 counterpart
 * @see .context/privacy/data-export.md — the guide
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { collectAppSubjectData, type AppSubjectData } from '@/lib/app/data-export';
import {
  SUBJECT_DATA_SOURCES,
  EXCLUDED_SOURCES,
  type ExcludedSource,
  type SubjectQuery,
} from '@/lib/privacy/export-sources';

/**
 * Bundle format version. Bump on any breaking change to the shape below — a
 * fork's downstream tooling reads this to know what it is parsing.
 */
export const EXPORT_FORMAT_VERSION = 1;

export type ExportReason = 'self_service' | 'admin_action';

export interface ExportUserParams {
  /** Id of the data subject to export. */
  userId: string;
  /** Who asked (the subject themselves, or an admin acting on a request). */
  actorUserId: string;
  reason: ExportReason;
}

/** What one source contributed, echoed back so the subject can audit the scope. */
export interface ExportedSourceSummary {
  model: string;
  section: string;
  description: string;
  /** Present when the source returns only some of the subject's matching rows, and why. */
  scopeNote?: string;
  rows: number;
}

export interface SubjectExportMeta {
  formatVersion: number;
  generatedAt: string;
  subjectUserId: string;
  /** Sources returned in full, with row counts. */
  exported: ExportedSourceSummary[];
  /** Sources returned as id + label + date only, with row counts. */
  attribution: ExportedSourceSummary[];
  /** Tables deliberately left out, with the reason. */
  excluded: ExcludedSource[];
}

export interface SubjectExport {
  meta: SubjectExportMeta;
  /** The subject's account record. */
  account: Record<string, unknown>;
  /** The subject's own data, keyed by section. */
  personalData: Record<string, unknown[]>;
  /** Config the subject created — identity of each thing, not its contents. */
  attributions: Record<string, unknown[]>;
  /** Erasure receipts naming this subject. Normally empty for a live account. */
  erasureReceipts: unknown[];
  /** App-owned data, from the `lib/app/data-export.ts` seam. Empty in vanilla Sunrise. */
  app: AppSubjectData;
}

/** Raised when the subject has no account row. */
export class SubjectNotFoundError extends Error {
  constructor(userId: string) {
    super(`No user with id ${userId}`);
    this.name = 'SubjectNotFoundError';
  }
}

/**
 * Build one data subject's export bundle.
 *
 * Every source runs against the live database — there is no caching and no
 * partial result. Volume is unbounded by design: a subject with a long
 * conversation history gets all of it, because truncating an access response
 * without saying so is the failure this whole path exists to avoid. Callers
 * that need to bound the response should stream or paginate at the transport,
 * not drop rows here.
 *
 * @throws {SubjectNotFoundError} if no user row matches `userId`
 */
export async function exportUserData(params: ExportUserParams): Promise<SubjectExport> {
  const { userId, actorUserId, reason } = params;

  const account = await prisma.user.findUnique({ where: { id: userId } });
  if (!account) {
    throw new SubjectNotFoundError(userId);
  }

  const subject: SubjectQuery = { userId, email: account.email };

  // Run every source, then split by disposition. A rejection here propagates:
  // an export that quietly lost a section would be indistinguishable, to the
  // person reading it, from one that had nothing to show.
  const results = await Promise.all(
    SUBJECT_DATA_SOURCES.map(async (source) => ({ source, rows: await source.fetch(subject) }))
  );

  const personalData: Record<string, unknown[]> = {};
  const attributions: Record<string, unknown[]> = {};
  const exported: ExportedSourceSummary[] = [];
  const attribution: ExportedSourceSummary[] = [];

  for (const { source, rows } of results) {
    const summary: ExportedSourceSummary = {
      model: source.model,
      section: source.section,
      description: source.description,
      // Only present on narrowed sources — a row count with no note means the
      // subject received every row that matched them.
      ...(source.scopeNote ? { scopeNote: source.scopeNote } : {}),
      rows: rows.length,
    };

    if (source.disposition === 'export') {
      personalData[source.section] = rows;
      exported.push(summary);
    } else {
      attributions[source.section] = rows;
      attribution.push(summary);
    }
  }

  // Receipts are keyed by `subjectUserId` with no FK, so they survive the user
  // row. A live subject normally has none; one appears only if an id was
  // reused, which is worth showing rather than hiding.
  const erasureReceipts = await prisma.dataErasureReceipt.findMany({
    where: { subjectUserId: userId },
    orderBy: { erasedAt: 'asc' },
  });

  const app = await collectAppSubjectData(subject);

  const totalRows =
    results.reduce((sum, { rows }) => sum + rows.length, 0) + erasureReceipts.length;

  logger.info('Subject data export generated', {
    userId,
    actorUserId,
    reason,
    sources: results.length,
    totalRows,
    appSections: Object.keys(app).length,
  });

  return {
    meta: {
      formatVersion: EXPORT_FORMAT_VERSION,
      generatedAt: new Date().toISOString(),
      subjectUserId: userId,
      exported,
      attribution,
      excluded: EXCLUDED_SOURCES,
    },
    account,
    personalData,
    attributions,
    erasureReceipts,
    app,
  };
}
