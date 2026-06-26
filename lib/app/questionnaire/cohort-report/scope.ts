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

/** The two report owners. `label` is the human display name used in the digest + title. */
export type ReportScope =
  | { kind: 'round'; roundId: string; versionId: string; label: string }
  | { kind: 'version'; versionId: string; label: string };

/** Construct a round-scoped report scope. */
export function roundScope(roundId: string, versionId: string, label: string): ReportScope {
  return { kind: 'round', roundId, versionId, label };
}

/** Construct a version-wide report scope. */
export function versionScope(versionId: string, label: string): ReportScope {
  return { kind: 'version', versionId, label };
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
 * round AND open-ended sessions (no `roundId` constraint). `isPreview: false` always — preview runs
 * never count.
 */
export function scopeSessionWhere(scope: ReportScope): Prisma.AppQuestionnaireSessionWhereInput {
  return {
    versionId: scope.versionId,
    isPreview: false,
    ...(scope.kind === 'round' ? { roundId: scope.roundId } : {}),
  };
}

/**
 * The unique `where` the header `AppCohortReport` is upserted/looked-up on. Round scope keys on the
 * nullable-unique `roundId`; version scope keys on the nullable-unique `versionOwnerId` (= versionId).
 */
export function scopeOwnerWhere(scope: ReportScope): Prisma.AppCohortReportWhereUniqueInput {
  return scope.kind === 'round' ? { roundId: scope.roundId } : { versionOwnerId: scope.versionId };
}

/** The owner-key columns to write when CREATING a header row for this scope. */
export function scopeOwnerCreate(scope: ReportScope): {
  scopeKind: 'round' | 'version';
  roundId: string | null;
  versionOwnerId: string | null;
  versionId: string;
} {
  return scope.kind === 'round'
    ? {
        scopeKind: 'round',
        roundId: scope.roundId,
        versionOwnerId: null,
        versionId: scope.versionId,
      }
    : {
        scopeKind: 'version',
        roundId: null,
        versionOwnerId: scope.versionId,
        versionId: scope.versionId,
      };
}
