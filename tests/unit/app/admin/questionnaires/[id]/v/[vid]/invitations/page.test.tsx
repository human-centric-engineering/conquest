/**
 * Invitations tab page (`/admin/questionnaires/[id]/v/[vid]/invitations`) tests.
 *
 * The page is an async Server Component that:
 *  - calls getQuestionnaireDetailCached(id) and notFound() when it returns null
 *  - finds the newest launched version for cost estimation
 *  - fetches invitations via serverFetch (capped at 100)
 *  - degrades gracefully ({ invitations: [], total: 0 }) when the fetch fails
 *  - renders CostEstimateCard only when a launched version exists
 *  - renders InviteForm with hasLaunchedVersion derived from the version list
 *  - renders InvitationsTable with the fetched invitations
 *  - renders a truncation note when total > invitations.length
 *
 * vid is read from params but intentionally not used (the invitations endpoint
 * is questionnaire-scoped, not version-scoped). Tests verify that behaviour.
 *
 * Heavy children (InviteForm, InvitationsTable, CostEstimateCard) are stubbed
 * to identifiable markers exposing their props as data-attributes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import type {
  QuestionnaireDetail,
  QuestionnaireVersionSummary,
} from '@/lib/app/questionnaire/views';
import type { InvitationView } from '@/lib/app/questionnaire/invitations';

// ─── Navigation mock ──────────────────────────────────────────────────────────

const { mockNotFound } = vi.hoisted(() => ({
  mockNotFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('next/navigation', () => ({
  notFound: mockNotFound,
  redirect: vi.fn(),
}));

// ─── workspace-data mock (for getQuestionnaireDetailCached + getVersionGraphCached) ───

const workspaceDataMock = vi.hoisted(() => ({
  getQuestionnaireDetailCached: vi.fn<() => Promise<QuestionnaireDetail | null>>(),
  getVersionGraphCached: vi.fn<() => Promise<null>>(),
}));
vi.mock('@/lib/app/questionnaire/workspace-data', () => workspaceDataMock);

// ─── server-fetch mock ────────────────────────────────────────────────────────

const apiMock = vi.hoisted(() => ({
  serverFetch: vi.fn(),
  parseApiResponse: vi.fn(),
}));
vi.mock('@/lib/api/server-fetch', () => apiMock);

// ─── logger mock ──────────────────────────────────────────────────────────────

const loggerMock = vi.hoisted(() => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/logging', () => loggerMock);

// ─── Stub heavy children ──────────────────────────────────────────────────────

vi.mock('@/components/admin/questionnaires/invite-import-wizard', () => ({
  InviteImportWizard: (props: { questionnaireId: string; disabled: boolean }) => (
    <div
      data-testid="invite-wizard"
      data-qid={props.questionnaireId}
      data-disabled={String(props.disabled)}
    />
  ),
}));

vi.mock('@/components/admin/questionnaires/invitations-table', () => ({
  InvitationsTable: (props: { questionnaireId: string; invitations: InvitationView[] }) => (
    <div
      data-testid="invitations-table"
      data-qid={props.questionnaireId}
      data-count={String(props.invitations.length)}
    />
  ),
}));

vi.mock('@/components/admin/questionnaires/cost-estimate-card', () => ({
  CostEstimateCard: (props: { questionnaireId: string; versionId: string; variant: string }) => (
    <div
      data-testid="cost-estimate-card"
      data-qid={props.questionnaireId}
      data-vid={props.versionId}
      data-variant={props.variant}
    />
  ),
}));

// ─── Factories ────────────────────────────────────────────────────────────────

function makeVersion(over: Partial<QuestionnaireVersionSummary> = {}): QuestionnaireVersionSummary {
  return {
    id: 'ver-1',
    versionNumber: 1,
    status: 'launched',
    goal: 'Understand the prospect',
    audience: null,
    sectionCount: 2,
    questionCount: 5,
    dataSlotCount: 0,
    changeCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...over,
  };
}

function makeDetail(over: Partial<QuestionnaireDetail> = {}): QuestionnaireDetail {
  return {
    id: 'qn-1',
    title: 'Northwind Onboarding',
    status: 'launched',
    demoClient: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    versions: [makeVersion()],
    ...over,
  };
}

function makeInvitation(over: Partial<InvitationView> = {}): InvitationView {
  return {
    id: 'inv-1',
    email: 'respondent@example.com',
    name: 'Alice',
    status: 'pending',
    versionId: 'ver-1',
    versionNumber: 1,
    expiresAt: '2026-07-12T00:00:00.000Z',
    sentAt: null,
    openedAt: null,
    registeredAt: null,
    revokedAt: null,
    createdAt: '2026-06-12T00:00:00.000Z',
    ...over,
  };
}

// ─── Page import ──────────────────────────────────────────────────────────────

import InvitationsTab from '@/app/admin/questionnaires/[id]/v/[vid]/invitations/page';

function renderPage(opts: { id?: string; vid?: string } = {}) {
  return InvitationsTab({
    params: Promise.resolve({ id: opts.id ?? 'qn-1', vid: opts.vid ?? 'ver-1' }),
  });
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue(makeDetail());
  workspaceDataMock.getVersionGraphCached.mockResolvedValue(null); // → default invitee fields
  apiMock.serverFetch.mockResolvedValue({ ok: true });
  apiMock.parseApiResponse.mockResolvedValue({
    success: true,
    data: [],
    meta: { total: 0 },
  });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('InvitationsTab', () => {
  describe('detail gating', () => {
    it('calls notFound when getQuestionnaireDetailCached returns null', async () => {
      // Arrange
      workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue(null);

      // Act + Assert
      await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
    });
  });

  describe('happy path — child component props', () => {
    it('renders the import wizard with the correct questionnaireId', async () => {
      // Act
      render(await renderPage({ id: 'qn-42' }));

      // Assert: the page derived the id from params and passed it to the wizard
      const wizard = screen.getByTestId('invite-wizard');
      expect(wizard).toHaveAttribute('data-qid', 'qn-42');
    });

    it('renders InvitationsTable with the correct questionnaireId', async () => {
      // Act
      render(await renderPage({ id: 'qn-42' }));

      // Assert
      const table = screen.getByTestId('invitations-table');
      expect(table).toHaveAttribute('data-qid', 'qn-42');
    });

    it('enables the wizard (disabled=false) when the detail has a launched version', async () => {
      // Arrange: default setup has one launched version
      // Act
      render(await renderPage());

      // Assert: the page computed the boolean from the versions list
      const wizard = screen.getByTestId('invite-wizard');
      expect(wizard).toHaveAttribute('data-disabled', 'false');
    });

    it('disables the wizard (disabled=true) when no launched version exists', async () => {
      // Arrange: all versions are drafts
      workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue(
        makeDetail({ versions: [makeVersion({ id: 'ver-1', status: 'draft' })] })
      );

      // Act
      render(await renderPage());

      // Assert
      const wizard = screen.getByTestId('invite-wizard');
      expect(wizard).toHaveAttribute('data-disabled', 'true');
    });

    it('renders the invitations list in the table', async () => {
      // Arrange: two invitations returned
      apiMock.parseApiResponse.mockResolvedValue({
        success: true,
        data: [makeInvitation({ id: 'inv-1' }), makeInvitation({ id: 'inv-2' })],
        meta: { total: 2 },
      });

      // Act
      render(await renderPage());

      // Assert: the page passed both invitations to the table
      const table = screen.getByTestId('invitations-table');
      expect(table).toHaveAttribute('data-count', '2');
    });
  });

  describe('CostEstimateCard', () => {
    it('renders CostEstimateCard with the newest launched versionId when a launched version exists', async () => {
      // Arrange: two versions — v2 is launched, v1 is archived
      workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue(
        makeDetail({
          versions: [
            makeVersion({ id: 'ver-2', versionNumber: 2, status: 'launched' }),
            makeVersion({ id: 'ver-1', versionNumber: 1, status: 'archived' }),
          ],
        })
      );

      // Act
      render(await renderPage());

      // Assert: the page picked the newest launched version (ver-2, versionNumber=2)
      const card = screen.getByTestId('cost-estimate-card');
      expect(card).toHaveAttribute('data-vid', 'ver-2');
      expect(card).toHaveAttribute('data-variant', 'banner');
    });

    it('renders CostEstimateCard for the highest-numbered launched version when multiple exist', async () => {
      // Arrange: v3 and v1 both launched; v3 should be chosen
      workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue(
        makeDetail({
          versions: [
            makeVersion({ id: 'ver-3', versionNumber: 3, status: 'launched' }),
            makeVersion({ id: 'ver-1', versionNumber: 1, status: 'launched' }),
          ],
        })
      );

      // Act
      render(await renderPage());

      // Assert: page sorted by versionNumber desc and picked ver-3
      const card = screen.getByTestId('cost-estimate-card');
      expect(card).toHaveAttribute('data-vid', 'ver-3');
    });

    it('does not render CostEstimateCard when there are no launched versions', async () => {
      // Arrange
      workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue(
        makeDetail({ versions: [makeVersion({ id: 'ver-1', status: 'draft' })] })
      );

      // Act
      render(await renderPage());

      // Assert
      expect(screen.queryByTestId('cost-estimate-card')).not.toBeInTheDocument();
    });
  });

  describe('truncation note', () => {
    it('shows a truncation note when meta.total exceeds the fetched invitations count', async () => {
      // Arrange: 3 records in total but only 2 in the page (total > invitations.length)
      apiMock.parseApiResponse.mockResolvedValue({
        success: true,
        data: [makeInvitation({ id: 'inv-1' }), makeInvitation({ id: 'inv-2' })],
        meta: { total: 3 },
      });

      // Act
      render(await renderPage());

      // Assert: the page detected truncation and rendered the note
      expect(screen.getByText(/Showing the most recent 2 of 3 invitations/)).toBeInTheDocument();
    });

    it('does not show a truncation note when total equals the fetched count', async () => {
      // Arrange: 2 records total, 2 fetched — no truncation
      apiMock.parseApiResponse.mockResolvedValue({
        success: true,
        data: [makeInvitation({ id: 'inv-1' }), makeInvitation({ id: 'inv-2' })],
        meta: { total: 2 },
      });

      // Act
      render(await renderPage());

      // Assert
      expect(screen.queryByText(/Showing the most recent/)).not.toBeInTheDocument();
    });

    it('uses data.length as total when meta.total is absent', async () => {
      // Arrange: no meta field — page falls back to data.length for total
      apiMock.parseApiResponse.mockResolvedValue({
        success: true,
        data: [makeInvitation()],
      });

      // Act
      render(await renderPage());

      // Assert: total === data.length means truncated === false
      expect(screen.queryByText(/Showing the most recent/)).not.toBeInTheDocument();
    });
  });

  describe('graceful degradation on failed fetch', () => {
    it('renders an empty invitations table when serverFetch returns !ok', async () => {
      // Arrange
      apiMock.serverFetch.mockResolvedValue({ ok: false });

      // Act
      render(await renderPage());

      // Assert: the !res.ok path returns { invitations: [], total: 0 }
      const table = screen.getByTestId('invitations-table');
      expect(table).toHaveAttribute('data-count', '0');
    });

    it('does not call parseApiResponse when serverFetch returns !ok', async () => {
      // Arrange
      apiMock.serverFetch.mockResolvedValue({ ok: false });

      // Act
      render(await renderPage());

      // Assert: early return guard prevents parse
      expect(apiMock.parseApiResponse).not.toHaveBeenCalled();
    });

    it('renders an empty invitations table when parseApiResponse returns success:false', async () => {
      // Arrange
      apiMock.parseApiResponse.mockResolvedValue({ success: false, error: {} });

      // Act
      render(await renderPage());

      // Assert
      const table = screen.getByTestId('invitations-table');
      expect(table).toHaveAttribute('data-count', '0');
    });

    it('renders an empty invitations table and logs when serverFetch throws', async () => {
      // Arrange
      apiMock.serverFetch.mockRejectedValue(new Error('network down'));

      // Act
      render(await renderPage());

      // Assert: catch path degrades to empty list
      const table = screen.getByTestId('invitations-table');
      expect(table).toHaveAttribute('data-count', '0');
      expect(loggerMock.logger.error).toHaveBeenCalledWith(
        'invitations tab: list fetch failed',
        expect.any(Error)
      );
    });
  });

  describe('vid is not used for the invitations fetch', () => {
    it('uses the same questionnaire-scoped invitations regardless of vid', async () => {
      // Arrange: two different vids
      apiMock.parseApiResponse.mockResolvedValue({
        success: true,
        data: [makeInvitation()],
        meta: { total: 1 },
      });

      // Act: render with vid=ver-99 (arbitrary — the page ignores it for the fetch)
      render(await renderPage({ id: 'qn-1', vid: 'ver-99' }));

      // Assert: the invitations table still gets the invitations — vid had no effect
      const table = screen.getByTestId('invitations-table');
      expect(table).toHaveAttribute('data-count', '1');
      // The URL passed to serverFetch must be questionnaire-scoped (contain qn-1 but not ver-99)
      const url = apiMock.serverFetch.mock.calls[0][0] as string;
      expect(url).toContain('qn-1');
      expect(url).not.toContain('ver-99');
    });
  });
});
