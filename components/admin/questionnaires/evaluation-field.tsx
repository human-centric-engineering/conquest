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
