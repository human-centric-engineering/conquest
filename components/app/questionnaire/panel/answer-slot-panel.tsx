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
import { ConfidenceIndicator } from '@/components/app/questionnaire/panel/confidence-indicator';
import { confidenceBand, confidenceBandLabel } from '@/lib/app/questionnaire/panel/confidence';
import type {
  AnswerPanelView,
  DataSlotPanelGroup,
  PanelSlotView,
} from '@/lib/app/questionnaire/panel/types';

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
  const dataSlotMode = view.dataSlotGroups !== undefined;
  // Data-slot mode shows one balanced percentage (questions + data slots) — never the raw question
  // count, which the respondent never sees. Question mode keeps the familiar "N of M" / "N captured".
  const percent = view.progressPercent ?? 0;
  const summary = dataSlotMode
    ? `${percent}% complete`
    : view.scope === 'answered_only'
      ? `${view.answeredCount} captured`
      : `${view.answeredCount} of ${view.totalCount} answered`;
  return (
    <div className="border-b px-4 py-3">
      <h2 className="text-sm font-semibold">
        {dataSlotMode ? 'What we’re learning' : 'Your answers'}
      </h2>
      <p className="text-muted-foreground mt-0.5 text-xs tabular-nums">{summary}</p>
      {dataSlotMode ? (
        <div
          className="bg-muted mt-2 h-1.5 overflow-hidden rounded-full"
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Completion progress"
        >
          <div
            className="bg-primary h-full rounded-full transition-[width] duration-500 ease-out"
            style={{ width: `${percent}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}

/** Data Slots feature: themed groups of data slots showing the paraphrase + a confidence dot. */
function DataSlotGroups({ groups }: { groups: DataSlotPanelGroup[] }) {
  if (groups.every((g) => g.slots.length === 0)) {
    return (
      <p className="text-muted-foreground px-1 py-4 text-sm">
        As you chat, we’ll show what we’re learning here.
      </p>
    );
  }
  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <section key={group.theme}>
          <h3 className="text-muted-foreground mb-1.5 px-1 text-xs font-medium tracking-wide uppercase">
            {group.theme}
          </h3>
          <ul className="space-y-2">
            {group.slots.map((slot) => (
              <li key={slot.key} className="rounded-md border px-3 py-2">
                <div className="flex items-start gap-2">
                  <ConfidenceIndicator confidence={slot.confidence} className="mt-1" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{slot.name}</p>
                    {slot.paraphrase ? (
                      <>
                        <p className="text-muted-foreground mt-0.5 text-sm">{slot.paraphrase}</p>
                        {slot.provenance === 'inferred' || slot.provenance === 'synthesised' ? (
                          <span
                            className="bg-muted text-muted-foreground mt-1 inline-flex items-center rounded-full px-1.5 py-0.5 text-[11px] font-medium"
                            title="We didn't capture this directly — it's our reading of the conversation, not something you stated"
                          >
                            Inferred ·{' '}
                            {confidenceBandLabel(confidenceBand(slot.confidence)).toLowerCase()}
                          </span>
                        ) : null}
                      </>
                    ) : (
                      <p className="text-muted-foreground/70 mt-0.5 text-xs italic">
                        Not covered yet
                      </p>
                    )}
                    {slot.provisional ? (
                      <p
                        className="text-muted-foreground/60 mt-0.5 text-[11px] italic"
                        title="A best guess we recorded so we could keep moving — we may revisit it"
                      >
                        provisional · may revisit
                      </p>
                    ) : null}
                    {slot.history.length > 0 ? (
                      <ul className="mt-1 space-y-0.5">
                        {slot.history
                          .filter((h) => h.paraphrase)
                          .map((h, i) => (
                            <li
                              key={i}
                              className="text-muted-foreground/70 text-xs line-through"
                              title="An earlier answer you later changed"
                            >
                              Earlier: {h.paraphrase}
                            </li>
                          ))}
                      </ul>
                    ) : null}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
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
            {view.dataSlotGroups !== undefined ? (
              <DataSlotGroups groups={view.dataSlotGroups} />
            ) : view.sections.length === 0 ? (
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
