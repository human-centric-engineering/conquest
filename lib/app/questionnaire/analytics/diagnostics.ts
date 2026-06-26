/**
 * Per-invitation diagnostics aggregation (Diagnostics).
 *
 * Reads the telemetry denormalized onto `AppQuestionnaireTurn` (durationMs / promptTokens /
 * completionTokens / costUsd) and the failures captured in `AppQuestionnaireError`, and rolls them
 * up by invitation so the admin Diagnostics surface can answer "what happened — and what went wrong
 * — for this invitee?".
 *
 * Privacy posture (see `views.ts` header): this is an admin DEBUG tool keyed on the invitation, so
 * it deliberately does NOT apply the low-N k-anonymity suppression the aggregate cost surface does —
 * an admin debugging a tiny pilot still needs the per-invitee view, and already knows whom they
 * invited. It DOES honour the version's `anonymousMode` opt-in: when on, identity (email/name) is
 * withheld while the operational telemetry + errors still show.
 */

import { prisma } from '@/lib/db/client';
import { narrowToEnum, SESSION_STATUSES, type SessionStatus } from '@/lib/app/questionnaire/types';
import type { AgentCallTrace } from '@/lib/app/questionnaire/inspector/types';
import {
  roundSessionFilter,
  type AnalyticsScope,
} from '@/lib/app/questionnaire/analytics/query-schema';
import type {
  DiagnosticsTotals,
  InvitationDiagnosticsRow,
  InvitationDiagnosticsResult,
  DiagnosticsSessionDetail,
  DiagnosticsTurnRow,
  DiagnosticsErrorRow,
  VersionDiagnosticsResult,
} from '@/lib/app/questionnaire/analytics/views';

/** Coerce a raw-SQL numeric aggregate to a finite JS number or null. */
function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

function narrowStatus(status: string): SessionStatus {
  return narrowToEnum<SessionStatus>(status, SESSION_STATUSES, 'active');
}

type SessionLite = {
  id: string;
  invitationId: string | null;
  status: string;
  createdAt: Date;
};

type TelemetryAgg = {
  turns: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  avgTurnMs: number | null;
  lastTurnAt: Date | null;
};

/**
 * Aggregate the per-version Diagnostics view: header totals + one row per invitation (plus a
 * synthetic "(no invitation)" group for walk-up / public sessions and unattributed errors).
 */
export async function getVersionDiagnostics(
  scope: AnalyticsScope
): Promise<VersionDiagnosticsResult> {
  const range = { from: scope.from.toISOString(), to: scope.to.toISOString() };
  const errorWindow = { gte: scope.from, lt: scope.to };

  const [sessions, invitations, config] = await Promise.all([
    prisma.appQuestionnaireSession.findMany({
      where: {
        versionId: scope.versionId,
        isPreview: false,
        ...roundSessionFilter(scope.roundId),
      },
      select: { id: true, invitationId: true, status: true, createdAt: true },
    }),
    prisma.appQuestionnaireInvitation.findMany({
      where: { versionId: scope.versionId },
      select: {
        id: true,
        email: true,
        name: true,
        status: true,
        sentAt: true,
        openedAt: true,
        registeredAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.appQuestionnaireConfig.findUnique({
      where: { versionId: scope.versionId },
      select: { anonymousMode: true },
    }),
  ]);

  const anonymous = config?.anonymousMode ?? false;
  const sessionIds = sessions.map((s) => s.id);

  // Per-session turn telemetry, windowed. `_avg.durationMs` ignores null durations; `_count._all`
  // counts every turn (the small over-weighting that introduces in the per-invitation average is
  // acceptable for a debug surface — the version-level avg/p95 below come from exact raw SQL).
  const turnAgg =
    sessionIds.length > 0
      ? await prisma.appQuestionnaireTurn.groupBy({
          by: ['sessionId'],
          where: { sessionId: { in: sessionIds }, createdAt: errorWindow },
          _count: { _all: true },
          _sum: { promptTokens: true, completionTokens: true, costUsd: true },
          _avg: { durationMs: true },
          _max: { createdAt: true },
        })
      : [];
  const telemetryBySession = new Map(turnAgg.map((t) => [t.sessionId, t]));

  // Errors grouped per invitation (with the latest timestamp) and per severity.
  const [errByInvitation, errBySeverity, durationStats] = await Promise.all([
    prisma.appQuestionnaireError.groupBy({
      by: ['invitationId'],
      where: { versionId: scope.versionId, createdAt: errorWindow },
      _count: { _all: true },
      _max: { createdAt: true },
    }),
    prisma.appQuestionnaireError.groupBy({
      by: ['severity'],
      where: { versionId: scope.versionId, createdAt: errorWindow },
      _count: { _all: true },
    }),
    // Exact version-level mean + p95 turn wall-clock (percentile_cont skips null durations).
    sessionIds.length > 0
      ? prisma.$queryRawUnsafe<{ avg_ms: number | null; p95_ms: number | null }[]>(
          `
          SELECT AVG("durationMs")::float8 AS avg_ms,
                 percentile_cont(0.95) WITHIN GROUP (ORDER BY "durationMs")::float8 AS p95_ms
          FROM "app_questionnaire_turn"
          WHERE "sessionId" = ANY($1::text[]) AND "createdAt" >= $2 AND "createdAt" < $3
          `,
          sessionIds,
          scope.from,
          scope.to
        )
      : Promise.resolve([{ avg_ms: null, p95_ms: null }]),
  ]);

  const errorCountByInvitation = new Map<string | null, number>();
  const errorMaxByInvitation = new Map<string | null, Date | null>();
  for (const row of errByInvitation) {
    errorCountByInvitation.set(row.invitationId, row._count._all);
    errorMaxByInvitation.set(row.invitationId, row._max.createdAt ?? null);
  }

  const errorsBySeverity = { error: 0, warning: 0, info: 0 };
  let errorCount = 0;
  for (const row of errBySeverity) {
    const n = row._count._all;
    errorCount += n;
    if (row.severity === 'error') errorsBySeverity.error += n;
    else if (row.severity === 'warning') errorsBySeverity.warning += n;
    else if (row.severity === 'info') errorsBySeverity.info += n;
  }

  // Group sessions by their invitation. A session whose invitationId is absent (walk-up/public) or
  // points outside the version's invitation set (defensive) folds into the synthetic null group.
  const invitationIds = new Set(invitations.map((i) => i.id));
  const sessionsByInvitation = new Map<string | null, SessionLite[]>();
  for (const s of sessions) {
    const key = s.invitationId && invitationIds.has(s.invitationId) ? s.invitationId : null;
    const list = sessionsByInvitation.get(key) ?? [];
    list.push(s);
    sessionsByInvitation.set(key, list);
  }

  const sumTelemetry = (list: SessionLite[]): TelemetryAgg => {
    let turns = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let costUsd = 0;
    let weightedMs = 0;
    let durTurns = 0;
    let lastTurnAt: Date | null = null;
    for (const s of list) {
      const t = telemetryBySession.get(s.id);
      if (!t) continue;
      const ct = t._count._all;
      turns += ct;
      promptTokens += t._sum.promptTokens ?? 0;
      completionTokens += t._sum.completionTokens ?? 0;
      costUsd += t._sum.costUsd ?? 0;
      if (t._avg.durationMs != null) {
        weightedMs += t._avg.durationMs * ct;
        durTurns += ct;
      }
      const m = t._max.createdAt;
      if (m && (!lastTurnAt || m > lastTurnAt)) lastTurnAt = m;
    }
    return {
      turns,
      promptTokens,
      completionTokens,
      costUsd,
      avgTurnMs: durTurns > 0 ? weightedMs / durTurns : null,
      lastTurnAt,
    };
  };

  const buildRow = (
    invitationId: string | null,
    meta: {
      email: string | null;
      name: string | null;
      status: string | null;
      sentAt: Date | null;
      openedAt: Date | null;
      registeredAt: Date | null;
    },
    list: SessionLite[]
  ): InvitationDiagnosticsRow => {
    const tel = sumTelemetry(list);
    const errCount = errorCountByInvitation.get(invitationId) ?? 0;
    const errMax = errorMaxByInvitation.get(invitationId) ?? null;
    const lastActivity =
      tel.lastTurnAt && errMax
        ? tel.lastTurnAt > errMax
          ? tel.lastTurnAt
          : errMax
        : (tel.lastTurnAt ?? errMax);
    const statuses = [...new Set(list.map((s) => narrowStatus(s.status)))];
    return {
      invitationId,
      email: anonymous ? null : meta.email,
      name: anonymous ? null : meta.name,
      status: meta.status,
      sentAt: iso(meta.sentAt),
      openedAt: iso(meta.openedAt),
      registeredAt: iso(meta.registeredAt),
      sessionCount: list.length,
      sessionStatuses: statuses,
      turns: tel.turns,
      promptTokens: tel.promptTokens,
      completionTokens: tel.completionTokens,
      costUsd: tel.costUsd,
      avgTurnMs: tel.avgTurnMs,
      errorCount: errCount,
      lastActivityAt: iso(lastActivity),
    };
  };

  const rows: InvitationDiagnosticsRow[] = invitations.map((inv) =>
    buildRow(
      inv.id,
      {
        email: inv.email,
        name: inv.name,
        status: inv.status,
        sentAt: inv.sentAt,
        openedAt: inv.openedAt,
        registeredAt: inv.registeredAt,
      },
      sessionsByInvitation.get(inv.id) ?? []
    )
  );

  // Synthetic "(no invitation)" group: walk-up/public sessions and any unattributed errors.
  const noInvSessions = sessionsByInvitation.get(null) ?? [];
  const noInvErrors = errorCountByInvitation.get(null) ?? 0;
  if (noInvSessions.length > 0 || noInvErrors > 0) {
    rows.push(
      buildRow(
        null,
        { email: null, name: null, status: null, sentAt: null, openedAt: null, registeredAt: null },
        noInvSessions
      )
    );
  }

  // Version totals: sum telemetry across all in-scope sessions; avg/p95 from the exact raw query.
  const allTel = sumTelemetry(sessions);
  const totals: DiagnosticsTotals = {
    sessions: sessions.length,
    turns: allTel.turns,
    promptTokens: allTel.promptTokens,
    completionTokens: allTel.completionTokens,
    totalTokens: allTel.promptTokens + allTel.completionTokens,
    costUsd: allTel.costUsd,
    avgTurnMs: numOrNull(durationStats[0]?.avg_ms),
    p95TurnMs: numOrNull(durationStats[0]?.p95_ms),
    errorCount,
    errorsBySeverity,
  };

  return {
    versionId: scope.versionId,
    range,
    totals,
    invitations: rows,
    identitySuppressed: anonymous,
  };
}

/**
 * Drill-down for one invitation: its lifecycle, every session it produced with the full per-turn
 * telemetry timeline (including the raw inspector calls for the deep-dive), and its captured errors.
 * Returns `null` when the invitation doesn't belong to the given version (the route 404s).
 */
export async function getInvitationDiagnostics(
  versionId: string,
  invitationId: string
): Promise<InvitationDiagnosticsResult | null> {
  const [invitation, config] = await Promise.all([
    prisma.appQuestionnaireInvitation.findUnique({
      where: { id: invitationId },
      select: {
        id: true,
        versionId: true,
        email: true,
        name: true,
        status: true,
        sentAt: true,
        openedAt: true,
        registeredAt: true,
        expiresAt: true,
        revokedAt: true,
      },
    }),
    prisma.appQuestionnaireConfig.findUnique({
      where: { versionId },
      select: { anonymousMode: true },
    }),
  ]);
  if (!invitation || invitation.versionId !== versionId) return null;
  const anonymous = config?.anonymousMode ?? false;

  const sessionRows = await prisma.appQuestionnaireSession.findMany({
    where: { invitationId },
    select: { id: true, publicRef: true, status: true, isPreview: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  const sessionIds = sessionRows.map((s) => s.id);

  const turns =
    sessionIds.length > 0
      ? await prisma.appQuestionnaireTurn.findMany({
          where: { sessionId: { in: sessionIds } },
          select: {
            sessionId: true,
            ordinal: true,
            createdAt: true,
            durationMs: true,
            promptTokens: true,
            completionTokens: true,
            costUsd: true,
            toolCalls: true,
            warnings: true,
            inspectorCalls: true,
          },
          orderBy: [{ sessionId: 'asc' }, { ordinal: 'asc' }],
        })
      : [];

  const turnsBySession = new Map<string, DiagnosticsTurnRow[]>();
  let totalTurns = 0;
  let totalPrompt = 0;
  let totalCompletion = 0;
  let totalCost = 0;
  let weightedMs = 0;
  let durTurns = 0;
  for (const t of turns) {
    totalTurns += 1;
    totalPrompt += t.promptTokens ?? 0;
    totalCompletion += t.completionTokens ?? 0;
    totalCost += t.costUsd ?? 0;
    if (t.durationMs != null) {
      weightedMs += t.durationMs;
      durTurns += 1;
    }
    const row: DiagnosticsTurnRow = {
      ordinal: t.ordinal,
      createdAt: t.createdAt.toISOString(),
      durationMs: t.durationMs,
      promptTokens: t.promptTokens,
      completionTokens: t.completionTokens,
      costUsd: t.costUsd,
      toolCalls: t.toolCalls,
      warnings: t.warnings,
      inspectorCalls: (t.inspectorCalls as unknown as AgentCallTrace[]) ?? [],
    };
    const list = turnsBySession.get(t.sessionId) ?? [];
    list.push(row);
    turnsBySession.set(t.sessionId, list);
  }

  const sessions: DiagnosticsSessionDetail[] = sessionRows.map((s) => ({
    sessionId: s.id,
    publicRef: s.publicRef,
    status: narrowStatus(s.status),
    isPreview: s.isPreview,
    createdAt: s.createdAt.toISOString(),
    turns: turnsBySession.get(s.id) ?? [],
  }));

  const errorRows = await prisma.appQuestionnaireError.findMany({
    where: { versionId, invitationId },
    select: {
      id: true,
      createdAt: true,
      scope: true,
      stage: true,
      severity: true,
      code: true,
      message: true,
      stack: true,
      turnOrdinal: true,
      metadata: true,
    },
    orderBy: { createdAt: 'desc' },
  });
  const errors: DiagnosticsErrorRow[] = errorRows.map((e) => ({
    id: e.id,
    createdAt: e.createdAt.toISOString(),
    scope: e.scope,
    stage: e.stage,
    severity: e.severity,
    code: e.code,
    message: e.message,
    stack: e.stack,
    turnOrdinal: e.turnOrdinal,
    metadata: e.metadata,
  }));

  return {
    versionId,
    invitationId: invitation.id,
    email: anonymous ? null : invitation.email,
    name: anonymous ? null : invitation.name,
    status: invitation.status,
    sentAt: iso(invitation.sentAt),
    openedAt: iso(invitation.openedAt),
    registeredAt: iso(invitation.registeredAt),
    expiresAt: iso(invitation.expiresAt),
    revokedAt: iso(invitation.revokedAt),
    sessions,
    errors,
    totals: {
      turns: totalTurns,
      promptTokens: totalPrompt,
      completionTokens: totalCompletion,
      costUsd: totalCost,
      avgTurnMs: durTurns > 0 ? weightedMs / durTurns : null,
      errorCount: errors.length,
    },
    identitySuppressed: anonymous,
  };
}
