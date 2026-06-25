/**
 * QuestionConfigWarning (F2.1 / PR2) — the amber "this question isn't ready" cue
 * shown on a misconfigured question in both the editable and read-only structure
 * views. Takes the already-resolved {@link QuestionConfigIssue} (the caller also
 * needs it for the row's amber ring, so it's computed once and passed down) and
 * renders nothing when there's no issue.
 *
 * The verdict comes from {@link questionConfigIssue} (shared with the save/launch
 * path) — the cue can't disagree with what actually blocks a launch. A short
 * label sits in the chip; the full sentence rides a tooltip so the row stays
 * compact.
 */

import { AlertTriangle } from 'lucide-react';

import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { QuestionConfigIssue } from '@/lib/app/questionnaire/authoring';

/**
 * Amber border + ring applied to a misconfigured question's row. Shared by both
 * structure views so the two surfaces can't drift on the treatment.
 */
export const QUESTION_ISSUE_RING =
  'border-amber-400 ring-1 ring-amber-300/60 dark:border-amber-500/50 dark:ring-amber-500/30';

export function QuestionConfigWarning({
  issue,
  className,
}: {
  issue: QuestionConfigIssue | null;
  className?: string;
}) {
  if (!issue) return null;

  return (
    <Tip label={issue.detail}>
      <span
        role="status"
        className={cn(
          'inline-flex cursor-help items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300',
          className
        )}
      >
        <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
        {issue.label}
      </span>
    </Tip>
  );
}
