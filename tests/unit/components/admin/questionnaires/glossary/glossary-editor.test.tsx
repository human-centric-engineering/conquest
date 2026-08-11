/**
 * GlossaryEditor component tests (P16).
 *
 * Anti-green-bar: drives the surface the way an admin does — add a term, tick a definition, accept,
 * reject, save — and asserts the rendered state and the outbound PUT body, not mock internals.
 *
 * The behaviours worth defending here are the ones that protect the admin from losing work or
 * shipping a broken glossary:
 *   - a duplicate surface is flagged inline, using the SAME normalisation the server rejects on, so
 *     Save is never the first time they hear about it;
 *   - terms are grouped by curation state, because proposals, live terms and rejections are three
 *     different jobs;
 *   - an analysis run is blocked while there are unsaved edits, since the run reloads the list.
 *
 * @see components/admin/questionnaires/glossary/glossary-editor.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const routerMock = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => routerMock }));

import { GlossaryEditor } from '@/components/admin/questionnaires/glossary/glossary-editor';
import type { GlossaryTermView } from '@/lib/app/questionnaire/glossary';

function term(over: Partial<GlossaryTermView> = {}): GlossaryTermView {
  return {
    id: 'term-1',
    term: 'higher self',
    normalizedTerm: 'higher self',
    aliases: [],
    status: 'accepted',
    source: 'ai_proposed',
    rationale: null,
    contextQuote: null,
    ordinal: 0,
    definitions: [
      {
        id: 'def-1',
        text: 'The observing part of you.',
        selected: true,
        source: 'ai_proposed',
        sourceQuote: null,
        edited: false,
        ordinal: 0,
      },
    ],
    ...over,
  };
}

const fetchMock = vi.fn();

/**
 * A Response whose body streams the given SSE events exactly as `lib/api/sse.ts` frames them:
 * an `event:` line naming the type, then the whole object as the `data:` payload. `parseSseBlock`
 * requires BOTH lines and returns null otherwise, so a `data:`-only frame parses to nothing.
 */
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

function okResponse(data: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ success: true, data, meta: null }),
  } as unknown as Response;
}

function renderEditor(initialTerms: GlossaryTermView[] = [], questionCount = 3) {
  return render(
    <GlossaryEditor
      questionnaireId="qn-1"
      versionId="ver-1"
      initialTerms={initialTerms}
      initialDocument={null}
      questionCount={questionCount}
    />
  );
}

/** The body of the last PUT that went out. */
function lastPutBody(): { terms: Array<Record<string, unknown>> } {
  const call = fetchMock.mock.calls.findLast(
    (c) => (c[1] as RequestInit | undefined)?.method === 'PUT'
  );
  return JSON.parse((call?.[1] as RequestInit).body as string);
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockResolvedValue(okResponse({ terms: [] }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GlossaryEditor — rendering', () => {
  it('groups terms by curation state', () => {
    renderEditor([
      term({ id: 't1', term: 'higher self', status: 'accepted' }),
      term({ id: 't2', term: 'ego', normalizedTerm: 'ego', status: 'proposed' }),
      term({ id: 't3', term: 'shadow', normalizedTerm: 'shadow', status: 'rejected' }),
    ]);

    // By role: a settled card carries its own "Accepted"/"Rejected" stamp, so a bare text match
    // would no longer distinguish the group heading from the cards inside it.
    expect(screen.getByRole('heading', { name: /Proposed/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /In use/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Rejected/ })).toBeInTheDocument();
  });

  it('offers to find terms when there are none, and explains hand-authoring', () => {
    renderEditor([]);
    expect(screen.getByRole('button', { name: /Find terms to define/ })).toBeInTheDocument();
    expect(screen.getByText(/No terms yet/)).toBeInTheDocument();
  });

  it('switches the analysis label to a re-run once terms exist', () => {
    renderEditor([term()]);
    expect(screen.getByRole('button', { name: /Re-run analysis/ })).toBeInTheDocument();
    expect(screen.getByText(/keeps everything you have already accepted/)).toBeInTheDocument();
  });

  it('says so when the version has no questions to analyse', () => {
    renderEditor([], 0);
    expect(screen.getByText(/no questions yet/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Find terms to define/ })).toBeDisabled();
  });
});

describe('GlossaryEditor — curation', () => {
  it('adds a hand-authored term and saves it', async () => {
    const user = userEvent.setup();
    renderEditor([]);

    await user.click(screen.getByRole('button', { name: /Add a term/ }));
    await user.type(screen.getByPlaceholderText('The term as it appears in your questions'), 'ego');
    await user.type(screen.getByPlaceholderText(/What this term means/), 'The constructed self.');
    await user.click(screen.getByRole('button', { name: /Save definitions/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(lastPutBody().terms[0]).toMatchObject({
      term: 'ego',
      status: 'accepted',
      source: 'admin',
      definitions: [{ text: 'The constructed self.', selected: true }],
    });
  });

  it('flags a duplicate surface inline, before Save', async () => {
    const user = userEvent.setup();
    // "higher-self" and "higher self" normalise to the same key — the server would reject the
    // save, so the editor must say so first.
    renderEditor([term({ term: 'higher self' })]);

    await user.click(screen.getByRole('button', { name: /Add a term/ }));
    const inputs = screen.getAllByPlaceholderText('The term as it appears in your questions');
    await user.type(inputs[inputs.length - 1], 'higher-self');

    expect(await screen.findByText(/Already defined above/)).toBeInTheDocument();
  });

  it('warns when an accepted term has no definition ticked', () => {
    renderEditor([
      term({
        definitions: [
          {
            id: 'def-1',
            text: 'Nobody ticked this.',
            selected: false,
            source: 'ai_proposed',
            sourceQuote: null,
            edited: false,
            ordinal: 0,
          },
        ],
      }),
    ]);
    // Would otherwise underline to a respondent and open an empty popover.
    expect(screen.getByText(/Tick at least one to accept/)).toBeInTheDocument();
  });

  it('moves a proposed term into "In use" when accepted', async () => {
    const user = userEvent.setup();
    renderEditor([term({ status: 'proposed' })]);

    await user.click(screen.getByRole('button', { name: /^Accept/ }));

    // Accepting settles the term: it moves group AND collapses to a stamped record, so the term
    // reads as text rather than as a form field.
    const inUse = screen.getByRole('heading', { name: /In use/ }).closest('section');
    expect(within(inUse as HTMLElement).getByText('higher self')).toBeInTheDocument();
    expect(within(inUse as HTMLElement).getByText('Accepted')).toBeInTheDocument();
    expect(within(inUse as HTMLElement).queryByDisplayValue('higher self')).not.toBeInTheDocument();
  });

  it('keeps a rejected term in the payload so a re-run does not re-propose it', async () => {
    const user = userEvent.setup();
    renderEditor([term()]);

    await user.click(screen.getByRole('button', { name: /^Reject/ }));
    await user.click(screen.getByRole('button', { name: /Save definitions/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(lastPutBody().terms[0]).toMatchObject({ term: 'higher self', status: 'rejected' });
  });

  it('removes a deleted term from the saved set entirely', async () => {
    const user = userEvent.setup();
    renderEditor([term()]);

    await user.click(screen.getByRole('button', { name: /Delete higher self/ }));
    await user.click(screen.getByRole('button', { name: /Save definitions/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(lastPutBody().terms).toHaveLength(0);
  });
});

describe('GlossaryEditor — save + analyse interaction', () => {
  it('disables Save until something changes', async () => {
    const user = userEvent.setup();
    renderEditor([term()]);

    expect(screen.getByRole('button', { name: /Save definitions/ })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /^Reject/ }));
    expect(screen.getByRole('button', { name: /Save definitions/ })).toBeEnabled();
    expect(screen.getByText(/Unsaved changes/)).toBeInTheDocument();
  });

  it('refuses to analyse over unsaved edits rather than silently discarding them', async () => {
    const user = userEvent.setup();
    renderEditor([term()]);

    await user.click(screen.getByRole('button', { name: /^Reject/ }));
    await user.click(screen.getByRole('button', { name: /Re-run analysis/ }));

    expect(
      await screen.findByText(/Save your changes before running an analysis/)
    ).toBeInTheDocument();
    // Nothing went out — the run would have reloaded the list and lost the edit.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('PUTs to the version-scoped glossary endpoint', async () => {
    const user = userEvent.setup();
    renderEditor([term()]);

    await user.click(screen.getByRole('button', { name: /^Reject/ }));
    await user.click(screen.getByRole('button', { name: /Save definitions/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/app/questionnaires/qn-1/versions/ver-1/glossary');
    expect(init.method).toBe('PUT');
    // Every authoring write opts into the fork-confirmation protocol.
    expect((init.headers as Record<string, string>)['x-fork-confirm']).toBe('prompt');
  });

  it('reports how many terms went live after a save', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(okResponse({ terms: [term()] }));
    renderEditor([term()]);

    await user.click(screen.getByRole('button', { name: /^Reject/ }));
    await user.click(screen.getByRole('button', { name: /Save definitions/ }));

    expect(await screen.findByText(/1 term is now in use/)).toBeInTheDocument();
  });

  it('says plainly when a save leaves nothing in use', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(okResponse({ terms: [term({ status: 'rejected' })] }));
    renderEditor([term()]);

    await user.click(screen.getByRole('button', { name: /^Reject/ }));
    await user.click(screen.getByRole('button', { name: /Save definitions/ }));

    expect(await screen.findByText(/No terms are accepted yet/)).toBeInTheDocument();
  });
});

describe('GlossaryEditor — the analysis run', () => {
  it('renders the proposals the run returned, without needing a page reload', () => {
    // THE REGRESSION. The done event used to carry only counts, and the handler leaned on
    // `router.refresh()` — but `terms` is seeded by a `useState` initialiser that never re-runs,
    // and `refresh()` deliberately preserves client state. The admin saw "Suggested 1 term to
    // review" over a panel still reading "No terms yet".
    const user = userEvent.setup();
    const proposed = term({
      id: 't-new',
      term: 'ego',
      normalizedTerm: 'ego',
      status: 'proposed',
    });
    fetchMock.mockResolvedValue(
      sseResponse([
        { type: 'phase', phase: 'analysing', message: 'Looking…' },
        {
          type: 'done',
          versionId: 'ver-1',
          terms: [proposed],
          proposedCount: 1,
          skippedExistingCount: 0,
          acceptedCount: 0,
        },
      ])
    );

    renderEditor([]);
    return user
      .click(screen.getByRole('button', { name: /Find terms to define/ }))
      .then(async () => {
        expect(await screen.findByText(/Suggested 1 term to review/)).toBeInTheDocument();
        // The proposal is actually on screen, in the Proposed group.
        expect(screen.getByText(/Proposed/)).toBeInTheDocument();
        expect(screen.getByDisplayValue('ego')).toBeInTheDocument();
        expect(screen.queryByText(/No terms yet/)).not.toBeInTheDocument();
      });
  });

  it('distinguishes "nothing new" from "nothing found"', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(
      sseResponse([
        {
          type: 'done',
          versionId: 'ver-1',
          terms: [],
          proposedCount: 0,
          skippedExistingCount: 3,
          acceptedCount: 0,
        },
      ])
    );

    renderEditor([]);
    await user.click(screen.getByRole('button', { name: /Find terms to define/ }));
    expect(await screen.findByText(/already decided on/)).toBeInTheDocument();
  });

  it('surfaces a streamed error rather than reporting success', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(
      sseResponse([
        { type: 'error', code: 'provider_unavailable', message: 'No provider configured.' },
      ])
    );

    renderEditor([]);
    await user.click(screen.getByRole('button', { name: /Find terms to define/ }));
    expect(await screen.findByText(/No provider configured\./)).toBeInTheDocument();
  });

  it('reports a non-2xx start without trying to read a stream', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ error: { message: 'Too many analyses. Try again shortly.' } }),
    });

    renderEditor([]);
    await user.click(screen.getByRole('button', { name: /Find terms to define/ }));
    expect(await screen.findByText(/Too many analyses/)).toBeInTheDocument();
  });
});
