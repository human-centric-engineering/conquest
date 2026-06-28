/**
 * Blank-instrument export — plain-text serialiser (F14.9).
 *
 * Renders an {@link InstrumentModel} as a readable `.txt` document: an intro listing the
 * questionnaire's context (version, goal, audience, counts), then the numbered sections and
 * questions with their type, required marker, answer options/scale, and guidelines. The empty form,
 * for review or paper distribution — no respondent answers.
 *
 * Pure: deterministic in its input. Sibling to {@link file://./build-transcript-text.ts}.
 */

import type { InstrumentModel } from '@/lib/app/questionnaire/export/build-instrument-model';

/** A horizontal rule between blocks. */
const RULE = '─'.repeat(60);

/** Append `Label: value` to `lines` only when the value is present. */
function detail(lines: string[], label: string, value: string | null): void {
  if (value && value.trim().length > 0) lines.push(`${label}: ${value}`);
}

/** Serialise the instrument model to a plain-text document. */
export function buildInstrumentText(model: InstrumentModel): string {
  const lines: string[] = [];

  // ── Intro / header ─────────────────────────────────────────────────────────
  lines.push(model.title);
  lines.push('Questionnaire (blank form)');
  lines.push('');

  detail(lines, 'Version', String(model.versionNumber));
  detail(lines, 'Goal', model.goal);
  detail(lines, 'Audience', model.audienceSummary);
  lines.push(`Sections: ${model.sectionCount} · Questions: ${model.questionCount}`);
  detail(lines, 'Generated', model.generatedAt);
  lines.push('');
  lines.push(RULE);
  lines.push('');

  // ── Sections / questions ─────────────────────────────────────────────────────
  if (model.sections.length === 0) {
    lines.push('This questionnaire has no sections yet.');
  } else {
    for (const section of model.sections) {
      lines.push(`${section.number}. ${section.title}`);
      if (section.description && section.description.trim().length > 0) {
        lines.push(section.description.trim());
      }
      lines.push('');

      if (section.questions.length === 0) {
        lines.push('  (no questions)');
        lines.push('');
        continue;
      }

      for (const q of section.questions) {
        const flags = [q.typeLabel, q.required ? 'required' : 'optional'].join(', ');
        lines.push(`  ${q.number}  ${q.prompt}  [${flags}]`);
        if (q.constraint) lines.push(`      ${q.constraint}`);
        for (const option of q.options) lines.push(`      • ${option}`);
        if (q.guidelines && q.guidelines.trim().length > 0) {
          lines.push(`      Guidance: ${q.guidelines.trim()}`);
        }
        if (q.tags.length > 0) lines.push(`      Tags: ${q.tags.join(', ')}`);
        lines.push('');
      }
    }
  }

  // Single trailing newline; collapse the loop's trailing blank line.
  return `${lines.join('\n').trimEnd()}\n`;
}
