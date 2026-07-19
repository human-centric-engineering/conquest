/**
 * Starting an experience run.
 *
 * Mints the run, resolves the entry step's version, creates its session, and records leg 0. The
 * mirror of `advanceExperienceRun`, and it deliberately shares that function's shape: typed
 * rejections rather than thrown errors, so the calling route maps a result to a status rather than
 * catching.
 *
 * Unlike an advance, this IS respondent-initiated, so the caller applies the start rate limit
 * before reaching here.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { generateSessionRef } from '@/lib/app/questionnaire/session-ref';
import { narrowToEnum, ACCESS_MODES } from '@/lib/app/questionnaire/types';
import { EXPERIENCE_STATUSES } from '@/lib/app/questionnaire/experiences/types';
import { createSessionForExperienceLeg } from '@/app/api/v1/app/questionnaire-sessions/_lib/create';

/** A started run, or a typed failure the route maps to an HTTP status. */
export type CreateRunResult =
  | {
      ok: true;
      run: { id: string; publicRef: string | null };
      session: { id: string; versionId: string };
      stepKey: string;
    }
  | { ok: false; status: number; code: string; message: string };

export interface CreateExperienceRunParams {
  experienceId: string;
  respondentUserId: string | null;
  cohortMemberId: string | null;
  /**
   * Whether the caller has already proven the respondent may start — an authenticated cohort
   * member, or an admin preview. When false, the experience's `accessMode` must permit a walk-up.
   */
  accessAlreadyProven: boolean;
}

/**
 * Start a run at the experience's entry step.
 *
 * Never throws: every failure is a typed rejection. A respondent hitting a misconfigured
 * experience should see a clear message, not a 500.
 */
export async function createExperienceRun(
  params: CreateExperienceRunParams
): Promise<CreateRunResult> {
  const experience = await prisma.appExperience.findUnique({
    where: { id: params.experienceId },
    select: {
      id: true,
      status: true,
      accessMode: true,
      steps: {
        where: { kind: 'entry' },
        orderBy: { ordinal: 'asc' },
        select: { id: true, key: true, questionnaireId: true, versionId: true, roundId: true },
      },
    },
  });

  if (!experience) {
    return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Experience not found' };
  }

  // A draft experience is not a secret worth hiding behind a 404 the way a draft questionnaire
  // version is — but it is not runnable either.
  const status = narrowToEnum(experience.status, EXPERIENCE_STATUSES, 'draft');
  if (status !== 'launched') {
    return {
      ok: false,
      status: status === 'archived' ? 410 : 404,
      code: status === 'archived' ? 'EXPERIENCE_ARCHIVED' : 'NOT_FOUND',
      message:
        status === 'archived' ? 'This experience is no longer running' : 'Experience not found',
    };
  }

  if (!params.accessAlreadyProven) {
    const accessMode = narrowToEnum(experience.accessMode, ACCESS_MODES, 'invitation_only');
    if (accessMode === 'invitation_only') {
      return {
        ok: false,
        status: 403,
        code: 'INVITATION_REQUIRED',
        message: 'This experience requires an invitation',
      };
    }
  }

  // Exactly one entry step is the authoring contract, but it is advisory rather than enforced, so
  // the runtime takes the first by ordinal and does not fail a respondent over an authoring slip.
  const entry = experience.steps[0];
  if (!entry?.questionnaireId) {
    logger.warn('experience run: no runnable entry step', { experienceId: experience.id });
    return {
      ok: false,
      status: 409,
      code: 'NO_ENTRY_STEP',
      message: 'This experience has no starting questionnaire yet',
    };
  }

  const versionId =
    entry.versionId ??
    (
      await prisma.appQuestionnaireVersion.findFirst({
        where: { questionnaireId: entry.questionnaireId, status: 'launched', archivedAt: null },
        orderBy: { versionNumber: 'desc' },
        select: { id: true },
      })
    )?.id ??
    null;

  if (!versionId) {
    return {
      ok: false,
      status: 409,
      code: 'ENTRY_NOT_LAUNCHED',
      message: 'The starting questionnaire has no launched version',
    };
  }

  // Create the run first so the leg has something to point at. A run with no legs is a coherent
  // (if brief) state — the reverse would not be.
  const run = await prisma.appExperienceRun.create({
    data: {
      experienceId: experience.id,
      publicRef: generateSessionRef(),
      status: 'active',
      currentStepId: entry.id,
      respondentUserId: params.respondentUserId,
      cohortMemberId: params.cohortMemberId,
    },
    select: { id: true, publicRef: true },
  });

  // Reuses the leg creator rather than `createSessionForVersion`, so leg 0 and every later leg are
  // born identically — same access posture, same limiter bypass, same event reason. The entry leg
  // has no predecessor, hence a null `fromSessionId`: there is no persona or safeguarding state to
  // carry into the first questionnaire a respondent sees.
  const created = await createSessionForExperienceLeg({
    versionId,
    respondentUserId: params.respondentUserId,
    cohortMemberId: params.cohortMemberId,
    roundId: entry.roundId,
    fromSessionId: null,
  });

  if (!created.ok) {
    // Roll the run back rather than leaving an orphan with no legs — a run that never started
    // should not appear in the admin list as if it had.
    await prisma.appExperienceRun.delete({ where: { id: run.id } }).catch((err: unknown) => {
      logger.error('experience run: rollback failed after leg-0 create failure', {
        runId: run.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    return created;
  }

  await prisma.appExperienceRunLeg.create({
    data: {
      runId: run.id,
      stepId: entry.id,
      sessionId: created.session.id,
      ordinal: 0,
      status: 'active',
    },
  });

  return {
    ok: true,
    run,
    session: { id: created.session.id, versionId: created.session.versionId },
    stepKey: entry.key,
  };
}
