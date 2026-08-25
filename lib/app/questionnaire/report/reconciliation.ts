/**
 * Open-vs-close reconciliation (C9 / guardrail G05) — pure, no I/O.
 *
 * A diagnostic asks what the respondent wants at the start, asks what they want done at the end, and
 * scores the ground in between. The workbook that prompted this is blunt about which of those
 * matters most: *"disagreement between what they say they need and what the scores show is the most
 * valuable output the tool produces."*
 *
 * Nothing held the three against each other. The report writer saw the opening answer and the
 * closing ask as two undifferentiated lines among seventy in `buildAnswerTranscript` — `slotKey` is
 * flattened away by the time it gets there — and it saw no scores at all, because no respondent-
 * report code read them. Told to "compare what they said with what the scores show", it could only
 * re-derive an impression from raw likert values in the transcript: an impression blind to
 * reverse-scored items, weights, band cutoffs and cross-scale normalisation, which is the entire
 * reason scoring exists as a separate deterministic layer.
 *
 * So this module does one thing: pull the three apart into named, addressable pieces the writer can
 * be instructed to compare. It decides nothing about whether they agree — that judgement is the
 * writer's, and forcing it here would mean encoding "disagreement" as a threshold, which is exactly
 * the kind of false precision the feature exists to avoid.
 *
 * Two ways to identify the ends, in priority order:
 *
 *  1. **Configured refs** — the admin names the question/data-slot keys. Precise, and the only
 *     option for an instrument with no Conditional Topics topics authored.
 *  2. **Topic phases** — free-text answers under `opening` topics against those under `closing`
 *     ones. Costs no configuration, which matters because a feature nobody switches on produces
 *     nothing; it is necessarily coarser, since it cannot tell "what do you want to achieve" from
 *     any other opening free-text question.
 *
 * Per end, not per report: an instrument may name its goal question precisely and let the close
 * derive, and the record says which happened for each.
 */

import { formatSlotAnswer } from '@/lib/app/questionnaire/panel/format-slot-answer';
import type {
  PanelAnswerInput,
  PanelSectionInput,
} from '@/lib/app/questionnaire/panel/answer-panel';
import type { QuestionType } from '@/lib/app/questionnaire/types';
import type { RespondentScores } from '@/lib/app/questionnaire/scoring/types';
import { isPartiallyAssessed } from '@/lib/app/questionnaire/scoring/types';
import type { TopicPhase } from '@/lib/app/questionnaire/scope/types';

/** How an end of the comparison was identified — recorded so a thin block is explicable. */
export type ReconciliationSource = 'configured' | 'phase' | 'none';

/** One thing the respondent said, kept with the question that elicited it. */
export interface ReconciliationStatement {
  /** The question prompt or data-slot name — context the bare answer does not carry. */
  prompt: string;
  /** What they said, rendered the same way the transcript and the PDF render it. */
  text: string;
}

/** One scale's measured result, reduced to what a comparison needs. */
export interface ReconciliationScale {
  name: string;
  raw: number;
  band: string | null;
  /**
   * True when the interview covered only part of the scale — Conditional Topics (P17). Carried because
   * a partial scale is a weaker basis for contradicting a respondent than a complete one, and the
   * writer has no other way to know the difference.
   */
  partiallyAssessed: boolean;
}

/** The three things held apart, ready for the writer to compare. */
export interface ReconciliationInput {
  statedGoal: ReconciliationStatement[];
  askedForActions: ReconciliationStatement[];
  /** Empty when the version has no scoring schema — the comparison then has only two legs. */
  scored: ReconciliationScale[];
  /**
   * Areas the interview never assessed. Repeated here (the writer already has them from
   * `notAssessedRules`) because in THIS block their absence means something specific: an area with
   * no score is not an area that scored badly, and a comparison is exactly where that slip happens.
   */
  notAssessedLabels: string[];
  goalSource: ReconciliationSource;
  askSource: ReconciliationSource;
}

/** The maximum statements taken from either end — a guard against an opening phase of forty items. */
const MAX_STATEMENTS_PER_END = 8;
/** Statement text is quoted into a prompt; a whole essay from one free-text answer helps nobody. */
const MAX_STATEMENT_CHARS = 1200;

/** A slot the reconciliation can read: prompt + type + the respondent's value. */
interface AnswerableSlot {
  key: string;
  prompt: string;
  type: QuestionType;
  typeConfig: unknown;
}

/** A captured data-slot value, addressable by key. */
export interface ReconciliationDataSlot {
  key: string;
  name: string;
  /** The respondent-facing paraphrase, or null when never filled. */
  value: string | null;
}

export interface BuildReconciliationParams {
  statedGoalRefs: readonly string[];
  askedForRefs: readonly string[];
  sections: readonly PanelSectionInput[];
  answers: readonly PanelAnswerInput[];
  dataSlots: readonly ReconciliationDataSlot[];
  /** Topic phase per question key — empty when the version has no Conditional Topics topics. */
  phaseByQuestionKey: ReadonlyMap<string, TopicPhase>;
  /** Topic phase per data-slot key. */
  phaseByDataSlotKey: ReadonlyMap<string, TopicPhase>;
  /** This respondent's computed scores, or null when the version has no scoring schema. */
  scores: RespondentScores | null;
  /** Scale key → display name, from the scoring schema. */
  scaleNames: ReadonlyMap<string, string>;
  notAssessedLabels: readonly string[];
}

function truncate(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_STATEMENT_CHARS
    ? `${trimmed.slice(0, MAX_STATEMENT_CHARS).trimEnd()}…`
    : trimmed;
}

/** Every question slot in the version, flattened and addressable by key. */
function slotsByKey(sections: readonly PanelSectionInput[]): Map<string, AnswerableSlot> {
  const out = new Map<string, AnswerableSlot>();
  for (const section of sections) {
    for (const slot of section.slots) {
      out.set(slot.slotKey, {
        key: slot.slotKey,
        prompt: slot.prompt,
        type: slot.type as QuestionType,
        typeConfig: slot.typeConfig,
      });
    }
  }
  return out;
}

/**
 * Render one answer as a statement, or null when there is nothing there.
 *
 * A respondent's own words are preferred over the stored value where both exist: the living
 * paraphrase is what the panel shows them, so quoting anything else would have the report arguing
 * with a sentence they were told was theirs.
 */
function statementFor(
  slot: AnswerableSlot,
  answer: PanelAnswerInput | undefined
): ReconciliationStatement | null {
  if (!answer) return null;
  const paraphrase = typeof answer.paraphrase === 'string' ? answer.paraphrase.trim() : '';
  const text = paraphrase || formatSlotAnswer(slot.type, slot.typeConfig, answer.value);
  if (!text || text === '—') return null;
  return { prompt: slot.prompt, text: truncate(text) };
}

/**
 * Collect one end of the comparison.
 *
 * Configured refs win outright, and a configured ref that matched nothing does NOT fall through to
 * the phase derivation: an admin who named a key meant that key, and quietly substituting the whole
 * opening phase would produce a comparison they did not ask for and cannot see is wrong.
 */
function collectEnd(
  refs: readonly string[],
  phase: TopicPhase,
  params: BuildReconciliationParams,
  slots: Map<string, AnswerableSlot>,
  answerByKey: Map<string, PanelAnswerInput>
): { statements: ReconciliationStatement[]; source: ReconciliationSource } {
  const out: ReconciliationStatement[] = [];

  if (refs.length > 0) {
    for (const ref of refs) {
      const slot = slots.get(ref);
      if (slot) {
        const statement = statementFor(slot, answerByKey.get(ref));
        if (statement) out.push(statement);
        continue;
      }
      const dataSlot = params.dataSlots.find((d) => d.key === ref);
      if (dataSlot?.value?.trim()) {
        out.push({ prompt: dataSlot.name, text: truncate(dataSlot.value) });
      }
    }
    return { statements: out.slice(0, MAX_STATEMENTS_PER_END), source: 'configured' };
  }

  // Derived: free text only. A likert answer under an opening topic is a rating, not a statement of
  // what the respondent wants, and quoting "4" as their stated goal would be worse than saying
  // nothing.
  for (const [key, slot] of slots) {
    if (slot.type !== 'free_text') continue;
    if (params.phaseByQuestionKey.get(key) !== phase) continue;
    const statement = statementFor(slot, answerByKey.get(key));
    if (statement) out.push(statement);
  }
  for (const dataSlot of params.dataSlots) {
    if (params.phaseByDataSlotKey.get(dataSlot.key) !== phase) continue;
    if (!dataSlot.value?.trim()) continue;
    out.push({ prompt: dataSlot.name, text: truncate(dataSlot.value) });
  }

  return {
    statements: out.slice(0, MAX_STATEMENTS_PER_END),
    source: out.length > 0 ? 'phase' : 'none',
  };
}

/**
 * Assemble the reconciliation input, or null when there is nothing to reconcile.
 *
 * Null when BOTH ends are empty, not when one is: a stated goal with no closing ask still supports
 * "you said you needed X, and here is what the assessment found", which is most of the value. Null
 * when only scores exist, though — a measurement with nothing claimed against it is just the report.
 */
export function buildReconciliation(params: BuildReconciliationParams): ReconciliationInput | null {
  const slots = slotsByKey(params.sections);
  const answerByKey = new Map(params.answers.map((a) => [a.slotKey, a]));

  const goal = collectEnd(params.statedGoalRefs, 'opening', params, slots, answerByKey);
  const ask = collectEnd(params.askedForRefs, 'closing', params, slots, answerByKey);
  if (goal.statements.length === 0 && ask.statements.length === 0) return null;

  const scored: ReconciliationScale[] = [];
  for (const [scaleKey, score] of Object.entries(params.scores ?? {})) {
    scored.push({
      name: params.scaleNames.get(scaleKey) ?? scaleKey,
      raw: score.raw,
      band: score.band,
      partiallyAssessed: isPartiallyAssessed(score),
    });
  }

  return {
    statedGoal: goal.statements,
    askedForActions: ask.statements,
    scored,
    notAssessedLabels: [...params.notAssessedLabels],
    goalSource: goal.source,
    askSource: ask.source,
  };
}

/** Render a score for the prompt: two decimals, plus its band and whether it is a partial reading. */
function renderScale(scale: ReconciliationScale): string {
  const band = scale.band ? ` — ${scale.band}` : '';
  const partial = scale.partiallyAssessed
    ? ' (PARTIAL: the interview covered only some of this scale, so it is a weaker reading)'
    : '';
  return `- ${scale.name}: ${scale.raw.toFixed(2)}${band}${partial}`;
}

/**
 * The prompt block: three things, held apart, with an instruction to name where they disagree.
 *
 * The instruction is deliberately one-sided. Every other rule in the writer's prompt pushes toward
 * caution — ground it, do not infer, say less where answers are thin — and a report writer under
 * that much restraint will reconcile by finding agreement, which is the failure this feature exists
 * to prevent. Naming the disagreement is the output; smoothing it is the thing that makes the whole
 * exercise pointless.
 *
 * What it does NOT do is manufacture one. "Say where they line up too" is not politeness — a
 * respondent whose ask matches their scores has learned something real, and a writer told only to
 * find conflict would invent it.
 */
export function reconciliationRules(input: ReconciliationInput): string {
  const parts: string[] = [
    'WHAT THEY SAID vs WHAT WAS MEASURED. The three blocks below are the same interview seen three ' +
      'ways: what the respondent said they needed, what they asked to have done, and what the ' +
      'assessment actually measured. Compare them explicitly and give the comparison its own ' +
      'section in the report.',
  ];

  if (input.statedGoal.length > 0) {
    parts.push(
      'WHAT THEY SAID THEY NEEDED (asked at the start, before anything was assessed):\n' +
        input.statedGoal.map((s) => `- ${s.prompt}\n  “${s.text}”`).join('\n')
    );
  }
  if (input.askedForActions.length > 0) {
    parts.push(
      'WHAT THEY ASKED FOR (asked at the end, in their own words):\n' +
        input.askedForActions.map((s) => `- ${s.prompt}\n  “${s.text}”`).join('\n')
    );
  }
  if (input.scored.length > 0) {
    parts.push(
      'WHAT THE ASSESSMENT MEASURED (computed from their answers by fixed rules — these are ' +
        'results, not opinions, and you must not re-derive or dispute them from the transcript):\n' +
        input.scored.map(renderScale).join('\n')
    );
  }

  const guidance: string[] = [
    'Where these disagree, SAY SO PLAINLY and early — a respondent asking for help with one thing ' +
      'while the assessment points at another is the single most useful finding this report can ' +
      'carry, and softening it wastes the exercise. Name the specific gap ("you asked for X; the ' +
      'strongest signal in your answers is Y"), and be concrete about what it implies.',
    'Where they line up, say that too, and say it briefly — agreement between what someone wants ' +
      'and what the evidence shows is a real result, not a missing finding. Do NOT manufacture a ' +
      'disagreement to have something to report.',
    'Address the respondent as you do elsewhere: this is an observation offered to them, not a ' +
      'verdict passed on them. Be direct without being adversarial.',
  ];

  if (input.scored.length === 0) {
    guidance.push(
      'No scores were computed for this questionnaire, so compare what they said they needed ' +
        'against what they asked for, and against the picture their answers actually paint. Do NOT ' +
        'invent a score, a rating, or a level.'
    );
  }
  if (input.scored.some((s) => s.partiallyAssessed)) {
    guidance.push(
      'A scale marked PARTIAL was measured over only part of its questions. You may use it, and you ' +
        'must not lean on it to contradict the respondent as firmly as a complete one.'
    );
  }
  if (input.notAssessedLabels.length > 0) {
    guidance.push(
      'These areas were never assessed, so they have no score and their absence is NOT a low ' +
        'result: ' +
        input.notAssessedLabels.join(', ') +
        '. Do not read a missing measurement as a poor one, and do not tell the respondent they ' +
        'scored badly on something nobody asked them about.'
    );
  }

  parts.push(guidance.join(' '));
  return parts.join('\n\n');
}
