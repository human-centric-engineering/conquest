/**
 * UploadQuestionnaireDialog component tests.
 *
 * Anti-green-bar: asserts the dialog POSTs a multipart FormData to the ingest
 * endpoint with exactly the fields the admin filled (file + non-empty overrides),
 * omits untouched audience/enum keys rather than sending blanks, navigates to the
 * new questionnaire's detail page on success, and surfaces server / network errors
 * inline without navigating.
 *
 * @see components/admin/questionnaires/upload-questionnaire-dialog.tsx
 */

import type { ComponentProps } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockPush = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { UploadQuestionnaireDialog } from '@/components/admin/questionnaires/upload-questionnaire-dialog';
import { API } from '@/lib/api/endpoints';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeFile(name = 'survey.md', contents = '# A survey\nQ1?'): File {
  return new File([contents], name, { type: 'text/markdown' });
}

/** The file input uses a `useId()` id, so reach it by type rather than label. */
function fileInput(): HTMLInputElement {
  const el = document.querySelector('input[type="file"]');
  if (!el) throw new Error('file input not found — is the dialog open?');
  return el as HTMLInputElement;
}

function mockFetchSuccess(questionnaireId = 'qn-1'): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue({
    ok: true,
    status: 201,
    json: async () => ({
      success: true,
      data: {
        questionnaireId,
        versionId: 'v-1',
        sectionCount: 3,
        questionCount: 12,
        changeCount: 0,
      },
    }),
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function mockFetchError(message: string, status = 409): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: async () => ({ success: false, error: { code: 'CONFLICT', message } }),
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** Open the dialog and return a configured userEvent instance. */
async function openDialog(props: Partial<ComponentProps<typeof UploadQuestionnaireDialog>> = {}) {
  const user = userEvent.setup();
  render(<UploadQuestionnaireDialog {...props} />);
  await user.click(screen.getByRole('button', { name: /upload questionnaire/i }));
  // The submit button only exists once the dialog content is mounted.
  await screen.findByRole('button', { name: /upload & extract/i });
  return user;
}

const DEMO_CLIENT_OPTIONS = [
  { id: 'client-1', slug: 'acme-bank', name: 'Acme Bank' },
  { id: 'client-2', slug: 'globex', name: 'Globex' },
];

function postedFormData(fetchMock: ReturnType<typeof vi.fn>): FormData {
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(init.body).toBeInstanceOf(FormData);
  return init.body as FormData;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('UploadQuestionnaireDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens the dialog from the trigger and shows the file input with accepted types', async () => {
    await openDialog();
    expect(fileInput()).toHaveAttribute('accept', '.pdf,.docx,.md,.txt');
  });

  it('POSTs multipart FormData to the ingest endpoint and navigates to the new detail page', async () => {
    const fetchMock = mockFetchSuccess('qn-77');
    const user = await openDialog();

    await user.upload(fileInput(), makeFile());
    await user.type(
      screen.getByPlaceholderText('Leave blank to use the inferred goal'),
      'Measure onboarding satisfaction'
    );
    await user.click(screen.getByRole('button', { name: /upload & extract/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        API.APP.QUESTIONNAIRES.ROOT,
        expect.objectContaining({ method: 'POST', credentials: 'same-origin' })
      );
    });

    const fd = postedFormData(fetchMock);
    expect(fd.get('file')).toBeInstanceOf(File);
    expect(fd.get('goal')).toBe('Measure onboarding satisfaction');

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/admin/questionnaires/qn-77');
    });
  });

  it('omits untouched audience / enum / table keys rather than sending blanks', async () => {
    const fetchMock = mockFetchSuccess();
    const user = await openDialog();

    await user.upload(fileInput(), makeFile());
    await user.click(screen.getByRole('button', { name: /upload & extract/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const fd = postedFormData(fetchMock);
    expect(fd.has('title')).toBe(false);
    expect(fd.has('demoClientId')).toBe(false);
    expect(fd.has('goal')).toBe(false);
    expect(fd.has('audience.description')).toBe(false);
    // Enum selects left at "Infer" must be omitted entirely (server rejects unknowns).
    expect(fd.has('audience.expertiseLevel')).toBe(false);
    expect(fd.has('audience.sensitivity')).toBe(false);
    expect(fd.has('extractTables')).toBe(false);
  });

  it('sends the admin-supplied name as the title field', async () => {
    const fetchMock = mockFetchSuccess();
    const user = await openDialog();

    await user.upload(fileInput(), makeFile());
    await user.type(
      screen.getByPlaceholderText('Leave blank to use the document title'),
      'Acme onboarding survey'
    );
    await user.click(screen.getByRole('button', { name: /upload & extract/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(postedFormData(fetchMock).get('title')).toBe('Acme onboarding survey');
  });

  it('hides the demo-client picker when no options are supplied', async () => {
    await openDialog();
    expect(screen.queryByRole('combobox', { name: /demo client/i })).not.toBeInTheDocument();
  });

  it('attributes the chosen demo client and sends its id as demoClientId', async () => {
    const fetchMock = mockFetchSuccess();
    const user = await openDialog({ demoClientOptions: DEMO_CLIENT_OPTIONS });

    await user.upload(fileInput(), makeFile());
    await user.click(screen.getByRole('combobox', { name: /demo client/i }));
    await user.click(await screen.findByRole('option', { name: /acme bank/i }));
    await user.click(screen.getByRole('button', { name: /upload & extract/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(postedFormData(fetchMock).get('demoClientId')).toBe('client-1');
  });

  it('omits demoClientId when the picker is left on "None"', async () => {
    const fetchMock = mockFetchSuccess();
    const user = await openDialog({ demoClientOptions: DEMO_CLIENT_OPTIONS });

    await user.upload(fileInput(), makeFile());
    await user.click(screen.getByRole('button', { name: /upload & extract/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(postedFormData(fetchMock).has('demoClientId')).toBe(false);
  });

  it("defaults requiredMode to 'all' (the checked radio) on submit", async () => {
    const fetchMock = mockFetchSuccess();
    const user = await openDialog();

    await user.upload(fileInput(), makeFile());
    // The default radio is checked without any interaction.
    expect(screen.getByRole('radio', { name: /make all fields required/i })).toBeChecked();
    await user.click(screen.getByRole('button', { name: /upload & extract/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(postedFormData(fetchMock).get('requiredMode')).toBe('all');
  });

  it('sends requiredMode=source when the document-markers radio is selected', async () => {
    const fetchMock = mockFetchSuccess();
    const user = await openDialog();

    await user.upload(fileInput(), makeFile());
    await user.click(screen.getByRole('radio', { name: /use the document.s required markers/i }));
    await user.click(screen.getByRole('button', { name: /upload & extract/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(postedFormData(fetchMock).get('requiredMode')).toBe('source');
  });

  it('sends extractTables=true when the toggle is checked', async () => {
    const fetchMock = mockFetchSuccess();
    const user = await openDialog();

    await user.upload(fileInput(), makeFile());
    await user.click(screen.getByRole('checkbox', { name: /extract tables from pdf/i }));
    await user.click(screen.getByRole('button', { name: /upload & extract/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(postedFormData(fetchMock).get('extractTables')).toBe('true');
  });

  it('shows the server error message inline and does not navigate', async () => {
    mockFetchError('The document could not be parsed.', 422);
    const user = await openDialog();

    await user.upload(fileInput(), makeFile());
    await user.click(screen.getByRole('button', { name: /upload & extract/i }));

    await waitFor(() => {
      expect(screen.getByText(/could not be parsed/i)).toBeInTheDocument();
    });
    expect(mockPush).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard
    // The form must re-enable so the admin can fix the input and retry.
    expect(screen.getByRole('button', { name: /upload & extract/i })).toBeEnabled();
  });

  it('shows the animated status ticker while extraction is in flight and removes it on error', async () => {
    // A fetch that never settles keeps the dialog in its busy state.
    let rejectFetch: (reason: Error) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn().mockReturnValue(new Promise((_, reject) => (rejectFetch = reject)))
    );
    const user = await openDialog();

    await user.upload(fileInput(), makeFile());
    await user.click(screen.getByRole('button', { name: /upload & extract/i }));

    expect(await screen.findByRole('status')).toBeInTheDocument();

    rejectFetch(new Error('Network down'));
    await waitFor(() => {
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });
    expect(screen.getByText(/upload failed/i)).toBeInTheDocument();
  });

  it('shows a generic message when fetch itself rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network down')));
    const user = await openDialog();

    await user.upload(fileInput(), makeFile());
    await user.click(screen.getByRole('button', { name: /upload & extract/i }));

    await waitFor(() => {
      expect(screen.getByText(/upload failed\. please try again\./i)).toBeInTheDocument();
    });
    expect(mockPush).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard
  });

  it('sends every supplied override (goal, audience text fields, enum selects, tables)', async () => {
    const fetchMock = mockFetchSuccess();
    const user = await openDialog();

    await user.upload(fileInput(), makeFile());
    await user.type(
      screen.getByPlaceholderText('Leave blank to use the inferred goal'),
      'Assess readiness'
    );
    await user.type(screen.getByRole('textbox', { name: /description/i }), 'New hires');
    await user.type(screen.getByRole('textbox', { name: /role/i }), 'employee');
    await user.type(screen.getByRole('textbox', { name: /locale/i }), 'en-GB');
    await user.type(screen.getByRole('spinbutton', { name: /duration/i }), '15');
    await user.type(screen.getByRole('textbox', { name: /notes/i }), 'keep it short');

    // Address each Radix Select by its label, not DOM order, so adding a third
    // select or reordering the form can't silently drive the wrong control.
    await user.click(screen.getByRole('combobox', { name: /expertise level/i }));
    await user.click(await screen.findByRole('option', { name: /intermediate/i }));
    await user.click(screen.getByRole('combobox', { name: /sensitivity/i }));
    await user.click(await screen.findByRole('option', { name: /moderate/i }));

    await user.click(screen.getByRole('checkbox', { name: /extract tables from pdf/i }));
    await user.click(screen.getByRole('button', { name: /upload & extract/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const fd = postedFormData(fetchMock);
    expect(fd.get('goal')).toBe('Assess readiness');
    expect(fd.get('audience.description')).toBe('New hires');
    expect(fd.get('audience.role')).toBe('employee');
    expect(fd.get('audience.locale')).toBe('en-GB');
    expect(fd.get('audience.estimatedDurationMinutes')).toBe('15');
    expect(fd.get('audience.notes')).toBe('keep it short');
    expect(fd.get('audience.expertiseLevel')).toBe('intermediate');
    expect(fd.get('audience.sensitivity')).toBe('moderate');
    expect(fd.get('extractTables')).toBe('true');
  });

  it('clears the form when the dialog is closed and reopened', async () => {
    const user = await openDialog();

    const goal = screen.getByPlaceholderText('Leave blank to use the inferred goal');
    await user.type(goal, 'temporary');
    expect(goal).toHaveValue('temporary');

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /upload & extract/i })).not.toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /upload questionnaire/i }));
    await screen.findByRole('button', { name: /upload & extract/i });
    expect(screen.getByPlaceholderText('Leave blank to use the inferred goal')).toHaveValue('');
  });
});
