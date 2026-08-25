/**
 * What a version's source documents look like to the surfaces that list them (F17.29).
 *
 * Pure — no Prisma. The query lives in `app/api/v1/app/questionnaires/_lib/source-documents.ts`;
 * the shape lives here so a client component can name it without reaching into a route module that
 * imports the database client.
 */

import type { SourceDocumentRole } from '@/lib/app/questionnaire/constants';

/** One document, as the admin surfaces show it. Never carries `extractedText`. */
export interface SourceDocumentView {
  id: string;
  role: SourceDocumentRole;
  fileName: string;
  byteSize: number;
  mimeType: string | null;
  pageCount: number | null;
  /** Characters of extracted text — what the analyst reads, and what its budget is spent in. */
  characterCount: number;
  createdAt: string;
}

/**
 * Narrow a stored `role` string to a role this build understands.
 *
 * Not a cast: the column is a `String`, and a row written by a later build with a role this one has
 * never heard of must not be read as `supplementary` and quietly fed to the analyst. Anything
 * unrecognised reads as `primary`, which is what every row written before the column existed is.
 */
export function narrowSourceDocumentRole(value: string): SourceDocumentRole {
  return value === 'supplementary' ? 'supplementary' : 'primary';
}
