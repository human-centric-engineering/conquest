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
vi.mock('@/lib/db/client', () => ({
  prisma: { appQuestionnaireTurn: { findMany: (...args: unknown[]) => findMany(...args) } },
}));

import { loadTranscript } from '@/app/api/v1/app/questionnaire-sessions/_lib/transcript';

type Row = { userMessage: string; agentResponse: string; warnings: unknown };

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
