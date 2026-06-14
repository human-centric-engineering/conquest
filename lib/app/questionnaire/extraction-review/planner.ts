/**
 * Extraction-change revert planner (F2.3) — the pure engine.
 *
 * Given one change record and a snapshot of the current version graph, decide
 * what reverting that change *means* as a set of primitive graph operations
 * (`RevertPlan`), or why it can't be done faithfully (`RevertImpossible`). No
 * Prisma, no Next — every input is a plain projection and every output is data,
 * so each change type is exhaustively unit-testable. The Prisma executor
 * (`_lib/extraction-review-routes.ts`) maps the ops to writes.
 *
 * The honest posture (see `.context/app/questionnaire/extraction-changes.md`):
 * fail cleanly rather than guess-and-corrupt. `beforeJson`/`afterJson` are
 * free-form LLM output and `targetEntityId` is null for every section/question
 * edit (only `infer_*` carries the version id), so an editorial edit must
 * *reconcile* its target against the live graph; any ambiguity returns a typed
 * `RevertImpossible` reason, never a silent wrong mutation. The same matching is
 * a dependency guard: if a later edit changed the entity, `afterJson` no longer
 * matches and the revert is refused — the admin reverts newest-first.
 */

import { isRecord } from '@/lib/utils';
import {
  AUDIENCE_FIELDS,
  QUESTION_TYPES,
  type AudienceProvenance,
  type AudienceShape,
  type FieldProvenance,
  type QuestionType,
} from '@/lib/app/questionnaire/types';
import { type ChangeType, type TargetEntityType } from '@/lib/app/questionnaire/ingestion/types';

// ─── Inputs ────────────────────────────────────────────────────────────────

/** The change-record fields the planner reasons over (a pure projection of the row). */
export interface RevertableChange {
  id: string;
  changeType: ChangeType;
  targetEntityType: TargetEntityType;
  targetEntityId: string | null;
  sourceQuote: string | null;
  beforeJson: unknown;
  afterJson: unknown;
}

/** A question in the snapshot the planner reconciles against. */
export interface SnapshotQuestion {
  id: string;
  sectionId: string;
  ordinal: number;
  key: string;
  prompt: string;
  guidelines: string | null;
  rationale: string | null;
  type: QuestionType;
  typeConfig: unknown;
  required: boolean;
  weight: number;
}

/** A section (with questions) in the snapshot. */
export interface SnapshotSection {
  id: string;
  ordinal: number;
  title: string;
  description: string | null;
  questions: SnapshotQuestion[];
}

/** The current editable-version graph the planner reads — pure, no Prisma. */
export interface GraphSnapshot {
  goal: string | null;
  goalProvenance: FieldProvenance | null;
  audience: AudienceShape | null;
  audienceProvenance: AudienceProvenance | null;
  sections: SnapshotSection[];
}

// ─── Outputs ───────────────────────────────────────────────────────────────

export const REVERT_IMPOSSIBLE_REASONS = [
  'target_not_found',
  'ambiguous_target',
  'missing_before_json',
  'structural_inverse_unavailable',
  'graph_drift',
] as const;
export type RevertImpossibleReason = (typeof REVERT_IMPOSSIBLE_REASONS)[number];

/** A new question to create — the executor assigns the per-version-unique `key`. */
export interface NewQuestionSpec {
  prompt: string;
  guidelines: string | null;
  rationale: string | null;
  type: QuestionType;
  typeConfig: unknown;
  required: boolean;
  weight: number;
}

/** The mutable fields a question revert may restore. */
export interface QuestionUpdateFields {
  prompt?: string;
  guidelines?: string | null;
  rationale?: string | null;
  type?: QuestionType;
  typeConfig?: unknown;
  required?: boolean;
  weight?: number;
}

/** The mutable fields a section revert may restore. */
export interface SectionUpdateFields {
  title?: string;
  description?: string | null;
}

/**
 * One primitive graph operation. All entity ids reference the snapshot the plan
 * was built from (i.e. the editable version), so the executor needs no remapping.
 * A `create-section`/`create-question` lets the executor assign a fresh key + the
 * append ordinal.
 */
export type RevertOp =
  | { op: 'set-goal'; goal: string | null; provenance: FieldProvenance | null }
  | { op: 'set-audience'; audience: AudienceShape | null; provenance: AudienceProvenance | null }
  | {
      op: 'create-section';
      title: string;
      description: string | null;
      questions: NewQuestionSpec[];
    }
  | { op: 'create-question'; sectionId: string; question: NewQuestionSpec }
  | { op: 'update-question'; questionId: string; fields: QuestionUpdateFields }
  | { op: 'update-section'; sectionId: string; fields: SectionUpdateFields }
  | { op: 'delete-question'; questionId: string }
  | { op: 'delete-section'; sectionId: string };

/** A faithful revert, expressed as ordered primitive ops + a human summary. */
export interface RevertPlan {
  ops: RevertOp[];
  /** One-line description of the effect, shown in the confirm dialog / audit. */
  summary: string;
}

export type RevertPlanResult =
  | { ok: true; plan: RevertPlan }
  | { ok: false; reason: RevertImpossibleReason; detail: string };

function impossible(reason: RevertImpossibleReason, detail: string): RevertPlanResult {
  return { ok: false, reason, detail };
}

// ─── Loose-JSON helpers (beforeJson/afterJson are free-form LLM output) ───────

/** Normalise a loose before/after value to an object: a bare string becomes `{ prompt }`. */
function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') return { prompt: value };
  if (isRecord(value)) return value;
  return null;
}

/** Pull a non-empty trimmed string off a loose object key, else null. */
function str(obj: Record<string, unknown> | null, key: string): string | null {
  if (!obj) return null;
  const v = obj[key];
  return typeof v === 'string' && v.trim().length > 0 ? v : null;
}

/** Narrow a loose value to a known QuestionType, else null. */
function asQuestionType(value: unknown): QuestionType | null {
  return typeof value === 'string' && (QUESTION_TYPES as readonly string[]).includes(value)
    ? (value as QuestionType)
    : null;
}

/** Stable equality for audience field values (primitives) without a deep-equal dep. */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Build a `NewQuestionSpec` from a loose object, applying schema defaults. */
function toNewQuestion(obj: Record<string, unknown>): NewQuestionSpec | null {
  const prompt = str(obj, 'prompt');
  if (prompt === null) return null; // a question without a prompt can't be re-created
  return {
    prompt,
    guidelines: str(obj, 'guidelines'),
    rationale: str(obj, 'rationale'),
    type: asQuestionType(obj.type) ?? 'free_text',
    typeConfig: isRecord(obj.typeConfig) ? obj.typeConfig : null,
    required: typeof obj.required === 'boolean' ? obj.required : false,
    // Neutral midpoint of the 0.1–1.0 weight scale when the snapshot carries none.
    weight: typeof obj.weight === 'number' ? obj.weight : 0.5,
  };
}

// ─── Reconciliation (find the entity a null-target edit applies to) ───────────

type Reconciled =
  | { kind: 'question'; question: SnapshotQuestion }
  | { kind: 'section'; section: SnapshotSection }
  | { kind: 'none' }
  | { kind: 'ambiguous'; count: number };

function allQuestions(snapshot: GraphSnapshot): SnapshotQuestion[] {
  return snapshot.sections.flatMap((s) => s.questions);
}

/** sourceQuote tiebreak: does either string contain the other (case-insensitive)? */
function quoteOverlaps(quote: string, text: string): boolean {
  const q = quote.trim().toLowerCase();
  const t = text.trim().toLowerCase();
  if (q.length === 0) return false;
  return t.includes(q) || q.includes(t);
}

/**
 * Find the entity an editorial (null-target) edit applies to by matching the
 * post-edit value (`afterJson`) against the current graph, tie-breaking with
 * `sourceQuote`. The match fields are the comparable string fields present in
 * `afterJson` (prompt/guidelines/type for a question; title for a section).
 */
function reconcileTarget(change: RevertableChange, snapshot: GraphSnapshot): Reconciled {
  const after = asObject(change.afterJson);

  if (change.targetEntityType === 'section') {
    const wantTitle = str(after, 'title');
    let matches = snapshot.sections;
    if (wantTitle !== null) matches = matches.filter((s) => s.title === wantTitle);
    return narrow(
      matches,
      change.sourceQuote,
      (s) => s.title,
      (section) => ({ kind: 'section', section })
    );
  }

  // Default: a question-targeted edit.
  const wantPrompt = str(after, 'prompt');
  const wantGuidelines = str(after, 'guidelines');
  const wantType = asQuestionType(after?.type);
  let matches = allQuestions(snapshot);
  if (wantPrompt !== null) matches = matches.filter((q) => q.prompt === wantPrompt);
  if (wantGuidelines !== null) matches = matches.filter((q) => q.guidelines === wantGuidelines);
  if (wantType !== null) matches = matches.filter((q) => q.type === wantType);
  return narrow(
    matches,
    change.sourceQuote,
    (q) => q.prompt,
    (question) => ({ kind: 'question', question })
  );
}

/** Collapse a candidate list to one (with a sourceQuote tiebreak) or report none/ambiguous. */
function narrow<T>(
  matches: readonly T[],
  sourceQuote: string | null,
  text: (item: T) => string,
  wrap: (item: T) => Reconciled
): Reconciled {
  if (matches.length === 0) return { kind: 'none' };
  if (matches.length === 1) return wrap(matches[0]);
  if (sourceQuote) {
    const narrowed = matches.filter((m) => quoteOverlaps(sourceQuote, text(m)));
    if (narrowed.length === 1) return wrap(narrowed[0]);
  }
  return { kind: 'ambiguous', count: matches.length };
}

// ─── Per-family planners ──────────────────────────────────────────────────────

/** infer_goal: clear the version goal the inference set (refuse if the admin owns it now). */
function planInferGoal(snapshot: GraphSnapshot): RevertPlanResult {
  if (snapshot.goalProvenance !== 'inferred') {
    return impossible(
      'graph_drift',
      'The goal is no longer marked inferred — it was edited or cleared after extraction.'
    );
  }
  return {
    ok: true,
    plan: {
      ops: [{ op: 'set-goal', goal: null, provenance: null }],
      summary: 'Clear the inferred goal.',
    },
  };
}

/** infer_audience: clear only the still-inferred subset of keys this inference set. */
function planInferAudience(change: RevertableChange, snapshot: GraphSnapshot): RevertPlanResult {
  const after = asObject(change.afterJson);
  if (!after) {
    return impossible(
      'missing_before_json',
      'The inferred audience payload is missing or malformed.'
    );
  }
  const audience: AudienceShape = { ...(snapshot.audience ?? {}) };
  const provenance: AudienceProvenance = { ...(snapshot.audienceProvenance ?? {}) };

  const cleared: string[] = [];
  for (const key of Object.keys(after)) {
    if (!(AUDIENCE_FIELDS as readonly string[]).includes(key)) continue;
    const field = key as keyof AudienceShape;
    // Only clear a key still owned by the inference AND still holding its value —
    // a key the admin re-supplied since has drifted and is left untouched.
    if (provenance[field] === 'inferred' && sameValue(audience[field], after[key])) {
      delete audience[field];
      delete provenance[field];
      cleared.push(key);
    }
  }
  if (cleared.length === 0) {
    return impossible(
      'graph_drift',
      'Every inferred audience field was edited or re-supplied after extraction.'
    );
  }
  const nextAudience = Object.keys(audience).length > 0 ? audience : null;
  const nextProvenance = Object.keys(provenance).length > 0 ? provenance : null;
  return {
    ok: true,
    plan: {
      ops: [{ op: 'set-audience', audience: nextAudience, provenance: nextProvenance }],
      summary: `Clear inferred audience field(s): ${cleared.join(', ')}.`,
    },
  };
}

/** prune_section: re-create the dropped section (and its questions) at the end. */
function planPruneSection(change: RevertableChange): RevertPlanResult {
  const before = asObject(change.beforeJson);
  const title = str(before, 'title');
  if (title === null) {
    return impossible('missing_before_json', 'The pruned section has no recoverable title.');
  }
  const rawQuestions: unknown[] = Array.isArray(before?.questions) ? before.questions : [];
  const questions: NewQuestionSpec[] = [];
  for (const raw of rawQuestions) {
    const obj = asObject(raw);
    const q = obj && toNewQuestion(obj);
    if (q) questions.push(q);
  }
  return {
    ok: true,
    plan: {
      ops: [{ op: 'create-section', title, description: str(before, 'description'), questions }],
      summary: `Re-create the pruned section “${title}” (${questions.length} question(s)) at the end.`,
    },
  };
}

/** prune_question: re-create the dropped question into its (resolved) parent section. */
function planPruneQuestion(change: RevertableChange, snapshot: GraphSnapshot): RevertPlanResult {
  const before = asObject(change.beforeJson);
  if (!before) {
    return impossible('missing_before_json', 'The pruned question has no recoverable content.');
  }
  const spec = toNewQuestion(before);
  if (!spec) {
    return impossible('missing_before_json', 'The pruned question has no recoverable prompt.');
  }
  if (snapshot.sections.length === 0) {
    return impossible('target_not_found', 'There is no section to restore the question into.');
  }
  // Resolve the parent section: by title/ordinal hint in beforeJson if it points
  // at exactly one current section, else fall back to the first section.
  const wantTitle = str(before, 'sectionTitle');
  const wantOrdinal = typeof before.sectionOrdinal === 'number' ? before.sectionOrdinal : null;
  let section: SnapshotSection | undefined;
  if (wantTitle !== null) {
    const byTitle = snapshot.sections.filter((s) => s.title === wantTitle);
    if (byTitle.length === 1) section = byTitle[0];
  }
  if (!section && wantOrdinal !== null) {
    section = snapshot.sections.find((s) => s.ordinal === wantOrdinal);
  }
  section ??= snapshot.sections[0];
  return {
    ok: true,
    plan: {
      ops: [{ op: 'create-question', sectionId: section.id, question: spec }],
      summary: `Re-create the pruned question into section “${section.title}”.`,
    },
  };
}

/**
 * Editorial edit (rewrite_prompt / correct_* / augment_question): reconcile the
 * (null-target) entity, then restore the touched fields from `beforeJson`. The
 * touched fields are those that appear in before/after; a field absent from
 * `beforeJson` but present in `afterJson` was *added* by the edit, so the inverse
 * clears it (null). A `prompt` that would clear to empty is refused.
 */
function planFieldRestore(
  change: RevertableChange,
  snapshot: GraphSnapshot,
  allowed: readonly string[]
): RevertPlanResult {
  const resolved = resolveOrFail(change, snapshot);
  if (!resolved.ok) return resolved;
  const { target } = resolved;

  const before = asObject(change.beforeJson);
  const after = asObject(change.afterJson);
  const touched = new Set<string>();
  for (const k of Object.keys(before ?? {})) if (allowed.includes(k)) touched.add(k);
  for (const k of Object.keys(after ?? {})) if (allowed.includes(k)) touched.add(k);
  if (touched.size === 0) {
    return impossible('missing_before_json', 'No recoverable before/after fields on this change.');
  }

  if (target.kind === 'section') {
    const fields: SectionUpdateFields = {};
    for (const key of touched) {
      if (key === 'title') {
        const v = str(before, 'title');
        if (v === null)
          return impossible('missing_before_json', 'No prior section title to restore.');
        fields.title = v;
      } else if (key === 'description') {
        fields.description = str(before, 'description'); // null clears
      }
    }
    return {
      ok: true,
      plan: {
        ops: [{ op: 'update-section', sectionId: target.section.id, fields }],
        summary: `Restore section “${target.section.title}” to its pre-edit text.`,
      },
    };
  }

  const fields: QuestionUpdateFields = {};
  for (const key of touched) {
    if (key === 'prompt') {
      const v = str(before, 'prompt');
      if (v === null) return impossible('missing_before_json', 'No prior prompt to restore.');
      fields.prompt = v;
    } else if (key === 'guidelines') {
      fields.guidelines = str(before, 'guidelines'); // null clears the augmentation
    } else if (key === 'rationale') {
      fields.rationale = str(before, 'rationale');
    }
  }
  return {
    ok: true,
    plan: {
      ops: [{ op: 'update-question', questionId: target.question.id, fields }],
      summary: `Restore question “${target.question.key}” to its pre-edit text.`,
    },
  };
}

/** infer_type: restore the question's prior type (+ config), or the default when inferred from nothing. */
function planInferType(change: RevertableChange, snapshot: GraphSnapshot): RevertPlanResult {
  const resolved = resolveOrFail(change, snapshot);
  if (!resolved.ok) return resolved;
  if (resolved.target.kind !== 'question') {
    return impossible('target_not_found', 'infer_type does not apply to a section.');
  }
  const { question } = resolved.target;
  const before = asObject(change.beforeJson);
  const priorType = asQuestionType(before?.type);
  const fields: QuestionUpdateFields = {
    // No prior type recorded → the type was inferred from nothing; the inverse is
    // the schema default with no config.
    type: priorType ?? 'free_text',
    typeConfig: isRecord(before?.typeConfig) ? before.typeConfig : null,
  };
  return {
    ok: true,
    plan: {
      ops: [{ op: 'update-question', questionId: question.id, fields }],
      summary: `Restore question “${question.key}” to type ${fields.type}.`,
    },
  };
}

/** merge_questions: re-create the N source questions and delete the merged one. */
function planMergeRestore(change: RevertableChange, snapshot: GraphSnapshot): RevertPlanResult {
  const before = change.beforeJson;
  if (!Array.isArray(before) || before.length < 2) {
    return impossible(
      'structural_inverse_unavailable',
      'A merge can only be reversed when beforeJson holds the ≥2 source questions; re-create them manually.'
    );
  }
  const specs: NewQuestionSpec[] = [];
  for (const raw of before) {
    const obj = asObject(raw);
    const q = obj && toNewQuestion(obj);
    if (!q) {
      return impossible(
        'structural_inverse_unavailable',
        'A source question in beforeJson is missing a prompt; re-create the merge manually.'
      );
    }
    specs.push(q);
  }
  const resolved = reconcileTarget(change, snapshot);
  if (resolved.kind === 'none') {
    return impossible('target_not_found', 'The merged question no longer matches any question.');
  }
  if (resolved.kind === 'ambiguous') {
    return impossible('ambiguous_target', `${resolved.count} questions match the merged question.`);
  }
  if (resolved.kind !== 'question') {
    return impossible('target_not_found', 'The merged target is not a question.');
  }
  const merged = resolved.question;
  return {
    ok: true,
    plan: {
      ops: [
        { op: 'delete-question', questionId: merged.id },
        ...specs.map(
          (question): RevertOp => ({ op: 'create-question', sectionId: merged.sectionId, question })
        ),
      ],
      summary: `Split the merged question back into ${specs.length} source questions.`,
    },
  };
}

/** split_question: delete the N split products and re-create the single original. */
function planSplitRestore(change: RevertableChange, snapshot: GraphSnapshot): RevertPlanResult {
  const before = asObject(change.beforeJson);
  const original = before && toNewQuestion(before);
  if (!original) {
    return impossible(
      'structural_inverse_unavailable',
      'A split can only be reversed when beforeJson holds the original question; re-create it manually.'
    );
  }
  // The products are the post-split questions named in afterJson (an array).
  const after = change.afterJson;
  if (!Array.isArray(after) || after.length < 2) {
    return impossible(
      'structural_inverse_unavailable',
      'The split products are not recorded in afterJson; reverse the split manually.'
    );
  }
  const productIds: string[] = [];
  let sectionId: string | null = null;
  for (const raw of after) {
    const obj = asObject(raw);
    const prompt = str(obj, 'prompt');
    const matches = allQuestions(snapshot).filter((q) => prompt !== null && q.prompt === prompt);
    if (matches.length !== 1) {
      return impossible(
        'structural_inverse_unavailable',
        'A split product was edited or removed, so the split cannot be cleanly reversed.'
      );
    }
    productIds.push(matches[0].id);
    sectionId ??= matches[0].sectionId;
  }
  if (sectionId === null) {
    return impossible('target_not_found', 'Could not resolve the section for the split products.');
  }
  return {
    ok: true,
    plan: {
      ops: [
        ...productIds.map((id): RevertOp => ({ op: 'delete-question', questionId: id })),
        { op: 'create-question', sectionId, question: original },
      ],
      summary: `Merge the ${productIds.length} split questions back into the original.`,
    },
  };
}

/** add_section: delete the added section — only when it is still empty. */
function planAddSectionRestore(
  change: RevertableChange,
  snapshot: GraphSnapshot
): RevertPlanResult {
  const after = asObject(change.afterJson);
  const wantTitle = str(after, 'title');
  const matches = snapshot.sections.filter((s) => wantTitle === null || s.title === wantTitle);
  if (matches.length === 0)
    return impossible('target_not_found', 'The added section no longer exists.');
  if (matches.length > 1) {
    return impossible('ambiguous_target', `${matches.length} sections match the added section.`);
  }
  const section = matches[0];
  if (section.questions.length > 0) {
    return impossible(
      'graph_drift',
      'The added section now contains questions; move or delete them before reverting.'
    );
  }
  return {
    ok: true,
    plan: {
      ops: [{ op: 'delete-section', sectionId: section.id }],
      summary: `Delete the added section “${section.title}”.`,
    },
  };
}

type ResolveResult =
  | {
      ok: true;
      target:
        | { kind: 'question'; question: SnapshotQuestion }
        | { kind: 'section'; section: SnapshotSection };
    }
  | { ok: false; reason: RevertImpossibleReason; detail: string };

/** Shared reconcile-or-typed-failure used by the editorial planners. */
function resolveOrFail(change: RevertableChange, snapshot: GraphSnapshot): ResolveResult {
  const resolved = reconcileTarget(change, snapshot);
  if (resolved.kind === 'none') {
    return {
      ok: false,
      reason: 'target_not_found',
      detail: 'No current entity matches the post-edit value; it may have been edited or deleted.',
    };
  }
  if (resolved.kind === 'ambiguous') {
    return {
      ok: false,
      reason: 'ambiguous_target',
      detail: `${resolved.count} entities match; revert manually.`,
    };
  }
  return { ok: true, target: resolved };
}

// ─── Entry point ──────────────────────────────────────────────────────────────

/**
 * Plan the revert of one change against the current graph, or report why it
 * can't be done. Pure — call it both as a pre-fork dry run (fail fast) and again
 * against the editable version before executing.
 */
export function planRevert(change: RevertableChange, snapshot: GraphSnapshot): RevertPlanResult {
  switch (change.changeType) {
    case 'infer_goal':
      return planInferGoal(snapshot);
    case 'infer_audience':
      return planInferAudience(change, snapshot);
    case 'prune_section':
      return planPruneSection(change);
    case 'prune_question':
      return planPruneQuestion(change, snapshot);
    case 'rewrite_prompt':
    case 'correct_spelling':
    case 'correct_grammar':
      return planFieldRestore(change, snapshot, ['prompt', 'guidelines', 'title', 'description']);
    case 'augment_question':
      return planFieldRestore(change, snapshot, ['prompt', 'guidelines', 'rationale']);
    case 'infer_type':
      return planInferType(change, snapshot);
    case 'merge_questions':
      return planMergeRestore(change, snapshot);
    case 'split_question':
      return planSplitRestore(change, snapshot);
    case 'add_section':
      return planAddSectionRestore(change, snapshot);
    default:
      return impossible('structural_inverse_unavailable', 'Unsupported change type.');
  }
}

/** Whether `reason` is a known impossible reason (for narrowing API error details). */
export function isRevertImpossibleReason(value: string): value is RevertImpossibleReason {
  return (REVERT_IMPOSSIBLE_REASONS as readonly string[]).includes(value);
}
