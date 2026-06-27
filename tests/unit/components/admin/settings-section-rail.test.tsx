/**
 * SettingsSectionRail Component Tests
 *
 * Sticky scroll-spy rail for long settings panels. Discovers sections from the
 * DOM (`[data-settings-section]` cards with an id + data-section-label inside the
 * target container), renders a jump link per section, and tracks the active one
 * via IntersectionObserver. A 'use client' component.
 *
 * IntersectionObserver and scrollIntoView aren't implemented in happy-dom, so we
 * stub them — capturing the IO callback lets us drive the scroll-spy directly.
 *
 * @see components/admin/settings-section-rail.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';

import { SettingsSectionRail } from '@/components/admin/settings-section-rail';

type IOCallback = (entries: Array<{ isIntersecting: boolean; target: { id: string } }>) => void;

let ioCallback: IOCallback | null;
const scrollIntoView = vi.fn();

beforeEach(() => {
  ioCallback = null;
  scrollIntoView.mockClear();
  window.HTMLElement.prototype.scrollIntoView = scrollIntoView;
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(cb: IOCallback) {
        ioCallback = cb;
      }
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
      takeRecords = () => [];
    }
  );
});

function Fixture({ sections }: { sections: { id: string; label: string }[] }) {
  return (
    <div>
      <div id="settings-sections">
        {sections.map((s) => (
          <div key={s.id} id={s.id} data-settings-section data-section-label={s.label}>
            {s.label}
          </div>
        ))}
      </div>
      <SettingsSectionRail targetId="settings-sections" />
    </div>
  );
}

const THREE = [
  { id: 'questions', label: 'Questions & completion' },
  { id: 'experience', label: 'Respondent experience' },
  { id: 'budget', label: 'Budget & limits' },
];

describe('SettingsSectionRail', () => {
  it('discovers a jump link per section, labelled from data-section-label', () => {
    render(<Fixture sections={THREE} />);
    for (const s of THREE) {
      const link = screen.getByRole('link', { name: s.label });
      expect(link).toHaveAttribute('href', `#${s.id}`);
    }
  });

  it('renders nothing when there is one section or fewer (nothing to move between)', () => {
    render(<Fixture sections={[{ id: 'solo', label: 'Solo' }]} />);
    expect(
      screen.queryByRole('navigation', { name: /settings sections/i })
    ).not.toBeInTheDocument();
  });

  it('jumps to a section on click and prevents the default hash navigation', () => {
    render(<Fixture sections={THREE} />);
    screen.getByRole('link', { name: 'Budget & limits' }).click();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('marks the topmost in-view section active via scroll-spy', () => {
    render(<Fixture sections={THREE} />);
    expect(ioCallback).not.toBeNull();
    act(() => {
      ioCallback!([{ isIntersecting: true, target: { id: 'experience' } }]);
    });
    expect(screen.getByRole('link', { name: 'Respondent experience' })).toHaveAttribute(
      'aria-current',
      'location'
    );
    // The others are not current.
    expect(screen.getByRole('link', { name: 'Questions & completion' })).not.toHaveAttribute(
      'aria-current'
    );
  });

  it('prefers the earliest section when several are in view at once', () => {
    render(<Fixture sections={THREE} />);
    act(() => {
      ioCallback!([
        { isIntersecting: true, target: { id: 'budget' } },
        { isIntersecting: true, target: { id: 'questions' } },
      ]);
    });
    // 'questions' comes first in document order → it wins.
    expect(screen.getByRole('link', { name: 'Questions & completion' })).toHaveAttribute(
      'aria-current',
      'location'
    );
  });
});
