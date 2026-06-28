/**
 * Settings tab page (`/admin/questionnaires/[id]/v/[vid]/settings`) tests.
 *
 * The page is an async Server Component that:
 *  - gates on isQuestionnairesEnabled() — calls notFound() when off
 *  - fetches the questionnaire detail via getQuestionnaireDetailCached
 *  - calls notFound() when the detail is null
 *  - fetches active demo clients via serverFetch (DEMO-ONLY)
 *  - filters to isActive clients and maps to AttributedDemoClient shape before passing to children
 *  - renders DemoClientAssign with the current attribution and the filtered options list
 *  - renders CloneForClientDialog with the same filtered options list
 *  - degrades gracefully on demo-clients fetch failures (network error, !ok, success:false)
 *
 * Fetching is mocked at the `server-fetch`, `feature-flag`, and `workspace-data` boundaries.
 * DemoClientAssign and CloneForClientDialog are stubbed to identifiable markers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import type {
  QuestionnaireDetail,
  QuestionnaireVersionSummary,
  VersionGraphView,
} from '@/lib/app/questionnaire/views';
import {
  DEFAULT_RESPONDENT_REPORT_SETTINGS,
  DEFAULT_COHORT_REPORT_SETTINGS,
  DEFAULT_INTRO_SETTINGS,
  DEFAULT_TONE_SETTINGS,
} from '@/lib/app/questionnaire/types';
import type { AttributedDemoClient, DemoClientView } from '@/lib/app/questionnaire/demo-clients';
import type { QuestionnaireWorkspaceFlags } from '@/lib/app/questionnaire/workspace-data';

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
}));
vi.mock('@/lib/app/questionnaire/feature-flag', () => flagMock);

// ─── workspace-data mock ──────────────────────────────────────────────────────

const workspaceDataMock = vi.hoisted(() => ({
  getQuestionnaireDetailCached: vi.fn<() => Promise<QuestionnaireDetail | null>>(),
  getVersionGraphCached: vi.fn<() => Promise<VersionGraphView | null>>(),
  resolveQuestionnaireWorkspaceFlags: vi.fn<() => Promise<QuestionnaireWorkspaceFlags>>(),
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

// ─── Stub heavy children to identifiable markers ──────────────────────────────

vi.mock('@/components/admin/questionnaires/rename-questionnaire', () => ({
  RenameQuestionnaire: (props: { questionnaireId: string; currentTitle: string }) => (
    <div
      data-testid="rename-questionnaire"
      data-qid={props.questionnaireId}
      data-title={props.currentTitle}
    />
  ),
}));

vi.mock('@/components/admin/demo-clients/demo-client-assign', () => ({
  DemoClientAssign: (props: {
    questionnaireId: string;
    current: AttributedDemoClient | null;
    options: AttributedDemoClient[];
  }) => (
    <div
      data-testid="demo-client-assign"
      data-qid={props.questionnaireId}
      data-current-id={props.current?.id ?? 'none'}
      data-option-count={String(props.options.length)}
    />
  ),
}));

vi.mock('@/components/admin/questionnaires/clone-for-client-dialog', () => ({
  CloneForClientDialog: (props: { questionnaireId: string; options: AttributedDemoClient[] }) => (
    <div
      data-testid="clone-for-client-dialog"
      data-qid={props.questionnaireId}
      data-option-count={String(props.options.length)}
    />
  ),
}));

vi.mock('@/components/admin/questionnaires/version-settings-panel', () => ({
  VersionSettingsPanel: (props: {
    questionnaireId: string;
    graph: VersionGraphView;
    adaptiveEnabled: boolean;
  }) => (
    <div
      data-testid="version-settings-panel"
      data-qid={props.questionnaireId}
      data-vid={props.graph.id}
      data-goal={props.graph.goal ?? ''}
      data-adaptive={String(props.adaptiveEnabled)}
    />
  ),
}));

// ─── Factories ────────────────────────────────────────────────────────────────

function makeVersion(over: Partial<QuestionnaireVersionSummary> = {}): QuestionnaireVersionSummary {
  return {
    id: 'ver-1',
    versionNumber: 1,
    status: 'draft',
    goal: null,
    audience: null,
    sectionCount: 0,
    questionCount: 0,
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
    status: 'draft',
    demoClient: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    versions: [makeVersion()],
    ...over,
  };
}

function makeGraph(over: Partial<VersionGraphView> = {}): VersionGraphView {
  return {
    id: 'ver-1',
    questionnaireId: 'qn-1',
    versionNumber: 1,
    status: 'launched',
    goal: null,
    audience: null,
    goalProvenance: null,
    audienceProvenance: null,
    sections: [
      {
        id: 'sec-1',
        ordinal: 0,
        title: 'About',
        description: null,
        questions: [],
      },
    ],
    tags: [],
    config: {
      saved: true,
      selectionStrategy: 'sequential',
      minQuestionsAnswered: 0,
      coverageThreshold: 1,
      answerConfidenceFloor: 0.5,
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
      inlineCorrectionEnabled: true,
      reasoningStreamEnabled: true,
      reasoningStreamPlacement: 'overlay',
      reasoningStreamDwellMs: 2000,
      reasoningStreamPerItemMs: 330,
      reasoningStreamPersist: true,
      previewInspectorEnabled: false,
      tone: DEFAULT_TONE_SETTINGS,
      respondentReport: DEFAULT_RESPONDENT_REPORT_SETTINGS,
      cohortReport: DEFAULT_COHORT_REPORT_SETTINGS,
      intro: DEFAULT_INTRO_SETTINGS,
    },
    ...over,
  };
}

function makeFlags(over: Partial<QuestionnaireWorkspaceFlags> = {}): QuestionnaireWorkspaceFlags {
  return {
    adaptive: false,
    adaptiveDataSlots: false,
    dataSlots: false,
    designEval: false,
    respondentReport: false,
    ...over,
  } as QuestionnaireWorkspaceFlags;
}

/** Build a DemoClientView row as the API would return — isActive controls the filter. */
function makeDemoClientApiRow(
  over: Partial<DemoClientView> & { id: string; slug: string; name: string }
): DemoClientView {
  return {
    description: null,
    isActive: true,
    ctaColor: null,
    accentColor: null,
    logoUrl: null,
    welcomeCopy: null,
    surfaceColor: null,
    ctaColorEnd: null,
    logoBackgroundColor: null,
    logoBackgroundEnabled: false,
    questionnaireCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

// ─── Page import ──────────────────────────────────────────────────────────────

import SettingsTab from '@/app/admin/questionnaires/[id]/v/[vid]/settings/page';

function renderPage(opts: { id?: string; vid?: string } = {}) {
  return SettingsTab({
    params: Promise.resolve({ id: opts.id ?? 'qn-1', vid: opts.vid ?? 'ver-1' }),
  });
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  flagMock.isQuestionnairesEnabled.mockResolvedValue(true);
  workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue(makeDetail());
  workspaceDataMock.getVersionGraphCached.mockResolvedValue(makeGraph());
  workspaceDataMock.resolveQuestionnaireWorkspaceFlags.mockResolvedValue(makeFlags());
  apiMock.serverFetch.mockResolvedValue({ ok: true });
  apiMock.parseApiResponse.mockResolvedValue({ success: true, data: [] });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SettingsTab', () => {
  describe('feature-flag gating', () => {
    it('calls notFound when the questionnaires master flag is off', async () => {
      // Arrange
      flagMock.isQuestionnairesEnabled.mockResolvedValue(false);

      // Act + Assert
      await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
    });
  });

  describe('data gating', () => {
    it('calls notFound when the questionnaire detail is null', async () => {
      // Arrange
      workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue(null);

      // Act + Assert
      await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
    });
  });

  describe('DemoClientAssign rendering', () => {
    it('passes the questionnaire id to DemoClientAssign', async () => {
      // Arrange
      workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue(makeDetail({ id: 'qn-77' }));

      // Act
      render(await renderPage({ id: 'qn-77' }));

      // Assert — the page wired up the id from detail, not hardcoded
      expect(screen.getByTestId('demo-client-assign')).toHaveAttribute('data-qid', 'qn-77');
    });

    it('passes the current attribution from the detail (null when unattributed)', async () => {
      // Arrange — detail has no demo client
      workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue(
        makeDetail({ demoClient: null })
      );

      // Act
      render(await renderPage());

      // Assert
      expect(screen.getByTestId('demo-client-assign')).toHaveAttribute('data-current-id', 'none');
    });

    it('passes the current attribution from the detail when set', async () => {
      // Arrange
      const demoClient: AttributedDemoClient = { id: 'dc-5', slug: 'acme', name: 'Acme Demo' };
      workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue(makeDetail({ demoClient }));

      // Act
      render(await renderPage());

      // Assert — the existing attribution flows through unchanged
      expect(screen.getByTestId('demo-client-assign')).toHaveAttribute('data-current-id', 'dc-5');
    });

    it('passes the filtered active-client options to DemoClientAssign', async () => {
      // Arrange — API returns 2 active + 1 inactive; page must filter to active only
      apiMock.parseApiResponse.mockResolvedValue({
        success: true,
        data: [
          makeDemoClientApiRow({ id: 'dc-1', slug: 'alpha', name: 'Alpha', isActive: true }),
          makeDemoClientApiRow({ id: 'dc-2', slug: 'beta', name: 'Beta', isActive: true }),
          makeDemoClientApiRow({ id: 'dc-3', slug: 'gone', name: 'Gone', isActive: false }),
        ],
      });

      // Act
      render(await renderPage());

      // Assert — page filtered out the inactive client; 2 active options passed
      expect(screen.getByTestId('demo-client-assign')).toHaveAttribute('data-option-count', '2');
    });
  });

  describe('CloneForClientDialog rendering', () => {
    it('passes the questionnaire id to CloneForClientDialog', async () => {
      // Arrange
      workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue(makeDetail({ id: 'qn-42' }));

      // Act
      render(await renderPage({ id: 'qn-42' }));

      // Assert
      expect(screen.getByTestId('clone-for-client-dialog')).toHaveAttribute('data-qid', 'qn-42');
    });

    it('passes the same filtered options to CloneForClientDialog as DemoClientAssign', async () => {
      // Arrange — API returns mixed active/inactive rows
      apiMock.parseApiResponse.mockResolvedValue({
        success: true,
        data: [
          makeDemoClientApiRow({ id: 'dc-1', slug: 'alpha', name: 'Alpha', isActive: true }),
          makeDemoClientApiRow({ id: 'dc-2', slug: 'gone', name: 'Gone', isActive: false }),
        ],
      });

      // Act
      render(await renderPage());

      // Assert — both children receive the same 1 active option
      expect(screen.getByTestId('clone-for-client-dialog')).toHaveAttribute(
        'data-option-count',
        '1'
      );
      expect(screen.getByTestId('demo-client-assign')).toHaveAttribute('data-option-count', '1');
    });
  });

  describe('graceful degradation on failed demo-clients fetch', () => {
    it('renders with empty options when serverFetch responds !ok', async () => {
      // Arrange
      apiMock.serverFetch.mockResolvedValueOnce({ ok: false });

      // Act
      render(await renderPage());

      // Assert — page degrades to empty options; parseApiResponse must not run
      expect(screen.getByTestId('demo-client-assign')).toHaveAttribute('data-option-count', '0');
      expect(screen.getByTestId('clone-for-client-dialog')).toHaveAttribute(
        'data-option-count',
        '0'
      );
      expect(apiMock.parseApiResponse).not.toHaveBeenCalled();
    });

    it('renders with empty options when parseApiResponse returns success:false', async () => {
      // Arrange
      apiMock.parseApiResponse.mockResolvedValueOnce({ success: false, error: {} });

      // Act
      render(await renderPage());

      // Assert
      expect(screen.getByTestId('demo-client-assign')).toHaveAttribute('data-option-count', '0');
    });

    it('logs and renders empty options when serverFetch throws (catch path)', async () => {
      // Arrange
      apiMock.serverFetch.mockRejectedValueOnce(new Error('network down'));

      // Act
      render(await renderPage());

      // Assert — page falls back gracefully and logs the error
      expect(screen.getByTestId('demo-client-assign')).toHaveAttribute('data-option-count', '0');
      expect(loggerMock.logger.error).toHaveBeenCalledWith(
        'settings tab: demo clients fetch failed',
        expect.any(Error)
      );
    });
  });

  describe('page section headings', () => {
    it('renders the "Demo client" section heading', async () => {
      render(await renderPage());
      expect(screen.getByText('Demo client')).toBeInTheDocument();
    });

    it('renders the "Clone for another client" section heading', async () => {
      render(await renderPage());
      expect(screen.getByText('Clone for another client')).toBeInTheDocument();
    });
  });

  describe('version settings (run-time config; goal/audience now live on Structure)', () => {
    it('renders the version-settings panel with the graph + adaptive flag', async () => {
      workspaceDataMock.getVersionGraphCached.mockResolvedValue(
        makeGraph({ id: 'ver-9', goal: 'Understand churn' })
      );
      workspaceDataMock.resolveQuestionnaireWorkspaceFlags.mockResolvedValue(
        makeFlags({ adaptive: true })
      );
      render(await renderPage({ id: 'qn-3', vid: 'ver-9' }));

      const panel = screen.getByTestId('version-settings-panel');
      expect(panel).toHaveAttribute('data-qid', 'qn-3');
      expect(panel).toHaveAttribute('data-vid', 'ver-9');
      expect(panel).toHaveAttribute('data-goal', 'Understand churn');
      expect(panel).toHaveAttribute('data-adaptive', 'true');
    });

    it('omits the version-settings panel when the version graph is unavailable', async () => {
      workspaceDataMock.getVersionGraphCached.mockResolvedValue(null);
      render(await renderPage());
      expect(screen.queryByTestId('version-settings-panel')).not.toBeInTheDocument();
      // Demo-client settings still render — a missing graph doesn't break the tab.
      expect(screen.getByTestId('demo-client-assign')).toBeInTheDocument();
    });
  });
});
