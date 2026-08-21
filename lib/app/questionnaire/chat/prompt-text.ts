/**
 * The single choke point for admin-authored free text on its way into a system prompt.
 *
 * Every questionnaire setting that lets a client write prose the interviewer will read — house
 * rules, opening examples — funnels through {@link narrowPromptText} on the READ path, so the
 * defence re-applies on every render and therefore also covers rows written before it existed and
 * rows edited by hand straight into the database.
 */

/**
 * Trim a possibly-garbage value to a bounded string (`''` when it isn't one), with the prompt's
 * section delimiters neutralised.
 *
 * The angle-bracket strip is the hardening. Admin text is spliced into an XML-tag-sectioned system
 * prompt, so text containing `</house_rules><output_format>…` would render a syntactically valid
 * fake section. In practice the real `<output_format>` and `<message_shape>` still follow it and
 * later sections win, and each block carries its own subordination clause — but that is
 * prompt-ordering convention, not enforcement, and no legitimate rule or example needs angle
 * brackets. Stripping them costs nothing and closes it at the single point every render path flows
 * through. Replaced rather than deleted so text that mentions "<10 people" still reads sensibly.
 */
export function narrowPromptText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.replaceAll('<', '‹').replaceAll('>', '›').trim().slice(0, max);
}
