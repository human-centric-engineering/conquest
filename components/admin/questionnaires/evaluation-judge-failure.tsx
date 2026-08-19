'use client';

/**
 * Shared treatment for a judge that did not run.
 *
 * A failed judge used to read as an unobtrusive outline "failed" chip — the same weight as a
 * clean judge's score — even though it is the one state on the page that invalidates the numbers
 * next to it. Both views (the headline strip and the by-judge sections) now render it through
 * these two pieces, so the failure looks the same everywhere and always carries its way out:
 *
 *  - {@link judgeFailureReason} turns the stored diagnostic *code* into something an admin can act
 *    on. The code is kept alongside it (as a `title`) — it's what support asks for.
 *  - {@link RetryJudgeButton} re-dispatches that one judge. Presentational only: the fetch and the
 *    run state live in `EvaluationRunDetail`, which is the component that owns the run.
 *
 * Dimension-agnostic (`dimension: string`) so the scope-evaluation panel (F17.21) — a second judge
 * panel with its own dimension vocabulary — shares this treatment rather than duplicating it; the
 * diagnostic codes both panels' `run-panel.ts` produce are the same small set.
 */

import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

/**
 * Diagnostic code → what actually went wrong, in the admin's terms. The codes come from
 * `runEvaluationPanel` (`judge_not_configured`, `dispatch_error`) and from the capability
 * dispatcher's error envelope, which is open-ended — so unknown codes get an honest generic
 * line rather than a lie.
 */
export function judgeFailureReason(diagnostic: string): string {
  switch (diagnostic) {
    case 'judge_not_configured':
      return 'This judge has no agent configured — run the questionnaire seeds, then retry.';
    case 'dispatch_error':
      return 'The judge call errored before it returned. Retrying usually clears it.';
    case 'evaluation_failed':
      return 'The judge ran but returned no usable verdict.';
    default:
      return 'The judge did not return a verdict.';
  }
}

interface RetryProps {
  dimension: string;
  /** True while *this* judge is being re-dispatched. */
  busy: boolean;
  /** True while any judge is being re-dispatched — retries are serialised. */
  disabled?: boolean;
  onRetry: (dimension: string) => void;
  className?: string;
}

/** "Retry judge" — re-dispatches this one judge into the same run. */
export function RetryJudgeButton({
  dimension,
  busy,
  disabled = false,
  onRetry,
  className,
}: RetryProps) {
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={busy || disabled}
      onClick={() => onRetry(dimension)}
      className={cn('h-7 gap-1.5 px-2 text-xs', className)}
    >
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
      ) : (
        <RefreshCw className="h-3.5 w-3.5" aria-hidden />
      )}
      {busy ? 'Retrying…' : 'Retry judge'}
    </Button>
  );
}

/** The warning icon used wherever a failed judge is named — one import, one size. */
export function JudgeFailureIcon({ className }: { className?: string }) {
  return (
    <AlertTriangle className={cn('text-destructive h-3.5 w-3.5 shrink-0', className)} aria-hidden />
  );
}
