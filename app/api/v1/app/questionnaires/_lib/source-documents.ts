/**
 * Source-document reads shared by the documents routes and the topics payload.
 *
 * Route-local DB seam — `lib/app/questionnaire/**` stays Prisma-free, so the view shape it returns
 * lives there ({@link SourceDocumentView}) and only the query lives here.
 */

import { prisma } from '@/lib/db/client';
import {
  narrowSourceDocumentRole,
  type SourceDocumentView,
} from '@/lib/app/questionnaire/ingestion/source-documents';

/**
 * Every document on a version, newest first.
 *
 * Metadata only. `extractedText` is the instrument itself and runs to megabytes, so it is measured
 * here (`characterCount`) and never returned — an admin surface that listed documents by shipping
 * their full text would be paying the analyst's bandwidth to render a filename.
 */
export async function listSourceDocuments(versionId: string): Promise<SourceDocumentView[]> {
  const rows = await prisma.appQuestionnaireSourceDocument.findMany({
    where: { versionId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      role: true,
      fileName: true,
      byteSize: true,
      mimeType: true,
      pageCount: true,
      extractedText: true,
      createdAt: true,
    },
  });

  return rows.map((row) => ({
    id: row.id,
    role: narrowSourceDocumentRole(row.role),
    fileName: row.fileName,
    byteSize: row.byteSize,
    mimeType: row.mimeType,
    pageCount: row.pageCount,
    characterCount: row.extractedText.length,
    createdAt: row.createdAt.toISOString(),
  }));
}
