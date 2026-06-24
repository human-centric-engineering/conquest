'use client';

/**
 * SlotMiniMap — a floating, vertical, scaled-down mirror of the data-slot scroll area (F7.8).
 *
 * Like the workflow-canvas minimap: one thin bar per slot (tinted by confidence band when filled, a
 * faint sliver when not), stacked in list order and sized proportional to the real rows, with a
 * "viewport window" rectangle showing what's currently on screen. Click or drag anywhere on the
 * track to scrub the list to that position; the window follows the list as it scrolls. Purely a
 * visual scroll aid (the real list + the after-turn stepper carry keyboard/SR navigation), so the
 * track is `aria-hidden`.
 *
 * Presentational: all geometry is precomputed by `computeMiniMapModel` and passed in as percentages.
 *
 * `// DEMO-ONLY (F7.2):` questionnaire-domain (data slots + confidence) — a non-questionnaire fork
 * strips this `panel/` directory.
 */

import { useRef } from 'react';

import { cn } from '@/lib/utils';
import { confidenceBandSolidBg } from '@/lib/app/questionnaire/panel/confidence';
import type { MiniMapBar } from '@/lib/app/questionnaire/panel/minimap';

export interface SlotMiniMapProps {
  bars: MiniMapBar[];
  /** The viewport window rectangle, as a percentage of the track. */
  windowTopPct: number;
  windowHeightPct: number;
  /**
   * Bars the most recent fill-turn captured — ringed and gently breathing (`cq-livedot`) so they
   * stay marked until a newer turn fills something.
   */
  recentlyFilledKeys?: ReadonlySet<string>;
  /** Scrub the list to a fraction [0,1] of the content. `smooth` for a discrete tap, not a drag. */
  onScrubToFraction: (fraction: number, smooth: boolean) => void;
  className?: string;
}

export function SlotMiniMap({
  bars,
  windowTopPct,
  windowHeightPct,
  recentlyFilledKeys,
  onScrubToFraction,
  className,
}: SlotMiniMapProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const fractionFromY = (clientY: number): number => {
    const el = trackRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    if (rect.height === 0) return 0;
    return Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
  };

  return (
    <div
      ref={trackRef}
      data-testid="slot-minimap"
      aria-hidden="true"
      onPointerDown={(e) => {
        draggingRef.current = true;
        if (e.currentTarget.setPointerCapture) {
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            // jsdom / unsupported — capture is a nicety, dragging still works without it.
          }
        }
        onScrubToFraction(fractionFromY(e.clientY), true);
      }}
      onPointerMove={(e) => {
        if (draggingRef.current) onScrubToFraction(fractionFromY(e.clientY), false);
      }}
      onPointerUp={(e) => {
        draggingRef.current = false;
        if (e.currentTarget.releasePointerCapture) {
          try {
            e.currentTarget.releasePointerCapture(e.pointerId);
          } catch {
            // no-op
          }
        }
      }}
      onPointerCancel={() => {
        draggingRef.current = false;
      }}
      className={cn(
        'bg-card/70 supports-[backdrop-filter]:bg-card/50 relative w-5 cursor-grab touch-none rounded-md border shadow-sm backdrop-blur-sm active:cursor-grabbing',
        className
      )}
    >
      {bars.map((bar) => (
        <div
          key={bar.key}
          data-bar-key={bar.key}
          style={{ top: `${bar.topPct}%`, height: `${bar.heightPct}%` }}
          className={cn(
            'absolute inset-x-0.5 rounded-[2px]',
            bar.filled ? confidenceBandSolidBg(bar.band) : 'bg-muted-foreground/15',
            // Previous-turn bars stay ringed and gently breathe until a newer turn fills something.
            recentlyFilledKeys?.has(bar.key) && 'ring-primary cq-livedot ring-1'
          )}
        />
      ))}
      {/* The viewport window — what's currently visible, and the draggable thumb now that the
          minimap stands in for the native scrollbar. A shaded grey fill (translucent, so the
          confidence bars read through it) plus a centred grip make it an obvious grab target. */}
      <div
        data-testid="slot-minimap-window"
        style={{ top: `${windowTopPct}%`, height: `${windowHeightPct}%` }}
        className="border-foreground/25 bg-muted-foreground/25 pointer-events-none absolute inset-x-0 flex items-center justify-center overflow-hidden rounded-sm border shadow-sm"
      >
        <span aria-hidden="true" className="flex flex-col items-center gap-[3px]">
          <span className="bg-foreground/40 h-px w-2 rounded-full" />
          <span className="bg-foreground/40 h-px w-2 rounded-full" />
          <span className="bg-foreground/40 h-px w-2 rounded-full" />
        </span>
      </div>
    </div>
  );
}
