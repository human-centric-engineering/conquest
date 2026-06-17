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

/** Render the drawer and open it from the collapsed edge tab (it now starts closed). */
async function renderOpen(user: ReturnType<typeof userEvent.setup>) {
  render(<TurnInspectorDrawer turns={turns} />);
  await user.click(screen.getByRole('button', { name: /open the admin turn inspector/i }));
}

describe('TurnInspectorDrawer', () => {
  it('starts closed: shows the edge tab (with call-count badge), not the open drawer', () => {
    render(<TurnInspectorDrawer turns={turns} />);
    // The collapsed tab is the reachable affordance; the close button (inside the open drawer) is not.
    expect(
      screen.getByRole('button', { name: /open the admin turn inspector/i })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /close the turn inspector/i })
    ).not.toBeInTheDocument();
    // Badge on the edge tab reflects the captured call count even while closed.
    const tab = screen.getByRole('button', { name: /open the admin turn inspector/i });
    expect(within(tab).getByText('2')).toBeInTheDocument();
  });

  it('opens from the edge tab: labelled admin-only and lists the turn with its call count', async () => {
    const user = userEvent.setup();
    await renderOpen(user);
    expect(screen.getByText(/not shown to respondents/i)).toBeInTheDocument();
    expect(screen.getAllByText(/admin only/i).length).toBeGreaterThan(0);
    expect(screen.getByText('Turn 1')).toBeInTheDocument();
    expect(screen.getByText('2 calls')).toBeInTheDocument();
  });

  it('shows a session summary header (turns, calls, total cost, tokens)', async () => {
    const user = userEvent.setup();
    await renderOpen(user);
    // Summary stat labels are present…
    expect(screen.getByText('Total cost')).toBeInTheDocument();
    expect(screen.getByText('Tokens in/out')).toBeInTheDocument();
    // …and the token rollup sums both calls (900+0 in / 40+0 out).
    expect(screen.getByText('900 / 40')).toBeInTheDocument();
  });

  it('renders an embedding call distinctly (VEC chip, Dimensions metric, Ranking block)', async () => {
    const user = userEvent.setup();
    render(
      <TurnInspectorDrawer
        turns={[
          {
            turnIndex: 0,
            calls: [
              {
                kind: 'embedding',
                label: 'Extraction candidate ranking',
                model: 'text-embedding-3-small',
                provider: 'openai',
                latencyMs: 41,
                costUsd: 0.0000012,
                tokensIn: 12,
                dimensions: 1536,
                prompt: [{ role: 'input', content: 'Embedded (query): "I rent a flat"' }],
                response: 'Ranked 62 questions → kept 25.',
              },
            ],
          },
        ]}
      />
    );
    await user.click(screen.getByRole('button', { name: /open the admin turn inspector/i }));
    expect(screen.getByText('VEC')).toBeInTheDocument();

    await user.click(screen.getByText('Extraction candidate ranking'));
    expect(screen.getByText('Dimensions')).toBeInTheDocument();
    expect(screen.getByText('1,536')).toBeInTheDocument();
    // The embedding's output block is labelled "Ranking", not "Response".
    expect(screen.getByText('Ranking')).toBeInTheDocument();
    expect(screen.queryByText('Response')).not.toBeInTheDocument();
  });

  it('expands a call to reveal its model, cost, and raw prompt + response', async () => {
    const user = userEvent.setup();
    await renderOpen(user);

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
      await renderOpen(user);

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
      await renderOpen(user);

      await user.click(screen.getByRole('button', { name: /copy turn 1 to clipboard/i }));

      const text = writeText.mock.calls[0][0] as string;
      expect(text).toContain('Turn 1 — 2 calls');
      // A single-turn copy omits the all-turns session banner.
      expect(text).not.toContain('=== Turn Inspector');
    });

    it('copies a single call via the copy button in its expanded body', async () => {
      const user = userEvent.setup();
      const writeText = mockClipboard();
      await renderOpen(user);

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
      await renderOpen(user);

      const copyAll = screen.getByRole('button', { name: /copy all turns to clipboard/i });
      expect(within(copyAll).queryByText(/copied/i)).not.toBeInTheDocument();
      await user.click(copyAll);
      expect(within(copyAll).getByText(/copied/i)).toBeInTheDocument();
    });
  });

  it('toggles between the open drawer and the collapsed tab', async () => {
    const user = userEvent.setup();
    await renderOpen(user);
    // Open: the close affordance is present, the tab is gone.
    expect(screen.getByRole('button', { name: /close the turn inspector/i })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /open the admin turn inspector/i })
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /close the turn inspector/i }));
    // Collapsed again: the tab is back.
    expect(
      screen.getByRole('button', { name: /open the admin turn inspector/i })
    ).toBeInTheDocument();
  });
});
