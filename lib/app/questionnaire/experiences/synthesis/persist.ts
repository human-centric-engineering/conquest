/**
 * Experience-wide synthesis (P15.8) — persistence and the read view.
 *
 * One row per experience, replaced on regeneration. Deliberately no revision chain, unlike
 * `AppCohortReport`: a synthesis is a read of a MOVING target (its input step reports are
 * themselves regenerated and edited), so keeping a history would imply a stability it does not
 * have — revision 3 might rest on step reports that no longer exist in that form. The breakout
 * synthesis makes the same trade for the same reason.
 */

import type { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db/client';
import { narrowToEnum } from '@/lib/app/questionnaire/types';
import {
  EXPERIENCE_SYNTHESIS_STATUSES,
  validateExperienceSynthesisContent,
  type ExperienceSynthesisContent,
  type ExperienceSynthesisStatus,
} from '@/lib/app/questionnaire/experiences/synthesis/types';

/** Cap on the persisted error string, matching the report pipeline's. */
const ERROR_MAX = 1_000;

/** The synthesis as the admin surface renders it. */
export interface ExperienceSynthesisView {
  exists: boolean;
  status: ExperienceSynthesisStatus;
  content: ExperienceSynthesisContent | null;
  coveredSteps: number;
  eligibleSteps: number;
  costUsd: number | null;
  error: string | null;
  /** ISO string, or null when never generated. */
  generatedAt: string | null;
}

/** The empty view — a synthesis that has never been generated. */
function emptyView(): ExperienceSynthesisView {
  return {
    exists: false,
    status: 'queued',
    content: null,
    coveredSteps: 0,
    eligibleSteps: 0,
    costUsd: null,
    error: null,
    generatedAt: null,
  };
}

/** Read the synthesis for one experience. Returns an empty view rather than null when absent. */
export async function getExperienceSynthesisView(
  experienceId: string
): Promise<ExperienceSynthesisView> {
  const row = await prisma.appExperienceSynthesis.findUnique({
    where: { experienceId },
  });
  if (!row) return emptyView();

  return {
    exists: true,
    status: narrowToEnum(row.status, EXPERIENCE_SYNTHESIS_STATUSES, 'queued'),
    // `content` is null until the first successful generation, and stays populated through a later
    // failure — a reader is better served by the previous synthesis plus an error than by nothing.
    content: row.content === null ? null : validateExperienceSynthesisContent(row.content),
    coveredSteps: row.coveredSteps,
    eligibleSteps: row.eligibleSteps,
    costUsd: row.costUsd,
    error: row.error,
    generatedAt: row.generatedAt?.toISOString() ?? null,
  };
}

/** Create the row if absent and mark it processing. Returns its id. */
export async function beginExperienceSynthesis(
  experienceId: string,
  userId: string | null
): Promise<string> {
  const row = await prisma.appExperienceSynthesis.upsert({
    where: { experienceId },
    create: { experienceId, status: 'processing', createdBy: userId },
    update: { status: 'processing', error: null },
    select: { id: true },
  });
  return row.id;
}

/** Store a finished synthesis. */
export async function completeExperienceSynthesis(params: {
  experienceId: string;
  content: ExperienceSynthesisContent;
  coveredSteps: number;
  eligibleSteps: number;
  costUsd: number;
}): Promise<void> {
  await prisma.appExperienceSynthesis.update({
    where: { experienceId: params.experienceId },
    data: {
      status: 'ready',
      // `as unknown as Prisma.InputJsonValue` is the house idiom for a validated content interface
      // (see cohort-report/persist.ts): Prisma's Json input wants an index signature these shaped
      // interfaces deliberately do not carry. Safe — the content has already been through
      // `validateExperienceSynthesisContent`.
      content: params.content as unknown as Prisma.InputJsonValue,
      coveredSteps: params.coveredSteps,
      eligibleSteps: params.eligibleSteps,
      costUsd: params.costUsd,
      error: null,
      generatedAt: new Date(),
    },
  });
}

/**
 * Mark a synthesis failed, preserving any previously generated content.
 *
 * A failed regeneration should not destroy the synthesis the admin already had — they pressed
 * "regenerate" on something that was working, and losing it would make retrying strictly worse than
 * not trying.
 */
export async function failExperienceSynthesis(experienceId: string, error: string): Promise<void> {
  await prisma.appExperienceSynthesis
    .update({
      where: { experienceId },
      data: { status: 'failed', error: error.slice(0, ERROR_MAX) },
    })
    .catch(() => {
      /* the row may not exist if we failed before creating it — nothing to record against */
    });
}
