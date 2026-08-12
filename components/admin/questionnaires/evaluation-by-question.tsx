'use client';

/**
 * The question-centric half of the run-detail view.
 *
 * One card per **target** (a question, a section, the goal, the audience), carrying every judge's
 * findings about it. This is the view that can express cross-judge consensus — "three judges
 * flagged Q4" — which the by-judge grouping structurally cannot, because those three findings live
 * in three different sections there.
 *
 * ## Reading order: verdict, then evidence
 *
 * A collapsed card answers three questions in the order a reviewer actually asks them:
 *
 *   1. *Which question is this?* — the prompt, the loudest element on the card.
 *   2. *What does the panel want done?* — one verb (reword / move / delete / change the answer
 *      type), the judges behind it, any dissent, and the reconciled wording several judges can live
 *      with. That is {@link EvaluationGroupVerdict}.
 *   3. *Why?* — the individual judgements, revealed on demand.
 *
 * The page used to open at step 3 and leave the reviewer to infer step 2 by reading four
 * suggestions per question. The evidence still matters — it is what makes the verdict checkable —
 * but it is the drill-down, not the headline.
 *
 * ## One card open at a time
 *
 * These cards are tall when open (several finding cards, each with its own apply controls), so two
 * open at once means scrolling past work you have finished to reach work you have not. The
 * accordion keeps exactly one question in play, which is also how the reviewing actually goes: fix
 * one, move to the next.
 *
 * Only *flagged* targets appear — the run payload carries findings, not the version's full question
 * list, so a clean question is absent by construction rather than shown as a pass.
 */

import { useMemo } from 'react';

import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { questionTypeLabel } from '@/lib/app/questionnaire/types';
import type { EvaluationFindingView } from '@/lib/app/questionnaire/views';
import type { ReconciledSuggestion } from '@/lib/app/questionnaire/evaluation/reconcile-schema';
import { FindingReviewCard } from '@/components/admin/questionnaires/evaluation-finding-review';
import {
  groupContextLabel,
  type FindingGroup,
} from '@/lib/app/questionnaire/evaluation/group-findings';
import { summariseGroupActions } from '@/lib/app/questionnaire/evaluation/group-actions';
import { FieldLabel } from '@/components/admin/questionnaires/evaluation-field';
import {
  EvaluationGroupVerdict,
  JudgeChips,
} from '@/components/admin/questionnaires/evaluation-group-verdict';

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
  /** The run's cross-judge alternatives, keyed by target — empty for runs that predate the step. */
  reconciledByKey: Map<string, ReconciledSuggestion>;
  /** The single expanded card's key; `null` when all are closed. */
  openKey: string | null;
  onToggle: (key: string) => void;
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

type CardProps = { group: FindingGroup; open: boolean } & Omit<Props, 'groups' | 'openKey'>;

function GroupCard({
  group,
  open,
  questionnaireId,
  versionId,
  runId,
  canApply,
  dataSlotsAvailable,
  reconciledByKey,
  onToggle,
  onUpdate,
}: CardProps) {
  // Still dimmed when there is nothing left to decide, so finished work reads as finished.
  const allTerminal = group.findings.every(
    (f) => f.status === 'applied' || f.status === 'declined'
  );

  const context = groupContextLabel(group);
  const summary = useMemo(() => summariseGroupActions(group), [group]);
  const reconciled = reconciledByKey.get(group.key);

  // `key` is a raw targetKey — a `section:<title>` carries spaces and a colon. `aria-controls` is
  // a space-separated ID *list*, so an unsanitised key silently becomes several bogus references.
  const bodyId = `eval-group-${group.key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

  return (
    <section
      className={cn(
        'bg-card overflow-hidden rounded-xl border transition-shadow',
        open && 'ring-primary/15 shadow-sm ring-1',
        allTerminal && 'opacity-70'
      )}
    >
      {/* The disclosure covers the identity of the question, not the verdict beneath it: the
          reconciled wording has to stay selectable, and text inside a button is not. */}
      <button
        type="button"
        onClick={() => onToggle(group.key)}
        aria-expanded={open}
        aria-controls={bodyId}
        className="hover:bg-accent/40 flex w-full flex-col gap-2 p-4 pb-2 text-left transition-colors"
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
                'text-muted-foreground text-xs transition-transform duration-200',
                open && 'rotate-90'
              )}
            >
              ▶
            </span>
          </div>
        </div>

        {/* The subject under review — the loudest thing on the card. */}
        <h3 className="text-base leading-snug font-semibold text-pretty">
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
      </button>

      <div className="px-4 pb-4">
        <EvaluationGroupVerdict summary={summary} reconciled={reconciled} expanded={open} />

        {open && (
          <div
            id={bodyId}
            className="animate-in fade-in slide-in-from-top-1 mt-4 space-y-3 duration-200"
          >
            {/* Who said what — detail, so it waits until the card is open. */}
            <JudgeChips dimensions={group.dimensions} gap={group.gap} />
            <ul className="space-y-3">
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
          </div>
        )}
      </div>
    </section>
  );
}

export function EvaluationByQuestion({ groups, openKey, ...rest }: Props) {
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
        // collapsing the one the reviewer has open.
        <GroupCard key={group.key} group={group} open={openKey === group.key} {...rest} />
      ))}
    </div>
  );
}
