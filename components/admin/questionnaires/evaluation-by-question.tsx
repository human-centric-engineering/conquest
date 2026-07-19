'use client';

/**
 * The question-centric half of the run-detail view.
 *
 * One card per **target** (a question, a section, the goal, the audience), carrying every judge's
 * findings about it. This is the view that can express cross-judge consensus — "three judges
 * flagged Q4" — which the by-judge grouping structurally cannot, because those three findings live
 * in three different sections there.
 *
 * The question prompt is the loudest element on each card: it is the subject under review, and the
 * judge that raised a point is metadata about it. That inverts the by-judge view's emphasis on
 * purpose.
 *
 * Only *flagged* targets appear — the run payload carries findings, not the version's full question
 * list, so a clean question is absent by construction rather than shown as a pass. The headline
 * band says "across N flagged items" for the same reason: it never implies full coverage.
 */

import { useState } from 'react';

import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { EVALUATION_DIMENSION_SPECS } from '@/lib/app/questionnaire/evaluation';
import { questionTypeLabel } from '@/lib/app/questionnaire/types';
import type { EvaluationFindingView } from '@/lib/app/questionnaire/views';
import { FindingReviewCard } from '@/components/admin/questionnaires/evaluation-finding-review';
import {
  groupContextLabel,
  type FindingGroup,
} from '@/components/admin/questionnaires/evaluation-grouping';
import { FieldLabel } from '@/components/admin/questionnaires/evaluation-field';

interface ApplyMeta {
  forked: boolean;
  versionId: string;
  versionNumber: number;
}

interface Props {
  groups: FindingGroup[];
  questionnaireId: string;
  versionId: string;
  runId: string;
  canApply: boolean;
  dataSlotsAvailable: boolean;
  onUpdate: (next: EvaluationFindingView, meta?: ApplyMeta) => void;
}

/** Severity tallies as small pills — colour is never the only signal, the count carries a word. */
function SeverityTally({ group }: { group: FindingGroup }) {
  const { major, minor, info } = group.counts;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1">
      {major > 0 && (
        <Badge variant="destructive" className="text-xs tabular-nums">
          {major} major
        </Badge>
      )}
      {minor > 0 && (
        <Badge variant="secondary" className="text-xs tabular-nums">
          {minor} minor
        </Badge>
      )}
      {info > 0 && (
        <Badge variant="outline" className="text-xs tabular-nums">
          {info} info
        </Badge>
      )}
    </div>
  );
}

function GroupCard({
  group,
  questionnaireId,
  versionId,
  runId,
  canApply,
  dataSlotsAvailable,
  onUpdate,
}: { group: FindingGroup } & Omit<Props, 'groups'>) {
  // Every group starts collapsed: the page opens as a scannable index of *which* questions have
  // problems and how bad they are (the card header carries context, prompt, judges and severity
  // tally), and the reviewer drills into the ones they choose to work on.
  const [open, setOpen] = useState(false);

  // Still dimmed when there is nothing left to decide, so finished work reads as finished.
  const allTerminal = group.findings.every(
    (f) => f.status === 'applied' || f.status === 'declined'
  );

  const context = groupContextLabel(group);
  // `key` is a raw targetKey — a `section:<title>` carries spaces and a colon. `aria-controls` is
  // a space-separated ID *list*, so an unsanitised key silently becomes several bogus references.
  const bodyId = `eval-group-${group.key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

  return (
    <section className={cn('bg-card rounded-xl border', allTerminal && 'opacity-70')}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={bodyId}
        className="hover:bg-accent/40 flex w-full flex-col gap-2 rounded-xl p-4 text-left transition-colors"
      >
        <div className="flex w-full flex-wrap items-center gap-2">
          {context && <FieldLabel>{context}</FieldLabel>}
          {/* How the question is answered — a suggestion reads differently against free text than
              against a Likert scale, and without this the reviewer has to open the editor to know. */}
          {group.questionType && (
            <Badge variant="outline" className="text-xs font-normal">
              {questionTypeLabel(group.questionType)}
            </Badge>
          )}
          {group.removed && (
            <Badge variant="outline" className="text-xs">
              Removed since run
            </Badge>
          )}
          <div className="ml-auto flex items-center gap-2">
            <SeverityTally group={group} />
            <span
              aria-hidden="true"
              className={cn(
                'text-muted-foreground text-xs transition-transform',
                open && 'rotate-90'
              )}
            >
              ▶
            </span>
          </div>
        </div>

        {/* The subject under review — the loudest thing on the card. */}
        <h3 className="text-base leading-snug font-semibold">
          {group.kind === 'question' ? `“${group.label}”` : group.label}
        </h3>

        {/* A gap group holds proposed *additions*, not judgements about something that exists. Said
            outright, because every other card on this page is about existing structure. */}
        {group.gap && (
          <p className="text-muted-foreground text-xs">
            Topics the goal calls for that no question covers. Nothing here changes an existing
            question.
          </p>
        )}

        {/* Cross-judge consensus: the signal this view exists to surface. */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-muted-foreground text-xs">
            {group.gap ? 'Raised by' : 'Flagged by'} {group.dimensions.length} of 7 judges:
          </span>
          {group.dimensions.map((d) => (
            <span
              key={d}
              className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[11px]"
            >
              {EVALUATION_DIMENSION_SPECS[d].label.replace(/ Judge$/, '')}
            </span>
          ))}
        </div>
      </button>

      {open && (
        <ul id={bodyId} className="space-y-3 px-4 pb-4">
          {group.findings.map((f) => (
            <FindingReviewCard
              key={f.id}
              finding={f}
              questionnaireId={questionnaireId}
              versionId={versionId}
              runId={runId}
              canApply={canApply}
              dataSlotsAvailable={dataSlotsAvailable}
              lead="dimension"
              onUpdate={onUpdate}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

export function EvaluationByQuestion({ groups, ...rest }: Props) {
  if (groups.length === 0) {
    return (
      <p className="text-muted-foreground rounded-xl border border-dashed py-10 text-center text-sm">
        No findings match these filters.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {groups.map((group) => (
        // Keyed on the target, not its sorted slot, so re-sorting reorders cards without
        // collapsing the ones the reviewer has open.
        <GroupCard key={group.key} group={group} {...rest} />
      ))}
    </div>
  );
}
