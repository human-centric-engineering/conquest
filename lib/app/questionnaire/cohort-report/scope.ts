/**
 * Report scope — the polymorphic owner of a synthesis report (cohort report kind).
 *
 * A report is generated for one of two owners:
 *  - `round`   — one round's submissions (the original cohort report, F14.3).
 *  - `version` — all of a version's completed sessions, across every round AND open-ended
 *                (non-round) sessions: the version-wide cross-round synthesis.
 *
 * Both share the entire generation pipeline (dataset → digest → agent → revision → publish → PDF);
 * the ONLY differences are the session `where` clause, the display label, the round-only context
 * lookups, and the header upsert key. This module is the single place those differences are encoded,
 * so the dataset/generator/persist/view layers stay owner-agnostic. Pure + client-safe (no Prisma).
 */

import type { Prisma } from '@prisma/client';

/** The three report owners. `label` is the human display name used in the digest + title. */
export type ReportScope =
  | { kind: 'round'; roundId: string; versionId: string; label: string }
  | { kind: 'version'; versionId: string; label: string }
  | { kind: 'experience_step'; stepId: string; versionId: string; label: string };

/** Construct a round-scoped report scope. */
export function roundScope(roundId: string, versionId: string, label: string): ReportScope {
  return { kind: 'round', roundId, versionId, label };
}

/** Construct a version-wide report scope. */
export function versionScope(versionId: string, label: string): ReportScope {
  return { kind: 'version', versionId, label };
}

/**
 * Construct an experience-step-scoped report scope (F15.4) — the legs of one step of one journey.
 *
 * **Per STEP, never per experience.** A step pins exactly one questionnaire version, so this scope
 * still carries a single `versionId` and every assumption the pipeline already makes holds:
 * `buildCohortDataset` resolves questions, data slots, profile fields and the scoring schema by
 * that one `versionId`, and `chart-series.ts` resolves specs against ids stable within it.
 *
 * An experience-wide scope would break that outright. Different steps run different versions whose
 * data-slot rows are distinct `AppDataSlot` ids, and `buildDataSlots` joins fills by `dataSlotId`
 * — fills from another version would find no bucket and be **silently dropped**, producing a
 * confident report over a fraction of the data. The experience-wide view is therefore a synthesis
 * over ready step reports, not a re-aggregation.
 */
export function experienceStepScope(stepId: string, versionId: string, label: string): ReportScope {
  return { kind: 'experience_step', stepId, versionId, label };
}

/** The owning experience step id, or null for any other scope. */
export function scopeStepId(scope: ReportScope): string | null {
  return scope.kind === 'experience_step' ? scope.stepId : null;
}

/** The version whose sessions/questions/data-slots the report analyses (set for both kinds). */
export function scopeVersionId(scope: ReportScope): string {
  return scope.versionId;
}

/** The owning round id, or null for a version-wide report. */
export function scopeRoundId(scope: ReportScope): string | null {
  return scope.kind === 'round' ? scope.roundId : null;
}

/** Human label for the dataset digest + default report title. */
export function scopeLabel(scope: ReportScope): string {
  return scope.label;
}

/**
 * The session `where` filter for this scope. Round scope pins `roundId`; version scope spans every
 * round AND open-ended sessions (no `roundId` constraint); experience-step scope pins the
 * denormalised `experienceStepId`. `isPreview: false` always — preview runs never count.
 *
 * The step filter reads `AppQuestionnaireSession.experienceStepId` rather than joining through
 * `AppExperienceRunLeg`, because that pointer is unmodelled (UG-1) and there is no relation to
 * join. Filtering on `versionId` alone would NOT be equivalent: it would sweep in every ordinary
 * round and walk-up session on the same questionnaire and report them as part of the journey.
 */
export function scopeSessionWhere(scope: ReportScope): Prisma.AppQuestionnaireSessionWhereInput {
  return {
    versionId: scope.versionId,
    isPreview: false,
    ...(scope.kind === 'round' ? { roundId: scope.roundId } : {}),
    ...(scope.kind === 'experience_step' ? { experienceStepId: scope.stepId } : {}),
  };
}

/**
 * The unique `where` the header `AppCohortReport` is upserted/looked-up on. Each scope keys on its
 * own nullable-unique owner column: `roundId`, `versionOwnerId` (= versionId), or
 * `experienceStepOwnerId`. Postgres permits multiple NULLs in a unique index, so the three coexist.
 */
export function scopeOwnerWhere(scope: ReportScope): Prisma.AppCohortReportWhereUniqueInput {
  switch (scope.kind) {
    case 'round':
      return { roundId: scope.roundId };
    case 'version':
      return { versionOwnerId: scope.versionId };
    case 'experience_step':
      return { experienceStepOwnerId: scope.stepId };
  }
}

/** The owner-key columns to write when CREATING a header row for this scope. */
export function scopeOwnerCreate(scope: ReportScope): {
  scopeKind: 'round' | 'version' | 'experience_step';
  roundId: string | null;
  versionOwnerId: string | null;
  experienceStepOwnerId: string | null;
  versionId: string;
} {
  // Exhaustive switch rather than a ternary chain: adding a fourth scope kind must fail to compile
  // here, not silently write a row with every owner key null and collide with the next one.
  switch (scope.kind) {
    case 'round':
      return {
        scopeKind: 'round',
        roundId: scope.roundId,
        versionOwnerId: null,
        experienceStepOwnerId: null,
        versionId: scope.versionId,
      };
    case 'version':
      return {
        scopeKind: 'version',
        roundId: null,
        versionOwnerId: scope.versionId,
        experienceStepOwnerId: null,
        versionId: scope.versionId,
      };
    case 'experience_step':
      return {
        scopeKind: 'experience_step',
        roundId: null,
        versionOwnerId: null,
        experienceStepOwnerId: scope.stepId,
        versionId: scope.versionId,
      };
  }
}
