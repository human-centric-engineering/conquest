/**
 * The probe-confirm contradiction flow — pure helpers (no Prisma / Next).
 *
 * When the detector flags a `probe`-mode contradiction, nothing is overwritten this turn. Instead
 * the interviewer asks a reconciliation question and the finding is parked as a
 * {@link PendingContradiction} on the session; the NEXT turn resolves it. This module builds the two
 * artefacts the detection turn needs from a {@link ContradictionFinding}:
 *
 *   1. the deterministic interviewer message (the reconciliation question PLUS an explicit,
 *      plain-language statement that confirming will CHANGE the earlier answer and the linked saved
 *      data — the respondent must never have an answer rewritten silently), and
 *   2. the {@link PendingContradiction} to persist.
 *
 * Pure and unit-testable: the orchestrator supplies human labels for the conflicting slots; this
 * module owns the wording so the consequence sentence can't drift between question and data-slot mode.
 */

import type {
  ContradictionFinding,
  PendingContradiction,
} from '@/lib/app/questionnaire/contradiction/types';

/**
 * Fallback reconciliation questions when the detector returned a `probe`-mode finding with no probe
 * of its own. Two variants, chosen by the finding's confidence (see {@link CLEAR_CONTRADICTION_CONFIDENCE}):
 * a plain, direct one for a clear-cut conflict, and a humbler, hedged one for a subtle/ambiguous one
 * — the same clear-vs-subtle calibration the detector prompt asks the model to apply to its own probe.
 */
/** Direct fallback — used when the conflict is clear-cut (confidence at/above the threshold). */
export const DEFAULT_RECONCILIATION_QUESTION =
  'A moment ago this seemed to point one way, and just now it sounded different — which best reflects how you really feel?';

/** Humble fallback — used when the conflict is subtle/ambiguous (confidence below the threshold). */
export const HUMBLE_RECONCILIATION_QUESTION =
  "Forgive me if I've misunderstood — it seemed a moment ago this pointed one way, and just now I may be reading it differently. Which best reflects how you really feel?";

/**
 * At or above this detector confidence a missing-probe finding is treated as clear-cut (direct
 * fallback); below it, as subtle/ambiguous (humble fallback). Mirrors the "clear and obvious vs
 * subtle or ambiguous" split the detector prompt applies to the LLM-authored probe.
 */
export const CLEAR_CONTRADICTION_CONFIDENCE = 0.8;

/**
 * Human labels for the conflicting slots, so the consequence sentence names what will change in the
 * respondent's own terms. `questionLabels` maps a question slotKey → its prompt; `dataSlotLabels`
 * (data-slot mode) maps a question slotKey → the data slot NAME that captures it. The data-slot name
 * is preferred when present (it's the respondent-facing topic); otherwise the question prompt is used.
 */
export interface ContradictionProbeLabels {
  questionLabels: Map<string, string>;
  dataSlotLabels?: Map<string, string>;
}

/** A short, de-duplicated, human list of the topics a confirmation would change. */
function affectedTopics(slotKeys: string[], labels: ContradictionProbeLabels): string[] {
  const seen = new Set<string>();
  const topics: string[] = [];
  for (const key of slotKeys) {
    const label = labels.dataSlotLabels?.get(key) ?? labels.questionLabels.get(key) ?? key;
    const trimmed = label.trim();
    if (trimmed.length > 0 && !seen.has(trimmed.toLowerCase())) {
      seen.add(trimmed.toLowerCase());
      topics.push(trimmed);
    }
  }
  return topics;
}

/** Join a short list as "a", "a and b", or "a, b and c". */
function humanJoin(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** The reconciliation question for one finding: its own probe, or a confidence-graded default. */
function questionFor(finding: ContradictionFinding): string {
  if (typeof finding.suggestedProbe === 'string' && finding.suggestedProbe.trim().length > 0) {
    return finding.suggestedProbe.trim();
  }
  return finding.confidence >= CLEAR_CONTRADICTION_CONFIDENCE
    ? DEFAULT_RECONCILIATION_QUESTION
    : HUMBLE_RECONCILIATION_QUESTION;
}

/** De-duplicated union of every finding's slot keys (first-seen order). */
function unionSlotKeys(findings: ContradictionFinding[]): string[] {
  return [...new Set(findings.flatMap((f) => f.slotKeys))];
}

/**
 * The informational "I noticed something" message for the blue notice. A single finding shows its
 * explanation verbatim (unchanged). Several conflicts detected in ONE turn are combined into a single
 * box — a short lead-in plus a numbered line per conflict — so the respondent sees one coherent notice
 * rather than a stack of separate callouts. Rendered with `whitespace-pre-line`, so the `\n` breaks show.
 */
export function buildContradictionNoticeMessage(findings: ContradictionFinding[]): string {
  if (findings.length <= 1) return findings[0]?.explanation ?? '';
  const points = findings.map((f, i) => `${i + 1}. ${f.explanation}`).join('\n');
  return `A few things you've said might not quite line up:\n\n${points}`;
}

/**
 * Build the reconciliation message + the {@link PendingContradiction} to persist for the probe-mode
 * conflict(s) raised THIS turn. Usually one finding: the message is two short paragraphs — the
 * reconciliation question, then a plain statement of the consequence (confirming updates the earlier
 * answer + the saved data). When a turn surfaces SEVERAL conflicts, they're combined into ONE probe
 * that raises each as a numbered point to clarify, followed by a single consequence naming every
 * affected topic — and every conflict is parked in {@link PendingContradiction.findings} so the next
 * turn reconciles them all. `dataMode` tweaks the noun ("saved responses" vs "the saved data record").
 */
export function buildContradictionProbe(input: {
  findings: ContradictionFinding[];
  statement: string;
  raisedAtTurnIndex: number;
  labels: ContradictionProbeLabels;
  dataMode: boolean;
}): { text: string; pending: PendingContradiction } {
  const { findings, statement, raisedAtTurnIndex, labels, dataMode } = input;

  const union = unionSlotKeys(findings);
  const topics = affectedTopics(union, labels);
  const topicClause = topics.length > 0 ? ` about ${humanJoin(topics)}` : '';
  const dataNoun = dataMode ? 'the linked saved data' : 'your saved responses';
  const answerNoun = findings.length > 1 ? 'earlier answers' : 'earlier answer';
  const consequence =
    `Just so you know: if you confirm the newer view, I'll update your ${answerNoun}${topicClause} ` +
    `(and ${dataNoun}) to match. If I've misread you, let me know and I'll leave it as it was.`;

  // One conflict → the question stands alone. Several → raise each as a numbered point to clarify.
  const questionBlock =
    findings.length <= 1
      ? questionFor(findings[0])
      : `I want to make sure I've understood a couple of things:\n\n` +
        findings.map((f, i) => `${i + 1}. ${questionFor(f)}`).join('\n\n');

  const text = `${questionBlock}\n\n${consequence}`;

  const firstProbe = findings.find(
    (f) => typeof f.suggestedProbe === 'string' && f.suggestedProbe.trim().length > 0
  )?.suggestedProbe;
  const pending: PendingContradiction = {
    slotKeys: union,
    explanation: findings.map((f) => f.explanation).join(' '),
    ...(firstProbe !== undefined ? { suggestedProbe: firstProbe } : {}),
    statement,
    raisedAtTurnIndex,
    findings: findings.map((f) => ({
      slotKeys: f.slotKeys,
      explanation: f.explanation,
      ...(f.suggestedProbe !== undefined ? { suggestedProbe: f.suggestedProbe } : {}),
    })),
  };

  return { text, pending };
}
