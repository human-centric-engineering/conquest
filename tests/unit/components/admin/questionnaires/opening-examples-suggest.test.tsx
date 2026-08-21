/**
 * OpeningExamplesSuggest component tests.
 *
 * Anti-green-bar: drives the dialog the way an admin does (open → read → add → retry) and asserts
 * the DOM plus the `onAdd` payload and the outbound request. The endpoint is mocked at the `fetch`
 * boundary, which is what `apiClient` uses.
 *
 * The properties worth pinning are the ones that make an AI affordance safe to put in an editor:
 * it proposes rather than applies, it shows its reasoning, and it does not silently spend twice.
 *
 * @see components/admin/questionnaires/opening-examples-suggest.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { OpeningExamplesSuggest } from '@/components/admin/questionnaires/opening-examples-suggest';
import { API } from '@/lib/api/endpoints';

const SUGGESTIONS = [
  {
    text: 'Tell me about your experience of working here — anything that stands out.',
    why: 'Wide and easy; most people can answer it immediately.',
  },
  {
    text: 'If you had a blank page to describe the last year, what would you write?',
    why: 'Suits people who think better without a frame.',
  },
];

function mockFetch(payload: unknown, ok = true): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 502,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () =>
      ok
        ? { success: true, data: payload }
        : {
            success: false,
            error: { code: 'OPENING_EXAMPLES_SUGGEST_FAILED', message: 'Nope.' },
          },
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function renderSuggest(over: Partial<Parameters<typeof OpeningExamplesSuggest>[0]> = {}) {
  const onAdd = vi.fn();
  render(
    <OpeningExamplesSuggest
      questionnaireId="qn-1"
      versionId="v1"
      addedTexts={new Set()}
      onAdd={onAdd}
      {...over}
    />
  );
  return { onAdd };
}

const openDialog = async () => {
  await userEvent.setup().click(screen.getByRole('button', { name: /Suggest openers/ }));
};

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('OpeningExamplesSuggest', () => {
  it('fetches from the version-scoped suggest endpoint when opened', async () => {
    const fetchMock = mockFetch({ suggestions: SUGGESTIONS });
    renderSuggest();
    await openDialog();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain(API.APP.QUESTIONNAIRES.openingExamplesSuggest('qn-1', 'v1'));
    expect(init?.method).toBe('POST');
  });

  it('shows each proposal with its reasoning', async () => {
    mockFetch({ suggestions: SUGGESTIONS });
    renderSuggest();
    await openDialog();

    expect(await screen.findByText(SUGGESTIONS[0].text)).toBeInTheDocument();
    // The `why` gets equal billing: the admin is choosing, not rubber-stamping.
    expect(screen.getByText(SUGGESTIONS[0].why)).toBeInTheDocument();
    expect(screen.getByText(SUGGESTIONS[1].text)).toBeInTheDocument();
  });

  /** Propose-then-accept: nothing reaches the editor until the admin clicks Add. */
  it('emits only the accepted opener, and only on Add', async () => {
    mockFetch({ suggestions: SUGGESTIONS });
    const { onAdd } = renderSuggest();
    await openDialog();

    await screen.findByText(SUGGESTIONS[0].text);
    expect(onAdd).not.toHaveBeenCalled();

    const row = screen.getByText(SUGGESTIONS[0].text).closest('div')?.parentElement as HTMLElement;
    await userEvent.setup().click(within(row).getByRole('button', { name: /Add/ }));
    expect(onAdd).toHaveBeenCalledExactlyOnceWith(SUGGESTIONS[0].text);
  });

  it('has no "add all" affordance', async () => {
    mockFetch({ suggestions: SUGGESTIONS });
    renderSuggest();
    await openDialog();
    await screen.findByText(SUGGESTIONS[0].text);
    expect(screen.queryByRole('button', { name: /add all/i })).not.toBeInTheDocument();
  });

  it('marks an already-added proposal rather than offering it twice', async () => {
    mockFetch({ suggestions: SUGGESTIONS });
    renderSuggest({ addedTexts: new Set([SUGGESTIONS[0].text]) });
    await openDialog();

    await screen.findByText(SUGGESTIONS[0].text);
    const row = screen.getByText(SUGGESTIONS[0].text).closest('div')?.parentElement as HTMLElement;
    expect(within(row).getByRole('button', { name: /Added/ })).toBeDisabled();
  });

  it('keeps proposals readable but unaddable once the list is full', async () => {
    mockFetch({ suggestions: SUGGESTIONS });
    renderSuggest({ atCap: true });
    await openDialog();

    expect(await screen.findByText(SUGGESTIONS[0].text)).toBeInTheDocument();
    for (const button of screen.getAllByRole('button', { name: /Add/ })) {
      expect(button).toBeDisabled();
    }
  });

  /** A paid call the admin didn't ask to repeat must not fire on a reopen. */
  it('does not re-fetch when reopened, but does on an explicit "Suggest again"', async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetch({ suggestions: SUGGESTIONS });
    renderSuggest();

    await openDialog();
    await screen.findByText(SUGGESTIONS[0].text);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await user.keyboard('{Escape}');
    await openDialog();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: /Suggest again/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it('offers a retry when the call fails, without losing the dialog', async () => {
    const user = userEvent.setup();
    mockFetch(null, false);
    renderSuggest();
    await openDialog();

    expect(await screen.findByRole('button', { name: /Try again/ })).toBeInTheDocument();

    const fetchMock = mockFetch({ suggestions: SUGGESTIONS });
    await user.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByText(SUGGESTIONS[0].text)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  /** "Nothing to add here" is a real answer, and must not read as a broken dialog. */
  it('explains an empty result rather than showing a blank panel', async () => {
    mockFetch({ suggestions: [] });
    renderSuggest();
    await openDialog();
    expect(
      await screen.findByText(/Nothing to suggest for this questionnaire/)
    ).toBeInTheDocument();
  });
});
