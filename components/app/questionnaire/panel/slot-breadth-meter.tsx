'use client';

/**
 * SlotBreadthMeter — the breadth (coverage) axis for a data-slot row (Data Slots feature).
 *
 * Breadth is deliberately a SEPARATE signal from the fill's confidence dot: confidence is the
 * agent's certainty about the captured position (a hue, emerald→red), breadth is how many of the
 * slot's mapped background questions the session has actually answered (a count). They form a 2×2 —
 * a slot can read "Confident" yet cover only 2 of 5 of its questions — so breadth gets its own
 * visual grammar: neutral, hue-free segmented pips that read as "N of M", never as a quality score.
 *
 * The pips render up to {@link MAX_PIPS} segments; past that the meter drops the pips and shows the
 * fraction alone so a many-question slot never sprawls. When `expandable` (presentationMode `both`,
 * where the respondent also sees the form), the meter is a full-width disclosure button — it fills its
 * footer so a click anywhere toggles, with the chevron docked to the right edge — itemising the mapped
 * questions, each with a tick/empty state and its own confidence dot. Otherwise it is inert summary
 * text: the count shows, but the raw prompts stay hidden (the chat-mode abstraction). The meter owns
 * its own footer padding; the caller supplies only the border/background frame.
 */

import { useEffect, useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';

import { cn } from '@/lib/utils';
import { ConfidenceIndicator } from '@/components/app/questionnaire/panel/confidence-indicator';
import type { DataSlotCoverage } from '@/lib/app/questionnaire/panel/types';

/** Max segments to draw before collapsing to the fraction-only label. */
const MAX_PIPS = 6;

export interface SlotBreadthMeterProps {
  coverage: DataSlotCoverage;
  /** When true, the meter expands to itemise the mapped questions (presentationMode `both`). */
  expandable: boolean;
  /**
   * When this number changes, an expanded questions list closes itself. The answer panel bumps it on
   * scroll and on refetch so the footer doesn't stay open over a row it's scrolled past or that has
   * since changed. Omit (undefined) to leave the meter under purely manual control.
   */
  collapseSignal?: number;
  className?: string;
}

/** The neutral, hue-free pip row — filled segments first, then empties. Hidden past MAX_PIPS. */
function Pips({ total, answered }: { total: number; answered: number }) {
  if (total > MAX_PIPS) return null;
  return (
    <span className="flex items-center gap-0.5" aria-hidden="true">
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={cn(
            'h-1.5 w-2.5 rounded-[1px]',
            i < answered ? 'bg-foreground/55' : 'bg-foreground/15'
          )}
        />
      ))}
    </span>
  );
}

export function SlotBreadthMeter({
  coverage,
  expandable,
  collapseSignal,
  className,
}: SlotBreadthMeterProps) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  // Close the expanded questions list when the parent signals a collapse (scroll / refetch).
  useEffect(() => {
    if (collapseSignal === undefined) return;
    setOpen(false);
  }, [collapseSignal]);
  const { total, answered, questions } = coverage;

  // A slot that maps to no questions has no breadth to show.
  if (total === 0) return null;

  const label = `${answered} of ${total} ${total === 1 ? 'question' : 'questions'} filled`;
  // Itemise only when the panel is allowed to AND the prompts were actually shipped.
  const canExpand = expandable && questions.length > 0;

  const summary = (
    <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs tabular-nums">
      <Pips total={total} answered={answered} />
      {label}
    </span>
  );

  if (!canExpand) {
    return <div className={cn('px-3 pt-0.5 pb-1.5', className)}>{summary}</div>;
  }

  return (
    <div className={cn(className)}>
      {/* Full-bleed header button: spans the whole footer width so a click anywhere toggles, with the
          chevron docked to the right edge (justify-between). */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={listId}
        className={cn(
          'hover:bg-muted/40 hover:text-foreground flex w-full items-center justify-between gap-2 px-3 pt-0.5 pb-1.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-current/40 focus-visible:ring-inset',
          !open && 'rounded-b-md'
        )}
      >
        {summary}
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'text-muted-foreground h-3 w-3 shrink-0 transition-transform duration-200 motion-reduce:transition-none',
            open && 'rotate-180'
          )}
        />
      </button>
      {open ? (
        <ul id={listId} className="border-border/60 mt-1 mb-2 ml-3 space-y-1 border-l pl-2.5">
          {questions.map((q, i) => (
            <li key={i} className="flex items-start gap-1.5 text-xs">
              {q.answered ? (
                <ConfidenceIndicator confidence={q.confidence} className="mt-1 shrink-0" />
              ) : (
                <span
                  aria-hidden="true"
                  className="border-muted-foreground/40 mt-1 h-2.5 w-2.5 shrink-0 rounded-full border"
                />
              )}
              <span className={cn('min-w-0 flex-1', q.answered ? '' : 'text-muted-foreground/70')}>
                {q.label}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
