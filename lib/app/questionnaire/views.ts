/**
 * Read-side view types for the questionnaire admin surface (P2 / F2.1a).
 *
 * The shapes the list/detail GET endpoints return and the admin UI consumes. Kept
 * **pure types, client-safe** (no Prisma, no Next, no server-only imports) so both
 * the route serializers and the `'use client'` table/detail components import the
 * same contract. Dates are serialised as ISO strings — these cross the HTTP
 * boundary, so there are no `Date` objects here.
 *
 * Distinct from `AppQuestionnaire*` Prisma rows: those carry storage detail (FKs,
 * raw JSON, `bytes`); these are the trimmed, enriched projections the UI needs.
 */

import type {
  AppQuestionnaireStatus,
  AudienceProvenance,
  AudienceShape,
  FieldProvenance,
  QuestionnaireConfigShape,
  QuestionType,
  TagColor,
} from '@/lib/app/questionnaire/types';
// DEMO-ONLY (F2.5.1): attribution summary embedded in list/detail rows.
import type { AttributedDemoClient } from '@/lib/app/questionnaire/demo-clients';
// F5.2/F5.3: design-evaluation run views reuse the judge dimension/severity/edit vocabulary.
import type {
  EvaluationDimension,
  FindingSeverity,
  FindingReviewStatus,
  FindingApplicability,
  ProposedEdit,
  ReconciledSuggestion,
} from '@/lib/app/questionnaire/evaluation';
// F17.21: scope-evaluation run views reuse the SAME severity/status/applicability vocabulary
// (imported above) plus their own dimension + edit-op vocabulary — see `scope-evaluation/types.ts`
// for why these are a separate module rather than an extension of `evaluation/`.
import type {
  ScopeEvaluationDimension,
  ScopeProposedEdit,
} from '@/lib/app/questionnaire/scope-evaluation';
// F18.8: the interviewer-policy panel, likewise its own dimension + edit-op vocabulary.
import type {
  PolicyEvaluationDimension,
  PolicyProposedEdit,
} from '@/lib/app/questionnaire/policy-evaluation';
// Ref-lookup turns carry their full inspector call trace so the admin evaluator can show the raw
// prompt of every call (same shape the preview drawer / diagnostics render).
import type { AgentCallTrace } from '@/lib/app/questionnaire/inspector/types';

/** A vocabulary tag (F2.2) — client-safe projection of `AppQuestionTag`. */
export interface TagView {
  id: string;
  label: string;
  /** Swatch from the `TAG_COLORS` allowlist, or `null` when uncoloured. */
  color: TagColor | null;
}

/** One row in the admin questionnaires list — enriched with latest-version counts. */
export interface QuestionnaireListItem {
  id: string;
  title: string;
  status: AppQuestionnaireStatus;
  /** Total versions on this questionnaire. */
  versionCount: number;
  /** The highest-numbered version (the one the list summarises), or null if none. */
  latestVersion: {
    id: string;
    versionNumber: number;
    status: AppQuestionnaireStatus;
  } | null;
  /** Section / question / data-slot counts for the latest version (0 when no version yet). */
  sectionCount: number;
  questionCount: number;
  /** Data slots generated for the latest version (0 when none / feature unused). */
  dataSlotCount: number;
  /** DEMO-ONLY (F2.5.1): the attributed demo client, or null for a generic Sunrise demo. */
  demoClient: AttributedDemoClient | null;
  /** Soft-delete marker — ISO timestamp when archived, or null when active. */
  archivedAt: string | null;
  createdAt: string;
  /** Last activity — the questionnaire row's `updatedAt`. */
  updatedAt: string;
}

/** A version summary in the questionnaire detail view (no full graph). */
export interface QuestionnaireVersionSummary {
  id: string;
  versionNumber: number;
  status: AppQuestionnaireStatus;
  /** Per-version soft-archive marker — ISO timestamp when archived, or null when active. */
  archivedAt: string | null;
  goal: string | null;
  audience: AudienceShape | null;
  sectionCount: number;
  questionCount: number;
  /** Data slots generated for this version (0 when none / feature unused). */
  dataSlotCount: number;
  /** Applied (not-yet-reverted) extraction-change records on this version. */
  changeCount: number;
  createdAt: string;
  updatedAt: string;
}

/** The questionnaire detail payload — the questionnaire plus its version list. */
export interface QuestionnaireDetail {
  id: string;
  title: string;
  status: AppQuestionnaireStatus;
  /** DEMO-ONLY (F2.5.1): the attributed demo client, or null for a generic Sunrise demo. */
  demoClient: AttributedDemoClient | null;
  /** Soft-delete marker — ISO timestamp when archived, or null when active. */
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Versions newest-first (highest `versionNumber` first). */
  versions: QuestionnaireVersionSummary[];
}

/** A single question in the version graph. */
export interface QuestionSlotView {
  id: string;
  ordinal: number;
  key: string;
  prompt: string;
  guidelines: string | null;
  rationale: string | null;
  type: QuestionType;
  typeConfig: unknown;
  required: boolean;
  weight: number;
  /** Five-stop `ask as written ↔ fill creatively` dial. Inert unless `config.questionFidelity.enabled`. */
  fidelity: number;
  extractionConfidence: number | null;
  /** Tags assigned to this question, ordered by normalised label. */
  tags: TagView[];
}

/** A section (with its questions) in the version graph. */
export interface SectionView {
  id: string;
  ordinal: number;
  title: string;
  description: string | null;
  questions: QuestionSlotView[];
}

/**
 * A version's resolved run-time configuration (F3.1) — client-safe projection of
 * `AppQuestionnaireConfig`. Always present on the graph: when no config row exists
 * the read path returns `DEFAULT_QUESTIONNAIRE_CONFIG`. Whether the admin has
 * actually saved one (which the launch gate requires) is carried by `saved`.
 */
export interface ConfigView extends QuestionnaireConfigShape {
  /** True once a config row exists for the version (admin saved at least once). */
  saved: boolean;
}

/** The full structural graph of one version — sections → questions + goal/audience. */
export interface VersionGraphView {
  id: string;
  questionnaireId: string;
  versionNumber: number;
  status: AppQuestionnaireStatus;
  goal: string | null;
  audience: AudienceShape | null;
  /**
   * Stored per-field provenance from the ingest merge. `goalProvenance` is the
   * goal's source (`null` when no goal); `audienceProvenance` has one entry per
   * resolved audience field. The UI marks a value "inferred" when its provenance
   * is `'inferred'`. Read straight from the version columns — no derivation.
   */
  goalProvenance: FieldProvenance | null;
  audienceProvenance: AudienceProvenance | null;
  sections: SectionView[];
  /** The version's tag vocabulary (F2.2), ordered by normalised label. */
  tags: TagView[];
  /** Resolved run-time configuration (F3.1) — defaults when never saved. */
  config: ConfigView;
}

/**
 * One dimension's outcome captured on a run (F5.2) — the client-safe shape of an entry
 * in the run's `dimensionSummary` JSON. `score` and `diagnostic` are mutually exclusive:
 * a judge that returned a verdict has a `score` (and `diagnostic: null`); one that failed
 * has a `diagnostic` (and `score: null`).
 */
export interface EvaluationDimensionSummary {
  dimension: EvaluationDimension;
  /** Judge score in [0, 1]; `null` when the judge failed (see `diagnostic`). */
  score: number | null;
  /** Findings this judge raised (0 when it scored cleanly or failed). */
  findingCount: number;
  /** Diagnostic code when the judge failed/was absent; `null` on success. */
  diagnostic: string | null;
}

/**
 * What a finding's `targetKey` actually refers to, resolved at read time against the live
 * structure (falling back to the run's snapshot). Never stored — a persisted prompt would rot
 * the moment the question was reworded. This is what lets the review queue say *which question*
 * a judgement is about instead of showing a bare slot key.
 */
export type FindingTargetKind = 'question' | 'section' | 'goal' | 'audience' | 'unknown';

/** The resolved subject of a finding (see {@link FindingTargetKind}). */
export interface FindingTargetView {
  kind: FindingTargetKind;
  /** The raw `targetKey`, unchanged — still the handle apply reconciles against. */
  key: string;
  /** Human label: the question prompt, the section title, or the version-level target's name. */
  label: string;
  /** Containing section title when `kind === 'question'`; `null` otherwise. */
  sectionTitle: string | null;
  /** 1-based position within its section when `kind === 'question'`; `null` otherwise. */
  position: number | null;
  /**
   * 1-based index of the containing section (`kind === 'question'`), or of the section itself
   * (`kind === 'section'`); `null` otherwise. Paired with {@link position} this is what lets a
   * reader sort findings into questionnaire order — `position` alone is only meaningful within
   * one section. Derived at read time like the rest of this view, never stored.
   */
  sectionPosition: number | null;
  /**
   * The configured answer type (`free_text`, `likert`, `single_choice`, …) when
   * `kind === 'question'`; `null` otherwise. A reviewer judges a suggestion very differently
   * depending on how the question is answered — "add a scale anchor" is meaningless on free text —
   * so the type travels with the target rather than forcing a trip to the structure editor. Kept
   * as `string` (not `QuestionType`) because it comes from a stored structure that may carry a
   * type this build no longer knows; the UI falls back to showing the raw value.
   */
  questionType: string | null;
  /**
   * Whether routing can withhold this question from a respondent, in the reviewer's terms
   * (F17.34). `always` — every respondent is asked it; `conditional` — only those its topic
   * selects; `never` — it belongs to no topic, so with Conditional Topics on it cannot be asked
   * at all.
   *
   * `null` whenever Conditional Topics is OFF for this version, or the structure predates the
   * routing overlay. **Never derived from the mere presence of topics**: ingest seeds one `core`
   * topic per section on every questionnaire, so a presence test would stamp "Always asked" on
   * every finding card in the product and teach reviewers to ignore the chip.
   *
   * Derived at read time like the rest of this view, never stored — the same reason
   * {@link FindingTargetView.questionType} travels here: a reviewer judges a suggestion very
   * differently once they know most respondents will never see the question it is about.
   */
  routingReach: 'always' | 'conditional' | 'never' | null;
  /** The owning topic(s), joined for display. `null` exactly when {@link routingReach} is. */
  topicLabel: string | null;
  /** The target exists only in the run's snapshot — it was removed from the live structure since. */
  removed: boolean;
}

/** One persisted finding (F5.2 + F5.3) — client-safe projection of `AppQuestionnaireEvaluationFinding`. */
export interface EvaluationFindingView {
  id: string;
  dimension: EvaluationDimension;
  /** Presentation order within (run, dimension). */
  ordinal: number;
  /** The slot `key`, `section:<title>`, `goal`, or `audience` this finding addresses. */
  targetKey: string;
  /**
   * `targetKey` resolved to its subject for display (F5.3) — the question prompt and where it
   * sits, so a reviewer can see which question a judgement is about without leaving the page.
   * Derived at read time, never stored; `null` when no structure was loadable to resolve against.
   */
  target: FindingTargetView | null;
  severity: FindingSeverity;
  proposedChange: string;
  rationale: string;
  sourceQuote: string | null;
  /** Review lifecycle: `pending` | `accepted` | `declined` | `applied`. */
  status: FindingReviewStatus;
  /** The judge's structured edit, when it attached one (F5.3); `null` when prose-only or degraded. */
  proposedEdit: ProposedEdit | null;
  /** The admin's edited op, which takes precedence over `proposedEdit` at apply (F5.3); `null` if unedited. */
  editedOverride: ProposedEdit | null;
  /**
   * The reviewer's free-text steer for how to make this change, replayed at batch apply (F5.4).
   *
   * `null` means "apply the structured op exactly as the judge proposed it". Anything else opts
   * this one finding into the AI-assisted leg of the batch, where the instruction is handed to the
   * Structure Edit Agent alongside the judge's suggestion.
   */
  applyInstruction: string | null;
  /** Admin who decided (accept/decline/edit); `null` while `pending`. */
  decidedByUserId: string | null;
  /** ISO timestamps — cross the HTTP boundary. */
  decidedAt: string | null;
  appliedAt: string | null;
  /** The version actually written when applied (may be a forked draft); `null` until applied. */
  appliedToVersionId: string | null;
  /**
   * Derived at read time (F5.3), never stored: whether intervening edits made this suggestion
   * obsolete. A stale finding's Apply is disabled — re-run the evaluation.
   */
  stale: boolean;
  /** Derived at read time (F5.3): how this finding can be actioned. See {@link FindingApplicability}. */
  applicable: FindingApplicability;
}

/**
 * A drafted question carried from an `add_question` finding into the structure editor (F5.3, the
 * "Open in editor" refine path). The structure page resolves it from the
 * `?seedFinding=<runId>:<findingId>` deep-link and hands it to the seed composer, which pre-fills a
 * highlighted new-question form. `sectionKey` is the suggested section title (or `null` → the admin
 * picks); `runId`/`findingId` let the composer stamp the finding applied once the question is saved.
 */
export interface EvaluationSeed {
  runId: string;
  findingId: string;
  prompt: string;
  type: QuestionType;
  guidelines: string | null;
  sectionKey: string | null;
}

/** One row in the evaluation-runs list for a version (F5.2), newest-first. */
export interface EvaluationRunListItem {
  id: string;
  /** Terminal status: `completed` | `partial` | `failed`. */
  status: string;
  dimensionsRequested: number;
  dimensionsRun: number;
  dimensionsFailed: number;
  totalFindings: number;
  /** Per-dimension scores/diagnostics, in dispatch order. */
  dimensionSummary: EvaluationDimensionSummary[];
  /** Admin who ran it (`User.id`); `null` if unattributed. */
  triggeredByUserId: string | null;
  /** ISO timestamps — these cross the HTTP boundary. */
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
}

/** Full evaluation-run detail (F5.2) — the list row plus its findings and run context. */
export interface EvaluationRunDetail extends EvaluationRunListItem {
  versionId: string;
  questionnaireId: string;
  /** Run-level failure note when `status === 'failed'`; `null` otherwise. */
  error: string | null;
  /** All findings across dimensions, ordered by (dimension, ordinal). */
  findings: EvaluationFindingView[];
  /**
   * Cross-judge alternatives for the questions MORE THAN ONE judge flagged — one or two phrasings
   * that try to satisfy every judge at once, each naming the dimensions it resolves and any it
   * cannot. Empty when nothing was contested, when the reconcile call failed, or when the run
   * predates reconciliation entirely; consumers then show the judges' own suggestions unchanged.
   */
  reconciled: ReconciledSuggestion[];
}

/**
 * What a scope-evaluation finding's `targetKey` refers to (F17.21) — the sibling of
 * {@link FindingTargetKind} for the Conditional Topics judge panel. `topic:<key>` / `rule:<id>` /
 * `settings` rather than question/section/goal/audience, since the panel judges the scope config,
 * not the question structure.
 */
export type ScopeFindingTargetKind = 'topic' | 'rule' | 'settings' | 'unknown';

/** The resolved subject of a scope finding (see {@link ScopeFindingTargetKind}). */
export interface ScopeFindingTargetView {
  kind: ScopeFindingTargetKind;
  /** The raw `targetKey`, unchanged — still the handle apply reconciles against. */
  key: string;
  /** Human label: the topic's label, the rule's rendered sentence, or "Conditional topics settings". */
  label: string;
  /** The target exists only in the run's snapshot — it was removed from the live config since. */
  removed: boolean;
}

/** One persisted scope-evaluation finding (F17.21) — client-safe projection of the DB row. */
export interface ScopeEvaluationFindingView {
  id: string;
  dimension: ScopeEvaluationDimension;
  /** Presentation order within (run, dimension). */
  ordinal: number;
  /** `topic:<key>`, `rule:<id>`, or `settings`. */
  targetKey: string;
  /** `targetKey` resolved to its subject for display, derived at read time, never stored. */
  target: ScopeFindingTargetView | null;
  severity: FindingSeverity;
  proposedChange: string;
  rationale: string;
  sourceQuote: string | null;
  /** Review lifecycle: `pending` | `accepted` | `declined` | `applied`. */
  status: FindingReviewStatus;
  proposedEdit: ScopeProposedEdit | null;
  /** The admin's edited op, which takes precedence over `proposedEdit` at apply; `null` if unedited. */
  editedOverride: ScopeProposedEdit | null;
  decidedByUserId: string | null;
  decidedAt: string | null;
  appliedAt: string | null;
  appliedToVersionId: string | null;
  /** Derived at read time, never stored: whether intervening edits made this suggestion obsolete. */
  stale: boolean;
  applicable: FindingApplicability;
}

/** One row in the scope-evaluation-runs list for a version (F17.21), newest-first. */
export interface ScopeEvaluationRunListItem {
  id: string;
  status: string;
  dimensionsRequested: number;
  dimensionsRun: number;
  dimensionsFailed: number;
  totalFindings: number;
  dimensionSummary: ScopeEvaluationDimensionSummary[];
  triggeredByUserId: string | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
}

/** One dimension's outcome captured on a scope-evaluation run (F17.21). */
export interface ScopeEvaluationDimensionSummary {
  dimension: ScopeEvaluationDimension;
  score: number | null;
  findingCount: number;
  diagnostic: string | null;
}

/** Full scope-evaluation-run detail (F17.21) — the list row plus its findings and run context. */
export interface ScopeEvaluationRunDetail extends ScopeEvaluationRunListItem {
  versionId: string;
  questionnaireId: string;
  error: string | null;
  findings: ScopeEvaluationFindingView[];
}

/* ── Interviewer-policy evaluation (F18.8) ──────────────────────────────── */

/**
 * The target vocabulary for the interviewer-policy judge panel. Note `house_rule`, not `rule` — the
 * scope panel already owns `rule:<id>` for a hard routing rule, and a pack printing both appendices
 * must never mis-resolve one as the other.
 */
export type PolicyFindingTargetKind =
  'house_rule' | 'house_rules' | 'strategy' | 'fidelity' | 'tone' | 'question' | 'unknown';

/** The resolved subject of a policy finding. */
export interface PolicyFindingTargetView {
  kind: PolicyFindingTargetKind;
  /** The raw `targetKey`, unchanged — still the handle apply reconciles against. */
  key: string;
  /**
   * Human label. For a question this reads `Fidelity — "<prompt>"` rather than the bare prompt, so a
   * question flagged by BOTH this panel and the question-design panel is never mistaken for one
   * subject appearing in two queues.
   */
  label: string;
  /** The target exists only in the run's snapshot — it was removed from the live config since. */
  removed: boolean;
}

/** One persisted policy-evaluation finding (F18.8) — client-safe projection of the DB row. */
export interface PolicyEvaluationFindingView {
  id: string;
  dimension: PolicyEvaluationDimension;
  ordinal: number;
  targetKey: string;
  /** `targetKey` resolved to its subject for display, derived at read time, never stored. */
  target: PolicyFindingTargetView | null;
  severity: FindingSeverity;
  proposedChange: string;
  rationale: string;
  sourceQuote: string | null;
  status: FindingReviewStatus;
  proposedEdit: PolicyProposedEdit | null;
  editedOverride: PolicyProposedEdit | null;
  decidedByUserId: string | null;
  decidedAt: string | null;
  appliedAt: string | null;
  appliedToVersionId: string | null;
  /**
   * Derived at read time, never stored. Compares ONLY the field the op writes — a blanket diff of
   * the whole strategy blob would mark every strategy finding stale as soon as any one applied, and
   * the panel would look broken. This matters more here than on either sibling: three of the four
   * dimensions can target the same field, so same-field collisions are the normal path, not an edge.
   */
  stale: boolean;
  applicable: FindingApplicability;
}

/** One dimension's outcome captured on a policy-evaluation run (F18.8). */
export interface PolicyEvaluationDimensionSummary {
  dimension: PolicyEvaluationDimension;
  score: number | null;
  findingCount: number;
  diagnostic: string | null;
}

/** One row in the policy-evaluation-runs list for a version (F18.8), newest-first. */
export interface PolicyEvaluationRunListItem {
  id: string;
  status: string;
  dimensionsRequested: number;
  dimensionsRun: number;
  dimensionsFailed: number;
  totalFindings: number;
  dimensionSummary: PolicyEvaluationDimensionSummary[];
  triggeredByUserId: string | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
}

/** Full policy-evaluation-run detail (F18.8) — the list row plus its findings and run context. */
export interface PolicyEvaluationRunDetail extends PolicyEvaluationRunListItem {
  versionId: string;
  questionnaireId: string;
  error: string | null;
  findings: PolicyEvaluationFindingView[];
}

/**
 * One row in the persisted turn-evaluation search surface — the denormalised facets the table
 * filters/sorts on, enriched with the (cross-`versionId`) questionnaire title + version number
 * in a fixed query budget. `commentPreview` is a trimmed slice so the list can show a comment
 * exists without shipping the whole note. Dates are ISO strings (they cross the HTTP boundary).
 */
export interface TurnEvaluationListItem {
  id: string;
  sessionId: string;
  turnId: string | null;
  turnOrdinal: number;
  overallScore: number;
  /** TurnEffectiveness band: Excellent | Good | Mixed | Weak | Poor. */
  effectiveness: string;
  evaluatorModel: string;
  evaluatorProvider: string;
  rubricVersion: string;
  questionnaireVersionId: string;
  /** Enriched from the version → questionnaire; `null` when the version no longer resolves. */
  questionnaireTitle: string | null;
  questionnaireId: string | null;
  versionNumber: number | null;
  /** Learning workflow: none | flagged | reviewed | actioned | dismissed. */
  flagStatus: string;
  /** Trimmed comment slice (or `null`); the full text is on the detail view. */
  commentPreview: string | null;
  /** The dataset case this row was actioned into, when `flagStatus === 'actioned'`. */
  datasetCaseId: string | null;
  costUsd: number | null;
  createdAt: string;
}

/**
 * Full persisted turn-evaluation detail — the list row plus the verdict, the snapshotted input
 * that was judged, the full comment, and the complete review/provenance state. `verdict` and
 * `evaluatedInput` are passed through as opaque JSON (the client renders the verdict with the
 * shared turn-evaluation components; the schema validates them at write time).
 */
/**
 * One turn in a ref-lookup result — enough for an admin to read what happened, inspect the raw
 * calls, and re-evaluate it. Messages are the **full** respondent/interviewer text (not truncated),
 * and `calls` is the complete saved inspector trace (every LLM/embedding call with its raw prompt +
 * response) so the admin evaluator can show all of them, matching the preview drawer / diagnostics.
 * `callCount` mirrors `calls.length`; `hasTraces` says whether any dump is present (so the turn can
 * be re-evaluated); `evaluationCount` is how many verdicts already exist for it.
 */
export interface RefLookupTurn {
  ordinal: number;
  userMessage: string;
  agentResponse: string;
  calls: AgentCallTrace[];
  callCount: number;
  hasTraces: boolean;
  evaluationCount: number;
  createdAt: string;
}

/** The result of looking a chat up by its support reference — the session + its turns. */
export interface RefLookupResult {
  session: {
    id: string;
    ref: string;
    status: string;
    isPreview: boolean;
    questionnaireTitle: string | null;
    questionnaireId: string | null;
    versionId: string;
    versionNumber: number | null;
    createdAt: string;
  };
  turns: RefLookupTurn[];
}

export interface TurnEvaluationDetail extends TurnEvaluationListItem {
  appVersion: string;
  evaluatorAgentId: string | null;
  evaluatedByUserId: string | null;
  /** The full `TurnEvaluation` verdict object. */
  verdict: unknown;
  /** The `{ turn, context }` dump that was judged. */
  evaluatedInput: unknown;
  comment: string | null;
  commentByUserId: string | null;
  commentAt: string | null;
  flagReviewerId: string | null;
  flagUpdatedAt: string | null;
  datasetId: string | null;
  updatedAt: string;
}
