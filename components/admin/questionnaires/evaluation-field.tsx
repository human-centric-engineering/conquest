/**
 * The shared label treatment for evaluation surfaces.
 *
 * A finding card stacks three or four blocks of prose — the question under review, the judge's
 * suggestion, its rationale, and sometimes a quote — and they are near-indistinguishable when the
 * only thing separating them is font weight. A reader landing mid-card cannot tell whether a
 * sentence is *the questionnaire* or *the AI's opinion of it*, which is the one distinction the
 * page exists to communicate.
 *
 * So every block of prose is introduced by the same small uppercase eyebrow. One component rather
 * than repeated class strings, because the value is in the labels being visibly *the same kind of
 * thing* everywhere they appear — the moment two surfaces drift in size or weight, the eyebrow stops
 * reading as structure and starts reading as decoration.
 */

import { cn } from '@/lib/utils';

/** The eyebrow itself — also used standalone for the group context chip in the by-question view. */
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
        'text-muted-foreground text-[11px] font-medium tracking-wide uppercase',
        className
      )}
    >
      {children}
    </span>
  );
}

/**
 * A labelled block of prose. `label` names what the reader is looking at ("Suggestion",
 * "Rationale"); `children` is the content, styled by the caller — the label is the constant, the
 * body varies (a quote renders differently from a sentence).
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
      <div className="mt-0.5">{children}</div>
    </div>
  );
}

/**
 * The face reserved for **the questionnaire's own words** — a question prompt, a reconciled
 * rewrite, a prompt quoted inside a judge's sentence.
 *
 * The page interleaves two voices that are otherwise typographically identical: the questionnaire
 * ("How confident are you about your finances?") and the panel's commentary about it ("Reword to
 * remove the double-barrelled ask"). Weight and colour were carrying that distinction alone, and
 * they lose it the moment a reader lands mid-card or skims a wall of similar-looking paragraphs.
 *
 * A change of *family* does not lose it. This is the ConQuest display serif already loaded on the
 * admin surface for the wordmark, so it is a face the reviewer has seen here rather than a new
 * aesthetic imported for one page. Never the only signal — block-level question text keeps its
 * curly quotes, and inline quotes keep their marks — because a font swap is invisible to a screen
 * reader and to anyone whose browser failed to load it.
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

/**
 * Matches a double-quoted span — straight or curly. Two characters minimum, so a bare `""` is not
 * a quote.
 *
 * Built per call rather than shared: a `g`-flagged regex carries a `lastIndex` cursor, so a
 * module-level one would make the second read of the same string skip its first quote — and
 * mutating it during render is exactly the shared state React's compiler forbids.
 */
function quotedSpans(text: string): { text: string; quoted: boolean }[] {
  const re = /[“"]([^”"]{2,}?)[”"]/g;
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
 * changes face and slants, so it can be found without reading the sentence that contains it. On
 * the run this was built against, 27 of 40 suggestions were that second shape.
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
          <q key={i} className={cn(QUESTION_FACE, 'text-foreground italic')}>
            {part.text}
          </q>
        ) : (
          part.text
        )
      )}
    </>
  );
}
