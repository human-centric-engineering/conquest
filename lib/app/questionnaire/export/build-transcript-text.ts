/**
 * Chat-transcript export — plain-text serialiser (F7.6).
 *
 * Renders a {@link TranscriptExportModel} as a readable `.txt` document: an intro that
 * explains the questionnaire context and lists the run's key details (reference, version,
 * goal, audience, respondent, timing, status), then the conversation — each turn labelled
 * ("Interviewer" / the respondent) and timestamped.
 *
 * Pure: deterministic in its input (timestamps formatted in UTC via the shared
 * {@link formatTranscriptStamp}), no Prisma / Next / clock. Sibling to the React-PDF
 * document — same model, same intro, plain text instead of a branded layout.
 */

import type { TranscriptExportModel } from '@/lib/app/questionnaire/export/transcript-types';
import {
  formatTranscriptStamp,
  humaniseSessionStatus,
} from '@/lib/app/questionnaire/export/transcript-format';

/** A horizontal rule between the intro and the conversation. */
const RULE = '─'.repeat(60);

/** Append `Label: value` to `lines` only when the value is present. */
function detail(lines: string[], label: string, value: string | null): void {
  if (value && value.trim().length > 0) lines.push(`${label}: ${value}`);
}

/** Serialise the transcript model to a plain-text document. */
export function buildTranscriptText(model: TranscriptExportModel): string {
  const lines: string[] = [];

  // ── Intro / header ─────────────────────────────────────────────────────────
  lines.push(model.questionnaireTitle);
  lines.push('Conversation transcript');
  lines.push('');

  detail(lines, 'Reference', model.refDisplay);
  detail(lines, 'Version', String(model.versionNumber));
  detail(lines, 'Goal', model.goal);
  detail(lines, 'Audience', model.audienceSummary);
  detail(lines, 'Respondent', model.anonymous ? 'Anonymous' : model.respondentLabel);
  detail(lines, 'Started', formatTranscriptStamp(model.startedAt));
  if (model.completedAt) detail(lines, 'Completed', formatTranscriptStamp(model.completedAt));
  detail(lines, 'Status', humaniseSessionStatus(model.status));
  detail(lines, 'Generated', formatTranscriptStamp(model.generatedAt));
  lines.push('');

  lines.push(
    `This is a record of your conversation with ${model.questionnaireTitle}. ` +
      `"${model.interviewerLabel}" is the questionnaire assistant; "${model.respondentLabel}" is you. ` +
      'Each turn is timestamped; times are shown in UTC.'
  );
  lines.push('');
  lines.push(RULE);
  lines.push('');

  // ── Conversation ───────────────────────────────────────────────────────────
  if (model.turns.length === 0) {
    lines.push('No conversation was recorded for this session.');
  } else {
    for (const turn of model.turns) {
      const label = turn.speaker === 'interviewer' ? model.interviewerLabel : model.respondentLabel;
      lines.push(`[${formatTranscriptStamp(turn.at)}] ${label}:`);
      lines.push(turn.text.trim());
      lines.push('');
    }
  }

  // Single trailing newline; collapse the loop's trailing blank line.
  return `${lines.join('\n').trimEnd()}\n`;
}
