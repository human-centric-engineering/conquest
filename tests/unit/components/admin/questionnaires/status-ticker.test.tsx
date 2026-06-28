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

import {
  StatusTicker,
  estimateExtractionMs,
} from '@/components/admin/questionnaires/status-ticker';

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

  function elapsedText(): string {
    return screen.getByTestId('elapsed').textContent ?? '';
  }

  it('shows an mm:ss elapsed counter that ticks once a second', () => {
    render(<StatusTicker messages={['X']} />);

    expect(elapsedText()).toBe('00:00');

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(elapsedText()).toBe('00:05');

    // Crosses the minute boundary — minutes and seconds both pad to two digits.
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(elapsedText()).toBe('01:05');
  });

  describe('adaptive pacing (estimatedMs)', () => {
    it('distributes deterministic holds weighted toward the middle message', () => {
      // 4 messages, estimate 8000ms. Paced indices 0..2 with triangular weights
      // 1:2:1 (sum 4) → holds 2000 / 4000 / 2000ms. Single-char messages keep the
      // typing time at one 40ms tick per message.
      render(<StatusTicker messages={['A', 'B', 'C', 'D']} estimatedMs={8_000} />);

      typeChars(1);
      expect(typedText()).toBe(`A${CURSOR}`);

      // Index 0 holds 2000ms — not the random 3–10s window.
      act(() => {
        vi.advanceTimersByTime(1_999);
      });
      expect(typedText()).toBe(`A${CURSOR}`);
      act(() => {
        vi.advanceTimersByTime(1);
      });
      typeChars(1);
      expect(typedText()).toBe(`B${CURSOR}`);

      // Index 1 is the heaviest hold (4000ms) — the middle dwells longest.
      act(() => {
        vi.advanceTimersByTime(3_999);
      });
      expect(typedText()).toBe(`B${CURSOR}`);
      act(() => {
        vi.advanceTimersByTime(1);
      });
      typeChars(1);
      expect(typedText()).toBe(`C${CURSOR}`);
    });

    it('holds the final message indefinitely even when the estimate is exceeded', () => {
      render(<StatusTicker messages={['A', 'B']} estimatedMs={4_000} />);

      typeChars(1); // 'A'
      act(() => {
        vi.advanceTimersByTime(4_000);
      });
      typeChars(1); // 'B' — the last message
      expect(typedText()).toBe(`B${CURSOR}`);

      // Long past the estimate, it sits on the last message rather than looping.
      act(() => {
        vi.advanceTimersByTime(120_000);
      });
      expect(typedText()).toBe(`B${CURSOR}`);
    });
  });
});

describe('estimateExtractionMs', () => {
  it('floors a tiny upload at the minimum estimate', () => {
    expect(estimateExtractionMs(0, 'tiny.txt')).toBe(15_000);
  });

  it('scales with file size', () => {
    // 1 MiB plain text: base 15000 + 9000/MB → 24000ms.
    expect(estimateExtractionMs(1024 * 1024, 'doc.txt')).toBe(24_000);
  });

  it('applies a per-format slowness factor (case-insensitive)', () => {
    expect(estimateExtractionMs(0, 'scan.PDF')).toBe(21_000); // 15000 * 1.4
    expect(estimateExtractionMs(0, 'book.xlsx')).toBe(22_500); // 15000 * 1.5
    expect(estimateExtractionMs(0, 'brief.docx')).toBe(18_000); // 15000 * 1.2
  });

  it('clamps a huge upload to the maximum estimate', () => {
    expect(estimateExtractionMs(500 * 1024 * 1024, 'huge.pdf')).toBe(180_000);
  });
});
