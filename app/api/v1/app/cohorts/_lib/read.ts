/**
 * Cohorts & Rounds — cohort read models.
 *
 * The list + detail serializers behind the cohort GET endpoints. Route-local DB seam (the
 * `lib/app/questionnaire/**` module is Prisma-free). Enriched in a FIXED query budget — no
 * per-row N+1 (the `questionnaires/_lib/list.ts` discipline): one cohorts query (with filtered
 * `_count` for active members + rounds), one rounds sweep to map rounds→cohorts, and one
 * session sweep folded by {@link sessionCountsByRound}.
 */

import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db/client';
import { narrowToEnum } from '@/lib/app/questionnaire/types';
import {
  COHORT_MEMBER_STATUSES,
  type CohortDetail,
  type CohortMemberView,
  type CohortSubgroupView,
  type CohortView,
} from '@/lib/app/questionnaire/rounds/types';
import {
  sessionCountsByRound,
  toCompletionStats,
  type RoundSessionCounts,
} from '@/app/api/v1/app/rounds/_lib/stats';

/** Identity columns + the headline counts shared by every cohort list/detail serializer. */
const COHORT_SELECT = {
  id: true,
  demoClientId: true,
  name: true,
  description: true,
  introBackground: true,
  createdAt: true,
  updatedAt: true,
  // Filtered relation count: only ACTIVE members make the headline roster size.
  _count: { select: { members: { where: { status: 'active' } }, rounds: true } },
} as const satisfies Prisma.AppCohortSelect;

type CohortRow = Prisma.AppCohortGetPayload<{ select: typeof COHORT_SELECT }>;

const COHORT_MEMBER_SELECT = {
  id: true,
  cohortId: true,
  subgroupId: true,
  email: true,
  name: true,
  notes: true,
  status: true,
  addedAt: true,
  removedAt: true,
} as const satisfies Prisma.AppCohortMemberSelect;

type CohortMemberRow = Prisma.AppCohortMemberGetPayload<{ select: typeof COHORT_MEMBER_SELECT }>;

export function toCohortMemberView(row: CohortMemberRow): CohortMemberView {
  return {
    id: row.id,
    cohortId: row.cohortId,
    email: row.email,
    name: row.name,
    notes: row.notes,
    status: narrowToEnum(row.status, COHORT_MEMBER_STATUSES, 'active'),
    subgroupId: row.subgroupId,
    addedAt: row.addedAt.toISOString(),
    removedAt: row.removedAt ? row.removedAt.toISOString() : null,
  };
}

/** Identity columns + active-member count shared by every subgroup serializer. */
const COHORT_SUBGROUP_SELECT = {
  id: true,
  cohortId: true,
  name: true,
  description: true,
  ordinal: true,
  createdAt: true,
  updatedAt: true,
  // Only ACTIVE members count toward a subgroup's headline size (mirrors the cohort roster rule).
  _count: { select: { members: { where: { status: 'active' } } } },
} as const satisfies Prisma.AppCohortSubgroupSelect;

type CohortSubgroupRow = Prisma.AppCohortSubgroupGetPayload<{
  select: typeof COHORT_SUBGROUP_SELECT;
}>;

export function toCohortSubgroupView(row: CohortSubgroupRow): CohortSubgroupView {
  return {
    id: row.id,
    cohortId: row.cohortId,
    name: row.name,
    description: row.description,
    ordinal: row.ordinal,
    memberCount: row._count.members,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** A cohort's subgroups (by ordinal, then name), or null when the cohort is unknown. */
export async function listCohortSubgroups(cohortId: string): Promise<CohortSubgroupView[] | null> {
  const cohort = await prisma.appCohort.findUnique({
    where: { id: cohortId },
    select: { id: true },
  });
  if (!cohort) return null;
  const rows = await prisma.appCohortSubgroup.findMany({
    where: { cohortId },
    orderBy: [{ ordinal: 'asc' }, { name: 'asc' }],
    select: COHORT_SUBGROUP_SELECT,
  });
  return rows.map(toCohortSubgroupView);
}

function toCohortView(row: CohortRow, stats: RoundSessionCounts | undefined): CohortView {
  return {
    id: row.id,
    demoClientId: row.demoClientId,
    name: row.name,
    description: row.description,
    introBackground: row.introBackground,
    memberCount: row._count.members,
    roundCount: row._count.rounds,
    stats: toCompletionStats(stats),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Cohorts for a demo client, newest-first, each with active-member + round counts and a
 * completion roll-up across all of the cohort's rounds. `q` filters by name
 * (case-insensitive contains).
 */
export async function listCohorts(demoClientId: string, q?: string): Promise<CohortView[]> {
  const where: Prisma.AppCohortWhereInput = { demoClientId };
  if (q && q.trim()) where.name = { contains: q.trim(), mode: 'insensitive' };

  const rows = await prisma.appCohort.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    select: COHORT_SELECT,
  });
  if (rows.length === 0) return [];

  // Map each cohort's rounds, then fold session stats up from round → cohort (no N+1).
  const cohortIds = rows.map((r) => r.id);
  const rounds = await prisma.appQuestionnaireRound.findMany({
    where: { cohortId: { in: cohortIds } },
    select: { id: true, cohortId: true },
  });
  const roundToCohort = new Map(rounds.map((r) => [r.id, r.cohortId]));
  const perRound = await sessionCountsByRound(rounds.map((r) => r.id));

  const perCohort = new Map<string, RoundSessionCounts>();
  for (const [roundId, counts] of perRound) {
    const cohortId = roundToCohort.get(roundId);
    if (!cohortId) continue;
    const entry = perCohort.get(cohortId) ?? { started: 0, completed: 0 };
    entry.started += counts.started;
    entry.completed += counts.completed;
    perCohort.set(cohortId, entry);
  }

  return rows.map((row) => toCohortView(row, perCohort.get(row.id)));
}

/** One cohort by id (with its roster, active first then by name), or null when absent. */
export async function getCohortDetail(id: string): Promise<CohortDetail | null> {
  const row = await prisma.appCohort.findUnique({
    where: { id },
    select: {
      ...COHORT_SELECT,
      members: { select: COHORT_MEMBER_SELECT },
      subgroups: { orderBy: [{ ordinal: 'asc' }, { name: 'asc' }], select: COHORT_SUBGROUP_SELECT },
    },
  });
  if (!row) return null;

  const rounds = await prisma.appQuestionnaireRound.findMany({
    where: { cohortId: id },
    select: { id: true },
  });
  const perRound = await sessionCountsByRound(rounds.map((r) => r.id));
  const stats: RoundSessionCounts = { started: 0, completed: 0 };
  for (const counts of perRound.values()) {
    stats.started += counts.started;
    stats.completed += counts.completed;
  }

  const members = row.members.map(toCohortMemberView).sort((a, b) => {
    // Active members first, then alphabetical by name.
    if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const subgroups = row.subgroups.map(toCohortSubgroupView);

  return { ...toCohortView(row, stats), members, subgroups };
}

/** A cohort's roster (active first, then by name), or null when the cohort is unknown. */
export async function listCohortMembers(cohortId: string): Promise<CohortMemberView[] | null> {
  const cohort = await prisma.appCohort.findUnique({
    where: { id: cohortId },
    select: { id: true, members: { select: COHORT_MEMBER_SELECT } },
  });
  if (!cohort) return null;
  return cohort.members.map(toCohortMemberView).sort((a, b) => {
    if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** Whether a demo client exists (the cohort-create FK target). Cheap existence probe. */
export async function demoClientExists(demoClientId: string): Promise<boolean> {
  const found = await prisma.appDemoClient.findUnique({
    where: { id: demoClientId },
    select: { id: true },
  });
  return found !== null;
}
