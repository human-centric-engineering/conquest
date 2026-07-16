/**
 * Analytics tab page (`/admin/questionnaires/[id]/v/[vid]/analytics`) tests.
 *
 * The page is an async Server Component that:
 *  - gates on isQuestionnairesEnabled()
 *  - reads `id`, `vid`, and optional `searchParams` (from/to/tagIds)
 *  - calls getVersionGraphCached for the tag vocabulary
 *  - fetches distributions, funnel, and cost via serverFetch in parallel
 *  - degrades gracefully (null props) when any fetch fails
 *  - renders ExportButtons with the constructed query string
 *  - renders AnalyticsView with resolved filters and fetched data
 *
 * Heavy children (AnalyticsView, ExportButtons) are stubbed to identifiable
 * markers that expose the props they receive as data-attributes, allowing
 * assertions on what the page computed and passed — not what the mock returned.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import type { VersionGraphView, TagView } from '@/lib/app/questionnaire/views';
import {
  DEFAULT_RESPONDENT_REPORT_SETTINGS,
  DEFAULT_COHORT_REPORT_SETTINGS,
  DEFAULT_INTRO_SETTINGS,
  DEFAULT_TONE_SETTINGS,
  DEFAULT_INTERVIEWER_STRATEGY,
} from '@/lib/app/questionnaire/types';
import type {
  QuestionDistributionsResult,
  CompletionFunnelResult,
  QuestionnaireCostResult,
  SafeguardingSummary,
} from '@/lib/app/questionnaire/analytics';

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

// ─── Feature-flag mock ────────────────────────────────────────────────────────

const flagMock = vi.hoisted(() => ({
  isQuestionnairesEnabled: vi.fn(),
  // Cohorts & Rounds: the analytics page gates the round-scope selector on this flag.
  isCohortsEnabled: vi.fn(),
}));
vi.mock('@/lib/app/questionnaire/feature-flag', () => flagMock);

// ─── workspace-data mock (for getVersionGraphCached) ─────────────────────────

const workspaceDataMock = vi.hoisted(() => ({
  getVersionGraphCached: vi.fn<() => Promise<VersionGraphView | null>>(),
  // The analytics page resolves workspace flags to gate the version-wide-report teaser
  // (`flags.cohortReport`). Default to off so the teaser is hidden in these tests.
  resolveQuestionnaireWorkspaceFlags: vi.fn(async () => ({ cohortReport: false })),
}));
vi.mock('@/lib/app/questionnaire/workspace-data', () => workspaceDataMock);

// ─── rounds read mock (for the analytics round-scope selector) ───────────────

const roundsReadMock = vi.hoisted(() => ({
  listRoundsForVersion: vi.fn(),
}));
vi.mock('@/app/api/v1/app/rounds/_lib/read', () => roundsReadMock);

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

// ─── analytics date-input mock (for determinism) ─────────────────────────────
// getAnalyticsDefaultDateInputs uses Date.now() internally; pin it so tests
// that assert filter values are not date-sensitive.

vi.mock('@/lib/app/questionnaire/analytics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/app/questionnaire/analytics')>();
  return {
    ...actual,
    getAnalyticsDefaultDateInputs: vi.fn(() => ({
      from: '2026-05-13',
      to: '2026-06-12',
    })),
  };
});

// ─── Stub AnalyticsView ───────────────────────────────────────────────────────

vi.mock('@/components/admin/questionnaires/analytics/analytics-view', () => ({
  AnalyticsView: (props: {
    tagVocabulary: TagView[];
    distributions: QuestionDistributionsResult | null;
    funnel: CompletionFunnelResult | null;
    cost: QuestionnaireCostResult | null;
    filters: { from: string; to: string; tagIds: string[] };
  }) => (
    <div
      data-testid="analytics-view"
      data-tag-count={String(props.tagVocabulary.length)}
      data-has-distributions={String(props.distributions !== null)}
      data-has-funnel={String(props.funnel !== null)}
      data-has-cost={String(props.cost !== null)}
      data-filter-from={props.filters.from}
      data-filter-to={props.filters.to}
      data-filter-tag-ids={props.filters.tagIds.join(',')}
    />
  ),
}));

// ─── Stub ExportButtons ───────────────────────────────────────────────────────

vi.mock('@/components/admin/questionnaires/analytics/export-buttons', () => ({
  ExportButtons: (props: { questionnaireId: string; versionId: string; query: string }) => (
    <div
      data-testid="export-buttons"
      data-qid={props.questionnaireId}
      data-vid={props.versionId}
      data-query={props.query}
    />
  ),
}));

// ─── Factories ────────────────────────────────────────────────────────────────

function makeTag(over: Partial<TagView> = {}): TagView {
  return { id: 'tag-1', label: 'Tag A', color: null, ...over };
}

function makeGraph(over: Partial<VersionGraphView> = {}): VersionGraphView {
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
    tags: [makeTag()],
    config: {
      saved: true,
      selectionStrategy: 'sequential',
      minQuestionsAnswered: 0,
      coverageThreshold: 1,
      answerConfidenceFloor: 0.5,
      allowEarlyFinish: false,
      earlyFinishMinCoverage: 0.5,
      earlyFinishMinQuestions: 0,
      interviewerStrategy: DEFAULT_INTERVIEWER_STRATEGY,
      costBudgetUsd: null,
      maxQuestionsPerSession: null,
      voiceEnabled: false,
      attachmentsEnabled: false,
      contradictionMode: 'off',
      contradictionWindowN: 0,
      contradictionEveryNTurns: 1,
      answerFitMode: 'fallback',
      extractionPrefilter: false,
      anonymousMode: false,
      accessMode: 'invitation_only',
      inviteeFields: [],
      abuseThreshold: 4,
      maxDataSlotAttempts: 2,
      sensitivityAwareness: false,
      supportMessage: '',
      supportResourceUrl: '',
      profileFields: [],
      answerSlotPanelScope: 'full_progress',
      presentationMode: 'chat',
      captureMode: 'form',
      inlineCorrectionEnabled: true,
      sessionResumeEnabled: true,
      reasoningStreamEnabled: true,
      reasoningStreamPlacement: 'overlay',
      reasoningStreamDwellMs: 2000,
      reasoningStreamPerItemMs: 330,
      reasoningStreamPersist: true,
      previewInspectorEnabled: false,
      tone: DEFAULT_TONE_SETTINGS,
      personas: [],
      personaSelection: {
        enabled: false,
        defaultPersonaKey: 'neutral-coach',
        allowRespondentSwitch: false,
        switcher: 'page',
      },
      respondentReport: DEFAULT_RESPONDENT_REPORT_SETTINGS,
      cohortReport: DEFAULT_COHORT_REPORT_SETTINGS,
      intro: DEFAULT_INTRO_SETTINGS,
    },
    ...over,
  };
}

function makeDistributions(): QuestionDistributionsResult {
  return {
    versionId: 'ver-1',
    range: { from: '2026-05-13T00:00:00.000Z', to: '2026-06-12T00:00:00.000Z' },
    totalSessions: 10,
    completedSessions: 8,
    suppressed: false,
    questions: [],
  };
}

function makeFunnel(): CompletionFunnelResult {
  return {
    versionId: 'ver-1',
    range: { from: '2026-05-13T00:00:00.000Z', to: '2026-06-12T00:00:00.000Z' },
    stages: [],
    anonymous: { started: 0, completed: 0 },
    suppressed: false,
  };
}

function makeCost(): QuestionnaireCostResult {
  return {
    versionId: 'ver-1',
    range: { from: '2026-05-13T00:00:00.000Z', to: '2026-06-12T00:00:00.000Z' },
    totalCostUsd: 1.5,
    runtimeCostUsd: 1.0,
    designTimeCostUsd: 0.5,
    byCapability: [],
    trend: [],
    topSessions: [],
    topSessionsSuppressed: false,
  };
}

function makeSafeguarding(): SafeguardingSummary {
  return {
    versionId: 'ver-1',
    range: { from: '2026-05-13T00:00:00.000Z', to: '2026-06-12T00:00:00.000Z' },
    flagged: 0,
    serious: 0,
    suppressed: false,
  };
}

// ─── Page import ──────────────────────────────────────────────────────────────

import AnalyticsTab from '@/app/admin/questionnaires/[id]/v/[vid]/analytics/page';

interface RenderPageOpts {
  id?: string;
  vid?: string;
  searchParams?: { from?: string; to?: string; tagIds?: string };
}

function renderPage({ id = 'qn-1', vid = 'ver-1', searchParams = {} }: RenderPageOpts = {}) {
  return AnalyticsTab({
    params: Promise.resolve({ id, vid }),
    searchParams: Promise.resolve(searchParams),
  });
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  flagMock.isQuestionnairesEnabled.mockResolvedValue(true);
  // Cohorts off by default for these tests — the round selector is absent unless a test opts in.
  flagMock.isCohortsEnabled.mockResolvedValue(false);
  roundsReadMock.listRoundsForVersion.mockResolvedValue({ rounds: [], hasOpenEnded: false });
  workspaceDataMock.getVersionGraphCached.mockResolvedValue(makeGraph());

  // By default all four fetches succeed. serverFetch embeds the URL in the response so
  // parseApiResponse can branch on it — this avoids call-order dependence in the happy path.
  apiMock.serverFetch.mockImplementation(async (url: string) => ({ ok: true, _url: url }));
  apiMock.parseApiResponse.mockImplementation(async (res: { ok: boolean; _url?: string }) => {
    const url = (res as { _url?: string })._url ?? '';
    if (url.includes('/distributions')) return { success: true, data: makeDistributions() };
    if (url.includes('/funnel')) return { success: true, data: makeFunnel() };
    if (url.includes('/cost')) return { success: true, data: makeCost() };
    if (url.includes('/safeguarding')) return { success: true, data: makeSafeguarding() };
    return { success: true, data: makeDistributions() };
  });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AnalyticsTab', () => {
  describe('feature-flag gating', () => {
    it('calls notFound when the questionnaires feature flag is off', async () => {
      // Arrange
      flagMock.isQuestionnairesEnabled.mockResolvedValue(false);

      // Act + Assert
      await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
    });
  });

  describe('happy path — child component props', () => {
    // No extra setup needed — the global beforeEach wires parseApiResponse to return
    // the correct fixture per endpoint URL, so call order in Promise.all is irrelevant.

    it('renders the ExportButtons with the correct questionnaireId and versionId', async () => {
      // Act
      render(await renderPage({ id: 'qn-42', vid: 'ver-99' }));

      // Assert: the page passed the IDs through — not just the mock's IDs
      const btn = screen.getByTestId('export-buttons');
      expect(btn).toHaveAttribute('data-qid', 'qn-42');
      expect(btn).toHaveAttribute('data-vid', 'ver-99');
    });

    it('renders the AnalyticsView with the tag vocabulary from the graph', async () => {
      // Arrange: graph with two tags
      workspaceDataMock.getVersionGraphCached.mockResolvedValue(
        makeGraph({ tags: [makeTag({ id: 'tag-1' }), makeTag({ id: 'tag-2', label: 'Tag B' })] })
      );

      // Act
      render(await renderPage());

      // Assert: the page passed the graph's tags to the child, not a re-computed value
      const view = screen.getByTestId('analytics-view');
      expect(view).toHaveAttribute('data-tag-count', '2');
    });

    it('renders AnalyticsView with empty tag vocabulary when the graph is null', async () => {
      // Arrange
      workspaceDataMock.getVersionGraphCached.mockResolvedValue(null);

      // Act
      render(await renderPage());

      // Assert: the page falls back to [] rather than propagating null
      const view = screen.getByTestId('analytics-view');
      expect(view).toHaveAttribute('data-tag-count', '0');
    });

    it('renders AnalyticsView with has-distributions=true on a successful distributions fetch', async () => {
      // Act
      render(await renderPage());

      // Assert: the page received real data and passed it to the child
      const view = screen.getByTestId('analytics-view');
      expect(view).toHaveAttribute('data-has-distributions', 'true');
    });
  });

  describe('query-string builder', () => {
    it('passes an empty query to ExportButtons when no searchParams are present', async () => {
      // Arrange
      apiMock.parseApiResponse.mockResolvedValue({ success: true, data: makeDistributions() });

      // Act
      render(await renderPage({ searchParams: {} }));

      // Assert: buildQuery with no sp produces '' — ExportButtons receives no query string
      const btn = screen.getByTestId('export-buttons');
      expect(btn).toHaveAttribute('data-query', '');
    });

    it('passes a query string with from/to when searchParams provide both', async () => {
      // Arrange
      apiMock.parseApiResponse.mockResolvedValue({ success: true, data: makeDistributions() });

      // Act
      render(await renderPage({ searchParams: { from: '2026-01-01', to: '2026-03-31' } }));

      // Assert: the page built a query string and forwarded it to ExportButtons
      const btn = screen.getByTestId('export-buttons');
      expect(btn).toHaveAttribute('data-query', '?from=2026-01-01&to=2026-03-31');
    });

    it('includes tagIds in the query string when provided', async () => {
      // Arrange
      apiMock.parseApiResponse.mockResolvedValue({ success: true, data: makeDistributions() });

      // Act
      render(await renderPage({ searchParams: { tagIds: 'tag-1,tag-2' } }));

      // Assert: tagIds passed through the buildQuery function into the child
      const btn = screen.getByTestId('export-buttons');
      expect(btn).toHaveAttribute('data-query', '?tagIds=tag-1%2Ctag-2');
    });

    it('uses default date inputs when searchParams are absent', async () => {
      // Arrange: no from/to in searchParams
      apiMock.parseApiResponse.mockResolvedValue({ success: true, data: makeDistributions() });

      // Act
      render(await renderPage({ searchParams: {} }));

      // Assert: the filters passed to AnalyticsView use the mocked defaults
      const view = screen.getByTestId('analytics-view');
      expect(view).toHaveAttribute('data-filter-from', '2026-05-13');
      expect(view).toHaveAttribute('data-filter-to', '2026-06-12');
    });

    it('uses searchParams date values as filters when provided', async () => {
      // Arrange
      apiMock.parseApiResponse.mockResolvedValue({ success: true, data: makeDistributions() });

      // Act
      render(await renderPage({ searchParams: { from: '2026-01-01', to: '2026-01-31' } }));

      // Assert: filters.from/to come from the searchParams, not the defaults
      const view = screen.getByTestId('analytics-view');
      expect(view).toHaveAttribute('data-filter-from', '2026-01-01');
      expect(view).toHaveAttribute('data-filter-to', '2026-01-31');
    });

    it('parses tagIds from searchParams into a string array on the filters object', async () => {
      // Arrange
      apiMock.parseApiResponse.mockResolvedValue({ success: true, data: makeDistributions() });

      // Act
      render(await renderPage({ searchParams: { tagIds: 'tag-1,tag-2' } }));

      // Assert: the page split the comma-separated tagIds and passed the array to AnalyticsView
      const view = screen.getByTestId('analytics-view');
      expect(view).toHaveAttribute('data-filter-tag-ids', 'tag-1,tag-2');
    });

    it('produces an empty tagIds array when tagIds searchParam is absent', async () => {
      // Arrange
      apiMock.parseApiResponse.mockResolvedValue({ success: true, data: makeDistributions() });

      // Act
      render(await renderPage({ searchParams: {} }));

      // Assert: no tagIds → empty array passed to child
      const view = screen.getByTestId('analytics-view');
      expect(view).toHaveAttribute('data-filter-tag-ids', '');
    });
  });

  describe('graceful degradation on failed sub-fetches', () => {
    it('renders with has-distributions=false and logs when distributions fetch returns !ok', async () => {
      // Arrange: distributions endpoint returns !ok; funnel, cost, and safeguarding succeed.
      // Keyed on URL so the order of the Promise.all does not affect which fixture each slot gets.
      apiMock.serverFetch.mockImplementation(async (url: string) =>
        url.includes('/distributions') ? { ok: false } : { ok: true, _url: url }
      );

      // Act
      render(await renderPage());

      // Assert: the page short-circuits on !ok and passes null for distributions.
      const view = screen.getByTestId('analytics-view');
      expect(view).toHaveAttribute('data-has-distributions', 'false');
      // The other three endpoints succeeded — their slots are non-null.
      expect(view).toHaveAttribute('data-has-funnel', 'true');
      expect(view).toHaveAttribute('data-has-cost', 'true');
    });

    it('renders with has-funnel=false when funnel parseApiResponse returns success:false', async () => {
      // Arrange: all fetches return ok, but the funnel body carries success:false.
      // parseApiResponse is keyed on URL so call order is irrelevant.
      apiMock.parseApiResponse.mockImplementation(async (res: { ok: boolean; _url?: string }) => {
        const url = (res as { _url?: string })._url ?? '';
        if (url.includes('/funnel'))
          return { success: false, error: { code: 'SERVER_ERROR', message: '' } };
        if (url.includes('/distributions')) return { success: true, data: makeDistributions() };
        if (url.includes('/cost')) return { success: true, data: makeCost() };
        if (url.includes('/safeguarding')) return { success: true, data: makeSafeguarding() };
        return { success: true, data: makeDistributions() };
      });

      // Act
      render(await renderPage());

      // Assert: the page passes null for funnel when body.success is false.
      const view = screen.getByTestId('analytics-view');
      expect(view).toHaveAttribute('data-has-funnel', 'false');
    });

    it('renders with has-cost=false and logs when cost fetch throws', async () => {
      // Arrange: cost endpoint throws; distributions, funnel, and safeguarding succeed.
      // Keyed on URL so it does not matter which position cost occupies in Promise.all.
      apiMock.serverFetch.mockImplementation(async (url: string) => {
        if (url.includes('/cost')) throw new Error('network down');
        return { ok: true, _url: url };
      });
      // parseApiResponse uses the global URL-keyed implementation for the three that succeed.

      // Act
      render(await renderPage());

      // Assert: cost is null, the specific error message is logged.
      const view = screen.getByTestId('analytics-view');
      expect(view).toHaveAttribute('data-has-cost', 'false');
      expect(loggerMock.logger.error).toHaveBeenCalledWith(
        'analytics tab: cost fetch failed',
        expect.any(Error)
      );
    });

    it('renders with all four null and logs a distinct error per endpoint when all fetches throw', async () => {
      // Arrange: every serverFetch rejects.
      apiMock.serverFetch.mockRejectedValue(new Error('network down'));

      // Act
      render(await renderPage());

      // Assert: all data props are null.
      const view = screen.getByTestId('analytics-view');
      expect(view).toHaveAttribute('data-has-distributions', 'false');
      expect(view).toHaveAttribute('data-has-funnel', 'false');
      expect(view).toHaveAttribute('data-has-cost', 'false');
      // Each endpoint's catch block logs its own distinct message — assert each one so
      // a rename or removal is caught regardless of how many endpoints there are.
      expect(loggerMock.logger.error).toHaveBeenCalledWith(
        'analytics tab: distributions fetch failed',
        expect.any(Error)
      );
      expect(loggerMock.logger.error).toHaveBeenCalledWith(
        'analytics tab: funnel fetch failed',
        expect.any(Error)
      );
      expect(loggerMock.logger.error).toHaveBeenCalledWith(
        'analytics tab: cost fetch failed',
        expect.any(Error)
      );
      expect(loggerMock.logger.error).toHaveBeenCalledWith(
        'analytics tab: safeguarding fetch failed',
        expect.any(Error)
      );
    });

    it('does not call parseApiResponse for a fetch that returns !ok', async () => {
      // Arrange
      apiMock.serverFetch.mockResolvedValue({ ok: false });

      // Act
      render(await renderPage());

      // Assert: the !res.ok guard returns early — parseApiResponse must not run
      expect(apiMock.parseApiResponse).not.toHaveBeenCalled();
    });
  });
});
