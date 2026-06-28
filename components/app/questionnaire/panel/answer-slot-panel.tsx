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
import { HelpCircle } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

import { cn } from '@/lib/utils';
import { usePrefersReducedMotion } from '@/lib/hooks/use-prefers-reduced-motion';
import { AnswerSlotItem } from '@/components/app/questionnaire/panel/answer-slot-item';
import { ConfidenceIndicator } from '@/components/app/questionnaire/panel/confidence-indicator';
import { ConfidenceScore } from '@/components/app/questionnaire/panel/confidence-score';
import { NoticeWhy } from '@/components/app/questionnaire/chat/notice-why';
import { SlotMiniMap } from '@/components/app/questionnaire/panel/slot-minimap';
import { SlotBreadthMeter } from '@/components/app/questionnaire/panel/slot-breadth-meter';
import { SlotHistoryDialog } from '@/components/app/questionnaire/panel/slot-history-dialog';
import {
  panelSlotDomId,
  recentlyFilledByLatestTurn,
} from '@/lib/app/questionnaire/panel/newly-filled';
import { computeMiniMapModel, type MiniMapRowInput } from '@/lib/app/questionnaire/panel/minimap';
import type {
  AnswerPanelView,
  DataSlotPanelGroup,
  DataSlotPanelSlot,
  PanelSlotView,
} from '@/lib/app/questionnaire/panel/types';
import type { PanelCorrection } from '@/lib/app/questionnaire/panel/correction-targets';
import { InlineAnswerEditor } from '@/components/app/questionnaire/panel/inline-answer-editor';

/** How long a scrolled-to slot keeps its highlight ring (ms). */
const HIGHLIGHT_MS = 1500;

/**
 * What the captured-context panel is *for* — shown in full on the first turn (when nothing is
 * captured yet) and tucked behind a "How this works" disclosure thereafter. Names the mechanic the
 * respondent can't otherwise see: this conversation is quietly completing a questionnaire, so the
 * captured-context list is a by-product, not a to-do list whose length signals "almost done".
 */
const CONTEXT_EXPLAINER =
  'As the conversation continues, we’ll record a high-level summary below. We’ll also be filling out ' +
  'a questionnaire in the background. You’re encouraged to speak your mind and expand as much as you ' +
  'like so we can try to fill several questions from a single turn in the chat.';

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
  /**
   * Force-hide the native scrollbar on the scroll area even when the minimap isn't shown. The
   * mobile review drawer sets this: touch scrolling needs no visible bar, and a native scrollbar
   * would otherwise appear beside the minimap-governed list. Desktop leaves it off so question
   * mode (no minimap) keeps its native bar as the scroll affordance.
   */
  hideNativeScrollbar?: boolean;
  /**
   * Inline answer correction (Variant B): when provided, an "Edit" affordance on each answered row
   * opens the shared {@link InlineAnswerEditor} so the respondent can fix a captured answer in place.
   * `undefined` hides it (toggle off / read-only / blocked session).
   */
  correction?: PanelCorrection;
  className?: string;
}

function ProgressHeading({ view }: { view: AnswerPanelView }) {
  const dataSlotMode = view.dataSlotGroups !== undefined;
  // How many context slots we've actually captured. Deliberately NOT a "% complete" anymore: the
  // single completion figure lives in the labelled "Through the questionnaire" bar up top. Showing a
  // second percentage here invited the panel to read as "almost done" once a few slots filled, even
  // though questionnaire coverage was still low. A plain count describes what the panel holds without
  // competing with that bar.
  const capturedCount = dataSlotMode
    ? (view.dataSlotGroups ?? []).reduce((n, g) => n + g.slots.filter((s) => s.filled).length, 0)
    : view.answeredCount;
  // Total context areas (filled + still-open data slots) — the denominator the respondent sees in
  // data-slot mode ("12 of 35 context areas captured").
  const totalAreas = dataSlotMode
    ? (view.dataSlotGroups ?? []).reduce((n, g) => n + g.slots.length, 0)
    : view.totalCount;
  // Average confidence across all captured slots. Honest mean: a tangential/low-confidence fill drags
  // it down by design. Omitted until something scored has been captured.
  const avgConfidence =
    view.averageConfidence !== undefined ? Math.round(view.averageConfidence * 100) : null;
  let summary: string;
  if (dataSlotMode) {
    const base = `${capturedCount} of ${totalAreas} context areas captured`;
    summary = avgConfidence !== null ? `${base} with ${avgConfidence}% confidence` : base;
  } else {
    const completion =
      view.scope === 'answered_only'
        ? `${view.answeredCount} captured`
        : `${view.answeredCount} of ${view.totalCount} answered`;
    summary =
      avgConfidence !== null ? `${completion} · avg confidence ${avgConfidence}%` : completion;
  }
  return (
    <div className="border-b px-4 py-3">
      {/* Title row: the heading on the left, with the "How this works" explainer tucked into a compact
          top-right modal link so it never costs vertical space in the header. */}
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-sm font-semibold">
          {dataSlotMode ? 'Capturing your context' : 'Your answers'}
        </h2>
        {dataSlotMode ? <HowThisWorksDialog /> : null}
      </div>
      {(!dataSlotMode || capturedCount > 0) && (
        <p className="text-muted-foreground mt-0.5 text-xs tabular-nums">{summary}</p>
      )}
    </div>
  );
}

/** The "How this works" top-right link + modal — explains the background-capture mechanic on demand. */
function HowThisWorksDialog() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label="How this works"
          title="How this works"
          className="text-muted-foreground hover:text-foreground inline-flex shrink-0 items-center transition-colors"
        >
          <HelpCircle className="h-4 w-4" aria-hidden="true" />
        </button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>How this works</DialogTitle>
          <DialogDescription className="text-foreground/80 text-sm leading-relaxed">
            {CONTEXT_EXPLAINER}
          </DialogDescription>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  );
}

/** The "N more …" stepper footer copy — singular wording for the last hop. */
function moreRecordedLabel(remaining: number): string {
  return remaining === 1 ? '1 more slot was answered' : `${remaining} more answers recorded`;
}

/**
 * One data-slot row (Data Slots feature): the short name with an "Edited" pill in its top-right
 * corner (opens the answer's evolution), the agent's paraphrase, a confidence dot + score, an
 * "Inferred" marker, the breadth meter (how many mapped questions are answered — a count, distinct
 * from the confidence hue), and the inline "Why?" rationale disclosure. Carries the DOM anchor +
 * highlight + stepper footer the panel injects for after-turn navigation.
 */
function DataSlotRow({
  slot,
  highlighted,
  recentlyFilled,
  showSlotQuestions,
  stepperRemaining,
  onStepNext,
  collapseSignal,
  outOfView,
  correction,
}: {
  slot: DataSlotPanelSlot;
  highlighted: boolean;
  /** Filled/updated by the most recent fill-turn — gently pulses until a newer turn fills something. */
  recentlyFilled: boolean;
  /** Whether the breadth meter may itemise its mapped questions (presentationMode `both`). */
  showSlotQuestions: boolean;
  /** When non-null, render the "N more recorded" footer with this many slots still to come. */
  stepperRemaining: number | null;
  onStepNext: () => void;
  /** Bumped by the panel on refetch so this row's open disclosures collapse themselves. */
  collapseSignal: number;
  /** True once this row has scrolled fully out of view — collapses its open disclosures. */
  outOfView: boolean;
  /** Inline correction bundle (Variant B); when present + the slot has mapped questions, show "Edit". */
  correction?: PanelCorrection;
}) {
  const [editing, setEditing] = useState(false);
  // A data-slot fix edits the underlying mapped questions; reconciliation then recomputes the reading.
  // Built from the slot's coverage (populated when inline correction is on). No mapped questions → no Edit.
  const editableQuestions = slot.coverage.questions.map((q) => ({
    slot: { slotKey: q.key, prompt: q.label, type: q.type, typeConfig: q.typeConfig },
    initialValue: q.value,
  }));
  const canEdit = correction != null && editableQuestions.length > 0;
  return (
    <li
      id={panelSlotDomId(slot.key)}
      data-slot-key={slot.key}
      tabIndex={-1}
      className={cn(
        'rounded-md border px-3 py-2 transition-shadow duration-500 outline-none motion-reduce:transition-none',
        highlighted && 'ring-primary/60 ring-2',
        // Previous-turn highlight: a gentle, lasting accent wash (kept until a newer turn fills).
        recentlyFilled && 'cq-fill-glow'
      )}
    >
      <div className="flex items-start gap-2">
        <ConfidenceIndicator
          confidence={slot.confidence}
          solid
          className={cn('mt-1', recentlyFilled && 'cq-livedot')}
        />
        <div className="min-w-0 flex-1">
          {/* Name row carries the "Edited" pill in the top-right corner (above the answer text). The
              pill renders nothing unless the slot changed at least once; opens the full evolution
              (replaces the old inline strikethrough "Earlier:" list). */}
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1 text-sm font-medium">{slot.name}</p>
            {canEdit && !editing && (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="text-muted-foreground hover:text-foreground shrink-0 text-xs font-medium underline-offset-2 hover:underline"
              >
                Edit
              </button>
            )}
            <SlotHistoryDialog slot={slot} />
          </div>
          {editing && correction ? (
            <div className="mt-2">
              <InlineAnswerEditor
                questions={editableQuestions}
                sessionId={correction.sessionId}
                accessToken={correction.accessToken}
                onSaved={correction.onCorrected}
                onCancel={() => setEditing(false)}
              />
            </div>
          ) : slot.paraphrase ? (
            <>
              <p className="text-muted-foreground mt-0.5 text-sm">{slot.paraphrase}</p>
              {/* Confidence (label + raw % — the nuanced 30–100% range reads at a glance) and the
                  "Inferred" marker, with the "Why?" rationale disclosure flowing inline after them.
                  "Why?" explains the whole reading, so it's a row-level affordance here, not an
                  annotation on the confidence figure; its rationale still expands full-width below. */}
              <NoticeWhy
                detail={slot.rationale ?? undefined}
                className="mt-1"
                collapseSignal={collapseSignal}
                outOfView={outOfView}
              >
                <ConfidenceScore confidence={slot.confidence} />
                {slot.provenance === 'inferred' || slot.provenance === 'synthesised' ? (
                  <span
                    className="bg-muted text-muted-foreground inline-flex items-center rounded-full px-1.5 py-0.5 text-[11px] font-medium"
                    title="We didn't capture this directly — it's our reading of the conversation, not something you stated"
                  >
                    Inferred
                  </span>
                ) : null}
              </NoticeWhy>
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
      {/* Breadth lives in the card footer — full-width, flush to the bottom edge, separated by a
          hairline. It's a per-slot count (how many mapped questions are answered), distinct from the
          confidence dot's quality hue, so it reads as a footer summary rather than an inline note.
          Suppressed when the slot maps to no questions (the meter would render nothing). */}
      {slot.coverage.total > 0 ? (
        <div className="border-border/60 bg-muted/20 -mx-3 mt-2 -mb-2 rounded-b-md border-t">
          <SlotBreadthMeter
            coverage={slot.coverage}
            expandable={showSlotQuestions}
            collapseSignal={collapseSignal}
            outOfView={outOfView}
          />
        </div>
      ) : null}
    </li>
  );
}

export function AnswerSlotPanel({
  view,
  loading = false,
  onRevisit,
  canRevisit = false,
  newlyFilledKeys,
  hideNativeScrollbar = false,
  correction,
  className,
}: AnswerSlotPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prefersReducedMotion = usePrefersReducedMotion();

  const [highlightedKey, setHighlightedKey] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');
  // Monotonic "collapse open disclosures" signal. Bumped when the respondent scrolls the list or the
  // view refetches, so any open "Why?" rationale / questions footer closes itself rather than lingering
  // over content it no longer lines up with. Threaded down to each row's disclosures.
  const [collapseSignal, setCollapseSignal] = useState(0);
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

  // Slot key -> name (aria-live announcement) and -> fill state (minimap bar colour).
  const slotMetaByKey = useMemo(() => {
    const map = new Map<string, { name: string; filled: boolean; confidence: number | null }>();
    for (const g of groups)
      for (const s of g.slots)
        map.set(s.key, { name: s.name, filled: s.filled, confidence: s.confidence });
    return map;
  }, [groups]);

  // Slots the MOST RECENT fill-turn captured — gently pulse in both the list and the minimap until a
  // newer turn fills something (so the highlight persists "even after it has been viewed"). This is
  // decoupled from `newlyFilledKeys` (which drives the one-shot stepper and clears on a no-fill turn).
  const recentlyFilledSet = useMemo(
    () =>
      recentlyFilledByLatestTurn(
        groups.flatMap((g) =>
          g.slots.map((s) => ({ key: s.key, answeredAtTurnIndex: s.answeredAtTurnIndex }))
        )
      ),
    [groups]
  );

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

  // A refetch (the workspace hands a fresh view after each settled turn) collapses any open
  // disclosure: the rationale/coverage behind it may have changed, so close rather than leave a stale
  // panel hanging open. Scroll-driven collapses are per-row instead (a row closes once it scrolls out
  // of view — see `outOfViewKeys`), not a blanket close on every scroll.
  useEffect(() => {
    setCollapseSignal((s) => s + 1);
  }, [view]);

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
  // The minimap is the scroll affordance, so show it whenever the list actually overflows —
  // regardless of slot count. (A small questionnaire like a few-slot survey overflows too, and
  // with native scrollbars suppressed it would otherwise have no scroll cue at all.)
  const showMap = dataSlotMode && miniMap.overflow;

  // Keys of slots whose row has scrolled fully out of the visible window — used to collapse a row's
  // open "Why?" / questions disclosure once you've scrolled past it, rather than on the first pixel of
  // scroll. A row counts as out only when it's entirely above or entirely below the viewport, so a
  // disclosure stays open while any part of its row is still in the focus window. Empty until geometry
  // is measured (the rows carry content-space tops/heights; `viewportTop` is the live scroll offset).
  const outOfViewKeys = useMemo(() => {
    const out = new Set<string>();
    const viewTop = viewportTop;
    const viewBottom = viewportTop + geometry.viewportHeight;
    // No measured viewport (pre-measure / hidden) → treat nothing as out, so we never close blindly.
    if (geometry.viewportHeight === 0) return out;
    for (const row of geometry.rows) {
      const rowBottom = row.top + row.height;
      if (rowBottom <= viewTop || row.top >= viewBottom) out.add(row.key);
    }
    return out;
  }, [geometry, viewportTop]);

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
          <div className="group/scroll relative min-h-0 flex-1">
            <div
              ref={scrollRef}
              onScroll={(e) => {
                // Just track the offset. An open "Why?" / questions disclosure no longer closes on the
                // first pixel of scroll — it collapses only once its row scrolls fully out of view (see
                // `outOfViewKeys` / the `outOfView` prop), so a small nudge leaves it open.
                setViewportTop(e.currentTarget.scrollTop);
              }}
              className={cn(
                'h-full overflow-y-auto px-3 py-3',
                // When the minimap shows it becomes the scroll affordance: clear room for it on the
                // right and hide the native bar so the two don't overlap on classic Windows scrollbars.
                showMap && 'cq-no-scrollbar pr-8',
                // In the drawer (touch), suppress the native bar even without a minimap.
                hideNativeScrollbar && !showMap && 'cq-no-scrollbar'
              )}
            >
              {view.dataSlotGroups !== undefined ? (
                groups.every((g) => g.slots.length === 0) ? (
                  <p className="text-muted-foreground px-1 py-4 text-sm">
                    As you chat, the context we capture will appear here.
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
                              recentlyFilled={recentlyFilledSet.has(slot.key)}
                              showSlotQuestions={view.showSlotQuestions ?? false}
                              stepperRemaining={focusedKey === slot.key ? stepperRemaining : null}
                              onStepNext={stepNext}
                              collapseSignal={collapseSignal}
                              outOfView={outOfViewKeys.has(slot.key)}
                              correction={correction}
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
                            correction={correction}
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
                recentlyFilledKeys={recentlyFilledSet}
                onScrubToFraction={scrubToFraction}
                className="absolute top-3 right-2 bottom-3"
              />
            ) : null}
          </div>
        </>
      )}
    </aside>
  );
}
