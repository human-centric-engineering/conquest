// @vitest-environment happy-dom

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
      dataSlotCount={2}
      liveTopicCount={0}
      scopeEnabled={false}
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

  it('does not call the analyst on mount when both autoTriggerPending and candidacy are absent', () => {
    renderCard({ candidacy: null, autoTriggerPending: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('runs itself on mount even with no candidacy verdict — the gate is autoTriggerPending alone', async () => {
    // `candidacy` only drives which banner sentence renders; the effect's own gate (`if
    // (!autoTriggerPending || draft !== null || disabled || autoTriggeredRef.current) return`)
    // never reads it. A prior version of this test set `autoTriggerPending: false` here too, which
    // made it identical to the sibling above and proved nothing about candidacy's role.
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

    renderCard({ candidacy: null, autoTriggerPending: true });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(STREAM_URL, expect.anything()));
    await waitFor(() => expect(screen.getByText('Pipeline')).toBeInTheDocument());
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
        dataSlotCount={2}
        liveTopicCount={0}
        scopeEnabled={false}
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
        dataSlotCount={2}
        liveTopicCount={0}
        scopeEnabled={false}
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

  it('does not render a "Turn into topic" action when the caller has no handler for it', () => {
    renderCard({ initialDraft: draft() });
    expect(screen.queryByRole('button', { name: /Turn into topic/ })).not.toBeInTheDocument();
  });

  it('calls onTurnGapIntoTopic with the gap when "Turn into topic" is clicked (F17.20)', async () => {
    const user = userEvent.setup();
    const onTurnGapIntoTopic = vi.fn();
    renderCard({ initialDraft: draft(), onTurnGapIntoTopic });

    await user.click(screen.getByRole('button', { name: /Turn into topic/ }));

    expect(onTurnGapIntoTopic).toHaveBeenCalledExactlyOnceWith({
      sourceQuote: 'Use judgement for respondents outside these categories.',
      explanation: 'Too vague to test mechanically — no data slot captures "judgement".',
    });
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
          trigger: null,
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

  it('shows an error banner when discarding fails, and keeps the draft on screen', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === DRAFT_URL && init?.method === 'DELETE') {
        return Promise.resolve(
          jsonResponse(
            { success: false, error: { code: 'INTERNAL_ERROR', message: 'Could not delete.' } },
            500
          )
        );
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });

    renderCard({ initialDraft: draft() });
    await user.click(screen.getByRole('button', { name: /Discard/ }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not delete.'));
    // The draft is still there to review — nothing was discarded.
    expect(screen.getByText('Pipeline')).toBeInTheDocument();
  });
});

/**
 * F17.22 Phase 1 — the two additional ways an admin reaches the analyst.
 *
 * Both exist because the ingestion-time candidacy check is deliberately biased to "no": it answers
 * "does this document SAY it routes", not "could this instrument usefully route". Before this, a
 * negative verdict drew nothing at all and the only button lived several screens above the topic
 * list, so the common case — a real instrument whose routing is implicit — had no visible route to
 * the analyst.
 */
describe('RoutingAnalystCard — reaching the analyst when candidacy said no', () => {
  it('explains a negative verdict instead of rendering nothing, and still offers the run', () => {
    renderCard({
      candidacy: { isCandidate: false, confidence: 0.1, summary: 'No routing language found.' },
    });

    expect(
      screen.getByText(/No explicit routing instructions were found in your document/)
    ).toBeInTheDocument();
    // The point of saying so: the analyst can still do the work from the questions alone.
    expect(
      screen.getByText(/still propose conditional topics from the questionnaire’s own questions/)
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Propose topics from the document/ })
    ).toBeInTheDocument();
  });

  it('distinguishes "checked and found nothing" from "never checked"', () => {
    renderCard({ candidacy: null });
    expect(
      screen.getByText(/This version has not been checked for routing instructions/)
    ).toBeInTheDocument();
  });

  it('does not draw the negative note over a positive verdict', () => {
    renderCard({
      candidacy: { isCandidate: true, confidence: 0.9, summary: 'A guardrails tab states rules.' },
    });
    expect(screen.getByText(/This document reads like it describes routing/)).toBeInTheDocument();
    expect(screen.queryByText(/No explicit routing instructions/)).not.toBeInTheDocument();
  });

  it('runs when the Topics section asks it to, and reports errors (unlike a silent auto-run)', async () => {
    fetchMock.mockResolvedValue(
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
    const onRunHandled = vi.fn();

    renderCard({ runRequest: { nonce: 1 }, onRunHandled });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(STREAM_URL, expect.anything()));
    await waitFor(() => expect(screen.getByText('Pipeline')).toBeInTheDocument());
    // The request is consumed, so the parent can drop it and a second press fires again.
    expect(onRunHandled).toHaveBeenCalledTimes(1);
  });

  it('never replaces a pending proposal the admin has not reviewed yet', async () => {
    const onRunHandled = vi.fn();
    renderCard({ initialDraft: draft(), runRequest: { nonce: 1 }, onRunHandled });

    // Scrolling to the pending proposal is the whole response — no run is started over it.
    await waitFor(() => expect(onRunHandled).toHaveBeenCalled());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText('Pipeline')).toBeInTheDocument();
  });

  it('starts nothing while the tab is busy saving', async () => {
    const onRunHandled = vi.fn();
    renderCard({ runRequest: { nonce: 1 }, onRunHandled, disabled: true });

    await waitFor(() => expect(onRunHandled).toHaveBeenCalled());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does nothing at all without a request — the effect is not a mount-time run', () => {
    renderCard({ runRequest: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('RoutingAnalystCard — the settings and corrections a proposal can carry (F17.22)', () => {
  it('names the fallback and blind-spot topics by label, not by key', () => {
    renderCard({
      initialDraft: draft({
        fallbackTopicKeys: ['pipeline'],
        checkTopicPreference: ['pipeline'],
      }),
    });

    expect(screen.getByText(/Ask if nothing matches:/)).toBeInTheDocument();
    expect(screen.getByText(/Sample as a blind spot:/)).toBeInTheDocument();
    // "pipeline" is the key; "Pipeline" is what the admin is reviewing.
    expect(screen.getAllByText(/Pipeline/).length).toBeGreaterThan(0);
  });

  it('says nothing about either when the proposal carries neither', () => {
    renderCard({ initialDraft: draft() });

    expect(screen.queryByText(/Ask if nothing matches:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Sample as a blind spot:/)).not.toBeInTheDocument();
  });

  it('tells the reviewer when a light always-run topic was set back to Full', () => {
    // The correction happens in narrowProposedTopicSet, but it must never be silent: the analyst
    // asked for something that would have dropped questions for every respondent.
    renderCard({ initialDraft: draft({ depthCorrectedKeys: ['pipeline'] }) });

    expect(screen.getByText(/set back to\s+Full/)).toBeInTheDocument();
    expect(screen.getByText(/dropped questions for every respondent/)).toBeInTheDocument();
  });

  it('shows no correction note on a well-formed proposal', () => {
    renderCard({ initialDraft: draft() });
    expect(screen.queryByText(/set back to\s+Full/)).not.toBeInTheDocument();
  });

  it('sends both settings on accept, and never sends `enabled`', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: {}, meta: { forked: false } }));

    renderCard({
      initialDraft: draft({
        fallbackTopicKeys: ['pipeline'],
        checkTopicPreference: ['pipeline'],
      }),
    });

    await user.click(screen.getByRole('button', { name: /accept/i }));
    const confirm = screen.getAllByRole('button', { name: /accept/i }).at(-1);
    if (confirm) await user.click(confirm);

    const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(call).toBeDefined();
    const sent = JSON.parse(String(call?.[1]?.body));
    expect(sent.fallbackTopicKeys).toEqual(['pipeline']);
    expect(sent.checkTopicPreference).toEqual(['pipeline']);
    expect(sent).not.toHaveProperty('enabled');
  });
});

describe('RoutingAnalystCard — the accept dialog offers to turn the feature on (F17.22 Phase 4)', () => {
  /** Accept-dialog POST that resolves, so the payload can be read back off the mock. */
  function mockAcceptOk() {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === DRAFT_URL && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ success: true, data: {}, meta: null }));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });
  }

  function acceptedBody() {
    const [, init] = fetchMock.mock.calls.find(
      ([url, callInit]) => url === DRAFT_URL && (callInit as RequestInit)?.method === 'POST'
    ) as [string, RequestInit];
    return JSON.parse(init.body as string) as Record<string, unknown>;
  }

  it('offers an UNTICKED box, and an untouched accept carries no enable', async () => {
    // The invariant the whole feature sits inside: accepting is authoring, going live is a
    // separate yes. A pre-ticked box would make the second happen as a side effect of the first.
    const user = userEvent.setup();
    mockAcceptOk();
    renderCard({ initialDraft: draft(), scopeEnabled: false });

    await user.click(screen.getByRole('button', { name: /Accept 1 topic/ }));
    const dialog = screen.getByRole('alertdialog');
    const box = within(dialog).getByRole('checkbox', { name: /Turn conditional topics on now/ });
    expect(box).not.toBeChecked();

    await user.click(within(dialog).getByRole('button', { name: /^Accept$/ }));
    await waitFor(() => expect(acceptedBody()).not.toHaveProperty('enable'));
  });

  it('sends enable: true once the admin ticks it', async () => {
    const user = userEvent.setup();
    mockAcceptOk();
    renderCard({ initialDraft: draft(), scopeEnabled: false });

    await user.click(screen.getByRole('button', { name: /Accept 1 topic/ }));
    const dialog = screen.getByRole('alertdialog');
    await user.click(
      within(dialog).getByRole('checkbox', { name: /Turn conditional topics on now/ })
    );
    await user.click(within(dialog).getByRole('button', { name: /^Accept$/ }));

    await waitFor(() => expect(acceptedBody().enable).toBe(true));
  });

  it('forgets a tick that was cancelled rather than accepted', async () => {
    // Reopening the dialog must not carry a previous yes: an admin who cancelled to re-read the
    // proposal would otherwise turn the feature on by pressing Accept the second time.
    const user = userEvent.setup();
    mockAcceptOk();
    renderCard({ initialDraft: draft(), scopeEnabled: false });

    await user.click(screen.getByRole('button', { name: /Accept 1 topic/ }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('checkbox', {
        name: /Turn conditional topics on now/,
      })
    );
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: /Cancel/ })
    );

    await user.click(screen.getByRole('button', { name: /Accept 1 topic/ }));
    expect(
      within(screen.getByRole('alertdialog')).getByRole('checkbox', {
        name: /Turn conditional topics on now/,
      })
    ).not.toBeChecked();
  });

  it('does not offer it when the feature is already on, and says so instead', async () => {
    const user = userEvent.setup();
    renderCard({ initialDraft: draft(), scopeEnabled: true });

    await user.click(screen.getByRole('button', { name: /Accept 1 topic/ }));
    const dialog = screen.getByRole('alertdialog');
    expect(
      within(dialog).queryByRole('checkbox', { name: /Turn conditional topics on now/ })
    ).not.toBeInTheDocument();
    expect(dialog).toHaveTextContent(/already on/i);
    expect(dialog).not.toHaveTextContent(/stays off until you turn it on yourself/i);
  });

  it('does not offer it when the proposal has no conditional topic', async () => {
    // With every topic asked regardless, turning the feature on changes nothing — the box would be
    // an invitation to enable something with no visible effect.
    const user = userEvent.setup();
    const coreOnly = draft();
    renderCard({
      initialDraft: { ...coreOnly, topics: [{ ...coreOnly.topics[0], phase: 'core' }] },
      scopeEnabled: false,
    });

    await user.click(screen.getByRole('button', { name: /Accept 1 topic/ }));
    const dialog = screen.getByRole('alertdialog');
    expect(
      within(dialog).queryByRole('checkbox', { name: /Turn conditional topics on now/ })
    ).not.toBeInTheDocument();
    expect(dialog).toHaveTextContent(/stays off until you turn it on yourself/i);
  });
});

/* -------------------------------------------------------------------------- */
/* Mid-interview triggers (F17.31a)                                           */
/* -------------------------------------------------------------------------- */

describe('RoutingAnalystCard — a proposed trigger', () => {
  const TRIGGERED = {
    key: 'abuse',
    label: 'Domestic abuse',
    phase: 'conditional' as const,
    criteria: 'The opening indicates the applicant is fleeing abuse.',
    depth: 'full' as const,
    members: { questionKeys: ['q1'], dataSlotKeys: [] },
    rationale: 'The document adds this block on disclosure.',
    trigger: {
      condition: 'The applicant discloses that they are fleeing abuse',
      cues: ['abuse'],
      sourceQuote: 'If the applicant discloses, at any stage…',
    },
  };

  it('tells the reviewer what the questionnaire asked for and what will happen instead', () => {
    renderCard({ initialDraft: draft({ topics: [TRIGGERED] }) });

    expect(
      screen.getByText(/The questionnaire says to add this whenever it comes up/)
    ).toBeInTheDocument();
    expect(screen.getAllByText(/fleeing abuse/).length).toBeGreaterThan(0);
    expect(
      screen.getByText(/decides what to cover once, after the opening questions/)
    ).toBeInTheDocument();
  });

  it('posts it with the accepted topic, so the record outlives the proposal', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === DRAFT_URL && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ success: true, data: {}, meta: null }));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });

    renderCard({ initialDraft: draft({ topics: [TRIGGERED] }) });
    await user.click(screen.getByRole('button', { name: /accept/i }));
    const confirm = screen.getAllByRole('button', { name: /accept/i }).at(-1);
    if (confirm) await user.click(confirm);
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) => url === DRAFT_URL && (init as RequestInit)?.method === 'POST'
        )
      ).toBe(true)
    );

    const [, init] = fetchMock.mock.calls.find(
      ([url, callInit]) => url === DRAFT_URL && (callInit as RequestInit)?.method === 'POST'
    ) as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { topics: Record<string, unknown>[] };
    expect(body.topics[0]?.trigger).toEqual(TRIGGERED.trigger);
  });
});

describe('the data-slot dependency, said before the run', () => {
  /**
   * A hard rule decides from one data slot, so the analyst's prompt is told "DATA SLOTS: none.
   * Propose no hard rules" when the version has none — and no ingest path generates data slots, so
   * a freshly uploaded questionnaire is always in that state. Run the analyst first and you get a
   * proposal with no rules, with nothing anywhere saying the order of work was why.
   *
   * Pinned as a NOTICE, not a blocker: proposing topics without data slots is still useful, and the
   * admin may legitimately not want rules at all.
   */
  it('suggests setting up data slots first when the version has none', () => {
    renderCard({ dataSlotCount: 0 });
    expect(screen.getByText(/Consider setting up data slots first/i)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Set up data slots/i })).toBeTruthy();
  });

  it('does not block the run — the analyst is still offered', () => {
    renderCard({ dataSlotCount: 0 });
    const run = screen.getByRole('button', { name: /Propose topics from the/i });
    expect(run.hasAttribute('disabled')).toBe(false);
  });

  it('stays quiet once the version has data slots', () => {
    renderCard({ dataSlotCount: 3 });
    expect(screen.queryByText(/Consider setting up data slots first/i)).toBeNull();
  });

  it('renders the link and its trailing sentence with no stray space before the comma', () => {
    // Regression: a `{' '}` left over from an em-dash rewrite put a literal space between the
    // link and the comma that followed it — "Set up data slots , or carry on…" — invisible to a
    // substring match but visible on screen. Pinned on the exact text content, not a substring.
    renderCard({ dataSlotCount: 0 });
    const link = screen.getByRole('link', { name: /Set up data slots/i });
    expect(link.parentElement?.textContent).toBe(
      'Set up data slots, or carry on and re-run this afterwards to pick up the rest.'
    );
  });
});
