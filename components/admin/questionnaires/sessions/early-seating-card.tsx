/**
 * What the interview committed to during its opening, as an admin reads it back (F17.36).
 *
 * A sibling of {@link InterviewPlanCard} and deliberately the same `<details>` shape, but it answers
 * a question the plan panel cannot answer in either of the two situations that matter:
 *
 * - **The opening never finished.** There is no plan, so the plan panel is absent entirely and the
 *   viewer would read as "no decision was made". If an area was chosen early, one was, and the
 *   respondent spent turns on it.
 * - **The plan exists and flattens the timing.** A sealed plan absorbs every early seat under one
 *   `decidedAtTurn`, so "this area was chosen at turn 3 and the rest at turn 9" survives only here.
 *
 * The two lines nobody would think to store are the ones that make it worth a panel: what the
 * respondent was TOLD about each area, and what the caps judged warranted and could not take. A cap
 * that quietly discards decisions reads afterwards as "it only found one area" when it found four.
 *
 * A server component: pure rendering over data the page already loaded.
 */

import { Milestone } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import type { AdminEarlySeatingView } from '@/app/api/v1/app/questionnaire-sessions/_lib/admin-session-view';

export interface EarlySeatingCardProps {
  early: AdminEarlySeatingView;
  /** True when the interview went on to seal a plan, which changes what this panel is evidence of. */
  planned: boolean;
}

export function EarlySeatingCard({ early, planned }: EarlySeatingCardProps) {
  return (
    <details className="bg-muted/20 rounded-md border text-sm">
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2">
        <Milestone className="h-4 w-4 shrink-0 text-sky-600 dark:text-sky-400" aria-hidden />
        <span className="font-medium">Chosen during the opening</span>
        <span className="text-muted-foreground text-xs">
          {early.seated.length} {early.seated.length === 1 ? 'area' : 'areas'}
          {early.seated.length > 0 &&
            ` · first at turn ${Math.min(...early.seated.map((s) => s.atTurn))}`}
        </span>
        {/* Stated on the summary, not buried in the body: it changes how the counts beside it read. */}
        {early.overCap && (
          <Badge variant="outline" className="text-[10px]">
            More was judged than the limits allowed
          </Badge>
        )}
      </summary>

      <div className="space-y-3 border-t px-3 py-3">
        <p className="text-muted-foreground text-xs">
          {planned
            ? 'These areas came into scope before the full decision was made, on part of the opening. The plan below absorbed them, so it lists them too, with the turn the plan was sealed rather than the turn each was chosen.'
            : 'These areas came into scope before the full decision was made. This interview never reached one, so this is the whole of what it decided.'}
        </p>

        {early.seated.length === 0 ? (
          <p className="text-muted-foreground text-xs italic">
            Nothing was clear enough to act on early.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {early.seated.map((seat) => (
              <li key={seat.key} className="text-xs">
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium">{seat.label}</span>
                  <Badge variant="outline" className="text-[10px]">
                    turn {seat.atTurn}
                  </Badge>
                  <Badge variant="outline" className="text-[10px]">
                    {Math.round(seat.confidence * 100)}% sure
                  </Badge>
                </span>
                {seat.rationale && (
                  <span className="text-muted-foreground block">{seat.rationale}</span>
                )}
                {/* What the respondent was actually told, kept beside the reason the admin was
                    given. They are two different sentences about the same decision, and a
                    challenge is usually about the gap between them. */}
                {seat.respondentReason && (
                  <span className="text-muted-foreground block italic">
                    Told the respondent: “{seat.respondentReason}”
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}

        {early.deferred.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-medium">Judged worth covering, never taken</p>
            <p className="text-muted-foreground text-xs">
              {early.deferred.map((t) => t.label).join(', ')}. The limits on this questionnaire were
              already spent, and the interview reached its full decision before these could be
              picked up.
            </p>
          </div>
        )}
      </div>
    </details>
  );
}
