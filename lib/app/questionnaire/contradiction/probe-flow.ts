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

/** Fallback reconciliation question when the detector returned a `probe`-mode finding with no probe. */
export const DEFAULT_RECONCILIATION_QUESTION =
  'A moment ago this seemed to point one way, and just now it sounded different — which best reflects how you really feel?';

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

/**
 * Build the reconciliation message + the {@link PendingContradiction} to persist for one probe-mode
 * finding. The message is two short paragraphs: the reconciliation question, then a plain statement
 * of the consequence (confirming updates the earlier answer + the saved data). `dataMode` tweaks the
 * noun ("saved responses" vs "the saved data record") so the wording reads naturally in each surface.
 */
export function buildContradictionProbe(input: {
  finding: ContradictionFinding;
  statement: string;
  raisedAtTurnIndex: number;
  labels: ContradictionProbeLabels;
  dataMode: boolean;
}): { text: string; pending: PendingContradiction } {
  const { finding, statement, raisedAtTurnIndex, labels, dataMode } = input;

  const question =
    typeof finding.suggestedProbe === 'string' && finding.suggestedProbe.trim().length > 0
      ? finding.suggestedProbe.trim()
      : DEFAULT_RECONCILIATION_QUESTION;

  const topics = affectedTopics(finding.slotKeys, labels);
  const topicClause = topics.length > 0 ? ` about ${humanJoin(topics)}` : '';
  const dataNoun = dataMode ? 'the linked saved data' : 'your saved responses';
  const consequence =
    `Just so you know: if you confirm the newer view, I'll update your earlier answer${topicClause} ` +
    `(and ${dataNoun}) to match. If I've misread you, let me know and I'll leave it as it was.`;

  const text = `${question}\n\n${consequence}`;

  const pending: PendingContradiction = {
    slotKeys: finding.slotKeys,
    explanation: finding.explanation,
    ...(finding.suggestedProbe !== undefined ? { suggestedProbe: finding.suggestedProbe } : {}),
    statement,
    raisedAtTurnIndex,
  };

  return { text, pending };
}
