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
import { FieldLabel, QUESTION_FACE } from '@/components/admin/questionnaires/evaluation-field';
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
    // Not a card. The group used to be a bordered box holding a tinted header box holding a tinted
    // verdict box holding bordered finding boxes — four nested frames, which reads as clutter and
    // flattens the hierarchy it was meant to express. Only one thing is filled now (the header
    // band); everything else is positioned by indent and by the space between groups.
    <section className={cn(allTerminal && 'opacity-60')}>
      {/* The disclosure covers the identity of the question, not the verdict beneath it: the
          reconciled wording has to stay selectable, and text inside a button is not.

          The only filled surface in the group, which is what makes it read as a *header* while the
          reviewer scrolls a long open card looking for "which question is this again?". */}
      <button
        type="button"
        onClick={() => onToggle(group.key)}
        aria-expanded={open}
        aria-controls={bodyId}
        className={cn(
          'bg-muted hover:bg-accent flex w-full flex-col gap-2 rounded-md px-4 py-3 text-left transition-colors',
          open && 'ring-border ring-1'
        )}
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

        {/* The subject under review — the only thing in the questionnaire's own face. Set at
            regular weight: it is already a serif on a filled band at 18px, and stacking bold on top
            of three other signals made a page of long questions harder to read, not easier. Capped
            at a heading measure, because a one-line question stretched across a 2560px display is
            not a heading, it is a rule with words on it. */}
        <h3 className={cn(QUESTION_FACE, 'max-w-[54ch] text-lg leading-snug text-pretty')}>
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

      {/* Indented under the header, on the page's own ground rather than in a box. Everything in
          here is *about* the question above it — the panel's verdict, then the judgements behind
          it — and with the frames gone the step in from the left edge is what says so. */}
      <div className="pt-3 pr-1 pl-6 sm:pl-12">
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
    // Generous, not tidy. With the group boxes gone, the gap between one question and the next is
    // the only thing separating them — at `space-y-3` two headers a few lines apart read as one
    // continuous list of paragraphs.
    <div className="space-y-8">
      {groups.map((group) => (
        // Keyed on the target, not its sorted slot, so re-sorting reorders cards without
        // collapsing the one the reviewer has open.
        <GroupCard key={group.key} group={group} open={openKey === group.key} {...rest} />
      ))}
    </div>
  );
}
