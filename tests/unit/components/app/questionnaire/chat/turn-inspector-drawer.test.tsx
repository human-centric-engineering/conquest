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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TurnInspectorDrawer } from '@/components/app/questionnaire/chat/turn-inspector-drawer';
import type { TurnInspectorData } from '@/lib/app/questionnaire/inspector';
import { apiClient } from '@/lib/api/client';
import type { TurnEvaluation } from '@/lib/app/questionnaire/turn-evaluation';

// The Evaluate flow posts the turn dump through apiClient; stub it so no network is hit.
vi.mock('@/lib/api/client', () => ({
  apiClient: { post: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

const mockPost = vi.mocked(apiClient.post);

/** A complete verdict the stubbed route returns. */
const sampleVerdict: TurnEvaluation = {
  overallScore: 82,
  effectiveness: 'Good',
  calls: [
    {
      name: 'Answer extraction',
      purpose: 'Map the answer to slots',
      score: 80,
      instructionCompliance: 'Followed the schema and confidence bands.',
      outputQuality: 'Correct and useful.',
      risks: 'Minor over-inference risk.',
      improvements: 'Tighten the confidence rubric.',
    },
  ],
  interviewer: {
    openEndedness: 8,
    singleTopicFocus: 9,
    nonLeading: 7,
    conversational: 8,
    cognitiveLoad: 9,
    specificity: 7,
    warmth: 8,
    stageAlignment: 8,
    violations: [],
  },
  extraction: {
    score: 84,
    confidenceQuality: 'reasonable',
    coverage: 'Captured the housing slot.',
    missedSignals: 'None of note.',
    overreach: 'None.',
  },
  questionSelection: {
    score: 79,
    relevance: 'Built on the prior answer.',
    coverageStrategy: 'Advanced coverage.',
    timing: 'Right moment.',
    alternatives: 'Could have probed tenure.',
  },
  informationGain: { rating: 'Medium', analysis: 'One slot filled.' },
  missedOpportunities: 'A follow-up on cost burden.',
  promptDrift: { rating: 'None', evidence: [] },
  efficiency: { rating: 'Good', analysis: 'Two calls, both justified.' },
  summary: {
    strengths: ['Clear question'],
    weaknesses: ['Slightly leading'],
    biggestRisk: 'Over-inference',
    biggestOpportunity: 'Probe cost burden',
    recommendedAction: 'Tighten the extractor confidence rubric',
  },
};

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
  render(<TurnInspectorDrawer turns={turns} sessionId="sess_test" />);
  await user.click(screen.getByRole('button', { name: /open the admin turn inspector/i }));
}

describe('TurnInspectorDrawer', () => {
  it('starts closed: shows the edge tab (with call-count badge), not the open drawer', () => {
    render(<TurnInspectorDrawer turns={turns} sessionId="sess_test" />);
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
        sessionId="sess_test"
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

  describe('turn evaluation', () => {
    beforeEach(() => {
      mockPost.mockReset();
    });

    // These tests stub global clipboard / URL plumbing (jsdom lacks it). Restore originals after
    // each so a stub can't leak into sibling tests in this or other files.
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    afterEach(() => {
      const restore = (
        target: object,
        prop: string,
        desc: PropertyDescriptor | undefined
      ): void => {
        if (desc) Object.defineProperty(target, prop, desc);
        else delete (target as Record<string, unknown>)[prop];
      };
      restore(navigator, 'clipboard', originalClipboard);
      restore(URL, 'createObjectURL', originalCreateObjectURL);
      restore(URL, 'revokeObjectURL', originalRevokeObjectURL);
    });

    it('runs the evaluator and renders the scored verdict', async () => {
      const user = userEvent.setup();
      mockPost.mockResolvedValue({ verdict: sampleVerdict, costUsd: 0.004, model: 'claude-x' });
      await renderOpen(user);

      // The latest turn is expanded by default, so the Evaluate button is visible.
      await user.click(screen.getByRole('button', { name: /evaluate turn/i }));

      // Posted to the evaluate-turn route for this session, carrying the turn dump.
      expect(mockPost).toHaveBeenCalledTimes(1);
      const [path, opts] = mockPost.mock.calls[0];
      expect(path).toContain('/questionnaire-sessions/sess_test/evaluate-turn');
      expect((opts as { body: { turn: TurnInspectorData } }).body.turn.turnIndex).toBe(0);

      // Headline chips + interviewer sub-scores render with their specific values.
      expect(await screen.findByText('82/100')).toBeInTheDocument();
      expect(screen.getAllByText('Good').length).toBeGreaterThan(0);
      expect(screen.getByText('84/100')).toBeInTheDocument(); // extraction score chip
      // All eight interviewer sub-scores render: 8/10 ×4, 9/10 ×2, 7/10 ×2 (sums to 8).
      expect(screen.getAllByText('8/10')).toHaveLength(4);
      expect(screen.getAllByText('9/10')).toHaveLength(2);
      expect(screen.getAllByText('7/10')).toHaveLength(2);
    });

    it('sends the turn conversation context (respondent + interviewer + recent), walking past a leading greeting', async () => {
      const user = userEvent.setup();
      mockPost.mockResolvedValue({
        verdict: sampleVerdict,
        costUsd: 0.004,
        model: 'claude-x',
        evaluationId: 'eval-1',
      });
      // A leading assistant greeting precedes the first user message — so index*2 math would
      // mis-map; the robust walk must still pick the first USER message as the respondent.
      const messages = [
        { role: 'assistant' as const, content: 'Welcome! Tell me about your home.' },
        { role: 'user' as const, content: 'I rent a flat' },
        { role: 'assistant' as const, content: 'And whereabouts is that?' },
      ];
      render(<TurnInspectorDrawer turns={turns} sessionId="sess_test" messages={messages} />);
      await user.click(screen.getByRole('button', { name: /open the admin turn inspector/i }));
      await user.click(screen.getByRole('button', { name: /evaluate turn/i }));

      const [, opts] = mockPost.mock.calls[0];
      const body = (
        opts as {
          body: {
            respondentMessage?: string;
            interviewerMessage?: string;
            recentMessages?: string[];
          };
        }
      ).body;
      expect(body.respondentMessage).toBe('I rent a flat');
      expect(body.interviewerMessage).toBe('And whereabouts is that?');
      expect(body.recentMessages).toEqual(['Interviewer: Welcome! Tell me about your home.']);
    });

    it('omits conversation context when no messages are supplied', async () => {
      const user = userEvent.setup();
      mockPost.mockResolvedValue({ verdict: sampleVerdict, costUsd: 0.004, model: 'claude-x' });
      await renderOpen(user); // renders without the messages prop
      await user.click(screen.getByRole('button', { name: /evaluate turn/i }));

      const [, opts] = mockPost.mock.calls[0];
      const body = (opts as { body: Record<string, unknown> }).body;
      expect(body).not.toHaveProperty('respondentMessage');
      expect(body).not.toHaveProperty('interviewerMessage');
      expect(body).not.toHaveProperty('recentMessages');
    });

    it('surfaces an error when the evaluation fails, without crashing the drawer', async () => {
      const user = userEvent.setup();
      mockPost.mockRejectedValue(new Error('Turn evaluation failed'));
      await renderOpen(user);

      await user.click(screen.getByRole('button', { name: /evaluate turn/i }));

      expect(await screen.findByText(/turn evaluation failed/i)).toBeInTheDocument();
      // The trigger is still available to retry.
      expect(screen.getByRole('button', { name: /evaluate turn/i })).toBeInTheDocument();
    });

    it('downloads the verdict as a turn-scoped Markdown file', async () => {
      const user = userEvent.setup();
      // jsdom has no Blob URL plumbing — stub it and capture the triggered download.
      const createObjectURL = vi.fn(() => 'blob:turn-eval');
      const revokeObjectURL = vi.fn();
      Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
      Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true });
      const clicks: Array<{ download: string; href: string }> = [];
      const realCreate = document.createElement.bind(document);
      const createSpy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
        const el = realCreate(tag);
        if (tag === 'a') {
          el.click = () =>
            clicks.push({
              download: (el as HTMLAnchorElement).download,
              href: (el as HTMLAnchorElement).href,
            });
        }
        return el;
      });

      mockPost.mockResolvedValue({ verdict: sampleVerdict, costUsd: 0.004, model: 'claude-x' });
      await renderOpen(user);
      await user.click(screen.getByRole('button', { name: /evaluate turn/i }));
      await screen.findByText('82/100');
      await user.click(
        screen.getByRole('button', { name: /download turn 1 evaluation as markdown/i })
      );

      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(clicks).toHaveLength(1);
      expect(clicks[0].download).toBe('turn-1-evaluation.md');
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:turn-eval');
      createSpy.mockRestore();
    });

    it('re-runs the evaluation when Re-run is clicked', async () => {
      const user = userEvent.setup();
      mockPost.mockResolvedValue({ verdict: sampleVerdict, costUsd: 0.004, model: 'claude-x' });
      await renderOpen(user);
      await user.click(screen.getByRole('button', { name: /evaluate turn/i }));
      await screen.findByText('82/100');

      await user.click(screen.getByRole('button', { name: /re-run the evaluation for turn 1/i }));

      expect(mockPost).toHaveBeenCalledTimes(2);
    });

    it('copies the verdict as the same Markdown the serializer produces', async () => {
      const user = userEvent.setup();
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      mockPost.mockResolvedValue({ verdict: sampleVerdict, costUsd: 0.004, model: 'claude-x' });
      await renderOpen(user);

      await user.click(screen.getByRole('button', { name: /evaluate turn/i }));
      await screen.findByText('82/100');
      await user.click(
        screen.getByRole('button', { name: /copy turn 1 evaluation to clipboard/i })
      );

      const text = writeText.mock.calls[0][0] as string;
      expect(text).toContain('# Turn 1 — Evaluation');
      expect(text).toContain('Overall Score: 82');
      expect(text).toContain('## Call-by-Call Evaluation');
    });
  });
});
