/**
 * Unit test: the source-document read seam (F17.29).
 *
 * Anti-green-bar: `listSourceDocuments` exists to do three things the caller cannot see from its
 * signature, so all three are asserted against a mocked Prisma rather than against the mock's own
 * return value — it must (1) never hand `extractedText` back, only its length, because that column
 * runs to megabytes and every admin surface listing filenames would otherwise pay for it; (2) push
 * the stored `role` string through the defensive narrowing rather than trusting the column; and
 * (3) order newest-first, which is what the Supporting Documents card renders without re-sorting.
 *
 * @see app/api/v1/app/questionnaires/_lib/source-documents.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireSourceDocument: { findMany: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

import { listSourceDocuments } from '@/app/api/v1/app/questionnaires/_lib/source-documents';

const CREATED = new Date('2026-08-25T10:30:00.000Z');

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'doc-1',
    role: 'primary',
    fileName: 'instrument.pdf',
    byteSize: 2048,
    mimeType: 'application/pdf',
    pageCount: 12,
    extractedText: 'x'.repeat(4321),
    createdAt: CREATED,
    ...overrides,
  };
}

describe('listSourceDocuments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the character count and never the extracted text itself', async () => {
    prismaMock.appQuestionnaireSourceDocument.findMany.mockResolvedValue([row()]);

    const [doc] = await listSourceDocuments('v1');

    expect(doc.characterCount).toBe(4321);
    expect(doc).not.toHaveProperty('extractedText');
    expect(JSON.stringify(doc)).not.toContain('xxxx');
  });

  it('narrows a role the build does not recognise to primary', async () => {
    prismaMock.appQuestionnaireSourceDocument.findMany.mockResolvedValue([
      row({ id: 'a', role: 'supplementary' }),
      row({ id: 'b', role: 'routing_memo_v2' }),
    ]);

    const docs = await listSourceDocuments('v1');

    expect(docs.map((d) => d.role)).toEqual(['supplementary', 'primary']);
  });

  it('serialises createdAt to an ISO string and passes the rest through unchanged', async () => {
    prismaMock.appQuestionnaireSourceDocument.findMany.mockResolvedValue([
      row({ mimeType: null, pageCount: null }),
    ]);

    const [doc] = await listSourceDocuments('v1');

    expect(doc).toEqual({
      id: 'doc-1',
      role: 'primary',
      fileName: 'instrument.pdf',
      byteSize: 2048,
      mimeType: null,
      pageCount: null,
      characterCount: 4321,
      createdAt: '2026-08-25T10:30:00.000Z',
    });
  });

  it('scopes to the version and asks the database for newest-first', async () => {
    prismaMock.appQuestionnaireSourceDocument.findMany.mockResolvedValue([]);

    await expect(listSourceDocuments('version-42')).resolves.toEqual([]);

    const args = prismaMock.appQuestionnaireSourceDocument.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ versionId: 'version-42' });
    expect(args.orderBy).toEqual({ createdAt: 'desc' });
    // The column is selected so it can be measured — the guard above is that it is not returned.
    expect(args.select.extractedText).toBe(true);
  });
});
