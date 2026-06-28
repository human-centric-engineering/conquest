'use client';

/**
 * QuestionnaireForm — the raw, sectioned form surface (P-presentation).
 *
 * Renders one section at a time with prev/next navigation and a {@link SectionNavigator}
 * completeness map, each question shown with the right control via {@link QuestionField}.
 * Presentational: the autosave state (values, save status, the form view) is owned by the
 * parent's {@link useFormAnswers} and passed in, so the same instance drives "both" mode's
 * chat↔form toggle without losing edits.
 *
 * Edits flow up through `onChange` (debounced autosave) with `onFlush` on blur; the
 * completeness map marks agent-inferred answers distinctly so the respondent can adjust
 * what the conversation filled in the background — the form's escape-hatch purpose.
 */

import { useMemo } from 'react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { FieldHelp } from '@/components/ui/field-help';
import { useWizard } from '@/lib/hooks/use-wizard';
import { QuestionField } from '@/components/app/questionnaire/form/question-field';
import { SectionNavigator } from '@/components/app/questionnaire/form/section-navigator';
import { ConfidenceScore } from '@/components/app/questionnaire/panel/confidence-score';
import { recentlyFilledByLatestTurn } from '@/lib/app/questionnaire/panel/newly-filled';
// Reuse the authoring editors' autosave pill (idle/saving/saved/error + last-saved clock) so the
// respondent form's persistent indicator reads identically to the admin structure editor's.
import { SaveStatus as SaveStatusIndicator } from '@/components/admin/questionnaires/save-status';
import type { SaveStatus } from '@/lib/hooks/use-form-answers';
import type { AnswerPanelView, PanelSlotView } from '@/lib/app/questionnaire/panel/types';

export interface QuestionnaireFormProps {
  view: AnswerPanelView | null;
  loading: boolean;
  values: Record<string, unknown>;
  /**
   * Slot keys the respondent has edited locally. Drives the "inferred"/confidence markers: an
   * answer stays the agent's (and shows its confidence) until the respondent edits it. Separate
   * from `values`, which is seeded with every existing answer so the inputs render. Defaults to
   * empty (no local edits yet).
   */
  editedKeys?: ReadonlySet<string>;
  statuses: Record<string, SaveStatus>;
  /** Aggregate autosave state for the persistent header indicator. Defaults to `idle`. */
  saveState?: SaveStatus;
  /** Epoch ms of the last successful save, for the indicator's "saved · 2m ago" clock. */
  lastSavedAt?: number | null;
  onChange: (slotKey: string, value: unknown) => void;
  onFlush: (slotKey: string) => void;
  /** Disable all inputs (e.g. a non-active session). */
  disabled?: boolean;
  className?: string;
}

/** Stable empty default for `editedKeys` so an omitted prop doesn't churn identity each render. */
const EMPTY_EDITED: ReadonlySet<string> = new Set();

/** A value the form treats as "no answer" for completeness purposes. */
function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

const SAVE_HINT: Record<SaveStatus, string> = {
  idle: '',
  saving: 'Saving…',
  saved: 'Saved',
  error: 'Not saved — retry',
};

export function QuestionnaireForm({
  view,
  loading,
  values,
  editedKeys = EMPTY_EDITED,
  statuses,
  saveState = 'idle',
  lastSavedAt = null,
  onChange,
  onFlush,
  disabled = false,
  className,
}: QuestionnaireFormProps) {
  const sections = useMemo(() => view?.sections ?? [], [view]);
  const wiz = useWizard({ totalSteps: Math.max(1, sections.length) });

  // Local-aware answered/inferred predicates: a locally-typed value counts immediately,
  // and an inferred badge reflects the server provenance until the respondent edits it.
  const inferredKeys = useMemo(() => {
    const set = new Set<string>();
    for (const section of sections) {
      for (const slot of section.slots) {
        if (
          slot.answered &&
          (slot.provenance === 'inferred' || slot.provenance === 'synthesised')
        ) {
          set.add(slot.slotKey);
        }
      }
    }
    return set;
  }, [sections]);

  // Questions the most recent fill-turn captured (max `answeredAtTurnIndex`) — gently pulsed in the
  // navigator dots and on the answer block, so a respondent switching to the form sees what the last
  // chat turn just filled. Persists until a newer turn fills something.
  const recentlyFilledKeys = useMemo(
    () =>
      recentlyFilledByLatestTurn(
        sections.flatMap((s) =>
          s.slots.map((slot) => ({
            key: slot.slotKey,
            answeredAtTurnIndex: slot.answeredAtTurnIndex,
          }))
        )
      ),
    [sections]
  );

  const isAnswered = (slotKey: string): boolean => {
    if (slotKey in values) return !isEmptyValue(values[slotKey]);
    return false;
  };
  // Still the agent's answer (show the "inferred" badge) until the respondent edits it. Gated on
  // `editedKeys`, NOT `slotKey in values`: `values` is seeded with every existing answer so the
  // inputs render, so "has a value" can't distinguish an agent fill from a respondent edit.
  const isInferred = (slotKey: string): boolean =>
    inferredKeys.has(slotKey) && !editedKeys.has(slotKey);

  // Whether to show the capture-confidence chip. A free-text answer is ALWAYS the agent's paraphrase
  // of what the respondent said (F9.18 living comments), so it carries a meaningful confidence even
  // when stated directly — show it on every answered free-text slot. Structured answers (likert /
  // choice / numeric …) only show it when the agent inferred/synthesised them. Drops on a local
  // edit (it's the respondent's own from then on) and when there's no score to show.
  const showsConfidence = (slot: PanelSlotView): boolean => {
    if (editedKeys.has(slot.slotKey) || slot.confidence === null) return false;
    if (slot.type === 'free_text') return slot.answered;
    return inferredKeys.has(slot.slotKey);
  };
  const isRecentlyFilled = (slotKey: string): boolean => recentlyFilledKeys.has(slotKey);

  if (loading && !view) {
    return (
      <div className={cn('text-muted-foreground p-6 text-sm', className)}>
        Loading questionnaire…
      </div>
    );
  }
  if (sections.length === 0) {
    return (
      <div className={cn('text-muted-foreground p-6 text-sm', className)}>
        This questionnaire has no questions yet.
      </div>
    );
  }

  const answeredCount = view?.answeredCount ?? 0;
  const totalCount = view?.totalCount ?? 0;
  const section = sections[Math.min(wiz.stepIndex, sections.length - 1)];

  return (
    <div className={cn('grid min-h-0 gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]', className)}>
      {/* Completeness map */}
      <aside className="hidden min-h-0 overflow-y-auto lg:block">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-foreground text-sm font-medium">Progress</span>
          <span className="text-muted-foreground text-xs tabular-nums">
            {answeredCount}/{totalCount}
          </span>
        </div>
        <SectionNavigator
          sections={sections}
          activeIndex={wiz.stepIndex}
          onJump={wiz.goTo}
          isAnswered={isAnswered}
          isInferred={isInferred}
          isRecentlyFilled={isRecentlyFilled}
        />
      </aside>

      {/* Active section. `min-w-0` lets this grid track shrink below its content's intrinsic width
          (likert buttons + the fixed confidence lane) instead of forcing the page to scroll. */}
      <div className="flex min-h-0 min-w-0 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {/* Sticky section header — stays pinned while the questions scroll beneath it, so the
              respondent always sees which section they're in (and the autosave state). The frosted
              backdrop lets content slide under it without a hard cut. */}
          <div className="bg-background/85 sticky top-0 z-10 flex items-center justify-between gap-3 border-b pt-0.5 pb-3 backdrop-blur-sm">
            <h2 className="text-foreground text-lg font-semibold">
              {section.title || `Section ${wiz.stepIndex + 1}`}
            </h2>
            {/* Persistent autosave indicator: nothing's lost, even though there's no Save button. */}
            <SaveStatusIndicator state={saveState} lastSavedAt={lastSavedAt} />
          </div>
          <ol className="mt-4 space-y-6">
            {section.slots.map((slot) => {
              const status = statuses[slot.slotKey] ?? 'idle';
              return (
                <li
                  key={slot.slotKey}
                  className={cn(
                    // Two-lane layout: the question (prompt + control) on the left, the agent's
                    // capture confidence in its own fixed right-hand column so chips align in a
                    // tidy lane instead of trailing each prompt. Collapses to one column below `sm`.
                    'grid grid-cols-1 items-start gap-x-5 gap-y-2 sm:grid-cols-[minmax(0,1fr)_8rem]',
                    // Filled by the latest turn — a brief one-shot wash that settles to a resting
                    // tint on the whole answer block (no indefinite breathing). `-mx-3` cancels the
                    // `px-3` so the tint gets breathing room without shifting the content right —
                    // keeping this question's text/inputs aligned with its unfilled siblings.
                    isRecentlyFilled(slot.slotKey) && 'cq-fill-glow-once -mx-3 rounded-md px-3 py-2'
                  )}
                >
                  {/* Question — prompt + control. `min-w-0` so the control can shrink within the
                      lane rather than pushing the row wider than the viewport. */}
                  <div className="min-w-0 space-y-2">
                    <label className="text-foreground text-sm font-medium">
                      {slot.prompt}
                      {slot.required && <span className="text-destructive ml-0.5">*</span>}
                    </label>
                    <QuestionField
                      slot={slot}
                      value={values[slot.slotKey]}
                      onChange={(v) => onChange(slot.slotKey, v)}
                      onBlur={() => onFlush(slot.slotKey)}
                      disabled={disabled}
                    />
                  </div>

                  {/* Confidence lane — how sure the agent is about the answer it captured (a
                      Tentative guess vs a Confident, corroborated one). Shows on agent-filled
                      structured answers and on every free-text answer (always a paraphrase), and
                      drops once the respondent edits it. The "inferred" ⓘ explainer sits beside the
                      chip (same provenance affordance); the transient save hint shares the lane.
                      Right-aligned + top-padded on `sm+` so the chips line up with each question's
                      first line; inline under the prompt on narrow screens. */}
                  <div className="flex flex-row flex-wrap items-center gap-x-2 gap-y-1 sm:flex-col sm:items-end sm:pt-0.5">
                    <div className="flex items-center gap-1">
                      {showsConfidence(slot) && (
                        <ConfidenceScore confidence={slot.confidence ?? null} />
                      )}
                      {isInferred(slot.slotKey) && (
                        <FieldHelp
                          title="Inferred from your conversation"
                          ariaLabel="Inferred answer — edit if needed"
                        >
                          The agent inferred this answer from what you said in the chat. Edit it
                          here if it&apos;s not quite right.
                        </FieldHelp>
                      )}
                    </div>
                    {status !== 'idle' && (
                      <span
                        className={cn(
                          'text-xs',
                          status === 'error' ? 'text-destructive' : 'text-muted-foreground'
                        )}
                      >
                        {SAVE_HINT[status]}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        </div>

        {/* Section nav */}
        <div className="mt-4 flex items-center justify-between border-t pt-3">
          <Button type="button" variant="outline" onClick={wiz.prev} disabled={wiz.isFirst}>
            Previous
          </Button>
          <span className="text-muted-foreground text-xs">
            Section {wiz.stepIndex + 1} of {sections.length}
          </span>
          <Button type="button" variant="outline" onClick={wiz.next} disabled={wiz.isLast}>
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
