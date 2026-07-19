/**
 * Experiences — read models (the Prisma seam).
 *
 * `lib/app/questionnaire/experiences/**` is Prisma-free, so the queries live here and the shapes +
 * narrowing live there. Every serializer projects through the shared selections below, so list,
 * detail, create and update cannot drift apart.
 *
 * Steps carry their questionnaire's title and (when pinned) version number. Those are resolved by
 * TWO batched queries for the whole page — never per row: the repo's no-N+1 rule, and the reason
 * the step views take their resolved fields as an argument rather than fetching them.
 */

import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db/client';
import {
  toExperienceDetailView,
  toExperienceListView,
  toExperienceStepView,
  type ExperienceDetailView,
  type ExperienceListView,
  type ExperienceStepView,
} from '@/lib/app/questionnaire/experiences/views';
import type { ListExperiencesQuery } from '@/lib/app/questionnaire/experiences/schemas';

/** Every column the experience serializers read, plus the client name and step count. */
export const EXPERIENCE_SELECT = {
  id: true,
  demoClientId: true,
  title: true,
  description: true,
  kind: true,
  status: true,
  continuityMode: true,
  routingFallback: true,
  minRoutingConfidence: true,
  routingInstructions: true,
  costBudgetUsd: true,
  accessMode: true,
  publicRef: true,
  cohortId: true,
  createdBy: true,
  settings: true,
  createdAt: true,
  updatedAt: true,
  demoClient: { select: { name: true } },
  _count: { select: { steps: true } },
} as const satisfies Prisma.AppExperienceSelect;

type ExperienceRowWithRelations = Prisma.AppExperienceGetPayload<{
  select: typeof EXPERIENCE_SELECT;
}>;

/** Every column the step serializer reads. */
export const EXPERIENCE_STEP_SELECT = {
  id: true,
  experienceId: true,
  key: true,
  kind: true,
  questionnaireId: true,
  versionId: true,
  roundId: true,
  title: true,
  purpose: true,
  selectionCriteria: true,
  ordinal: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.AppExperienceStepSelect;

type ExperienceStepRowSelected = Prisma.AppExperienceStepGetPayload<{
  select: typeof EXPERIENCE_STEP_SELECT;
}>;

/** Project one experience row into the list view. */
export function toListView(row: ExperienceRowWithRelations): ExperienceListView {
  return toExperienceListView(row, row.demoClient?.name ?? null, row._count.steps);
}

/**
 * Resolve the display metadata a batch of steps points at, in two queries regardless of step
 * count.
 *
 * Pointers are unmodelled (UG-1), so a step may reference a questionnaire or version that has
 * since been deleted. Missing ids simply do not appear in the maps and surface as `null` in the
 * view — a dangling pointer must render as "missing", never throw.
 */
async function resolveStepTargets(steps: readonly ExperienceStepRowSelected[]): Promise<{
  titles: Map<string, string>;
  versionNumbers: Map<string, number>;
}> {
  const questionnaireIds = [
    ...new Set(steps.map((s) => s.questionnaireId).filter((id): id is string => id !== null)),
  ];
  const versionIds = [
    ...new Set(steps.map((s) => s.versionId).filter((id): id is string => id !== null)),
  ];

  const [questionnaires, versions] = await Promise.all([
    questionnaireIds.length
      ? prisma.appQuestionnaire.findMany({
          where: { id: { in: questionnaireIds } },
          select: { id: true, title: true },
        })
      : Promise.resolve([]),
    versionIds.length
      ? prisma.appQuestionnaireVersion.findMany({
          where: { id: { in: versionIds } },
          select: { id: true, versionNumber: true },
        })
      : Promise.resolve([]),
  ]);

  return {
    titles: new Map(questionnaires.map((q) => [q.id, q.title])),
    versionNumbers: new Map(versions.map((v) => [v.id, v.versionNumber])),
  };
}

/** Project step rows into views, resolving their targets in a single batch. */
export async function toStepViews(
  steps: readonly ExperienceStepRowSelected[]
): Promise<ExperienceStepView[]> {
  const { titles, versionNumbers } = await resolveStepTargets(steps);
  return steps.map((step) =>
    toExperienceStepView(step, {
      questionnaireTitle: step.questionnaireId ? (titles.get(step.questionnaireId) ?? null) : null,
      versionNumber: step.versionId ? (versionNumbers.get(step.versionId) ?? null) : null,
    })
  );
}

/** List experiences, newest-first, with optional status / kind / client filters. */
export async function listExperiences(
  filters: ListExperiencesQuery = {}
): Promise<ExperienceListView[]> {
  const rows = await prisma.appExperience.findMany({
    where: {
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.kind ? { kind: filters.kind } : {}),
      ...(filters.demoClientId ? { demoClientId: filters.demoClientId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    select: EXPERIENCE_SELECT,
  });
  return rows.map(toListView);
}

/** Load one experience with its ordered steps, or null when it does not exist. */
export async function getExperienceDetail(id: string): Promise<ExperienceDetailView | null> {
  const row = await prisma.appExperience.findUnique({
    where: { id },
    select: EXPERIENCE_SELECT,
  });
  if (!row) return null;

  const steps = await prisma.appExperienceStep.findMany({
    where: { experienceId: id },
    orderBy: [{ ordinal: 'asc' }, { createdAt: 'asc' }],
    select: EXPERIENCE_STEP_SELECT,
  });

  return toExperienceDetailView(row, row.demoClient?.name ?? null, await toStepViews(steps));
}

/** Counts for the list page's stat tiles, in one grouped query. */
export async function experienceStatusCounts(): Promise<{
  total: number;
  draft: number;
  launched: number;
  archived: number;
}> {
  const grouped = await prisma.appExperience.groupBy({
    by: ['status'],
    _count: { _all: true },
  });
  const byStatus = new Map(grouped.map((g) => [g.status, g._count._all]));
  const draft = byStatus.get('draft') ?? 0;
  const launched = byStatus.get('launched') ?? 0;
  const archived = byStatus.get('archived') ?? 0;
  return {
    // Sum the grouped rows rather than the three known statuses, so a row carrying an
    // unrecognised status still counts toward the total instead of vanishing from it.
    total: grouped.reduce((sum, g) => sum + g._count._all, 0),
    draft,
    launched,
    archived,
  };
}
