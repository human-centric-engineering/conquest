/**
 * reconcileDataSlotFills — form-mode answer edits keep the chat-facing data-slot fills in sync
 * (P-presentation). The mock transaction client stands in for `Prisma.TransactionClient`; the
 * assertions pin: an edited question's data slot is upserted from the session's current answers
 * (deterministic paraphrase, direct/full-confidence/non-provisional); a slot whose questions are
 * all cleared has its fill deleted; and an edit touching no data slot writes nothing.
 *
 * @see app/api/v1/app/questionnaire-sessions/_lib/form-answers.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { reconcileDataSlotFills } from '@/app/api/v1/app/questionnaire-sessions/_lib/form-answers';

type Mock = ReturnType<typeof vi.fn>;

/**
 * Build a mock client. `links` = which data slots each edited question feeds; `mapped` = the
 * questions each data slot covers; `answers` = the session's current answers (questionSlotId →
 * value). The fill is treated as not-yet-existing (create path).
 */
function makeClient(opts: {
  links: { dataSlotId: string }[];
  mapped: Record<string, { id: string; key: string }[]>;
  answers: { questionSlotId: string; value: unknown }[];
}) {
  const dsqFindMany = vi.fn(async (args: { where: Record<string, unknown> }) => {
    if ('questionSlotId' in args.where) return opts.links;
    const dataSlotId = args.where.dataSlotId as string;
    return (opts.mapped[dataSlotId] ?? []).map((q) => ({ questionSlot: q }));
  });
  const ansFindMany = vi.fn(async () => opts.answers);
  const fillFindUnique = vi.fn(async () => null);
  const fillCreate = vi.fn(async () => ({ id: 'fill-1' }));
  const fillUpdate = vi.fn(async () => ({ id: 'fill-1' }));
  const fillDeleteMany = vi.fn(async () => ({ count: 1 }));

  const client = {
    appDataSlotQuestion: { findMany: dsqFindMany },
    appAnswerSlot: { findMany: ansFindMany },
    appDataSlotFill: {
      findUnique: fillFindUnique,
      create: fillCreate,
      update: fillUpdate,
      deleteMany: fillDeleteMany,
    },
  };
  return {
    client: client as unknown as Parameters<typeof reconcileDataSlotFills>[0],
    fillCreate,
    fillDeleteMany,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('reconcileDataSlotFills', () => {
  it('does nothing when no questions were edited', async () => {
    const { client, fillCreate, fillDeleteMany } = makeClient({
      links: [],
      mapped: {},
      answers: [],
    });
    await reconcileDataSlotFills(client, 'sess-1', []);
    expect(fillCreate).not.toHaveBeenCalled();
    expect(fillDeleteMany).not.toHaveBeenCalled();
  });

  it('does nothing when the edited question feeds no data slot', async () => {
    const { client, fillCreate, fillDeleteMany } = makeClient({
      links: [],
      mapped: {},
      answers: [],
    });
    await reconcileDataSlotFills(client, 'sess-1', ['q1']);
    expect(fillCreate).not.toHaveBeenCalled();
    expect(fillDeleteMany).not.toHaveBeenCalled();
  });

  it('upserts the mapped data slot from the current answer with a deterministic paraphrase', async () => {
    const { client, fillCreate } = makeClient({
      links: [{ dataSlotId: 'ds-age' }],
      mapped: { 'ds-age': [{ id: 'q1', key: 'age' }] },
      answers: [{ questionSlotId: 'q1', value: 34 }],
    });
    await reconcileDataSlotFills(client, 'sess-1', ['q1']);

    expect(fillCreate).toHaveBeenCalledTimes(1);
    const data = (fillCreate as Mock).mock.calls[0][0].data;
    expect(data).toMatchObject({
      sessionId: 'sess-1',
      dataSlotId: 'ds-age',
      paraphrase: '34',
      provenanceLabel: 'direct',
      confidence: 1,
      provisional: false,
    });
    // Structured, diffable value keyed by question.
    expect(data.value).toEqual({ age: 34 });
  });

  it('joins multiple answered questions into one paraphrase', async () => {
    const { client, fillCreate } = makeClient({
      links: [{ dataSlotId: 'ds-demo' }],
      mapped: {
        'ds-demo': [
          { id: 'q1', key: 'age' },
          { id: 'q2', key: 'team' },
        ],
      },
      answers: [
        { questionSlotId: 'q1', value: 34 },
        { questionSlotId: 'q2', value: 'Engineering' },
      ],
    });
    await reconcileDataSlotFills(client, 'sess-1', ['q1']);
    expect((fillCreate as Mock).mock.calls[0][0].data.paraphrase).toBe('34; Engineering');
  });

  it('formats array (multi-choice) and object values in the paraphrase', async () => {
    const { client, fillCreate } = makeClient({
      links: [{ dataSlotId: 'ds-x' }],
      mapped: {
        'ds-x': [
          { id: 'q1', key: 'tags' },
          { id: 'q2', key: 'misc' },
        ],
      },
      answers: [
        { questionSlotId: 'q1', value: ['a', 'b'] },
        { questionSlotId: 'q2', value: { nested: true } },
      ],
    });
    await reconcileDataSlotFills(client, 'sess-1', ['q1']);
    // Array → "a, b"; plain object → JSON; joined across questions with "; ".
    expect((fillCreate as Mock).mock.calls[0][0].data.paraphrase).toBe('a, b; {"nested":true}');
  });

  it('clears the fill when every mapped question is now unanswered', async () => {
    const { client, fillCreate, fillDeleteMany } = makeClient({
      links: [{ dataSlotId: 'ds-age' }],
      mapped: { 'ds-age': [{ id: 'q1', key: 'age' }] },
      answers: [], // the edit cleared the only mapped question
    });
    await reconcileDataSlotFills(client, 'sess-1', ['q1']);
    expect(fillCreate).not.toHaveBeenCalled();
    expect(fillDeleteMany).toHaveBeenCalledWith({
      where: { sessionId: 'sess-1', dataSlotId: 'ds-age' },
    });
  });
});
