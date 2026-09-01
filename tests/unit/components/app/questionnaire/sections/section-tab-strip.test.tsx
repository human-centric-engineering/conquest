// @vitest-environment happy-dom

/**
 * SectionTabStrip — the strip of sections the respondent moves between (P21).
 *
 * Covers: the two null-render guards (inactive view, empty visible-tab list), the
 * `showLocked` filter, the `strip` vs `menu` variant shells, and the shared `TabButton`
 * behaviour (disabled state, `aria-current`, status icon, screen-reader text, click).
 *
 * @see components/app/questionnaire/sections/section-tab-strip.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SectionTabStrip } from '@/components/app/questionnaire/sections/section-tab-strip';
import type { SectionStripView, SectionTabView } from '@/lib/app/questionnaire/sections/view';

function makeTab(overrides: Partial<SectionTabView> = {}): SectionTabView {
  return {
    key: 'intro',
    label: 'Introduction',
    position: 1,
    status: 'not_started',
    isActive: false,
    isAvailable: true,
    reopenCount: 0,
    ...overrides,
  };
}

function makeView(overrides: Partial<SectionStripView> = {}): SectionStripView {
  return {
    active: true,
    sections: [
      makeTab({ key: 'intro', label: 'Introduction', position: 1, isActive: true }),
      makeTab({ key: 'goals', label: 'Goals', position: 2, isAvailable: false }),
      makeTab({ key: 'wrap', label: 'Wrap up', position: 3, status: 'closed', isAvailable: true }),
    ],
    activeKey: 'intro',
    canClose: false,
    blockedOnRequired: false,
    allClosed: false,
    showLocked: true,
    ...overrides,
  };
}

describe('SectionTabStrip', () => {
  it('renders nothing when the view is not active', () => {
    const { container } = render(
      <SectionTabStrip view={makeView({ active: false })} onSelect={vi.fn()} canSelect />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the visible tab list is empty', () => {
    // showLocked=false with every tab unavailable leaves nothing to draw.
    const view = makeView({
      showLocked: false,
      sections: [makeTab({ key: 'only', isAvailable: false, isActive: false })],
    });
    const { container } = render(<SectionTabStrip view={view} onSelect={vi.fn()} canSelect />);
    expect(container).toBeEmptyDOMElement();
  });

  it('draws every section when showLocked is true, including unavailable ones', () => {
    render(<SectionTabStrip view={makeView({ showLocked: true })} onSelect={vi.fn()} canSelect />);
    expect(screen.getByRole('button', { name: /Introduction/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Goals/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Wrap up/ })).toBeInTheDocument();
  });

  it('filters to only isAvailable sections when showLocked is false', () => {
    render(<SectionTabStrip view={makeView({ showLocked: false })} onSelect={vi.fn()} canSelect />);
    expect(screen.getByRole('button', { name: /Introduction/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Goals/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Wrap up/ })).toBeInTheDocument();
  });

  it('renders a nav with aria-label "Sections" for the default strip variant', () => {
    render(<SectionTabStrip view={makeView()} onSelect={vi.fn()} canSelect />);
    expect(screen.getByRole('navigation', { name: 'Sections' })).toBeInTheDocument();
  });

  it('renders the menu variant trigger with the active label and position/total', () => {
    render(<SectionTabStrip view={makeView()} onSelect={vi.fn()} canSelect variant="menu" />);
    // No nav in the menu variant; the trigger button carries the label and count instead.
    expect(screen.queryByRole('navigation', { name: 'Sections' })).not.toBeInTheDocument();
    const trigger = screen.getByRole('button', { name: /Introduction/ });
    expect(trigger).toHaveTextContent('1/3');
  });

  it('falls back to "Sections" on the menu trigger when no tab is active', () => {
    const view = makeView({
      activeKey: null,
      sections: [
        makeTab({ key: 'intro', isActive: false }),
        makeTab({ key: 'goals', label: 'Goals', position: 2, isActive: false }),
      ],
    });
    render(<SectionTabStrip view={view} onSelect={vi.fn()} canSelect variant="menu" />);
    const trigger = screen.getByRole('button', { name: 'Sections' });
    expect(trigger).toBeInTheDocument();
    // No position/total fraction is shown when nothing is active.
    expect(trigger).not.toHaveTextContent('/');
  });

  it('disables a tab button when canSelect is false', () => {
    render(<SectionTabStrip view={makeView()} onSelect={vi.fn()} canSelect={false} />);
    expect(screen.getByRole('button', { name: /Introduction/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Wrap up/ })).toBeDisabled();
  });

  it('disables an unavailable tab button even when canSelect is true', () => {
    render(<SectionTabStrip view={makeView({ showLocked: true })} onSelect={vi.fn()} canSelect />);
    expect(screen.getByRole('button', { name: /Goals/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Introduction/ })).not.toBeDisabled();
  });

  it('sets aria-current="step" only on the active tab', () => {
    render(<SectionTabStrip view={makeView()} onSelect={vi.fn()} canSelect />);
    expect(screen.getByRole('button', { name: /Introduction/ })).toHaveAttribute(
      'aria-current',
      'step'
    );
    expect(screen.getByRole('button', { name: /Wrap up/ })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('button', { name: /Goals/ })).not.toHaveAttribute('aria-current');
  });

  it('shows the Check icon on a closed tab and no lock', () => {
    render(<SectionTabStrip view={makeView({ showLocked: true })} onSelect={vi.fn()} canSelect />);
    const wrapButton = screen.getByRole('button', { name: /Wrap up/ });
    expect(wrapButton.querySelector('svg.lucide-check')).toBeInTheDocument();
    expect(wrapButton.querySelector('svg.lucide-lock')).not.toBeInTheDocument();
  });

  it('shows the Lock icon on an unavailable, non-closed tab', () => {
    render(<SectionTabStrip view={makeView({ showLocked: true })} onSelect={vi.fn()} canSelect />);
    const goalsButton = screen.getByRole('button', { name: /Goals/ });
    expect(goalsButton.querySelector('svg.lucide-lock')).toBeInTheDocument();
    expect(goalsButton.querySelector('svg.lucide-check')).not.toBeInTheDocument();
  });

  it('shows neither icon on an available, not-yet-closed tab', () => {
    render(<SectionTabStrip view={makeView()} onSelect={vi.fn()} canSelect />);
    const introButton = screen.getByRole('button', { name: /Introduction/ });
    expect(introButton.querySelector('svg.lucide-lock')).not.toBeInTheDocument();
    expect(introButton.querySelector('svg.lucide-check')).not.toBeInTheDocument();
  });

  it('includes "part N of M" and ", finished" in the screen-reader text of a closed tab', () => {
    render(<SectionTabStrip view={makeView({ showLocked: true })} onSelect={vi.fn()} canSelect />);
    const wrapButton = screen.getByRole('button', { name: /Wrap up/ });
    expect(wrapButton).toHaveTextContent('(part 3 of 3, finished)');
  });

  it('includes "part N of M" and ", not available yet" in the screen-reader text of a locked tab', () => {
    render(<SectionTabStrip view={makeView({ showLocked: true })} onSelect={vi.fn()} canSelect />);
    const goalsButton = screen.getByRole('button', { name: /Goals/ });
    expect(goalsButton).toHaveTextContent('(part 2 of 3, not available yet)');
  });

  it('omits the finished/locked suffix for an available, not-yet-closed tab', () => {
    render(<SectionTabStrip view={makeView()} onSelect={vi.fn()} canSelect />);
    const introButton = screen.getByRole('button', { name: /Introduction/ });
    expect(introButton).toHaveTextContent('(part 1 of 3)');
  });

  it('calls onSelect with the tab key when an available tab is clicked', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<SectionTabStrip view={makeView()} onSelect={onSelect} canSelect />);

    await user.click(screen.getByRole('button', { name: /Wrap up/ }));

    expect(onSelect).toHaveBeenCalledExactlyOnceWith('wrap');
  });
});
