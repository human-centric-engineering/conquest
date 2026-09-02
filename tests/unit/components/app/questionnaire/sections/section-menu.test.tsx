// @vitest-environment happy-dom

/**
 * SectionMenu — where the respondent is, and the way to somewhere else (P21).
 *
 * Covers: the two null-render guards (inactive view, empty visible list), what the trigger says
 * when a section is active and when none is, the `showLocked` filter, and the row behaviour
 * (disabled state, `aria-current`, status icon, screen-reader text, click).
 *
 * Almost everything here has to OPEN the menu first, which is the point of the redesign: the list
 * is out of the way until it is asked for. The trigger is what a respondent sees the rest of the
 * time, so it gets assertions of its own.
 *
 * @see components/app/questionnaire/sections/section-menu.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SectionMenu } from '@/components/app/questionnaire/sections/section-menu';
import { RespondentSurfaceProvider } from '@/components/app/questionnaire/chat/respondent-surface-context';
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
      makeTab({ key: 'goals', label: 'Goals', position: 2, isAvailable: false }),
      makeTab({ key: 'wrap', label: 'Wrap up', position: 3, status: 'closed', isAvailable: true }),
    ],
    activeKey: 'intro',
    canClose: false,
    blockedOnRequired: false,
    allClosed: false,
    showLocked: true,
    canGrow: false,
    ...overrides,
  };
}

/** Render, press the trigger, and hand back the list. */
async function openMenu(
  view: SectionStripView = makeView(),
  props: Partial<{ canSelect: boolean; onSelect: (key: string) => void }> = {}
) {
  const user = userEvent.setup();
  const onSelect = props.onSelect ?? vi.fn();
  render(<SectionMenu view={view} onSelect={onSelect} canSelect={props.canSelect ?? true} />);
  // The trigger's accessible name is the active section's label, so it is found by role rather
  // than by text — there is exactly one button on screen before the menu opens.
  await user.click(screen.getByRole('button'));
  return {
    user,
    onSelect,
    // The rows, scoped to their group...
    list: within(screen.getByRole('group', { name: 'Sections' })),
    // ...and the whole panel, for the heading and the note, which sit outside that group.
    panel: within(screen.getByRole('dialog')),
  };
}

describe('SectionMenu', () => {
  it('renders nothing when the view is not active', () => {
    const { container } = render(
      <SectionMenu view={makeView({ active: false })} onSelect={vi.fn()} canSelect />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the visible section list is empty', () => {
    // showLocked=false with every section unavailable leaves nothing to offer.
    const view = makeView({
      showLocked: false,
      sections: [makeTab({ key: 'only', isAvailable: false, isActive: false })],
    });
    const { container } = render(<SectionMenu view={view} onSelect={vi.fn()} canSelect />);
    expect(container).toBeEmptyDOMElement();
  });

  describe('the trigger, which is all a respondent sees until they ask', () => {
    it('names the current section and its place in the run', () => {
      // The whole brief: say where they are, and say it once. The count is what a tab strip used to
      // convey by being visible, and it survives because "2 of 5" is the part that orients.
      render(<SectionMenu view={makeView()} onSelect={vi.fn()} canSelect />);
      const trigger = screen.getByRole('button');
      expect(trigger).toHaveTextContent('Introduction');
      expect(trigger).toHaveTextContent('1 of 3');
    });

    it('falls back to "Sections" with no count when nothing is active', () => {
      // Before the first section opens. A count would have to invent a position to show.
      const view = makeView({
        activeKey: null,
        sections: [
          makeTab({ key: 'intro', isActive: false }),
          makeTab({ key: 'goals', label: 'Goals', position: 2, isActive: false }),
        ],
      });
      render(<SectionMenu view={view} onSelect={vi.fn()} canSelect />);
      const trigger = screen.getByRole('button');
      expect(trigger).toHaveTextContent('Sections');
      expect(trigger).not.toHaveTextContent(' of ');
    });

    it('keeps the list shut until it is pressed', () => {
      render(<SectionMenu view={makeView()} onSelect={vi.fn()} canSelect />);
      expect(screen.queryByRole('group', { name: 'Sections' })).not.toBeInTheDocument();
    });
  });

  it('lists every section when showLocked is true, including unavailable ones', async () => {
    const { list } = await openMenu(makeView({ showLocked: true }));
    expect(list.getByRole('button', { name: /Introduction/ })).toBeInTheDocument();
    expect(list.getByRole('button', { name: /Goals/ })).toBeInTheDocument();
    expect(list.getByRole('button', { name: /Wrap up/ })).toBeInTheDocument();
  });

  it('filters to only isAvailable sections when showLocked is false', async () => {
    const { list } = await openMenu(makeView({ showLocked: false }));
    expect(list.getByRole('button', { name: /Introduction/ })).toBeInTheDocument();
    expect(list.queryByRole('button', { name: /Goals/ })).not.toBeInTheDocument();
    expect(list.getByRole('button', { name: /Wrap up/ })).toBeInTheDocument();
  });

  it('disables every row while a turn is in flight', async () => {
    // Moving mid-stream would strand the reply that is still arriving.
    const { list } = await openMenu(makeView(), { canSelect: false });
    expect(list.getByRole('button', { name: /Introduction/ })).toBeDisabled();
    expect(list.getByRole('button', { name: /Wrap up/ })).toBeDisabled();
  });

  it('disables an unavailable section even when a turn is not in flight', async () => {
    const { list } = await openMenu(makeView({ showLocked: true }));
    expect(list.getByRole('button', { name: /Goals/ })).toBeDisabled();
    expect(list.getByRole('button', { name: /Introduction/ })).not.toBeDisabled();
  });

  it('leaves the onward section unlocked once the active one can be finished', async () => {
    // The reported bug: "Move on to Growth Strategy" beside a Growth Strategy row with a padlock on
    // it. `finishesActive` is what the builder sets on that one row, and the list has to honour it
    // the same as any other reachable section.
    const view = makeView({
      canClose: true,
      sections: [
        makeTab({ key: 'intro', label: 'Introduction', position: 1, isActive: true }),
        makeTab({ key: 'goals', label: 'Goals', position: 2, finishesActive: true }),
        makeTab({ key: 'wrap', label: 'Wrap up', position: 3, isAvailable: false }),
      ],
    });
    const { list } = await openMenu(view);
    const goals = list.getByRole('button', { name: /Goals/ });
    expect(goals).not.toBeDisabled();
    expect(goals.querySelector('svg.lucide-lock')).not.toBeInTheDocument();
    expect(goals).toHaveTextContent('(part 2 of 3)');
    // Everything past it stays behind unfinished ground.
    expect(list.getByRole('button', { name: /Wrap up/ })).toBeDisabled();
  });

  it('shuts the list when a section is picked', async () => {
    // Radix closes a popover on an outside press or Escape, and a row is neither: the list stayed
    // open over the section it had just moved to, covering the reply arriving underneath it.
    const onSelect = vi.fn();
    const { list } = await openMenu(makeView(), { onSelect });

    await userEvent.click(list.getByRole('button', { name: /Wrap up/ }));

    expect(onSelect).toHaveBeenCalledWith('wrap');
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'Sections' })).not.toBeInTheDocument()
    );
  });

  it('sets aria-current="step" only on the section they are in', async () => {
    // The list is shut most of the time, so this is how the current section is announced rather
    // than merely tinted.
    const { list } = await openMenu();
    expect(list.getByRole('button', { name: /Introduction/ })).toHaveAttribute(
      'aria-current',
      'step'
    );
    expect(list.getByRole('button', { name: /Wrap up/ })).not.toHaveAttribute('aria-current');
    expect(list.getByRole('button', { name: /Goals/ })).not.toHaveAttribute('aria-current');
  });

  it('shows the Check icon on a finished section and no lock', async () => {
    const { list } = await openMenu(makeView({ showLocked: true }));
    const wrap = list.getByRole('button', { name: /Wrap up/ });
    expect(wrap.querySelector('svg.lucide-check')).toBeInTheDocument();
    expect(wrap.querySelector('svg.lucide-lock')).not.toBeInTheDocument();
  });

  it('shows the Lock icon on an unavailable, unfinished section', async () => {
    const { list } = await openMenu(makeView({ showLocked: true }));
    const goals = list.getByRole('button', { name: /Goals/ });
    expect(goals.querySelector('svg.lucide-lock')).toBeInTheDocument();
    expect(goals.querySelector('svg.lucide-check')).not.toBeInTheDocument();
  });

  it('shows neither icon on an available, unfinished section', async () => {
    const view = makeView({
      sections: [
        makeTab({ key: 'intro', label: 'Introduction', position: 1, isActive: false }),
        makeTab({ key: 'goals', label: 'Goals', position: 2, isActive: true }),
      ],
    });
    const { list } = await openMenu(view);
    const intro = list.getByRole('button', { name: /Introduction/ });
    expect(intro.querySelector('svg.lucide-lock')).not.toBeInTheDocument();
    expect(intro.querySelector('svg.lucide-check')).not.toBeInTheDocument();
  });

  it('includes "part N of M" and ", finished" in the screen-reader text of a finished section', async () => {
    const { list } = await openMenu(makeView({ showLocked: true }));
    expect(list.getByRole('button', { name: /Wrap up/ })).toHaveTextContent(
      '(part 3 of 3, finished)'
    );
  });

  it('includes "part N of M" and ", not available yet" for a locked section', async () => {
    const { list } = await openMenu(makeView({ showLocked: true }));
    expect(list.getByRole('button', { name: /Goals/ })).toHaveTextContent(
      '(part 2 of 3, not available yet)'
    );
  });

  it('omits the finished/locked suffix for an available, unfinished section', async () => {
    const { list } = await openMenu();
    expect(list.getByRole('button', { name: /Introduction/ })).toHaveTextContent('(part 1 of 3)');
  });

  describe('the "more may appear" note', () => {
    it('is shown when the list can still grow', async () => {
      // Conditional Topics seats new topics as the plan lands, so a section really can appear after
      // the respondent has already read the list. Without the note, one that turns up later reads
      // as the interview changing its mind.
      const { panel } = await openMenu(makeView({ canGrow: true }));
      expect(panel.getByText(/More sections can appear/i)).toBeInTheDocument();
    });

    it('is absent on a fixed instrument', async () => {
      // The reason it is a view field rather than always-on copy: here it would be a promise the
      // questionnaire cannot keep, and someone who read it would go on waiting for a section that
      // is never coming.
      const { panel } = await openMenu(makeView({ canGrow: false }));
      expect(panel.queryByText(/More sections can appear/i)).not.toBeInTheDocument();
    });
  });

  describe('the way back, when they have moved off where the interview was', () => {
    /**
     * A run whose first section is finished, the second is open and unfinished, and the respondent
     * has gone back into the first to add something. "Where the interview continues" is the second;
     * they are in the first.
     */
    function wentBack(): SectionStripView {
      return makeView({
        activeKey: 'intro',
        sections: [
          makeTab({
            key: 'intro',
            label: 'Introduction',
            position: 1,
            status: 'closed',
            isActive: true,
          }),
          makeTab({ key: 'goals', label: 'Goals', position: 2, status: 'in_progress' }),
          makeTab({ key: 'wrap', label: 'Wrap up', position: 3 }),
        ],
      });
    }

    it('offers the way back, naming where the interview continues', () => {
      // Named rather than "Back", because "back" from a list the respondent chose from is not
      // obviously a place. It is the FIRST unfinished section, which is the same rule the view
      // builder uses to decide what a sequential run may move to next.
      render(<SectionMenu view={wentBack()} onSelect={vi.fn()} canSelect />);
      expect(screen.getByRole('button', { name: /Back to Goals/ })).toBeInTheDocument();
    });

    it('moves the conversation back when it is pressed', async () => {
      const user = userEvent.setup();
      const onSelect = vi.fn();
      render(<SectionMenu view={wentBack()} onSelect={onSelect} canSelect />);

      await user.click(screen.getByRole('button', { name: /Back to Goals/ }));

      expect(onSelect).toHaveBeenCalledExactlyOnceWith('goals');
    });

    it('is disabled while a turn is in flight', async () => {
      // Same rule as the rows: moving mid-stream would strand the reply still arriving.
      render(<SectionMenu view={wentBack()} onSelect={vi.fn()} canSelect={false} />);
      expect(screen.getByRole('button', { name: /Back to Goals/ })).toBeDisabled();
    });

    it('is absent on a straight run through', async () => {
      // The common case, and the reason this is not a permanent control: the section they are in IS
      // where the interview continues, so there is nowhere to go back to.
      render(<SectionMenu view={makeView()} onSelect={vi.fn()} canSelect />);
      expect(screen.queryByRole('button', { name: /Back to/ })).not.toBeInTheDocument();
    });

    it('is absent before the first section has opened', async () => {
      // No active section means they have not moved away from one. Offering to send them to the
      // section they are about to start anyway would be a control that does nothing.
      const view = makeView({
        activeKey: null,
        sections: [
          makeTab({ key: 'intro', isActive: false }),
          makeTab({ key: 'goals', position: 2 }),
        ],
      });
      render(<SectionMenu view={view} onSelect={vi.fn()} canSelect />);
      expect(screen.queryByRole('button', { name: /Back to/ })).not.toBeInTheDocument();
    });

    it('is absent once every section is finished', async () => {
      // There is nothing left to continue to; the completion offer is the affordance that matters.
      const view = makeView({
        activeKey: 'intro',
        allClosed: true,
        sections: [
          makeTab({ key: 'intro', position: 1, status: 'closed', isActive: true }),
          makeTab({ key: 'goals', label: 'Goals', position: 2, status: 'closed' }),
        ],
      });
      render(<SectionMenu view={view} onSelect={vi.fn()} canSelect />);
      expect(screen.queryByRole('button', { name: /Back to/ })).not.toBeInTheDocument();
    });
  });

  describe('wearing the respondent surface through the portal', () => {
    // Radix portals the list to document.body, OUTSIDE the BrandThemeProvider div that carries
    // `data-surface="respondent"` and the client's `--app-*` variables. Without re-applying them
    // here every colour in the list resolves to a platform fallback: the accent mark and the focus
    // ring come out in the platform primary, and the paper reverts to the surrounding ConQuest
    // consumer brand — a cream-and-blue menu in the middle of a client's magenta questionnaire.

    async function openBranded() {
      const user = userEvent.setup();
      render(
        <RespondentSurfaceProvider
          attrs={{
            'data-surface': 'respondent',
            'data-design': 'rounded',
            style: { '--app-accent-color': '#e6007e' } as React.CSSProperties,
          }}
        >
          <SectionMenu view={makeView()} onSelect={vi.fn()} canSelect />
        </RespondentSurfaceProvider>
      );
      await user.click(screen.getByRole('button'));
      return screen.getByRole('dialog');
    }

    it('marks the portalled list as the respondent surface', async () => {
      expect(await openBranded()).toHaveAttribute('data-surface', 'respondent');
    });

    it('carries the client brand variables onto the portalled list', async () => {
      // Asserted as "the accent survived the portal" rather than by matching a whole style string,
      // which would break on any unrelated token being added to the theme.
      expect((await openBranded()).getAttribute('style')).toContain('--app-accent-color');
    });

    // NOT asserted here: that the `color-mix` tints themselves land on the same element. happy-dom
    // validates colour values and silently drops a `color-mix()` it cannot parse, so the assertion
    // would fail against a component that is correct in every browser. The ordering it would have
    // guarded (surface variables spread first, tints second, since the tints read those variables
    // off the same element) is stated in the component instead.

    it('renders without a provider above it (the admin replay has no brand to wear)', async () => {
      const { panel } = await openMenu();
      expect(panel.getByText('Introduction')).toBeInTheDocument();
    });
  });

  it('calls onSelect with the section key when an available row is clicked', async () => {
    const onSelect = vi.fn();
    const { user, list } = await openMenu(makeView(), { onSelect });

    await user.click(list.getByRole('button', { name: /Wrap up/ }));

    expect(onSelect).toHaveBeenCalledExactlyOnceWith('wrap');
  });
});
