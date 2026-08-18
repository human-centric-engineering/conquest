/**
 * Unit tests: `RoutingAnalystCard` — run the Routing Analyst, then review what it proposed
 * (P17.4 / F17.19 Phase 2).
 *
 * Two things carry real weight here:
 *
 *   1. **Gaps render, but never reach the accept payload.** `gaps[]` (F17.19 Phase 2) is advisory —
 *      routing language the analyst recognized but could not formalize. Accepting the proposal must
 *      post only `topics`, `rules` and `maxConditionalTopics`; a regression that spread `draft` into
 *      the accept body would silently try to write gaps as if they were topics.
 *   2. **The evidence, not just the proposal.** `fromDocument`, `sourceQuote` (or its absence) and
 *      the uncovered-question count are what an admin decides on — the SSE round trip and the
 *      rendered review must carry all three through untouched.
 *
 * @see components/admin/questionnaires/topics/routing-analyst-card.tsx
 */

import type { ComponentProps } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const routerMock = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => routerMock }));

import { RoutingAnalystCard } from '@/components/admin/questionnaires/topics/routing-analyst-card';
import { API } from '@/lib/api/endpoints';
import type { ProposedTopicSet, ProposedScopeRule } from '@/lib/app/questionnaire/scope/types';

const RULE: ProposedScopeRule = {
  dataSlotKey: 'headcount',
  operator: 'gt',
  value: '50',
  action: 'include',
  topicKey: 'pipeline',
  rationale: 'Stated as a certainty on the guardrails tab.',
  sourceQuote: 'Always include Pipeline when headcount is over 50.',
};

const QN_ID = 'qn-1';
const VID = 'ver-1';

const STREAM_URL = API.APP.QUESTIONNAIRES.versionTopicsAnalyseStream(QN_ID, VID);
const DRAFT_URL = API.APP.QUESTIONNAIRES.versionTopicsDraft(QN_ID, VID);

function draft(overrides: Partial<ProposedTopicSet> = {}): ProposedTopicSet {
  return {
    v: 1,
    topics: [
      {
        key: 'pipeline',
        label: 'Pipeline',
        phase: 'conditional',
        criteria: 'They named deals stalling.',
        depth: 'full',
        members: { questionKeys: ['q1'], dataSlotKeys: [] },
        rationale: 'The routing tab restricts this to sales-led businesses.',
        sourceQuote: 'Only cover pipeline for sales-led businesses.',
      },
    ],
    rules: [],
    gaps: [
      {
        sourceQuote: 'Use judgement for respondents outside these categories.',
        explanation: 'Too vague to test mechanically — no data slot captures "judgement".',
      },
    ],
    summary: 'Read from the routing tab.',
    fromDocument: true,
    generatedAt: '2026-08-18T00:00:00.000Z',
    ...overrides,
  };
}

const fetchMock = vi.fn();

/** A Response whose body streams the given SSE events, framed exactly as `lib/api/sse.ts` does. */
function sseResponse(events: ({ type: string } & Record<string, unknown>)[]) {
  const encoder = new TextEncoder();
  const frames = events.map((e) =>
    encoder.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
  );
  let i = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () =>
          i < frames.length
            ? { done: false, value: frames[i++] }
            : { done: true, value: undefined },
      }),
    },
  } as unknown as Response;
}

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 300, status, json: async () => body } as unknown as Response;
}

function renderCard(props: Partial<ComponentProps<typeof RoutingAnalystCard>> = {}) {
  return render(
    <RoutingAnalystCard
      questionnaireId={QN_ID}
      versionId={VID}
      initialDraft={null}
      questionKeys={['q1']}
      liveTopicCount={0}
      candidacy={null}
      autoTriggerPending={false}
      {...props}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RoutingAnalystCard — no pending draft', () => {
  it('offers to run the analyst', () => {
    renderCard();
    expect(
      screen.getByRole('button', { name: /Propose topics from the document/ })
    ).toBeInTheDocument();
  });

  it('runs the analysis and renders the returned proposal, gaps included', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((url: string) => {
      if (url === STREAM_URL) {
        return Promise.resolve(
          sseResponse([
            { type: 'phase', phase: 'reading', message: 'Reading…' },
            {
              type: 'done',
              versionId: VID,
              draft: draft(),
              replacedCount: 0,
              uncoveredQuestionCount: 0,
            },
          ])
        );
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });

    renderCard();
    await user.click(screen.getByRole('button', { name: /Propose topics from the document/ }));

    // The proposal itself.
    await waitFor(() => expect(screen.getByText('Pipeline')).toBeInTheDocument());
    expect(
      screen.getByText(/Read from the document’s own routing instructions/)
    ).toBeInTheDocument();
    expect(screen.getByText('Only cover pipeline for sales-led businesses.')).toBeInTheDocument();

    // What the analyst admits it could not formalize.
    expect(screen.getByText(/Recognized but not formalized/)).toBeInTheDocument();
    expect(
      screen.getByText('Use judgement for respondents outside these categories.')
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Too vague to test mechanically — no data slot captures/)
    ).toBeInTheDocument();
  });

  it('shows the error carried by a terminal SSE error event', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((url: string) => {
      if (url === STREAM_URL) {
        return Promise.resolve(
          sseResponse([
            { type: 'error', code: 'ROUTING_ANALYSIS_FAILED', message: 'The model timed out.' },
          ])
        );
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });

    renderCard();
    await user.click(screen.getByRole('button', { name: /Propose topics from the document/ }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('The model timed out.')
    );
  });

  it('shows the server error when starting the run fails (rate limit, unseeded agent, …)', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((url: string) => {
      if (url === STREAM_URL) {
        return Promise.resolve(
          jsonResponse({ error: { message: 'Too many requests, slow down.' } }, 429)
        );
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });

    renderCard();
    await user.click(screen.getByRole('button', { name: /Propose topics from the document/ }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Too many requests, slow down.')
    );
  });

  it('shows an error when the request itself throws (network failure)', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((url: string) => {
      if (url === STREAM_URL) return Promise.reject(new Error('Network down.'));
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });

    renderCard();
    await user.click(screen.getByRole('button', { name: /Propose topics from the document/ }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Network down.'));
  });
});

describe('RoutingAnalystCard — auto-trigger (F17.19 Phase 3)', () => {
  const CANDIDACY = {
    isCandidate: true,
    confidence: 0.82,
    summary: 'The intro page describes screening by role.',
  };

  it('does not call the analyst on mount when autoTriggerPending is false', () => {
    renderCard({ candidacy: CANDIDACY, autoTriggerPending: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not call the analyst on mount when there is no candidacy verdict', () => {
    renderCard({ candidacy: null, autoTriggerPending: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('runs itself on mount when autoTriggerPending is true, without any click', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === STREAM_URL) {
        return Promise.resolve(
          sseResponse([
            {
              type: 'done',
              versionId: VID,
              draft: draft(),
              replacedCount: 0,
              uncoveredQuestionCount: 0,
            },
          ])
        );
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });

    renderCard({ candidacy: CANDIDACY, autoTriggerPending: true });

    // No click — the request fires on its own, and the proposal it returns still renders.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(STREAM_URL, expect.anything()));
    await waitFor(() => expect(screen.getByText('Pipeline')).toBeInTheDocument());
  });

  it('shows a distinct initial status before any phase event arrives', async () => {
    // The first `read()` never resolves, so the component is stuck on whatever `run()` seeded
    // `status` to before the stream produced anything — this is what pins the auto-run's initial
    // label as reachable, rather than being permanently shadowed by the unconditional `setStatus`
    // call at the top of `run()`.
    const release: { current: (() => void) | null } = { current: null };
    const hang = new Promise<void>((resolve) => {
      release.current = resolve;
    });
    fetchMock.mockImplementation((url: string) => {
      if (url === STREAM_URL) {
        return Promise.resolve({
          ok: true,
          status: 200,
          body: {
            getReader: () => ({
              read: async () => {
                await hang;
                return { done: true, value: undefined };
              },
            }),
          },
        } as unknown as Response);
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });

    renderCard({ candidacy: CANDIDACY, autoTriggerPending: true });

    await waitFor(() => expect(screen.getByText('Drafting a proposal…')).toBeInTheDocument());

    release.current?.();
  });

  it('explains the auto-run while it is in flight', async () => {
    // A stream that emits a phase but never a terminal event, so the component stays in its
    // `draft === null` / analysing state long enough to assert the banner.
    const release: { current: (() => void) | null } = { current: null };
    const hang = new Promise<void>((resolve) => {
      release.current = resolve;
    });
    fetchMock.mockImplementation((url: string) => {
      if (url === STREAM_URL) {
        const encoder = new TextEncoder();
        let sentFirst = false;
        return Promise.resolve({
          ok: true,
          status: 200,
          body: {
            getReader: () => ({
              read: async () => {
                if (!sentFirst) {
                  sentFirst = true;
                  return {
                    done: false,
                    value: encoder.encode(
                      `event: phase\ndata: ${JSON.stringify({ type: 'phase', phase: 'reading', message: 'Reading…' })}\n\n`
                    ),
                  };
                }
                await hang;
                return { done: true, value: undefined };
              },
            }),
          },
        } as unknown as Response);
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });

    renderCard({ candidacy: CANDIDACY, autoTriggerPending: true });

    await waitFor(() => expect(screen.getByText('Reading…')).toBeInTheDocument());
    // The banner explains the auto-run rather than leaving the admin wondering why it started.
    expect(screen.getByText(/drafting a starting point automatically/i)).toBeInTheDocument();
    expect(screen.getByText(CANDIDACY.summary)).toBeInTheDocument();

    release.current?.();
  });

  it('fires only once even if the effect re-runs, and never on a re-render alone', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === STREAM_URL) {
        return Promise.resolve(sseResponse([{ type: 'phase', phase: 'reading', message: 'x' }]));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });

    const { rerender } = render(
      <RoutingAnalystCard
        questionnaireId={QN_ID}
        versionId={VID}
        initialDraft={null}
        questionKeys={['q1']}
        liveTopicCount={0}
        candidacy={CANDIDACY}
        autoTriggerPending={true}
      />
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    rerender(
      <RoutingAnalystCard
        questionnaireId={QN_ID}
        versionId={VID}
        initialDraft={null}
        questionKeys={['q1']}
        liveTopicCount={0}
        candidacy={CANDIDACY}
        autoTriggerPending={true}
      />
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not show an error banner when an auto-triggered run fails', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === STREAM_URL) {
        return Promise.resolve(
          jsonResponse({ error: { message: 'Too many requests, slow down.' } }, 429)
        );
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });

    renderCard({ candidacy: CANDIDACY, autoTriggerPending: true });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(STREAM_URL, expect.anything()));
    // Give the (rejected) promise chain a tick to settle.
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    // The banner must not keep claiming a draft is being generated once the attempt has settled —
    // `autoStarted` never resets, so this pins the `analysing` gate that stops it lying forever.
    expect(screen.queryByText(/drafting a starting point automatically/i)).not.toBeInTheDocument();
    expect(screen.getByText('This document reads like it describes routing.')).toBeInTheDocument();
    // The button is still there, ready for the admin to try manually — which reports normally.
    expect(
      screen.getByRole('button', { name: /Propose topics from the document/ })
    ).toBeInTheDocument();
  });

  it('does not show an error banner when an auto-triggered run ends in a terminal SSE error', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === STREAM_URL) {
        return Promise.resolve(
          sseResponse([
            { type: 'error', code: 'ROUTING_ANALYSIS_FAILED', message: 'The model timed out.' },
          ])
        );
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });

    renderCard({ candidacy: CANDIDACY, autoTriggerPending: true });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(STREAM_URL, expect.anything()));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('does not show an error banner when an auto-triggered run throws', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === STREAM_URL) return Promise.reject(new Error('Network down.'));
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });

    renderCard({ candidacy: CANDIDACY, autoTriggerPending: true });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(STREAM_URL, expect.anything()));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('does not auto-run when the card already has a pending draft', () => {
    renderCard({
      candidacy: CANDIDACY,
      autoTriggerPending: true,
      initialDraft: draft(),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('RoutingAnalystCard — reviewing a pending draft', () => {
  it('shows the amber "inferred" banner when fromDocument is false', () => {
    renderCard({ initialDraft: draft({ fromDocument: false, gaps: [] }) });
    expect(screen.getByText(/Inferred from the questionnaire’s structure/)).toBeInTheDocument();
  });

  it('does not render a gaps section when there are none', () => {
    renderCard({ initialDraft: draft({ gaps: [] }) });
    expect(screen.queryByText(/Recognized but not formalized/)).not.toBeInTheDocument();
  });

  it('warns about questions the proposal left in no topic', () => {
    renderCard({ initialDraft: draft(), questionKeys: ['q1', 'q2'] });
    expect(screen.getByText(/1 question would belong to no/)).toBeInTheDocument();
  });

  it('accepts the proposal, posting only topics/rules/maxConditionalTopics — never gaps', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === DRAFT_URL && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ success: true, data: {}, meta: null }));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });

    renderCard({ initialDraft: draft() });
    await user.click(screen.getByRole('button', { name: /Accept 1 topic/ }));

    const dialog = screen.getByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /^Accept$/ }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        DRAFT_URL,
        expect.objectContaining({ method: 'POST', body: expect.any(String) })
      )
    );
    const [, init] = fetchMock.mock.calls.find(
      ([url, callInit]) => url === DRAFT_URL && (callInit as RequestInit)?.method === 'POST'
    ) as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      topics: [
        {
          key: 'pipeline',
          label: 'Pipeline',
          description: null,
          phase: 'conditional',
          criteria: 'They named deals stalling.',
          depth: 'full',
          questionKeys: ['q1'],
          dataSlotKeys: [],
        },
      ],
      rules: [],
    });
    expect(body).not.toHaveProperty('gaps');
  });

  it('renders proposed hard rules and posts them on accept', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === DRAFT_URL && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ success: true, data: {}, meta: null }));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });

    renderCard({ initialDraft: draft({ rules: [RULE] }) });

    expect(screen.getByText('Hard rules')).toBeInTheDocument();
    expect(screen.getByText('headcount', { selector: 'code' })).toBeInTheDocument();
    expect(
      screen.getByText('Always include Pipeline when headcount is over 50.')
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Accept 1 topic/ }));
    const dialog = screen.getByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /^Accept$/ }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        DRAFT_URL,
        expect.objectContaining({ method: 'POST', body: expect.any(String) })
      )
    );
    const [, init] = fetchMock.mock.calls.find(
      ([url, callInit]) => url === DRAFT_URL && (callInit as RequestInit)?.method === 'POST'
    ) as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { rules: unknown[] };
    expect(body.rules).toEqual([
      {
        dataSlotKey: 'headcount',
        operator: 'gt',
        value: '50',
        action: 'include',
        topicKey: 'pipeline',
      },
    ]);
  });

  it('redirects to the forked draft when accepting forks a launched version', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === DRAFT_URL && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({
            success: true,
            data: {},
            meta: { forked: true, versionId: 'ver-2', versionNumber: 2 },
          })
        );
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });

    renderCard({ initialDraft: draft() });
    await user.click(screen.getByRole('button', { name: /Accept 1 topic/ }));
    const dialog = screen.getByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /^Accept$/ }));

    await waitFor(() =>
      expect(routerMock.replace).toHaveBeenCalledWith('/admin/questionnaires/qn-1/v/ver-2/topics')
    );
  });

  it('shows an error banner when accepting fails outright', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === DRAFT_URL && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse(
            { success: false, error: { code: 'TOPIC_KEY_TAKEN', message: 'Could not save.' } },
            400
          )
        );
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });

    renderCard({ initialDraft: draft() });
    await user.click(screen.getByRole('button', { name: /Accept 1 topic/ }));
    const dialog = screen.getByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /^Accept$/ }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not save.'));
  });

  it('closes silently, with no error, when the admin declines the fork confirmation', async () => {
    // No `ForkConfirmProvider` is mounted in this test, so `requestForkConfirm` resolves
    // `confirmed: false` on its own — exactly the "declined" path `authoringMutate` takes on a
    // real 409, without needing to simulate the confirm dialog itself.
    const user = userEvent.setup();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === DRAFT_URL && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse(
            {
              success: false,
              error: {
                code: 'VERSION_FORK_CONFIRMATION_REQUIRED',
                message: 'Editing this launched version will create a new draft.',
                details: {
                  sourceVersionNumber: 3,
                  nextVersionNumber: 4,
                  versions: [{ versionNumber: 3, status: 'launched' }],
                },
              },
            },
            409
          )
        );
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });

    renderCard({ initialDraft: draft() });
    await user.click(screen.getByRole('button', { name: /Accept 1 topic/ }));
    const dialog = screen.getByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /^Accept$/ }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // Nothing was accepted — the draft is still there to review.
    expect(screen.getByText('Pipeline')).toBeInTheDocument();
  });

  it('discards the proposal', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === DRAFT_URL && init?.method === 'DELETE') {
        return Promise.resolve(jsonResponse({ success: true, data: {}, meta: null }));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });

    renderCard({ initialDraft: draft() });
    await user.click(screen.getByRole('button', { name: /Discard/ }));

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /Propose topics from the document/ })
      ).toBeInTheDocument()
    );
  });
});
