/**
 * TurnInspectorDrawer (admin-only) component tests.
 *
 * Drives the drawer the way an admin does — it auto-opens when data arrives, lists turns with
 * their call counts, and expands a call to reveal its model/cost metrics + raw prompt/response.
 * Asserts the admin-only labelling is present (the feature's whole point is that it's not for
 * respondents).
 *
 * @see components/app/questionnaire/chat/turn-inspector-drawer.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TurnInspectorDrawer } from '@/components/app/questionnaire/chat/turn-inspector-drawer';
import type { TurnInspectorData } from '@/lib/app/questionnaire/inspector';

const turns: TurnInspectorData[] = [
  {
    turnIndex: 0,
    calls: [
      {
        label: 'Answer extraction',
        model: 'gpt-4o-mini',
        provider: 'openai',
        latencyMs: 412,
        costUsd: 0.0013,
        tokensIn: 900,
        tokensOut: 40,
        prompt: [{ role: 'input', content: '{"userMessage":"I rent a flat"}' }],
        response: '{"intents":[{"slotKey":"housing"}]}',
      },
      {
        label: 'Interviewer phrasing',
        model: 'gpt-4o-mini',
        provider: 'openai',
        latencyMs: 800,
        costUsd: 0.0007,
        prompt: [{ role: 'system', content: 'You are a warm interviewer.' }],
        response: 'And whereabouts is that?',
      },
    ],
  },
];

describe('TurnInspectorDrawer', () => {
  it('auto-opens, is labelled admin-only, and lists the turn with its call count', () => {
    render(<TurnInspectorDrawer turns={turns} />);
    expect(screen.getByText(/not shown to respondents/i)).toBeInTheDocument();
    expect(screen.getAllByText(/admin only/i).length).toBeGreaterThan(0);
    expect(screen.getByText('Turn 1')).toBeInTheDocument();
    expect(screen.getByText('2 calls')).toBeInTheDocument();
  });

  it('expands a call to reveal its model, cost, and raw prompt + response', async () => {
    const user = userEvent.setup();
    render(<TurnInspectorDrawer turns={turns} />);

    // The latest turn is expanded by default, so the call rows are visible; expand the first call.
    await user.click(screen.getByText('Answer extraction'));

    expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument();
    // The raw prompt (the dispatched input) and the raw response are both shown verbatim.
    expect(screen.getByText(/"userMessage":"I rent a flat"/)).toBeInTheDocument();
    expect(screen.getByText(/"intents":\[\{"slotKey":"housing"\}\]/)).toBeInTheDocument();
  });

  describe('copy to clipboard', () => {
    /**
     * Stub navigator.clipboard *after* userEvent.setup() — setup() installs its own clipboard stub,
     * so defining ours first would be clobbered. Returns the spy the component's onClick will hit.
     */
    function mockClipboard() {
      const writeText = vi.fn().mockResolvedValue(undefined);
      // navigator.clipboard is a getter-only property in jsdom — define it rather than assign.
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      return writeText;
    }

    it('copies every turn (with the session header) via the header "Copy all" button', async () => {
      const user = userEvent.setup();
      const writeText = mockClipboard();
      render(<TurnInspectorDrawer turns={turns} />);

      await user.click(screen.getByRole('button', { name: /copy all turns to clipboard/i }));

      expect(writeText).toHaveBeenCalledTimes(1);
      const text = writeText.mock.calls[0][0] as string;
      expect(text).toContain('=== Turn Inspector — 1 turn, 2 agent calls ===');
      expect(text).toContain('Answer extraction');
      expect(text).toContain('Interviewer phrasing');
    });

    it('copies a single turn via its per-turn copy button', async () => {
      const user = userEvent.setup();
      const writeText = mockClipboard();
      render(<TurnInspectorDrawer turns={turns} />);

      await user.click(screen.getByRole('button', { name: /copy turn 1 to clipboard/i }));

      const text = writeText.mock.calls[0][0] as string;
      expect(text).toContain('Turn 1 — 2 calls');
      // A single-turn copy omits the all-turns session banner.
      expect(text).not.toContain('=== Turn Inspector');
    });

    it('copies a single call via the copy button in its expanded body', async () => {
      const user = userEvent.setup();
      const writeText = mockClipboard();
      render(<TurnInspectorDrawer turns={turns} />);

      // Expand the first call so its copy affordance is visible.
      await user.click(screen.getByText('Answer extraction'));
      await user.click(screen.getByRole('button', { name: /copy the "Answer extraction" call/i }));

      const text = writeText.mock.calls[0][0] as string;
      expect(text).toContain('Answer extraction');
      expect(text).toContain('{"intents":[{"slotKey":"housing"}]}');
      // One call only — the sibling call must not be included.
      expect(text).not.toContain('Interviewer phrasing');
    });

    it('flips the button to a "Copied" state after a successful copy', async () => {
      const user = userEvent.setup();
      mockClipboard();
      render(<TurnInspectorDrawer turns={turns} />);

      const copyAll = screen.getByRole('button', { name: /copy all turns to clipboard/i });
      expect(within(copyAll).queryByText(/copied/i)).not.toBeInTheDocument();
      await user.click(copyAll);
      expect(within(copyAll).getByText(/copied/i)).toBeInTheDocument();
    });
  });

  it('collapses to a tab that can reopen the drawer', async () => {
    const user = userEvent.setup();
    render(<TurnInspectorDrawer turns={turns} />);
    await user.click(screen.getByRole('button', { name: /close the turn inspector/i }));
    const reopen = screen.getByRole('button', { name: /open the admin turn inspector/i });
    expect(reopen).toBeInTheDocument();
    await user.click(reopen);
    // Drawer is open again — its close affordance is back, the collapsed tab is gone.
    expect(screen.getByRole('button', { name: /close the turn inspector/i })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /open the admin turn inspector/i })
    ).not.toBeInTheDocument();
  });
});
