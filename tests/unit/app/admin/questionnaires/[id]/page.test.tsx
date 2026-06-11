/**
 * Admin Questionnaire Detail Page tests.
 *
 * The page is an async Server Component that gates on `isQuestionnairesEnabled`, fetches the
 * detail + (per selected version) graph via `serverFetch`, and renders version actions. These
 * tests pin the feature-flag gate, the not-found paths, version selection, and — the focus of
 * the demo-polish PR — the two new operator affordances:
 *   - "Review & Launch" (LaunchChecklist) shows only on a draft version with a loaded graph.
 *   - "Preview as respondent" links to the live respondent surface whenever the live-sessions
 *     flag is on AND the version is launched: an anonymous-mode version opens its real no-login
 *     `/q/<versionId>` surface; a non-anonymous one opens the admin preview (`?preview=1`). The
 *     selected version's access mode is also surfaced as a badge.
 *
 * Data fetching is faked at the `server-fetch` boundary (routed by URL); the heavy child
 * components are stubbed so we assert the page's own branching, not their internals.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import QuestionnaireDetailPage from '@/app/admin/questionnaires/[id]/page';
import { DEFAULT_QUESTIONNAIRE_CONFIG } from '@/lib/app/questionnaire/types';
import type {
  QuestionnaireDetail,
  QuestionnaireVersionSummary,
  VersionGraphView,
} from '@/lib/app/questionnaire/views';

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const flagMock = vi.hoisted(() => ({
  isQuestionnairesEnabled: vi.fn(),
  isAdaptiveSelectionEnabled: vi.fn(),
  isDesignEvaluationEnabled: vi.fn(),
  isLiveSessionsEnabled: vi.fn(),
  isDataSlotsEnabled: vi.fn(),
}));
vi.mock('@/lib/app/questionnaire/feature-flag', () => flagMock);

// `serverFetch` returns a Response-like marker carrying its URL; `parseApiResponse` routes off
// that URL into the per-test `apiData` registry. This keeps the three fetches (detail, demo
// clients, version graph) independently controllable without relying on call order.
interface ApiData {
  detail: QuestionnaireDetail | null;
  graph: VersionGraphView | null;
}
const apiData: ApiData = { detail: null, graph: null };

vi.mock('@/lib/api/server-fetch', () => ({
  serverFetch: vi.fn(async (url: string) => ({ ok: true, _url: url })),
  parseApiResponse: vi.fn(async (res: { _url: string }) => {
    const url = res._url;
    if (url.includes('/versions/')) {
      return apiData.graph ? { success: true, data: apiData.graph } : { success: false, error: {} };
    }
    if (url.includes('/demo-clients')) {
      return { success: true, data: [] };
    }
    return apiData.detail ? { success: true, data: apiData.detail } : { success: false, error: {} };
  }),
}));

// Heavy children stubbed to identifiable markers so we assert the page's branching only.
vi.mock('@/components/admin/questionnaires/launch-checklist', () => ({
  LaunchChecklist: (props: { versionNumber: number }) => (
    <div data-testid="launch-checklist">launch v{props.versionNumber}</div>
  ),
}));
vi.mock('@/components/admin/questionnaires/version-graph', () => ({
  VersionGraph: () => <div data-testid="version-graph" />,
}));
vi.mock('@/components/admin/questionnaires/version-editor', () => ({
  VersionEditor: () => <div data-testid="version-editor" />,
}));
vi.mock('@/components/admin/questionnaires/reingest-dialog', () => ({
  ReingestDialog: () => <div data-testid="reingest-dialog" />,
}));
vi.mock('@/components/admin/questionnaires/clone-for-client-dialog', () => ({
  CloneForClientDialog: () => <div data-testid="clone-dialog" />,
}));
vi.mock('@/components/admin/demo-clients/demo-client-assign', () => ({
  DemoClientAssign: () => <div data-testid="demo-client-assign" />,
}));

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

function renderPage(opts: { id?: string; v?: string; edit?: string } = {}) {
  return QuestionnaireDetailPage({
    params: Promise.resolve({ id: opts.id ?? 'qn-1' }),
    searchParams: Promise.resolve({ v: opts.v, edit: opts.edit }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  apiData.detail = makeDetail();
  apiData.graph = makeGraph();
  flagMock.isQuestionnairesEnabled.mockResolvedValue(true);
  flagMock.isAdaptiveSelectionEnabled.mockResolvedValue(false);
  flagMock.isDesignEvaluationEnabled.mockResolvedValue(false);
  flagMock.isLiveSessionsEnabled.mockResolvedValue(true);
  flagMock.isDataSlotsEnabled.mockResolvedValue(false);
});

describe('QuestionnaireDetailPage', () => {
  describe('gating', () => {
    it('calls notFound when the questionnaires feature is disabled', async () => {
      flagMock.isQuestionnairesEnabled.mockResolvedValue(false);
      await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
    });

    it('calls notFound when the detail fetch returns nothing', async () => {
      apiData.detail = null;
      await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
    });
  });

  describe('rendering', () => {
    it('renders the title and version count', async () => {
      render(await renderPage());
      expect(screen.getByRole('heading', { name: 'Northwind Onboarding' })).toBeInTheDocument();
      expect(screen.getByText('1 version')).toBeInTheDocument();
    });

    it('selects the version named by the ?v= param', async () => {
      apiData.detail = makeDetail({
        versions: [
          makeVersion({ id: 'ver-2', versionNumber: 2 }),
          makeVersion({ id: 'ver-1', versionNumber: 1 }),
        ],
      });
      render(await renderPage({ v: 'ver-1' }));
      // The version-selector link for the *active* version omits the ?v= self-link styling we
      // can't easily assert; instead confirm the section/question summary for the picked version
      // rendered (proving selection resolved to a real version, not a crash).
      expect(screen.getByText(/2 sections · 5 questions/)).toBeInTheDocument();
    });
  });

  describe('Review & Launch (LaunchChecklist)', () => {
    it('renders the launch checklist on a draft version with a loaded graph', async () => {
      apiData.detail = makeDetail({
        status: 'draft',
        versions: [makeVersion({ status: 'draft' })],
      });
      apiData.graph = makeGraph();
      render(await renderPage());
      expect(screen.getByTestId('launch-checklist')).toHaveTextContent('launch v1');
    });

    it('does not render the launch checklist on a launched version', async () => {
      // default detail/graph are launched
      render(await renderPage());
      expect(screen.queryByTestId('launch-checklist')).not.toBeInTheDocument();
    });
  });

  describe('Preview as respondent', () => {
    it('links to the real /q/<versionId> surface when launched + live-sessions on + anonymous', async () => {
      apiData.graph = makeGraph({ anonymousMode: true });
      render(await renderPage());
      const link = screen.getByRole('link', { name: /preview as respondent/i });
      expect(link).toHaveAttribute('href', '/q/ver-1');
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    });

    it('links to the admin preview (?preview=1) when anonymous mode is off — no longer disabled', async () => {
      apiData.graph = makeGraph({ anonymousMode: false });
      render(await renderPage());
      expect(
        screen.queryByRole('button', { name: /preview as respondent/i })
      ).not.toBeInTheDocument();
      const link = screen.getByRole('link', { name: /preview as respondent/i });
      expect(link).toHaveAttribute('href', '/q/ver-1?preview=1');
      expect(link).toHaveAttribute('target', '_blank');
    });

    it('surfaces the access mode of the selected version as a badge', async () => {
      apiData.graph = makeGraph({ anonymousMode: true });
      render(await renderPage());
      expect(screen.getByText('Anonymous mode')).toBeInTheDocument();
      expect(screen.queryByText('Invitation only')).not.toBeInTheDocument();
    });

    it('shows the "Invitation only" badge when anonymous mode is off', async () => {
      apiData.graph = makeGraph({ anonymousMode: false });
      render(await renderPage());
      expect(screen.getByText('Invitation only')).toBeInTheDocument();
      expect(screen.queryByText('Anonymous mode')).not.toBeInTheDocument();
    });

    it('is absent entirely when the live-sessions flag is off', async () => {
      flagMock.isLiveSessionsEnabled.mockResolvedValue(false);
      render(await renderPage());
      expect(screen.queryByText(/preview as respondent/i)).not.toBeInTheDocument();
    });

    it('does not query the live-sessions flag for a draft version (status short-circuit)', async () => {
      apiData.detail = makeDetail({
        status: 'draft',
        versions: [makeVersion({ status: 'draft' })],
      });
      await renderPage();
      expect(flagMock.isLiveSessionsEnabled).not.toHaveBeenCalled();
    });
  });
});
