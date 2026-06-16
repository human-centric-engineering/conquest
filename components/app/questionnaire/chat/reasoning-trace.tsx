'use client';

/**
 * ReasoningTrace — the live "watch it think" feed in the respondent chat (demo feature).
 *
 * Renders the per-turn {@link ReasoningStep}[] the `/messages` route streams (and persists). It is
 * the single clearest "this is an agent, not a form" signal: the respondent sees what the agent
 * captured (with how it read it + how sure it is), any contradiction it noticed, and *why* it asks
 * the next question.
 *
 * Two variants, chosen by the version's placement setting:
 *  - `live` — shown WHILE the turn streams, in place of the plain thinking dots: a titled feed whose
 *    rows rise in one-by-one (staggered `cq-rise`) so the reasoning visibly assembles.
 *  - `collapsed` — shown on a SETTLED turn: a compact "Reasoning · N" chip that expands to the same
 *    rows. Used for both placements' turn history (overlay collapses to it; inline is only this).
 *
 * Presentational only — the steps are decided server-side and respondent-safe by construction
 * (no abuse / sensitivity content; see `lib/app/questionnaire/reasoning`). Brand colour comes from
 * the page's `BrandThemeProvider` CSS vars, matching the chat's accent dot + contradiction notice.
 *
 * `// DEMO-ONLY:` questionnaire-domain surface for the sales demo.
 */

import { useState } from 'react';
import {
  ArrowRight,
  Brain,
  ChevronDown,
  GitCompareArrows,
  ListChecks,
  RefreshCw,
  Sparkles,
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
function StepRow({
  step,
  animate,
  index,
}: {
  step: ReasoningStep;
  animate: boolean;
  index: number;
}) {
  const Icon = STEP_ICONS[step.kind];
  // Tone tints the glyph: insight = brand accent, caution = amber, neutral = muted.
  const glyphColor =
    step.tone === 'insight'
      ? ACCENT
      : step.tone === 'caution'
        ? 'var(--color-amber-600, #d97706)'
        : 'var(--color-muted-foreground)';
  return (
    <li
      className={cn('flex items-start gap-2.5', animate && 'cq-rise')}
      style={animate ? { animationDelay: `${index * 110}ms` } : undefined}
    >
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

export interface ReasoningTraceProps {
  steps: ReasoningStep[];
  /** `live` (streaming, animated, always open) vs `collapsed` (settled turn, toggle to open). */
  variant: 'live' | 'collapsed';
  className?: string;
}

export function ReasoningTrace({ steps, variant, className }: ReasoningTraceProps) {
  // Collapsed turns start closed (the chip); live always renders open. A respondent can peek.
  const [open, setOpen] = useState(variant === 'live');
  if (steps.length === 0) return null;

  const list = (
    <ul className={cn('flex flex-col gap-2.5', variant === 'collapsed' && 'mt-2.5')}>
      {steps.map((step, i) => (
        <StepRow key={i} step={step} animate={variant === 'live'} index={i} />
      ))}
    </ul>
  );

  if (variant === 'collapsed') {
    return (
      <div className={cn(className)}>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 rounded-md text-xs font-medium transition-colors"
        >
          <Brain className="h-3.5 w-3.5" style={{ color: ACCENT }} aria-hidden="true" />
          <span>Reasoning · {steps.length}</span>
          <ChevronDown
            className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')}
            aria-hidden="true"
          />
        </button>
        {open && list}
      </div>
    );
  }

  // Live: a titled, brand-tinted panel that reads as the agent working in real time.
  return (
    <div
      role="status"
      aria-label="Agent reasoning"
      className={cn('rounded-xl border px-3.5 py-3', className)}
      style={{
        borderColor: `color-mix(in srgb, ${ACCENT} 30%, transparent)`,
        backgroundColor: `color-mix(in srgb, ${ACCENT} 5%, transparent)`,
      }}
    >
      <div className="mb-2.5 flex items-center gap-2">
        <Brain className="h-4 w-4" style={{ color: ACCENT }} aria-hidden="true" />
        <span className="text-foreground text-xs font-semibold tracking-wide">
          Working it through
        </span>
        <span className="ml-1 inline-flex gap-1" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="h-1 w-1 animate-bounce rounded-full"
              style={{ backgroundColor: ACCENT, animationDelay: `${i * 0.15}s` }}
            />
          ))}
        </span>
      </div>
      {list}
    </div>
  );
}
