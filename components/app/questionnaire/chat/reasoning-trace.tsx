'use client';

/**
 * ReasoningTrace — the per-turn "watch it think" disclosure in the respondent chat (demo feature).
 *
 * Renders the {@link ReasoningStep}[] the `/messages` route emits (and persists). It is the single
 * clearest "this is an agent, not a form" signal: the respondent sees what the agent captured (with
 * how it read it + how sure it is), any contradiction it noticed, and *why* it asks the next question.
 *
 * Always a compact "Reasoning · N" chip that expands to the rows; the expand/collapse is animated.
 * The version's placement setting drives only how it *starts*:
 *  - "Animated" (`overlay`) passes `autoReveal` on the NEWEST turn, so it mounts open and then
 *    animates closed after {@link AUTO_REVEAL_DWELL_MS} — a glimpse of the reasoning before it tucks
 *    away. Historical / older turns mount closed.
 *  - "Inline" never passes `autoReveal`: every turn mounts closed and opens only on a click.
 *
 * Presentational only — the steps are decided server-side and respondent-safe by construction
 * (no abuse / sensitivity content; see `lib/app/questionnaire/reasoning`). Brand colour comes from
 * the page's `BrandThemeProvider` CSS vars, matching the chat's accent dot + contradiction notice.
 *
 * `// DEMO-ONLY:` questionnaire-domain surface for the sales demo.
 */

import { useEffect, useId, useState } from 'react';
import {
  Brain,
  ChevronDown,
  GitCompareArrows,
  ListChecks,
  RefreshCw,
  Sparkles,
  ArrowRight,
  type LucideIcon,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import type { ReasoningStep, ReasoningStepKind } from '@/lib/app/questionnaire/reasoning';
import { confidenceBand } from '@/lib/app/questionnaire/panel/confidence';

const STEP_ICONS: Record<ReasoningStepKind, LucideIcon> = {
  extraction: Sparkles,
  contradiction: GitCompareArrows,
  refinement: RefreshCw,
  completion: ListChecks,
  selection: ArrowRight,
};

const ACCENT = 'var(--app-accent-color, var(--color-primary))';

/**
 * A "signal-strength" confidence pip — 1–3 filled bars for low / moderate / high. Compact +
 * glanceable. Bands and thresholds come from the canonical {@link confidenceBand} so the trace
 * agrees with the answer panel's confidence chip (no per-surface threshold drift).
 */
function ConfidencePips({ confidence }: { confidence: number }) {
  const band = confidenceBand(confidence);
  const level = band === 'high' ? 3 : band === 'moderate' ? 2 : 1;
  return (
    <span
      className="ml-auto inline-flex shrink-0 items-end gap-0.5"
      title={`${band} confidence`}
      aria-label={`${band} confidence`}
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="w-0.5 rounded-full"
          style={{
            height: `${4 + i * 2}px`,
            backgroundColor: i < level ? ACCENT : 'var(--color-border)',
            opacity: i < level ? 1 : 0.6,
          }}
        />
      ))}
    </span>
  );
}

/** One reasoning row: glyph, headline, optional detail / source quote, optional confidence pips. */
function StepRow({ step }: { step: ReasoningStep }) {
  const Icon = STEP_ICONS[step.kind];
  // Tone tints the glyph: insight = brand accent, caution = amber, neutral = muted.
  const glyphColor =
    step.tone === 'insight'
      ? ACCENT
      : step.tone === 'caution'
        ? 'var(--color-amber-600, #d97706)'
        : 'var(--color-muted-foreground)';
  return (
    <li className="flex items-start gap-2.5">
      <span
        aria-hidden="true"
        className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md"
        style={{
          backgroundColor: `color-mix(in srgb, ${glyphColor} 12%, transparent)`,
          color: glyphColor,
        }}
      >
        <Icon className="h-3 w-3" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-foreground text-xs font-medium">{step.label}</span>
          {typeof step.confidence === 'number' && <ConfidencePips confidence={step.confidence} />}
        </div>
        {step.detail && (
          <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">{step.detail}</p>
        )}
        {step.rationale && (
          <p className="text-muted-foreground/80 mt-0.5 text-[11px] leading-relaxed italic">
            {step.rationale}
          </p>
        )}
        {step.sourceQuote && (
          <p
            className="text-muted-foreground/90 mt-1 border-l-2 pl-2 text-xs italic"
            style={{ borderColor: `color-mix(in srgb, ${ACCENT} 35%, transparent)` }}
          >
            “{step.sourceQuote}”
          </p>
        )}
      </div>
    </li>
  );
}

/** Default base dwell (ms) the "Animated" placement holds a trace of up to two steps open. */
export const AUTO_REVEAL_DWELL_MS = 2000;

/** Default extra dwell (ms) added per reasoning step beyond the second. */
export const AUTO_REVEAL_PER_ITEM_MS = 750;

/** Step count up to which the base dwell applies; each step beyond adds the per-item dwell. */
export const AUTO_REVEAL_ITEM_THRESHOLD = 2;

/**
 * Duration of the grid-rows collapse animation. Single-sourced into the inline transition so the
 * chat surface can wait for the trace to finish tucking away before it types the next question in
 * (see `questionnaire-chat.tsx`). Keep in sync with the easing class on the content wrapper.
 */
export const AUTO_REVEAL_COLLAPSE_MS = 300;

/**
 * Dwell (ms) for a trace of `stepCount` steps: the base dwell for up to {@link
 * AUTO_REVEAL_ITEM_THRESHOLD} steps, plus `perItemMs` for each step beyond — so a longer summary
 * stays open long enough to read. `baseMs`/`perItemMs` come from the version config (admin-tunable).
 */
export function computeReasoningDwellMs(
  stepCount: number,
  baseMs: number = AUTO_REVEAL_DWELL_MS,
  perItemMs: number = AUTO_REVEAL_PER_ITEM_MS
): number {
  return baseMs + Math.max(0, stepCount - AUTO_REVEAL_ITEM_THRESHOLD) * perItemMs;
}

export interface ReasoningTraceProps {
  steps: ReasoningStep[];
  /**
   * When true (the "Animated" placement, newest turn only), the trace mounts OPEN and animates
   * itself closed after {@link dwellMs}. When false/omitted, it mounts closed and opens only when
   * the respondent clicks the chip.
   */
  autoReveal?: boolean;
  /** How long (ms) to stay open before auto-collapsing under `autoReveal`. Default base dwell. */
  dwellMs?: number;
  className?: string;
}

export function ReasoningTrace({
  steps,
  autoReveal = false,
  dwellMs = AUTO_REVEAL_DWELL_MS,
  className,
}: ReasoningTraceProps) {
  const [open, setOpen] = useState(autoReveal);
  const contentId = useId();

  // "Animated" placement: hold the newest turn's trace open for a beat, then tuck it away with the
  // same animated collapse a manual toggle uses. One-shot on mount — a later prop change (this turn
  // ceasing to be the newest) must not re-open it, and the respondent can still re-open by click.
  useEffect(() => {
    if (!autoReveal) return;
    const t = setTimeout(() => setOpen(false), dwellMs);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only; `autoReveal`/`dwellMs` fixed per turn
  }, []);

  if (steps.length === 0) return null;

  return (
    <div className={cn(className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={contentId}
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 rounded-md text-xs font-medium transition-colors"
      >
        <Brain className="h-3.5 w-3.5" style={{ color: ACCENT }} aria-hidden="true" />
        <span>Reasoning · {steps.length}</span>
        <ChevronDown
          className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')}
          aria-hidden="true"
        />
      </button>
      {/* Animated open/close: the grid-rows 0fr↔1fr trick collapses smoothly with dynamic-height
          content (no fixed max-height guess). The inner wrapper clips the rows mid-transition.
          `motion-reduce` honours a respondent's reduced-motion preference. The rows stay mounted so
          the collapse can animate, so `aria-hidden`/`inert` mirror the visual state — without them a
          screen reader would read every step while the chip still reports `aria-expanded="false"`. */}
      <div
        className="grid transition-[grid-template-rows] ease-out motion-reduce:transition-none"
        style={{
          gridTemplateRows: open ? '1fr' : '0fr',
          transitionDuration: `${AUTO_REVEAL_COLLAPSE_MS}ms`,
        }}
      >
        <div id={contentId} className="overflow-hidden" aria-hidden={!open} inert={!open}>
          <ul className="mt-2.5 flex flex-col gap-2.5">
            {steps.map((step, i) => (
              <StepRow key={i} step={step} />
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
