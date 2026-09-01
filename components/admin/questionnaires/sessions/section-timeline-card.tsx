/**
 * The section timeline, as an admin reads it back — Sectioned interviews (P21).
 *
 * A sectioned interview has a shape the transcript does not show. The transcript says what was
 * asked; it does not say that part three was opened at turn 19, reopened twice, and never closed.
 * That is the shape of a stalled run, and this panel is where it becomes visible to an operator.
 *
 * Three things it gives equal weight to the sections that closed cleanly:
 *
 * - **Where it stopped.** The section the run was in when it ended is marked, because a session
 *   that stalls stalls somewhere specific, and "which part were they on" is the first question.
 * - **Why a section closed.** A respondent's own decision, an accepted offer, and a turn cap
 *   running out are three different events, and only the third says the section closed WITHOUT its
 *   gate being satisfied. Collapsing them into a tick would hide the one that matters.
 * - **What it cost.** Spend per section is how a run that burned its budget in one place is told
 *   apart from one that spent evenly.
 *
 * A server component: pure rendering over data the page already loaded. Sibling to
 * {@link InterviewPlanCard}, and deliberately the same `<details>` shape — both answer a question
 * asked after the fact, and neither should crowd the transcript that is the page's subject.
 */

import { ListOrdered, RotateCcw } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import type {
  AdminSectionTimelineEntry,
  AdminSectionTimelineView,
} from '@/app/api/v1/app/questionnaire-sessions/_lib/admin-session-view';
import type { SectionCloseReason, SectionStatus } from '@/lib/app/questionnaire/sections/types';

/**
 * Plain-English status. Deliberately not the stored enum: `not_started` is implementation
 * vocabulary, and an admin reading a session back wants to know whether the respondent got there.
 */
const STATUS_LABELS: Record<SectionStatus, string> = {
  not_started: 'Not reached',
  in_progress: 'Open',
  closed: 'Finished',
};

/**
 * Why a section closed, said the way it happened.
 *
 * `cap` is worded to name what it means rather than what it is called: it is the ONE reason that
 * says the section closed while its gate was still unsatisfied, and an operator reading "turn limit"
 * knows to look at what was left unanswered there.
 */
const CLOSE_REASON_LABELS: Record<SectionCloseReason, string> = {
  respondent: 'Respondent moved on',
  agent_offer: 'Accepted the offer to move on',
  cap: 'Released by the turn limit',
  auto: 'Nothing left to ask',
};

/** Spend for one section, or null when no turn there recorded a cost. */
function formatCost(costUsd: number | null): string | null {
  if (costUsd === null) return null;
  return `$${costUsd.toFixed(costUsd > 0 && costUsd < 0.01 ? 4 : 2)}`;
}

function TimelineRow({
  entry,
  isWhereItStopped,
}: {
  entry: AdminSectionTimelineEntry;
  isWhereItStopped: boolean;
}) {
  const cost = formatCost(entry.costUsd);
  return (
    <li className="border-t px-3 py-2 first:border-t-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground text-xs tabular-nums">{entry.position}.</span>
        <span className="font-medium">{entry.label}</span>
        <Badge
          variant={entry.status === 'closed' ? 'secondary' : 'outline'}
          className="text-[10px]"
        >
          {STATUS_LABELS[entry.status]}
        </Badge>
        {/* Never on a part that was never reached. `buildSectionState` SYNTHESISES an active key
            when the stored run carries none (`run.activeKey ?? nextOpenSectionKey(...)`), so a
            session that banked a run without taking a turn resolves its first section as active —
            and badging it would put "Not reached" and "Where it stopped" on the same row. */}
        {isWhereItStopped && entry.status !== 'not_started' && (
          <Badge variant="outline" className="text-[10px]">
            Where it stopped
          </Badge>
        )}
        {/* A section the version no longer carries. Shown rather than dropped: turns were tagged
            with it, and hiding it would leave them belonging to nothing. */}
        {entry.stale && (
          <span className="text-muted-foreground text-xs">no longer in this questionnaire</span>
        )}
        {entry.reopenCount > 0 && (
          <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
            <RotateCcw className="h-3 w-3" aria-hidden />
            came back {entry.reopenCount === 1 ? 'once' : `${entry.reopenCount} times`}
          </span>
        )}
      </div>
      <div className="text-muted-foreground mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs">
        {/* Whether a section was opened is read off its STATUS, never off `openedAtTurn`.
            The runtime stamps that field with `selectionRound`, the count of turns BEFORE the one
            being written, so the section a respondent starts in is stamped 0 while its first
            exchange is turn 1 — and a card testing `openedAtTurn > 0` told the operator a finished
            section with six turns and recorded spend was "never opened". The status is the
            authoritative signal and needs no arithmetic. A zero stamp is then described in words
            rather than printed, because the one number it must not claim is "turn 0". */}
        <span>
          {entry.status === 'not_started'
            ? 'never opened'
            : entry.openedAtTurn > 0
              ? `opened at turn ${entry.openedAtTurn}`
              : 'opened at the first turn'}
        </span>
        {entry.closedAtTurn !== null && <span>finished at turn {entry.closedAtTurn}</span>}
        <span>
          {entry.turnsSpent} {entry.turnsSpent === 1 ? 'turn' : 'turns'}
        </span>
        {cost && <span>{cost}</span>}
        {entry.closeReason && <span>{CLOSE_REASON_LABELS[entry.closeReason]}</span>}
      </div>
    </li>
  );
}

export interface SectionTimelineCardProps {
  timeline: AdminSectionTimelineView;
}

export function SectionTimelineCard({ timeline }: SectionTimelineCardProps) {
  const finished = timeline.entries.filter((e) => e.status === 'closed').length;
  const total = timeline.entries.length;

  return (
    <details className="bg-muted/20 rounded-md border text-sm">
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2">
        <ListOrdered className="h-4 w-4 shrink-0 text-sky-600 dark:text-sky-400" aria-hidden />
        <span className="font-medium">Sections</span>
        <span className="text-muted-foreground text-xs">
          {finished} of {total} finished
        </span>
      </summary>
      <ul className="border-t">
        {timeline.entries.map((entry) => (
          <TimelineRow
            key={entry.key}
            entry={entry}
            isWhereItStopped={entry.key === timeline.activeKey}
          />
        ))}
      </ul>
    </details>
  );
}
