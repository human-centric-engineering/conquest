/**
 * Ingestion-specific types for the questionnaire extractor (F1.1).
 *
 * Pure data shapes — no Zod, no Prisma, no Next.js. The extraction Zod schema
 * (`extraction-schema.ts`) derives its enums from the `const` tuples here, and
 * the change-record normaliser (`change-records.ts`) returns the version-agnostic
 * `ChangeRecordIntent[]` the route persists in PR4.
 */

import type { AudienceShape } from '@/lib/app/questionnaire/types';

/**
 * The editorial-decision vocabulary recorded on
 * `AppQuestionnaireExtractionChange.changeType`. The write path supports the
 * full set; the F1.1 extractor emits the editorial + inference decisions a
 * conservative-but-opinionated pass produces. A verbatim, unedited question
 * yields NO record.
 *
 * Single source of truth (see `QUESTION_TYPES` in `../types.ts` for the
 * rationale) — the Zod schema derives `z.enum(CHANGE_TYPES)` from this tuple.
 */
export const CHANGE_TYPES = [
  'prune_section',
  'prune_question',
  'correct_spelling',
  'correct_grammar',
  'rewrite_prompt',
  'infer_type',
  'merge_questions',
  'split_question',
  'add_section',
  'augment_question',
  'infer_goal',
  'infer_audience',
] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];

/** What a change record points at. `version` is reserved for `infer_*`. */
export const TARGET_ENTITY_TYPES = ['section', 'question', 'version'] as const;
export type TargetEntityType = (typeof TARGET_ENTITY_TYPES)[number];

/**
 * Change types whose `afterJson` must be null — the data being removed survives
 * only in `beforeJson`, which F2.3 restores on revert.
 */
export const PRUNE_CHANGE_TYPES = ['prune_section', 'prune_question'] as const;

/**
 * Inference change types. They target the VERSION (goal/audience live there),
 * carry the inferred value in `afterJson`, and are suppressed per field when the
 * admin supplied that field.
 */
export const INFER_CHANGE_TYPES = ['infer_goal', 'infer_audience'] as const;
export type InferChangeType = (typeof INFER_CHANGE_TYPES)[number];

/**
 * Metadata an admin supplies on upload. A field being present (even empty
 * string) means "admin owns this" → the extractor must not infer it, and any
 * inference the model reports for it is dropped (produces no change record).
 * Suppression is per field: supplying `audience.role` suppresses only `role`.
 */
export interface AdminSuppliedMetadata {
  goal?: string;
  audience?: Partial<AudienceShape>;
}

/**
 * A normalised, version-agnostic change-record intent. Coherence-checked and
 * inference-suppressed by `normalizeChangeRecords`; the route attaches
 * `versionId` and resolves `targetEntityId` against the persisted graph (PR4).
 * `beforeJson`/`afterJson` are arbitrary JSON (or `null`); `undefined` means the
 * field is omitted from the persisted row.
 */
export interface ChangeRecordIntent {
  changeType: ChangeType;
  targetEntityType: TargetEntityType;
  sourceQuote?: string;
  beforeJson?: unknown;
  afterJson?: unknown;
  rationale?: string;
  confidence?: number;
}
