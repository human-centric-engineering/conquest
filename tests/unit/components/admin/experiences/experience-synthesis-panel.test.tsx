/**
 * ExperienceSynthesisPanel — the experience-wide synthesis read/generate panel (P15.8).
 *
 * Covers: the never-generated empty state, rendering a stored synthesis (narrative, findings,
 * divergences, per-step coverage, caveats), the Generate click's loading/disabled state and the
 * refreshed result it lands, the 409 NOTHING_TO_SYNTHESISE path, a generic generation failure, and
 * that a persisted `status: 'failed'` view renders its warning rather than being mistaken for a
 * clean success.
 *
 * fetch is stubbed globally and returns real `Response`-shaped objects — `parseApiResponse` only
 * calls `.json()`, so a `{ json }` stub is enough; there is no need to mock `next/navigation` or
 * `@/lib/api/client` here, unlike the sibling step-form test, because this component talks to
 * `fetch` + `parseApiResponse` directly rather than through `apiClient`.
 *
 * @see components/admin/experiences/experience-synthesis-panel.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ExperienceSynthesisPanel } from '@/components/admin/experiences/experience-synthesis-panel';
import type { ExperienceSynthesisContent } from '@/lib/app/questionnaire/experiences/synthesis/types';

/** Mirrors the component's internal (unexported) `SynthesisView` / persist.ts `ExperienceSynthesisView` shape. */
interface SynthesisViewFixture {
  exists: boolean;
  status: 'queued' | 'processing' | 'ready' | 'failed';
  content: ExperienceSynthesisContent | null;
  coveredSteps: number;
  eligibleSteps: number;
  costUsd: number | null;
  error: string | null;
  generatedAt: string | null;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A fetch `Response`-shaped stub — `parseApiResponse` only reads `.json()`. */
function jsonResponse(body: unknown) {
  return { json: () => Promise.resolve(body) };
}

function emptyView(): SynthesisViewFixture {
  return {
    exists: false,
    status: 'queued',
    content: null,
    coveredSteps: 0,
    eligibleSteps: 0,
    costUsd: null,
    error: null,
    generatedAt: null,
  };
}

function fullContent(): ExperienceSynthesisContent {
  return {
    narrative: 'The population split cleanly on tenure.\n\nNewer joiners were more optimistic.',
    findings: [
      {
        statement: 'Most respondents wanted faster onboarding.',
        detail: 'Raised independently in two of three steps.',
        sourceStepKeys: ['step-intro', 'step-followup'],
      },
    ],
    divergences: [
      {
        statement: 'Managers and practitioners disagreed on priority.',
        detail: null,
        sourceStepKeys: [],
      },
    ],
    coverage: [
      { stepKey: 'step-intro', stepTitle: 'Shared opening', included: true, reason: 'included' },
      {
        stepKey: 'step-followup',
        stepTitle: 'Manager follow-up',
        included: false,
        reason: 'no_report',
      },
    ],
    caveats: ['Only nine respondents reached the follow-up step.'],
  };
}

function readyView(overrides: Partial<SynthesisViewFixture> = {}): SynthesisViewFixture {
  return {
    exists: true,
    status: 'ready',
    content: fullContent(),
    coveredSteps: 1,
    eligibleSteps: 2,
    costUsd: 0.0123,
    error: null,
    generatedAt: '2026-07-01T12:00:00.000Z',
    ...overrides,
  };
}

/** Queues the initial GET on mount. Every test needs exactly one of these before rendering. */
function queueInitialLoad(view: SynthesisViewFixture) {
  fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: view }));
}

describe('ExperienceSynthesisPanel', () => {
  describe('never generated yet', () => {
    it('shows the empty-state prompt and a Generate button, not synthesis content', async () => {
      queueInitialLoad(emptyView());

      render(<ExperienceSynthesisPanel experienceId="exp-1" isMeeting={false} />);

      expect(
        await screen.findByText(/not generated yet/i, undefined, { timeout: 3000 })
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^generate$/i })).toBeInTheDocument();
      expect(screen.queryByText(/^narrative$/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/^coverage$/i)).not.toBeInTheDocument();
    });

    it('uses breakout vocabulary for a meeting rather than step vocabulary', async () => {
      queueInitialLoad(emptyView());

      render(<ExperienceSynthesisPanel experienceId="exp-1" isMeeting />);

      expect(
        await screen.findByText(/generate the individual breakout reports/i)
      ).toBeInTheDocument();
    });
  });

  describe('rendering a stored synthesis', () => {
    it('renders the narrative, findings, divergences, coverage, and caveats from the stored view', async () => {
      queueInitialLoad(readyView());

      render(<ExperienceSynthesisPanel experienceId="exp-1" isMeeting={false} />);

      // Narrative — split into paragraphs on the blank line.
      expect(
        await screen.findByText('The population split cleanly on tenure.')
      ).toBeInTheDocument();
      expect(screen.getByText('Newer joiners were more optimistic.')).toBeInTheDocument();

      // Findings — statement, detail, and the verified source step keys.
      expect(screen.getByText('Most respondents wanted faster onboarding.')).toBeInTheDocument();
      expect(screen.getByText('Raised independently in two of three steps.')).toBeInTheDocument();
      expect(screen.getByText('step-intro')).toBeInTheDocument();
      expect(screen.getByText('step-followup')).toBeInTheDocument();

      // Divergence.
      expect(
        screen.getByText('Managers and practitioners disagreed on priority.')
      ).toBeInTheDocument();

      // Coverage — count, per-step title and reason label.
      expect(screen.getByText('This synthesis covers 1 of 2 step(s).')).toBeInTheDocument();
      expect(screen.getByText('Shared opening')).toBeInTheDocument();
      expect(screen.getByText('Included')).toBeInTheDocument();
      expect(screen.getByText('Manager follow-up')).toBeInTheDocument();
      expect(screen.getByText('No report generated yet')).toBeInTheDocument();

      // Caveats.
      expect(
        screen.getByText('Only nine respondents reached the follow-up step.')
      ).toBeInTheDocument();

      // Generated-at + cost footer. (Not `/generated/i` alone — "No report generated yet" in the
      // coverage list also matches that pattern.)
      expect(screen.getByText(/^Generated /)).toBeInTheDocument();
      expect(screen.getByText(/\$0\.0123/)).toBeInTheDocument();

      // Button reads "Regenerate" once content exists, not "Generate".
      expect(screen.getByRole('button', { name: /regenerate/i })).toBeInTheDocument();
    });

    it('uses breakout(s) wording in the coverage summary for a meeting', async () => {
      queueInitialLoad(readyView());

      render(<ExperienceSynthesisPanel experienceId="exp-1" isMeeting />);

      expect(
        await screen.findByText('This synthesis covers 1 of 2 breakout(s).')
      ).toBeInTheDocument();
    });

    it('omits optional sections entirely when the stored content has none of them', async () => {
      const minimal: ExperienceSynthesisContent = {
        narrative: '',
        findings: [],
        divergences: [],
        coverage: [],
        caveats: [],
      };
      queueInitialLoad(readyView({ content: minimal, generatedAt: null, costUsd: null }));

      render(<ExperienceSynthesisPanel experienceId="exp-1" isMeeting={false} />);

      // The Card renders (Regenerate is available because `content` is non-null), but every
      // optional section is absent rather than rendering as an empty heading.
      await screen.findByRole('button', { name: /regenerate/i });
      expect(screen.queryByText(/^narrative$/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/^findings$/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/^divergence$/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/^coverage$/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/^caveats$/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/generated/i)).not.toBeInTheDocument();
    });
  });

  describe('clicking Generate', () => {
    it('disables the button and shows a writing state, then renders the refreshed result', async () => {
      const user = userEvent.setup();
      queueInitialLoad(emptyView());

      // The POST response is held open under our control so the loading state is observable.
      let resolvePost!: (value: { json: () => Promise<unknown> }) => void;
      const postResponse = new Promise<{ json: () => Promise<unknown> }>((resolve) => {
        resolvePost = resolve;
      });
      fetchMock.mockReturnValueOnce(postResponse);

      render(<ExperienceSynthesisPanel experienceId="exp-1" isMeeting={false} />);
      const button = await screen.findByRole('button', { name: /^generate$/i });

      await user.click(button);

      // Mid-flight: disabled, and the label switches to the writing state.
      await waitFor(() => expect(screen.getByRole('button', { name: /writing/i })).toBeDisabled());

      // Release the POST with the refreshed synthesis.
      resolvePost(jsonResponse({ success: true, data: readyView() }));

      // Landed: content renders, button re-enables and reads Regenerate (not stuck on Writing).
      expect(
        await screen.findByText('The population split cleanly on tenure.')
      ).toBeInTheDocument();
      const finalButton = screen.getByRole('button', { name: /regenerate/i });
      expect(finalButton).not.toBeDisabled();

      // Confirms the button actually POSTed to the generate endpoint, not the read endpoint again.
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        '/api/v1/app/experiences/exp-1/synthesis/generate',
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  describe('the 409 NOTHING_TO_SYNTHESISE path', () => {
    it('surfaces the server error message on a 409 with no eligible step reports', async () => {
      const user = userEvent.setup();
      queueInitialLoad(emptyView());
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          success: false,
          error: {
            message: 'No step has a finished report to synthesise yet',
            code: 'NOTHING_TO_SYNTHESISE',
            details: {
              coverage: [
                {
                  stepKey: 'step-intro',
                  stepTitle: 'Shared opening',
                  included: false,
                  reason: 'no_report',
                },
                {
                  stepKey: 'step-followup',
                  stepTitle: 'Manager follow-up',
                  included: false,
                  reason: 'no_report',
                },
              ],
            },
          },
        })
      );

      render(<ExperienceSynthesisPanel experienceId="exp-1" isMeeting={false} />);
      await user.click(await screen.findByRole('button', { name: /^generate$/i }));

      expect(
        await screen.findByText('No step has a finished report to synthesise yet')
      ).toBeInTheDocument();

      // The route attaches `error.details.coverage` specifically so the panel can name which steps
      // are missing ("Answering 409 with the coverage attached lets the panel say exactly which
      // steps are missing rather than 'something went wrong'" —
      // app/api/v1/app/experiences/[id]/synthesis/generate/route.ts). Naming the gaps is the whole
      // point of the status code, so the per-step titles must reach the screen.
      expect(await screen.findByText('Shared opening')).toBeInTheDocument();
      expect(screen.getByText('Manager follow-up')).toBeInTheDocument();
    });

    it('degrades to the plain message when the 409 carries no usable coverage', async () => {
      // `details` is an untrusted payload. A malformed or absent one must leave the reader with the
      // server's sentence rather than throwing and blanking the panel.
      const user = userEvent.setup();
      queueInitialLoad(emptyView());
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          success: false,
          error: {
            message: 'No step has a finished report to synthesise yet',
            code: 'NOTHING_TO_SYNTHESISE',
            details: { coverage: 'not-an-array' },
          },
        })
      );

      render(<ExperienceSynthesisPanel experienceId="exp-1" isMeeting={false} />);
      await user.click(await screen.findByRole('button', { name: /^generate$/i }));

      expect(
        await screen.findByText('No step has a finished report to synthesise yet')
      ).toBeInTheDocument();
      expect(screen.queryByText(/waiting on these steps/i)).not.toBeInTheDocument();
    });
  });

  describe('a generic generation failure', () => {
    it('surfaces the error message without touching the (absent) content', async () => {
      const user = userEvent.setup();
      queueInitialLoad(emptyView());
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          success: false,
          error: { message: 'Synthesis generation failed', code: 'GENERATION_FAILED' },
        })
      );

      render(<ExperienceSynthesisPanel experienceId="exp-1" isMeeting={false} />);
      await user.click(await screen.findByRole('button', { name: /^generate$/i }));

      expect(await screen.findByText('Synthesis generation failed')).toBeInTheDocument();
      // Still the empty-state prompt underneath the error — no content was ever set.
      expect(screen.getByText(/not generated yet/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^generate$/i })).toBeInTheDocument();
    });

    it('reports a network-level failure with its own message when fetch rejects', async () => {
      const user = userEvent.setup();
      queueInitialLoad(emptyView());
      fetchMock.mockRejectedValueOnce(new Error('network down'));

      render(<ExperienceSynthesisPanel experienceId="exp-1" isMeeting={false} />);
      await user.click(await screen.findByRole('button', { name: /^generate$/i }));

      expect(await screen.findByText('Generation failed.')).toBeInTheDocument();
    });
  });

  describe('a stale/failed persisted state', () => {
    it('renders the failure warning alongside the previous synthesis, not as a clean success', async () => {
      queueInitialLoad(
        readyView({
          status: 'failed',
          error: 'The model timed out after 30s.',
        })
      );

      render(<ExperienceSynthesisPanel experienceId="exp-1" isMeeting={false} />);

      // The failed-regeneration warning names the underlying error.
      expect(
        await screen.findByText(/the last regeneration failed, so this is the previous synthesis/i)
      ).toBeInTheDocument();
      expect(screen.getByText(/the model timed out after 30s/i)).toBeInTheDocument();

      // The previous (still-valid) synthesis is what's shown underneath — this is not an empty or
      // broken screen, and the panel offers Regenerate, not Generate, because content still exists.
      expect(screen.getByText('The population split cleanly on tenure.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /regenerate/i })).toBeInTheDocument();

      // Exactly one warning banner — the persisted-failure notice — not a second, generic
      // component-level error banner layered on top of it.
      const warnings = screen.getAllByText(/the model timed out after 30s/i);
      expect(warnings).toHaveLength(1);
    });
  });
});
