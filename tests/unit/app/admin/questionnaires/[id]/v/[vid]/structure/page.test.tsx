/**
 * Structure tab page (`/admin/questionnaires/[id]/v/[vid]/structure`) tests.
 *
 * The page is an async Server Component that:
 *  - fetches the questionnaire detail and the version graph in parallel
 *  - calls notFound() when the detail is null or the vid is not in the version list
 *  - renders VersionEditor when ?edit=1 and graph is non-null
 *  - renders VersionGraph when not editing and the graph is present
 *  - renders a "Could not load" message when the graph is null
 *  - shows ReingestDialog only for draft versions
 *  - shows an Edit/Done toggle button based on edit mode
 *  - displays section/question counts from the selected version
 *  - shows an anonymous-mode badge derived from graph.config.anonymousMode
 *
 * Fetching is mocked at the `workspace-data` boundary. Heavy children
 * (VersionEditor, VersionGraph, ReingestDialog) are stubbed to identifiable markers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import type {
  QuestionnaireDetail,
  QuestionnaireVersionSummary,
  VersionGraphView,
} from '@/lib/app/questionnaire/views';
import { DEFAULT_QUESTIONNAIRE_CONFIG } from '@/lib/app/questionnaire/types';

// ─── Navigation mock ──────────────────────────────────────────────────────────

const { mockNotFound } = vi.hoisted(() => ({
  mockNotFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('next/navigation', () => ({
  notFound: mockNotFound,
  redirect: vi.fn(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

// ─── Workspace-data mock ──────────────────────────────────────────────────────

const workspaceDataMock = vi.hoisted(() => ({
  getQuestionnaireDetailCached: vi.fn<() => Promise<QuestionnaireDetail | null>>(),
  getVersionGraphCached: vi.fn<() => Promise<VersionGraphView | null>>(),
  getVersionDataSlotCountCached: vi.fn<() => Promise<number>>(),
  getEvaluationAddQuestionSeed: vi.fn(),
}));

vi.mock('@/lib/app/questionnaire/workspace-data', () => workspaceDataMock);

// ─── Logger mock ──────────────────────────────────────────────────────────────

const loggerMock = vi.hoisted(() => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/logging', () => loggerMock);

// ─── Stub heavy children to identifiable markers ──────────────────────────────

vi.mock('@/components/admin/questionnaires/version-editor', () => ({
  VersionEditor: (props: { questionnaireId: string; version: VersionGraphView }) => (
    <div
      data-testid="version-editor"
      data-qid={props.questionnaireId}
      data-vid={props.version.id}
    />
  ),
}));

vi.mock('@/components/admin/questionnaires/version-graph', () => ({
  VersionGraph: (props: { graph: VersionGraphView }) => (
    <div data-testid="version-graph" data-vid={props.graph.id} />
  ),
}));

vi.mock('@/components/admin/questionnaires/reingest-dialog', () => ({
  ReingestDialog: (props: {
    questionnaireId: string;
    versionId: string;
    versionNumber: number;
  }) => (
    <div
      data-testid="reingest-dialog"
      data-qid={props.questionnaireId}
      data-vid={props.versionId}
      data-version-number={String(props.versionNumber)}
    />
  ),
}));

// ─── Factories ────────────────────────────────────────────────────────────────

function makeVersion(over: Partial<QuestionnaireVersionSummary> = {}): QuestionnaireVersionSummary {
  return {
    id: 'ver-1',
    versionNumber: 1,
    status: 'draft',
    goal: 'Understand the prospect',
    audience: null,
    sectionCount: 3,
    questionCount: 7,
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
    archivedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    versions: [makeVersion()],
    ...over,
  };
}

function makeGraph(
  over: Partial<VersionGraphView> & {
    anonymousMode?: boolean;
    accessMode?: 'invitation_only' | 'public' | 'both';
  } = {}
): VersionGraphView {
  const { anonymousMode = false, accessMode = 'invitation_only', ...rest } = over;
  return {
    id: 'ver-1',
    questionnaireId: 'qn-1',
    versionNumber: 1,
    status: 'draft',
    goal: 'Understand the prospect',
    audience: null,
    goalProvenance: null,
    audienceProvenance: null,
    sections: [],
    tags: [],
    config: {
      ...DEFAULT_QUESTIONNAIRE_CONFIG,
      saved: true,
      anonymousMode,
      accessMode,
    },
    ...rest,
  };
}

// ─── Page import ──────────────────────────────────────────────────────────────

import StructureTab from '@/app/admin/questionnaires/[id]/v/[vid]/structure/page';

function renderPage(opts: { id?: string; vid?: string; edit?: string } = {}) {
  return StructureTab({
    params: Promise.resolve({ id: opts.id ?? 'qn-1', vid: opts.vid ?? 'ver-1' }),
    searchParams: Promise.resolve({ edit: opts.edit }),
  });
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue(makeDetail());
  workspaceDataMock.getVersionGraphCached.mockResolvedValue(makeGraph());
  workspaceDataMock.getVersionDataSlotCountCached.mockResolvedValue(0);
  workspaceDataMock.getEvaluationAddQuestionSeed.mockResolvedValue(null);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('StructureTab', () => {
  describe('data gating', () => {
    it('calls notFound when the detail fetch returns null', async () => {
      // Arrange
      workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue(null);

      // Act + Assert
      await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
    });

    it('calls notFound when the vid is not in the versions list', async () => {
      // Arrange: detail has a different version id than requested
      workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue(
        makeDetail({ versions: [makeVersion({ id: 'ver-other' })] })
      );

      // Act + Assert
      await expect(renderPage({ vid: 'ver-1' })).rejects.toThrow('NEXT_NOT_FOUND');
    });
  });

  describe('read-only mode (no ?edit=1)', () => {
    it('renders the VersionGraph when the graph is non-null', async () => {
      // Arrange: default setup — no edit param, graph present
      render(await renderPage());

      // Assert: the read-only component is shown, not the editor
      expect(screen.getByTestId('version-graph')).toBeInTheDocument();
      expect(screen.queryByTestId('version-editor')).not.toBeInTheDocument();
    });

    it('passes the correct version id to VersionGraph', async () => {
      // Arrange
      workspaceDataMock.getVersionGraphCached.mockResolvedValue(makeGraph({ id: 'ver-1' }));
      render(await renderPage({ vid: 'ver-1' }));

      // Assert: VersionGraph receives the graph whose id matches the fetched graph
      expect(screen.getByTestId('version-graph')).toHaveAttribute('data-vid', 'ver-1');
    });

    it('renders the "Could not load" message when the graph is null', async () => {
      // Arrange
      workspaceDataMock.getVersionGraphCached.mockResolvedValue(null);
      render(await renderPage());

      // Assert: fallback message rendered, neither component shown
      // Note: the source uses a curly apostrophe (’) — match by regex to be encoding-safe.
      expect(screen.getByText(/Could not load this version.s structure\./)).toBeInTheDocument();
      expect(screen.queryByTestId('version-graph')).not.toBeInTheDocument();
      expect(screen.queryByTestId('version-editor')).not.toBeInTheDocument();
    });

    it('surfaces the data-slot count in the header', async () => {
      workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue(
        makeDetail({ versions: [makeVersion({ dataSlotCount: 3 })] })
      );

      render(await renderPage());

      expect(screen.getByText(/3 data slots/)).toBeInTheDocument();
    });
  });

  describe('edit mode (?edit=1)', () => {
    it('renders VersionEditor instead of VersionGraph when ?edit=1 and graph is non-null', async () => {
      // Arrange
      render(await renderPage({ edit: '1' }));

      // Assert: editor is active, read-only graph is hidden
      expect(screen.getByTestId('version-editor')).toBeInTheDocument();
      expect(screen.queryByTestId('version-graph')).not.toBeInTheDocument();
    });

    it('passes the correct questionnaireId and versionId to VersionEditor', async () => {
      // Arrange
      workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue(
        makeDetail({ id: 'qn-42', versions: [makeVersion({ id: 'ver-99' })] })
      );
      workspaceDataMock.getVersionGraphCached.mockResolvedValue(makeGraph({ id: 'ver-99' }));
      render(await renderPage({ id: 'qn-42', vid: 'ver-99', edit: '1' }));

      // Assert: the editor component received both ids from the page's route params
      const editor = screen.getByTestId('version-editor');
      expect(editor).toHaveAttribute('data-qid', 'qn-42');
      expect(editor).toHaveAttribute('data-vid', 'ver-99');
    });

    it('falls back to read-only VersionGraph when ?edit=1 but graph is null', async () => {
      // Arrange: edit requested but no graph available — editing is only active when
      // `edit === '1' && graph !== null`, so the page should show neither the editor
      // nor the could-not-load fallback — it shows the fallback message
      workspaceDataMock.getVersionGraphCached.mockResolvedValue(null);
      render(await renderPage({ edit: '1' }));

      // Assert: editor cannot be activated without a graph; fallback message shown
      expect(screen.queryByTestId('version-editor')).not.toBeInTheDocument();
      // Note: curly apostrophe in source — match by regex.
      expect(screen.getByText(/Could not load this version.s structure\./)).toBeInTheDocument();
    });
  });

  describe('draft-only affordances — ReingestDialog', () => {
    it('renders ReingestDialog for a draft version', async () => {
      // Arrange: version is draft (default)
      render(await renderPage());

      // Assert: re-ingest action present
      expect(screen.getByTestId('reingest-dialog')).toBeInTheDocument();
    });

    it('passes the correct ids and versionNumber to ReingestDialog', async () => {
      // Arrange
      workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue(
        makeDetail({
          id: 'qn-10',
          versions: [makeVersion({ id: 'ver-3', versionNumber: 3, status: 'draft' })],
        })
      );
      render(await renderPage({ id: 'qn-10', vid: 'ver-3' }));

      // Assert: reingest dialog receives the correct props from the page
      const dialog = screen.getByTestId('reingest-dialog');
      expect(dialog).toHaveAttribute('data-qid', 'qn-10');
      expect(dialog).toHaveAttribute('data-vid', 'ver-3');
      expect(dialog).toHaveAttribute('data-version-number', '3');
    });

    it('does not render ReingestDialog for a launched version', async () => {
      // Arrange: re-ingest is a draft-only editorial operation
      workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue(
        makeDetail({ versions: [makeVersion({ id: 'ver-1', status: 'launched' })] })
      );
      render(await renderPage());

      // Assert: re-ingest affordance absent for launched versions
      expect(screen.queryByTestId('reingest-dialog')).not.toBeInTheDocument();
    });

    it('does not render ReingestDialog for an archived version', async () => {
      // Arrange
      workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue(
        makeDetail({ versions: [makeVersion({ id: 'ver-1', status: 'archived' })] })
      );
      render(await renderPage());

      // Assert
      expect(screen.queryByTestId('reingest-dialog')).not.toBeInTheDocument();
    });
  });

  describe('section / question count display', () => {
    it('renders the correct section and question counts from the selected version', async () => {
      // Arrange
      workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue(
        makeDetail({
          versions: [makeVersion({ id: 'ver-1', sectionCount: 4, questionCount: 12 })],
        })
      );
      render(await renderPage());

      // Assert: counts are derived from the selected version summary, not the graph
      expect(screen.getByText(/4 sections/)).toBeInTheDocument();
      expect(screen.getByText(/12 questions/)).toBeInTheDocument();
    });

    it('uses singular "section" and "question" when counts are 1', async () => {
      // Arrange
      workspaceDataMock.getQuestionnaireDetailCached.mockResolvedValue(
        makeDetail({
          versions: [makeVersion({ id: 'ver-1', sectionCount: 1, questionCount: 1 })],
        })
      );
      render(await renderPage());

      // Assert: singular form applied correctly
      const countText = screen.getByText(/1 section · 1 question/);
      expect(countText).toBeInTheDocument();
    });
  });

  describe('access + identity badges', () => {
    it('shows the "Anonymous" identity badge when anonymousMode is true', async () => {
      workspaceDataMock.getVersionGraphCached.mockResolvedValue(makeGraph({ anonymousMode: true }));
      render(await renderPage());

      expect(screen.getByText('Anonymous')).toBeInTheDocument();
      expect(screen.queryByText('Identified')).not.toBeInTheDocument();
    });

    it('shows the "Identified" identity badge when anonymousMode is false', async () => {
      workspaceDataMock.getVersionGraphCached.mockResolvedValue(
        makeGraph({ anonymousMode: false })
      );
      render(await renderPage());

      expect(screen.getByText('Identified')).toBeInTheDocument();
      expect(screen.queryByText('Anonymous')).not.toBeInTheDocument();
    });

    it('shows the access-mode badge independently of identity', async () => {
      workspaceDataMock.getVersionGraphCached.mockResolvedValue(
        makeGraph({ accessMode: 'public', anonymousMode: false })
      );
      render(await renderPage());

      // Access axis and identity axis are orthogonal: a public, identified questionnaire.
      expect(screen.getByText('Public link')).toBeInTheDocument();
      expect(screen.getByText('Identified')).toBeInTheDocument();
    });

    it('renders no access/identity badges when the graph is null', async () => {
      workspaceDataMock.getVersionGraphCached.mockResolvedValue(null);
      render(await renderPage());

      expect(screen.queryByText('Anonymous')).not.toBeInTheDocument();
      expect(screen.queryByText('Identified')).not.toBeInTheDocument();
      expect(screen.queryByText('Invitation only')).not.toBeInTheDocument();
    });
  });

  describe('Edit / Done toggle button', () => {
    it('renders an "Edit" link when not in edit mode and graph is present', async () => {
      // Arrange: read-only mode
      render(await renderPage());

      // Assert: the button links to the edit URL
      const editLink = screen.getByRole('link', { name: 'Edit' });
      expect(editLink).toBeInTheDocument();
      expect(editLink).toHaveAttribute(
        'href',
        '/admin/questionnaires/qn-1/v/ver-1/structure?edit=1'
      );
    });

    it('renders a "Done" link when in edit mode and graph is present', async () => {
      // Arrange: edit mode active
      render(await renderPage({ edit: '1' }));

      // Assert: the button links back to the read-only URL (no ?edit=1)
      const doneLink = screen.getByRole('link', { name: 'Done' });
      expect(doneLink).toBeInTheDocument();
      expect(doneLink).toHaveAttribute('href', '/admin/questionnaires/qn-1/v/ver-1/structure');
    });

    it('does not render the Edit/Done toggle when the graph is null', async () => {
      // Arrange
      workspaceDataMock.getVersionGraphCached.mockResolvedValue(null);
      render(await renderPage());

      // Assert: the toggle requires a loaded graph to be shown
      expect(screen.queryByRole('link', { name: 'Edit' })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Done' })).not.toBeInTheDocument();
    });
  });
});
