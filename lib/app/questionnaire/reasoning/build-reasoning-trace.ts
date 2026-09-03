/**
 * Build the visible reasoning trace for one turn (demo feature — "watch it think").
 *
 * Pure: maps an in-memory {@link TurnResult} to a short, respondent-safe {@link ReasoningStep}[],
 * in pipeline order (extraction → contradiction → refinement → completion → selection). No Prisma,
 * no Next, no clock — the route calls this right after the turn runs and emits the steps over SSE.
 *
 * **What it deliberately never surfaces:** the seriousness / abuse verdict and the sensitivity
 * disclosure summary. Both are excluded entirely — the abuse reason would be accusatory to show a
 * respondent, and the sensitivity summary is PII-guarded everywhere else (only severity + category
 * leave the server, and never to the respondent). An abuse-abandoned turn produces no trace at all.
 */

import type { TurnResult } from '@/lib/app/questionnaire/orchestrator/types';
import type { DataSlotTarget } from '@/lib/app/questionnaire/orchestrator/types';
import type { QuestionView } from '@/lib/app/questionnaire/selection/types';
import type { RefinementDecision } from '@/lib/app/questionnaire/refinement/types';
import type { AnswerProvenance, SelectionStrategy } from '@/lib/app/questionnaire/types';

import type { ReasoningStep, ReasoningTone } from '@/lib/app/questionnaire/reasoning/types';
import { confidenceBand } from '@/lib/app/questionnaire/panel/confidence';

/** What the builder reads beyond the result — the labels it resolves slot keys/ids against. */
export interface ReasoningTraceOptions {
  /** Every question slot in the version (resolves `slotKey`/`targetedQuestionId` → a human label). */
  questions: QuestionView[];
  /** The version's data slots (data-slot mode) — resolves data-slot keys → their short names. */
  dataSlots?: DataSlotTarget[];
  /** True on the opening/kickoff turn, so the selection step reads as a warm "let's begin". */
  isOpening?: boolean;
  /**
   * Conditional Topics: the areas this turn's reply is announcing, if any.
   *
   * Passed in rather than read off the {@link TurnResult} because the decision is not part of the
   * turn: the plan is sealed at the END of the turn that completes the opening, and announced on the
   * next one. The route already resolves exactly that ("is the announcement due this turn"), so
   * handing the answer down keeps one rule for when the respondent is told, in the chat and here.
   *
   * The rule this must not break is the same one the announcement itself obeys: say WHAT will now be
   * covered and why, never that a decision was made about them, and never a key, score or criterion.
   */
  scopeDecision?: ScopeDecisionNote;
}

/** One announcement's worth of areas, as {@link ReasoningTraceOptions.scopeDecision} carries it. */
export interface ScopeDecisionNote {
  /**
   * Whether the whole interview was just shaped (`planned`), or one area was brought in while the
   * opening was still running (`seated`). Two genuinely different moments, and the trace should not
   * describe a partial decision as the whole one.
   */
  kind: 'planned' | 'seated';
  /** Respondent-facing area labels, in the order the interview will meet them. */
  labels: string[];
}

/** Most extraction steps a single turn may show — a side-effect-heavy reply shouldn't flood the feed. */
const MAX_EXTRACTION_STEPS = 8;
/** A question prompt trimmed to a chip-sized label. */
const MAX_LABEL_CHARS = 64;

function shortLabel(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length > MAX_LABEL_CHARS ? `${trimmed.slice(0, MAX_LABEL_CHARS - 1)}…` : trimmed;
}

/** Respondent-facing phrasing of how a value was arrived at. */
function provenancePhrase(provenance: AnswerProvenance): string {
  switch (provenance) {
    case 'direct':
      return 'Directly from what you said';
    case 'inferred':
      return 'Inferred from your answer';
    case 'synthesised':
      return 'Pieced together from the conversation';
    case 'refined':
      return 'Updated from later context';
  }
}

/** `inferred`/`synthesised`/`refined` are the "intelligent" moments worth a highlight. */
function provenanceTone(provenance: AnswerProvenance): ReasoningTone {
  return provenance === 'direct' ? 'neutral' : 'insight';
}

/** A short account of what prompted a refinement (its `source`) — the `detail`; the refiner's own
 *  `rationale` rides the separate italic line. */
function refinementSourcePhrase(source: RefinementDecision['source']): string {
  switch (source) {
    case 'contradiction':
      return 'Reconciled a conflict with an earlier answer';
    case 'clarification':
      return 'Clarified from later context';
    case 'correction':
      return 'Corrected an earlier capture';
    case 'manual':
      return 'You edited this directly';
  }
}

/** Trim a captured rationale, returning undefined when empty so the field stays optional. */
function cleanRationale(rationale: string | undefined): string | undefined {
  const trimmed = rationale?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/** Friendly, per-strategy account of the next-question choice (the deterministic strategies have
 *  terse internal rationales; `adaptive` carries a real LLM sentence we prefer verbatim). */
function selectionDetail(
  strategy: SelectionStrategy | undefined,
  rationale: string | undefined
): string | undefined {
  switch (strategy) {
    case 'sequential':
      return 'Working through the questionnaire in order.';
    case 'random':
      return 'Picking the next one to keep things varied.';
    case 'weighted':
      return 'Prioritising the areas that matter most right now.';
    case 'adaptive':
      return rationale ?? 'Choosing what follows most naturally from your last answer.';
    default:
      // Data-slot mode (no strategy) carries its own phrased rationale.
      return rationale;
  }
}

export function buildReasoningTrace(
  result: TurnResult,
  opts: ReasoningTraceOptions
): ReasoningStep[] {
  // An abuse-abandoned turn must read as nothing but the polite final message — no reasoning.
  if (result.abuse?.flagged) return [];

  const steps: ReasoningStep[] = [];

  const questionLabelByKey = new Map(opts.questions.map((q) => [q.key, q.prompt ?? '']));
  const questionLabelById = new Map(opts.questions.map((q) => [q.id, q.prompt ?? '']));
  const dataSlotNameByKey = new Map((opts.dataSlots ?? []).map((s) => [s.key, s.name]));

  const questionLabel = (key: string): string => {
    const prompt = questionLabelByKey.get(key);
    return prompt && prompt.trim().length > 0 ? shortLabel(prompt) : 'your answer';
  };

  // 1. Extraction. In data-slot mode the respondent-facing capture is the data-slot fills; in
  //    question mode it's the answer upserts. Provisional fills are parked placeholders, not real
  //    captures — skip them so the feed never claims to have captured something it gave up on.
  const dataSlotFills = result.sideEffects.dataSlotFills ?? [];
  if ((opts.dataSlots?.length ?? 0) > 0 && dataSlotFills.length > 0) {
    for (const fill of dataSlotFills.filter((f) => !f.provisional).slice(0, MAX_EXTRACTION_STEPS)) {
      const name = dataSlotNameByKey.get(fill.dataSlotKey) ?? 'a detail';
      const rationale = cleanRationale(fill.rationale);
      steps.push({
        kind: 'extraction',
        label: `Captured ${name}`,
        ...(fill.paraphrase.trim().length > 0 ? { detail: fill.paraphrase.trim() } : {}),
        ...(rationale ? { rationale } : {}),
        confidence: fill.confidence,
        provenance: fill.provenance,
        tone: provenanceTone(fill.provenance),
      });
    }
  } else {
    for (const intent of result.sideEffects.answerUpserts.slice(0, MAX_EXTRACTION_STEPS)) {
      const rationale = cleanRationale(intent.rationale);
      steps.push({
        kind: 'extraction',
        label: `Captured "${questionLabel(intent.slotKey)}"`,
        detail: `${provenancePhrase(intent.provenance)} · ${confidenceBand(intent.confidence)} confidence`,
        ...(rationale ? { rationale } : {}),
        ...(intent.sourceQuote ? { sourceQuote: intent.sourceQuote } : {}),
        confidence: intent.confidence,
        provenance: intent.provenance,
        tone: provenanceTone(intent.provenance),
      });
    }
  }

  // 2. Contradiction — a gentle "noticed a conflict" (the probe itself still rides the chat notice).
  for (const finding of result.contradictions) {
    steps.push({
      kind: 'contradiction',
      label: 'Spotted a possible contradiction',
      ...(finding.explanation.trim().length > 0 ? { detail: finding.explanation.trim() } : {}),
      confidence: finding.confidence,
      tone: 'caution',
    });
  }

  // 3. Refinement — an earlier answer evolved in light of this turn. `detail` says what prompted it
  //    (the source); the refiner's own `rationale` rides the separate italic line.
  for (const decision of result.sideEffects.answerRefinements) {
    const rationale = cleanRationale(decision.rationale);
    steps.push({
      kind: 'refinement',
      label: `Updated "${questionLabel(decision.slotKey)}"`,
      detail: refinementSourcePhrase(decision.source),
      ...(rationale ? { rationale } : {}),
      confidence: decision.confidence,
      provenance: 'refined',
      tone: 'insight',
    });
  }

  // 4. Completion — readiness / progress. Skipped on an empty opening turn (nothing answered yet).
  const pct = Math.round(result.assessment.coverage * 100);
  if (result.assessment.kind === 'offer') {
    steps.push({
      kind: 'completion',
      label: 'Looks like we have what we need',
      detail: `${pct}% covered · ${result.assessment.answeredCount} answered`,
      tone: 'insight',
    });
  } else if (result.assessment.answeredCount > 0) {
    steps.push({
      kind: 'completion',
      label:
        result.assessment.kind === 'blocked_on_required'
          ? 'A few required questions still to go'
          : 'Tracking your progress',
      detail: `${pct}% covered so far`,
      tone: 'neutral',
    });
  }

  // 4b. Scope — Conditional Topics has just decided which areas of the questionnaire this
  //     respondent gets, and the reply is saying so. Without this the interview visibly changed
  //     shape and the one surface whose whole job is to account for its choices said nothing about
  //     the largest choice it makes.
  //
  //     Before the selection step, because it is the reason behind it: what the interview will now
  //     cover, then the question it is asking out of that.
  const scope = opts.scopeDecision;
  if (scope && scope.labels.length > 0) {
    steps.push({
      kind: 'scope',
      label:
        scope.kind === 'planned'
          ? 'Focusing on what matters for you'
          : 'Adding something worth going into',
      detail:
        scope.labels.length === 1
          ? `We'll cover ${scope.labels[0]}.`
          : `We'll cover ${scope.labels.slice(0, -1).join(', ')} and ${scope.labels[scope.labels.length - 1]}.`,
      tone: 'insight',
    });
  }

  // 5. Selection — the marquee "why this, next". Offer/complete turns selected nothing (the
  //    completion step above already speaks); `none` notes the end.
  const response = result.response;
  const selDetail = selectionDetail(result.selectionStrategy, result.selectionRationale);
  if (response.kind === 'question') {
    const prompt = result.targetedQuestionId
      ? questionLabelById.get(result.targetedQuestionId)
      : undefined;
    const label = prompt && prompt.trim().length > 0 ? shortLabel(prompt) : 'the next question';
    steps.push({
      kind: 'selection',
      label: opts.isOpening ? `Let's start with "${label}"` : `Asking about "${label}" next`,
      ...(selDetail ? { detail: selDetail } : {}),
      tone: 'insight',
    });
  } else if (response.kind === 'data_slot') {
    steps.push({
      kind: 'selection',
      label: opts.isOpening
        ? `Let's start with ${response.name}`
        : `Exploring ${response.name} next`,
      ...(selDetail ? { detail: selDetail } : {}),
      tone: 'insight',
    });
  } else if (response.kind === 'none') {
    steps.push({
      kind: 'selection',
      label: "We've reached the end of the questions",
      tone: 'neutral',
    });
  } else if (response.kind === 'section_covered') {
    // P21: nothing was selected, because there was nothing left in this part to select. The trace
    // says which part ended rather than falling silent, which would read as a turn that did nothing.
    steps.push({
      kind: 'selection',
      label: "That's this part covered",
      ...(response.nextLabel ? { detail: `${response.nextLabel} is next.` } : {}),
      tone: 'neutral',
    });
  } else if (response.kind === 'contradiction_probe') {
    steps.push({
      kind: 'selection',
      label: 'Checking before changing an earlier answer',
      detail:
        'Asking you to confirm the apparent change of heart — nothing is updated until you do.',
      tone: 'caution',
    });
  }

  return steps;
}
