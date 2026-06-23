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
 * Data-slot mode adds two navigation aids for long questionnaires (F7.8): a floating
 * {@link SlotMiniMap} — a vertical, scaled-down mirror of the scroll area (one proportional bar per
 * slot, tinted by confidence, with a viewport window that follows the scroll; click/drag to scrub) —
 * and an after-turn stepper: when a turn fills slots the panel scrolls to the topmost one and a
 * footer steps through the rest ("2 more answers recorded →"). The workspace computes which slots a
 * turn filled (see `newly-filled.ts`) and hands the ordered keys in via `newlyFilledKeys`.
 *
 * Inherits the brand CSS vars from the `BrandThemeProvider` it renders under, so no
 * theme prop-drilling. Read-only display: no `<FieldHelp>` (that's for form inputs).
 *
 * `// DEMO-ONLY (F7.2):` the section/slot/confidence framing is questionnaire-domain;
 * a non-questionnaire fork strips this `panel/` directory.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { cn } from '@/lib/utils';
import { usePrefersReducedMotion } from '@/lib/hooks/use-prefers-reduced-motion';
import { AnswerSlotItem } from '@/components/app/questionnaire/panel/answer-slot-item';
import { ConfidenceIndicator } from '@/components/app/questionnaire/panel/confidence-indicator';
import { ConfidenceScore } from '@/components/app/questionnaire/panel/confidence-score';
import { NoticeWhy } from '@/components/app/questionnaire/chat/notice-why';
import { SlotMiniMap } from '@/components/app/questionnaire/panel/slot-minimap';
import { panelSlotDomId } from '@/lib/app/questionnaire/panel/newly-filled';
import { computeMiniMapModel, type MiniMapRowInput } from '@/lib/app/questionnaire/panel/minimap';
import type {
  AnswerPanelView,
  DataSlotPanelGroup,
  DataSlotPanelSlot,
  PanelSlotView,
} from '@/lib/app/questionnaire/panel/types';

/** Show the minimap only once the list is long enough to need one (and actually overflows). */
const OVERVIEW_MIN_SLOTS = 10;
/** How long a scrolled-to slot keeps its highlight ring (ms). */
const HIGHLIGHT_MS = 1500;

export interface AnswerSlotPanelProps {
  /** The panel view, or null while the first (anonymous) fetch is in flight. */
  view: AnswerPanelView | null;
  loading?: boolean;
  /** Re-ask a slot's question in the conversation. Omit to hide the affordance. */
  onRevisit?: (slot: PanelSlotView) => void;
  /** Whether a revisit can be sent right now (false while streaming / blocked). */
  canRevisit?: boolean;
  /**
   * Data-slot mode: keys the latest turn filled, in panel display order (from the workspace's
   * snapshot diff). The panel scrolls to the first and steps through the rest. Omit / empty when no
   * slots changed this turn.
   */
  newlyFilledKeys?: readonly string[];
  className?: string;
}

function ProgressHeading({ view }: { view: AnswerPanelView }) {
  const dataSlotMode = view.dataSlotGroups !== undefined;
  // Data-slot mode shows one balanced percentage (questions + data slots) — never the raw question
  // count, which the respondent never sees. Question mode keeps the familiar "N of M" / "N captured".
  const percent = view.progressPercent ?? 0;
  const completion = dataSlotMode
    ? `${percent}% complete`
    : view.scope === 'answered_only'
      ? `${view.answeredCount} captured`
      : `${view.answeredCount} of ${view.totalCount} answered`;
  // Average confidence across all captured slots, paired with completion ("… · avg confidence 58%").
  // Honest mean: a tangential/low-confidence fill drags it down by design. Omitted until something
  // scored has been captured.
  const avgConfidence =
    view.averageConfidence !== undefined ? Math.round(view.averageConfidence * 100) : null;
  const summary =
    avgConfidence !== null ? `${completion} · avg confidence ${avgConfidence}%` : completion;
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

/** The "N more …" stepper footer copy — singular wording for the last hop. */
function moreRecordedLabel(remaining: number): string {
  return remaining === 1 ? '1 more slot was answered' : `${remaining} more answers recorded`;
}

/**
 * One data-slot row (Data Slots feature): the short name, the agent's paraphrase, a confidence dot
 * + score, an "Inferred" marker, the "Why?" rationale disclosure, and prior values. Carries the DOM
 * anchor + highlight + stepper footer the panel injects for after-turn navigation.
 */
function DataSlotRow({
  slot,
  highlighted,
  stepperRemaining,
  onStepNext,
}: {
  slot: DataSlotPanelSlot;
  highlighted: boolean;
  /** When non-null, render the "N more recorded" footer with this many slots still to come. */
  stepperRemaining: number | null;
  onStepNext: () => void;
}) {
  return (
    <li
      id={panelSlotDomId(slot.key)}
      data-slot-key={slot.key}
      tabIndex={-1}
      className={cn(
        'rounded-md border px-3 py-2 transition-shadow duration-300 outline-none motion-reduce:transition-none',
        highlighted && 'ring-primary/60 ring-2'
      )}
    >
      <div className="flex items-start gap-2">
        <ConfidenceIndicator confidence={slot.confidence} className="mt-1" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{slot.name}</p>
          {slot.paraphrase ? (
            <>
              <p className="text-muted-foreground mt-0.5 text-sm">{slot.paraphrase}</p>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                {/* The confidence as label + raw % — shown to respondents so the
                    nuanced 30–100% range reads at a glance, not just a band word. */}
                <ConfidenceScore confidence={slot.confidence} />
                {slot.provenance === 'inferred' || slot.provenance === 'synthesised' ? (
                  <span
                    className="bg-muted text-muted-foreground inline-flex items-center rounded-full px-1.5 py-0.5 text-[11px] font-medium"
                    title="We didn't capture this directly — it's our reading of the conversation, not something you stated"
                  >
                    Inferred
                  </span>
                ) : null}
              </div>
              {/* The agent's rationale for this reading, behind a "Why?" disclosure. */}
              <NoticeWhy detail={slot.rationale ?? undefined} />
            </>
          ) : (
            <p className="text-muted-foreground/70 mt-0.5 text-xs italic">Not covered yet</p>
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
          {stepperRemaining != null && stepperRemaining > 0 ? (
            <button
              type="button"
              onClick={onStepNext}
              aria-label="Go to the next answer recorded this turn"
              className="text-primary hover:text-primary/80 mt-1.5 inline-flex items-center gap-1 text-xs font-medium underline-offset-2 hover:underline"
            >
              {moreRecordedLabel(stepperRemaining)} <span aria-hidden="true">→</span>
            </button>
          ) : null}
        </div>
      </div>
    </li>
  );
}

export function AnswerSlotPanel({
  view,
  loading = false,
  onRevisit,
  canRevisit = false,
  newlyFilledKeys,
  className,
}: AnswerSlotPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prefersReducedMotion = usePrefersReducedMotion();

  const [highlightedKey, setHighlightedKey] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');
  // Stepper cursor: index into `newlyFilledKeys`, or null when no after-turn fills are active.
  const [cursor, setCursor] = useState<number | null>(null);
  // Measured minimap geometry (content + row rects) and the live scroll offset, kept separate so a
  // scroll updates only the cheap `viewportTop` rather than re-measuring every row.
  const [geometry, setGeometry] = useState<{
    contentHeight: number;
    viewportHeight: number;
    rows: MiniMapRowInput[];
  }>({ contentHeight: 0, viewportHeight: 0, rows: [] });
  const [viewportTop, setViewportTop] = useState(0);

  const dataSlotMode = view?.dataSlotGroups !== undefined;
  const groups: DataSlotPanelGroup[] = useMemo(
    () => view?.dataSlotGroups ?? [],
    [view?.dataSlotGroups]
  );
  const totalSlots = useMemo(() => groups.reduce((n, g) => n + g.slots.length, 0), [groups]);

  // Slot key -> name (aria-live announcement) and -> fill state (minimap bar colour).
  const slotMetaByKey = useMemo(() => {
    const map = new Map<string, { name: string; filled: boolean; confidence: number | null }>();
    for (const g of groups)
      for (const s of g.slots)
        map.set(s.key, { name: s.name, filled: s.filled, confidence: s.confidence });
    return map;
  }, [groups]);

  // Scroll the list (its own container, never the window) to a slot, focus it, and pulse it.
  const scrollToSlot = useCallback(
    (key: string) => {
      const container = scrollRef.current;
      // No-op when the panel is not laid out (hidden below `lg`, or SSR) - nothing to scroll.
      if (!container || container.offsetHeight === 0) return;
      const el = container.querySelector<HTMLElement>(`[data-slot-key="${CSS.escape(key)}"]`);
      if (!el) return;
      const delta = el.getBoundingClientRect().top - container.getBoundingClientRect().top;
      container.scrollTo({
        top: container.scrollTop + delta - 8,
        behavior: prefersReducedMotion ? 'auto' : 'smooth',
      });
      // Move focus so keyboard users follow the jump; preventScroll avoids fighting our own scroll.
      el.focus({ preventScroll: true });
      setHighlightedKey(key);
      setAnnounce(`Jumped to ${slotMetaByKey.get(key)?.name ?? 'answer'}`);
      if (highlightTimer.current) clearTimeout(highlightTimer.current);
      highlightTimer.current = setTimeout(() => setHighlightedKey(null), HIGHLIGHT_MS);
    },
    [slotMetaByKey, prefersReducedMotion]
  );

  // Scrub the list to a fraction [0,1] of its content (minimap click / drag), centring the point.
  const scrubToFraction = useCallback(
    (fraction: number, smooth: boolean) => {
      const container = scrollRef.current;
      if (!container) return;
      const maxTop = container.scrollHeight - container.clientHeight;
      const target = Math.min(
        maxTop,
        Math.max(0, fraction * container.scrollHeight - container.clientHeight / 2)
      );
      container.scrollTo({
        top: target,
        behavior: smooth && !prefersReducedMotion ? 'smooth' : 'auto',
      });
    },
    [prefersReducedMotion]
  );

  useEffect(() => {
    return () => {
      if (highlightTimer.current) clearTimeout(highlightTimer.current);
    };
  }, []);

  // After-turn stepper: a new set of newly-filled keys arms the stepper at the top one and scrolls
  // to it. Keyed on the serialized keys so the same turn does not re-fire, and a new turn restarts.
  const newlyKey = newlyFilledKeys ? newlyFilledKeys.join(' ') : '';
  useEffect(() => {
    if (!newlyFilledKeys || newlyFilledKeys.length === 0) {
      setCursor(null);
      return;
    }
    setCursor(0);
    scrollToSlot(newlyFilledKeys[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key on the serialized list, not identity
  }, [newlyKey]);

  const stepNext = useCallback(() => {
    setCursor((prev) => {
      if (prev === null || !newlyFilledKeys) return prev;
      const next = prev + 1;
      if (next >= newlyFilledKeys.length) return prev;
      scrollToSlot(newlyFilledKeys[next]);
      return next;
    });
  }, [newlyFilledKeys, scrollToSlot]);

  // Measure the minimap geometry: the scroll content height and every slot row's rect, in content
  // pixel space. Re-runs when the content changes (`view`) or the panel resizes - NOT on scroll
  // (the window position rides `viewportTop`, updated cheaply in onScroll).
  const measureGeometry = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    const cRect = container.getBoundingClientRect();
    const rows: MiniMapRowInput[] = [];
    container.querySelectorAll<HTMLElement>('[data-slot-key]').forEach((el) => {
      const key = el.dataset.slotKey;
      if (!key) return;
      const r = el.getBoundingClientRect();
      const meta = slotMetaByKey.get(key);
      rows.push({
        key,
        top: r.top - cRect.top + container.scrollTop,
        height: r.height,
        filled: meta?.filled ?? false,
        confidence: meta?.confidence ?? null,
      });
    });
    setGeometry({
      contentHeight: container.scrollHeight,
      viewportHeight: container.clientHeight,
      rows,
    });
    setViewportTop(container.scrollTop);
  }, [slotMetaByKey]);

  useEffect(() => {
    if (!dataSlotMode) return;
    measureGeometry();
    const container = scrollRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measureGeometry());
    ro.observe(container);
    // Also watch the content wrapper: expanding a row (e.g. the "Why?" disclosure) grows the
    // scrollable content WITHOUT changing the container's own box, so observing only the container
    // would miss it and leave the minimap bars + window stale until the next refetch.
    if (contentRef.current) ro.observe(contentRef.current);
    return () => ro.disconnect();
  }, [dataSlotMode, view, measureGeometry]);

  const miniMap = useMemo(
    () =>
      computeMiniMapModel({
        contentHeight: geometry.contentHeight,
        viewportHeight: geometry.viewportHeight,
        viewportTop,
        rows: geometry.rows,
      }),
    [geometry, viewportTop]
  );
  const showMap = dataSlotMode && totalSlots > OVERVIEW_MIN_SLOTS && miniMap.overflow;

  const focusedKey = cursor !== null && newlyFilledKeys ? (newlyFilledKeys[cursor] ?? null) : null;
  const stepperRemaining =
    cursor !== null && newlyFilledKeys ? newlyFilledKeys.length - cursor - 1 : 0;

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
          {/* Quiet announcement of navigation jumps for screen readers. */}
          <p className="sr-only" role="status" aria-live="polite">
            {announce}
          </p>
          <div className="relative min-h-0 flex-1">
            <div
              ref={scrollRef}
              onScroll={(e) => setViewportTop(e.currentTarget.scrollTop)}
              className={cn('h-full overflow-y-auto px-3 py-3', showMap && 'pl-7')}
            >
              {view.dataSlotGroups !== undefined ? (
                groups.every((g) => g.slots.length === 0) ? (
                  <p className="text-muted-foreground px-1 py-4 text-sm">
                    As you chat, we’ll show what we’re learning here.
                  </p>
                ) : (
                  <div ref={contentRef} className="space-y-4">
                    {groups.map((group) => (
                      <section key={group.theme}>
                        <h3 className="text-muted-foreground mb-1.5 px-1 text-xs font-medium tracking-wide uppercase">
                          {group.theme}
                        </h3>
                        <ul className="space-y-2">
                          {group.slots.map((slot) => (
                            <DataSlotRow
                              key={slot.key}
                              slot={slot}
                              highlighted={highlightedKey === slot.key}
                              stepperRemaining={focusedKey === slot.key ? stepperRemaining : null}
                              onStepNext={stepNext}
                            />
                          ))}
                        </ul>
                      </section>
                    ))}
                  </div>
                )
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
            {showMap ? (
              <SlotMiniMap
                bars={miniMap.bars}
                windowTopPct={miniMap.windowTopPct}
                windowHeightPct={miniMap.windowHeightPct}
                newlyFilledKeys={newlyFilledKeys}
                onScrubToFraction={scrubToFraction}
                className="absolute top-3 bottom-3 left-2"
              />
            ) : null}
          </div>
        </>
      )}
    </aside>
  );
}
