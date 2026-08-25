/**
 * ReingestDialog component tests.
 *
 * Anti-green-bar: asserts the dialog accepts the spreadsheet extension and POSTs
 * a multipart FormData to the **streaming re-ingest** endpoint carrying the admin's
 * free-text extraction instructions (and goal), so the spreadsheet + steering
 * path works on re-ingest the same way it does on first ingest; and that it consumes
 * the SSE stream — rendering the REAL phase messages (including the rising
 * "N questions so far" count) and settling on the terminal `done` frame, deduped or
 * not. Scoped to the dialog; the broader replace-flow is exercised by the route's
 * integration test.
 *
 * @see components/admin/questionnaires/reingest-dialog.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('next/navigation', async () => {
  const { createMockRouter } = await import('@/tests/types/mocks');
  return {
    useRouter: () => createMockRouter(),
  };
});

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { ReingestDialog } from '@/components/admin/questionnaires/reingest-dialog';
import { API } from '@/lib/api/endpoints';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeFile(name = 'workbook.xlsx'): File {
  return new File(['bytes'], name, {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

function fileInput(): HTMLInputElement {
  const el = document.querySelector('input[type="file"]');
  if (!el) throw new Error('file input not found — is the dialog open?');
  return el as HTMLInputElement;
}

/** A one-shot `text/event-stream` body carrying the given SSE events, then closing. */
function sseBody(
  events: Array<Record<string, unknown> & { type: string }>
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const frames = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(frames));
      controller.close();
    },
  });
}

/**
 * The re-ingest endpoint streams SSE: real `phase` frames then a terminal `done` frame
 * carrying the version's counts (and the dedup flag). The dialog reads `res.body` — not
 * `res.json()` — so the mock must expose a real `ReadableStream`.
 */
function mockFetchSuccess(
  data: {
    sectionCount: number;
    questionCount: number;
    changeCount: number;
    deduped: boolean;
    /** F17.22 Phase 2 — present only when the analyst proposed during this upload. */
    conditionalTopicsProposal?: { topicCount: number; conditionalCount: number };
  } = {
    sectionCount: 2,
    questionCount: 5,
    changeCount: 1,
    deduped: false,
  },
  phases: Array<Record<string, unknown> & { type: string }> = [
    { type: 'phase', phase: 'extracting', message: 'Structure extractor — 7 questions so far' },
  ]
): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    body: sseBody([
      ...phases,
      { type: 'done', questionnaireId: 'qn-1', versionId: 'v-2', ...data },
    ]),
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** A terminal `error` frame mid-stream — HTTP 200, because the stream already opened. */
function mockFetchStreamError(message: string): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    body: sseBody([
      { type: 'phase', phase: 'extracting', message: 'Reading…' },
      { type: 'error', code: 'EXTRACTION_FAILED', message },
    ]),
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** A pre-stream JSON envelope (rate limit, non-draft 409, guard) — never a stream. */
function mockFetchJsonError(message: string, status = 409): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: async () => ({ success: false, error: { code: 'REINGEST_NOT_DRAFT', message } }),
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function mockFetchReject(): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
  vi.stubGlobal('fetch', fn);
  return fn;
}

function postedFormData(fetchMock: ReturnType<typeof vi.fn>): FormData {
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(init.body).toBeInstanceOf(FormData);
  return init.body as FormData;
}

async function openDialog() {
  const user = userEvent.setup();
  render(<ReingestDialog questionnaireId="qn-1" versionId="v-2" versionNumber={2} />);
  await user.click(screen.getByRole('button', { name: /re-ingest/i }));
  await screen.findByRole('button', { name: /replace structure/i });
  return user;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ReingestDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // clearAllMocks does NOT unstub globals — without this the fetch stub leaks
  // into the next test (e.g. the no-file test would inherit a 200-OK stub).
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('accepts the spreadsheet extension on the file input', async () => {
    await openDialog();
    expect(fileInput()).toHaveAttribute('accept', '.pdf,.docx,.md,.txt,.xlsx');
  });

  it('POSTs the extraction instructions to the re-ingest endpoint', async () => {
    const fetchMock = mockFetchSuccess();
    const user = await openDialog();

    await user.upload(fileInput(), makeFile());
    await user.type(
      screen.getByRole('textbox', { name: /extraction instructions/i }),
      "Questions are in the Activities tab. Replace 'HPE' with 'our org'."
    );
    await user.click(screen.getByRole('button', { name: /replace structure/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(API.APP.QUESTIONNAIRES.versionReingestStream('qn-1', 'v-2'));
    expect(postedFormData(fetchMock).get('instructions')).toBe(
      "Questions are in the Activities tab. Replace 'HPE' with 'our org'."
    );
  });

  it('omits instructions when the field is left blank', async () => {
    const fetchMock = mockFetchSuccess();
    const user = await openDialog();

    await user.upload(fileInput(), makeFile());
    await user.click(screen.getByRole('button', { name: /replace structure/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(postedFormData(fetchMock).has('instructions')).toBe(false);
  });

  it('renders the extracted counts on a successful (non-deduped) re-ingest', async () => {
    mockFetchSuccess({ sectionCount: 3, questionCount: 12, changeCount: 4, deduped: false });
    const user = await openDialog();

    await user.upload(fileInput(), makeFile());
    await user.click(screen.getByRole('button', { name: /replace structure/i }));

    // The result screen reports the new structure; the destructive submit is gone.
    expect(await screen.findByText(/re-ingested/i)).toBeInTheDocument();
    expect(screen.getByText(/3/)).toBeInTheDocument();
    expect(screen.getByText(/12/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /replace structure/i })).not.toBeInTheDocument();
  });

  it('reports what the analyst proposed during the upload (F17.22 Phase 2)', async () => {
    // This dialog is the only place the admin is still standing when the proposal finishes —
    // without this line, a draft that cost a real model call waits on a tab nothing mentioned.
    mockFetchSuccess({
      sectionCount: 3,
      questionCount: 12,
      changeCount: 4,
      deduped: false,
      conditionalTopicsProposal: { topicCount: 6, conditionalCount: 3 },
    });
    const user = await openDialog();

    await user.upload(fileInput(), makeFile());
    await user.click(screen.getByRole('button', { name: /replace structure/i }));

    const line = await screen.findByText(/document describes routing/i);
    expect(line).toHaveTextContent('6');
    expect(line).toHaveTextContent('3');
    // Says plainly that nothing is live — accepting stays an explicit act on the tab.
    expect(line).toHaveTextContent(/nothing is live/i);
  });

  it('says nothing about routing when no proposal was made', async () => {
    mockFetchSuccess({ sectionCount: 3, questionCount: 12, changeCount: 4, deduped: false });
    const user = await openDialog();

    await user.upload(fileInput(), makeFile());
    await user.click(screen.getByRole('button', { name: /replace structure/i }));

    await screen.findByText(/re-ingested/i);
    expect(screen.queryByText(/document describes routing/i)).not.toBeInTheDocument();
  });

  it('reports an unchanged re-ingest when the document is identical (deduped)', async () => {
    mockFetchSuccess({ sectionCount: 0, questionCount: 0, changeCount: 0, deduped: true });
    const user = await openDialog();

    await user.upload(fileInput(), makeFile());
    await user.click(screen.getByRole('button', { name: /replace structure/i }));

    expect(await screen.findByText(/nothing changed/i)).toBeInTheDocument();
  });

  it('renders the streamed phase message — the real question count, not a scripted ticker', async () => {
    // The stream stalls after one phase frame so the in-flight progress line stays mounted.
    const encoder = new TextEncoder();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `event: phase\ndata: ${JSON.stringify({
                  type: 'phase',
                  phase: 'extracting',
                  message: 'Structure extractor — reading the document… 9 questions so far',
                })}\n\n`
              )
            );
            // Deliberately left open — mirrors a long extraction still in flight.
          },
        }),
      })
    );
    const user = await openDialog();

    await user.upload(fileInput(), makeFile());
    await user.click(screen.getByRole('button', { name: /replace structure/i }));

    expect(await screen.findByText(/9 questions so far/i)).toBeInTheDocument();
  });

  it('surfaces a terminal stream error inline and keeps the form mounted for a retry', async () => {
    mockFetchStreamError('The extractor could not read that document.');
    const user = await openDialog();

    await user.upload(fileInput(), makeFile());
    await user.click(screen.getByRole('button', { name: /replace structure/i }));

    expect(
      await screen.findByText(/the extractor could not read that document/i)
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /replace structure/i })).toBeInTheDocument();
  });

  it('surfaces a pre-stream JSON error (non-draft version) inline', async () => {
    mockFetchJsonError('Only draft versions can be re-ingested');
    const user = await openDialog();

    await user.upload(fileInput(), makeFile());
    await user.click(screen.getByRole('button', { name: /replace structure/i }));

    expect(await screen.findByText(/only draft versions can be re-ingested/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /replace structure/i })).toBeInTheDocument();
  });

  it('surfaces a network failure inline without navigating away from the form', async () => {
    mockFetchReject();
    const user = await openDialog();

    await user.upload(fileInput(), makeFile());
    await user.click(screen.getByRole('button', { name: /replace structure/i }));

    expect(await screen.findByText(/re-ingest failed/i)).toBeInTheDocument();
    // The form is still mounted (no result screen) so the admin can retry.
    expect(screen.getByRole('button', { name: /replace structure/i })).toBeInTheDocument();
  });
});
