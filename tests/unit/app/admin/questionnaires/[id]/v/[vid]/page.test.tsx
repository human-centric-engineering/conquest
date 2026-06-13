/**
 * Overview tab page (`/admin/questionnaires/[id]/v/[vid]`) tests.
 *
 * The Overview tab is the default workspace landing. It shows stat tiles, launch
 * readiness (LaunchChecklist for drafts, a "launched" panel otherwise), and quick
 * actions including "Preview as respondent" (gated on liveSessions flag + version
 * status === 'launched') and a version timeline.
 *
 * Fetchers are mocked at the `workspace-data` boundary. Heavy children (CqStatTiles,
 * LaunchChecklist) are stubbed to identifiable markers so we assert the page's own
 * branching, not their internals.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import type {
  QuestionnaireDetail,
  QuestionnaireVersionSummary,
  VersionGraphView,
} from '@/lib/app/questionnaire/views';
import type { QuestionnaireWorkspaceFlags } from '@/lib/app/questionnaire/workspace-data';
import { DEFAULT_QUESTIONNAIRE_CONFIG } from '@/lib/app/questionnaire/types';

// ─── Navigation mocks ────────────────────────────────────────────────────────

const { mockNotFound } = vi.hoisted(() => ({
  mockNotFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('next/navigation', () => ({
  notFound: mockNotFound,
  redirect: vi.fn(),
}));

// ─── Workspace-data mock ──────────────────────────────────────────────────────

const workspaceDataMock = vi.hoisted(() => ({
  getQuestionnaireDetailCached: vi.fn<() => Promise<QuestionnaireDetail | null>>(),
  getVersionGraphCached: vi.fn<() => Promise<VersionGraphView | null>>(),
  getVersionDataSlotCountCached: vi.fn<() => Promise<number>>(),
  resolveQuestionnaireWorkspaceFlags: vi.fn<() => Promise<QuestionnaireWorkspaceFlags>>(),
}));

vi.mock('@/lib/app/questionnaire/workspace-data', () => workspaceDataMock);

// ─── Stub heavy children to identifiable markers ──────────────────────────────

vi.mock('@/components/admin/cq-stat-tiles', () => ({
  CqStatTiles: (props: { stats: Array<{ label: string; value: number; hint?: string }> }) => (
    <div data-testid="cq-stat-tiles" data-count={String(props.stats.length)}>
      {props.stats.map((s) => (
        <div key={s.label} data-testid={`stat-${s.label}`} data-hint={s.hint ?? ''}>
          {s.label}: {s.value}
        </div>
      ))}
    </div>
  ),
}));

vi.mock('@/components/admin/questionnaires/launch-checklist', () => ({
  LaunchChecklist: (props: { versionNumber: number }) => (
    <div data-testid="launch-checklist">launch v{props.versionNumber}</div>
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

function makeGraph(over: { anonymousMode?: boolean; saved?: boolean } = {}): VersionGraphView {
  return {
    id: 'ver-1',
    questionnaireId: 'qn-1',
    versionNumber: 1,
    status: 'launched',
    goal: 'Understand the prospect',
    audience: null,
    goalProvenance: null,
    audienceProvenance: null,
    sections: [],
    tags: [],
    config: {
      ...DEFAULT_QUESTIONNAIRE_CONFIG,
      saved: over.saved ?? true,
      anonymousMode: over.anonymousMode ?? true,
    },
  };
}

function makeFlags(over: Partial<QuestionnaireWorkspaceFlags> = {}): QuestionnaireWorkspaceFlags {
  return {
    master: true,
    dataSlots: false,
    designEval: false,
    liveSessions: true,
    adaptive: false,
    ...over,
  };
}

// ─── Page import ──────────────────────────────────────────────────────────────

import OverviewTab from '@/app/admin/questionnaires/[id]/v/[vid]/page';

function renderPage(opts: { id?: string; vid?: string } = {}) {
  return OverviewTab({
    params: Promise.resolve({ id: opts.id ?? 'qn-1', vid: opts.vid ?? 'ver-1' }),
  });
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue(makeDetail());
  workspaceDataMock.getVersionGraphCached.mockResolvedValue(makeGraph());
  workspaceDataMock.getVersionDataSlotCountCached.mockResolvedValue(0);
  workspaceDataMock.resolveQuestionnaireWorkspaceFlags.mockResolvedValue(makeFlags());
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('OverviewTab', () => {
  describe('data gating', () => {
    it('calls notFound when the detail fetch returns null', async () => {
      workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue(null);
      await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
    });

    it('calls notFound when the vid is not in the versions list', async () => {
      workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue(
        makeDetail({ versions: [makeVersion({ id: 'ver-other' })] })
      );
      await expect(renderPage({ vid: 'ver-1' })).rejects.toThrow('NEXT_NOT_FOUND');
    });
  });

  describe('stat tiles', () => {
    it('renders the CqStatTiles component with four stats', async () => {
      render(await renderPage());
      const tiles = screen.getByTestId('cq-stat-tiles');
      expect(tiles).toHaveAttribute('data-count', '4');
    });

    it('hints "none recorded" on the Extraction changes tile when changeCount is 0', async () => {
      workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue(
        makeDetail({ versions: [makeVersion({ id: 'ver-1', changeCount: 0 })] })
      );
      render(await renderPage());
      expect(screen.getByTestId('stat-Extraction changes')).toHaveAttribute(
        'data-hint',
        'none recorded'
      );
    });

    it('hints "review on the Changes tab" on the Extraction changes tile when changeCount > 0', async () => {
      workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue(
        makeDetail({ versions: [makeVersion({ id: 'ver-1', changeCount: 3 })] })
      );
      render(await renderPage());
      expect(screen.getByTestId('stat-Extraction changes')).toHaveAttribute(
        'data-hint',
        'review on the Changes tab'
      );
    });
  });

  describe('launch readiness — draft version', () => {
    it('renders the LaunchChecklist for a draft version with a loaded graph', async () => {
      workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue(
        makeDetail({ versions: [makeVersion({ id: 'ver-1', status: 'draft' })] })
      );
      workspaceDataMock.getVersionGraphCached.mockResolvedValue(makeGraph());
      render(await renderPage());
      expect(screen.getByTestId('launch-checklist')).toHaveTextContent('launch v1');
    });

    it('does not render the LaunchChecklist when the version is launched', async () => {
      // default setup: version is 'launched'
      render(await renderPage());
      expect(screen.queryByTestId('launch-checklist')).not.toBeInTheDocument();
    });

    it('shows the launch readiness message on a draft version', async () => {
      workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue(
        makeDetail({ versions: [makeVersion({ id: 'ver-1', status: 'draft' })] })
      );
      render(await renderPage());
      // The page renders "This version is a draft. Review the launch checklist…"
      // The phrase crosses two text nodes (one wrapping <p> + an inline <span>),
      // so match the containing <p> by substring.
      expect(screen.getByText(/launch checklist before going live/i)).toBeInTheDocument();
    });
  });

  describe('launch readiness — launched version', () => {
    it('shows the Launched badge for a launched version', async () => {
      render(await renderPage());
      expect(screen.getByText('Launched')).toBeInTheDocument();
    });

    it('shows the "This version is live" message for a launched version', async () => {
      render(await renderPage());
      expect(screen.getByText(/This version is live/)).toBeInTheDocument();
    });
  });

  describe('launch readiness — archived version', () => {
    it('shows the archived message for an archived version', async () => {
      workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue(
        makeDetail({ versions: [makeVersion({ id: 'ver-1', status: 'archived' })] })
      );
      render(await renderPage());
      // "This version is <span>archived</span>." crosses two text nodes — match the
      // wrapping <p> by its leading text node, then assert the full message content.
      const message = screen.getByText(/This version is/);
      expect(message).toHaveTextContent('This version is archived.');
    });

    it('does not show the launched panel or the LaunchChecklist when archived', async () => {
      workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue(
        makeDetail({ versions: [makeVersion({ id: 'ver-1', status: 'archived' })] })
      );
      render(await renderPage());
      expect(screen.queryByText(/This version is live/)).not.toBeInTheDocument();
      expect(screen.queryByTestId('launch-checklist')).not.toBeInTheDocument();
    });
  });

  describe('Preview as respondent', () => {
    it('links to the admin preview (?preview=1) when launched + live-sessions on, anonymous mode', async () => {
      // Anonymous versions preview through ?preview=1 too — the admin-gated /preview route marks
      // the run isPreview (kept out of analytics) and lets the surface show an "Exit preview" exit.
      workspaceDataMock.getVersionGraphCached.mockResolvedValue(makeGraph({ anonymousMode: true }));
      render(await renderPage());
      const link = screen.getByRole('link', { name: /preview as respondent/i });
      expect(link).toHaveAttribute('href', '/q/ver-1?preview=1');
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    });

    it('links to the admin preview (?preview=1) when launched + live-sessions on, anonymous mode off', async () => {
      workspaceDataMock.getVersionGraphCached.mockResolvedValue(
        makeGraph({ anonymousMode: false })
      );
      render(await renderPage());
      const link = screen.getByRole('link', { name: /preview as respondent/i });
      expect(link).toHaveAttribute('href', '/q/ver-1?preview=1');
      expect(link).toHaveAttribute('target', '_blank');
    });

    it('is absent when the live-sessions flag is off', async () => {
      workspaceDataMock.resolveQuestionnaireWorkspaceFlags.mockResolvedValue(
        makeFlags({ liveSessions: false })
      );
      render(await renderPage());
      expect(
        screen.queryByRole('link', { name: /preview as respondent/i })
      ).not.toBeInTheDocument();
    });

    it('is absent when the version is a draft (not launched)', async () => {
      workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue(
        makeDetail({ versions: [makeVersion({ id: 'ver-1', status: 'draft' })] })
      );
      render(await renderPage());
      expect(
        screen.queryByRole('link', { name: /preview as respondent/i })
      ).not.toBeInTheDocument();
    });

    it('is absent when the graph is null even with live-sessions on + launched', async () => {
      workspaceDataMock.getVersionGraphCached.mockResolvedValue(null);
      render(await renderPage());
      expect(
        screen.queryByRole('link', { name: /preview as respondent/i })
      ).not.toBeInTheDocument();
    });
  });

  describe('version timeline', () => {
    it('renders all versions in the timeline list', async () => {
      workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue(
        makeDetail({
          versions: [
            makeVersion({ id: 'ver-2', versionNumber: 2 }),
            makeVersion({ id: 'ver-1', versionNumber: 1 }),
          ],
        })
      );
      render(await renderPage({ vid: 'ver-2' }));
      expect(screen.getByText('v2')).toBeInTheDocument();
      expect(screen.getByText('v1')).toBeInTheDocument();
    });

    it('marks the active version with "(viewing)"', async () => {
      render(await renderPage({ vid: 'ver-1' }));
      expect(screen.getByText('(viewing)')).toBeInTheDocument();
    });
  });

  describe('data-slots quick action', () => {
    it('shows the Data slots quick-action button when the dataSlots flag is on', async () => {
      workspaceDataMock.resolveQuestionnaireWorkspaceFlags.mockResolvedValue(
        makeFlags({ dataSlots: true })
      );
      workspaceDataMock.getVersionDataSlotCountCached.mockResolvedValue(0);
      render(await renderPage());
      expect(screen.getByRole('link', { name: /data slots/i })).toBeInTheDocument();
    });

    it('hides the Data slots quick-action button when the dataSlots flag is off', async () => {
      workspaceDataMock.resolveQuestionnaireWorkspaceFlags.mockResolvedValue(
        makeFlags({ dataSlots: false })
      );
      render(await renderPage());
      expect(screen.queryByRole('link', { name: /data slots/i })).not.toBeInTheDocument();
    });

    it('shows the data-slot count when non-zero', async () => {
      workspaceDataMock.resolveQuestionnaireWorkspaceFlags.mockResolvedValue(
        makeFlags({ dataSlots: true })
      );
      workspaceDataMock.getVersionDataSlotCountCached.mockResolvedValue(3);
      render(await renderPage());
      expect(screen.getByRole('link', { name: /data slots \(3\)/i })).toBeInTheDocument();
    });
  });
});
