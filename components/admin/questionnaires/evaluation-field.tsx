/**
 * The shared typography of the evaluation surfaces.
 *
 * A finding card interleaves two voices — the questionnaire's own words ("How would you rate the
 * effectiveness of our sales strategy?") and the panel's commentary about them ("Add a question on
 * actual sales outcomes") — and a reader landing mid-card must be able to tell which is which
 * without reading either. That is the only distinction this page's typography exists to carry.
 *
 * It was carrying far more than that. One card had two families plus a mono chip, five sizes
 * (11/12/13/14/16px), three weights, italics, four badge variants and five uppercase eyebrows
 * stacked down its left edge — every block announcing itself so loudly that none of them read as
 * more important than any other. The fix is not more signals, it is fewer:
 *
 * ## The scale — four steps, no others
 *
 * | Role                                   | Treatment                                  |
 * | -------------------------------------- | ------------------------------------------ |
 * | The subject of a group                 | serif, `text-lg`, regular                  |
 * | Questionnaire wording inside a card    | serif, `text-base`, regular                |
 * | Prose — suggestion, rationale, evidence| sans, `text-sm`, regular                   |
 * | Meta, labels, counts, decisions        | sans, `text-xs`, medium, muted             |
 *
 * ## The rules that keep it there
 *
 *  - **Two families, one job each.** {@link QUESTION_FACE} is the questionnaire's voice and nothing
 *    else's; sans is everything the system says *about* it. There is no third family — a raw target
 *    key set in mono was a developer's debug string wearing a badge.
 *  - **One weight for prose.** `font-medium` is for labels and for the single verb a card leads
 *    with. Nothing is bold. Nothing is italic: a serif and its quote marks already say "quoted",
 *    and slanting the small sizes on top of that only cost legibility.
 *  - **The eyebrow is structure, so it must stay rare.** {@link FieldLabel} names a block whose
 *    content would otherwise be mistaken for the block above it. Suggestion and rationale no longer
 *    take one — position and colour separate them — which is what lets the eyebrows that remain
 *    (the target, the drafted question) still mean something.
 *  - **Facts run on one line.** {@link MetaRow} dot-separates them instead of giving each its own
 *    pill, so colour is left free for the one thing that is genuinely a signal: severity.
 */

import { cn } from '@/lib/utils';

/**
 * The eyebrow — the label above a block whose content would otherwise be read as a continuation of
 * the block before it.
 *
 * Also used standalone for the group context chip in the by-question view. Sized at the meta step
 * (12px) rather than a bespoke 11px: an eyebrow is meta, and a size that exists only here is a
 * fifth step in a four-step scale.
 */
export function FieldLabel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'text-muted-foreground text-xs font-medium tracking-[0.08em] uppercase',
        className
      )}
    >
      {children}
    </span>
  );
}

/**
 * A labelled block of prose. `label` names what the reader is looking at; `children` is the
 * content, styled by the caller — the label is the constant, the body varies.
 *
 * Reach for this only where the block genuinely needs naming (see the eyebrow rule above). Most
 * prose on these cards is now separated by position and colour instead.
 */
export function LabelledField({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <FieldLabel>{label}</FieldLabel>
      <div className="mt-1">{children}</div>
    </div>
  );
}

/**
 * A row of facts about a card, dot-separated on one line.
 *
 * The alternative — and what this replaces — is a pill for each: a severity badge, a judge badge, a
 * mono key chip, a status badge, four different fills across four different variants sitting in one
 * row. That reads as four alerts rather than one sentence of context, and it spends the page's
 * whole colour budget on facts that are not warnings. Here only severity keeps a badge; the rest is
 * text, and the dots do the separating that borders were doing.
 *
 * `null` / `false` children are dropped, so callers can inline conditions without emitting a
 * dangling separator.
 */
export function MetaRow({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const items = (Array.isArray(children) ? children : [children]).filter(
    (child) => child !== null && child !== undefined && child !== false && child !== ''
  );

  return (
    <span
      className={cn(
        'text-muted-foreground flex flex-wrap items-center gap-x-1.5 text-xs',
        className
      )}
    >
      {items.map((item, i) => (
        <span key={i} className="flex items-center gap-x-1.5">
          {i > 0 && (
            <span aria-hidden="true" className="opacity-50">
              ·
            </span>
          )}
          {item}
        </span>
      ))}
    </span>
  );
}

/**
 * The face reserved for **the questionnaire's own words** — a question prompt, a reconciled
 * rewrite, a prompt quoted inside a judge's sentence.
 *
 * This is the ConQuest display serif already loaded on the admin surface for the wordmark, so it is
 * a face the reviewer has seen here rather than a new aesthetic imported for one page. Never the
 * only signal — block-level question text keeps its curly quotes, and inline quotes keep their
 * marks — because a font swap is invisible to a screen reader and to anyone whose browser failed to
 * load it.
 */
export const QUESTION_FACE = 'font-[family-name:var(--font-display-cq)]';

/**
 * A comfortable measure for body prose.
 *
 * The admin shell is full-bleed, so on a wide display a rationale ran the whole width of the
 * window — well past 150 characters a line, where the eye loses its place on the return sweep. The
 * cap is on the *text*, not just the card, because a card also holds badges and buttons that
 * legitimately want the extra width.
 */
export const PROSE_MEASURE = 'max-w-[68ch]';

/** The measure for questionnaire wording, which is set larger and so wants a shorter line. */
export const QUESTION_MEASURE = 'max-w-[54ch]';

/**
 * Matches a double-quoted span — straight or curly. One character minimum, so a bare `""` is not a
 * quote but a single-character option is.
 *
 * The floor is 1 and not 2 because a lazy `{2,}?` does not skip a short span, it *swallows* it: on
 * `Offer "y" or "n"` the two-character floor makes the only match the ` or ` between them, so the
 * connective prose gets set as the questionnaire's wording and the proposed options do not. One
 * character is a legitimate thing to propose — a scale label, a code, an option letter.
 *
 * Built per call rather than shared: a `g`-flagged regex carries a `lastIndex` cursor, so a
 * module-level one would make the second read of the same string skip its first quote — and
 * mutating it during render is exactly the shared state React's compiler forbids.
 */
export function quotedSpans(text: string): { text: string; quoted: boolean }[] {
  const re = /[“"]([^”"]+?)[”"]/g;
  const parts: { text: string; quoted: boolean }[] = [];
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    if (match.index > last) parts.push({ text: text.slice(last, match.index), quoted: false });
    parts.push({ text: match[1], quoted: true });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), quoted: false });
  return parts;
}

/**
 * A judge's sentence with its quoted spans set in {@link QUESTION_FACE}.
 *
 * Judges write two shapes of suggestion: the bare replacement prompt, and a sentence that carries
 * the prompt inside quotes ("Add a direct question on runway, such as: “If your main income stopped
 * tomorrow…”"). In the second shape the part the reviewer actually needs to read — the wording
 * being proposed — was buried mid-sentence in the same face as the advice around it. Here it
 * changes face, so it can be found without reading the sentence that contains it. On the run this
 * was built against, 27 of 40 suggestions were that second shape.
 *
 * Roman, not italic. The face and the quotation marks are already two signals; the slant was a
 * third, and it landed on the longest strings at the smallest sizes — a whole proposed question set
 * in slanted serif is the hardest thing on the card to read, which is exactly backwards.
 *
 * What it marks is *quoted material*, which on this page is near-always the questionnaire's own
 * words — a proposed prompt in a suggestion, the phrase under criticism in a rationale ("“Real
 * ownership,” is doing a lot of work here"). That is a claim the text makes about itself, via its
 * own quote marks, rather than something inferred: text with no quoted span renders unchanged, and
 * this never restyles a whole sentence on a guess about whether it "looks like" a question.
 */
export function QuotedProse({ text }: { text: string }) {
  const parts = quotedSpans(text);
  if (!parts.some((p) => p.quoted)) return <>{text}</>;

  return (
    <>
      {parts.map((part, i) =>
        part.quoted ? (
          // `<q>` rather than a styled span: the quotation marks come back from the UA stylesheet,
          // so the marks survive for anyone the face does not reach.
          <q key={i} className={cn(QUESTION_FACE, 'text-foreground')}>
            {part.text}
          </q>
        ) : (
          part.text
        )
      )}
    </>
  );
}

/** Fold away the differences that don't change what a reader takes from a line of text. */
export function normalizeQuote(text: string): string {
  return text
    .replace(/[“”„‟"'‘’]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.?!,;:\s]+$/, '')
    .trim()
    .toLowerCase();
}

/**
 * Remove from `text` any quoted span that merely restates one of `shown` — wording the card is
 * already printing in full somewhere else.
 *
 * A judge drafting a new question writes its suggestion as `Add a question on sales outcomes:
 * “How would you rate…?”`, and the card then previews that same drafted prompt below in its own
 * block. Unstripped, the reviewer reads the proposed question twice within four lines, in two
 * different treatments, and has to compare them character by character to discover they are the
 * same sentence — the single worst piece of redundancy on the surface, and the one that made two
 * faces collide inside one paragraph.
 *
 * Returns `''` when nothing but connective tissue survives (`Add a question on sales outcomes:` on
 * its own is not a sentence), so the caller can drop the paragraph rather than print a fragment.
 * A quote that reaches outside what is already shown survives untouched — that is evidence the
 * reader cannot see anywhere else.
 */
export function stripRestatedQuotes(text: string, shown: readonly string[]): string {
  const targets = shown.map(normalizeQuote).filter(Boolean);
  if (targets.length === 0) return text;

  const parts = quotedSpans(text);
  if (!parts.some((p) => p.quoted && targets.includes(normalizeQuote(p.text)))) return text;

  const kept = parts
    .filter((p) => !(p.quoted && targets.includes(normalizeQuote(p.text))))
    .map((p) => (p.quoted ? `“${p.text}”` : p.text))
    .join('')
    .replace(/\s+/g, ' ')
    // The lead-in punctuation that introduced the removed quote ("…outcomes:", "…such as,") is
    // now pointing at nothing. Close the sentence instead.
    .replace(/[\s,:;—–-]+$/, '')
    .trim();

  // Nothing left but a lead-in fragment: better to say nothing than to print half a sentence.
  if (kept.length < 12) return '';
  return /[.?!]$/.test(kept) ? kept : `${kept}.`;
}
