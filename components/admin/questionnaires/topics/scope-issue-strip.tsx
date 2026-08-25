'use client';

/**
 * The coherence findings as a summary strip, directly under the status header.
 *
 * The same two-level shape `config-conflicts.tsx` uses: a strip at the top of the surface that says
 * how much is wrong and lets you jump to it, plus the existing {@link ScopeIssues} lower down as the
 * full read. Two renderings, ONE source — both are handed `validateAdaptiveScope`'s output, so they
 * cannot report different counts.
 *
 * ## Why the rows are buttons, not links
 *
 * `ConfigConflict` carries a `sectionId` and its banner links to `#anchor`. `ScopeIssue` carries
 * only `code` and an optional `topicKey` (`scope/validate.ts`), so there is no anchor to point at —
 * the thing that fixes a finding is a row in a topic editor whose DOM id is a client-side detail.
 * So a row calls back instead, and the panel decides what "go there" means. Today that reuses the
 * topic-list focus handoff; once this tab is split into sub-tabs it also picks the tab that owns
 * the finding.
 *
 * A finding with no `topicKey` is about the setup as a whole ("no topic is marked as the opening"),
 * so it renders as plain text: there is no single row to send anyone to, and a button that moved
 * the page somewhere unrelated would be worse than no button.
 */

import { AlertTriangle, Info } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { ScopeIssue } from '@/lib/app/questionnaire/scope/validate';

/** How many rows the strip lists before it stops and says how many are left. */
const MAX_ROWS = 4;

export interface ScopeIssueStripProps {
  issues: readonly ScopeIssue[];
  /**
   * Take the admin to the thing that fixes this finding. Omitted renders the rows as plain text —
   * a strip with no destination is still a useful summary.
   */
  onSelectIssue?: (issue: ScopeIssue) => void;
  className?: string;
}

export function ScopeIssueStrip({ issues, onSelectIssue, className }: ScopeIssueStripProps) {
  if (issues.length === 0) return null;

  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const hasErrors = errors.length > 0;
  // Errors first: they are what blocks launch, so they are what a skim needs to find.
  const rows = [...errors, ...warnings];
  const shown = rows.slice(0, MAX_ROWS);
  const hidden = rows.length - shown.length;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'rounded-lg border p-3',
        hasErrors
          ? 'border-destructive/40 bg-destructive/10'
          : 'border-amber-300 bg-amber-50 dark:border-amber-500/30 dark:bg-amber-500/10',
        className
      )}
    >
      <div className="flex items-start gap-2.5">
        {hasErrors ? (
          <AlertTriangle className="text-destructive mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        ) : (
          <Info
            className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-400"
            aria-hidden="true"
          />
        )}

        <div className="min-w-0 flex-1">
          <p
            className={cn(
              'text-sm font-semibold',
              hasErrors ? 'text-destructive' : 'text-amber-900 dark:text-amber-200'
            )}
          >
            {/* "Block launch" rather than "errors": the consequence is the thing an admin can act
                on, and it is literally true — `assertLaunchable` refuses on a non-zero error
                count. Warnings are named by what they are worth, not by their severity word. */}
            {hasErrors && (
              <>
                {errors.length} {errors.length === 1 ? 'problem blocks' : 'problems block'} launch
              </>
            )}
            {hasErrors && warnings.length > 0 && <span className="opacity-70"> · </span>}
            {warnings.length > 0 && (
              <span className={hasErrors ? 'font-medium opacity-80' : undefined}>
                {warnings.length} worth a look
              </span>
            )}
          </p>

          <ul className="mt-1.5 space-y-1">
            {shown.map((issue, i) => {
              const tone =
                issue.severity === 'error'
                  ? 'text-destructive'
                  : 'text-amber-800 dark:text-amber-300';
              const jumpable = onSelectIssue !== undefined && issue.topicKey !== undefined;
              return (
                <li key={`${issue.code}-${i}`} className={cn('text-xs', tone)}>
                  {jumpable ? (
                    <button
                      type="button"
                      onClick={() => onSelectIssue?.(issue)}
                      className="text-left underline decoration-dotted underline-offset-2 hover:decoration-solid focus-visible:ring-2 focus-visible:outline-none"
                    >
                      {issue.message}
                    </button>
                  ) : (
                    <span>{issue.message}</span>
                  )}
                </li>
              );
            })}
          </ul>

          {hidden > 0 && (
            <p
              className={cn(
                'mt-1 text-xs opacity-80',
                hasErrors ? 'text-destructive' : 'text-amber-800 dark:text-amber-300'
              )}
            >
              …and {hidden} more.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
