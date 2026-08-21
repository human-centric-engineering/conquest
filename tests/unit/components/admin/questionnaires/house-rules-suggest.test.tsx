/**
 * HouseRulesSuggest component tests.
 *
 * Anti-green-bar: drives the dialog the way an admin does (open → read → add → retry) and asserts
 * the DOM plus the `onAdd` payload and the outbound request. The endpoint is mocked at the `fetch`
 * boundary, which is what `apiClient` uses.
 *
 * The properties worth pinning are the ones that make an AI affordance safe to put in an editor:
 * it proposes rather than applies, it shows its reasoning, and it does not silently spend twice.
 *
 * @see components/admin/questionnaires/house-rules-suggest.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { HouseRulesSuggest } from '@/components/admin/questionnaires/house-rules-suggest';
import { API } from '@/lib/api/endpoints';

const SUGGESTIONS = [
  {
    kind: 'never' as const,
    text: 'Give advice or recommend a course of action.',
    why: 'An interviewer that advises stops collecting.',
  },
  {
    kind: 'if_asked' as const,
    text: 'Only the research team, and results are reported grouped.',
    trigger: 'who will see their answers',
    why: 'Often decides whether someone answers honestly.',
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
        : { success: false, error: { code: 'HOUSE_RULES_SUGGEST_FAILED', message: 'Nope.' } },
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function renderSuggest(over: Partial<Parameters<typeof HouseRulesSuggest>[0]> = {}) {
  const onAdd = vi.fn();
  render(
    <HouseRulesSuggest
      questionnaireId="qn-1"
      versionId="v1"
      addedTexts={new Set()}
      onAdd={onAdd}
      {...over}
    />
  );
  return { onAdd };
}

const openDialog = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole('button', { name: /suggest rules/i }));

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('HouseRulesSuggest', () => {
  it('fetches nothing until the admin asks — an LLM call is never made on render', async () => {
    const fetchMock = mockFetch({ suggestions: SUGGESTIONS });
    renderSuggest();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('calls the suggest endpoint for this version on open', async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetch({ suggestions: SUGGESTIONS });
    renderSuggest();

    await openDialog(user);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      API.APP.QUESTIONNAIRES.houseRulesSuggest('qn-1', 'v1')
    );
  });

  it('shows each proposal with its reasoning, and its trigger when it has one', async () => {
    const user = userEvent.setup();
    mockFetch({ suggestions: SUGGESTIONS });
    renderSuggest();

    await openDialog(user);

    // The reason gets shown alongside the rule — the admin is deciding, not the model.
    expect(
      await screen.findByText(/An interviewer that advises stops collecting\./)
    ).toBeInTheDocument();
    expect(screen.getByText(/who will see their answers/)).toBeInTheDocument();
  });

  it('adds only the proposal the admin picked, never the whole set', async () => {
    const user = userEvent.setup();
    mockFetch({ suggestions: SUGGESTIONS });
    const { onAdd } = renderSuggest();

    await openDialog(user);
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getAllByRole('button', { name: /^add$/i })[0]);

    // No "add all" by design: a rule the admin never read is what this feature prevents.
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd).toHaveBeenCalledWith(SUGGESTIONS[0]);
    expect(within(dialog).queryByRole('button', { name: /add all/i })).not.toBeInTheDocument();
  });

  it('carries the trigger through when adding an "if asked" proposal', async () => {
    const user = userEvent.setup();
    mockFetch({ suggestions: SUGGESTIONS });
    const { onAdd } = renderSuggest();

    await openDialog(user);
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getAllByRole('button', { name: /^add$/i })[1]);

    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'if_asked', trigger: 'who will see their answers' })
    );
  });

  it('marks an already-added proposal rather than offering it twice', async () => {
    const user = userEvent.setup();
    mockFetch({ suggestions: SUGGESTIONS });
    renderSuggest({ addedTexts: new Set([SUGGESTIONS[0].text]) });

    await openDialog(user);
    const dialog = await screen.findByRole('dialog');

    expect(await within(dialog).findByRole('button', { name: /added/i })).toBeDisabled();
  });

  it('disables adding at the rule cap while still showing the proposals', async () => {
    const user = userEvent.setup();
    mockFetch({ suggestions: SUGGESTIONS });
    renderSuggest({ atCap: true });

    await openDialog(user);
    const dialog = await screen.findByRole('dialog');

    // Readable but not addable — the list is full.
    expect(await within(dialog).findByText(/Give advice/)).toBeInTheDocument();
    for (const button of within(dialog).getAllByRole('button', { name: /^add$/i })) {
      expect(button).toBeDisabled();
    }
  });

  it('says so plainly when there is nothing worth proposing', async () => {
    const user = userEvent.setup();
    mockFetch({ suggestions: [] });
    renderSuggest();

    await openDialog(user);

    // An empty result is a legitimate answer, not an error state.
    expect(await screen.findByText(/nothing to suggest/i)).toBeInTheDocument();
  });

  it('shows the server’s reason for a failure, then recovers on retry', async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetch(null, false);
    // A retry against a server that has recovered — a single mockResolvedValue could never show
    // that the second attempt actually renders results.
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({
        success: false,
        error: { code: 'HOUSE_RULES_SUGGEST_FAILED', message: 'Nope.' },
      }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ success: true, data: { suggestions: SUGGESTIONS } }),
    });
    renderSuggest();

    await openDialog(user);
    // The server's own message, not a swallowed generic one.
    expect(await screen.findByText('Nope.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /try again/i }));

    expect(await screen.findByText(SUGGESTIONS[0].text)).toBeInTheDocument();
    expect(screen.queryByText('Nope.')).not.toBeInTheDocument();
  });

  it('does not spend again when the dialog is merely reopened', async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetch({ suggestions: SUGGESTIONS });
    renderSuggest();

    await openDialog(user);
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await openDialog(user);

    // Reopening shows what it already proposed; paying again has to be explicit.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it('re-runs only when the admin explicitly asks for another pass', async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetch({ suggestions: SUGGESTIONS });
    renderSuggest();

    await openDialog(user);
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: /suggest again/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
