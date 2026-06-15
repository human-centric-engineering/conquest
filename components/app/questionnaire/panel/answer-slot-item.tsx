'use client';

/**
 * AnswerSlotItem — one slot row in the answer panel (F7.2).
 *
 * Collapsed: the question prompt, the captured value (or a quiet "Not answered yet"),
 * a confidence dot, and a provenance badge. Click an answered row to expand it — the
 * model's rationale, the refinement history, and a "Revisit" action that re-asks the
 * question in the conversation (confirm-gated, since it costs a turn).
 *
 * `// DEMO-ONLY (F7.2):` questionnaire-domain row.
 */

import { useState } from 'react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ConfidenceIndicator } from '@/components/app/questionnaire/panel/confidence-indicator';
import { ConfidenceScore } from '@/components/app/questionnaire/panel/confidence-score';
import { ProvenanceBadge } from '@/components/app/questionnaire/panel/provenance-badge';
import { RefinementHistory } from '@/components/app/questionnaire/panel/refinement-history';
import { formatAnswerValue } from '@/components/app/questionnaire/panel/format-answer-value';
import type { PanelSlotView } from '@/lib/app/questionnaire/panel/types';

export interface AnswerSlotItemProps {
  slot: PanelSlotView;
  /** Re-ask this slot's question in the conversation. Omit to hide the affordance. */
  onRevisit?: (slot: PanelSlotView) => void;
  /** Whether a revisit can be sent right now (false while streaming / blocked). */
  canRevisit?: boolean;
}

export function AnswerSlotItem({ slot, onRevisit, canRevisit = false }: AnswerSlotItemProps) {
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const expandable = slot.answered;
  const toggle = () => {
    if (!expandable) return;
    setExpanded((v) => !v);
    setConfirming(false);
  };

  return (
    <li className="rounded-md border px-3 py-2">
      <button
        type="button"
        onClick={toggle}
        disabled={!expandable}
        aria-expanded={expandable ? expanded : undefined}
        className={cn(
          'flex w-full items-start gap-2 text-left',
          expandable ? 'cursor-pointer' : 'cursor-default'
        )}
      >
        {slot.answered ? (
          <ConfidenceIndicator confidence={slot.confidence} className="mt-1" />
        ) : (
          <span
            aria-hidden="true"
            className="border-muted-foreground/40 mt-1 inline-flex h-2.5 w-2.5 shrink-0 rounded-full border border-dashed"
          />
        )}
        <span className="min-w-0 flex-1">
          <span className="text-foreground block text-sm leading-snug">{slot.prompt}</span>
          {slot.answered ? (
            <>
              <span className="text-muted-foreground mt-0.5 block truncate text-sm">
                {formatAnswerValue(slot.value)}
              </span>
              {/* The actual confidence score (demo panel shows the number). */}
              <ConfidenceScore confidence={slot.confidence} className="mt-1" />
            </>
          ) : (
            <span className="text-muted-foreground/70 mt-0.5 block text-xs italic">
              Not answered yet
            </span>
          )}
          {/* A one-line peek at the model's reasoning, so the "why" reads in the row
              itself; the full rationale stays in the expanded view. */}
          {slot.answered && slot.rationale && !expanded && (
            <span className="text-muted-foreground/70 mt-0.5 line-clamp-1 block text-xs">
              {slot.rationale}
            </span>
          )}
        </span>
        {slot.answered && <ProvenanceBadge provenance={slot.provenance} className="mt-0.5" />}
      </button>

      {expandable && expanded && (
        <div className="mt-2 space-y-2 border-t pt-2 pl-[1.125rem]">
          {slot.rationale && <p className="text-muted-foreground text-xs">{slot.rationale}</p>}
          <RefinementHistory entries={slot.refinementHistory} />

          {onRevisit &&
            (confirming ? (
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground text-xs">Re-ask this question?</span>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={!canRevisit}
                  onClick={() => {
                    onRevisit(slot);
                    setConfirming(false);
                    setExpanded(false);
                  }}
                >
                  Yes, revisit
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirming(false)}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!canRevisit}
                onClick={() => setConfirming(true)}
              >
                Revisit
              </Button>
            ))}
        </div>
      )}
    </li>
  );
}
