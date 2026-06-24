/**
 * Pure geometry model for the data-slot minimap (F7.8).
 *
 * A scaled-down vertical mirror of the answer-panel scroll area: one bar per slot, positioned and
 * sized proportional to the real rows, plus a "viewport window" rectangle showing what's on screen.
 * The panel measures the live DOM (scroll height, row rects) and hands the raw pixel metrics here;
 * this turns them into percentage-of-track positions the `SlotMiniMap` renders. Kept pure (no DOM,
 * no React) so the proportional maths is unit-testable in isolation.
 */

import { confidenceBand, type ConfidenceBand } from '@/lib/app/questionnaire/panel/confidence';

/** One measured slot row, in scroll-content pixel space. */
export interface MiniMapRowInput {
  key: string;
  /** Row top relative to the top of the scroll content, px. */
  top: number;
  /** Row height, px. */
  height: number;
  filled: boolean;
  confidence: number | null;
}

export interface MiniMapMetrics {
  /** Full scrollable content height (`scrollHeight`), px. */
  contentHeight: number;
  /** Visible height (`clientHeight`), px. */
  viewportHeight: number;
  /** Current scroll offset (`scrollTop`), px. */
  viewportTop: number;
  rows: MiniMapRowInput[];
}

/** One bar in the minimap, positioned as a percentage of the track height. */
export interface MiniMapBar {
  key: string;
  topPct: number;
  heightPct: number;
  filled: boolean;
  /** Confidence band of a filled slot; `unscored` for an unfilled one. */
  band: ConfidenceBand;
}

export interface MiniMapModel {
  /** True only when the content actually overflows the viewport — otherwise a minimap is pointless. */
  overflow: boolean;
  bars: MiniMapBar[];
  /** The viewport window rectangle, as a percentage of the track. */
  windowTopPct: number;
  windowHeightPct: number;
}

/** Floor so a single-line row still shows as a visible sliver in the mini track. */
const MIN_BAR_PCT = 1.5;

function clampPct(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(100, Math.max(0, v));
}

/** Project measured pixel geometry into a percentage-based minimap model. */
export function computeMiniMapModel(m: MiniMapMetrics): MiniMapModel {
  const { contentHeight, viewportHeight, viewportTop, rows } = m;
  const overflow = contentHeight > 0 && contentHeight > viewportHeight + 1;
  const pct = (v: number) => (contentHeight > 0 ? clampPct((v / contentHeight) * 100) : 0);
  const bars: MiniMapBar[] = rows.map((r) => ({
    key: r.key,
    topPct: pct(r.top),
    heightPct: Math.max(pct(r.height), MIN_BAR_PCT),
    filled: r.filled,
    band: r.filled ? confidenceBand(r.confidence) : 'unscored',
  }));
  return {
    overflow,
    bars,
    windowTopPct: pct(viewportTop),
    windowHeightPct: clampPct(contentHeight > 0 ? (viewportHeight / contentHeight) * 100 : 0),
  };
}
