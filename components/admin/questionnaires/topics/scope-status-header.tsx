'use client';

/**
 * The Adaptive Scope status header — "is this on, and is it ready?", answered before anything else.
 *
 * The tab it sits above is ordered by the runtime pipeline: the AI proposer leads, the verification
 * cards sit in the middle, and the topic list an admin edits most is last, below several screens of
 * other surface. The master switch — on which the feature's whole "off by default, inert by
 * construction" invariant rests — used to live in the header of the tenth card, which is the last
 * place someone asking "is this even on?" would look.
 *
 * So this is deliberately the smallest thing that answers the question, and it is **presentational
 * only**: no payload, no fetching, no derived state beyond formatting. It cannot grow a second
 * source of truth about whether the feature is on, because it has no way to find out except being
 * told.
 *
 * ## The switch is controlled by the SERVER's value, never a local draft
 *
 * `enabled` is `payload.settings.enabled`, and the toggle calls back rather than setting state.
 * That is what makes a declined fork correct: `authoringMutate` throws `ForkCancelledError`, the
 * panel writes nothing, and the next render puts the switch back where it was. A locally-drafted
 * switch would sit in the position the admin clicked, describing a version that was never written.
 *
 * It is also why the settings card below no longer owns this field at all — two writers of one
 * value drift, and the one that loses is whichever rendered last.
 */

import { Route } from 'lucide-react';

import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { formatSeconds } from '@/lib/app/questionnaire/scope/budget';
import { cn } from '@/lib/utils';

export interface ScopeStatusHeaderProps {
  enabled: boolean;
  /** Every topic on the version. */
  topicCount: number;
  /** How many are `conditional` — the only phase the planner ever chooses between. */
  conditionalCount: number;
  /** Questions belonging to no topic. With scope on, these can never be asked. */
  uncoveredQuestions: number;
  /** What the always-run phases cost a respondent, in seconds. */
  alwaysSeconds: number;
  /** The session budget. **0 means no budget**, not a zero-second one — see below. */
  budgetSeconds: number;
  busy: boolean;
  onToggleEnabled: (next: boolean) => void;
  className?: string;
}

export function ScopeStatusHeader({
  enabled,
  topicCount,
  conditionalCount,
  uncoveredQuestions,
  alwaysSeconds,
  budgetSeconds,
  busy,
  onToggleEnabled,
  className,
}: ScopeStatusHeaderProps) {
  return (
    <section
      className={cn('bg-card rounded-lg border p-4 shadow-sm', className)}
      aria-labelledby="scope-status-heading"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span
            className={cn(
              'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
              enabled
                ? 'bg-teal-500/10 text-teal-600 dark:text-teal-400'
                : 'bg-muted text-muted-foreground'
            )}
          >
            <Route className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0 space-y-1">
            <h2 id="scope-status-heading" className="text-sm font-semibold tracking-tight">
              Adaptive scope
            </h2>
            {/* The off-state sentence carries the invariant in the plainest words available. An
                admin who reads "Off" and nothing else has to infer what off MEANS, and the
                inference people reach for — "the feature is broken" or "nothing is set up" — is
                wrong in a way that makes them start changing things. */}
            <p className="text-muted-foreground text-xs leading-relaxed">
              {enabled
                ? 'On — each respondent is asked the opening, the always-asked topics, and whichever conditional topics fit what they said.'
                : 'Off — every respondent is asked the whole questionnaire.'}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Label htmlFor="scope-status-enabled" className="text-xs font-medium">
            {enabled ? 'On' : 'Off'}
          </Label>
          <Switch
            id="scope-status-enabled"
            checked={enabled}
            onCheckedChange={onToggleEnabled}
            disabled={busy}
            aria-label="Adaptive scope"
          />
        </div>
      </div>

      <dl className="text-muted-foreground mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-3 text-xs">
        <Stat label="topics" value={topicCount} />
        <Divider />
        <Stat label="conditional" value={conditionalCount} />
        {uncoveredQuestions > 0 && (
          <>
            <Divider />
            {/* Surfaced here rather than only in the issue list because it is the one number that
                changes what turning the switch on DOES. The issue list says the same thing with
                more words; this is the version a skim catches. */}
            <span className="text-amber-700 dark:text-amber-400">
              <span className="font-semibold tabular-nums">{uncoveredQuestions}</span>{' '}
              {uncoveredQuestions === 1 ? 'question' : 'questions'} in no topic
            </span>
          </>
        )}
        <Divider />
        <span>
          Always asked ≈{' '}
          <span className="text-foreground font-semibold">{formatSeconds(alwaysSeconds)}</span>
        </span>
        <Divider />
        {/* 0 is "no budget", NOT a zero-second budget — `narrowAdaptiveScopeSettings` uses 0 as the
            off value because a duration of zero is not a usable one. Rendering it through
            `formatSeconds` would print "0m", which reads as a budget so tight nothing can run. */}
        <span>
          {budgetSeconds > 0 ? (
            <>
              Time limit{' '}
              <span className="text-foreground font-semibold">{formatSeconds(budgetSeconds)}</span>
            </>
          ) : (
            'no time limit set'
          )}
        </span>
      </dl>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <span>
      <span className="text-foreground font-semibold tabular-nums">{value}</span> {label}
    </span>
  );
}

function Divider() {
  return <span aria-hidden="true">·</span>;
}
