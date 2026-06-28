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
  mapped: Record<string, { id: string; key: string; type?: string; typeConfig?: unknown }[]>;
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

  it('summarises from the meaningful answers, dropping bare likert points', async () => {
    // A likert point ("Not at all") is meaningless in a slot summary without its question, so the
    // paraphrase is built only from answers that read on their own — here the free-text comment.
    const likertConfig = {
      min: 1,
      max: 5,
      labels: ['Not at all', 'A little', 'Somewhat', 'A lot', 'To a very great extent'],
    };
    const { client, fillCreate } = makeClient({
      links: [{ dataSlotId: 'ds-pipe' }],
      mapped: {
        'ds-pipe': [
          { id: 'q1', key: 'kpi_clarity', type: 'likert', typeConfig: likertConfig },
          { id: 'q2', key: 'playbook', type: 'likert', typeConfig: likertConfig },
          { id: 'q3', key: 'notes', type: 'free_text', typeConfig: null },
        ],
      },
      answers: [
        { questionSlotId: 'q1', value: 1 },
        { questionSlotId: 'q2', value: 1 },
        { questionSlotId: 'q3', value: 'We have a weak pipeline' },
      ],
    });
    await reconcileDataSlotFills(client, 'sess-1', ['q1']);
    expect((fillCreate as Mock).mock.calls[0][0].data.paraphrase).toBe('We have a weak pipeline');
  });

  it('falls back to a plain message when a slot has only bare likert/numeric answers', async () => {
    const likertConfig = {
      min: 1,
      max: 5,
      labels: ['Not at all', 'A little', 'Somewhat', 'A lot', 'Fully'],
    };
    const { client, fillCreate } = makeClient({
      links: [{ dataSlotId: 'ds-kpi' }],
      mapped: {
        'ds-kpi': [
          { id: 'q1', key: 'kpi_clarity', type: 'likert', typeConfig: likertConfig },
          { id: 'q2', key: 'team_size', type: 'numeric', typeConfig: null },
        ],
      },
      answers: [
        { questionSlotId: 'q1', value: 2 },
        { questionSlotId: 'q2', value: 5 },
      ],
    });
    await reconcileDataSlotFills(client, 'sess-1', ['q1']);
    const data = (fillCreate as Mock).mock.calls[0][0].data;
    // Nothing reads on its own → an honest message, not a meaningless "A little; 5".
    expect(data.paraphrase).toBe('Form questions were answered directly.');
    // The structured values are still kept whole for diffing / scoring.
    expect(data.value).toEqual({ kpi_clarity: 2, team_size: 5 });
  });

  it('renders choice answers as their labels in the summary', async () => {
    const choiceConfig = {
      choices: [
        { value: 'eng', label: 'Engineering' },
        { value: 'sales', label: 'Sales' },
      ],
    };
    const { client, fillCreate } = makeClient({
      links: [{ dataSlotId: 'ds-dept' }],
      mapped: {
        'ds-dept': [{ id: 'q1', key: 'dept', type: 'single_choice', typeConfig: choiceConfig }],
      },
      answers: [{ questionSlotId: 'q1', value: 'eng' }],
    });
    await reconcileDataSlotFills(client, 'sess-1', ['q1']);
    expect((fillCreate as Mock).mock.calls[0][0].data.paraphrase).toBe('Engineering');
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
