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
vi.mock('@/lib/db/client', () => ({
  prisma: {
    appQuestionnaireTurn: {
      findMany: (...args: unknown[]) => findMany(...args),
      findUnique: (...args: unknown[]) => findUnique(...args),
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

  it('skips the empty-message kickoff turn’s user bubble but keeps its assistant reply', async () => {
    const rows: Row[] = [
      { userMessage: '', agentResponse: 'Opening question?', warnings: [] },
      { userMessage: 'My answer', agentResponse: 'Follow-up?', warnings: [] },
    ];
    findMany.mockResolvedValue(rows);

    const turns = await loadTranscript('sess-1');

    expect(turns).toEqual([
      { role: 'assistant', content: 'Opening question?' },
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
