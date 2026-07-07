/**
 * ToneDimensionRow (F-tone / F-persona) — unit tests for the shared tone-dimension control used by
 * both the version tone panel and each persona card.
 *
 * Tests pin what the component DOES:
 *  - the enable toggle shows/hides the slider + clause preview and fires `onToggle`
 *  - the slider renders on the signed −2…+2 display scale (stored 1–5 → display) and hands the
 *    STORED level back through `onLevel` (display → stored)
 *  - the live "what's added" preview shows the exact clause the current position injects, pulled
 *    from the real prompt source ({@link DIMENSION_PHRASES}) — neutral positions show "no tone clause"
 *  - the signed value label formats +n / 0 / -n and marks the neutral midpoint on bipolar dials
 *
 * The shadcn Switch/Slider/FieldHelp are replaced with plain inputs so userEvent works in jsdom.
 *
 * @see components/admin/questionnaires/tone-dimensions.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import {
  ToneDimensionRow,
  TONE_DIMENSION_META,
} from '@/components/admin/questionnaires/tone-dimensions';
import { DIMENSION_PHRASES } from '@/lib/app/questionnaire/chat/tone';
import {
  TONE_LEVEL_NEUTRAL,
  fromDisplayLevel,
  type ToneDimension,
} from '@/lib/app/questionnaire/types';

// ─── Switch → checkbox ───────────────────────────────────────────────────────
vi.mock('@/components/ui/switch', () => ({
  Switch: ({
    checked,
    onCheckedChange,
    disabled,
  }: {
    checked: boolean;
    onCheckedChange: (v: boolean) => void;
    disabled?: boolean;
  }) => (
    <input
      type="checkbox"
      role="switch"
      checked={checked}
      disabled={disabled}
      onChange={(e) => onCheckedChange(e.target.checked)}
    />
  ),
}));

// ─── Slider → range input ────────────────────────────────────────────────────
vi.mock('@/components/ui/slider', () => ({
  Slider: (props: {
    value?: number[];
    min?: number;
    max?: number;
    step?: number;
    onValueChange?: (value: number[]) => void;
    'aria-label'?: string;
  }) => (
    <input
      type="range"
      aria-label={props['aria-label']}
      value={props.value?.[0]}
      min={props.min}
      max={props.max}
      step={props.step}
      onChange={(e) => props.onValueChange?.([Number(e.target.value)])}
    />
  ),
}));

// ─── FieldHelp → passthrough ─────────────────────────────────────────────────
vi.mock('@/components/ui/field-help', () => ({
  FieldHelp: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

const empathyMeta = TONE_DIMENSION_META.find((m) => m.key === 'empathy')!;
const mirroringMeta = TONE_DIMENSION_META.find((m) => m.key === 'mirroring')!;

function renderRow(
  meta: (typeof TONE_DIMENSION_META)[number],
  value: ToneDimension,
  handlers: { onToggle?: (v: boolean) => void; onLevel?: (n: number) => void } = {}
) {
  const onToggle = handlers.onToggle ?? vi.fn();
  const onLevel = handlers.onLevel ?? vi.fn();
  const utils = render(
    <ToneDimensionRow
      meta={meta}
      value={value}
      busy={false}
      onToggle={onToggle}
      onLevel={onLevel}
    />
  );
  return { onToggle, onLevel, ...utils };
}

describe('ToneDimensionRow', () => {
  it('renders the dimension label and its enable toggle', () => {
    renderRow(empathyMeta, { enabled: false, level: TONE_LEVEL_NEUTRAL });
    expect(screen.getByText(/Empathy/)).toBeInTheDocument();
    expect(screen.getByRole('switch')).not.toBeChecked();
  });

  it('hides the slider and clause preview while the dimension is disabled', () => {
    renderRow(empathyMeta, { enabled: false, level: TONE_LEVEL_NEUTRAL });
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    expect(screen.queryByText(/Adds to the prompt/)).not.toBeInTheDocument();
  });

  it('fires onToggle(true) when the switch is turned on', () => {
    const onToggle = vi.fn();
    renderRow(empathyMeta, { enabled: false, level: TONE_LEVEL_NEUTRAL }, { onToggle });
    fireEvent.click(screen.getByRole('switch'));
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it('shows the slider on the signed −2…+2 scale with pole labels when enabled', () => {
    // Stored level 5 (max) → display +2.
    renderRow(empathyMeta, { enabled: true, level: 5 });
    const slider = screen.getByRole<HTMLInputElement>('slider');
    expect(slider.value).toBe('2');
    expect(slider.min).toBe('-2');
    expect(slider.max).toBe('2');
    expect(screen.getByText(empathyMeta.left)).toBeInTheDocument();
    expect(screen.getByText(empathyMeta.right)).toBeInTheDocument();
    // Signed value label for +2.
    expect(screen.getByText('+2')).toBeInTheDocument();
  });

  it('hands the STORED 1–5 level back through onLevel when the slider moves', () => {
    const onLevel = vi.fn();
    renderRow(empathyMeta, { enabled: true, level: TONE_LEVEL_NEUTRAL }, { onLevel });
    // Move to display −2 → stored 1.
    fireEvent.change(screen.getByRole('slider'), { target: { value: '-2' } });
    expect(onLevel).toHaveBeenCalledWith(fromDisplayLevel(-2));
    expect(onLevel).toHaveBeenCalledWith(1);
  });

  it('previews the exact clause the current position injects (from the real prompt source)', () => {
    // Stored level 5 → display +2; clause is the level-5 empathy phrase.
    renderRow(empathyMeta, { enabled: true, level: 5 });
    expect(screen.getByText(/Adds to the prompt/)).toBeInTheDocument();
    expect(screen.getByText(`“${DIMENSION_PHRASES.empathy[5]}”`)).toBeInTheDocument();
  });

  it('marks a bipolar dial as neutral and adds no clause at the midpoint', () => {
    // empathy is bipolar: its neutral midpoint emits nothing.
    expect(DIMENSION_PHRASES.empathy[TONE_LEVEL_NEUTRAL]).toBe('');
    renderRow(empathyMeta, { enabled: true, level: TONE_LEVEL_NEUTRAL });
    expect(screen.getByText(/· neutral/)).toBeInTheDocument();
    expect(
      screen.getByText(/Neutral at this position — no tone clause is added\./)
    ).toBeInTheDocument();
  });

  it('always adds a clause for a unipolar (intensity) dial, even at the midpoint', () => {
    // mirroring is unipolar: every position emits, including the midpoint.
    expect(DIMENSION_PHRASES.mirroring[TONE_LEVEL_NEUTRAL]).not.toBe('');
    renderRow(mirroringMeta, { enabled: true, level: TONE_LEVEL_NEUTRAL });
    expect(screen.getByText(/Adds to the prompt/)).toBeInTheDocument();
    expect(screen.queryByText(/no tone clause is added/)).not.toBeInTheDocument();
  });
});
