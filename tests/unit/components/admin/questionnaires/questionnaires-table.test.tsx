/**
 * QuestionnairesTable empty-state tests.
 *
 * Scope: the F-gap upload affordance. Asserts that with no questionnaires the
 * table renders the friendly empty-state copy plus the `UploadQuestionnaireDialog`
 * CTA (not the old "POST the API by hand" message), and that with rows present the
 * empty-state CTA is gone. The table hydrates from `initialItems`, so these render
 * without any network fetch.
 *
 * @see components/admin/questionnaires/questionnaires-table.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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

// The row-actions menu's Duplicate item drives the shared duplicate hook. Mock it so
// state (isDuplicating / error) and the duplicate() call are controllable per test —
// every test in this file renders the table, so a default is reset in beforeEach.
const mockDuplicate = vi.fn();
const mockUseDuplicate = vi.fn();
vi.mock('@/components/admin/questionnaires/use-duplicate-questionnaire', () => ({
  useDuplicateQuestionnaire: () => mockUseDuplicate(),
}));

// The Archive / Restore row actions drive the shared archive hook — mock it so the
// archive()/restore() calls and the pending/error state are controllable per test.
const mockArchive = vi.fn();
const mockRestore = vi.fn();
const mockUseArchive = vi.fn();
vi.mock('@/components/admin/questionnaires/use-archive-questionnaire', () => ({
  useArchiveQuestionnaire: () => mockUseArchive(),
}));

// parseApiResponse is what fetchPage feeds the fetch Response through on a view
// switch / page change. Controlling it lets the Archived-view test populate rows
// without a real network round-trip.
const mockParseApiResponse = vi.fn();
vi.mock('@/lib/api/parse-response', () => ({
  parseApiResponse: (...args: unknown[]) => mockParseApiResponse(...args),
}));

beforeEach(() => {
  // Clear accumulated call history on every mock (incl. mockUseDuplicate itself), then
  // re-arm the default state — otherwise the hook factory's call log persists across tests.
  vi.clearAllMocks();
  mockUseDuplicate.mockReturnValue({
    duplicate: mockDuplicate,
    isDuplicating: false,
    error: null,
    clearError: vi.fn(),
  });
  mockArchive.mockResolvedValue(true);
  mockRestore.mockResolvedValue(true);
  mockUseArchive.mockReturnValue({
    archive: mockArchive,
    restore: mockRestore,
    isPending: false,
    error: null,
    clearError: vi.fn(),
  });
  // Default fetch → a successful empty page; individual tests override parseApiResponse.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true }) as unknown as Response)
  );
  mockParseApiResponse.mockResolvedValue({
    success: true,
    data: [],
    meta: { page: 1, limit: 25, total: 0, totalPages: 1 },
  });
});

import { QuestionnairesTable } from '@/components/admin/questionnaires/questionnaires-table';
import type { QuestionnaireListItem } from '@/lib/app/questionnaire/views';
import type { PaginationMeta } from '@/types/api';

const META: PaginationMeta = { page: 1, limit: 25, total: 0, totalPages: 1 };

function item(over: Partial<QuestionnaireListItem> = {}): QuestionnaireListItem {
  // No `as` cast — let TypeScript enforce the real QuestionnaireListItem shape so
  // the fixture can't drift from the fields the component actually reads (notably
  // `updatedAt`, which the row renders via formatDate).
  return {
    id: 'qn-1',
    title: 'Onboarding survey',
    status: 'draft',
    versionCount: 1,
    latestVersion: { id: 'v-1', versionNumber: 1, status: 'draft' },
    sectionCount: 2,
    questionCount: 9,
    dataSlotCount: 0,
    demoClient: null,
    archivedAt: null,
    createdAt: '2026-06-05T00:00:00.000Z',
    updatedAt: '2026-06-05T00:00:00.000Z',
    ...over,
  };
}

describe('QuestionnairesTable empty state', () => {
  it('shows the upload CTA and friendly copy when there are no questionnaires', () => {
    render(<QuestionnairesTable initialItems={[]} initialMeta={META} />);

    expect(screen.getByText(/no questionnaires yet/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /upload questionnaire/i })).toBeInTheDocument();
    // The old "call the API by hand" guidance must be gone.
    expect(screen.queryByText(/POST \/api\/v1\/app\/questionnaires/i)).not.toBeInTheDocument();
  });

  it('renders rows and no empty-state CTA when questionnaires exist', () => {
    render(<QuestionnairesTable initialItems={[item()]} initialMeta={{ ...META, total: 1 }} />);

    expect(screen.getByText('Onboarding survey')).toBeInTheDocument();
    // Each enriched column actually renders, so a dropped/corrupted field fails here.
    expect(screen.getByText('Draft')).toBeInTheDocument(); // status badge label
    expect(screen.getByText('v1')).toBeInTheDocument(); // latest version number
    expect(screen.getByText('2')).toBeInTheDocument(); // section count
    expect(screen.getByText('9')).toBeInTheDocument(); // question count
    // Locks the formatDate(updatedAt) regression: a missing/renamed date field
    // would render "Invalid Date" here (locale/TZ-independent check).
    expect(screen.queryByText(/invalid date/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/no questionnaires yet/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /upload questionnaire/i })).not.toBeInTheDocument();
  });
});

describe('QuestionnairesTable demo-client column', () => {
  it('renders the attributed demo client name in its own row', () => {
    render(
      <QuestionnairesTable
        initialItems={[
          item({ demoClient: { id: 'client-1', slug: 'acme-bank', name: 'Acme Bank' } }),
        ]}
        initialMeta={{ ...META, total: 1 }}
      />
    );

    expect(screen.getByRole('columnheader', { name: /demo client/i })).toBeInTheDocument();
    expect(screen.getByText('Acme Bank')).toBeInTheDocument();
  });

  it('shows an em-dash when a questionnaire has no demo client', () => {
    render(
      <QuestionnairesTable
        initialItems={[item({ demoClient: null })]}
        initialMeta={{ ...META, total: 1 }}
      />
    );

    // The owner cell falls back to a muted em-dash rather than rendering blank.
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});

describe('QuestionnairesTable row actions (Duplicate)', () => {
  it('renders a per-row actions trigger labelled with the questionnaire title', () => {
    render(
      <QuestionnairesTable
        initialItems={[item({ title: 'Onboarding survey' })]}
        initialMeta={{ ...META, total: 1 }}
      />
    );

    expect(
      screen.getByRole('button', { name: /actions for onboarding survey/i })
    ).toBeInTheDocument();
  });

  it('calls duplicate() with the row id when the Duplicate item is selected', async () => {
    const user = userEvent.setup();
    render(
      <QuestionnairesTable
        initialItems={[item({ id: 'qn-42', title: 'Onboarding survey' })]}
        initialMeta={{ ...META, total: 1 }}
      />
    );

    await user.click(screen.getByRole('button', { name: /actions for onboarding survey/i }));
    const duplicateItem = await screen.findByRole('menuitem', { name: /duplicate/i });
    await user.click(duplicateItem);

    expect(mockDuplicate).toHaveBeenCalledExactlyOnceWith('qn-42');
  });

  it('disables every row-actions trigger while a duplicate is in flight', () => {
    mockUseDuplicate.mockReturnValue({
      duplicate: mockDuplicate,
      isDuplicating: true,
      error: null,
      clearError: vi.fn(),
    });
    render(
      <QuestionnairesTable
        initialItems={[item({ title: 'Onboarding survey' })]}
        initialMeta={{ ...META, total: 1 }}
      />
    );

    expect(screen.getByRole('button', { name: /actions for onboarding survey/i })).toBeDisabled();
  });

  it('surfaces a duplicate error from the hook', () => {
    mockUseDuplicate.mockReturnValue({
      duplicate: mockDuplicate,
      isDuplicating: false,
      error: 'Could not duplicate the questionnaire.',
      clearError: vi.fn(),
    });
    render(<QuestionnairesTable initialItems={[item()]} initialMeta={{ ...META, total: 1 }} />);

    expect(screen.getByText(/could not duplicate the questionnaire/i)).toBeInTheDocument();
  });
});

describe('QuestionnairesTable archive / restore', () => {
  it('archiving asks for confirmation before calling archive()', async () => {
    const user = userEvent.setup();
    render(
      <QuestionnairesTable
        initialItems={[item({ id: 'qn-42', title: 'Onboarding survey' })]}
        initialMeta={{ ...META, total: 1 }}
      />
    );

    await user.click(screen.getByRole('button', { name: /actions for onboarding survey/i }));
    await user.click(await screen.findByRole('menuitem', { name: /delete/i }));

    // A confirm dialog appears — archive() is NOT called yet.
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText(/delete this questionnaire\?/i)).toBeInTheDocument();
    expect(mockArchive).not.toHaveBeenCalled();
  });

  it('calls archive() with the row id after the confirmation is accepted', async () => {
    const user = userEvent.setup();
    render(
      <QuestionnairesTable
        initialItems={[item({ id: 'qn-42', title: 'Onboarding survey' })]}
        initialMeta={{ ...META, total: 1 }}
      />
    );

    await user.click(screen.getByRole('button', { name: /actions for onboarding survey/i }));
    await user.click(await screen.findByRole('menuitem', { name: /delete/i }));
    // The dialog's confirm button (not the menu item) commits the archive.
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /^delete$/i }));

    expect(mockArchive).toHaveBeenCalledExactlyOnceWith('qn-42');
  });

  it('shows Active / Deleted view toggles with Active pressed by default', () => {
    render(<QuestionnairesTable initialItems={[item()]} initialMeta={{ ...META, total: 1 }} />);

    expect(screen.getByRole('button', { name: 'Active' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Deleted' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
  });

  it('switching to the Deleted view fetches the deleted slice and offers Restore, not Delete', async () => {
    const user = userEvent.setup();
    // When the Archived toggle fires its fetch, return one archived row.
    mockParseApiResponse.mockResolvedValue({
      success: true,
      data: [
        item({
          id: 'qn-arch',
          title: 'Old survey',
          archivedAt: '2026-06-01T00:00:00.000Z',
        }),
      ],
      meta: { page: 1, limit: 25, total: 1, totalPages: 1 },
    });

    render(<QuestionnairesTable initialItems={[]} initialMeta={META} />);
    await user.click(screen.getByRole('button', { name: 'Deleted' }));

    // The archived row surfaces, and its only action is Restore.
    const trigger = await screen.findByRole('button', { name: /actions for old survey/i });
    await user.click(trigger);
    expect(await screen.findByRole('menuitem', { name: /restore/i })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /delete/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /duplicate/i })).not.toBeInTheDocument();

    // The fetch carried the archived=true slice selector (first arg is the URL string).
    const lastCallArg = vi.mocked(fetch).mock.calls.at(-1)?.[0];
    const fetchUrl = typeof lastCallArg === 'string' ? lastCallArg : '';
    expect(fetchUrl).toContain('archived=true');
  });

  it('restores an archived row via the Restore action', async () => {
    const user = userEvent.setup();
    mockParseApiResponse.mockResolvedValue({
      success: true,
      data: [item({ id: 'qn-arch', title: 'Old survey', archivedAt: '2026-06-01T00:00:00.000Z' })],
      meta: { page: 1, limit: 25, total: 1, totalPages: 1 },
    });

    render(<QuestionnairesTable initialItems={[]} initialMeta={META} />);
    await user.click(screen.getByRole('button', { name: 'Deleted' }));
    await user.click(await screen.findByRole('button', { name: /actions for old survey/i }));
    await user.click(await screen.findByRole('menuitem', { name: /restore/i }));

    expect(mockRestore).toHaveBeenCalledExactlyOnceWith('qn-arch');
  });

  it('surfaces a delete error from the hook', () => {
    mockUseArchive.mockReturnValue({
      archive: mockArchive,
      restore: mockRestore,
      isPending: false,
      error: 'Could not delete the questionnaire.',
      clearError: vi.fn(),
    });
    render(<QuestionnairesTable initialItems={[item()]} initialMeta={{ ...META, total: 1 }} />);

    expect(screen.getByText(/could not delete the questionnaire/i)).toBeInTheDocument();
  });

  it('cancelling the confirm dialog closes it without calling archive()', async () => {
    const user = userEvent.setup();
    render(
      <QuestionnairesTable
        initialItems={[item({ id: 'qn-42', title: 'Onboarding survey' })]}
        initialMeta={{ ...META, total: 1 }}
      />
    );

    await user.click(screen.getByRole('button', { name: /actions for onboarding survey/i }));
    await user.click(await screen.findByRole('menuitem', { name: /delete/i }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /cancel/i }));

    expect(mockArchive).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('does not refresh the list when archive() reports failure', async () => {
    const user = userEvent.setup();
    mockArchive.mockResolvedValue(false); // hook already surfaced the error; no refetch
    render(
      <QuestionnairesTable
        initialItems={[item({ id: 'qn-42', title: 'Onboarding survey' })]}
        initialMeta={{ ...META, total: 1 }}
      />
    );

    await user.click(screen.getByRole('button', { name: /actions for onboarding survey/i }));
    await user.click(await screen.findByRole('menuitem', { name: /delete/i }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /^delete$/i }));

    expect(mockArchive).toHaveBeenCalledExactlyOnceWith('qn-42');
    // refreshAfterMutation() drives the only post-hydration fetch — a failed archive skips it.
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

describe('QuestionnairesTable filters, paging, and columns', () => {
  it('filters by status — issues a fetch carrying the status param', async () => {
    const user = userEvent.setup();
    render(<QuestionnairesTable initialItems={[item()]} initialMeta={{ ...META, total: 1 }} />);

    await user.click(screen.getByRole('combobox', { name: /filter by status/i }));
    await user.click(await screen.findByRole('option', { name: /launched/i }));

    const url = vi.mocked(fetch).mock.calls.at(-1)?.[0];
    expect(typeof url === 'string' ? url : '').toContain('status=launched');
  });

  it('paging Next requests the next page', async () => {
    const user = userEvent.setup();
    render(
      <QuestionnairesTable
        initialItems={[item()]}
        initialMeta={{ page: 1, limit: 25, total: 30, totalPages: 2 }}
      />
    );

    await user.click(screen.getByRole('button', { name: /next page/i }));

    const url = vi.mocked(fetch).mock.calls.at(-1)?.[0];
    expect(typeof url === 'string' ? url : '').toContain('page=2');
  });

  it('surfaces a load error when a fetch fails', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false }) as unknown as Response)
    );
    render(
      <QuestionnairesTable
        initialItems={[item()]}
        initialMeta={{ page: 1, limit: 25, total: 30, totalPages: 2 }}
      />
    );

    await user.click(screen.getByRole('button', { name: /next page/i }));

    expect(await screen.findByText(/could not load questionnaires/i)).toBeInTheDocument();
  });

  it('debounced search eventually issues a fetch with the q param', async () => {
    const user = userEvent.setup();
    render(<QuestionnairesTable initialItems={[item()]} initialMeta={{ ...META, total: 1 }} />);

    await user.type(screen.getByLabelText(/search questionnaires by title/i), 'onboarding');

    // The 300ms debounce fires the fetch on the trailing edge — waitFor polls past it.
    await waitFor(() => {
      const url = vi.mocked(fetch).mock.calls.at(-1)?.[0];
      expect(typeof url === 'string' ? url : '').toContain('q=onboarding');
    });
  });

  it('renders the Data slots column when enabled', () => {
    render(
      <QuestionnairesTable
        initialItems={[item({ dataSlotCount: 7 })]}
        initialMeta={{ ...META, total: 1 }}
        showDataSlots
      />
    );

    expect(screen.getByRole('columnheader', { name: /data slots/i })).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
  });
});
