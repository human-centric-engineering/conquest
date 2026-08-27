// @vitest-environment happy-dom

/**
 * Unit tests: `ScopeExplainer` — the "How conditional topics works" panel at the top of the tab.
 *
 * Three of its properties are decisions rather than styling, and each has been got wrong at least
 * once, so each is asserted here:
 *
 * - **Collapsed by default, and never persisted.** Persisting it was reverted twice: an admin who
 *   expanded it once to read it was then shown the full panel on every questionnaire forever, and the
 *   stored value silently outranked any later change to the default. A remount must come back closed.
 * - **The heading and one-line summary stay visible while collapsed**, so the panel is still findable
 *   by the person who actually needs it.
 * - **The copy is plain English.** This tab's vocabulary rule says no implementation words on screen —
 *   "instrument" was replaced with "questionnaire" here, and a regression would be invisible to types.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ScopeExplainer } from '@/components/admin/questionnaires/topics/scope-explainer';

/** The four authoring steps, in the order the panel must present them. */
const STEP_TITLES = [
  'Group every question into a topic',
  'Mark the ones that are conditional',
  'Pin anything you are certain about',
  'Switch it on',
];

function toggle() {
  return screen.getByRole('button', { name: /How conditional topics works/ });
}

describe('ScopeExplainer', () => {
  it('starts collapsed, with the heading and summary still readable', () => {
    render(<ScopeExplainer />);

    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('How conditional topics works')).toBeInTheDocument();
    expect(screen.getByText(/Ask each respondent only the parts/)).toBeInTheDocument();
    expect(screen.queryByText(STEP_TITLES[0])).not.toBeInTheDocument();
  });

  it('reveals the four authoring steps, in order, when expanded', async () => {
    const user = userEvent.setup();
    render(<ScopeExplainer />);

    await user.click(toggle());

    expect(toggle()).toHaveAttribute('aria-expanded', 'true');
    const items = screen.getAllByRole('listitem');
    expect(items.map((li) => li.querySelector('p')?.textContent)).toEqual(STEP_TITLES);
  });

  it('numbers the steps, because the order is the thing the controls cannot convey', async () => {
    const user = userEvent.setup();
    render(<ScopeExplainer />);

    await user.click(toggle());

    const numbers = screen.getAllByRole('listitem').map((li) => li.firstElementChild?.textContent);
    expect(numbers).toEqual(['1', '2', '3', '4']);
  });

  it('collapses again on a second click', async () => {
    const user = userEvent.setup();
    render(<ScopeExplainer />);

    await user.click(toggle());
    expect(screen.getByText(STEP_TITLES[0])).toBeInTheDocument();

    await user.click(toggle());
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(STEP_TITLES[0])).not.toBeInTheDocument();
  });

  it('does not persist the expanded state — a remount comes back collapsed', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<ScopeExplainer />);

    await user.click(toggle());
    expect(toggle()).toHaveAttribute('aria-expanded', 'true');
    unmount();

    render(<ScopeExplainer />);
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
  });

  it('says the switch is off until the author says otherwise', async () => {
    const user = userEvent.setup();
    render(<ScopeExplainer />);

    await user.click(toggle());

    expect(screen.getByText('It is off until you say otherwise')).toBeInTheDocument();
    expect(screen.getByText(/Turning it off again restores the full questionnaire/)).toBeVisible();
  });

  it('uses plain English throughout — "questionnaire", never "instrument"', async () => {
    const user = userEvent.setup();
    const { container } = render(<ScopeExplainer />);

    await user.click(toggle());

    expect(container.textContent).not.toMatch(/instrument/i);
    expect(container.textContent).toMatch(/questionnaire/i);
  });

  it('wires the disclosure up for assistive tech', () => {
    render(<ScopeExplainer />);

    expect(toggle()).toHaveAttribute('aria-controls', 'scope-explainer-body');
    expect(screen.getByLabelText('How conditional topics works')).toBeInTheDocument();
  });

  it('passes a caller’s className through to the section', () => {
    const { container } = render(<ScopeExplainer className="mt-8" />);

    expect(container.querySelector('section')?.className).toContain('mt-8');
  });
});

describe('ScopeExplainer — the steps deep-link into the sub-tabs (F17.26)', () => {
  it('sends the two grouping steps to Topics', async () => {
    const user = userEvent.setup();
    const onGoToTab = vi.fn();
    render(<ScopeExplainer onGoToTab={onGoToTab} />);
    await user.click(toggle());

    await user.click(screen.getByRole('button', { name: STEP_TITLES[0] }));
    expect(onGoToTab).toHaveBeenLastCalledWith('topics');

    await user.click(screen.getByRole('button', { name: STEP_TITLES[1] }));
    expect(onGoToTab).toHaveBeenLastCalledWith('topics');
  });

  it('sends the hard-rules step to Rules & limits', async () => {
    const user = userEvent.setup();
    const onGoToTab = vi.fn();
    render(<ScopeExplainer onGoToTab={onGoToTab} />);
    await user.click(toggle());

    await user.click(screen.getByRole('button', { name: STEP_TITLES[2] }));

    expect(onGoToTab).toHaveBeenCalledWith('rules');
  });

  it('leaves "Switch it on" as plain text — it is the header a few pixels above', async () => {
    // A jump would be theatre: the switch is already on screen, above this panel.
    const user = userEvent.setup();
    render(<ScopeExplainer onGoToTab={vi.fn()} />);
    await user.click(toggle());

    expect(screen.queryByRole('button', { name: STEP_TITLES[3] })).not.toBeInTheDocument();
    expect(screen.getByText(STEP_TITLES[3])).toBeInTheDocument();
  });

  it('renders every step as plain text when there is nowhere to send them', async () => {
    const user = userEvent.setup();
    render(<ScopeExplainer />);
    await user.click(toggle());

    for (const title of STEP_TITLES) {
      expect(screen.queryByRole('button', { name: title })).not.toBeInTheDocument();
      expect(screen.getByText(title)).toBeInTheDocument();
    }
  });
});
