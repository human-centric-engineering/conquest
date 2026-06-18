/**
 * reconcileChatDataSlotFills — chat-mode gap-filler that keeps the data-slot layer in sync when the
 * extractor answers a mapped question but leaves its PARENT data slot empty (the bug: "badly thought
 * out KPIs" answers `performance_kpis` but its slot `business_execution` stays blank).
 *
 * The mock client stands in for the Prisma client passed via `opts.client`. Assertions pin:
 *  - GAP-FILLING: a slot the extractor already filled this turn is left untouched.
 *  - The synthesised fill leads with the answer's rationale, falls back to the formatted value.
 *  - provenance is `inferred` for one mapped question, `synthesised` for several; confidence = max.
 *  - the reconciliation is logged (an invariant breach worth surfacing).
 *
 * @see app/api/v1/app/questionnaires/_lib/data-slot-fills.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({ prisma: {} }));
vi.mock('@/app/api/v1/app/questionnaires/_lib/authoring-routes', () => ({
  jsonInput: vi.fn((v: unknown) => v),
}));
const loggerMock = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('@/lib/logging', () => ({ logger: loggerMock }));

import { reconcileChatDataSlotFills } from '@/app/api/v1/app/questionnaires/_lib/data-slot-fills';

type Mock = ReturnType<typeof vi.fn>;

interface MappedQuestion {
  id: string;
  key: string;
}
interface AnswerRow {
  questionSlotId: string;
  value: unknown;
  rationale: string | null;
  confidence: number | null;
}

/**
 * Build a mock client. `links` = which data slots each answered question feeds (+ the slot key for
 * logging); `mapped` = the questions each data slot covers; `answers` = the session's current answers;
 * `existingFills` = data slot ids that ALREADY have a fill (the gap-filler skips these). Slots without
 * an existing fill take the upsert create path → returns `fill-<dataSlotId>`.
 */
function makeClient(opts: {
  links: { dataSlotId: string; key: string }[];
  mapped: Record<string, MappedQuestion[]>;
  answers: AnswerRow[];
  existingFills?: string[];
}) {
  const dsqFindMany = vi.fn(async (args: { where: Record<string, unknown> }) => {
    if ('questionSlotId' in args.where) {
      return opts.links.map((l) => ({ dataSlotId: l.dataSlotId, dataSlot: { key: l.key } }));
    }
    const dataSlotId = args.where.dataSlotId as string;
    return (opts.mapped[dataSlotId] ?? []).map((q) => ({ questionSlot: q }));
  });
  const ansFindMany = vi.fn(async (args: { where: { questionSlotId: { in: string[] } } }) => {
    const ids = new Set(args.where.questionSlotId.in);
    return opts.answers.filter((a) => ids.has(a.questionSlotId));
  });
  // The gap-filler's "which candidates already have a fill?" query.
  const fillFindMany = vi.fn(async (args: { where: { dataSlotId: { in: string[] } } }) => {
    const ids = new Set(args.where.dataSlotId.in);
    return (opts.existingFills ?? []).filter((id) => ids.has(id)).map((id) => ({ dataSlotId: id }));
  });
  // upsert's own existence check (only reached for slots with no existing fill → create path).
  const fillFindUnique = vi.fn(async () => null);
  const fillCreate = vi.fn(async (args: { data: { dataSlotId: string } }) => ({
    id: `fill-${args.data.dataSlotId}`,
  }));
  const fillUpdate = vi.fn(async () => ({ id: 'fill-existing' }));

  const client = {
    appDataSlotQuestion: { findMany: dsqFindMany },
    appAnswerSlot: { findMany: ansFindMany },
    appDataSlotFill: {
      findMany: fillFindMany,
      findUnique: fillFindUnique,
      create: fillCreate,
      update: fillUpdate,
    },
  };
  return {
    client: client as unknown as Parameters<typeof reconcileChatDataSlotFills>[0]['client'],
    fillCreate,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('reconcileChatDataSlotFills', () => {
  it('does nothing when no questions were answered this turn', async () => {
    const { client, fillCreate } = makeClient({ links: [], mapped: {}, answers: [] });
    const ids = await reconcileChatDataSlotFills({
      sessionId: 'sess-1',
      answeredQuestionSlotIds: [],
      client,
    });
    expect(ids).toEqual([]);
    expect(fillCreate).not.toHaveBeenCalled();
  });

  it('does nothing when the answered question feeds no data slot', async () => {
    const { client, fillCreate } = makeClient({ links: [], mapped: {}, answers: [] });
    const ids = await reconcileChatDataSlotFills({
      sessionId: 'sess-1',
      answeredQuestionSlotIds: ['q-orphan'],
      client,
    });
    expect(ids).toEqual([]);
    expect(fillCreate).not.toHaveBeenCalled();
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it('GAP-FILLING: leaves a slot that already has a fill untouched (this turn OR an earlier one)', async () => {
    const { client, fillCreate } = makeClient({
      links: [{ dataSlotId: 'ds-be', key: 'business_execution' }],
      mapped: { 'ds-be': [{ id: 'q-kpi', key: 'performance_kpis' }] },
      answers: [
        {
          questionSlotId: 'q-kpi',
          value: false,
          rationale: 'criticises the KPIs',
          confidence: 0.8,
        },
      ],
      existingFills: ['ds-be'], // already filled (by the extractor or a prior turn) — never overwrite
    });
    const ids = await reconcileChatDataSlotFills({
      sessionId: 'sess-1',
      answeredQuestionSlotIds: ['q-kpi'],
      client,
    });
    expect(ids).toEqual([]);
    expect(fillCreate).not.toHaveBeenCalled();
  });

  it('fills the orphaned parent slot, leading the paraphrase with the rationale (the bug case)', async () => {
    const { client, fillCreate } = makeClient({
      links: [{ dataSlotId: 'ds-be', key: 'business_execution' }],
      mapped: { 'ds-be': [{ id: 'q-kpi', key: 'performance_kpis' }] },
      answers: [
        {
          questionSlotId: 'q-kpi',
          value: false,
          rationale: "directly criticizes the KPIs as 'badly thought out'",
          confidence: 0.8,
        },
      ],
    });
    const ids = await reconcileChatDataSlotFills({
      sessionId: 'sess-1',
      answeredQuestionSlotIds: ['q-kpi'],
      client,
    });

    expect(ids).toEqual(['fill-ds-be']);
    expect(fillCreate).toHaveBeenCalledTimes(1);
    const data = (fillCreate as Mock).mock.calls[0][0].data;
    expect(data).toMatchObject({
      sessionId: 'sess-1',
      dataSlotId: 'ds-be',
      // boolean → "No", enriched with the answer's natural-language rationale.
      paraphrase: "No — directly criticizes the KPIs as 'badly thought out'",
      provenanceLabel: 'inferred',
      confidence: 0.8,
      provisional: false,
    });
    // Structured, diffable value keyed by question.
    expect(data.value).toEqual({ performance_kpis: false });
    // The breach is surfaced for observability.
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
    expect(loggerMock.warn.mock.calls[0][1]).toMatchObject({
      sessionId: 'sess-1',
      dataSlotKeys: ['business_execution'],
    });
  });

  it('rolls up several mapped answers as `synthesised` with the max confidence', async () => {
    const { client, fillCreate } = makeClient({
      links: [{ dataSlotId: 'ds-be', key: 'business_execution' }],
      mapped: {
        'ds-be': [
          { id: 'q-kpi', key: 'performance_kpis' },
          { id: 'q-tools', key: 'tools_and_support' },
        ],
      },
      answers: [
        { questionSlotId: 'q-kpi', value: false, rationale: 'KPIs unclear', confidence: 0.8 },
        { questionSlotId: 'q-tools', value: true, rationale: null, confidence: 0.6 },
      ],
    });
    await reconcileChatDataSlotFills({
      sessionId: 'sess-1',
      answeredQuestionSlotIds: ['q-kpi'],
      client,
    });
    const data = (fillCreate as Mock).mock.calls[0][0].data;
    expect(data.provenanceLabel).toBe('synthesised');
    expect(data.confidence).toBe(0.8); // max of 0.8 / 0.6
    // First fragment enriched with rationale; second has no rationale → bare formatted value.
    expect(data.paraphrase).toBe('No — KPIs unclear; Yes');
    expect(data.value).toEqual({ performance_kpis: false, tools_and_support: true });
  });

  it('falls back to the formatted value when the answer has no rationale', async () => {
    const { client, fillCreate } = makeClient({
      links: [{ dataSlotId: 'ds-x', key: 'topic' }],
      mapped: { 'ds-x': [{ id: 'q1', key: 'age' }] },
      answers: [{ questionSlotId: 'q1', value: 34, rationale: '', confidence: null }],
    });
    await reconcileChatDataSlotFills({
      sessionId: 'sess-1',
      answeredQuestionSlotIds: ['q1'],
      client,
    });
    const data = (fillCreate as Mock).mock.calls[0][0].data;
    expect(data.paraphrase).toBe('34');
    expect(data.provenanceLabel).toBe('inferred');
    expect(data.confidence).toBe(0.5); // null confidence → default 0.5
  });
});
