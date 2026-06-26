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
} from '@/lib/app/questionnaire/analytics/diagnostics';
import type { AnalyticsScope } from '@/lib/app/questionnaire/analytics/query-schema';

const p = mocks.prisma;
const scope: AnalyticsScope = {
  versionId: 'v-1',
  from: new Date('2026-06-01T00:00:00Z'),
  to: new Date('2026-07-01T00:00:00Z'),
  tagIds: [],
};

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
    p.$queryRawUnsafe.mockResolvedValue([{ avg_ms: 800, p95_ms: 950 }]);

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
    p.$queryRawUnsafe.mockResolvedValue([{ avg_ms: 500, p95_ms: 500 }]);

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
    p.$queryRawUnsafe.mockResolvedValue([{ avg_ms: 600, p95_ms: 600 }]);

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
    p.$queryRawUnsafe.mockResolvedValue([{ avg_ms: null, p95_ms: null }]);

    const result = await getVersionDiagnostics(scope);
    const row = result.invitations[0];
    expect(row.avgTurnMs).toBeNull();
    expect(row.lastActivityAt).toBe(errAt.toISOString());
    expect(result.totals.avgTurnMs).toBeNull();
  });
});
