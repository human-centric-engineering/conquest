/**
 * Unit test: result-export DB loader (F8.2).
 *
 * Mocks Prisma and pins the load contract that the serialisers depend on:
 *   - only completed, non-preview sessions in the window are queried;
 *   - respondent names are batch-resolved (one query) and ONLY when not anonymous;
 *   - anonymous mode nulls every respondent name AND drops every session's turns,
 *     while still resolving answer→turn ordinals (identity gone, audit math intact);
 *   - the over-cap `capped` flag.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const versionFindUnique = vi.fn();
const slotFindMany = vi.fn();
const sessionFindMany = vi.fn();
const sessionCount = vi.fn();
const userFindMany = vi.fn();

vi.mock('@/lib/db/client', () => ({
  prisma: {
    appQuestionnaireVersion: { findUnique: (...a: unknown[]) => versionFindUnique(...a) },
    appQuestionSlot: { findMany: (...a: unknown[]) => slotFindMany(...a) },
    appQuestionnaireSession: {
      findMany: (...a: unknown[]) => sessionFindMany(...a),
      count: (...a: unknown[]) => sessionCount(...a),
    },
    user: { findMany: (...a: unknown[]) => userFindMany(...a) },
  },
}));

import {
  loadResultsExport,
  MAX_EXPORT_SESSIONS,
} from '@/lib/app/questionnaire/export/results-loader';
import type { AnalyticsScope } from '@/lib/app/questionnaire/analytics';

const scope: AnalyticsScope = {
  versionId: 'v1',
  from: new Date('2026-01-01T00:00:00.000Z'),
  to: new Date('2026-02-01T00:00:00.000Z'),
  tagIds: [],
};

const SLOTS = [
  {
    id: 'q1',
    key: 'role',
    prompt: 'Your role?',
    type: 'free_text',
    required: true,
    section: { title: 'About you' },
  },
];

/** One completed session with a single answer captured on turn ordinal 2. */
function sessionRow(over: Record<string, unknown> = {}) {
  return {
    id: 's1',
    status: 'completed',
    createdAt: new Date('2026-01-10T09:00:00.000Z'),
    updatedAt: new Date('2026-01-10T09:40:00.000Z'),
    respondentUserId: 'u1',
    answers: [
      {
        value: 'Engineer',
        confidence: 0.8,
        provenanceLabel: 'direct',
        provenanceItems: null,
        rationale: null,
        refinementHistory: [],
        lastUpdatedTurnId: 't2',
        questionSlot: { key: 'role' },
      },
    ],
    turns: [
      {
        id: 't1',
        ordinal: 1,
        userMessage: 'hi',
        agentResponse: 'hello',
        targetedQuestionId: null,
        toolCalls: [],
        sideEffectAnswerIds: [],
        costUsd: null,
        createdAt: new Date('2026-01-10T09:01:00.000Z'),
      },
      {
        id: 't2',
        ordinal: 2,
        userMessage: 'I am an engineer',
        agentResponse: 'noted',
        targetedQuestionId: 'q1',
        toolCalls: [],
        sideEffectAnswerIds: ['a1'],
        costUsd: 0.02,
        createdAt: new Date('2026-01-10T09:02:00.000Z'),
      },
    ],
    events: [{ createdAt: new Date('2026-01-10T09:30:00.000Z') }],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  versionFindUnique.mockResolvedValue({
    versionNumber: 3,
    config: { anonymousMode: false },
    questionnaire: { title: 'Onboarding' },
  });
  slotFindMany.mockResolvedValue(SLOTS);
  sessionFindMany.mockResolvedValue([sessionRow()]);
  sessionCount.mockResolvedValue(1);
  userFindMany.mockResolvedValue([{ id: 'u1', name: 'Ada Lovelace' }]);
});

describe('loadResultsExport', () => {
  it('returns null when the version does not exist', async () => {
    versionFindUnique.mockResolvedValue(null);
    expect(await loadResultsExport(scope)).toBeNull();
  });

  it('queries only completed, non-preview sessions inside the window', async () => {
    await loadResultsExport(scope);
    const where = sessionFindMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      versionId: 'v1',
      isPreview: false,
      status: 'completed',
      createdAt: { gte: scope.from, lt: scope.to },
    });
  });

  it('resolves respondent names in one batched query when not anonymous', async () => {
    const model = await loadResultsExport(scope);
    expect(userFindMany).toHaveBeenCalledTimes(1);
    expect(userFindMany.mock.calls[0][0].where).toEqual({ id: { in: ['u1'] } });
    expect(model!.sessions[0].respondentName).toBe('Ada Lovelace');
  });

  it('maps an answer to the ordinal of the turn that last captured it', async () => {
    const model = await loadResultsExport(scope);
    expect(model!.sessions[0].answers[0].lastUpdatedTurnOrdinal).toBe(2);
  });

  it('populates the full turn graph when not anonymous', async () => {
    const model = await loadResultsExport(scope);
    expect(model!.sessions[0].turns).toHaveLength(2);
    expect(model!.sessions[0].turns[1].userMessage).toBe('I am an engineer');
  });

  it('nulls identity and drops turns in anonymous mode, without querying users', async () => {
    versionFindUnique.mockResolvedValue({
      versionNumber: 3,
      config: { anonymousMode: true },
      questionnaire: { title: 'Onboarding' },
    });
    const model = await loadResultsExport(scope);
    expect(model!.anonymous).toBe(true);
    expect(model!.sessions[0].respondentName).toBeNull();
    expect(model!.sessions[0].turns).toEqual([]);
    // Identity is never queried in anonymous mode.
    expect(userFindMany).not.toHaveBeenCalled();
    // Answer→turn ordinal math still works (turns were loaded, just not surfaced).
    expect(model!.sessions[0].answers[0].lastUpdatedTurnOrdinal).toBe(2);
  });

  it('flags `capped` when more sessions match than the cap returns', async () => {
    sessionCount.mockResolvedValue(MAX_EXPORT_SESSIONS + 5);
    const model = await loadResultsExport(scope);
    expect(model!.capped).toBe(true);
    expect(sessionFindMany.mock.calls[0][0].take).toBe(MAX_EXPORT_SESSIONS);
  });

  it('applies the tag filter to the slot query when tagIds are present', async () => {
    await loadResultsExport({ ...scope, tagIds: ['t1', 't2'] });
    const where = slotFindMany.mock.calls[0][0].where;
    expect(where.tags).toEqual({ some: { tagId: { in: ['t1', 't2'] } } });
  });

  it('handles config-less versions, null/unknown respondents, and absent/unmapped turn links', async () => {
    const created = new Date('2026-01-10T09:00:00.000Z');
    const updated = new Date('2026-01-10T09:40:00.000Z');
    // No `config` row → anonymousMode defaults to false.
    versionFindUnique.mockResolvedValue({
      versionNumber: 1,
      config: null,
      questionnaire: { title: 'X' },
    });
    // The known user has a null name; the other respondent id isn't returned at all.
    userFindMany.mockResolvedValue([{ id: 'u-known', name: null }]);
    sessionFindMany.mockResolvedValue([
      {
        // Logged-out anonymous: no respondent, no completion event, junk refinement history,
        // provenanceItems present, answer not linked to a turn.
        id: 's1',
        status: 'completed',
        createdAt: created,
        updatedAt: updated,
        respondentUserId: null,
        answers: [
          {
            value: 'v',
            confidence: null,
            provenanceLabel: 'refined',
            provenanceItems: { a: 1 },
            rationale: null,
            refinementHistory: 'not-an-array',
            lastUpdatedTurnId: null,
            questionSlot: { key: 'role' },
          },
        ],
        turns: [],
        events: [],
      },
      {
        // Known respondent (name null) whose answer points at a turn that isn't loaded.
        id: 's2',
        status: 'completed',
        createdAt: created,
        updatedAt: updated,
        respondentUserId: 'u-known',
        answers: [
          {
            value: 'v',
            confidence: 0.5,
            provenanceLabel: 'direct',
            provenanceItems: null,
            rationale: null,
            refinementHistory: [],
            lastUpdatedTurnId: 't-missing',
            questionSlot: { key: 'role' },
          },
        ],
        turns: [
          {
            id: 't1',
            ordinal: 1,
            userMessage: 'm',
            agentResponse: 'a',
            targetedQuestionId: null,
            toolCalls: [],
            sideEffectAnswerIds: [],
            costUsd: null,
            createdAt: created,
          },
        ],
        events: [],
      },
      {
        // Respondent id that the user lookup doesn't resolve.
        id: 's3',
        status: 'completed',
        createdAt: created,
        updatedAt: updated,
        respondentUserId: 'u-gone',
        answers: [],
        turns: [],
        events: [],
      },
    ]);
    sessionCount.mockResolvedValue(3);

    const model = await loadResultsExport(scope);
    expect(model!.anonymous).toBe(false); // config null → false
    // s1: null respondent, junk history → [], non-null provenanceItems passthrough, no turn link,
    // and completedAt falls back to updatedAt when there's no completion event.
    expect(model!.sessions[0].respondentName).toBeNull();
    expect(model!.sessions[0].answers[0].refinementHistory).toEqual([]);
    expect(model!.sessions[0].answers[0].provenanceItems).toEqual({ a: 1 });
    expect(model!.sessions[0].answers[0].lastUpdatedTurnOrdinal).toBeNull();
    expect(model!.sessions[0].completedAt).toBe(updated.toISOString());
    // s2: known user with a null name → null; answer→turn link misses → null ordinal.
    expect(model!.sessions[1].respondentName).toBeNull();
    expect(model!.sessions[1].answers[0].lastUpdatedTurnOrdinal).toBeNull();
    // s3: unresolved respondent id → null.
    expect(model!.sessions[2].respondentName).toBeNull();
  });
});
