/**
 * Per-client knowledge isolation — unit tests.
 *
 * Covers the tag provisioning (idempotent, persists the pointer), the document-id resolution used as
 * the vector-search allowlist, and the questionnaire-scoped view — including the no-bleed invariant
 * that one client's resolution never returns another client's documents.
 *
 * @see lib/app/questionnaire/report/client-knowledge.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    appDemoClient: { findUnique: vi.fn(), update: vi.fn() },
    knowledgeTag: { findUnique: vi.fn(), upsert: vi.fn() },
    aiKnowledgeDocumentTag: { findMany: vi.fn() },
    aiKnowledgeDocument: { findMany: vi.fn() },
    appQuestionnaire: { findUnique: vi.fn() },
  },
}));
vi.mock('@/lib/logging', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { prisma } from '@/lib/db/client';
import {
  clientKnowledgeTagSlug,
  ensureClientKnowledgeTag,
  resolveClientKnowledgeDocumentIds,
  getClientKnowledgeViewForQuestionnaire,
} from '@/lib/app/questionnaire/report/client-knowledge';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('clientKnowledgeTagSlug', () => {
  it('is deterministic and namespaced by the client id', () => {
    expect(clientKnowledgeTagSlug('clt-abc')).toBe('app-client-clt-abc');
  });
});

describe('ensureClientKnowledgeTag', () => {
  it('returns null when the client does not resolve', async () => {
    vi.mocked(prisma.appDemoClient.findUnique).mockResolvedValue(null);
    await expect(ensureClientKnowledgeTag('nope')).resolves.toBeNull();
  });

  it('reuses an existing tag pointer without re-provisioning', async () => {
    vi.mocked(prisma.appDemoClient.findUnique).mockResolvedValue({
      id: 'clt-1',
      name: 'Acme',
      knowledgeTagId: 'tag-1',
    } as never);
    vi.mocked(prisma.knowledgeTag.findUnique).mockResolvedValue({ id: 'tag-1' } as never);

    await expect(ensureClientKnowledgeTag('clt-1')).resolves.toBe('tag-1');
    expect(prisma.knowledgeTag.upsert).not.toHaveBeenCalled();
    expect(prisma.appDemoClient.update).not.toHaveBeenCalled();
  });

  it('provisions a tag by deterministic slug and persists the pointer when missing', async () => {
    vi.mocked(prisma.appDemoClient.findUnique).mockResolvedValue({
      id: 'clt-2',
      name: 'Beta Co',
      knowledgeTagId: null,
    } as never);
    vi.mocked(prisma.knowledgeTag.upsert).mockResolvedValue({ id: 'tag-new' } as never);
    vi.mocked(prisma.appDemoClient.update).mockResolvedValue({} as never);

    await expect(ensureClientKnowledgeTag('clt-2')).resolves.toBe('tag-new');

    const upsertArg = vi.mocked(prisma.knowledgeTag.upsert).mock.calls[0][0];
    expect(upsertArg.where).toEqual({ slug: 'app-client-clt-2' });
    expect(prisma.appDemoClient.update).toHaveBeenCalledWith({
      where: { id: 'clt-2' },
      data: { knowledgeTagId: 'tag-new' },
    });
  });

  it('re-links by slug when the pointer references a deleted tag', async () => {
    vi.mocked(prisma.appDemoClient.findUnique).mockResolvedValue({
      id: 'clt-3',
      name: 'Gamma',
      knowledgeTagId: 'stale-tag',
    } as never);
    // The pointed-at tag no longer exists.
    vi.mocked(prisma.knowledgeTag.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.knowledgeTag.upsert).mockResolvedValue({ id: 'tag-relinked' } as never);
    vi.mocked(prisma.appDemoClient.update).mockResolvedValue({} as never);

    await expect(ensureClientKnowledgeTag('clt-3')).resolves.toBe('tag-relinked');
    expect(prisma.appDemoClient.update).toHaveBeenCalledWith({
      where: { id: 'clt-3' },
      data: { knowledgeTagId: 'tag-relinked' },
    });
  });
});

describe('resolveClientKnowledgeDocumentIds', () => {
  it('returns [] when the client has no tag (no corpus)', async () => {
    vi.mocked(prisma.appDemoClient.findUnique).mockResolvedValue({
      knowledgeTagId: null,
    } as never);
    await expect(resolveClientKnowledgeDocumentIds('clt-1')).resolves.toEqual([]);
    expect(prisma.aiKnowledgeDocumentTag.findMany).not.toHaveBeenCalled();
  });

  it('returns the document ids carrying the client tag', async () => {
    vi.mocked(prisma.appDemoClient.findUnique).mockResolvedValue({
      knowledgeTagId: 'tag-1',
    } as never);
    vi.mocked(prisma.aiKnowledgeDocumentTag.findMany).mockResolvedValue([
      { documentId: 'doc-a' },
      { documentId: 'doc-b' },
    ] as never);

    await expect(resolveClientKnowledgeDocumentIds('clt-1')).resolves.toEqual(['doc-a', 'doc-b']);
    // Scoped to the client's tag only — the no-bleed query shape.
    expect(vi.mocked(prisma.aiKnowledgeDocumentTag.findMany).mock.calls[0][0]).toMatchObject({
      where: { tagId: 'tag-1' },
    });
  });

  it('isolates clients — resolution is keyed on each client’s own tag', async () => {
    // Client A → tag-A → [doc-a]; Client B → tag-B → [doc-b]. Neither sees the other's docs.
    vi.mocked(prisma.appDemoClient.findUnique)
      .mockResolvedValueOnce({ knowledgeTagId: 'tag-A' } as never)
      .mockResolvedValueOnce({ knowledgeTagId: 'tag-B' } as never);
    vi.mocked(prisma.aiKnowledgeDocumentTag.findMany)
      .mockResolvedValueOnce([{ documentId: 'doc-a' }] as never)
      .mockResolvedValueOnce([{ documentId: 'doc-b' }] as never);

    await expect(resolveClientKnowledgeDocumentIds('clt-A')).resolves.toEqual(['doc-a']);
    await expect(resolveClientKnowledgeDocumentIds('clt-B')).resolves.toEqual(['doc-b']);
    expect(vi.mocked(prisma.aiKnowledgeDocumentTag.findMany).mock.calls[0][0]).toMatchObject({
      where: { tagId: 'tag-A' },
    });
    expect(vi.mocked(prisma.aiKnowledgeDocumentTag.findMany).mock.calls[1][0]).toMatchObject({
      where: { tagId: 'tag-B' },
    });
  });
});

describe('getClientKnowledgeViewForQuestionnaire', () => {
  it('returns an unattributed view when the questionnaire has no demo client', async () => {
    vi.mocked(prisma.appQuestionnaire.findUnique).mockResolvedValue({ demoClient: null } as never);

    await expect(getClientKnowledgeViewForQuestionnaire('qn-1')).resolves.toEqual({
      client: null,
      knowledgeTagId: null,
      documents: [],
    });
    // No tag provisioning or document query when there's no client.
    expect(prisma.knowledgeTag.upsert).not.toHaveBeenCalled();
    expect(prisma.aiKnowledgeDocument.findMany).not.toHaveBeenCalled();
  });

  it('ensures the tag and lists the client’s documents scoped to that tag', async () => {
    vi.mocked(prisma.appQuestionnaire.findUnique).mockResolvedValue({
      demoClient: { id: 'clt-1', name: 'Acme' },
    } as never);
    // ensureClientKnowledgeTag path: pointer already set + tag exists.
    vi.mocked(prisma.appDemoClient.findUnique).mockResolvedValue({
      id: 'clt-1',
      name: 'Acme',
      knowledgeTagId: 'tag-1',
    } as never);
    vi.mocked(prisma.knowledgeTag.findUnique).mockResolvedValue({ id: 'tag-1' } as never);
    vi.mocked(prisma.aiKnowledgeDocument.findMany).mockResolvedValue([
      {
        id: 'doc-a',
        name: 'Playbook',
        fileName: 'playbook.md',
        status: 'ready',
        chunkCount: 12,
        sourceUrl: null,
        createdAt: new Date('2026-06-01T00:00:00Z'),
      },
    ] as never);

    const view = await getClientKnowledgeViewForQuestionnaire('qn-1');
    expect(view.client).toEqual({ id: 'clt-1', name: 'Acme' });
    expect(view.knowledgeTagId).toBe('tag-1');
    expect(view.documents).toEqual([
      {
        id: 'doc-a',
        name: 'Playbook',
        fileName: 'playbook.md',
        status: 'ready',
        chunkCount: 12,
        sourceUrl: null,
        createdAt: '2026-06-01T00:00:00.000Z',
      },
    ]);
    // The document list is scoped to the client's tag.
    expect(vi.mocked(prisma.aiKnowledgeDocument.findMany).mock.calls[0][0]).toMatchObject({
      where: { tags: { some: { tagId: 'tag-1' } } },
    });
  });
});
