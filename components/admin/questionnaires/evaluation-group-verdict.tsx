'use client';

/**
 * The panel's verdict on one question — the thing a reviewer reads before anything else.
 *
 * The run-detail page used to open with seven judges' worth of individual findings and leave the
 * reviewer to work out what the panel collectively wanted. This band inverts that: the **verb**
 * first (reword / move / delete / change the answer type), then the wording the judges can all live
 * with, and only then — on request — the individual judgements that produced it.
 *
 * Three things it must never do:
 *
 *  1. **Manufacture agreement.** When judges proposed different actions, the dissent is printed
 *     next to the headline, not hidden behind it. `summariseGroupActions` keeps every proposal.
 *  2. **Overstate the rewrite.** A reconciled alternative names the judges it satisfies, and the
 *     `unresolved` line names the ones no wording can — because a rewrite presented as the answer
 *     to a type-fit complaint is worse than no rewrite at all.
 *  3. **Swallow the reconciled text into a control.** The wording is the most copy-pasted string on
 *     the page, so it lives outside the disclosure button where it can be selected.
 */

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { EVALUATION_DIMENSION_SPECS } from '@/lib/app/questionnaire/evaluation';
import type { EvaluationDimension } from '@/lib/app/questionnaire/evaluation';
import type {
  GroupAction,
  GroupActionKind,
  GroupActionSummary,
} from '@/lib/app/questionnaire/evaluation/group-actions';
import type { ReconciledSuggestion } from '@/lib/app/questionnaire/evaluation/reconcile-schema';

/** Judge names read better without the noun — "Clarity, Audience-Match", not "Clarity Judge, …". */
function judgeName(dimension: EvaluationDimension): string {
  return EVALUATION_DIMENSION_SPECS[dimension].label.replace(/ Judge$/, '');
}

function judgeNames(dimensions: EvaluationDimension[]): string {
  return dimensions.map(judgeName).join(', ');
}

/**
 * Accent per verb. Colour carries a hint, never the message — every action also states itself in
 * words, so this survives greyscale, colour-blindness, and a reviewer skimming at speed.
 */
const ACTION_TONE: Record<GroupActionKind, string> = {
  delete: 'border-destructive/40 bg-destructive/5',
  retype: 'border-amber-500/40 bg-amber-500/5',
  move: 'border-amber-500/40 bg-amber-500/5',
  add: 'border-emerald-500/40 bg-emerald-500/5',
  reword: 'border-primary/30 bg-primary/5',
  guidance: 'border-primary/30 bg-primary/5',
  goal: 'border-primary/30 bg-primary/5',
  audience: 'border-primary/30 bg-primary/5',
  review: 'border-border bg-muted/40',
};

/**
 * How much of the panel is behind an action, in words.
 *
 * The denominator is the judges that flagged THIS question, not the seven on the panel. "2 of 7"
 * would be measuring the wrong thing: the other five had nothing to say about this question, so
 * counting them as absent votes reads as weaker support than the panel actually gave. Who flagged
 * it at all is answered by the judge chips once the card is open.
 */
function backing(action: GroupAction, flaggers: number): string {
  const n = action.judges.length;
  if (n === flaggers) return n === 1 ? '1 judge' : `all ${n} judges`;
  return `${n} of ${flaggers} judges`;
}

interface Props {
  summary: GroupActionSummary;
  /** The run's reconciled alternatives for this target; `undefined` when nothing was reconciled. */
  reconciled: ReconciledSuggestion | undefined;
  /** Show every alternative rather than just the leading one (the expanded card does). */
  expanded: boolean;
}

export function EvaluationGroupVerdict({ summary, reconciled, expanded }: Props) {
  const { primary, others, contested, judgeCount } = summary;
  if (!primary) return null;

  const alternatives = reconciled?.alternatives ?? [];
  // Collapsed, one wording is the recommendation; a second is a trade-off worth deciding, and that
  // decision belongs in the drill-down rather than in a card the reviewer is still scanning.
  const shown = expanded ? alternatives : alternatives.slice(0, 1);
  const hidden = alternatives.length - shown.length;

  return (
    <div className={cn('rounded-lg border-l-2 px-3 py-2.5', ACTION_TONE[primary.kind])}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-sm font-semibold tracking-tight">{primary.label}</span>
        <span className="text-muted-foreground text-xs tabular-nums">
          {backing(primary, judgeCount)}
        </span>

        {/* Dissent, printed beside the headline. A reviewer must never learn only after opening the
            card that one judge wanted the question gone. One string, not styled fragments: it has
            to read as a sentence at a glance. */}
        {contested &&
          others.map((other) => (
            <span key={other.kind} className="text-muted-foreground text-xs">
              {`· ${
                other.judges.length === 1 ? '1 judge says' : `${other.judges.length} judges say`
              } ${other.label.toLowerCase()} instead`}
            </span>
          ))}
      </div>

      {shown.length > 0 && (
        <div className="mt-2 space-y-2">
          {shown.map((alt, i) => (
            <div key={i}>
              {/* Selectable: this is the string a reviewer copies into the editor. */}
              <p className="text-foreground text-sm leading-snug font-medium text-pretty">
                “{alt.prompt}”
              </p>
              <p className="text-muted-foreground mt-0.5 text-xs">
                Satisfies {judgeNames(alt.addresses)}
                {alt.note && expanded ? ` — ${alt.note}` : ''}
              </p>
            </div>
          ))}

          {hidden > 0 && (
            <p className="text-muted-foreground text-xs italic">
              {hidden} alternative wording{hidden === 1 ? '' : 's'} below.
            </p>
          )}

          {reconciled && reconciled.unresolved.length > 0 && (
            <p className="text-muted-foreground text-xs">
              {`${judgeNames(reconciled.unresolved)} ${
                reconciled.unresolved.length === 1 ? 'is' : 'are'
              } not resolved by rewording — that needs a structural change.`}
            </p>
          )}
        </div>
      )}

      {/* No reconciled wording: either one judge flagged it (nothing to reconcile) or the
          reconcile step did not run. Say nothing rather than implying the panel fell silent. */}
      {shown.length === 0 && primary.kind !== 'review' && (
        <p className="text-muted-foreground mt-1 text-xs">
          Proposed by {judgeNames(primary.judges)}.
        </p>
      )}
    </div>
  );
}

/** The judges that flagged a target, as quiet chips — detail, shown once a card is open. */
export function JudgeChips({
  dimensions,
  gap,
}: {
  dimensions: EvaluationDimension[];
  gap: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-muted-foreground text-xs">{gap ? 'Raised by' : 'Flagged by'}</span>
      {dimensions.map((d) => (
        <Badge key={d} variant="secondary" className="text-[11px] font-normal">
          {judgeName(d)}
        </Badge>
      ))}
    </div>
  );
}
