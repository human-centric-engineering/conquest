// @vitest-environment happy-dom

/**
 * Unit tests: `SupportingDocumentsCard` — the companions the Routing Analyst reads (F17.29).
 *
 * What carries weight here:
 *
 *   1. **The instrument is named, and it is the NEWEST primary.** A re-ingest appends rather than
 *      replacing, so a version can hold a superseded upload; naming that one would tell an admin
 *      the analyst reads a questionnaire that is no longer this one.
 *   2. **A supporting document can be removed; the instrument cannot.** The remove control exists
 *      only on the companions — the primary row is the provenance record for questions that
 *      already exist.
 *   3. **The cap is visible before it is hit.** An admin who cannot attach needs the reason on
 *      screen, not a 409 after choosing a file.
 *
 * @see components/admin/questionnaires/topics/supporting-documents-card.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const routerMock = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => routerMock }));

import { SupportingDocumentsCard } from '@/components/admin/questionnaires/topics/supporting-documents-card';
import { API } from '@/lib/api/endpoints';
import { MAX_SUPPLEMENTARY_DOCUMENTS } from '@/lib/app/questionnaire/constants';
import type { SourceDocumentView } from '@/lib/app/questionnaire/ingestion/source-documents';

const QN_ID = 'qn-1';
const VID = 'ver-1';

function doc(over: Partial<SourceDocumentView> = {}): SourceDocumentView {
  return {
    id: 'doc-1',
    role: 'primary',
    fileName: 'bank.md',
    byteSize: 2048,
    mimeType: 'text/markdown',
    pageCount: null,
    characterCount: 1200,
    createdAt: '2026-02-01T00:00:00.000Z',
    ...over,
  };
}

function okResponse(documents: SourceDocumentView[]) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ success: true, data: { documents }, meta: { forked: false } }),
  } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => okResponse([]))
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderCard(documents: SourceDocumentView[]) {
  return render(
    <SupportingDocumentsCard questionnaireId={QN_ID} versionId={VID} documents={documents} />
  );
}

describe('SupportingDocumentsCard', () => {
  it('names the newest instrument, not a superseded upload', async () => {
    // Rows arrive newest-first. The second primary is the re-ingested original.
    renderCard([
      doc({ id: 'doc-new', fileName: 'v2.docx' }),
      doc({ id: 'doc-old', fileName: 'v1.docx' }),
    ]);

    expect(screen.getByText('v2.docx')).toBeInTheDocument();
    expect(screen.queryByText('v1.docx')).not.toBeInTheDocument();
    expect(screen.getByText(/the questionnaire itself/)).toBeInTheDocument();
  });

  it('says plainly when the version was never built from a document', () => {
    renderCard([]);
    expect(screen.getByText(/not built from an uploaded document/)).toBeInTheDocument();
  });

  it('offers a remove control on a companion and none on the instrument', () => {
    renderCard([doc(), doc({ id: 'doc-2', role: 'supplementary', fileName: 'memo.md' })]);

    expect(screen.getByRole('button', { name: 'Remove memo.md' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove bank.md' })).not.toBeInTheDocument();
  });

  it('posts the chosen file as multipart to the documents endpoint', async () => {
    const user = userEvent.setup();
    const { container } = renderCard([doc()]);

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File(['routing rules'], 'memo.md', { type: 'text/markdown' }));

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(API.APP.QUESTIONNAIRES.versionDocuments(QN_ID, VID));
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
    // The browser must set Content-Type itself, or the multipart boundary is missing.
    expect(init.headers['Content-Type']).toBeUndefined();
  });

  it('tells the admin the attach only takes effect on the next run', async () => {
    // The analyst does not re-run on attach — an admin who assumes it did would read a stale
    // proposal as the answer to the document they just added.
    const user = userEvent.setup();
    const { container } = renderCard([doc()]);

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File(['rules'], 'memo.md', { type: 'text/markdown' }));

    expect(await screen.findByText(/Run the AI proposal again to use it/)).toBeInTheDocument();
  });

  it('deletes through the per-document endpoint', async () => {
    const user = userEvent.setup();
    renderCard([doc({ id: 'doc-2', role: 'supplementary', fileName: 'memo.md' })]);

    await user.click(screen.getByRole('button', { name: 'Remove memo.md' }));

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(API.APP.QUESTIONNAIRES.versionDocument(QN_ID, VID, 'doc-2'));
    expect(init.method).toBe('DELETE');
  });

  it('follows a fork to the new draft rather than refreshing the old version', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        success: true,
        data: { documents: [] },
        meta: { forked: true, versionId: 'ver-2', versionNumber: 3 },
      }),
    });
    const user = userEvent.setup();
    const { container } = renderCard([doc()]);

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File(['rules'], 'memo.md', { type: 'text/markdown' }));

    await waitFor(() =>
      expect(routerMock.push).toHaveBeenCalledWith(
        expect.stringContaining(`/admin/questionnaires/${QN_ID}/v/ver-2/topics`)
      )
    );
    expect(routerMock.refresh).not.toHaveBeenCalled();
  });

  it('disables the attach control at the cap, and says why', () => {
    const full = Array.from({ length: MAX_SUPPLEMENTARY_DOCUMENTS }, (_, i) =>
      doc({ id: `doc-${i}`, role: 'supplementary', fileName: `memo-${i}.md` })
    );
    renderCard([doc(), ...full]);

    expect(screen.getByRole('button', { name: /Attach a supporting document/ })).toBeDisabled();
    expect(
      screen.getByText(new RegExp(`limit of ${MAX_SUPPLEMENTARY_DOCUMENTS}`))
    ).toBeInTheDocument();
  });

  it('surfaces the server’s own message when an attach is refused', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        success: false,
        error: { code: 'DUPLICATE_DOCUMENT', message: 'That file is already attached' },
      }),
    });
    const user = userEvent.setup();
    const { container } = renderCard([doc()]);

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File(['rules'], 'memo.md', { type: 'text/markdown' }));

    expect(await screen.findByText('That file is already attached')).toBeInTheDocument();
  });
});
