/**
 * QR matrix helpers — geometry and encoding invariants.
 *
 * These tests deliberately avoid asserting against a golden module bitmap. A QR symbol's
 * exact contents depend on the encoder's mask-pattern choice, so a hardcoded matrix would
 * pin us to one `qrcode` version rather than to correct behaviour. Instead they assert the
 * structural properties a scanner actually relies on (spec-mandated sizing, finder patterns,
 * quiet zone) and prove the SVG path is a faithful re-encoding of the matrix.
 */

import { describe, expect, it } from 'vitest';

import {
  QR_LOGO_INSET_RATIO,
  QR_LOGO_MARK_RADIUS_FACTOR,
  QR_LOGO_RATIO,
  QR_QUIET_ZONE,
  createQrMatrix,
  isDarkModule,
  qrDisplaySize,
  qrFileStem,
  qrLogoMarkRect,
  qrLogoRect,
  qrPathData,
} from '@/lib/app/qr/qr-matrix';

const URL_UNDER_TEST = 'https://conquest.example.com/q/clx1234567890abcdef';

/**
 * Re-render a path built by `qrPathData` back into a boolean grid, so we can compare it
 * against the matrix it came from. Only handles the `M{x} {y}h{w}v1h-{w}z` runs that
 * `qrPathData` emits.
 */
function rasterisePath(path: string, span: number): boolean[][] {
  const grid = Array.from({ length: span }, () => new Array<boolean>(span).fill(false));
  const runs = path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g);

  for (const [, xRaw, yRaw, widthRaw] of runs) {
    const x = Number(xRaw);
    const y = Number(yRaw);
    for (let i = 0; i < Number(widthRaw); i += 1) grid[y][x + i] = true;
  }

  return grid;
}

describe('createQrMatrix', () => {
  it('produces a spec-legal symbol size for the encoded text', () => {
    const matrix = createQrMatrix(URL_UNDER_TEST);

    // QR versions run 21, 25, 29... — always 21 + 4n.
    expect((matrix.size - 21) % 4).toBe(0);
    expect(matrix.size).toBeGreaterThanOrEqual(21);
    expect(matrix.dark).toHaveLength(matrix.size * matrix.size);
  });

  it('spans the symbol plus a quiet zone on both edges', () => {
    const matrix = createQrMatrix(URL_UNDER_TEST);

    expect(matrix.span).toBe(matrix.size + QR_QUIET_ZONE * 2);
  });

  it('places complete finder patterns in the three positioning corners', () => {
    const matrix = createQrMatrix(URL_UNDER_TEST);
    const last = matrix.size - 7;

    // The full spec shape: 7x7 dark border, light ring, dark 3x3 core. Asserting the whole
    // grid rather than spot-checking corners — a scrambled pattern that happened to leave
    // three probe coordinates intact would otherwise pass.
    const FINDER = ['#######', '#.....#', '#.###.#', '#.###.#', '#.###.#', '#.....#', '#######'];

    for (const [rowOffset, colOffset] of [
      [0, 0],
      [0, last],
      [last, 0],
    ]) {
      const actual = FINDER.map((_, row) =>
        FINDER[row]
          .split('')
          .map((_, col) => (isDarkModule(matrix, rowOffset + row, colOffset + col) ? '#' : '.'))
          .join('')
      );
      expect(actual).toEqual(FINDER);
    }

    // The fourth corner holds no finder — that asymmetry is how scanners find orientation.
    expect(isDarkModule(matrix, last + 3, last + 3)).toBe(false);
  });

  it('encodes different text into different symbols', () => {
    const a = createQrMatrix('https://example.com/a');
    const b = createQrMatrix('https://example.com/b');

    expect(a.dark).not.toEqual(b.dark);
  });

  it('rejects empty text rather than emitting an unscannable symbol', () => {
    expect(() => createQrMatrix('')).toThrow(/non-empty/);
  });
});

describe('isDarkModule', () => {
  it('reads out-of-range coordinates as light', () => {
    const matrix = createQrMatrix(URL_UNDER_TEST);

    expect(isDarkModule(matrix, -1, 0)).toBe(false);
    expect(isDarkModule(matrix, 0, -1)).toBe(false);
    expect(isDarkModule(matrix, matrix.size, 0)).toBe(false);
    expect(isDarkModule(matrix, 0, matrix.size)).toBe(false);
  });
});

describe('qrPathData', () => {
  it('reproduces every dark module, and no light one, at the quiet-zone offset', () => {
    const matrix = createQrMatrix(URL_UNDER_TEST);
    const grid = rasterisePath(qrPathData(matrix), matrix.span);

    for (let row = 0; row < matrix.size; row += 1) {
      for (let col = 0; col < matrix.size; col += 1) {
        expect(grid[row + QR_QUIET_ZONE][col + QR_QUIET_ZONE]).toBe(isDarkModule(matrix, row, col));
      }
    }
  });

  it('leaves the quiet zone entirely clear', () => {
    const matrix = createQrMatrix(URL_UNDER_TEST);
    const grid = rasterisePath(qrPathData(matrix), matrix.span);

    for (let i = 0; i < matrix.span; i += 1) {
      for (let edge = 0; edge < QR_QUIET_ZONE; edge += 1) {
        expect(grid[edge][i]).toBe(false);
        expect(grid[matrix.span - 1 - edge][i]).toBe(false);
        expect(grid[i][edge]).toBe(false);
        expect(grid[i][matrix.span - 1 - edge]).toBe(false);
      }
    }
  });

  it('merges horizontally adjacent modules into single runs', () => {
    const matrix = createQrMatrix(URL_UNDER_TEST);
    const path = qrPathData(matrix);

    const runCount = [...path.matchAll(/M/g)].length;
    const darkCount = matrix.dark.filter(Boolean).length;

    // Finder patterns alone guarantee 7-wide runs, so merging must beat one-rect-per-module.
    expect(runCount).toBeLessThan(darkCount);
    expect(path).toMatch(/h[2-9]/);
  });
});

describe('qrLogoRect', () => {
  it('centres the plate within the drawing', () => {
    const matrix = createQrMatrix(URL_UNDER_TEST);
    const { x, y, side } = qrLogoRect(matrix);

    expect(x).toBeCloseTo(y);
    expect(x + side / 2).toBeCloseTo(matrix.span / 2);
  });

  it('covers a fraction of the symbol that level-H error correction can absorb', () => {
    const matrix = createQrMatrix(URL_UNDER_TEST);
    const { side } = qrLogoRect(matrix);

    // Level H recovers ~30% of codewords. The plate's *area* share — the square of the
    // side ratio — is what has to stay under that budget.
    const LEVEL_H_RECOVERY = 0.3;
    const areaShare = (side * side) / (matrix.span * matrix.span);
    expect(areaShare).toBeLessThan(LEVEL_H_RECOVERY);

    // Pin the constant itself too, so a bump to QR_LOGO_RATIO is a deliberate edit here
    // rather than a silent slide toward the budget ceiling.
    expect(side / matrix.span).toBeCloseTo(QR_LOGO_RATIO);
    expect(QR_LOGO_RATIO ** 2).toBeLessThan(LEVEL_H_RECOVERY / 2);
  });
});

describe('qrLogoMarkRect', () => {
  it('sits concentrically inside the plate with a visible white border', () => {
    const matrix = createQrMatrix(URL_UNDER_TEST);
    const plate = qrLogoRect(matrix);
    const mark = qrLogoMarkRect(matrix);

    expect(mark.side).toBeLessThan(plate.side);
    expect(mark.x).toBeGreaterThan(plate.x);
    expect(mark.x + mark.side).toBeLessThan(plate.x + plate.side);
    // Same centre — an off-centre mark reads as a rendering bug, not a logo.
    expect(mark.x + mark.side / 2).toBeCloseTo(plate.x + plate.side / 2);
    expect(mark.y + mark.side / 2).toBeCloseTo(plate.y + plate.side / 2);
  });

  it('is the single source both renderers share', () => {
    const matrix = createQrMatrix(URL_UNDER_TEST);
    const mark = qrLogoMarkRect(matrix);

    // The SVG and the PNG must draw the same mark — they previously each hardcoded the
    // inset and radius factor, which let the on-screen code and the download drift.
    const inset = (qrLogoRect(matrix).side - mark.side) / 2;
    expect(inset / qrLogoRect(matrix).side).toBeCloseTo(QR_LOGO_INSET_RATIO);
    expect(mark.radius).toBeCloseTo(qrLogoRect(matrix).radius * QR_LOGO_MARK_RADIUS_FACTOR);
  });
});

describe('qrDisplaySize', () => {
  it('honours the preferred size when modules are already large enough', () => {
    // A short public link (~span 49) at 176px clears the 4px/module bar.
    expect(qrDisplaySize(40, 176)).toBe(176);
  });

  it('grows a dense symbol so its modules stay legible', () => {
    // A long invite URL packs more modules in; holding 176px would shrink them below the
    // threshold, which is exactly the case that stopped decoding in verification.
    expect(qrDisplaySize(73, 176)).toBe(292);
    expect(qrDisplaySize(73, 176) / 73).toBeGreaterThanOrEqual(4);
  });

  it('caps growth so a pathological URL cannot dominate the form', () => {
    expect(qrDisplaySize(200, 176)).toBe(320);
  });

  it('never returns less than the preferred size for any span it can honour', () => {
    for (const span of [21, 33, 49, 57, 65, 73]) {
      expect(qrDisplaySize(span, 176)).toBeGreaterThanOrEqual(176);
    }
  });
});

describe('qrFileStem', () => {
  it('slugifies a human label', () => {
    expect(qrFileStem('Public link')).toBe('public-link');
    expect(qrFileStem('No-login link')).toBe('no-login-link');
  });

  it('strips punctuation and collapses separators', () => {
    expect(qrFileStem('invite — Ada Lovelace!')).toBe('invite-ada-lovelace');
  });

  it('keeps non-Latin names distinct rather than collapsing them to the fallback', () => {
    // A cohort of `invite-<name>` labels previously all slugged to `invite`, so every
    // download overwrote the last one in the user's Downloads folder.
    expect(qrFileStem('invite-李伟')).not.toBe('invite');
    expect(qrFileStem('invite-李伟')).not.toBe(qrFileStem('invite-陈静'));
    expect(qrFileStem('Zoë Müller')).toBe('zoë-müller');
  });

  it('still strips path separators, dots, and control characters', () => {
    // The Unicode allowance must not reopen path traversal.
    expect(qrFileStem('../../etc/passwd')).toBe('etc-passwd');
    expect(qrFileStem('a/b\\c')).toBe('a-b-c');
    expect(qrFileStem('name\u0000.png')).toBe('name-png');
    for (const stem of [
      qrFileStem('../../etc/passwd'),
      qrFileStem('a/b\\c'),
      qrFileStem('name\u0000.png'),
    ]) {
      // Checked character-wise rather than by regex: a control-character class in a
      // literal regex trips ESLint's `no-control-regex`.
      for (const forbidden of ['/', '\\', '.', '\u0000']) {
        expect(stem).not.toContain(forbidden);
      }
    }
  });

  it('falls back when nothing usable survives', () => {
    expect(qrFileStem(undefined)).toBe('qr-code');
    expect(qrFileStem('')).toBe('qr-code');
    expect(qrFileStem('///')).toBe('qr-code');
  });

  it('bounds the length so the filename stays sane', () => {
    expect(qrFileStem('a'.repeat(200)).length).toBeLessThanOrEqual(60);
  });
});
