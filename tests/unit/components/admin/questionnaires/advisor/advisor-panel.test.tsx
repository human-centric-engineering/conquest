/**
 * AdvisorPanel component tests.
 *
 * Anti-green-bar: assertions target DOM changes driven by the component's logic —
 * phase transitions after SSE events, narrative accumulation, conflict/suggestion
 * rendering, per-suggestion apply UI, error display, and fork-redirect — not mock
 * return values.
 *
 * Mocking strategy:
 * - fetch is stubbed via vi.stubGlobal so the SSE stream is intercepted.
 * - SSE responses use a ReadableStream that emits crafted event frames.
 * - authoringMutate is mocked; AuthoringError is re-declared in the mock so the
 *   component's instanceof check in applySuggestion's catch block remains valid.
 * - next/navigation's useRouter is mocked.
 * - react-markdown is replaced with a pass-through <div> to make text assertions
 *   independent of Markdown's paragraph/inline element hierarchy.
 * - FieldHelp is stubbed to avoid Radix UI Popover issues in JSDOM.
 *
 * @see components/admin/questionnaires/advisor/advisor-panel.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

const mutateMock = vi.hoisted(() => {
  class AuthoringError extends Error {
    constructor(
      message: string,
      readonly code?: string,
      readonly details?: Record<string, unknown>
    ) {
      super(message);
      this.name = 'AuthoringError';
    }
  }
  return { authoringMutate: vi.fn(), AuthoringError };
});
vi.mock('@/components/admin/questionnaires/authoring-mutate', () => mutateMock);

// Bypass Radix UI Popover in JSDOM — renders children only.
vi.mock('@/components/ui/field-help', () => ({
  FieldHelp: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

// Replace Markdown with a plain-text wrapper so getByText works directly on the
// narrative string without fighting react-markdown's paragraph/inline element tree.
vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <div>{children}</div>,
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import type React from 'react';
import { AdvisorPanel } from '@/components/admin/questionnaires/advisor/advisor-panel';
import { API } from '@/lib/api/endpoints';
import type { VersionGraphView } from '@/lib/app/questionnaire/views';
import { DEFAULT_QUESTIONNAIRE_CONFIG } from '@/lib/app/questionnaire/types';
import type {
  AdvisorConflict,
  AdvisorSuggestion,
} from '@/lib/app/questionnaire/advisor/advisor-schema';

// ─── Graph fixture ────────────────────────────────────────────────────────────

function makeGraph(over: Partial<VersionGraphView> = {}): VersionGraphView {
  return {
    id: 'ver-1',
    questionnaireId: 'qn-1',
    versionNumber: 1,
    status: 'launched',
    goal: null,
    audience: null,
    goalProvenance: null,
    audienceProvenance: null,
    sections: [],
    tags: [],
    config: { ...DEFAULT_QUESTIONNAIRE_CONFIG, saved: true },
    ...over,
  };
}

// ─── SSE helpers ─────────────────────────────────────────────────────────────

function sseFrame(eventType: string, data: unknown): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

function makeSseStream(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame));
      }
      controller.close();
    },
  });
}

function mockSseStream(frames: string[], ok = true, status = 200) {
  const fn = vi.fn().mockResolvedValue({
    ok,
    status,
    body: makeSseStream(frames),
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function mockJsonErrorResponse(message: string, status = 403) {
  const fn = vi.fn().mockResolvedValue({
    ok: false,
    status,
    body: null,
    json: async () => ({ error: { message } }),
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

// ─── Test data fixtures ───────────────────────────────────────────────────────

const CONFLICT: AdvisorConflict = {
  title: 'Voice + attachments both enabled',
  detail: 'Enabling both simultaneously can confuse respondents.',
  settings: ['voiceEnabled', 'attachmentsEnabled'],
  severity: 'warning',
};

const SUGGESTION: AdvisorSuggestion = {
  id: 'sug-1',
  title: 'Disable attachments',
  rationale: 'Respondents rarely use both input modes.',
  severity: 'info',
  patch: { attachmentsEnabled: false },
};

/** Full happy-path SSE sequence: two narrative deltas → analysis → done. */
function makeHappyFrames(
  suggestion: AdvisorSuggestion = SUGGESTION,
  conflict: AdvisorConflict = CONFLICT
): string[] {
  return [
    sseFrame('narrative_delta', { type: 'narrative_delta', text: 'Voice ' }),
    sseFrame('narrative_delta', { type: 'narrative_delta', text: 'and attachments clash.' }),
    sseFrame('narrative_done', { type: 'narrative_done' }),
    sseFrame('analysis', {
      type: 'analysis',
      conflicts: [conflict],
      suggestions: [suggestion],
    }),
    sseFrame('done', { type: 'done' }),
  ];
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AdvisorPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: apply succeeds, no fork.
    mutateMock.authoringMutate.mockResolvedValue({
      data: {},
      meta: { forked: false, versionId: 'ver-1', versionNumber: 1 },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // ── Idle state on mount ─────────────────────────────────────────────────────

  describe('idle state on mount', () => {
    it('renders the "Run advisor" button in the idle state', () => {
      render(<AdvisorPanel questionnaireId="qn-1" graph={makeGraph()} />);
      expect(screen.getByRole('button', { name: /run advisor/i })).toBeInTheDocument();
    });

    it('does NOT call fetch on mount — advisor only runs on demand', () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      render(<AdvisorPanel questionnaireId="qn-1" graph={makeGraph()} />);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('shows no conflicts, suggestions, or errors before a run', () => {
      render(<AdvisorPanel questionnaireId="qn-1" graph={makeGraph()} />);
      expect(screen.queryByText('Conflicts')).not.toBeInTheDocument();
      expect(screen.queryByText('Suggested tweaks')).not.toBeInTheDocument();
    });
  });

  // ── Streaming run ───────────────────────────────────────────────────────────

  describe('streaming run', () => {
    it('shows "Reviewing…" label and disables the button while the stream is open', async () => {
      let releaseStream!: () => void;
      const pending = new Promise<void>((res) => (releaseStream = res));
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          body: new ReadableStream({
            async start(controller) {
              await pending;
              controller.close();
            },
          }),
        })
      );
      const user = userEvent.setup();
      render(<AdvisorPanel questionnaireId="qn-1" graph={makeGraph()} />);

      await user.click(screen.getByRole('button', { name: /run advisor/i }));

      await waitFor(() => expect(screen.getByText('Reviewing…')).toBeInTheDocument());
      expect(screen.getByRole('button', { name: /reviewing/i })).toBeDisabled();

      releaseStream();
    });

    it('POSTs to the advisorStream endpoint with the correct questionnaire and version ids', async () => {
      const fetchMock = mockSseStream(makeHappyFrames());
      const user = userEvent.setup();
      render(
        <AdvisorPanel
          questionnaireId="qn-42"
          graph={makeGraph({ id: 'ver-7', questionnaireId: 'qn-42' })}
        />
      );

      await user.click(screen.getByRole('button', { name: /run advisor/i }));

      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      // Assert the component computed the correct URL — not just that fetch was called.
      expect(url).toBe(API.APP.QUESTIONNAIRES.advisorStream('qn-42', 'ver-7'));
      expect(init.method).toBe('POST');
    });

    it('accumulates narrative_delta text and renders the concatenated narrative', async () => {
      mockSseStream(makeHappyFrames());
      const user = userEvent.setup();
      render(<AdvisorPanel questionnaireId="qn-1" graph={makeGraph()} />);

      await user.click(screen.getByRole('button', { name: /run advisor/i }));

      // Component concatenates "Voice " + "and attachments clash." — the mock Markdown
      // <div> renders the full joined string, proving the component did the accumulation.
      await waitFor(() =>
        expect(screen.getByText('Voice and attachments clash.')).toBeInTheDocument()
      );
    });

    it('renders conflict title and detail from the analysis event', async () => {
      mockSseStream(makeHappyFrames());
      const user = userEvent.setup();
      render(<AdvisorPanel questionnaireId="qn-1" graph={makeGraph()} />);

      await user.click(screen.getByRole('button', { name: /run advisor/i }));

      await waitFor(() => {
        expect(screen.getByText('Voice + attachments both enabled')).toBeInTheDocument();
        expect(
          screen.getByText('Enabling both simultaneously can confuse respondents.')
        ).toBeInTheDocument();
      });
    });

    it('renders suggestion title and rationale from the analysis event', async () => {
      mockSseStream(makeHappyFrames());
      const user = userEvent.setup();
      render(<AdvisorPanel questionnaireId="qn-1" graph={makeGraph()} />);

      await user.click(screen.getByRole('button', { name: /run advisor/i }));

      await waitFor(() => {
        expect(screen.getByText('Disable attachments')).toBeInTheDocument();
        expect(screen.getByText('Respondents rarely use both input modes.')).toBeInTheDocument();
      });
    });

    it('shows the "Re-run advisor" button after the stream completes', async () => {
      mockSseStream(makeHappyFrames());
      const user = userEvent.setup();
      render(<AdvisorPanel questionnaireId="qn-1" graph={makeGraph()} />);

      await user.click(screen.getByRole('button', { name: /run advisor/i }));

      await waitFor(() =>
        expect(screen.getByRole('button', { name: /re-run advisor/i })).toBeInTheDocument()
      );
    });

    it('shows the "no conflicts" message when the analysis is empty', async () => {
      // The clean-run branch (done + empty conflicts + empty suggestions + no error) renders a
      // reassurance line instead of the conflicts/suggestions lists. makeHappyFrames always carries
      // one of each, so this path needs an explicitly-empty analysis frame.
      mockSseStream([
        sseFrame('narrative_delta', {
          type: 'narrative_delta',
          text: 'This configuration is sound.',
        }),
        sseFrame('narrative_done', { type: 'narrative_done' }),
        sseFrame('analysis', { type: 'analysis', conflicts: [], suggestions: [] }),
        sseFrame('done', { type: 'done' }),
      ]);
      const user = userEvent.setup();
      render(<AdvisorPanel questionnaireId="qn-1" graph={makeGraph()} />);

      await user.click(screen.getByRole('button', { name: /run advisor/i }));

      await waitFor(() =>
        expect(screen.getByText(/no conflicts or tweaks suggested/i)).toBeInTheDocument()
      );
      // And neither list heading should render (the section h3s, not the h2 panel title).
      expect(
        screen.queryByRole('heading', { level: 3, name: 'Conflicts' })
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole('heading', { level: 3, name: 'Suggested tweaks' })
      ).not.toBeInTheDocument();
    });

    it('shows an "Apply" button for the suggestion after the analysis event', async () => {
      mockSseStream(makeHappyFrames());
      const user = userEvent.setup();
      render(<AdvisorPanel questionnaireId="qn-1" graph={makeGraph()} />);

      await user.click(screen.getByRole('button', { name: /run advisor/i }));

      await waitFor(() =>
        expect(screen.getByRole('button', { name: /^apply$/i })).toBeInTheDocument()
      );
    });
  });

  // ── Error states ────────────────────────────────────────────────────────────

  describe('error states', () => {
    it('shows the server error message and returns to idle on a non-2xx response', async () => {
      mockJsonErrorResponse('Feature flag disabled', 403);
      const user = userEvent.setup();
      render(<AdvisorPanel questionnaireId="qn-1" graph={makeGraph()} />);

      await user.click(screen.getByRole('button', { name: /run advisor/i }));

      await waitFor(() => {
        expect(screen.getByText('Feature flag disabled')).toBeInTheDocument();
        // Phase returns to idle — button label reverts to "Run advisor"
        expect(screen.getByRole('button', { name: /run advisor/i })).toBeInTheDocument();
      });
    });

    it('shows a fallback error message when the non-2xx body has no error.message', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 429,
          body: null,
          json: async () => ({ success: false }),
        })
      );
      const user = userEvent.setup();
      render(<AdvisorPanel questionnaireId="qn-1" graph={makeGraph()} />);

      await user.click(screen.getByRole('button', { name: /run advisor/i }));

      await waitFor(() =>
        expect(screen.getByText('Advisor run failed (429). Try again.')).toBeInTheDocument()
      );
    });

    it('surfaces a mid-stream error event while preserving already-streamed narrative', async () => {
      const frames = [
        sseFrame('narrative_delta', { type: 'narrative_delta', text: 'Partial narrative.' }),
        sseFrame('error', {
          type: 'error',
          code: 'PROVIDER_UNAVAILABLE',
          message: 'AI provider timed out.',
        }),
      ];
      mockSseStream(frames);
      const user = userEvent.setup();
      render(<AdvisorPanel questionnaireId="qn-1" graph={makeGraph()} />);

      await user.click(screen.getByRole('button', { name: /run advisor/i }));

      await waitFor(() => {
        // Error message must be visible
        expect(screen.getByText('AI provider timed out.')).toBeInTheDocument();
        // Narrative that arrived before the error must remain in the DOM
        expect(screen.getByText('Partial narrative.')).toBeInTheDocument();
      });
    });
  });

  // ── Apply suggestion ────────────────────────────────────────────────────────

  describe('apply suggestion', () => {
    /** Stream to phase=done with one suggestion visible in the panel. */
    async function reachDoneWithSuggestion(
      questionnaireId = 'qn-1',
      versionId = 'ver-1',
      suggestion = SUGGESTION
    ) {
      mockSseStream(makeHappyFrames(suggestion));
      const user = userEvent.setup();
      render(
        <AdvisorPanel
          questionnaireId={questionnaireId}
          graph={makeGraph({ id: versionId, questionnaireId })}
        />
      );
      await user.click(screen.getByRole('button', { name: /run advisor/i }));
      await waitFor(() => screen.getByRole('button', { name: /^apply$/i }));
      return user;
    }

    it('calls authoringMutate with PATCH, the versionConfig URL, and the suggestion patch', async () => {
      const user = await reachDoneWithSuggestion('qn-1', 'ver-1');
      await user.click(screen.getByRole('button', { name: /^apply$/i }));

      await waitFor(() =>
        expect(mutateMock.authoringMutate).toHaveBeenCalledWith(
          'PATCH',
          API.APP.QUESTIONNAIRES.versionConfig('qn-1', 'ver-1'),
          SUGGESTION.patch
        )
      );
    });

    it('marks the Apply button as "Applied" and disables it after a successful apply', async () => {
      const user = await reachDoneWithSuggestion();
      await user.click(screen.getByRole('button', { name: /^apply$/i }));

      await waitFor(() => {
        const btn = screen.getByRole('button', { name: /applied/i });
        expect(btn).toBeInTheDocument();
        expect(btn).toBeDisabled();
      });
    });

    it('marks the panel stale and shows the re-run hint after a successful apply', async () => {
      const user = await reachDoneWithSuggestion();
      await user.click(screen.getByRole('button', { name: /^apply$/i }));

      await waitFor(() => expect(screen.getByText(/Settings changed/i)).toBeInTheDocument());
    });

    it('calls router.replace with the new draft settings path when meta.forked is true', async () => {
      mutateMock.authoringMutate.mockResolvedValueOnce({
        data: {},
        meta: { forked: true, versionId: 'ver-new-999', versionNumber: 2 },
      });
      const user = await reachDoneWithSuggestion('qn-5', 'ver-3');
      await user.click(screen.getByRole('button', { name: /^apply$/i }));

      await waitFor(() =>
        expect(router.replace).toHaveBeenCalledWith(
          '/admin/questionnaires/qn-5/v/ver-new-999/settings'
        )
      );
    });

    it('disables remaining Apply buttons after a fork, so a second click cannot fork the stale version again', async () => {
      // Applying suggestion A on a launched version forks a new draft and redirects; until that
      // navigation settles, versionId still points at the pre-fork version. Other Apply buttons must
      // be locked out so a quick second click cannot PATCH the stale id and spawn a divergent fork.
      mutateMock.authoringMutate.mockResolvedValueOnce({
        data: {},
        meta: { forked: true, versionId: 'ver-new-1', versionNumber: 2 },
      });
      const second: AdvisorSuggestion = { ...SUGGESTION, id: 'sug-2', title: 'Enable tone' };
      mockSseStream([
        sseFrame('narrative_delta', { type: 'narrative_delta', text: 'Review.' }),
        sseFrame('narrative_done', { type: 'narrative_done' }),
        sseFrame('analysis', {
          type: 'analysis',
          conflicts: [],
          suggestions: [SUGGESTION, second],
        }),
        sseFrame('done', { type: 'done' }),
      ]);
      const user = userEvent.setup();
      render(<AdvisorPanel questionnaireId="qn-1" graph={makeGraph()} />);
      await user.click(screen.getByRole('button', { name: /run advisor/i }));
      await waitFor(() =>
        expect(screen.getAllByRole('button', { name: /^apply$/i })).toHaveLength(2)
      );

      await user.click(screen.getAllByRole('button', { name: /^apply$/i })[0]);

      await waitFor(() => expect(router.replace).toHaveBeenCalled());
      // Suggestion A now reads "Applied"; the remaining "Apply" button (suggestion B) is locked.
      expect(screen.getByRole('button', { name: /^apply$/i })).toBeDisabled();
    });

    it('calls router.refresh on a successful apply when there is no fork', async () => {
      mutateMock.authoringMutate.mockResolvedValueOnce({
        data: {},
        meta: { forked: false, versionId: 'ver-1', versionNumber: 1 },
      });
      const user = await reachDoneWithSuggestion();
      await user.click(screen.getByRole('button', { name: /^apply$/i }));

      await waitFor(() => expect(router.refresh).toHaveBeenCalled());
      expect(router.replace).not.toHaveBeenCalled();
    });

    it('shows a per-suggestion error on apply failure and does not mark the suggestion applied', async () => {
      mutateMock.authoringMutate.mockRejectedValueOnce(new Error('Validation failed on server.'));
      const user = await reachDoneWithSuggestion();
      await user.click(screen.getByRole('button', { name: /^apply$/i }));

      await waitFor(() =>
        expect(screen.getByText('Validation failed on server.')).toBeInTheDocument()
      );
      // Apply button must still be present (not replaced by "Applied")
      expect(screen.queryByRole('button', { name: /applied/i })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^apply$/i })).toBeInTheDocument();
    });
  });
});
