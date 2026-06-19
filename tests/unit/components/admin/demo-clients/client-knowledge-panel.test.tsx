/**
 * ClientKnowledgePanel — component tests (demo-client KB section).
 *
 * Covers the loading + unavailable states, listing the client's documents, the tag-stamped upload,
 * and delete. The client-scoped fetch (`DEMO_CLIENTS.knowledge`) is mocked via apiClient. The panel is
 * keyed on a `clientId` + `clientName` (the corpus is client-owned, managed on the client's page).
 *
 * @see components/admin/demo-clients/client-knowledge-panel.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('@/lib/api/client', () => ({
  apiClient: { get: vi.fn(), delete: vi.fn().mockResolvedValue(undefined) },
  APIClientError: class extends Error {},
}));

import { apiClient } from '@/lib/api/client';
import { ClientKnowledgePanel } from '@/components/admin/demo-clients/client-knowledge-panel';

type Mock = ReturnType<typeof vi.fn>;

function renderPanel() {
  return render(<ClientKnowledgePanel clientId="clt-1" clientName="Acme" />);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ClientKnowledgePanel', () => {
  it('fetches the client-scoped knowledge endpoint', async () => {
    (apiClient.get as unknown as Mock).mockResolvedValue({
      client: { id: 'clt-1', name: 'Acme' },
      knowledgeTagId: 'tag-1',
      documents: [],
    });
    renderPanel();
    await waitFor(() =>
      expect(apiClient.get as unknown as Mock).toHaveBeenCalledWith(
        '/api/v1/app/demo-clients/clt-1/knowledge'
      )
    );
  });

  it('shows a loading state before the fetch settles', () => {
    (apiClient.get as unknown as Mock).mockReturnValue(new Promise(() => {})); // never resolves
    renderPanel();
    expect(screen.getByText(/Loading knowledge base/i)).toBeInTheDocument();
  });

  it('surfaces a load error', async () => {
    (apiClient.get as unknown as Mock).mockRejectedValue(new Error('boom'));
    renderPanel();
    expect(await screen.findByText(/Could not load the knowledge base/i)).toBeInTheDocument();
  });

  it('shows an unavailable notice when the tag could not be resolved', async () => {
    (apiClient.get as unknown as Mock).mockResolvedValue({
      client: { id: 'clt-1', name: 'Acme' },
      knowledgeTagId: null,
      documents: [],
    });
    renderPanel();
    expect(await screen.findByText(/knowledge base is unavailable/i)).toBeInTheDocument();
  });

  it('lists the client documents under the client name', async () => {
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

    renderPanel();
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

    renderPanel();
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

    renderPanel();
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
    renderPanel();
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
    renderPanel();
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

    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /Delete Playbook/i }));

    await waitFor(() =>
      expect(apiClient.delete as unknown as Mock).toHaveBeenCalledWith(
        '/api/v1/admin/orchestration/knowledge/documents/doc-a'
      )
    );
  });
});
