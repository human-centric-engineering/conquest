/**
 * ReingestDialog component tests.
 *
 * Anti-green-bar: asserts the dialog accepts the spreadsheet extension and POSTs
 * a multipart FormData to the **re-ingest** endpoint carrying the admin's
 * free-text extraction instructions (and goal), so the spreadsheet + steering
 * path works on re-ingest the same way it does on first ingest. Scoped to the
 * fields this branch added; the broader replace-flow is exercised by the route's
 * integration test.
 *
 * @see components/admin/questionnaires/reingest-dialog.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

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

function mockFetchSuccess(
  data: { sectionCount: number; questionCount: number; changeCount: number; deduped: boolean } = {
    sectionCount: 2,
    questionCount: 5,
    changeCount: 1,
    deduped: false,
  }
): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ success: true, data }),
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
    expect(url).toBe(API.APP.QUESTIONNAIRES.versionReingest('qn-1', 'v-2'));
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

  it('reports an unchanged re-ingest when the document is identical (deduped)', async () => {
    mockFetchSuccess({ sectionCount: 0, questionCount: 0, changeCount: 0, deduped: true });
    const user = await openDialog();

    await user.upload(fileInput(), makeFile());
    await user.click(screen.getByRole('button', { name: /replace structure/i }));

    expect(await screen.findByText(/nothing changed/i)).toBeInTheDocument();
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
