/**
 * SlotMiniMap — floating vertical minimap: proportional bars, viewport window, click/drag to scrub.
 *
 * @see components/app/questionnaire/panel/slot-minimap.tsx
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { SlotMiniMap } from '@/components/app/questionnaire/panel/slot-minimap';
import type { MiniMapBar } from '@/lib/app/questionnaire/panel/minimap';

const bars: MiniMapBar[] = [
  { key: 'age', topPct: 0, heightPct: 20, filled: true, band: 'high' },
  { key: 'mood', topPct: 20, heightPct: 20, filled: true, band: 'moderate' },
  { key: 'goal', topPct: 40, heightPct: 20, filled: true, band: 'low' },
  { key: 'plans', topPct: 60, heightPct: 40, filled: false, band: 'unscored' },
];

function bar(key: string): HTMLElement {
  return document.querySelector(`[data-bar-key="${key}"]`) as HTMLElement;
}

afterEach(() => vi.restoreAllMocks());

describe('SlotMiniMap', () => {
  it('renders one bar per slot, positioned by percentage', () => {
    render(
      <SlotMiniMap bars={bars} windowTopPct={0} windowHeightPct={50} onScrubToFraction={vi.fn()} />
    );
    expect(document.querySelectorAll('[data-bar-key]')).toHaveLength(4);
    expect(bar('mood').style.top).toBe('20%');
    expect(bar('mood').style.height).toBe('20%');
  });

  it('tints filled bars by confidence band and renders unfilled ones faint', () => {
    render(
      <SlotMiniMap bars={bars} windowTopPct={0} windowHeightPct={50} onScrubToFraction={vi.fn()} />
    );
    expect(bar('age').className).toContain('emerald');
    expect(bar('mood').className).toContain('amber');
    expect(bar('goal').className).toContain('red');
    expect(bar('plans').className).toContain('bg-muted-foreground/15');
  });

  it('draws the viewport window at the given position', () => {
    render(
      <SlotMiniMap bars={bars} windowTopPct={30} windowHeightPct={25} onScrubToFraction={vi.fn()} />
    );
    const win = screen.getByTestId('slot-minimap-window');
    expect(win.style.top).toBe('30%');
    expect(win.style.height).toBe('25%');
  });

  it('rings and gently breathes a previous-turn bar (recentlyFilledKeys)', () => {
    render(
      <SlotMiniMap
        bars={bars}
        windowTopPct={0}
        windowHeightPct={50}
        recentlyFilledKeys={new Set(['goal'])}
        onScrubToFraction={vi.fn()}
      />
    );
    expect(bar('goal').className).toContain('ring-primary');
    expect(bar('goal').className).toContain('cq-livedot');
    expect(bar('age').className).not.toContain('ring-primary');
    expect(bar('age').className).not.toContain('cq-livedot');
  });

  it('scrubs to the clicked fraction of the track (smooth) on pointer down', () => {
    const onScrubToFraction = vi.fn();
    render(
      <SlotMiniMap
        bars={bars}
        windowTopPct={0}
        windowHeightPct={50}
        onScrubToFraction={onScrubToFraction}
      />
    );
    const track = screen.getByTestId('slot-minimap');
    // Track spans y=0..200; a click at y=50 is fraction 0.25.
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      height: 200,
      left: 0,
      right: 0,
      bottom: 200,
      width: 16,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    fireEvent.pointerDown(track, { clientY: 50, pointerId: 1 });
    expect(onScrubToFraction).toHaveBeenCalledWith(0.25, true);
  });

  it('scrubs continuously (not smooth) while dragging', () => {
    const onScrubToFraction = vi.fn();
    render(
      <SlotMiniMap
        bars={bars}
        windowTopPct={0}
        windowHeightPct={50}
        onScrubToFraction={onScrubToFraction}
      />
    );
    const track = screen.getByTestId('slot-minimap');
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      height: 200,
      left: 0,
      right: 0,
      bottom: 200,
      width: 16,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    fireEvent.pointerDown(track, { clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(track, { clientY: 100, pointerId: 1 });
    expect(onScrubToFraction).toHaveBeenLastCalledWith(0.5, false);
    // After release, moves no longer scrub.
    fireEvent.pointerUp(track, { clientY: 100, pointerId: 1 });
    onScrubToFraction.mockClear();
    fireEvent.pointerMove(track, { clientY: 200, pointerId: 1 });
    expect(onScrubToFraction).not.toHaveBeenCalled();
  });

  it('stops scrubbing when the pointer interaction is cancelled', () => {
    const onScrubToFraction = vi.fn();
    render(
      <SlotMiniMap
        bars={bars}
        windowTopPct={0}
        windowHeightPct={50}
        onScrubToFraction={onScrubToFraction}
      />
    );
    const track = screen.getByTestId('slot-minimap');
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      height: 200,
      left: 0,
      right: 0,
      bottom: 200,
      width: 16,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    fireEvent.pointerDown(track, { clientY: 0, pointerId: 1 });
    fireEvent.pointerCancel(track, { pointerId: 1 });
    onScrubToFraction.mockClear();
    fireEvent.pointerMove(track, { clientY: 100, pointerId: 1 });
    expect(onScrubToFraction).not.toHaveBeenCalled();
  });

  it('treats an unmeasured track (zero height) as fraction 0 and tolerates missing pointer capture', () => {
    const onScrubToFraction = vi.fn();
    render(
      <SlotMiniMap
        bars={bars}
        windowTopPct={0}
        windowHeightPct={50}
        onScrubToFraction={onScrubToFraction}
      />
    );
    const track = screen.getByTestId('slot-minimap');
    // No rect mock → jsdom returns a zero-height rect → fractionFromY short-circuits to 0.
    // Also remove pointer-capture support to exercise the capability guard.
    (track as unknown as { setPointerCapture?: unknown }).setPointerCapture = undefined;
    fireEvent.pointerDown(track, { clientY: 40, pointerId: 1 });
    expect(onScrubToFraction).toHaveBeenCalledWith(0, true);
  });
});
