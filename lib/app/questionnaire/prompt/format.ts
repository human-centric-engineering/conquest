/**
 * Shared prompt-formatting helpers for the questionnaire LLM prompts.
 *
 * The capability prompts (extraction, selection, the interviewer phraser, …) were each assembled as
 * ad-hoc template literals glued with blank lines, so their section boundaries were invisible — both
 * to a human reading them in the Turn Inspector / Prompt Library and to the model. These helpers
 * standardise that structure: top-level **XML-style section tags** (`<role>`, `<rules>`, `<context>`,
 * `<output_format>`, …) for framing, with prose and the existing `- ` / `1.` lists kept *inside*
 * sections. XML tags (not markdown headers) because some prompts allow the model to emit markdown in
 * its reply — tags can't be confused with output content, and the Claude family attends to them well.
 *
 * Pure (no imports): every consumer is a pure prompt builder. The cardinal rule is that **empty input
 * collapses to `''`** — so an optional section (tone, prior answers, guidelines) costs nothing when
 * absent, exactly as the hand-rolled `condition ? block : ''` patterns did before.
 */

/** Coerce to a trimmed string; non-strings (false/null/undefined) become ''. */
function clean(value: string | false | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Wrap `body` in an XML-style section tag with tidy surrounding newlines. Whitespace-only/empty body
 * ⇒ `''`, so optional sections add nothing to the assembled prompt.
 */
export function section(tag: string, body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return '';
  return `<${tag}>\n${trimmed}\n</${tag}>`;
}

/** Join the non-empty parts with a blank line between them (the canonical section gap). */
export function joinSections(...parts: Array<string | false | null | undefined>): string {
  return parts.map(clean).filter(Boolean).join('\n\n');
}

/** A bullet list, skipping empty items. `''` when nothing survives. */
export function bulletList(
  items: Array<string | false | null | undefined>,
  marker: '-' | '•' = '-'
): string {
  return items
    .map(clean)
    .filter(Boolean)
    .map((item) => `${marker} ${item}`)
    .join('\n');
}

/** A `1. 2. 3.` numbered list, skipping empty items. `''` when nothing survives. */
export function numberedList(items: Array<string | false | null | undefined>): string {
  const kept = items.map(clean).filter(Boolean);
  return kept.map((item, i) => `${i + 1}. ${item}`).join('\n');
}

/** A titled block — `Title:\n<body>`. Empty body ⇒ `''`. */
export function titledBlock(title: string, body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return '';
  return `${title}:\n${trimmed}`;
}

/**
 * A standard JSON-only output contract: a short preface naming the required reply, then the shape.
 * Centralises the "respond with ONLY JSON" wording the builders repeat. `shape` is the literal JSON
 * skeleton (kept verbatim so the builder controls the contract its parser expects).
 */
export function jsonOutputContract(
  shape: string,
  opts?: { preface?: string; trailer?: string }
): string {
  const preface = opts?.preface ?? 'Respond with ONLY this JSON object, nothing else';
  const trailer = opts?.trailer ? ` ${opts.trailer.trim()}` : '';
  return `${preface}:\n${shape}${trailer}`;
}
