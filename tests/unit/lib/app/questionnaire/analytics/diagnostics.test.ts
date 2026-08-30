/**
 * Unit test: per-invitation diagnostics aggregation.
 *
 * Prisma is mocked; the real roll-up logic runs. Pins the rows-per-invitation assembly (including
 * the synthetic "(no invitation)" group), the anonymous-mode identity suppression, the version
 * totals, and the drill-down's version-ownership guard.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prisma: {
    appQuestionnaireSession: { findMany: vi.fn() },
    appQuestionnaireInvitation: { findMany: vi.fn(), findUnique: vi.fn() },
    appQuestionnaireConfig: { findUnique: vi.fn() },
    appQuestionnaireTurn: { groupBy: vi.fn(), findMany: vi.fn() },
    appQuestionnaireError: { groupBy: vi.fn(), findMany: vi.fn() },
    $queryRawUnsafe: vi.fn(),
  },
}));
vi.mock('@/lib/db/client', () => ({ prisma: mocks.prisma }));

import {
  getVersionDiagnostics,
  getInvitationDiagnostics,
  getStageLatency,
} from '@/lib/app/questionnaire/analytics/diagnostics';
import type { AnalyticsScope } from '@/lib/app/questionnaire/analytics/query-schema';

const p = mocks.prisma;
const scope: AnalyticsScope = {
  versionId: 'v-1',
  from: new Date('2026-06-01T00:00:00Z'),
  to: new Date('2026-07-01T00:00:00Z'),
  tagIds: [],
};

/**
 * `getVersionDiagnostics` issues THREE raw queries — the turn-duration avg/p95, and the two that
 * make up the P20 stage-latency split. A single `mockResolvedValue` would hand all three the same
 * shape, so each test would silently exercise whichever one happened to tolerate it. This routes
 * each query to its own fixture by matching a marker unique to that SQL.
 */
function mockRawQueries(
  fixtures: {
    duration?: unknown[];
    stages?: unknown[];
    turnTotals?: unknown[];
  } = {}
) {
  p.$queryRawUnsafe.mockImplementation((sql: string) => {
    if (sql.includes("c->>'label'")) return Promise.resolve(fixtures.stages ?? []);
    if (sql.includes('total_call_ms')) return Promise.resolve(fixtures.turnTotals ?? []);
    return Promise.resolve(fixtures.duration ?? [{ avg_ms: null, p95_ms: null }]);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  p.appQuestionnaireConfig.findUnique.mockResolvedValue({ anonymousMode: false });
});

describe('getVersionDiagnostics', () => {
  it('rolls up telemetry + errors per invitation and computes version totals', async () => {
    p.appQuestionnaireSession.findMany.mockResolvedValue([
      { id: 's-1', invitationId: 'inv-1', status: 'completed', createdAt: new Date('2026-06-10') },
    ]);
    p.appQuestionnaireInvitation.findMany.mockResolvedValue([
      {
        id: 'inv-1',
        email: 'ada@example.com',
        name: 'Ada',
        status: 'completed',
        sentAt: new Date('2026-06-09'),
        openedAt: new Date('2026-06-09'),
        registeredAt: new Date('2026-06-10'),
        createdAt: new Date('2026-06-09'),
      },
    ]);
    p.appQuestionnaireTurn.groupBy.mockResolvedValue([
      {
        sessionId: 's-1',
        _count: { _all: 4 },
        _sum: { promptTokens: 100, completionTokens: 40, costUsd: 0.5 },
        _avg: { durationMs: 800 },
        _max: { createdAt: new Date('2026-06-10T01:00:00Z') },
      },
    ]);
    p.appQuestionnaireError.groupBy
      .mockResolvedValueOnce([
        { invitationId: 'inv-1', _count: { _all: 2 }, _max: { createdAt: new Date('2026-06-10') } },
      ]) // by invitation
      .mockResolvedValueOnce([
        { severity: 'error', _count: { _all: 1 } },
        { severity: 'warning', _count: { _all: 1 } },
      ]); // by severity
    mockRawQueries({ duration: [{ avg_ms: 800, p95_ms: 950 }] });

    const result = await getVersionDiagnostics(scope);

    expect(result.totals).toMatchObject({
      sessions: 1,
      turns: 4,
      promptTokens: 100,
      completionTokens: 40,
      totalTokens: 140,
      costUsd: 0.5,
      avgTurnMs: 800,
      p95TurnMs: 950,
      errorCount: 2,
      errorsBySeverity: { error: 1, warning: 1, info: 0 },
    });
    expect(result.invitations).toHaveLength(1);
    expect(result.invitations[0]).toMatchObject({
      invitationId: 'inv-1',
      email: 'ada@example.com',
      turns: 4,
      errorCount: 2,
      sessionStatuses: ['completed'],
    });
    expect(result.identitySuppressed).toBe(false);
  });

  it('folds walk-up sessions and unattributed errors into a "(no invitation)" row', async () => {
    p.appQuestionnaireSession.findMany.mockResolvedValue([
      { id: 's-anon', invitationId: null, status: 'active', createdAt: new Date('2026-06-12') },
    ]);
    p.appQuestionnaireInvitation.findMany.mockResolvedValue([]);
    p.appQuestionnaireTurn.groupBy.mockResolvedValue([
      {
        sessionId: 's-anon',
        _count: { _all: 1 },
        _sum: { promptTokens: 10, completionTokens: 5, costUsd: 0.01 },
        _avg: { durationMs: 500 },
        _max: { createdAt: new Date('2026-06-12') },
      },
    ]);
    p.appQuestionnaireError.groupBy
      .mockResolvedValueOnce([
        { invitationId: null, _count: { _all: 3 }, _max: { createdAt: new Date('2026-06-12') } },
      ])
      .mockResolvedValueOnce([{ severity: 'error', _count: { _all: 3 } }]);
    mockRawQueries({ duration: [{ avg_ms: 500, p95_ms: 500 }] });

    const result = await getVersionDiagnostics(scope);
    expect(result.invitations).toHaveLength(1);
    expect(result.invitations[0]).toMatchObject({
      invitationId: null,
      email: null,
      turns: 1,
      errorCount: 3,
    });
  });

  it('withholds identity under anonymous mode but keeps telemetry', async () => {
    p.appQuestionnaireConfig.findUnique.mockResolvedValue({ anonymousMode: true });
    p.appQuestionnaireSession.findMany.mockResolvedValue([
      { id: 's-1', invitationId: 'inv-1', status: 'completed', createdAt: new Date('2026-06-10') },
    ]);
    p.appQuestionnaireInvitation.findMany.mockResolvedValue([
      {
        id: 'inv-1',
        email: 'ada@example.com',
        name: 'Ada',
        status: 'completed',
        sentAt: null,
        openedAt: null,
        registeredAt: null,
        createdAt: new Date('2026-06-09'),
      },
    ]);
    p.appQuestionnaireTurn.groupBy.mockResolvedValue([
      {
        sessionId: 's-1',
        _count: { _all: 2 },
        _sum: { promptTokens: 20, completionTokens: 10, costUsd: 0.1 },
        _avg: { durationMs: 600 },
        _max: { createdAt: new Date('2026-06-10') },
      },
    ]);
    p.appQuestionnaireError.groupBy.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    mockRawQueries({ duration: [{ avg_ms: 600, p95_ms: 600 }] });

    const result = await getVersionDiagnostics(scope);
    expect(result.identitySuppressed).toBe(true);
    expect(result.invitations[0].email).toBeNull();
    expect(result.invitations[0].name).toBeNull();
    expect(result.invitations[0].turns).toBe(2); // telemetry still present
  });
});

describe('getInvitationDiagnostics', () => {
  it('returns null when the invitation belongs to a different version', async () => {
    p.appQuestionnaireInvitation.findUnique.mockResolvedValue({ id: 'inv-1', versionId: 'other' });
    p.appQuestionnaireConfig.findUnique.mockResolvedValue({ anonymousMode: false });
    expect(await getInvitationDiagnostics('v-1', 'inv-1')).toBeNull();
  });

  it('assembles sessions, turns, errors, and totals for the invitation', async () => {
    p.appQuestionnaireInvitation.findUnique.mockResolvedValue({
      id: 'inv-1',
      versionId: 'v-1',
      email: 'ada@example.com',
      name: 'Ada',
      status: 'started',
      sentAt: new Date('2026-06-09'),
      openedAt: null,
      registeredAt: null,
      expiresAt: new Date('2026-06-16'),
      revokedAt: null,
    });
    p.appQuestionnaireConfig.findUnique.mockResolvedValue({ anonymousMode: false });
    p.appQuestionnaireSession.findMany.mockResolvedValue([
      {
        id: 's-1',
        publicRef: '7F3K9M2P',
        status: 'active',
        isPreview: false,
        createdAt: new Date('2026-06-10'),
      },
    ]);
    p.appQuestionnaireTurn.findMany.mockResolvedValue([
      {
        sessionId: 's-1',
        ordinal: 1,
        createdAt: new Date('2026-06-10'),
        durationMs: 700,
        promptTokens: 50,
        completionTokens: 20,
        costUsd: 0.2,
        toolCalls: [],
        warnings: [],
        inspectorCalls: [
          {
            label: 'extract',
            model: 'm',
            provider: 'p',
            latencyMs: 100,
            costUsd: 0.1,
            prompt: [],
            response: 'ok',
          },
        ],
      },
    ]);
    p.appQuestionnaireError.findMany.mockResolvedValue([
      {
        id: 'e-1',
        createdAt: new Date('2026-06-10'),
        scope: 'pipeline',
        stage: 'run_turn',
        severity: 'error',
        code: 'TypeError',
        message: 'boom',
        stack: 'at ...',
        turnOrdinal: 1,
        metadata: { dataSlotMode: false },
      },
    ]);

    const result = await getInvitationDiagnostics('v-1', 'inv-1');
    expect(result).not.toBeNull();
    expect(result!.sessions).toHaveLength(1);
    expect(result!.sessions[0].turns[0].inspectorCalls).toHaveLength(1);
    expect(result!.errors).toHaveLength(1);
    expect(result!.totals).toMatchObject({
      turns: 1,
      promptTokens: 50,
      completionTokens: 20,
      costUsd: 0.2,
      avgTurnMs: 700,
      errorCount: 1,
    });
  });

  it('handles a session with no turns (avgTurnMs null, zero totals)', async () => {
    p.appQuestionnaireInvitation.findUnique.mockResolvedValue({
      id: 'inv-1',
      versionId: 'v-1',
      email: 'ada@example.com',
      name: 'Ada',
      status: 'registered',
      sentAt: null,
      openedAt: null,
      registeredAt: null,
      expiresAt: null,
      revokedAt: null,
    });
    p.appQuestionnaireConfig.findUnique.mockResolvedValue({ anonymousMode: false });
    p.appQuestionnaireSession.findMany.mockResolvedValue([
      {
        id: 's-1',
        publicRef: null,
        status: 'active',
        isPreview: false,
        createdAt: new Date('2026-06-10'),
      },
    ]);
    // No sessionIds branch is still hit (one session) but the turn read returns nothing.
    p.appQuestionnaireTurn.findMany.mockResolvedValue([]);
    p.appQuestionnaireError.findMany.mockResolvedValue([]);

    const result = await getInvitationDiagnostics('v-1', 'inv-1');
    expect(result).not.toBeNull();
    expect(result!.sessions[0].turns).toEqual([]);
    expect(result!.totals.avgTurnMs).toBeNull();
    expect(result!.totals.turns).toBe(0);
  });

  it('withholds email/name under anonymous mode in the drill-down', async () => {
    p.appQuestionnaireInvitation.findUnique.mockResolvedValue({
      id: 'inv-1',
      versionId: 'v-1',
      email: 'ada@example.com',
      name: 'Ada',
      status: 'started',
      sentAt: null,
      openedAt: null,
      registeredAt: null,
      expiresAt: null,
      revokedAt: null,
    });
    p.appQuestionnaireConfig.findUnique.mockResolvedValue({ anonymousMode: true });
    p.appQuestionnaireSession.findMany.mockResolvedValue([]);
    p.appQuestionnaireError.findMany.mockResolvedValue([]);

    const result = await getInvitationDiagnostics('v-1', 'inv-1');
    expect(result!.email).toBeNull();
    expect(result!.name).toBeNull();
    expect(result!.identitySuppressed).toBe(true);
  });
});

describe('getVersionDiagnostics — edge branches', () => {
  it('short-circuits with zero totals and no rows when the version has no sessions', async () => {
    p.appQuestionnaireSession.findMany.mockResolvedValue([]);
    p.appQuestionnaireInvitation.findMany.mockResolvedValue([]);
    // sessionIds empty → the turn groupBy + raw p95 query are skipped entirely.
    p.appQuestionnaireError.groupBy.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const result = await getVersionDiagnostics(scope);

    expect(p.appQuestionnaireTurn.groupBy).not.toHaveBeenCalled();
    expect(p.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(result.totals).toMatchObject({
      sessions: 0,
      turns: 0,
      totalTokens: 0,
      avgTurnMs: null,
      p95TurnMs: null,
      errorCount: 0,
    });
    expect(result.invitations).toEqual([]);
  });

  it('reports avgTurnMs null and derives lastActivity from errors when a turn logged no duration', async () => {
    p.appQuestionnaireSession.findMany.mockResolvedValue([
      { id: 's-1', invitationId: 'inv-1', status: 'active', createdAt: new Date('2026-06-10') },
    ]);
    p.appQuestionnaireInvitation.findMany.mockResolvedValue([
      {
        id: 'inv-1',
        email: 'ada@example.com',
        name: 'Ada',
        status: 'started',
        sentAt: null,
        openedAt: null,
        registeredAt: null,
        createdAt: new Date('2026-06-09'),
      },
    ]);
    // A turn with no recorded duration (_avg.durationMs null) and no _max timestamp.
    p.appQuestionnaireTurn.groupBy.mockResolvedValue([
      {
        sessionId: 's-1',
        _count: { _all: 1 },
        _sum: { promptTokens: 10, completionTokens: 0, costUsd: 0 },
        _avg: { durationMs: null },
        _max: { createdAt: null },
      },
    ]);
    const errAt = new Date('2026-06-11');
    p.appQuestionnaireError.groupBy
      .mockResolvedValueOnce([
        { invitationId: 'inv-1', _count: { _all: 1 }, _max: { createdAt: errAt } },
      ])
      .mockResolvedValueOnce([{ severity: 'error', _count: { _all: 1 } }]);
    mockRawQueries({ duration: [{ avg_ms: null, p95_ms: null }] });

    const result = await getVersionDiagnostics(scope);
    const row = result.invitations[0];
    expect(row.avgTurnMs).toBeNull();
    expect(row.lastActivityAt).toBe(errAt.toISOString());
    expect(result.totals.avgTurnMs).toBeNull();
  });
});

/* ── Where a turn's time goes (P20 Phase 1) ───────────────────────────────── */

describe('getStageLatency', () => {
  it('groups calls by label and reports what each stage adds to an average turn', async () => {
    // 10 turns, 20s of wall-clock between them. Extraction ran on every turn; the seriousness
    // judge only on half — so its per-turn cost is half its own average call, which is exactly
    // the distinction `perTurnMs` exists to make.
    mockRawQueries({
      stages: [
        { label: 'Interviewer phrasing', calls: 10, avg_ms: 900, p95_ms: 1400, total_ms: 9000 },
        { label: 'Answer extraction', calls: 10, avg_ms: 600, p95_ms: 800, total_ms: 6000 },
        { label: 'Seriousness judge', calls: 5, avg_ms: 400, p95_ms: 500, total_ms: 2000 },
      ],
      turnTotals: [{ turns: 10, total_turn_ms: 20_000, total_call_ms: 17_000 }],
    });

    const result = await getStageLatency(['s-1'], scope.from, scope.to);

    expect(result.turns).toBe(10);
    expect(result.stages.map((s) => s.label)).toEqual([
      'Interviewer phrasing',
      'Answer extraction',
      'Seriousness judge',
    ]);
    // Ran on every turn: per-turn cost equals its average call.
    expect(result.stages[0]).toMatchObject({ calls: 10, avgMs: 900, p95Ms: 1400, perTurnMs: 900 });
    // Ran on half the turns: 2000ms spread over 10 turns, not over its own 5 calls.
    expect(result.stages[2]).toMatchObject({ calls: 5, avgMs: 400, perTurnMs: 200 });
  });

  it('reports the wall-clock that was not spent in any model call', async () => {
    mockRawQueries({
      stages: [{ label: 'Answer extraction', calls: 4, avg_ms: 500, p95_ms: 600, total_ms: 2000 }],
      turnTotals: [{ turns: 4, total_turn_ms: 8000, total_call_ms: 2000 }],
    });

    const result = await getStageLatency(['s-1'], scope.from, scope.to);

    // 8000 wall-clock − 2000 in calls = 6000 of database, embedding and persistence: three
    // quarters of the turn, and the finding that would send the whole latency plan back.
    expect(result.residualMs).toBe(6000);
    expect(result.residualShare).toBe(0.75);
    expect(result.totalCallMs).toBe(2000);
  });

  it('clamps the residual at zero when summed call latency exceeds the wall-clock', async () => {
    // What P20 Phase 3 will produce: three stage-1 calls overlapping, so their latencies sum past
    // the turn's own wall-clock. A negative residual is not a measurement — 0 is the honest floor.
    mockRawQueries({
      stages: [{ label: 'Answer extraction', calls: 2, avg_ms: 900, p95_ms: 900, total_ms: 1800 }],
      turnTotals: [{ turns: 2, total_turn_ms: 1200, total_call_ms: 1800 }],
    });

    const result = await getStageLatency(['s-1'], scope.from, scope.to);

    expect(result.residualMs).toBe(0);
    expect(result.residualShare).toBe(0);
    // The raw figures are still reported honestly — only the derived residual is clamped.
    expect(result.totalCallMs).toBe(1800);
    expect(result.totalTurnMs).toBe(1200);
  });

  it('issues no query and returns the zero breakdown when no sessions are in scope', async () => {
    const result = await getStageLatency([], scope.from, scope.to);

    expect(p.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(result).toEqual({
      turns: 0,
      totalTurnMs: 0,
      totalCallMs: 0,
      residualMs: 0,
      residualShare: null,
      stages: [],
    });
  });

  it('drops a call row with no label rather than rendering an unnamed stage', async () => {
    mockRawQueries({
      stages: [
        { label: 'Answer extraction', calls: 1, avg_ms: 500, p95_ms: 500, total_ms: 500 },
        { label: null, calls: 3, avg_ms: 100, p95_ms: 100, total_ms: 300 },
      ],
      turnTotals: [{ turns: 1, total_turn_ms: 900, total_call_ms: 800 }],
    });

    const result = await getStageLatency(['s-1'], scope.from, scope.to);

    expect(result.stages).toHaveLength(1);
    expect(result.stages[0]?.label).toBe('Answer extraction');
  });

  it('reports a null residual share when no turn recorded a duration', async () => {
    mockRawQueries({
      stages: [],
      turnTotals: [{ turns: 0, total_turn_ms: 0, total_call_ms: 0 }],
    });

    const result = await getStageLatency(['s-1'], scope.from, scope.to);

    // Distinguishable from "0% of the turn was overhead" — nothing was measured at all.
    expect(result.residualShare).toBeNull();
    expect(result.stages).toEqual([]);
  });
});

describe('getVersionDiagnostics — stage latency', () => {
  it('surfaces the stage split alongside the invitation rollup', async () => {
    p.appQuestionnaireSession.findMany.mockResolvedValue([
      { id: 's-1', invitationId: null, status: 'active', createdAt: new Date('2026-06-10') },
    ]);
    p.appQuestionnaireInvitation.findMany.mockResolvedValue([]);
    p.appQuestionnaireTurn.groupBy.mockResolvedValue([]);
    p.appQuestionnaireError.groupBy.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    mockRawQueries({
      duration: [{ avg_ms: 1500, p95_ms: 2000 }],
      stages: [
        { label: 'Interviewer phrasing', calls: 2, avg_ms: 900, p95_ms: 900, total_ms: 1800 },
      ],
      turnTotals: [{ turns: 2, total_turn_ms: 3000, total_call_ms: 1800 }],
    });

    const result = await getVersionDiagnostics(scope);

    expect(result.stageLatency.stages).toHaveLength(1);
    expect(result.stageLatency.stages[0]?.label).toBe('Interviewer phrasing');
    expect(result.stageLatency.residualMs).toBe(1200);
    // The pre-existing duration rollup is unaffected by the two extra queries.
    expect(result.totals.avgTurnMs).toBe(1500);
    expect(result.totals.p95TurnMs).toBe(2000);
  });
});
