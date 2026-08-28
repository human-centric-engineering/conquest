'use client';

/**
 * The question-centric half of the run-detail view.
 *
 * One card per **target** (a question, a section, the goal, the audience), carrying every judge's
 * findings about it. This is the view that can express cross-judge consensus — "three judges
 * flagged Q4" — which the by-judge grouping structurally cannot, because those three findings live
 * in three different sections there.
 *
 * ## Three layers, and the reviewer chooses when to descend
 *
 *   1. **Closed** — the question, its answer type, its severity tally, and (when the panel split)
 *      that the judges disagree. Nothing else. This layer is an index of work to do, and a verdict
 *      printed on every row of it is a paragraph the reviewer has to read past to reach the next
 *      question.
 *   2. **Open** — the panel's combined verdict, inside the same filled header area as the question,
 *      flush with it rather than indented. The verdict is a property of the question above it, not
 *      a detail underneath it; sharing the judges' indent made it read as the first of them rather
 *      than the summary of all of them.
 *   3. **A judge's tab** — one judge's reasoning and its apply controls, indented beneath. Stacked
 *      in one column, a question flagged by four judges was four near-identical cards each with its
 *      own decision controls; tabs make "whose reasoning am I reading" a choice rather than a
 *      scroll position.
 *
 * The one thing layer 1 must never hide is a disagreement — a reviewer skimming the queue should
 * not discover only after opening a card that a judge wanted the question deleted. So `contested`
 * surfaces on the closed header even though the verdict itself does not.
 *
 * ## One card open at a time
 *
 * These cards are tall when open (a verdict, a tab strip, a finding with its own apply controls),
 * so two open at once means scrolling past work you have finished to reach work you have not. The
 * accordion keeps exactly one question in play, which is also how the reviewing actually goes: fix
 * one, move to the next.
 *
 * Only *flagged* targets appear — the run payload carries findings, not the version's full question
 * list, so a clean question is absent by construction rather than shown as a pass.
 */

import { useState } from 'react';

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
import {
  summariseGroupActions,
  type GroupActionSummary,
} from '@/lib/app/questionnaire/evaluation/group-actions';
import {
  FieldLabel,
  MetaRow,
  QUESTION_FACE,
  QUESTION_MEASURE,
} from '@/components/admin/questionnaires/evaluation-field';
import {
  EvaluationGroupVerdict,
  JudgeTabs,
} from '@/components/admin/questionnaires/evaluation-group-verdict';
import type { EvaluationDimension } from '@/lib/app/questionnaire/evaluation';

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
  /**
   * The panel's verdict per target, derived upstream from *every* finding on it.
   *
   * Passed in rather than computed from `group` because `group` holds only the findings that
   * survived the filter, and a verdict computed from those would report a consensus the panel never
   * reached — see the note at its construction in `evaluation-run-detail`.
   */
  verdictByKey: Map<string, GroupActionSummary>;
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
  verdictByKey,
  onToggle,
  onUpdate,
}: CardProps) {
  // Which judge's reasoning is on screen. Derived-with-fallback rather than synced in an effect:
  // re-sorting or re-filtering can drop the selected judge out of the group entirely, and a stale
  // selection must degrade to "the first judge", never to an empty panel.
  const [picked, setPicked] = useState<EvaluationDimension | null>(null);
  const activeJudge = picked && group.dimensions.includes(picked) ? picked : group.dimensions[0];

  // Still dimmed when there is nothing left to decide, so finished work reads as finished.
  const allTerminal = group.findings.every(
    (f) => f.status === 'applied' || f.status === 'declined'
  );

  const context = groupContextLabel(group);
  // Falls back to the filtered group only if the map has no entry for this key, which cannot happen
  // while both derive from the same finding list — the `??` is a type-level floor, not a real case.
  const summary = verdictByKey.get(group.key) ?? summariseGroupActions(group);
  const reconciled = reconciledByKey.get(group.key);

  const findingsByJudge = group.findings.filter((f) => f.dimension === activeJudge);
  const counts: Record<string, number> = {};
  for (const f of group.findings) counts[f.dimension] = (counts[f.dimension] ?? 0) + 1;

  // `key` is a raw targetKey — a `section:<title>` carries spaces and a colon. `aria-controls` is
  // a space-separated ID *list*, so an unsanitised key silently becomes several bogus references.
  const idBase = `eval-group-${group.key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const bodyId = `${idBase}-body`;

  return (
    // Not a card. The group used to be a bordered box holding a tinted header box holding a tinted
    // verdict box holding bordered finding boxes — four nested frames, which reads as clutter and
    // flattens the hierarchy it was meant to express. One filled surface (the header area) carries
    // the question and the panel's verdict; the judges hang off it by indent.
    <section className={cn(allTerminal && 'opacity-60')}>
      {/* The header AREA — the question, and, once open, what the panel concluded about it. Full
          width, not indented: the verdict is a property of the question above it, not a detail
          underneath it, and it used to sit in the same indented column as the individual judges
          where it read as the first of them rather than as the summary of all of them. */}
      <div className={cn('bg-muted overflow-hidden rounded-md', open && 'ring-border ring-1')}>
        {/* The disclosure covers the identity of the question only. The verdict beneath it has to
            stay selectable — the reconciled wording is the most copy-pasted string on the page —
            and text inside a button is not. */}
        <button
          type="button"
          onClick={() => onToggle(group.key)}
          aria-expanded={open}
          aria-controls={bodyId}
          className="hover:bg-accent flex w-full cursor-pointer flex-col gap-2 px-4 py-3 text-left transition-colors"
        >
          <div className="flex w-full flex-wrap items-center gap-2">
            {/* One line of context, not a row of outline pills. The answer type and the removed
                notice are facts about the question — the same voice as the eyebrow beside them. */}
            <MetaRow>
              {context ? <FieldLabel>{context}</FieldLabel> : null}
              {/* How the question is answered — a suggestion reads differently against free text
                  than against a Likert scale, and without this the reviewer has to open the
                  editor. */}
              {group.questionType ? questionTypeLabel(group.questionType) : null}
              {group.removed ? 'removed since this run' : null}
            </MetaRow>
            <div className="ml-auto flex items-center gap-2">
              {/* Closed, the card shows the question and nothing else — which is the point, but it
                  must not be able to hide a disagreement. A reviewer skimming a queue should never
                  discover only after opening a card that one judge wanted the question deleted, so
                  the fact that the panel split is on the closed header even though the verdict
                  itself is not. */}
              {summary.contested && (
                <Badge variant="outline" className="text-xs font-normal">
                  Judges disagree
                </Badge>
              )}
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
              regular weight: it is already a serif on a filled band at 18px, and stacking bold on
              top of three other signals made a page of long questions harder to read, not easier.
              Capped at a heading measure, because a one-line question stretched across a 2560px
              display is not a heading, it is a rule with words on it. */}
          <h3 className={cn(QUESTION_FACE, QUESTION_MEASURE, 'text-lg leading-snug text-pretty')}>
            {group.kind === 'question' ? `“${group.label}”` : group.label}
          </h3>

          {/* A gap group holds proposed *additions*, not judgements about something that exists.
              Said outright, because every other card on this page is about existing structure. */}
          {group.gap && (
            <p className="text-muted-foreground max-w-[68ch] text-sm">
              Topics the goal calls for that no question covers. Nothing here changes an existing
              question.
            </p>
          )}
        </button>

        {open && (
          <div className="bg-background border-t px-4 py-4">
            <EvaluationGroupVerdict summary={summary} reconciled={reconciled} />
          </div>
        )}
      </div>

      {/* Indented under the header area, on the page's own ground rather than in a box. Everything
          in here is one judge's argument for what the summary above already concluded — the step in
          from the left edge is what says so. */}
      {open && (
        <div
          id={bodyId}
          className="animate-in fade-in slide-in-from-top-1 mt-4 space-y-3 pr-1 pl-6 duration-200 sm:pl-12"
        >
          <JudgeTabs
            dimensions={group.dimensions}
            counts={counts}
            gap={group.gap}
            active={activeJudge}
            onSelect={setPicked}
            idBase={idBase}
          />
          <ul
            role="tabpanel"
            id={`${idBase}-panel-${activeJudge}`}
            aria-labelledby={`${idBase}-tab-${activeJudge}`}
            className="space-y-3"
          >
            {findingsByJudge.map((f) => (
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
