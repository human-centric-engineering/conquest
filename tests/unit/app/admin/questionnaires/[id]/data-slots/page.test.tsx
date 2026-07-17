/**
 * Legacy Data Slots redirect page tests.
 *
 * The old data-slots page is now a thin redirector:
 *   - calls notFound() when the detail fetch returns null
 *   - calls notFound() when the questionnaire has no versions
 *   - redirects to `/admin/questionnaires/[id]/v/[vid]/data-slots` using newest version
 *   - honours ?v= when the named version exists in the detail's versions list
 *
 * Fetching is mocked at the `workspace-data` boundary.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import type {
  QuestionnaireDetail,
  QuestionnaireVersionSummary,
} from '@/lib/app/questionnaire/views';

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
}));

vi.mock('@/lib/app/questionnaire/workspace-data', () => workspaceDataMock);

// ─── Factories ────────────────────────────────────────────────────────────────

function makeVersion(over: Partial<QuestionnaireVersionSummary> = {}): QuestionnaireVersionSummary {
  return {
    id: 'ver-1',
    versionNumber: 1,
    status: 'draft',
    goal: 'Understand the prospect',
    audience: null,
    sectionCount: 2,
    questionCount: 3,
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
    title: 'Prospect Discovery',
    status: 'draft',
    demoClient: null,
    archivedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    versions: [makeVersion()],
    ...over,
  };
}

// ─── Page import ──────────────────────────────────────────────────────────────

import LegacyDataSlotsRedirect from '@/app/admin/questionnaires/[id]/data-slots/page';

function renderPage(opts: { id?: string; v?: string } = {}) {
  return LegacyDataSlotsRedirect({
    params: Promise.resolve({ id: opts.id ?? 'qn-1' }),
    searchParams: Promise.resolve({ v: opts.v }),
  });
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue(makeDetail());
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('LegacyDataSlotsRedirect', () => {
  describe('gating', () => {
    it('calls notFound when the detail fetch returns null', async () => {
      workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue(null);
      await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
    });

    it('calls notFound when the questionnaire has no versions', async () => {
      workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue(
        makeDetail({ versions: [] })
      );
      await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
    });
  });

  describe('redirect to data-slots tab', () => {
    it('redirects to the newest version data-slots tab when no ?v= given', async () => {
      workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue(
        makeDetail({ versions: [makeVersion({ id: 'ver-1' })] })
      );
      await expect(renderPage()).rejects.toThrow(
        'NEXT_REDIRECT:/admin/questionnaires/qn-1/v/ver-1/data-slots'
      );
    });

    it('uses versions[0] (newest) when multiple versions exist and no ?v= given', async () => {
      workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue(
        makeDetail({
          versions: [
            makeVersion({ id: 'ver-2', versionNumber: 2 }),
            makeVersion({ id: 'ver-1', versionNumber: 1 }),
          ],
        })
      );
      await expect(renderPage()).rejects.toThrow(
        'NEXT_REDIRECT:/admin/questionnaires/qn-1/v/ver-2/data-slots'
      );
    });

    it('honours ?v= when the named version is in the list', async () => {
      workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue(
        makeDetail({
          versions: [
            makeVersion({ id: 'ver-2', versionNumber: 2 }),
            makeVersion({ id: 'ver-1', versionNumber: 1 }),
          ],
        })
      );
      await expect(renderPage({ v: 'ver-1' })).rejects.toThrow(
        'NEXT_REDIRECT:/admin/questionnaires/qn-1/v/ver-1/data-slots'
      );
    });

    it('falls back to the newest version when ?v= does not match any version', async () => {
      workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue(
        makeDetail({ versions: [makeVersion({ id: 'ver-1' })] })
      );
      // ver-nonexistent doesn't exist → falls back to ver-1
      await expect(renderPage({ v: 'ver-nonexistent' })).rejects.toThrow(
        'NEXT_REDIRECT:/admin/questionnaires/qn-1/v/ver-1/data-slots'
      );
    });
  });
});
