// @vitest-environment happy-dom

/**
 * SectionRail Component Tests
 *
 * Sticky scroll-spy rail for long, single-scroll panels. Discovers sections from
 * the DOM (`[data-section-rail]` cards with an id + data-section-label inside the
 * target container), renders a jump link per section, and tracks the active one
 * via IntersectionObserver. A 'use client' component.
 *
 * IntersectionObserver and scrollIntoView aren't implemented in happy-dom, so we
 * stub them — capturing the IO callback lets us drive the scroll-spy directly.
 *
 * @see components/admin/section-rail.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent, within } from '@testing-library/react';

import { SectionRail } from '@/components/admin/section-rail';

type IOCallback = (entries: Array<{ isIntersecting: boolean; target: { id: string } }>) => void;

let ioCallback: IOCallback | null;
const scrollIntoView = vi.fn();
const originalScrollIntoView = window.HTMLElement.prototype.scrollIntoView;

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

afterEach(() => {
  // Restore the prototype + globals so stubs don't leak into other test files.
  window.HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  vi.unstubAllGlobals();
});

function Fixture({
  sections,
  onJump,
}: {
  sections: { id: string; label: string; fields?: string[] }[];
  onJump?: (id: string) => void;
}) {
  return (
    <div>
      <div id="settings-sections">
        {sections.map((s) => (
          <div key={s.id} id={s.id} data-section-rail data-section-label={s.label}>
            {s.label}
            {/* The rail reads a section's field names from its <label>s, as the settings panel
                renders them — including inside a group that is currently folded shut. */}
            {(s.fields ?? []).map((f) => (
              <label key={f}>{f}</label>
            ))}
          </div>
        ))}
      </div>
      <SectionRail targetId="settings-sections" ariaLabel="Settings sections" onJump={onJump} />
    </div>
  );
}

/** Enough sections to cross the rail's filter threshold (8). */
const MANY = [
  { id: 'questions', label: 'Questions & completion' },
  { id: 'experience', label: 'Respondent experience', fields: ['Voice input', 'Attachments'] },
  { id: 'milestones', label: 'Progress milestones' },
  { id: 'intro', label: 'Intro screen' },
  { id: 'reasoning', label: 'Reasoning stream' },
  { id: 'tone', label: 'Interviewer tone & persona' },
  { id: 'access', label: 'Access & invitations' },
  { id: 'budget', label: 'Budget & limits' },
];

const THREE = [
  { id: 'questions', label: 'Questions & completion' },
  { id: 'experience', label: 'Respondent experience' },
  { id: 'budget', label: 'Budget & limits' },
];

describe('SectionRail', () => {
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
    // Dispatch a cancelable click so we can assert preventDefault actually fired
    // (a bare .click() can't report defaultPrevented).
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    screen.getByRole('link', { name: 'Budget & limits' }).dispatchEvent(event);
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    expect(event.defaultPrevented).toBe(true);
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

  it('hands off to the next visible section once the active one scrolls out of view', () => {
    render(<Fixture sections={THREE} />);
    act(() => {
      ioCallback!([
        { isIntersecting: true, target: { id: 'budget' } },
        { isIntersecting: true, target: { id: 'questions' } },
      ]);
    });
    act(() => {
      // 'questions' leaves the viewport — 'budget' is still visible and takes over.
      ioCallback!([{ isIntersecting: false, target: { id: 'questions' } }]);
    });
    expect(screen.getByRole('link', { name: 'Budget & limits' })).toHaveAttribute(
      'aria-current',
      'location'
    );
    expect(screen.getByRole('link', { name: 'Questions & completion' })).not.toHaveAttribute(
      'aria-current'
    );
  });

  it('calls onJump before scrolling, so a caller can unfold a collapsed section first', () => {
    const onJump = vi.fn();
    render(<Fixture sections={THREE} onJump={onJump} />);
    screen.getByRole('link', { name: 'Budget & limits' }).click();
    expect(onJump).toHaveBeenCalledWith('budget');
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it('caps its height to the room left below it, so the last section stays reachable', () => {
    // The admin shell scrolls inside <main>, not the window, so the cap is measured rather than
    // written as a 100vh sum — a rail that runs past the fold is one the admin cannot scroll to.
    const { container } = render(<Fixture sections={MANY} />);
    const box = container.querySelector<HTMLElement>('nav > div');
    expect(box?.style.maxHeight).toMatch(/^\d+px$/);
  });

  it('coalesces rapid resize/scroll events into a single measurement per frame', () => {
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame');
    render(<Fixture sections={MANY} />);
    rafSpy.mockClear();
    act(() => {
      // Two events land before the first rAF callback has a chance to run — the
      // second must be coalesced rather than scheduling a frame of its own.
      window.dispatchEvent(new Event('resize'));
      window.dispatchEvent(new Event('resize'));
    });
    expect(rafSpy).toHaveBeenCalledTimes(1);
    rafSpy.mockRestore();
  });

  describe('filter', () => {
    it('stays out of the way on a short rail', () => {
      render(<Fixture sections={THREE} />);
      expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    });

    it('appears once the rail is long enough to be worth filtering', () => {
      render(<Fixture sections={MANY} />);
      expect(
        screen.getByRole('searchbox', { name: /filter settings sections/i })
      ).toBeInTheDocument();
    });

    it("matches a section's fields, not just its heading", () => {
      render(<Fixture sections={MANY} />);
      // "Voice input" is a field inside Respondent experience — no heading says "voice".
      fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'voice' } });
      const nav = screen.getByRole('navigation', { name: /settings sections/i });
      expect(within(nav).getAllByRole('link')).toHaveLength(1);
      expect(within(nav).getByRole('link', { name: 'Respondent experience' })).toBeInTheDocument();
    });

    it('names the matching field under the section, so the hit is explained', () => {
      render(<Fixture sections={MANY} />);
      const nav = screen.getByRole('navigation', { name: /settings sections/i });
      fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'voice' } });
      expect(within(nav).getByText('Voice input')).toBeInTheDocument();
      // Only the fields that matched — 'Attachments' lives in the same section and did not.
      expect(within(nav).queryByText('Attachments')).not.toBeInTheDocument();
    });

    it('lists sections plainly when nothing is being filtered', () => {
      render(<Fixture sections={MANY} />);
      const nav = screen.getByRole('navigation', { name: /settings sections/i });
      // An unfiltered rail is a list of sections, not a list of every field in the panel.
      expect(within(nav).queryByText('Voice input')).not.toBeInTheDocument();
    });

    it('says so when nothing matches, rather than showing an empty rail', () => {
      render(<Fixture sections={MANY} />);
      fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzz' } });
      const nav = screen.getByRole('navigation', { name: /settings sections/i });
      expect(within(nav).queryAllByRole('link')).toHaveLength(0);
      expect(screen.getByText(/no matching sections/i)).toBeInTheDocument();
    });

    it('jumps to the first match on Enter', () => {
      render(<Fixture sections={MANY} />);
      const box = screen.getByRole('searchbox');
      fireEvent.change(box, { target: { value: 'budget' } });
      fireEvent.keyDown(box, { key: 'Enter' });
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    });
  });
});
