/**
 * Admin session-ref browser read model (alpha tooling).
 *
 * The enriched query behind `GET /api/v1/app/questionnaire-sessions/refs`: a paginated, cross-
 * questionnaire list of every session that carries a support reference, with the questionnaire title +
 * version it belongs to (so each row can deep-link the session viewer) plus the client / cohort / round
 * it belongs to (so the browser can show and filter on them). Filters: ref substring, status, preview,
 * questionnaire, version, client, cohort, round, and a created-between window. Sort by created or turns.
 *
 * Route-local DB seam — the `lib/app/questionnaire/**` domain stays Prisma-free, so this read query
 * lives here next to the other admin session reads (`admin-session-view.ts`). The `where`-builder and
 * filter-option loader are shared with the stats read model (`admin-session-stats.ts`).
 */

import { z } from 'zod';
import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db/client';
import { SESSION_STATUSES, narrowToEnum, type SessionStatus } from '@/lib/app/questionnaire/types';
import { formatSessionRef, normalizeSessionRef } from '@/lib/app/questionnaire/session-ref';
import {
  CLIENT_UNASSIGNED,
  ROUND_NONE,
} from '@/lib/app/questionnaire/admin-session-filter-constants';

/** One row of the admin session-ref browser. */
export interface AdminSessionRefItem {
  sessionId: string;
  /** Raw 8-char support reference. */
  ref: string;
  /** Grouped for display (e.g. `7F3K-9M2P`). */
  refFormatted: string;
  status: SessionStatus;
  isPreview: boolean;
  /** ISO timestamp the session was created. */
  createdAt: string;
  questionnaireId: string;
  questionnaireTitle: string;
  versionId: string;
  versionNumber: number;
  /** The attributed demo client (via `questionnaire.demoClientId`), or null when unassigned. */
  clientId: string | null;
  clientName: string | null;
  /** The round this session ran in (via `roundId`), or null when open-ended. */
  roundId: string | null;
  roundName: string | null;
  /** The cohort the round/member belongs to (resolved from `roundId`/`cohortMemberId`), or null. */
  cohortId: string | null;
  cohortName: string | null;
  /** Number of respondent turns taken in the session (one per exchanged message). */
  turns: number;
  /** Answered question slots for this session. */
  answeredCount: number;
  /** Total question slots in the session's version. */
  totalQuestions: number;
  /**
   * Completion percentage — answered slots ÷ total question slots, rounded. Matches the report
   * generator's `completionPct` (a version with no slots reports 100).
   */
  percentComplete: number;
  /**
   * Wall-clock span from the first to the last turn (ms) — how long the session took beginning to
   * end, INCLUDING any idle gaps between sittings. Null with fewer than two turns (nothing to span).
   */
  durationMs: number | null;
  /**
   * Engaged time (ms) — the beginning-to-end span with the idle gaps between sittings removed. For an
   * all-at-once session this equals `durationMs`; for a staged one it's the sum of the active blocks.
   */
  activeMs: number | null;
  /**
   * How many distinct sittings the session was completed in: 1 = all at once, >1 = returned across
   * multiple sittings (a gap over the sitting threshold starts a new one). Null when unknown (no turns).
   */
  sittings: number | null;
}

/**
 * Query params for the browser + stats: pagination, ref search, and the filter set. Sort applies to
 * the list only (stats ignores it). Reused verbatim by the stats route so filters stay in lockstep.
 */
export const adminSessionListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  /** Case-insensitive substring match on the support reference (normalised first). */
  q: z.string().trim().min(1).max(64).optional(),
  status: z.enum(SESSION_STATUSES).optional(),
  /**
   * Real-vs-preview toggle. Preview (admin rehearsal) sessions are HIDDEN by default, so an omitted
   * value — like the explicit `false` — shows real sessions only. `true` shows preview sessions only;
   * `all` shows both.
   */
  isPreview: z.enum(['all', 'true', 'false']).optional(),
  questionnaireId: z.string().trim().min(1).max(64).optional(),
  versionId: z.string().trim().min(1).max(64).optional(),
  /** Demo-client id, or the `unassigned` sentinel for questionnaires with no client. */
  demoClientId: z.string().trim().min(1).max(64).optional(),
  cohortId: z.string().trim().min(1).max(64).optional(),
  /** Round id, or the `none` sentinel for open-ended (round-less) sessions. */
  roundId: z.string().trim().min(1).max(64).optional(),
  /** Inclusive created-between window, `YYYY-MM-DD` (interpreted in UTC). */
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  sort: z.enum(['createdAt', 'turns']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export type AdminSessionListQuery = z.infer<typeof adminSessionListQuerySchema>;

/**
 * Build the Prisma `where` for a filter query. Async because the cohort filter must first resolve the
 * cohort's rounds + members (the session→cohort link is the plain-String `roundId`/`cohortMemberId`
 * pointers — UG-1 house style — so there is no relation to join on). Shared by the list and the stats.
 */
export async function buildAdminSessionWhere(
  query: AdminSessionListQuery
): Promise<Prisma.AppQuestionnaireSessionWhereInput> {
  const {
    q,
    status,
    isPreview,
    questionnaireId,
    versionId,
    demoClientId,
    cohortId,
    roundId,
    from,
    to,
  } = query;

  const where: Prisma.AppQuestionnaireSessionWhereInput = { publicRef: { not: null } };
  if (status) where.status = status;
  // Preview (admin rehearsal) sessions are hidden by default: an omitted or `false` value shows real
  // sessions only, `true` shows preview only, and `all` opts into showing both.
  if (isPreview === 'true') where.isPreview = true;
  else if (isPreview !== 'all') where.isPreview = false;
  if (q) {
    // The stored ref is the normalised (separator-free, upper) form; normalise the query the same way
    // so a pasted `7F3K-9M2P` matches. Substring so a partial ref still finds its session.
    where.publicRef = { contains: normalizeSessionRef(q), mode: 'insensitive' };
  }

  // Created-between window (inclusive). `to` extends to the end of that UTC day so the day is covered.
  if (from || to) {
    where.createdAt = {
      ...(from ? { gte: new Date(`${from}T00:00:00.000Z`) } : {}),
      ...(to ? { lte: new Date(`${to}T23:59:59.999Z`) } : {}),
    };
  }

  // Version scalar + questionnaire/client via the version relation. `demoClientId` lives on the
  // questionnaire (a real FK), so client filtering is a clean join — no round→cohort detour.
  if (versionId) where.versionId = versionId;
  const versionWhere: Prisma.AppQuestionnaireVersionWhereInput = {};
  if (questionnaireId) versionWhere.questionnaireId = questionnaireId;
  if (demoClientId) {
    versionWhere.questionnaire = {
      demoClientId: demoClientId === CLIENT_UNASSIGNED ? null : demoClientId,
    };
  }
  if (Object.keys(versionWhere).length > 0) where.version = versionWhere;

  // Round: a real id filters to that round; the `none` sentinel selects open-ended sessions.
  if (roundId) where.roundId = roundId === ROUND_NONE ? null : roundId;

  // Cohort: resolve the cohort's rounds + members, then match a session that points at either. An
  // empty resolution can never match, so force an impossible clause rather than silently matching all.
  if (cohortId) {
    const [rounds, members] = await Promise.all([
      prisma.appQuestionnaireRound.findMany({ where: { cohortId }, select: { id: true } }),
      prisma.appCohortMember.findMany({ where: { cohortId }, select: { id: true } }),
    ]);
    const or: Prisma.AppQuestionnaireSessionWhereInput[] = [];
    if (rounds.length > 0) or.push({ roundId: { in: rounds.map((r) => r.id) } });
    if (members.length > 0) or.push({ cohortMemberId: { in: members.map((m) => m.id) } });
    where.OR = or.length > 0 ? or : [{ id: '__no_match__' }];
  }

  return where;
}

/**
 * List sessions that carry a support reference for the alpha ref browser, filtered + sorted per the
 * query. Returns the page of items plus the unpaginated `total` for the pager.
 */
export async function listAdminSessionRefs(
  query: AdminSessionListQuery
): Promise<{ items: AdminSessionRefItem[]; total: number }> {
  const { page, limit, sort, order } = query;
  const where = await buildAdminSessionWhere(query);

  const orderBy: Prisma.AppQuestionnaireSessionOrderByWithRelationInput =
    sort === 'turns' ? { turns: { _count: order } } : { createdAt: order };

  const [rows, total] = await Promise.all([
    prisma.appQuestionnaireSession.findMany({
      where,
      orderBy,
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        publicRef: true,
        status: true,
        isPreview: true,
        createdAt: true,
        versionId: true,
        roundId: true,
        cohortMemberId: true,
        version: {
          select: {
            versionNumber: true,
            questionnaireId: true,
            questionnaire: {
              select: { title: true, demoClient: { select: { id: true, name: true } } },
            },
          },
        },
        // Turn count (one row per respondent exchange) and answered-slot count, both derived — the
        // session stores neither. Answered feeds the completion percentage below.
        _count: { select: { turns: true, answers: true } },
      },
    }),
    prisma.appQuestionnaireSession.count({ where }),
  ]);

  // Total question slots per version — the denominator for completion. One grouped count over the
  // versions on this page (slot rows carry a denormalised `versionId`), so no per-row query.
  const versionIds = [...new Set(rows.map((r) => r.versionId))];
  const slotCounts = versionIds.length
    ? await prisma.appQuestionSlot.groupBy({
        by: ['versionId'],
        where: { versionId: { in: versionIds } },
        _count: { _all: true },
      })
    : [];
  const totalByVersion = new Map(slotCounts.map((g) => [g.versionId, g._count._all]));

  // Cohort/round names live behind the plain-String `roundId`/`cohortMemberId` pointers (UG-1, no
  // relation), so resolve them in batched lookups keyed on the page's distinct ids.
  const cohortBySession = await resolveCohortRound(rows);

  // Session timing (duration + sittings) is derived from the turn timestamps — the session stores
  // neither. One batched read over the page's sessions, grouped in memory.
  const timingBySession = await resolveTiming(rows.map((r) => r.id));

  const items: AdminSessionRefItem[] = [];
  for (const r of rows) {
    // `publicRef` is filtered non-null above; `version` is a required relation. Guard defensively so a
    // malformed row is skipped rather than crashing the whole page.
    if (!r.publicRef || !r.version) continue;
    const answeredCount = r._count.answers;
    const totalQuestions = totalByVersion.get(r.versionId) ?? 0;
    // Same formula as the report generator's `completionPct`: a version with no slots reports 100.
    const percentComplete =
      totalQuestions > 0 ? Math.round((answeredCount / totalQuestions) * 100) : 100;
    const cr = cohortBySession.get(r.id);
    const timing = timingBySession.get(r.id) ?? {
      durationMs: null,
      activeMs: null,
      sittings: null,
    };
    items.push({
      sessionId: r.id,
      ref: r.publicRef,
      refFormatted: formatSessionRef(r.publicRef),
      status: narrowToEnum(r.status, SESSION_STATUSES, 'active'),
      isPreview: r.isPreview,
      createdAt: r.createdAt.toISOString(),
      questionnaireId: r.version.questionnaireId,
      questionnaireTitle: r.version.questionnaire.title,
      versionId: r.versionId,
      versionNumber: r.version.versionNumber,
      clientId: r.version.questionnaire.demoClient?.id ?? null,
      clientName: r.version.questionnaire.demoClient?.name ?? null,
      roundId: r.roundId,
      roundName: cr?.roundName ?? null,
      cohortId: cr?.cohortId ?? null,
      cohortName: cr?.cohortName ?? null,
      turns: r._count.turns,
      answeredCount,
      totalQuestions,
      percentComplete,
      durationMs: timing.durationMs,
      activeMs: timing.activeMs,
      sittings: timing.sittings,
    });
  }

  return { items, total };
}

/**
 * A gap longer than this between two consecutive turns is read as the respondent leaving and coming
 * back — i.e. a new sitting. 30 minutes comfortably clears normal thinking/typing pauses.
 */
const SITTING_GAP_MS = 30 * 60 * 1000;

/** Session-level timing derived from a session's turn timestamps. */
interface SessionTiming {
  durationMs: number | null;
  activeMs: number | null;
  sittings: number | null;
}

/**
 * Batch-derive each session's duration + sittings from its turn timestamps. `durationMs` is the
 * first→last span (idle gaps included); `activeMs` removes the inter-sitting gaps; `sittings` counts
 * the continuous blocks (a gap over {@link SITTING_GAP_MS} starts a new one).
 */
async function resolveTiming(sessionIds: string[]): Promise<Map<string, SessionTiming>> {
  const out = new Map<string, SessionTiming>();
  if (sessionIds.length === 0) return out;

  const turns = await prisma.appQuestionnaireTurn.findMany({
    where: { sessionId: { in: sessionIds } },
    select: { sessionId: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  const bySession = new Map<string, number[]>();
  for (const t of turns) {
    const arr = bySession.get(t.sessionId);
    if (arr) arr.push(t.createdAt.getTime());
    else bySession.set(t.sessionId, [t.createdAt.getTime()]);
  }

  for (const [sessionId, times] of bySession) {
    out.set(sessionId, computeTiming(times));
  }
  return out;
}

/** Compute duration + active time + sittings from a session's ascending turn timestamps (ms). */
function computeTiming(times: number[]): SessionTiming {
  if (times.length < 2) {
    // Nothing (or a lone kickoff turn) to span — one sitting at most, no meaningful duration.
    return { durationMs: null, activeMs: null, sittings: times.length === 1 ? 1 : null };
  }
  const durationMs = times[times.length - 1] - times[0];
  let sittings = 1;
  let activeMs = 0;
  let sittingStart = times[0];
  for (let i = 1; i < times.length; i++) {
    const gap = times[i] - times[i - 1];
    if (gap > SITTING_GAP_MS) {
      activeMs += times[i - 1] - sittingStart; // close the block at the last turn before the gap
      sittings += 1;
      sittingStart = times[i];
    }
  }
  activeMs += times[times.length - 1] - sittingStart;
  return { durationMs, activeMs, sittings };
}

/** Resolved cohort/round labels for one session, keyed by session id. */
interface CohortRound {
  roundName: string | null;
  cohortId: string | null;
  cohortName: string | null;
}

/**
 * Batch-resolve each session's round name + cohort from its `roundId`/`cohortMemberId` pointers. A
 * session's cohort is its round's cohort, else (round-less) its cohort member's cohort.
 */
async function resolveCohortRound(
  rows: { id: string; roundId: string | null; cohortMemberId: string | null }[]
): Promise<Map<string, CohortRound>> {
  const roundIds = [...new Set(rows.map((r) => r.roundId).filter((v): v is string => Boolean(v)))];
  const memberIds = [
    ...new Set(rows.map((r) => r.cohortMemberId).filter((v): v is string => Boolean(v))),
  ];

  const [rounds, members] = await Promise.all([
    roundIds.length
      ? prisma.appQuestionnaireRound.findMany({
          where: { id: { in: roundIds } },
          select: { id: true, name: true, cohortId: true },
        })
      : Promise.resolve([]),
    memberIds.length
      ? prisma.appCohortMember.findMany({
          where: { id: { in: memberIds } },
          select: { id: true, cohortId: true },
        })
      : Promise.resolve([]),
  ]);

  const roundById = new Map(rounds.map((r) => [r.id, r]));
  const memberById = new Map(members.map((m) => [m.id, m]));

  const cohortIds = [
    ...new Set([...rounds.map((r) => r.cohortId), ...members.map((m) => m.cohortId)]),
  ];
  const cohorts = cohortIds.length
    ? await prisma.appCohort.findMany({
        where: { id: { in: cohortIds } },
        select: { id: true, name: true },
      })
    : [];
  const cohortById = new Map(cohorts.map((c) => [c.id, c]));

  const out = new Map<string, CohortRound>();
  for (const r of rows) {
    const round = r.roundId ? roundById.get(r.roundId) : undefined;
    const member = r.cohortMemberId ? memberById.get(r.cohortMemberId) : undefined;
    const cohortId = round?.cohortId ?? member?.cohortId ?? null;
    out.set(r.id, {
      roundName: round?.name ?? null,
      cohortId,
      cohortName: cohortId ? (cohortById.get(cohortId)?.name ?? null) : null,
    });
  }
  return out;
}

/** Dropdown option lists for the browser's filter bar (loaded once, SSR-seeded). */
export interface AdminSessionFilterOptions {
  clients: { id: string; name: string }[];
  questionnaires: { id: string; title: string }[];
  cohorts: { id: string; name: string; clientName: string }[];
  rounds: { id: string; name: string; cohortId: string }[];
  /** Whether any ref-carrying session has no round (gates the "Open-ended" round option). */
  hasOpenEnded: boolean;
  /** Whether any questionnaire has no client (gates the "Unassigned" client option). */
  hasUnassignedClient: boolean;
}

/** Load the filter-bar option lists. Static relative to the filters, so the page seeds it once. */
export async function loadAdminSessionFilterOptions(): Promise<AdminSessionFilterOptions> {
  const [clients, questionnaires, cohorts, rounds, openEndedCount, unassignedCount] =
    await Promise.all([
      prisma.appDemoClient.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      prisma.appQuestionnaire.findMany({
        select: { id: true, title: true },
        orderBy: { title: 'asc' },
      }),
      prisma.appCohort.findMany({
        select: { id: true, name: true, demoClient: { select: { name: true } } },
        orderBy: { name: 'asc' },
      }),
      prisma.appQuestionnaireRound.findMany({
        select: { id: true, name: true, cohortId: true },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.appQuestionnaireSession.count({ where: { publicRef: { not: null }, roundId: null } }),
      prisma.appQuestionnaire.count({ where: { demoClientId: null } }),
    ]);

  return {
    clients,
    questionnaires,
    cohorts: cohorts.map((c) => ({ id: c.id, name: c.name, clientName: c.demoClient.name })),
    rounds,
    hasOpenEnded: openEndedCount > 0,
    hasUnassignedClient: unassignedCount > 0,
  };
}
