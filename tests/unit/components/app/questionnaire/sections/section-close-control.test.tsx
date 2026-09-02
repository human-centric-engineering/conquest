// @vitest-environment happy-dom

/**
 * SectionCloseControl — "finish this section and move on" (P21).
 *
 * Covers: the three null-render guards (inactive, all closed, no active key), the silent vs
 * blocked-copy split when `canClose` is false, the button's "move on to X" vs "finish this
 * section" label, the disabled combinations, the busy spinner vs arrow icon, and the click.
 *
 * @see components/app/questionnaire/sections/section-close-control.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SectionCloseControl } from '@/components/app/questionnaire/sections/section-close-control';
import type { SectionStripView, SectionTabView } from '@/lib/app/questionnaire/sections/view';

function makeTab(overrides: Partial<SectionTabView> = {}): SectionTabView {
  return {
    key: 'intro',
    label: 'Introduction',
    position: 1,
    status: 'not_started',
    isActive: false,
    isAvailable: true,
    finishesActive: false,
    reopenCount: 0,
    ...overrides,
  };
}

function makeView(overrides: Partial<SectionStripView> = {}): SectionStripView {
  return {
    active: true,
    sections: [
      makeTab({ key: 'intro', label: 'Introduction', position: 1, isActive: true }),
      makeTab({ key: 'goals', label: 'Goals', position: 2 }),
    ],
    activeKey: 'intro',
    canClose: true,
    blockedOnRequired: false,
    allClosed: false,
    showLocked: true,
    canGrow: false,
    ...overrides,
  };
}

describe('SectionCloseControl', () => {
  it('renders nothing when the view is not active', () => {
    const { container } = render(
      <SectionCloseControl view={makeView({ active: false })} onClose={vi.fn()} canClose />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when every section is already closed', () => {
    const { container } = render(
      <SectionCloseControl view={makeView({ allClosed: true })} onClose={vi.fn()} canClose />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when there is no active key', () => {
    const { container } = render(
      <SectionCloseControl view={makeView({ activeKey: null })} onClose={vi.fn()} canClose />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when canClose is false and not blocked on a required question', () => {
    const { container } = render(
      <SectionCloseControl
        view={makeView({ canClose: false, blockedOnRequired: false })}
        onClose={vi.fn()}
        canClose
      />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the blocked copy when canClose is false and blockedOnRequired is true', () => {
    render(
      <SectionCloseControl
        view={makeView({ canClose: false, blockedOnRequired: true })}
        onClose={vi.fn()}
        canClose
      />
    );
    expect(
      screen.getByText('There is still one thing needed in this section before you can move on.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders "Move on to {next label}" when a next section exists', () => {
    render(<SectionCloseControl view={makeView({ canClose: true })} onClose={vi.fn()} canClose />);
    expect(screen.getByRole('button', { name: /Move on to Goals/ })).toBeInTheDocument();
  });

  it('names the section the move actually lands in, skipping one already finished', () => {
    // Position + 1 would have named "Goals", which is closed and which the server's own close rule
    // skips straight past. The label has to name where the respondent will land.
    const view = makeView({
      canClose: true,
      sections: [
        makeTab({ key: 'intro', label: 'Introduction', position: 1, isActive: true }),
        makeTab({ key: 'goals', label: 'Goals', position: 2, status: 'closed' }),
        makeTab({ key: 'wrap', label: 'Wrap up', position: 3 }),
      ],
    });
    render(<SectionCloseControl view={view} onClose={vi.fn()} canClose />);
    expect(screen.getByRole('button', { name: /Move on to Wrap up/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Move on to Goals/ })).not.toBeInTheDocument();
  });

  it('renders "Finish this section" when there is no next section', () => {
    const view = makeView({
      canClose: true,
      sections: [makeTab({ key: 'intro', label: 'Introduction', position: 1, isActive: true })],
    });
    render(<SectionCloseControl view={view} onClose={vi.fn()} canClose />);
    expect(screen.getByRole('button', { name: 'Finish this section' })).toBeInTheDocument();
  });

  it('disables the button when the canClose prop is false', () => {
    render(
      <SectionCloseControl view={makeView({ canClose: true })} onClose={vi.fn()} canClose={false} />
    );
    expect(screen.getByRole('button', { name: /Move on to Goals/ })).toBeDisabled();
  });

  it('disables the button when busy is true', () => {
    render(
      <SectionCloseControl view={makeView({ canClose: true })} onClose={vi.fn()} canClose busy />
    );
    expect(screen.getByRole('button', { name: /Move on to Goals/ })).toBeDisabled();
  });

  it('shows the spinner icon and not the arrow icon while busy', () => {
    render(
      <SectionCloseControl view={makeView({ canClose: true })} onClose={vi.fn()} canClose busy />
    );
    const button = screen.getByRole('button', { name: /Move on to Goals/ });
    expect(button.querySelector('svg.lucide-loader-circle')).toBeInTheDocument();
    expect(button.querySelector('svg.lucide-arrow-right')).not.toBeInTheDocument();
  });

  it('shows the arrow icon and not the spinner when not busy', () => {
    render(
      <SectionCloseControl
        view={makeView({ canClose: true })}
        onClose={vi.fn()}
        canClose
        busy={false}
      />
    );
    const button = screen.getByRole('button', { name: /Move on to Goals/ });
    expect(button.querySelector('svg.lucide-arrow-right')).toBeInTheDocument();
    expect(button.querySelector('svg.lucide-loader-circle')).not.toBeInTheDocument();
  });

  it('calls onClose when the button is clicked', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<SectionCloseControl view={makeView({ canClose: true })} onClose={onClose} canClose />);

    await user.click(screen.getByRole('button', { name: /Move on to Goals/ }));

    expect(onClose).toHaveBeenCalledOnce();
  });
});
