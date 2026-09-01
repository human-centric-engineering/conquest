'use client';

/**
 * The panel's verdict on one question — the thing a reviewer reads before anything else.
 *
 * The run-detail page used to open with seven judges' worth of individual findings and leave the
 * reviewer to work out what the panel collectively wanted. This section inverts that: what is on
 * the table, who is behind each option, and the wording several judges can live with — and only
 * then, in the tabs below it, the individual judgements that produced it.
 *
 * ## One block per proposed action, ruled off from its neighbours
 *
 * The verdict used to be a single line: the winning verb, its backing, and any dissent appended as
 * trailing clauses ("Reword it · 2 of 3 judges · 1 judge says delete it instead"). That is the whole
 * panel compressed into one sentence, and a reader has to parse three clauses before knowing what
 * the options even are. Worse, the caveats that hung off the end of it — "Type-Fit is not resolved
 * by rewording" — floated free of the thing they were a caveat about.
 *
 * So each proposed action is now its own block under its own heading ("A reword, as proposed by 2 of
 * 3 judges"), the blocks are separated by rules, and every caveat sits inside the block it
 * qualifies. The reviewer reads a list of options, not a sentence to be unpacked.
 *
 * Three things it must never do:
 *
 *  1. **Manufacture agreement.** Every proposed action gets a block, in support order. The dissent
 *     is not a footnote on the winner; it is the next heading down.
 *  2. **Overstate the rewrite.** A reconciled alternative names the judges it satisfies, and the
 *     `unresolved` line names the ones no wording can — because a rewrite presented as the answer
 *     to a type-fit complaint is worse than no rewrite at all. Both live in the block holding the
 *     wording, so neither can drift away from what it is talking about.
 *  3. **Swallow the reconciled text into a control.** The wording is the most copy-pasted string on
 *     the page, so it lives outside the disclosure button where it can be selected.
 */

import { cn } from '@/lib/utils';
import type { EvaluationDimension } from '@/lib/app/questionnaire/evaluation';
import {
  ACTION_NOUNS,
  backing,
  judgeName,
  judgeNames,
  wordingHost,
  type GroupActionKind,
  type GroupActionSummary,
} from '@/lib/app/questionnaire/evaluation/group-actions';
import type { ReconciledSuggestion } from '@/lib/app/questionnaire/evaluation/reconcile-schema';
import {
  FieldLabel,
  MetaRow,
  PROSE_MEASURE,
  QUESTION_FACE,
  QUESTION_MEASURE,
} from '@/components/admin/questionnaires/evaluation-field';

/**
 * Re-exported rather than declared here. `judgeName` moved into `group-actions.ts` when the
 * Questionnaire Pack needed the same names in a document it renders on the server, and a
 * `'use client'` module is not somewhere `lib/` can import from. Callers in this folder keep their
 * existing import site.
 */
export { judgeName };

/**
 * Accent per verb, as a rule down the left edge of its block rather than a fill.
 *
 * Colour carries a hint, never the message — every action also states itself in words in its
 * heading, so this survives greyscale, colour-blindness, and a reviewer skimming at speed.
 */
const ACTION_TONE: Record<GroupActionKind, string> = {
  delete: 'border-destructive/50',
  retype: 'border-amber-500/60',
  // Amber with `move` and `retype`: it reshapes the instrument rather than merely rewording it.
  split: 'border-amber-500/60',
  move: 'border-amber-500/60',
  add: 'border-emerald-500/60',
  reword: 'border-primary/40',
  guidance: 'border-primary/40',
  goal: 'border-primary/40',
  audience: 'border-primary/40',
  review: 'border-border',
};

interface Props {
  summary: GroupActionSummary;
  /** The run's reconciled alternatives for this target; `undefined` when nothing was reconciled. */
  reconciled: ReconciledSuggestion | undefined;
}

export function EvaluationGroupVerdict({ summary, reconciled }: Props) {
  const { primary, others, judgeCount } = summary;
  if (!primary) return null;

  const actions = [primary, ...others];
  const alternatives = reconciled?.alternatives ?? [];
  const host = wordingHost(actions);

  return (
    <section>
      {/* Named in full rather than eyebrowed. "VERDICT" over a block of options assumes the reader
          already knows which verdict, reached by whom — this page has three different panels on it
          and a run of seven judges, so the heading says both. */}
      <h4 className="text-sm font-medium">The overall verdict from the evaluation judges:</h4>

      <div className="bg-background mt-2 divide-y rounded-md border">
        {actions.map((action) => {
          const holdsWording = action === host && alternatives.length > 0;
          return (
            <div key={action.kind} className={cn('border-l-2 px-3 py-3', ACTION_TONE[action.kind])}>
              <h5 className="text-sm font-medium">
                {ACTION_NOUNS[action.kind]}, as proposed by {backing(action, judgeCount)}
              </h5>
              <MetaRow className="mt-1">{judgeNames(action.judges)}</MetaRow>

              {holdsWording && (
                <div className="mt-2.5 space-y-2.5">
                  {alternatives.map((alt, i) => (
                    <div key={i}>
                      {/* Selectable: this is the string a reviewer copies into the editor. Set in
                          the questionnaire's own face, because that is exactly what it is —
                          proposed wording, not advice about wording. */}
                      <p
                        className={cn(
                          QUESTION_FACE,
                          QUESTION_MEASURE,
                          'text-foreground text-base leading-snug text-pretty'
                        )}
                      >
                        “{alt.prompt}”
                      </p>
                      <MetaRow className="mt-1">
                        {`Satisfies ${judgeNames(alt.addresses)}`}
                        {alt.note ? alt.note : null}
                      </MetaRow>
                    </div>
                  ))}

                  {/* The caveat lives inside the block holding the wording it is a caveat about.
                      Floating at the end of the verdict it read as a free-standing statement about
                      a judge, which is how "Type-Fit is not resolved by rewording" ended up
                      looking like a finding of its own. */}
                  {reconciled && reconciled.unresolved.length > 0 && (
                    <p className={cn(PROSE_MEASURE, 'text-muted-foreground text-sm')}>
                      {`No wording satisfies ${judgeNames(reconciled.unresolved)} — that ${
                        reconciled.unresolved.length === 1 ? 'judge needs' : 'judges need'
                      } a structural change, not a rewrite.`}
                    </p>
                  )}
                </div>
              )}

              {/* No wording under this block: either nothing was reconciled, or this is a dissenting
                  action. Point at the tab that carries the argument rather than leaving the heading
                  to stand alone. */}
              {!holdsWording && (
                <p className={cn(PROSE_MEASURE, 'text-muted-foreground mt-1.5 text-sm')}>
                  {action.judges.length === 1
                    ? `See the ${judgeNames(action.judges)} tab below for the reasoning.`
                    : 'See the judge tabs below for the reasoning.'}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/**
 * The judges that flagged a target, as a tab strip — one tab per judge, one judge's findings shown
 * at a time.
 *
 * Every judge's findings used to be stacked in one column below the verdict, so a question flagged
 * by four judges was a page of near-identical cards, each with its own apply controls, and the
 * reviewer scrolled past three of them to reach the fourth. Tabs make "whose reasoning am I
 * reading" a choice rather than a scroll position, and keep exactly one set of decision controls
 * on screen at a time.
 *
 * A single judge still gets a strip of one. The label says who is talking, and a lone tab is a
 * cheaper thing to read than a special case is to explain.
 */
export function JudgeTabs({
  dimensions,
  counts,
  gap,
  active,
  onSelect,
  idBase,
}: {
  dimensions: EvaluationDimension[];
  /** Findings per judge — a judge that raised two points says so on its tab. */
  counts: Record<string, number>;
  gap: boolean;
  active: EvaluationDimension;
  onSelect: (dimension: EvaluationDimension) => void;
  /** Prefix for the `id` / `aria-controls` pair, unique per group. */
  idBase: string;
}) {
  const one = dimensions.length === 1;

  return (
    <div>
      <FieldLabel>
        {gap ? 'Raised by' : 'Flagged by'} the following {one ? 'judge' : 'judges'}:
      </FieldLabel>
      <div role="tablist" className="mt-1.5 flex flex-wrap items-end gap-1 border-b">
        {dimensions.map((d) => {
          const selected = d === active;
          return (
            <button
              key={d}
              type="button"
              role="tab"
              id={`${idBase}-tab-${d}`}
              aria-selected={selected}
              aria-controls={`${idBase}-panel-${d}`}
              onClick={() => onSelect(d)}
              className={cn(
                '-mb-px cursor-pointer border-b-2 px-3 py-1.5 text-sm transition-colors',
                selected
                  ? 'border-primary text-foreground font-medium'
                  : 'text-muted-foreground hover:text-foreground border-transparent'
              )}
            >
              {judgeName(d)}
              {counts[d] > 1 && (
                <span className="text-muted-foreground ml-1.5 text-xs tabular-nums">
                  {counts[d]}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
