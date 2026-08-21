/**
 * loadTranscript — rebuilds a session's rendered transcript from its persisted turn rows for
 * the F7.1 resume replay. The `prisma` client is mocked; the assertions pin: ordinal-ordered
 * read, the kickoff turn (empty `userMessage`) contributing only its assistant message, the
 * per-turn notices being parsed onto the assistant turn, and the warnings parse failing soft
 * (a malformed `warnings` JSON degrades to no notices rather than throwing).
 *
 * @see app/api/v1/app/questionnaire-sessions/_lib/transcript.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const findMany = vi.fn();
const findUnique = vi.fn();
const slotFindMany = vi.fn();
vi.mock('@/lib/db/client', () => ({
  prisma: {
    appQuestionnaireTurn: {
      findMany: (...args: unknown[]) => findMany(...args),
      findUnique: (...args: unknown[]) => findUnique(...args),
    },
    appQuestionSlot: {
      findMany: (...args: unknown[]) => slotFindMany(...args),
    },
  },
}));

import {
  loadTranscript,
  loadInspectorTurns,
  findTurnByIdempotencyKey,
} from '@/app/api/v1/app/questionnaire-sessions/_lib/transcript';

type Row = { userMessage: string; agentResponse: string; warnings: unknown };

/** A minimal valid persisted agent-call trace (satisfies `agentCallTraceSchema`). */
function call(label: string) {
  return {
    label,
    model: 'gpt-x',
    provider: 'openai',
    latencyMs: 12,
    costUsd: 0.0003,
    prompt: [{ role: 'system', content: 'prompt' }],
    response: 'response',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadTranscript', () => {
  it('reads turns ordinal-ascending for the session', async () => {
    findMany.mockResolvedValue([]);
    await loadTranscript('sess-1');
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sessionId: 'sess-1' },
        orderBy: { ordinal: 'asc' },
      })
    );
  });

  it('skips the empty- or whitespace-only kickoff turn’s user bubble but keeps its assistant reply', async () => {
    // Source gates the user bubble on `userMessage.trim().length > 0`, so a whitespace-only
    // message is dropped too — covered by the second row, not just the bare-empty first.
    const rows: Row[] = [
      { userMessage: '', agentResponse: 'Opening question?', warnings: [] },
      { userMessage: '   ', agentResponse: 'Still opening?', warnings: [] },
      { userMessage: 'My answer', agentResponse: 'Follow-up?', warnings: [] },
    ];
    findMany.mockResolvedValue(rows);

    const turns = await loadTranscript('sess-1');

    expect(turns).toEqual([
      { role: 'assistant', content: 'Opening question?' },
      { role: 'assistant', content: 'Still opening?' },
      { role: 'user', content: 'My answer' },
      { role: 'assistant', content: 'Follow-up?' },
    ]);
  });

  it('attaches persisted notices to the assistant turn that raised them', async () => {
    const rows: Row[] = [
      {
        userMessage: 'lol',
        agentResponse: "Let's keep it genuine.",
        warnings: [{ code: 'seriousness', message: "That doesn't seem serious." }],
      },
    ];
    findMany.mockResolvedValue(rows);

    const turns = await loadTranscript('sess-1');

    expect(turns).toEqual([
      { role: 'user', content: 'lol' },
      {
        role: 'assistant',
        content: "Let's keep it genuine.",
        warnings: [{ code: 'seriousness', message: "That doesn't seem serious." }],
      },
    ]);
  });

  it('omits the warnings key when a turn raised none', async () => {
    findMany.mockResolvedValue([{ userMessage: 'a', agentResponse: 'b', warnings: [] }]);
    const turns = await loadTranscript('sess-1');
    expect(turns.at(-1)).not.toHaveProperty('warnings');
  });

  it('fails soft to no notices when the persisted warnings JSON is malformed', async () => {
    // A row whose `warnings` is the wrong shape (e.g. legacy/corrupt) must not throw — replay
    // degrades to the message with no notices.
    findMany.mockResolvedValue([
      { userMessage: 'a', agentResponse: 'b', warnings: { not: 'an array' } },
      { userMessage: 'c', agentResponse: 'd', warnings: [{ code: 'support' }] }, // missing message
    ]);

    const turns = await loadTranscript('sess-1');

    expect(turns).toEqual([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
      { role: 'assistant', content: 'd' },
    ]);
  });
});

describe('loadInspectorTurns', () => {
  it('reads turns ordinal-ascending, selecting ordinal + inspectorCalls', async () => {
    findMany.mockResolvedValue([]);
    await loadInspectorTurns('sess-1');
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sessionId: 'sess-1' },
        orderBy: { ordinal: 'asc' },
        select: { ordinal: true, inspectorCalls: true },
      })
    );
  });

  it('maps the 1-based ordinal to the live 0-based turnIndex (ordinal − 1)', async () => {
    // Reproduces the index the live `inspector` frame used (`selectionRound`), so a hydrated turn
    // lines up with the same transcript user message the drawer derives context from.
    findMany.mockResolvedValue([
      { ordinal: 1, inspectorCalls: [call('Kickoff')] },
      { ordinal: 2, inspectorCalls: [call('Extractor'), call('Interviewer')] },
    ]);

    const turns = await loadInspectorTurns('sess-1');

    expect(turns).toEqual([
      { turnIndex: 0, calls: [expect.objectContaining({ label: 'Kickoff' })] },
      {
        turnIndex: 1,
        calls: [
          expect.objectContaining({ label: 'Extractor' }),
          expect.objectContaining({ label: 'Interviewer' }),
        ],
      },
    ]);
  });

  it('skips a turn that captured no calls (the live frame only emits when calls exist)', async () => {
    findMany.mockResolvedValue([
      { ordinal: 1, inspectorCalls: [] },
      { ordinal: 2, inspectorCalls: [call('Interviewer')] },
    ]);

    const turns = await loadInspectorTurns('sess-1');

    expect(turns).toEqual([
      { turnIndex: 1, calls: [expect.objectContaining({ label: 'Interviewer' })] },
    ]);
  });

  it('fails soft, dropping a turn whose persisted inspectorCalls JSON is malformed', async () => {
    findMany.mockResolvedValue([
      { ordinal: 1, inspectorCalls: { not: 'an array' } },
      { ordinal: 2, inspectorCalls: [{ label: 'no model/provider' }] }, // missing required fields
      { ordinal: 3, inspectorCalls: [call('Good')] },
    ]);

    const turns = await loadInspectorTurns('sess-1');

    expect(turns).toEqual([{ turnIndex: 2, calls: [expect.objectContaining({ label: 'Good' })] }]);
  });
});

describe('findTurnByIdempotencyKey', () => {
  it('looks up the turn by the compound (sessionId, idempotencyKey) unique', async () => {
    findUnique.mockResolvedValue(null);
    await findTurnByIdempotencyKey('sess-1', 'key-abc');
    expect(findUnique).toHaveBeenCalledWith({
      where: { sessionId_idempotencyKey: { sessionId: 'sess-1', idempotencyKey: 'key-abc' } },
      select: { id: true, agentResponse: true, warnings: true, reasoning: true },
    });
  });

  it('returns null when no turn carries the key (the common retry case — first attempt never persisted)', async () => {
    findUnique.mockResolvedValue(null);
    expect(await findTurnByIdempotencyKey('sess-1', 'missing')).toBeNull();
  });

  it('returns the saved reply with validated warnings + reasoning for replay', async () => {
    findUnique.mockResolvedValue({
      id: 'turn-7',
      agentResponse: 'Here is the reply.',
      warnings: [{ code: 'contradiction', message: 'That differs.', detail: 'why' }],
      reasoning: [{ kind: 'extraction', label: 'Captured role', tone: 'neutral' }],
    });

    const replay = await findTurnByIdempotencyKey('sess-1', 'key-abc');

    expect(replay).toEqual({
      id: 'turn-7',
      agentResponse: 'Here is the reply.',
      warnings: [{ code: 'contradiction', message: 'That differs.', detail: 'why' }],
      reasoning: [{ kind: 'extraction', label: 'Captured role', tone: 'neutral' }],
    });
  });

  it('fails soft on malformed warnings/reasoning JSON (replay degrades to empty, never throws)', async () => {
    findUnique.mockResolvedValue({
      id: 'turn-8',
      agentResponse: 'Reply.',
      warnings: { not: 'an array' },
      reasoning: 'garbage',
    });

    const replay = await findTurnByIdempotencyKey('sess-1', 'key-bad');

    expect(replay).toEqual({
      id: 'turn-8',
      agentResponse: 'Reply.',
      warnings: [],
      reasoning: [],
    });
  });
});

describe('loadTranscript — question-card replay (P18)', () => {
  const turnRow = (over: Record<string, unknown> = {}) => ({
    userMessage: 'sure',
    agentResponse: 'Before we move on, one as written:',
    warnings: [],
    reasoning: [],
    questionCardKey: 'workload',
    ...over,
  });

  const slotRow = (over: Record<string, unknown> = {}) => ({
    id: 'q1',
    key: 'workload',
    prompt: 'How satisfied are you with your current workload?',
    type: 'likert',
    typeConfig: { min: 1, max: 5 },
    required: true,
    fidelity: 1,
    answers: [],
    section: { version: { config: { questionFidelity: { enabled: true, defaultFidelity: 0.5 } } } },
    ...over,
  });

  it('scopes the slot lookup to THIS session, and reads its answers per-session', async () => {
    // The `where` is the isolation guarantee: without the session scope a card could be rebuilt
    // from a slot on somebody else's questionnaire, and without the per-session `answers` filter a
    // question another respondent had answered would suppress this respondent's card.
    findMany.mockResolvedValue([turnRow()]);
    slotFindMany.mockResolvedValue([slotRow()]);

    await loadTranscript('sess-1');

    expect(slotFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          key: { in: ['workload'] },
          section: { version: { sessions: { some: { id: 'sess-1' } } } },
        },
        select: expect.objectContaining({
          answers: { where: { sessionId: 'sess-1' }, select: { id: true }, take: 1 },
          // The gate rides the same traversal — no second round-trip for it.
          section: {
            select: { version: { select: { config: { select: { questionFidelity: true } } } } },
          },
        }),
      })
    );
  });

  it('rebuilds the card from the LIVE slot, not a stored snapshot', async () => {
    // Only the key is persisted, so an admin who rewords a question between sessions must not leave
    // a stale copy pinned in a resumed transcript.
    findMany.mockResolvedValue([turnRow()]);
    slotFindMany.mockResolvedValue([slotRow({ prompt: 'Reworded since that turn?' })]);

    const turns = await loadTranscript('sess-1');

    const assistant = turns.find((t) => t.role === 'assistant');
    expect(assistant?.card).toMatchObject({
      questionKey: 'workload',
      prompt: 'Reworded since that turn?',
      reason: 'must_ask',
    });
  });

  it('suppresses the card once the question has been answered', async () => {
    // Replaying a live control over an answer they already gave invites a second submission, which
    // would overwrite the first.
    findMany.mockResolvedValue([turnRow()]);
    slotFindMany.mockResolvedValue([slotRow({ answers: [{ id: 'a1' }] })]);

    const turns = await loadTranscript('sess-1');
    expect(turns.find((t) => t.role === 'assistant')?.card).toBeUndefined();
  });

  it('suppresses the card when the question can no longer render a control', async () => {
    // Retyped to free text, or its choices removed, since the turn was recorded.
    findMany.mockResolvedValue([turnRow()]);
    slotFindMany.mockResolvedValue([slotRow({ type: 'single_choice', typeConfig: null })]);

    const turns = await loadTranscript('sess-1');
    expect(turns.find((t) => t.role === 'assistant')?.card).toBeUndefined();
  });

  it('suppresses the card when the stored type is not a known question type', async () => {
    // A legacy or hand-edited row degrades to free_text, which has no answer control — so the turn
    // replays as prose rather than rendering a control the respondent cannot use.
    findMany.mockResolvedValue([turnRow()]);
    slotFindMany.mockResolvedValue([slotRow({ type: 'slider' })]);

    const turns = await loadTranscript('sess-1');
    expect(turns.find((t) => t.role === 'assistant')?.card).toBeUndefined();
  });

  it('labels a non-must-ask replay as a last resort', async () => {
    findMany.mockResolvedValue([turnRow()]);
    slotFindMany.mockResolvedValue([slotRow({ fidelity: 0.5 })]);

    const turns = await loadTranscript('sess-1');
    expect(turns.find((t) => t.role === 'assistant')?.card?.reason).toBe('last_resort');
  });

  it('suppresses the card when the version gate has since been switched off', async () => {
    // The turn genuinely rendered a card, but the control is INTERACTIVE — replaying it after the
    // admin disabled the feature would let a respondent still submit through it, breaking the
    // inert-when-off guarantee.
    findMany.mockResolvedValue([turnRow()]);
    slotFindMany.mockResolvedValue([
      slotRow({
        section: {
          version: { config: { questionFidelity: { enabled: false, defaultFidelity: 0.5 } } },
        },
      }),
    ]);

    const turns = await loadTranscript('sess-1');
    expect(turns.find((t) => t.role === 'assistant')?.card).toBeUndefined();
  });

  it('suppresses the card when the version has no config row at all', async () => {
    findMany.mockResolvedValue([turnRow()]);
    slotFindMany.mockResolvedValue([slotRow({ section: { version: { config: null } } })]);

    const turns = await loadTranscript('sess-1');
    expect(turns.find((t) => t.role === 'assistant')?.card).toBeUndefined();
  });

  it('makes NO slot query when no turn carried a card', async () => {
    // The overwhelming majority of sessions. The common path must not pay for this feature.
    findMany.mockResolvedValue([turnRow({ questionCardKey: null })]);

    const turns = await loadTranscript('sess-1');
    expect(slotFindMany).not.toHaveBeenCalled();
    expect(turns.find((t) => t.role === 'assistant')?.card).toBeUndefined();
  });
});
