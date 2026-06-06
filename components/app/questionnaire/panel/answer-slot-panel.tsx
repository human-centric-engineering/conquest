'use client';

/**
 * AnswerSlotPanel — the live answer-slot panel beside the chat (F7.2).
 *
 * Renders the session's slots grouped by section, each with a confidence dot,
 * provenance, and an expandable detail (rationale + refinement history + Revisit). The
 * header shows progress: "X of N answered" in full_progress, or "N captured" in
 * answered_only (where the pending prompts are never sent). Updates live —
 * {@link SessionWorkspace} refetches the view when each turn settles.
 *
 * Inherits the brand CSS vars from the `BrandThemeProvider` it renders under, so no
 * theme prop-drilling. Read-only display: no `<FieldHelp>` (that's for form inputs).
 *
 * `// DEMO-ONLY (F7.2):` the section/slot/confidence framing is questionnaire-domain;
 * a non-questionnaire fork strips this `panel/` directory.
 */

import { cn } from '@/lib/utils';
import { AnswerSlotItem } from '@/components/app/questionnaire/panel/answer-slot-item';
import type { AnswerPanelView, PanelSlotView } from '@/lib/app/questionnaire/panel/types';

export interface AnswerSlotPanelProps {
  /** The panel view, or null while the first (anonymous) fetch is in flight. */
  view: AnswerPanelView | null;
  loading?: boolean;
  /** Re-ask a slot's question in the conversation. Omit to hide the affordance. */
  onRevisit?: (slot: PanelSlotView) => void;
  /** Whether a revisit can be sent right now (false while streaming / blocked). */
  canRevisit?: boolean;
  className?: string;
}

function ProgressHeading({ view }: { view: AnswerPanelView }) {
  const summary =
    view.scope === 'answered_only'
      ? `${view.answeredCount} captured`
      : `${view.answeredCount} of ${view.totalCount} answered`;
  return (
    <div className="border-b px-4 py-3">
      <h2 className="text-sm font-semibold">Your answers</h2>
      <p className="text-muted-foreground mt-0.5 text-xs tabular-nums">{summary}</p>
    </div>
  );
}

export function AnswerSlotPanel({
  view,
  loading = false,
  onRevisit,
  canRevisit = false,
  className,
}: AnswerSlotPanelProps) {
  return (
    <aside
      aria-label="Your answers"
      className={cn('bg-card flex h-full min-h-0 flex-col rounded-xl border', className)}
    >
      {view === null ? (
        <div className="text-muted-foreground flex flex-1 items-center justify-center p-6 text-sm">
          {loading ? 'Loading your answers…' : 'No answers yet.'}
        </div>
      ) : (
        <>
          <ProgressHeading view={view} />
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
            {view.sections.length === 0 ? (
              <p className="text-muted-foreground px-1 py-4 text-sm">
                Your answers will appear here as the conversation continues.
              </p>
            ) : (
              <div className="space-y-4">
                {view.sections.map((section) => (
                  <section key={section.sectionId}>
                    <h3 className="text-muted-foreground mb-1.5 px-1 text-xs font-medium tracking-wide uppercase">
                      {section.title}
                    </h3>
                    <ul className="space-y-2">
                      {section.slots.map((slot) => (
                        <AnswerSlotItem
                          key={slot.slotKey}
                          slot={slot}
                          onRevisit={onRevisit}
                          canRevisit={canRevisit}
                        />
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </aside>
  );
}
