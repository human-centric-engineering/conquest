/**
 * Turn-evaluation → Markdown serialization.
 *
 * Renders a {@link TurnEvaluation} verdict as a single Markdown document following the
 * product spec's section headings. Pure (no DOM / Prisma / Next) and shared by the drawer's
 * Copy and Download affordances, so the clipboard text and the downloaded `.md` are byte-for-
 * byte identical and read the same as the on-screen panel.
 */

import type { TurnEvaluation } from '@/lib/app/questionnaire/turn-evaluation/schema';

/** Render a string list as Markdown bullets, or an em-dash when empty. */
function bullets(items: string[]): string {
  if (items.length === 0) return '—';
  return items.map((i) => `- ${i}`).join('\n');
}

/** A prose section body, or an em-dash when blank. */
function body(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : '—';
}

/**
 * Serialize a verdict to Markdown. `turnIndex` is the 0-based dump index; the heading shows
 * the 1-based turn number to match the drawer.
 */
export function serializeTurnEvaluation(verdict: TurnEvaluation, turnIndex: number): string {
  const i = verdict.interviewer;
  const out: string[] = [];

  out.push(`# Turn ${turnIndex + 1} — Evaluation`);
  out.push('');

  out.push('## Overall Turn Assessment');
  out.push(`Overall Score: ${verdict.overallScore}`);
  out.push(`Effectiveness: ${verdict.effectiveness}`);
  out.push('');

  out.push('## Call-by-Call Evaluation');
  if (verdict.calls.length === 0) {
    out.push('—');
  } else {
    for (const c of verdict.calls) {
      out.push(`### ${c.name}  (Score: ${c.score})`);
      out.push(`Purpose: ${body(c.purpose)}`);
      out.push('');
      out.push('**Instruction Compliance**');
      out.push(body(c.instructionCompliance));
      out.push('');
      out.push('**Output Quality**');
      out.push(body(c.outputQuality));
      out.push('');
      out.push('**Risks**');
      out.push(body(c.risks));
      out.push('');
      out.push('**Improvements**');
      out.push(body(c.improvements));
      out.push('');
    }
  }

  out.push('## Interviewer Evaluation');
  out.push('Question Quality (1–10):');
  out.push(`- Open-endedness: ${i.openEndedness}`);
  out.push(`- Single-topic focus: ${i.singleTopicFocus}`);
  out.push(`- Non-leading phrasing: ${i.nonLeading}`);
  out.push(`- Conversational quality: ${i.conversational}`);
  out.push(`- Cognitive load: ${i.cognitiveLoad}`);
  out.push(`- Specificity: ${i.specificity}`);
  out.push(`- Warmth and rapport: ${i.warmth}`);
  out.push(`- Alignment with interview stage: ${i.stageAlignment}`);
  out.push('');
  out.push('Prompt Compliance — violations:');
  out.push(bullets(i.violations));
  out.push('');

  out.push('## Extraction Evaluation');
  out.push(`Extraction Score: ${verdict.extraction.score}`);
  out.push(`Confidence Quality: ${verdict.extraction.confidenceQuality}`);
  out.push('');
  out.push('**Coverage**');
  out.push(body(verdict.extraction.coverage));
  out.push('');
  out.push('**Missed Signals**');
  out.push(body(verdict.extraction.missedSignals));
  out.push('');
  out.push('**Overreach**');
  out.push(body(verdict.extraction.overreach));
  out.push('');

  out.push('## Question Selection Evaluation');
  out.push(`Question Selection Score: ${verdict.questionSelection.score}`);
  out.push('');
  out.push('**Relevance**');
  out.push(body(verdict.questionSelection.relevance));
  out.push('');
  out.push('**Coverage Strategy**');
  out.push(body(verdict.questionSelection.coverageStrategy));
  out.push('');
  out.push('**Timing**');
  out.push(body(verdict.questionSelection.timing));
  out.push('');
  out.push('**Alternatives**');
  out.push(body(verdict.questionSelection.alternatives));
  out.push('');

  out.push('## Information Gain Analysis');
  out.push(`Information Gain Rating: ${verdict.informationGain.rating}`);
  out.push('');
  out.push(body(verdict.informationGain.analysis));
  out.push('');

  out.push('## Missed Opportunity Analysis');
  out.push(body(verdict.missedOpportunities));
  out.push('');

  out.push('## Prompt Drift Analysis');
  out.push(`Prompt Drift: ${verdict.promptDrift.rating}`);
  out.push('Evidence:');
  out.push(bullets(verdict.promptDrift.evidence));
  out.push('');

  out.push('## Cost and Efficiency Analysis');
  out.push(`Efficiency Rating: ${verdict.efficiency.rating}`);
  out.push('');
  out.push(body(verdict.efficiency.analysis));
  out.push('');

  out.push('## Turn Summary');
  out.push('**Strengths**');
  out.push(bullets(verdict.summary.strengths));
  out.push('');
  out.push('**Weaknesses**');
  out.push(bullets(verdict.summary.weaknesses));
  out.push('');
  out.push(`**Biggest Risk:** ${body(verdict.summary.biggestRisk)}`);
  out.push(`**Biggest Opportunity:** ${body(verdict.summary.biggestOpportunity)}`);
  out.push(`**Recommended Action:** ${body(verdict.summary.recommendedAction)}`);

  return out.join('\n');
}
