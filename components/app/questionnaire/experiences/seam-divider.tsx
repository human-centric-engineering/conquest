/**
 * The labelled rule marking where one questionnaire hands over to the next (P15.3).
 *
 * Rendered only under `stitched` continuity with the `divider` seam marker. Its job is to be
 * noticed once and then ignored: a respondent who scrolls back should be able to tell which
 * questions belonged to which part, without the seam interrupting the read on the way down.
 *
 * Not a heading element. The stitched surface is one conversation, and introducing a heading
 * mid-transcript would put a section break into the accessibility tree that does not match how the
 * page actually behaves. `<span>` inside a presentational rule, with the rule itself hidden from
 * screen readers and the label left to read as ordinary text.
 */

import { cn } from '@/lib/utils';

export interface SeamDividerProps {
  /** The step title. Falls back to generic copy when the step pointer no longer resolves (UG-1). */
  label: string | null;
  className?: string;
}

export function SeamDivider({ label, className }: SeamDividerProps) {
  return (
    <div className={cn('flex items-center gap-3 py-2', className)}>
      <span className="bg-border h-px flex-1" aria-hidden="true" />
      <span className="text-muted-foreground text-xs font-medium tracking-wide">
        {label ?? 'Next part'}
      </span>
      <span className="bg-border h-px flex-1" aria-hidden="true" />
    </div>
  );
}
