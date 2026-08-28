// @vitest-environment happy-dom

/**
 * ModeToggle — the compact chat ↔ form segmented switch (P-presentation).
 *
 * Pins the contract the workspace relies on: two tabs, the active one marked
 * aria-selected, a click reports the target view, and the sliding indicator tracks the value.
 *
 * @see components/app/questionnaire/mode-toggle.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MessageSquare, ListChecks } from 'lucide-react';

import { ModeToggle } from '@/components/app/questionnaire/mode-toggle';

describe('ModeToggle', () => {
  it('renders Chat + Form tabs with the active one selected', () => {
    render(<ModeToggle value="chat" onChange={() => {}} />);
    expect(screen.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Form' })).toHaveAttribute('aria-selected', 'false');
  });

  it('reports the target view on click', () => {
    const onChange = vi.fn();
    render(<ModeToggle value="chat" onChange={onChange} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Form' }));
    expect(onChange).toHaveBeenCalledWith('form');
  });

  it('slides the indicator to the second segment when the value is form', () => {
    const { container } = render(<ModeToggle value="form" onChange={() => {}} />);
    // The indicator offset is computed from the active index (segment 2 of 2 → 100% of its width).
    const indicator = container.querySelector('[aria-hidden="true"]');
    expect(indicator?.getAttribute('style')).toContain('translateX(100%)');
  });

  it('keeps the indicator on the first segment when the value is chat', () => {
    const { container } = render(<ModeToggle value="chat" onChange={() => {}} />);
    const indicator = container.querySelector('[aria-hidden="true"]');
    expect(indicator?.getAttribute('style')).toContain('translateX(0%)');
  });

  it('renders a third segment and tracks it when supplied custom items', () => {
    const onChange = vi.fn();
    const items = [
      { id: 'intro', label: 'Intro', Icon: MessageSquare },
      { id: 'chat', label: 'Chat', Icon: MessageSquare },
      { id: 'form', label: 'Form', Icon: ListChecks },
    ];
    const { container } = render(<ModeToggle value="form" onChange={onChange} items={items} />);
    expect(screen.getByRole('tab', { name: 'Intro' })).toBeInTheDocument();
    // Third of three segments → translated two widths across.
    const indicator = container.querySelector('[aria-hidden="true"]');
    expect(indicator?.getAttribute('style')).toContain('translateX(200%)');
    fireEvent.click(screen.getByRole('tab', { name: 'Intro' }));
    expect(onChange).toHaveBeenCalledWith('intro');
  });
});

/**
 * When the words stand down, and why it depends on how many there are.
 *
 * The pill shares the lifecycle strip's control line with the text-size stepper and the review
 * trigger, and every segment it gains carries another word. A single collapse threshold cannot serve
 * both ends of that range: tuned for two segments, a four-segment strip wraps onto a second line on
 * a phone (which is what it did); tuned for four, a two-segment pill loses words it had room for.
 *
 * jsdom evaluates no media queries, so what is asserted is the declaration — the same reasoning the
 * answer drawer's `lg:hidden` is tested on. The second assertion is the one that actually earns its
 * place: Tailwind scans source text, so an interpolated `max-[${n}px]:hidden` would compile to no
 * CSS at all and fail as a label that simply never hides — silently, and only on a phone.
 */
describe('label collapse scales with the segment count', () => {
  function item(id: string, label: string) {
    return { id, label, Icon: MessageSquare };
  }

  const CASES: Array<[number, string[], string]> = [
    [2, ['Chat', 'Form'], 'max-[360px]:hidden'],
    [3, ['Intro', 'Chat', 'Form'], 'max-[420px]:hidden'],
    [4, ['Intro', 'Interviewer', 'Chat', 'Form'], 'max-[540px]:hidden'],
  ];

  it.each(CASES)('%i segments hide their words below the %s threshold', (_n, labels, expected) => {
    render(
      <ModeToggle
        value={labels[0]}
        onChange={() => {}}
        items={labels.map((l) => item(l.toLowerCase(), l))}
      />
    );
    for (const label of labels) {
      expect(screen.getByText(label)).toHaveClass(expected);
    }
  });

  it('gives more segments an earlier threshold, never a later one', () => {
    // The relationship is the point, not the three numbers: a wider pill must give up its words
    // sooner. A future edit that adds a segment set has to keep this monotonic.
    const widths = CASES.map(([, , cls]) => Number(/max-\[(\d+)px\]/.exec(cls)![1]));
    expect(widths).toEqual([...widths].sort((a, b) => a - b));
  });

  it('names every tab regardless, so an icon-only segment is still a target', () => {
    render(
      <ModeToggle
        value="chat"
        onChange={() => {}}
        items={[item('chat', 'Chat'), item('form', 'Form')]}
      />
    );
    // `aria-label` on the button, not the hidden span — the name has to survive the collapse.
    expect(screen.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-label', 'Chat');
  });
});
