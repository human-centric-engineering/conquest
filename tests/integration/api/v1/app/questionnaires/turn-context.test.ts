/**
 * Integration test: the live turn-context loader (F6.1, PR4).
 *
 * Prisma is mocked; this pins the loader's mapping from the persisted session graph onto
 * the orchestrator shapes: questions/slots, coverage vs value answer views, the recent
 * transcript (oldest → newest), the active question (the prior turn's target), and the
 * monotonic selection round.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prisma: { appQuestionnaireSession: { findUnique: vi.fn() } },
}));
vi.mock('@/lib/db/client', () => ({ prisma: mocks.prisma }));

import { buildTurnContext } from '@/app/api/v1/app/questionnaires/_lib/turn-context';

type Mock = ReturnType<typeof vi.fn>;

function sessionGraph(over: Record<string, unknown> = {}) {
  return {
    id: 'sess-1',
    status: 'active',
    versionId: 'v1',
    respondentUserId: 'user-1',
    version: {
      config: null, // lazy — resolves to defaults
      sections: [
        {
          id: 's1',
          ordinal: 0,
          questions: [
            {
              id: 'q1',
              key: 'role',
              ordinal: 0,
              weight: 1,
              required: true,
              type: 'free_text',
              prompt: 'What is your role?',
              guidelines: 'Be specific',
              typeConfig: null,
              tags: [],
            },
            {
              id: 'q2',
              key: 'team',
              ordinal: 1,
              weight: 1,
              required: false,
              type: 'numeric',
              prompt: 'Team size?',
              guidelines: null,
              typeConfig: { min: 0 },
              tags: [{ tagId: 't1' }],
            },
          ],
        },
      ],
    },
    answers: [
      {
        value: 'marketing',
        confidence: 0.9,
        provenanceLabel: 'direct',
        rationale: 'said so',
        questionSlot: { id: 'q1', key: 'role' },
      },
    ],
    turns: [
      // newest first (orderBy ordinal desc)
      {
        userMessage: 'I do marketing',
        agentResponse: 'And your team size?',
        targetedQuestionId: 'q2',
        ordinal: 2,
      },
      {
        userMessage: 'hi',
        agentResponse: 'What is your role?',
        targetedQuestionId: 'q1',
        ordinal: 1,
      },
    ],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildTurnContext', () => {
  it('returns null for an unknown session', async () => {
    (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(null);
    expect(await buildTurnContext('nope')).toBeNull();
  });

  it('maps questions, slots, and the active question (the prior turn target)', async () => {
    (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(sessionGraph());
    const loaded = await buildTurnContext('sess-1');

    expect(loaded).not.toBeNull();
    expect(loaded!.base.questions.map((q) => q.key)).toEqual(['role', 'team']);
    // Slots carry typeConfig/guidelines only when present.
    expect(loaded!.slots[0]).toMatchObject({ key: 'role', guidelines: 'Be specific' });
    expect(loaded!.slots[0]).not.toHaveProperty('typeConfig');
    expect(loaded!.slots[1]).toMatchObject({ key: 'team', typeConfig: { min: 0 } });
    expect(loaded!.slots[1]).not.toHaveProperty('guidelines');
    // The most recent turn targeted q2 → active question key is 'team'.
    expect(loaded!.activeQuestionKey).toBe('team');
  });

  it('builds coverage + value answer views and the oldest→newest transcript', async () => {
    (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(sessionGraph());
    const loaded = await buildTurnContext('sess-1');

    expect(loaded!.base.answered).toEqual([{ questionId: 'q1', confidence: 0.9 }]);
    expect(loaded!.base.existingAnswers[0]).toMatchObject({
      slotKey: 'role',
      value: 'marketing',
      provenance: 'direct',
      confidence: 0.9,
      rationale: 'said so',
    });
    // Reversed to oldest → newest, interleaving user + agent messages.
    expect(loaded!.base.recentMessages).toEqual([
      'hi',
      'What is your role?',
      'I do marketing',
      'And your team size?',
    ]);
    // selectionRound is the number of prior turns (monotonic).
    expect(loaded!.base.selectionRound).toBe(2);
  });

  it('resolves an absent config row to defaults', async () => {
    (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(sessionGraph());
    const loaded = await buildTurnContext('sess-1');
    expect(loaded!.base.config.selectionStrategy).toBe('sequential');
    expect(loaded!.base.config.contradictionMode).toBe('off');
  });

  it('has no active question and an empty transcript on a fresh session (no turns/answers)', async () => {
    (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      sessionGraph({ answers: [], turns: [] })
    );
    const loaded = await buildTurnContext('sess-1');
    expect(loaded!.activeQuestionKey).toBeNull();
    expect(loaded!.base.recentMessages).toEqual([]);
    expect(loaded!.base.answered).toEqual([]);
    expect(loaded!.base.existingAnswers).toEqual([]);
    expect(loaded!.base.selectionRound).toBe(0);
  });

  it('drops blank user/agent messages from the transcript and tolerates null answer fields', async () => {
    (mocks.prisma.appQuestionnaireSession.findUnique as Mock).mockResolvedValue(
      sessionGraph({
        answers: [
          {
            value: 5,
            confidence: null,
            provenanceLabel: 'inferred',
            rationale: null,
            questionSlot: { id: 'q2', key: 'team' },
          },
        ],
        turns: [
          { userMessage: 'only user', agentResponse: '', targetedQuestionId: null, ordinal: 1 },
        ],
      })
    );
    const loaded = await buildTurnContext('sess-1');
    // Blank agent response is dropped; the active question is null (turn targeted nothing).
    expect(loaded!.base.recentMessages).toEqual(['only user']);
    expect(loaded!.activeQuestionKey).toBeNull();
    const ans = loaded!.base.existingAnswers[0];
    expect(ans).toMatchObject({ slotKey: 'team', value: 5, provenance: 'inferred' });
    expect(ans).not.toHaveProperty('confidence');
    expect(ans).not.toHaveProperty('rationale');
  });
});
