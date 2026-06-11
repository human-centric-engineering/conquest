/**
 * StatusTicker component tests.
 *
 * Anti-green-bar: drives the fake-timer clock through the typewriter cadence
 * and asserts the actual visible text at each stage — characters appear one
 * per tick, the next message starts only after the randomised 3–10s hold, and
 * the final message holds indefinitely rather than looping.
 *
 * @see components/admin/questionnaires/status-ticker.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';

import { StatusTicker } from '@/components/admin/questionnaires/status-ticker';

const TYPE_INTERVAL_MS = 40;
const CURSOR = '▍';

/** Advance the clock one typing tick at a time so each effect can reschedule. */
function typeChars(count: number) {
  for (let i = 0; i < count; i++) {
    act(() => {
      vi.advanceTimersByTime(TYPE_INTERVAL_MS);
    });
  }
}

function typedText(): string {
  return screen.getByTestId('typed-text').textContent ?? '';
}

describe('StatusTicker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('types the first message out character by character', () => {
    render(<StatusTicker messages={['Reading…', 'Thinking…']} />);

    expect(typedText()).toBe(CURSOR);
    typeChars(4);
    expect(typedText()).toBe(`Read${CURSOR}`);
    typeChars(4);
    expect(typedText()).toBe(`Reading…${CURSOR}`);
  });

  it('holds a typed message for the randomised 3–10s window before starting the next', () => {
    // random=0.5 → hold of 3000 + 0.5 * 7000 = 6500ms.
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    render(<StatusTicker messages={['Hi', 'Bye']} />);

    typeChars(2);
    expect(typedText()).toBe(`Hi${CURSOR}`);

    // Just shy of the hold: still on the first message.
    act(() => {
      vi.advanceTimersByTime(6_499);
    });
    expect(typedText()).toBe(`Hi${CURSOR}`);

    // Crossing the hold restarts typing from scratch on the next message.
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(typedText()).toBe(CURSOR);
    typeChars(3);
    expect(typedText()).toBe(`Bye${CURSOR}`);
  });

  it('announces the full message to screen readers without the typing animation', () => {
    render(<StatusTicker messages={['Processing…']} />);
    expect(screen.getByRole('status')).toHaveTextContent('Processing…');
  });

  it('holds the final message indefinitely instead of looping', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    render(<StatusTicker messages={['Hi', 'Bye']} />);

    typeChars(2);
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    typeChars(3);
    expect(typedText()).toBe(`Bye${CURSOR}`);

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(typedText()).toBe(`Bye${CURSOR}`);
  });
});
