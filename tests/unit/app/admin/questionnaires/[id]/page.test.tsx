/**
 * Admin Questionnaire Entry Page (redirector) tests.
 *
 * The page is now a thin redirector: it fetches the questionnaire detail + resolves
 * workspace flags, then:
 *  - calls notFound() when the master flag is off
 *  - calls notFound() when the detail fetch returns null
 *  - redirects to the newest version's workspace base when no ?v= is given
 *  - honours ?v= when the named version exists in the detail's versions list
 *  - renders a "no versions" message (no redirect) when versions is empty
 *
 * Data fetching is faked at the workspace-data boundary; next/navigation's redirect
 * is mocked to throw a sentinel so tests can assert the destination URL.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import type {
  QuestionnaireDetail,
  QuestionnaireVersionSummary,
} from '@/lib/app/questionnaire/views';
import type { QuestionnaireWorkspaceFlags } from '@/lib/app/questionnaire/workspace-data';

// ─── Navigation mocks ────────────────────────────────────────────────────────

const { mockRedirect, mockNotFound } = vi.hoisted(() => ({
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  mockNotFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('next/navigation', () => ({
  redirect: mockRedirect,
  notFound: mockNotFound,
}));

// ─── Workspace-data mock ──────────────────────────────────────────────────────

const workspaceDataMock = vi.hoisted(() => ({
  getQuestionnaireDetailCached: vi.fn<() => Promise<QuestionnaireDetail | null>>(),
  resolveQuestionnaireWorkspaceFlags: vi.fn<() => Promise<QuestionnaireWorkspaceFlags>>(),
}));

vi.mock('@/lib/app/questionnaire/workspace-data', () => workspaceDataMock);

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

function makeFlags(over: Partial<QuestionnaireWorkspaceFlags> = {}): QuestionnaireWorkspaceFlags {
  return {
    master: true,
    dataSlots: false,
    designEval: false,
    liveSessions: true,
    adaptive: false,
    adaptiveDataSlots: false,
    respondentReport: false,
    cohortReport: false,
    introScreen: false,
    advisor: false,
    ...over,
  };
}

// ─── Page import ──────────────────────────────────────────────────────────────

// Import after vi.mock declarations so mocks are in place.
import QuestionnaireEntryPage from '@/app/admin/questionnaires/[id]/page';

function renderPage(opts: { id?: string; v?: string } = {}) {
  return QuestionnaireEntryPage({
    params: Promise.resolve({ id: opts.id ?? 'qn-1' }),
    searchParams: Promise.resolve({ v: opts.v }),
  });
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue(makeDetail());
  workspaceDataMock.resolveQuestionnaireWorkspaceFlags.mockResolvedValue(makeFlags());
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('QuestionnaireEntryPage (redirector)', () => {
  describe('flag and detail gating', () => {
    it('calls notFound when the master feature flag is off', async () => {
      workspaceDataMock.resolveQuestionnaireWorkspaceFlags.mockResolvedValue(
        makeFlags({ master: false })
      );
      await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
    });

    it('calls notFound when the detail fetch returns null', async () => {
      workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue(null);
      await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
    });
  });

  describe('redirect to newest version', () => {
    it('redirects to the workspace base of the first (newest) version when no ?v= given', async () => {
      workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue(
        makeDetail({ versions: [makeVersion({ id: 'ver-1' })] })
      );
      await expect(renderPage()).rejects.toThrow(
        'NEXT_REDIRECT:/admin/questionnaires/qn-1/v/ver-1'
      );
    });

    it('redirects to the newest when there are multiple versions and no ?v=', async () => {
      workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue(
        makeDetail({
          versions: [
            makeVersion({ id: 'ver-2', versionNumber: 2 }),
            makeVersion({ id: 'ver-1', versionNumber: 1 }),
          ],
        })
      );
      // versions[0] is the newest (the list is newest-first)
      await expect(renderPage()).rejects.toThrow(
        'NEXT_REDIRECT:/admin/questionnaires/qn-1/v/ver-2'
      );
    });
  });

  describe('?v= param honouring', () => {
    it('redirects to the ?v= version when it exists in the list', async () => {
      workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue(
        makeDetail({
          versions: [
            makeVersion({ id: 'ver-2', versionNumber: 2 }),
            makeVersion({ id: 'ver-1', versionNumber: 1 }),
          ],
        })
      );
      await expect(renderPage({ v: 'ver-1' })).rejects.toThrow(
        'NEXT_REDIRECT:/admin/questionnaires/qn-1/v/ver-1'
      );
    });

    it('falls back to the newest version when ?v= does not match any version', async () => {
      workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue(
        makeDetail({ versions: [makeVersion({ id: 'ver-1' })] })
      );
      await expect(renderPage({ v: 'ver-nonexistent' })).rejects.toThrow(
        'NEXT_REDIRECT:/admin/questionnaires/qn-1/v/ver-1'
      );
    });
  });

  describe('no-versions state', () => {
    it('renders a "no versions" message when the questionnaire has zero versions', async () => {
      workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue(
        makeDetail({ title: 'Empty QN', versions: [] })
      );
      const el = await renderPage();
      render(el);
      expect(screen.getByText('This questionnaire has no versions yet.')).toBeInTheDocument();
      // Should NOT redirect — no throw means we returned JSX
      expect(mockRedirect).not.toHaveBeenCalled();
    });

    it('shows the questionnaire title in the no-versions message', async () => {
      workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue(
        makeDetail({ title: 'My Survey', versions: [] })
      );
      const el = await renderPage();
      render(el);
      expect(screen.getByText('My Survey')).toBeInTheDocument();
    });
  });
});
