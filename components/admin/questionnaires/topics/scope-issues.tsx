'use client';

/**
 * The Conditional Topics coherence findings, as the Topics tab renders them.
 *
 * Advisory by design. `validateConditionalTopics` runs on READ — an admin mid-edit routinely has an
 * incoherent set, and a surface that refuses the save is a surface they fight. So this shows what
 * is wrong and where, and never blocks a keystroke.
 *
 * The severity split carries real weight and the rendering must not flatten it: an `error` means
 * turning the feature on would make the questionnaire behave wrongly (a question belonging to no
 * topic can never be asked, and nothing else in the system would ever tell you), while a `warning`
 * means it will run, just not as the author probably intends. Errors block launch; warnings do not.
 */

import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { ScopeIssue } from '@/lib/app/questionnaire/scope/validate';

export interface ScopeIssuesProps {
  issues: readonly ScopeIssue[];
  /**
   * Whether the feature is on. Only changes the "all clear" copy: with scope off, "nothing would
   * behave wrongly" is a statement about a hypothetical, and saying so plainly is more useful than
   * a green tick that implies the feature is running.
   */
  enabled: boolean;
  className?: string;
}

export function ScopeIssues({ issues, enabled, className }: ScopeIssuesProps) {
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');

  if (issues.length === 0) {
    return (
      <div
        className={cn(
          'flex items-start gap-2 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200',
          className
        )}
      >
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <p>
          {enabled
            ? 'This topic set is coherent — every question belongs to a topic and every reference resolves.'
            : 'Nothing to fix. This topic set would still be coherent if you turned conditional topics on.'}
        </p>
      </div>
    );
  }

  return (
    <div className={cn('space-y-2', className)}>
      {errors.length > 0 && (
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/10 text-destructive space-y-1.5 rounded-md border p-3 text-sm"
        >
          <p className="flex items-center gap-1.5 font-medium">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
            {errors.length} {errors.length === 1 ? 'problem blocks' : 'problems block'} launch
          </p>
          <ul className="ml-6 list-disc space-y-1">
            {errors.map((issue, i) => (
              <li key={`${issue.code}-${issue.topicKey ?? i}`}>{issue.message}</li>
            ))}
          </ul>
        </div>
      )}
      {warnings.length > 0 && (
        <div className="space-y-1.5 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          <p className="flex items-center gap-1.5 font-medium">
            <Info className="h-4 w-4 shrink-0" aria-hidden="true" />
            {warnings.length} {warnings.length === 1 ? 'thing' : 'things'} worth a look
          </p>
          <ul className="ml-6 list-disc space-y-1">
            {warnings.map((issue, i) => (
              <li key={`${issue.code}-${issue.topicKey ?? i}`}>{issue.message}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
