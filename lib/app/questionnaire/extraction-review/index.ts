/**
 * Public surface of the extraction-change review module (F2.3).
 *
 * Barrel re-export so consumers import from
 * `@/lib/app/questionnaire/extraction-review` rather than reaching into files.
 * The pure revert planner, the list-filter schema + status vocabulary, and the
 * read views. Prisma-free throughout — the executor lives in the route-local
 * `_lib/extraction-review-routes.ts`.
 */

export {
  planRevert,
  isRevertImpossibleReason,
  REVERT_IMPOSSIBLE_REASONS,
} from '@/lib/app/questionnaire/extraction-review/planner';
export type {
  RevertableChange,
  GraphSnapshot,
  SnapshotSection,
  SnapshotQuestion,
  RevertPlan,
  RevertOp,
  RevertPlanResult,
  RevertImpossibleReason,
  NewQuestionSpec,
  QuestionUpdateFields,
  SectionUpdateFields,
} from '@/lib/app/questionnaire/extraction-review/planner';

export {
  listChangesQuerySchema,
  EXTRACTION_CHANGE_STATUSES,
} from '@/lib/app/questionnaire/extraction-review/schemas';
export type {
  ListChangesQuery,
  ExtractionChangeStatus,
} from '@/lib/app/questionnaire/extraction-review/schemas';

export type {
  ExtractionChangeView,
  ExtractionChangeListResponse,
  RevertChangeResult,
} from '@/lib/app/questionnaire/extraction-review/views';
