/**
 * Design-time evaluation contract and in-memory shapes (F5.1).
 *
 * P5 lets an admin evaluate a questionnaire **version's structure** against its stated
 * `goal` and `audience` using a panel of LLM judges — one per dimension (clarity,
 * coverage, duplicates, type fit, ordering, audience match, goal match). Unlike the
 * P4 conversational engine, there is no respondent and no session: the judges read an
 * artefact that already exists (the authored structure) and emit **actionable
 * findings** — concrete proposed edits — that F5.3's review queue will turn into
 * accept/decline/apply rows.
 *
 * This module owns the **pure, DB-free** half: the dimension vocabulary, the judge
 * output contract, and the prompt builder. Like F4.1–F4.5 it imports no Prisma and no
 * Next.js — the dispatch capability and the preview route (F5.1 PR2) supply the I/O
 * and persistence is deferred to F5.2.
 *
 * The judges are dispatched **app-natively** (a structured `runStructuredCompletion`
 * call per dimension, the F4.5 `compose-completion-offer` shape), NOT through
 * Sunrise's dataset-driven `AiEvaluationRun` worker — a deliberate divergence from the
 * development-plan's original F5.2 sketch, recorded in the decisions log. The judges
 * are still seeded as `kind = 'judge'` agents so they appear in the platform Judges
 * surface and reuse agent-resolver / cost / admin-edit, but their rubric lives in the
 * prompt builder (versioned in code), not in the agent row.
 */

import type { AudienceShape, QuestionType } from '@/lib/app/questionnaire/types';

/**
 * The seven evaluation dimensions, as a `const` tuple — the single source of truth.
 * `snake_case` to match the question-type / status tuples elsewhere in the module.
 * The per-dimension judge slug, label, and rubric all key off these values (see
 * `dimensions.ts` and `judge-prompt.ts`); a parity test asserts the registry, the
 * rubrics, and the seeds all cover exactly this set.
 */
export const EVALUATION_DIMENSIONS = [
  'clarity',
  'coverage',
  'duplicates',
  'type_fit',
  'ordering',
  'audience_match',
  'goal_match',
] as const;
export type EvaluationDimension = (typeof EVALUATION_DIMENSIONS)[number];

/**
 * Severity of a single finding, ascending. `info` is a nice-to-have; `minor` is a
 * real but non-blocking issue; `major` is a structural problem worth fixing before
 * launch. A closed vocabulary so the Zod contract, the review queue (F5.3), and any
 * filter UI all derive from one source.
 */
export const FINDING_SEVERITIES = ['info', 'minor', 'major'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/**
 * The op vocabulary for a {@link ProposedEdit} — the single source of truth, the
 * `const`-tuple discipline used everywhere else in this module. F5.3's apply engine
 * switches on `op`; the judge prompt names them; a parity test asserts coverage.
 */
export const PROPOSED_EDIT_OPS = [
  'replace_prompt',
  'edit_guidelines',
  'change_type',
  'delete_question',
  'reorder',
  'edit_goal',
  'edit_audience',
  'add_question',
] as const;
export type ProposedEditOp = (typeof PROPOSED_EDIT_OPS)[number];

/**
 * A **structured, machine-applicable** edit a judge may attach to a finding alongside
 * the prose `proposedChange` (F5.3). When present and well-formed, F5.3's review queue
 * can apply it in one click through the existing fork-if-launched authoring seam; when
 * absent (a nuanced suggestion that doesn't map to an op), the finding stays prose-only
 * and the admin is routed into the pre-filled editor instead.
 *
 * Deliberately **draft-shaped**: ops address their target the way `targetKey` does — by
 * slot `key` / `section:<title>` / `goal` / `audience`, never by a cuid the judge can't
 * know. The op is an **accelerator, never a trust boundary**: it is prompt-guided, not
 * provider-enforced (the JSON schema is not sent to the model), so every applied op is
 * re-validated at apply time exactly like a hand authoring edit (`validateTypeConfig`,
 * key-collision, ordinal bounds). A malformed op degrades to `null` on persist (the
 * `parseAudienceShape` posture), never failing the surrounding verdict.
 *
 * `op` is the single discriminator. `add_question` carries a *draft* (no ids, the
 * section may not exist) and is never blind-applied — F5.3 routes it to a pre-filled
 * create form. There is intentionally **no `merge` op**: the authoring surface has no
 * single-slot merge write path, so a duplicates finding emits `delete_question` on the
 * weaker slot plus prose.
 */
export type ProposedEdit =
  /** Rewrite a question's prompt in place. Target: slot `key`. (clarity) */
  | { op: 'replace_prompt'; prompt: string }
  /** Set or clear a question's author guidelines. Target: slot `key`. (clarity, audience_match) */
  | { op: 'edit_guidelines'; guidelines: string | null }
  /** Change a question's answer type (config reset/revalidated at apply). Target: slot `key`. (type_fit) */
  | { op: 'change_type'; type: QuestionType; typeConfig?: unknown }
  /** Remove a question. Target: slot `key`. (duplicates, goal_match) */
  | { op: 'delete_question' }
  /**
   * Move a question to an absolute 0-based `ordinal` (clamped at apply), optionally into
   * another section by its title. Target: slot `key`. (ordering)
   */
  | { op: 'reorder'; ordinal: number; targetSectionKey?: string }
  /** Replace the version goal. Target: `goal`. (goal_match) */
  | { op: 'edit_goal'; goal: string }
  /** Merge-patch the version audience (only the named sub-fields change). Target: `audience`. (audience_match) */
  | { op: 'edit_audience'; audience: Partial<AudienceShape> }
  /**
   * Draft a missing question. Never blind-applied — routes to a pre-filled create form.
   * Target: `goal` or `section:<title>`. (coverage)
   */
  | {
      op: 'add_question';
      prompt: string;
      type: QuestionType;
      /** A concise `snake_case` key the judge proposes; slugified + collision-suffixed at apply. */
      key?: string;
      sectionKey?: string;
      guidelines?: string;
      typeConfig?: unknown;
    };

/**
 * The persisted review lifecycle of a finding (F5.3) — the single source of truth for the
 * `AppQuestionnaireEvaluationFinding.status` column. A finding starts `pending`; the admin
 * moves it to `accepted` (agree, not yet applied) or `declined` (dismiss); `applied` is the
 * terminal state once the structured edit was written to the draft.
 *
 * `stale` is **deliberately not a status here**: a finding is stale when intervening edits
 * make its suggestion obsolete, which is a function of the *live* structure and so is derived
 * at read time (see `applicable`/`FindingApplicability`), never written — a stored `stale`
 * would rot the moment the structure changed again.
 */
export const FINDING_REVIEW_STATUSES = ['pending', 'accepted', 'declined', 'applied'] as const;
export type FindingReviewStatus = (typeof FINDING_REVIEW_STATUSES)[number];

/**
 * How a finding can be actioned, derived at read time (F5.3) from its `proposedEdit`/override
 * and the live structure:
 *
 * - `apply` — a clean structured op the review queue can apply in one click.
 * - `deep-link` — needs authoring (an `add_question` draft, or a low-confidence op): the admin
 *   is sent to a pre-filled editor rather than a blind write.
 * - `manual` — prose-only (no op): the admin edits the structure by hand from the suggestion.
 */
export const FINDING_APPLICABILITIES = ['apply', 'deep-link', 'manual'] as const;
export type FindingApplicability = (typeof FINDING_APPLICABILITIES)[number];

/**
 * One actionable suggestion from a judge. `targetKey` addresses what the finding is
 * about: a question by its stable slot `key`, a section by `section:<title>`, or the
 * version-level `goal` / `audience`. It's a free string (not validated against the
 * live graph here — the pure core has no graph): F5.3 reconciles it at apply time,
 * fail-cleanly, the same posture as F2.3's revert planner.
 */
export interface JudgeFinding {
  /** What this finding is about — a slot `key`, `section:<title>`, `goal`, or `audience`. */
  targetKey: string;
  /** How serious the issue is. */
  severity: FindingSeverity;
  /** The concrete edit the judge proposes (e.g. "split into two questions"). */
  proposedChange: string;
  /** Why the change is warranted, in one or two sentences. */
  rationale: string;
  /** The offending text quoted from the structure, when the finding points at one. */
  sourceQuote?: string;
  /**
   * Optional structured edit (F5.3) the review queue can apply in one click. Absent on
   * a prose-only finding; see {@link ProposedEdit}.
   */
  proposedEdit?: ProposedEdit;
}

/**
 * One judge's verdict for one dimension. `score` is continuous in [0, 1] (1 = the
 * dimension is in great shape). `findings` may be empty when the judge has no
 * suggestions — a clean pass is a valid, useful result. `dimension` is stamped by the
 * caller (the capability), not the LLM, so a judge can never mislabel its own verdict.
 */
export interface JudgeVerdict {
  /** Which dimension this verdict scores. */
  dimension: EvaluationDimension;
  /** Continuous quality score in [0, 1]; 1 = no issues on this dimension. */
  score: number;
  /** The actionable findings — possibly empty. */
  findings: JudgeFinding[];
}

/** One question, flattened for the judge prompt. */
export interface StructureQuestion {
  /** Stable slot key — the address a finding's `targetKey` uses. */
  key: string;
  /** The question prompt shown to a respondent. */
  prompt: string;
  /** The configured answer type (free_text, single_choice, likert, …). */
  type: string;
  /** Whether the question is required. */
  required: boolean;
  /** Optional author guidelines/help, when present. */
  guidelines?: string;
}

/** One section, flattened for the judge prompt. */
export interface StructureSection {
  /** Section heading. */
  title: string;
  /** Optional section description. */
  description?: string;
  /** The section's questions in presentation order. */
  questions: StructureQuestion[];
}

/**
 * The pure DTO the route assembles from a version's persisted graph and hands to the
 * prompt builder. Keeps `lib/app/**` Prisma-free: all the `findFirst`/select lives in
 * the route-local loader (`_lib/evaluation-structure.ts`), the same DB-seam split
 * F4.1's `buildSelectionContext` uses.
 */
export interface VersionStructureInput {
  /** The version's stated goal, or `null` when never set. */
  goal: string | null;
  /** The version's structured audience, or `null` when never set. */
  audience: AudienceShape | null;
  /** Sections in presentation order. */
  sections: StructureSection[];
}
