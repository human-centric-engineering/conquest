/**
 * ClientKnowledgePanel — component tests.
 *
 * Covers the unattributed-client notice, listing the client's documents, the tag-stamped upload, and
 * delete. The client-scoped fetch (`reportKnowledge`) is mocked via apiClient.
 *
 * @see components/admin/questionnaires/report/client-knowledge-panel.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('@/lib/api/client', () => ({
  apiClient: { get: vi.fn(), delete: vi.fn().mockResolvedValue(undefined) },
  APIClientError: class extends Error {},
}));

import { apiClient } from '@/lib/api/client';
import { ClientKnowledgePanel } from '@/components/admin/questionnaires/report/client-knowledge-panel';

type Mock = ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ClientKnowledgePanel', () => {
  it('shows a loading state before the fetch settles', () => {
    (apiClient.get as unknown as Mock).mockReturnValue(new Promise(() => {})); // never resolves
    render(<ClientKnowledgePanel questionnaireId="qn-1" />);
    expect(screen.getByText(/Loading knowledge base/i)).toBeInTheDocument();
  });

  it('surfaces a load error', async () => {
    (apiClient.get as unknown as Mock).mockRejectedValue(new Error('boom'));
    render(<ClientKnowledgePanel questionnaireId="qn-1" />);
    expect(await screen.findByText(/Could not load the knowledge base/i)).toBeInTheDocument();
  });

  it('shows the unattributed notice when there is no client', async () => {
    (apiClient.get as unknown as Mock).mockResolvedValue({
      client: null,
      knowledgeTagId: null,
      documents: [],
    });

    render(<ClientKnowledgePanel questionnaireId="qn-1" />);
    expect(await screen.findByText(/No client attributed/i)).toBeInTheDocument();
  });

  it('lists the client documents', async () => {
    (apiClient.get as unknown as Mock).mockResolvedValue({
      client: { id: 'clt-1', name: 'Acme' },
      knowledgeTagId: 'tag-1',
      documents: [
        {
          id: 'doc-a',
          name: 'Playbook',
          fileName: 'p.md',
          status: 'ready',
          chunkCount: 4,
          sourceUrl: null,
          createdAt: '2026-06-01T00:00:00.000Z',
        },
      ],
    });

    render(<ClientKnowledgePanel questionnaireId="qn-1" />);
    expect(await screen.findByText('Playbook')).toBeInTheDocument();
    expect(screen.getByText(/Acme/)).toBeInTheDocument();
  });

  it('uploads with the client tag stamped and refreshes', async () => {
    (apiClient.get as unknown as Mock).mockResolvedValue({
      client: { id: 'clt-1', name: 'Acme' },
      knowledgeTagId: 'tag-1',
      documents: [],
    });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);

    render(<ClientKnowledgePanel questionnaireId="qn-1" />);
    await screen.findByText(/Private corpus/i);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['hello'], 'notes.md', { type: 'text/markdown' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0];
    const body = init.body as FormData;
    expect(body.get('file')).toBeTruthy();
    expect(body.getAll('tagIds')).toEqual(['tag-1']);

    vi.unstubAllGlobals();
  });

  it('surfaces an upload failure from the documents endpoint', async () => {
    (apiClient.get as unknown as Mock).mockResolvedValue({
      client: { id: 'clt-1', name: 'Acme' },
      knowledgeTagId: 'tag-1',
      documents: [],
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 413,
      json: async () => ({ error: { message: 'Too big' } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ClientKnowledgePanel questionnaireId="qn-1" />);
    await screen.findByText(/Private corpus/i);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'], 'a.md')] } });

    expect(await screen.findByText(/Too big/i)).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it('renders a zero-chunk document without a chunk count', async () => {
    (apiClient.get as unknown as Mock).mockResolvedValue({
      client: { id: 'clt-1', name: 'Acme' },
      knowledgeTagId: 'tag-1',
      documents: [
        {
          id: 'doc-x',
          name: 'Pending',
          fileName: 'p.pdf',
          status: 'processing',
          chunkCount: 0,
          sourceUrl: null,
          createdAt: '2026-06-01T00:00:00.000Z',
        },
      ],
    });
    render(<ClientKnowledgePanel questionnaireId="qn-1" />);
    expect(await screen.findByText('Pending')).toBeInTheDocument();
    expect(screen.getByText(/^processing$/)).toBeInTheDocument();
  });

  it('surfaces a delete failure', async () => {
    (apiClient.get as unknown as Mock).mockResolvedValue({
      client: { id: 'clt-1', name: 'Acme' },
      knowledgeTagId: 'tag-1',
      documents: [
        {
          id: 'doc-a',
          name: 'Playbook',
          fileName: 'p.md',
          status: 'ready',
          chunkCount: 4,
          sourceUrl: null,
          createdAt: '2026-06-01T00:00:00.000Z',
        },
      ],
    });
    (apiClient.delete as unknown as Mock).mockRejectedValue(new Error('nope'));
    render(<ClientKnowledgePanel questionnaireId="qn-1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Delete Playbook/i }));
    expect(await screen.findByText(/Could not delete the document/i)).toBeInTheDocument();
  });

  it('deletes a document via the platform endpoint', async () => {
    (apiClient.get as unknown as Mock).mockResolvedValue({
      client: { id: 'clt-1', name: 'Acme' },
      knowledgeTagId: 'tag-1',
      documents: [
        {
          id: 'doc-a',
          name: 'Playbook',
          fileName: 'p.md',
          status: 'ready',
          chunkCount: 4,
          sourceUrl: null,
          createdAt: '2026-06-01T00:00:00.000Z',
        },
      ],
    });

    render(<ClientKnowledgePanel questionnaireId="qn-1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Delete Playbook/i }));

    await waitFor(() =>
      expect(apiClient.delete as unknown as Mock).toHaveBeenCalledWith(
        '/api/v1/admin/orchestration/knowledge/documents/doc-a'
      )
    );
  });
});
