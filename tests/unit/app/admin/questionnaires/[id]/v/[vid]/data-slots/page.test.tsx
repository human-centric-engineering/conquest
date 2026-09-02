// @vitest-environment happy-dom

/**
 * Data Slots tab page (`/admin/questionnaires/[id]/v/[vid]/data-slots`) tests.
 *
 * The page is an async Server Component that:
 *  - fetches the version graph via getVersionGraphCached and data slots via serverFetch
 *  - renders a "no questions" message when the graph has no questions
 *  - renders DataSlotsReview when questions are present
 *
 * Fetching is mocked at the `server-fetch` + `workspace-data` boundaries.
 * The heavy DataSlotsReview child is stubbed to an identifiable marker.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import type { VersionGraphView } from '@/lib/app/questionnaire/views';
import type { DataSlotView, DataSlotDraftView } from '@/lib/app/questionnaire/data-slots';
import { DEFAULT_QUESTIONNAIRE_CONFIG } from '@/lib/app/questionnaire/types';
import { EMPTY_TOPICS_PAYLOAD } from '@/lib/app/questionnaire/scope/views';
import type { TopicsPayload } from '@/lib/app/questionnaire/scope/views';
import { DEFAULT_CONDITIONAL_TOPICS_SETTINGS } from '@/lib/app/questionnaire/scope/types';

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

// ─── workspace-data mock ──────────────────────────────────────────────────────
//
// BOTH loaders, because this page reads both: the graph for its questions, and the topics payload
// to decide whether saving data slots should point the admin back at the Routing Analyst (hard
// rules only become possible once data slots exist). A mock missing one throws at import.

const workspaceDataMock = vi.hoisted(() => ({
  getVersionGraphCached: vi.fn<() => Promise<VersionGraphView | null>>(),
  getVersionTopicsCached: vi.fn<() => Promise<TopicsPayload>>(),
}));
vi.mock('@/lib/app/questionnaire/workspace-data', () => workspaceDataMock);

// ─── server-fetch mock (for the slots sub-fetch) ──────────────────────────────

interface ApiData {
  slots: { slots: DataSlotView[]; draft: DataSlotDraftView | null } | null;
}
const apiData: ApiData = { slots: null };

const apiMock = vi.hoisted(() => ({
  serverFetch: vi.fn(),
  parseApiResponse: vi.fn(),
}));

vi.mock('@/lib/api/server-fetch', () => apiMock);

const loggerMock = vi.hoisted(() => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/logging', () => loggerMock);

// ─── Stub DataSlotEmbeddingStep (rendered whenever slots exist; a client component
//     that calls useRouter, so stub it to keep these server-page tests hook-free) ──

vi.mock('@/components/admin/questionnaires/data-slot-embedding-step', () => ({
  DataSlotEmbeddingStep: () => <div data-testid="data-slot-embedding-step" />,
}));

// ─── Stub DataSlotsReview ────────────────────────────────────────────────────

vi.mock('@/components/admin/questionnaires/data-slots-review', () => ({
  DataSlotsReview: (props: {
    questionnaireId: string;
    versionId: string;
    questions: unknown[];
    initialSlots: unknown[];
    initialDraft: unknown;
    conditionalTopicsInUse?: boolean;
  }) => (
    <div
      data-testid="data-slots-review"
      data-qid={props.questionnaireId}
      data-vid={props.versionId}
      data-qcount={String(props.questions.length)}
      data-scount={String(props.initialSlots.length)}
      data-has-draft={String(props.initialDraft !== null)}
      data-conditional-topics-in-use={String(props.conditionalTopicsInUse === true)}
    />
  ),
}));

// ─── Factories ────────────────────────────────────────────────────────────────

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
    fidelity: 0.5,
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
    sections:
      questionCount > 0
        ? [{ id: 'sec-1', ordinal: 0, title: 'General', description: null, questions }]
        : [],
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

// ─── Page import ──────────────────────────────────────────────────────────────

import DataSlotsTab from '@/app/admin/questionnaires/[id]/v/[vid]/data-slots/page';

function renderPage(opts: { id?: string; vid?: string } = {}) {
  return DataSlotsTab({
    params: Promise.resolve({ id: opts.id ?? 'qn-1', vid: opts.vid ?? 'ver-1' }),
  });
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  workspaceDataMock.getVersionGraphCached.mockResolvedValue(makeGraph(3));
  // The quiet default: no conditional topics anywhere, so the page computes
  // `conditionalTopicsInUse: false` and the analyst nudge stays off.
  workspaceDataMock.getVersionTopicsCached.mockResolvedValue({
    ...EMPTY_TOPICS_PAYLOAD,
    settings: DEFAULT_CONDITIONAL_TOPICS_SETTINGS,
  });
  apiData.slots = { slots: [], draft: null };
  apiMock.serverFetch.mockImplementation(async (url: string) => ({ ok: true, _url: url }));
  apiMock.parseApiResponse.mockImplementation(async () =>
    apiData.slots ? { success: true, data: apiData.slots } : { success: false, error: {} }
  );
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DataSlotsTab', () => {
  describe('no-questions state', () => {
    it('renders a "no questions" message when the graph has no sections/questions', async () => {
      workspaceDataMock.getVersionGraphCached.mockResolvedValue(makeGraph(0));
      render(await renderPage());
      expect(
        screen.getByText('This version has no questions to abstract over yet.')
      ).toBeInTheDocument();
      expect(screen.queryByTestId('data-slots-review')).not.toBeInTheDocument();
    });

    it('renders a "no questions" message when the graph fetch fails (null)', async () => {
      workspaceDataMock.getVersionGraphCached.mockResolvedValue(null);
      render(await renderPage());
      expect(
        screen.getByText('This version has no questions to abstract over yet.')
      ).toBeInTheDocument();
    });
  });

  describe('DataSlotsReview rendering', () => {
    it('renders DataSlotsReview with the correct questionnaire and version IDs', async () => {
      render(await renderPage({ id: 'qn-42', vid: 'ver-99' }));
      const review = screen.getByTestId('data-slots-review');
      expect(review).toHaveAttribute('data-qid', 'qn-42');
      expect(review).toHaveAttribute('data-vid', 'ver-99');
    });

    it('passes the flattened question list to the review component', async () => {
      workspaceDataMock.getVersionGraphCached.mockResolvedValue(makeGraph(3));
      render(await renderPage());
      const review = screen.getByTestId('data-slots-review');
      expect(review).toHaveAttribute('data-qcount', '3');
    });

    it('passes initialSlots to the review component', async () => {
      apiData.slots = { slots: makeSlots(2), draft: null };
      render(await renderPage());
      const review = screen.getByTestId('data-slots-review');
      expect(review).toHaveAttribute('data-scount', '2');
    });

    it('passes initialDraft=null when no draft exists', async () => {
      apiData.slots = { slots: [], draft: null };
      render(await renderPage());
      const review = screen.getByTestId('data-slots-review');
      expect(review).toHaveAttribute('data-has-draft', 'false');
    });

    it('passes the draft object when a draft exists', async () => {
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
    it('renders with empty slots and no draft when parseApiResponse returns success:false', async () => {
      apiData.slots = null;
      render(await renderPage());
      const review = screen.getByTestId('data-slots-review');
      expect(review).toHaveAttribute('data-scount', '0');
      expect(review).toHaveAttribute('data-has-draft', 'false');
    });

    it('renders with empty slots when serverFetch responds !ok (no parse attempted)', async () => {
      apiMock.serverFetch.mockResolvedValueOnce({ ok: false, _url: 'x' });
      render(await renderPage());
      const review = screen.getByTestId('data-slots-review');
      expect(review).toHaveAttribute('data-scount', '0');
      expect(review).toHaveAttribute('data-has-draft', 'false');
      // The !res.ok guard returns early — parseApiResponse must not run.
      expect(apiMock.parseApiResponse).not.toHaveBeenCalled();
    });

    it('logs and renders empty slots when serverFetch throws (catch path)', async () => {
      apiMock.serverFetch.mockRejectedValueOnce(new Error('network down'));
      render(await renderPage());
      const review = screen.getByTestId('data-slots-review');
      expect(review).toHaveAttribute('data-scount', '0');
      expect(review).toHaveAttribute('data-has-draft', 'false');
      expect(loggerMock.logger.error).toHaveBeenCalledWith(
        'data slots tab: slots fetch failed',
        expect.any(Error)
      );
    });
  });

  // ── conditionalTopicsInUse ─────────────────────────────────────────────────
  //
  // Saving data slots is the moment hard rules become possible (a rule decides from one data slot,
  // so with none the Routing Analyst is told to propose none), and the analyst does not re-run
  // itself. The page therefore tells `DataSlotsReview` whether pointing back at the analyst is
  // signal or noise. Four independent facts can each make it signal; none of them was covered when
  // this flag was added, which is how a missing `getVersionTopicsCached` mock reached CI.

  describe('conditionalTopicsInUse', () => {
    const withTopics = (over: Partial<TopicsPayload>): TopicsPayload => ({
      ...EMPTY_TOPICS_PAYLOAD,
      settings: DEFAULT_CONDITIONAL_TOPICS_SETTINGS,
      ...over,
    });

    async function flagFor(payload: TopicsPayload): Promise<string | null> {
      workspaceDataMock.getVersionTopicsCached.mockResolvedValue(payload);
      render(await renderPage());
      return screen.getByTestId('data-slots-review').getAttribute('data-conditional-topics-in-use');
    }

    it('is false when nothing about the version involves conditional topics', async () => {
      expect(await flagFor(withTopics({}))).toBe('false');
    });

    it('is true when the feature is switched on', async () => {
      const payload = withTopics({
        settings: { ...DEFAULT_CONDITIONAL_TOPICS_SETTINGS, enabled: true },
      });
      expect(await flagFor(payload)).toBe('true');
    });

    it('is true when a conditional topic already exists, even with the feature off', async () => {
      const payload = withTopics({
        topics: [
          {
            id: 't1',
            key: 'partner_channel',
            label: 'Partner channel',
            description: null,
            phase: 'conditional',
            criteria: 'They sell through partners',
            depth: 'full',
            members: { dataSlotKeys: [], questionKeys: [] },
            ordinal: 0,
            source: 'analyst',
            trigger: null,
          },
        ],
      });
      expect(await flagFor(payload)).toBe('true');
    });

    it('is false when the only topics are always-run ones', async () => {
      // A `core` topic is not conditional routing, so it must not trigger the nudge.
      const payload = withTopics({
        topics: [
          {
            id: 't1',
            key: 'spine',
            label: 'Spine',
            description: null,
            phase: 'core',
            criteria: null,
            depth: 'full',
            members: { dataSlotKeys: [], questionKeys: [] },
            ordinal: 0,
            source: 'manual',
            trigger: null,
          },
        ],
      });
      expect(await flagFor(payload)).toBe('false');
    });

    it('is true when an unreviewed analyst proposal is waiting', async () => {
      const payload = withTopics({
        draft: {
          v: 1,
          topics: [],
          gaps: [],
          summary: 's',
          fromDocument: true,
          generatedAt: '2026-08-31T00:00:00.000Z',
        },
      });
      expect(await flagFor(payload)).toBe('true');
    });

    it('is true when the ingest candidacy check said the document describes routing', async () => {
      const payload = withTopics({
        candidacy: { isCandidate: true, confidence: 0.9, summary: 'Routing table present' },
      });
      expect(await flagFor(payload)).toBe('true');
    });

    it('is false when candidacy explicitly said no', async () => {
      const payload = withTopics({
        candidacy: { isCandidate: false, confidence: 0.8, summary: 'No routing instructions' },
      });
      expect(await flagFor(payload)).toBe('false');
    });
  });
});
