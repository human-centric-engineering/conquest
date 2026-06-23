/**
 * minimap — pure projection of measured scroll geometry into the data-slot minimap model.
 *
 * @see lib/app/questionnaire/panel/minimap.ts
 */

import { describe, it, expect } from 'vitest';

import { computeMiniMapModel, type MiniMapRowInput } from '@/lib/app/questionnaire/panel/minimap';

function row(over: Partial<MiniMapRowInput> & { key: string }): MiniMapRowInput {
  return { top: 0, height: 100, filled: false, confidence: null, ...over };
}

describe('computeMiniMapModel', () => {
  it('reports no overflow when the content fits the viewport', () => {
    const m = computeMiniMapModel({
      contentHeight: 300,
      viewportHeight: 300,
      viewportTop: 0,
      rows: [row({ key: 'a' })],
    });
    expect(m.overflow).toBe(false);
  });

  it('reports overflow when the content is taller than the viewport', () => {
    const m = computeMiniMapModel({
      contentHeight: 1000,
      viewportHeight: 300,
      viewportTop: 0,
      rows: [],
    });
    expect(m.overflow).toBe(true);
  });

  it('positions bars and the viewport window as percentages of the content height', () => {
    const m = computeMiniMapModel({
      contentHeight: 1000,
      viewportHeight: 250,
      viewportTop: 500,
      rows: [row({ key: 'a', top: 0, height: 200 }), row({ key: 'b', top: 200, height: 300 })],
    });
    expect(m.bars[0]).toMatchObject({ key: 'a', topPct: 0, heightPct: 20 });
    expect(m.bars[1]).toMatchObject({ key: 'b', topPct: 20, heightPct: 30 });
    // Window: scrollTop 500/1000 = 50% down, clientHeight 250/1000 = 25% tall.
    expect(m.windowTopPct).toBe(50);
    expect(m.windowHeightPct).toBe(25);
  });

  it('assigns a confidence band to filled bars and unscored to unfilled ones', () => {
    const m = computeMiniMapModel({
      contentHeight: 1000,
      viewportHeight: 300,
      viewportTop: 0,
      rows: [
        row({ key: 'hi', filled: true, confidence: 0.95 }),
        row({ key: 'lo', filled: true, confidence: 0.3 }),
        row({ key: 'empty', filled: false, confidence: null }),
      ],
    });
    expect(m.bars.find((b) => b.key === 'hi')).toMatchObject({ filled: true, band: 'high' });
    expect(m.bars.find((b) => b.key === 'lo')).toMatchObject({ filled: true, band: 'low' });
    expect(m.bars.find((b) => b.key === 'empty')).toMatchObject({
      filled: false,
      band: 'unscored',
    });
  });

  it('floors a tiny row to a visible minimum bar height', () => {
    const m = computeMiniMapModel({
      contentHeight: 10000,
      viewportHeight: 300,
      viewportTop: 0,
      rows: [row({ key: 'tiny', top: 0, height: 20 })], // 0.2% → floored to 1.5%
    });
    expect(m.bars[0].heightPct).toBe(1.5);
  });

  it('clamps and zeroes safely when content height is zero (unmeasured)', () => {
    const m = computeMiniMapModel({
      contentHeight: 0,
      viewportHeight: 0,
      viewportTop: 0,
      rows: [row({ key: 'a', top: 50, height: 100 })],
    });
    expect(m.overflow).toBe(false);
    expect(m.bars[0].topPct).toBe(0);
    expect(m.windowTopPct).toBe(0);
    expect(m.windowHeightPct).toBe(0);
  });

  it('clamps a window that would exceed the track to 100%', () => {
    const m = computeMiniMapModel({
      contentHeight: 400,
      viewportHeight: 600, // viewport taller than content (no overflow) → window clamps to 100%
      viewportTop: 0,
      rows: [],
    });
    expect(m.windowHeightPct).toBe(100);
  });
});
