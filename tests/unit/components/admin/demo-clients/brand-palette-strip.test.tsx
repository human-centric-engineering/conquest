// @vitest-environment happy-dom

/**
 * BrandPaletteStrip component tests.
 *
 * The strip is a reference sheet, so the behaviours worth pinning are the ones that make it
 * trustworthy rather than decorative:
 *
 *  - it says WHERE and WHEN the colours came from, because a palette read off a site that has
 *    since been rebranded is worse than no palette if nobody can tell;
 *  - a chip copies its hex, which is the whole reason an admin looks at it while filling a field;
 *  - the accessible name of a chip carries the share and the neutral flag — the two facts that
 *    decide which candidate belongs in which field — rather than hiding them in a `title`;
 *  - the proportional band is `aria-hidden`, so the palette is announced once, not twice;
 *  - a nearly-invisible accent still gets a clickable slice of the band.
 *
 * @see components/admin/demo-clients/brand-palette-strip.tsx
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { BrandPaletteStrip } from '@/components/admin/demo-clients/brand-palette-strip';
import type { BrandPalette } from '@/lib/app/questionnaire/brand-import/palette-record';

/**
 * Stub `navigator.clipboard` AFTER `userEvent.setup()`, which installs its own — the convention
 * the sibling chip/drawer tests already use, via `defineProperty` because happy-dom's is read-only.
 */
function mockClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  return { writeText };
}

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
afterEach(() => {
  if (originalClipboardDescriptor) {
    Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor);
  } else {
    delete (navigator as unknown as Record<string, unknown>).clipboard;
  }
});

const PALETTE: BrandPalette = {
  candidates: [
    { hex: '#fffcf5', share: 0.71, neutral: true },
    { hex: '#0a1a3a', share: 0.22, neutral: false },
    // A brand accent: tiny by area, and often the single most useful hex in the list.
    { hex: '#ff03df', share: 0.004, neutral: false },
  ],
  readFrom: 'acme.example + 2 screenshots',
  capturedAt: '2026-08-31T09:00:00.000Z',
};

describe('BrandPaletteStrip', () => {
  it('names where and when the palette was read', () => {
    render(<BrandPaletteStrip palette={PALETTE} />);
    expect(screen.getByText(/acme\.example \+ 2 screenshots/)).toBeTruthy();
    // Locale-formatted, so assert on the year rather than pinning a format the CI locale may not
    // produce — the point of the assertion is that a date is shown at all.
    expect(screen.getByText(/2026/)).toBeTruthy();
  });

  it('omits the provenance dot when the source could not be named', () => {
    render(<BrandPaletteStrip palette={{ ...PALETTE, readFrom: null }} />);
    expect(screen.queryByText(/acme\.example/)).toBeNull();
    expect(screen.getByText(/2026/)).toBeTruthy();
  });

  it('renders one chip per measured colour, in the order measured', () => {
    render(<BrandPaletteStrip palette={PALETTE} />);
    const chips = screen.getAllByRole('button', { name: /^Copy #/ });
    expect(chips.map((c) => c.getAttribute('aria-label')?.slice(5, 12))).toEqual([
      '#fffcf5',
      '#0a1a3a',
      '#ff03df',
    ]);
  });

  it('puts the share and the neutral flag in the accessible name, not a tooltip', () => {
    // These are the facts that decide which candidate belongs in which field. A `title` is
    // invisible to a keyboard and to a screen reader, which is most of the reason to state them.
    render(<BrandPaletteStrip palette={PALETTE} />);
    expect(
      screen.getByRole('button', { name: 'Copy #fffcf5 — 71.0 percent of the page, a neutral' })
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Copy #0a1a3a — 22.0 percent of the page' })
    ).toBeTruthy();
  });

  it('copies a hex when its chip is pressed', async () => {
    const user = userEvent.setup();
    const { writeText } = mockClipboard();
    render(<BrandPaletteStrip palette={PALETTE} />);

    await user.click(screen.getByRole('button', { name: /Copy #0a1a3a/ }));

    expect(writeText).toHaveBeenCalledWith('#0a1a3a');
  });

  it('does not apply the colour to anything — copying is the whole action', async () => {
    // The strip has ten colours and the form has ten colour boxes; "apply" would need a target.
    // Assigning colours to roles is the import dialog's job, and this asserts the split holds.
    const user = userEvent.setup();
    mockClipboard();
    const onClear = vi.fn();
    render(<BrandPaletteStrip palette={PALETTE} onClear={onClear} />);

    await user.click(screen.getByRole('button', { name: /Copy #0a1a3a/ }));

    expect(onClear).not.toHaveBeenCalled();
  });

  it('gives a nearly-invisible accent a clickable slice of the band', () => {
    // At its true 0.4% share the accent is a sub-pixel sliver. The floor is what makes the band
    // a thing an admin can point at rather than a picture of the two biggest colours.
    render(<BrandPaletteStrip palette={PALETTE} />);
    const slices = Array.from(screen.getByTestId('brand-palette-band').children) as HTMLElement[];
    expect(slices).toHaveLength(3);
    expect(Number(slices[2].style.flexGrow)).toBeGreaterThanOrEqual(2);
  });

  it('hides the band from assistive tech so the palette is announced once', () => {
    render(<BrandPaletteStrip palette={PALETTE} />);
    expect(screen.getByTestId('brand-palette-band').getAttribute('aria-hidden')).toBe('true');
  });

  it('offers no Clear button when the parent has nothing to clear with', () => {
    render(<BrandPaletteStrip palette={PALETTE} />);
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
  });

  it('clears through the parent rather than dropping the palette itself', async () => {
    // The palette lives in form state, so the strip must not own its own copy — clearing has to
    // travel through the form or Save would stay greyed out with a stale strip on screen.
    const user = userEvent.setup();
    const onClear = vi.fn();
    render(<BrandPaletteStrip palette={PALETTE} onClear={onClear} />);

    await user.click(screen.getByRole('button', { name: /Clear/ }));

    expect(onClear).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole('button', { name: /^Copy #/ })).toHaveLength(3);
  });

  it('marks the copied chip and leaves the others alone', async () => {
    const user = userEvent.setup();
    mockClipboard();
    render(<BrandPaletteStrip palette={PALETTE} />);

    await user.click(screen.getByRole('button', { name: /Copy #0a1a3a/ }));

    await waitFor(() => {
      const copied = screen.getByRole('button', { name: /Copy #0a1a3a/ });
      expect(copied.querySelector('.text-emerald-600')).toBeTruthy();
    });
    const other = screen.getByRole('button', { name: /Copy #fffcf5/ });
    expect(other.querySelector('.text-emerald-600')).toBeNull();
  });
});
