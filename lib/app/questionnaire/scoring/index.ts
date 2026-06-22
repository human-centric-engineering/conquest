/**
 * Deterministic scoring (report kind `cohort`, F14.4) — public surface.
 *
 * The "hard rules" engine: a versioned scoring schema (scales / item mappings / bands) authored in
 * the visual builder or extracted from a document, the pure {@link scoreSession} engine, and the
 * I/O layer that scores sessions for aggregation + persistence. Server-only at the seam (compute
 * touches Prisma); the `types` + `score` + `schema-validation` modules are pure/client-safe.
 */

export type {
  ScoringScale,
  ScoringItem,
  ScoringBand,
  ScoringSchemaContent,
  ScaleScore,
  RespondentScores,
} from '@/lib/app/questionnaire/scoring/types';
export { EMPTY_SCORING_SCHEMA } from '@/lib/app/questionnaire/scoring/types';
export { scoreSession, type ItemBounds } from '@/lib/app/questionnaire/scoring/score';
export {
  scoringSchemaContentSchema,
  narrowScoringSchemaContent,
} from '@/lib/app/questionnaire/scoring/schema-validation';
export {
  buildScoringInputs,
  scoreSessions,
  recomputeSessionScores,
  type ScoringInputs,
} from '@/lib/app/questionnaire/scoring/compute';
