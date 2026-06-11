/**
 * Admin Data Slots Page tests.
 *
 * The page is an async Server Component that gates on both `isQuestionnairesEnabled`
 * and `isDataSlotsEnabled`, fetches the questionnaire detail + version graph + data
 * slots via `serverFetch`, and renders a version-selector and `<DataSlotsReview>` (or
 * graceful empty states when no versions / no questions).
 *
 * Following the same mock architecture as the sibling `page.test.tsx` — `serverFetch`
 * returns a Response-like marker carrying its URL; `parseApiResponse` routes off that
 * URL into the per-test `apiData` registry — so the three fetches (detail, graph,
 * slots) are independently controllable without relying on call order.
 *
 * Heavy children are stubbed to identifiable markers so we assert the page's own
 * branching, not their internals.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import DataSlotsPage from '@/app/admin/questionnaires/[id]/data-slots/page';
import type {
  QuestionnaireDetail,
  QuestionnaireVersionSummary,
  VersionGraphView,
} from '@/lib/app/questionnaire/views';
import type { DataSlotView, DataSlotDraftView } from '@/lib/app/questionnaire/data-slots';
import { DEFAULT_QUESTIONNAIRE_CONFIG } from '@/lib/app/questionnaire/types';

// ─── Mocks ──────────────────────────────────────────────────────────────────

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
  isDataSlotsEnabled: vi.fn(),
}));
vi.mock('@/lib/app/questionnaire/feature-flag', () => flagMock);

// `serverFetch` returns a Response-like marker carrying its URL; `parseApiResponse`
// routes off that URL into the per-test `apiData` registry.
interface ApiData {
  detail: QuestionnaireDetail | null;
  graph: VersionGraphView | null;
  slots: { slots: DataSlotView[]; draft: DataSlotDraftView | null } | null;
}
const apiData: ApiData = { detail: null, graph: null, slots: null };

vi.mock('@/lib/api/server-fetch', () => ({
  serverFetch: vi.fn(async (url: string) => ({ ok: true, _url: url })),
  parseApiResponse: vi.fn(async (res: { _url: string }) => {
    const url = res._url;
    if (url.includes('/data-slots')) {
      return apiData.slots ? { success: true, data: apiData.slots } : { success: false, error: {} };
    }
    if (url.includes('/versions/')) {
      return apiData.graph ? { success: true, data: apiData.graph } : { success: false, error: {} };
    }
    return apiData.detail ? { success: true, data: apiData.detail } : { success: false, error: {} };
  }),
}));

// Stub DataSlotsReview to an identifiable marker so we assert the page's branching.
vi.mock('@/components/admin/questionnaires/data-slots-review', () => ({
  DataSlotsReview: (props: {
    questionnaireId: string;
    versionId: string;
    questions: unknown[];
    initialSlots: unknown[];
    initialDraft: unknown;
  }) => (
    <div
      data-testid="data-slots-review"
      data-qid={props.questionnaireId}
      data-vid={props.versionId}
      data-qcount={String(props.questions.length)}
      data-scount={String(props.initialSlots.length)}
      data-has-draft={String(props.initialDraft !== null)}
    />
  ),
}));

// ─── Factories ───────────────────────────────────────────────────────────────

function makeVersion(over: Partial<QuestionnaireVersionSummary> = {}): QuestionnaireVersionSummary {
  return {
    id: 'ver-1',
    versionNumber: 1,
    status: 'draft',
    goal: 'Understand the prospect',
    audience: null,
    sectionCount: 2,
    questionCount: 3,
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
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    versions: [makeVersion()],
    ...over,
  };
}

function makeGraph(questionCount = 3, over: Partial<VersionGraphView> = {}): VersionGraphView {
  const questions = Array.from({ length: questionCount }, (_, i) => ({
    id: `q-${i}`,
    ordinal: i,
    key: `q${i + 1}`,
    prompt: `Question ${i + 1}?`,
    guidelines: null,
    rationale: null,
    type: 'free_text' as const,
    typeConfig: {},
    required: true,
    weight: 1,
    extractionConfidence: null,
    tags: [],
  }));

  return {
    id: 'ver-1',
    questionnaireId: 'qn-1',
    versionNumber: 1,
    status: 'draft',
    goal: 'Understand the prospect',
    audience: null,
    goalProvenance: null,
    audienceProvenance: null,
    sections: [
      {
        id: 'sec-1',
        ordinal: 0,
        title: 'General',
        description: null,
        questions,
      },
    ],
    tags: [],
    config: {
      ...DEFAULT_QUESTIONNAIRE_CONFIG,
      saved: true,
      anonymousMode: true,
    },
    ...over,
  };
}

function makeSlots(count = 1): DataSlotView[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `slot-${i}`,
    key: `slot_key_${i}`,
    name: `Slot ${i}`,
    description: 'A slot.',
    theme: 'Goals',
    ordinal: i,
    weight: 1,
    questionKeys: [`q${i + 1}`],
  }));
}

function renderPage(opts: { id?: string; v?: string } = {}) {
  return DataSlotsPage({
    params: Promise.resolve({ id: opts.id ?? 'qn-1' }),
    searchParams: Promise.resolve({ v: opts.v }),
  });
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  apiData.detail = makeDetail();
  apiData.graph = makeGraph();
  apiData.slots = { slots: [], draft: null };
  flagMock.isQuestionnairesEnabled.mockResolvedValue(true);
  flagMock.isDataSlotsEnabled.mockResolvedValue(true);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DataSlotsPage', () => {
  describe('feature-flag gating', () => {
    it('calls notFound when the questionnaires feature flag is off', async () => {
      flagMock.isQuestionnairesEnabled.mockResolvedValue(false);
      await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
    });

    it('calls notFound when the data-slots feature flag is off', async () => {
      flagMock.isDataSlotsEnabled.mockResolvedValue(false);
      await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
    });

    it('calls notFound when both flags are off', async () => {
      flagMock.isQuestionnairesEnabled.mockResolvedValue(false);
      flagMock.isDataSlotsEnabled.mockResolvedValue(false);
      await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
    });
  });

  describe('data-fetch gating', () => {
    it('calls notFound when the detail fetch returns null', async () => {
      apiData.detail = null;
      await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
    });
  });

  describe('breadcrumb and heading', () => {
    it('renders the questionnaire title as a breadcrumb link', async () => {
      render(await renderPage());
      expect(screen.getByRole('link', { name: 'Prospect Discovery' })).toHaveAttribute(
        'href',
        '/admin/questionnaires/qn-1'
      );
    });

    it('renders the "Data slots" heading', async () => {
      render(await renderPage());
      expect(screen.getByRole('heading', { name: 'Data slots' })).toBeInTheDocument();
    });

    it('renders the Questionnaires breadcrumb link', async () => {
      render(await renderPage());
      expect(screen.getByRole('link', { name: 'Questionnaires' })).toHaveAttribute(
        'href',
        '/admin/questionnaires'
      );
    });
  });

  describe('version selector', () => {
    it('renders a version-tab link for each version', async () => {
      apiData.detail = makeDetail({
        versions: [
          makeVersion({ id: 'ver-1', versionNumber: 1, status: 'draft' }),
          makeVersion({ id: 'ver-2', versionNumber: 2, status: 'launched' }),
        ],
      });
      render(await renderPage());
      expect(screen.getByRole('link', { name: /v1.*draft/i })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /v2.*launched/i })).toBeInTheDocument();
    });

    it('selects the version named by the ?v= search param', async () => {
      apiData.detail = makeDetail({
        versions: [
          makeVersion({ id: 'ver-1', versionNumber: 1 }),
          makeVersion({ id: 'ver-2', versionNumber: 2 }),
        ],
      });
      render(await renderPage({ v: 'ver-2' }));
      // The DataSlotsReview stub carries data-vid so we can check which version was selected
      const review = screen.getByTestId('data-slots-review');
      expect(review).toHaveAttribute('data-vid', 'ver-2');
    });

    it('falls back to the first version when ?v= is absent', async () => {
      apiData.detail = makeDetail({
        versions: [makeVersion({ id: 'ver-1', versionNumber: 1 })],
      });
      render(await renderPage());
      const review = screen.getByTestId('data-slots-review');
      expect(review).toHaveAttribute('data-vid', 'ver-1');
    });
  });

  describe('no-versions state', () => {
    it('renders a "no versions" message and omits the version selector and review', async () => {
      apiData.detail = makeDetail({ versions: [] });
      render(await renderPage());
      expect(screen.getByText('This questionnaire has no versions.')).toBeInTheDocument();
      expect(screen.queryByTestId('data-slots-review')).not.toBeInTheDocument();
    });
  });

  describe('no-questions state', () => {
    it('renders a "no questions" message when the graph has no sections/questions', async () => {
      apiData.graph = makeGraph(0);
      render(await renderPage());
      expect(
        screen.getByText('This version has no questions to abstract over yet.')
      ).toBeInTheDocument();
      expect(screen.queryByTestId('data-slots-review')).not.toBeInTheDocument();
    });
  });

  describe('DataSlotsReview rendering', () => {
    it('passes the questionnaire ID and version ID to the review component', async () => {
      render(await renderPage({ id: 'qn-1' }));
      const review = screen.getByTestId('data-slots-review');
      expect(review).toHaveAttribute('data-qid', 'qn-1');
      expect(review).toHaveAttribute('data-vid', 'ver-1');
    });

    it('passes the flattened question list (key + prompt) to the review component', async () => {
      apiData.graph = makeGraph(3);
      render(await renderPage());
      const review = screen.getByTestId('data-slots-review');
      // Graph has 3 questions → 3 QuestionRef entries
      expect(review).toHaveAttribute('data-qcount', '3');
    });

    it('passes the loaded slots as initialSlots to the review component', async () => {
      apiData.slots = { slots: makeSlots(2), draft: null };
      render(await renderPage());
      const review = screen.getByTestId('data-slots-review');
      expect(review).toHaveAttribute('data-scount', '2');
    });

    it('passes initialDraft=null to the review component when no draft exists', async () => {
      apiData.slots = { slots: [], draft: null };
      render(await renderPage());
      const review = screen.getByTestId('data-slots-review');
      expect(review).toHaveAttribute('data-has-draft', 'false');
    });

    it('passes the draft object to the review component when a draft exists', async () => {
      const draft: DataSlotDraftView = {
        slots: [
          {
            name: 'Timeline',
            description: 'When.',
            theme: 'Urgency',
            questionKeys: ['q1'],
            confidence: 0.9,
          },
        ],
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      apiData.slots = { slots: [], draft };
      render(await renderPage());
      const review = screen.getByTestId('data-slots-review');
      expect(review).toHaveAttribute('data-has-draft', 'true');
    });
  });

  describe('graceful degradation on failed sub-fetches', () => {
    it('renders with empty questions when the graph fetch fails', async () => {
      apiData.graph = null;
      render(await renderPage());
      // No graph → questions is [] → "no questions" message
      expect(
        screen.getByText('This version has no questions to abstract over yet.')
      ).toBeInTheDocument();
    });

    it('renders with empty slots and no draft when the slots fetch fails', async () => {
      apiData.slots = null;
      render(await renderPage());
      // Graph fetch succeeds → questions present → DataSlotsReview renders with empty slots
      const review = screen.getByTestId('data-slots-review');
      expect(review).toHaveAttribute('data-scount', '0');
      expect(review).toHaveAttribute('data-has-draft', 'false');
    });
  });
});
