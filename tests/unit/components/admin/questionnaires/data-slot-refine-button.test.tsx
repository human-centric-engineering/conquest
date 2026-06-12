/**
 * DataSlotRefineButton component tests.
 *
 * Anti-green-bar: drives the popover the way an admin does (open → type → submit / cancel /
 * keyboard) and asserts the DOM + the `onRefined` callback + the outbound request, not mock
 * internals. The endpoint is mocked at the `fetch` boundary (authoringMutate uses global fetch).
 *
 * @see components/admin/questionnaires/data-slot-refine-button.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { DataSlotRefineButton } from '@/components/admin/questionnaires/data-slot-refine-button';
import { API } from '@/lib/api/endpoints';
import type { GeneratedDataSlot } from '@/lib/app/questionnaire/data-slots';

const SLOT = {
  name: 'Onboarding ease',
  description: 'How smoothly the user got started.',
  theme: 'Friction',
  questionKeys: ['q1'],
};

const REFINED: GeneratedDataSlot = {
  name: 'Enterprise onboarding',
  description: 'How smoothly an enterprise buyer got started.',
  theme: 'Friction',
  questionKeys: ['q1', 'q2'],
  confidence: 0.9,
};

function mockFetch(payload: unknown, ok = true): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 400,
    json: async () => (ok ? { success: true, data: payload } : { success: false, error: payload }),
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function renderButton(overrides: Partial<Parameters<typeof DataSlotRefineButton>[0]> = {}) {
  const onRefined = vi.fn();
  render(
    <DataSlotRefineButton
      questionnaireId="qn-1"
      versionId="ver-1"
      slot={SLOT}
      onRefined={onRefined}
      {...overrides}
    />
  );
  return { onRefined };
}

describe('DataSlotRefineButton', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('disables the trigger when the `disabled` prop is set', () => {
    renderButton({ disabled: true });
    expect(screen.getByRole('button', { name: /refine with ai/i })).toBeDisabled();
  });

  it('keeps the submit button disabled until instructions are typed', async () => {
    const user = userEvent.setup();
    renderButton();
    await user.click(screen.getByRole('button', { name: /refine with ai/i }));

    const submit = screen.getByRole('button', { name: /^refine$/i });
    expect(submit).toBeDisabled();

    await user.type(await screen.findByPlaceholderText(/make it focus on enterprise/i), 'go');
    expect(submit).toBeEnabled();
  });

  it('submits, calls onRefined with the refined slot, and POSTs the instructions + slot', async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetch({ slot: REFINED });
    const { onRefined } = renderButton();

    await user.click(screen.getByRole('button', { name: /refine with ai/i }));
    await user.type(
      await screen.findByPlaceholderText(/make it focus on enterprise/i),
      'Focus on enterprise.'
    );
    await user.click(screen.getByRole('button', { name: /^refine$/i }));

    await waitFor(() => expect(onRefined).toHaveBeenCalledWith(REFINED));
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(API.APP.QUESTIONNAIRES.versionDataSlotsRefine('qn-1', 'ver-1'));
    const body = JSON.parse((opts as { body: string }).body);
    expect(body).toEqual({ instructions: 'Focus on enterprise.', slot: SLOT });
  });

  it('includes siblingSlots in the request body when provided', async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetch({ slot: REFINED });
    renderButton({ siblingSlots: [{ name: 'Pricing', theme: 'Money' }] });

    await user.click(screen.getByRole('button', { name: /refine with ai/i }));
    await user.type(await screen.findByPlaceholderText(/make it focus on enterprise/i), 'go');
    await user.click(screen.getByRole('button', { name: /^refine$/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.siblingSlots).toEqual([{ name: 'Pricing', theme: 'Money' }]);
  });

  it('omits siblingSlots from the body when none are provided', async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetch({ slot: REFINED });
    renderButton(); // no siblingSlots

    await user.click(screen.getByRole('button', { name: /refine with ai/i }));
    await user.type(await screen.findByPlaceholderText(/make it focus on enterprise/i), 'go');
    await user.click(screen.getByRole('button', { name: /^refine$/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body).not.toHaveProperty('siblingSlots');
  });

  it('submits with ⌘/Ctrl+Enter from the textarea', async () => {
    const user = userEvent.setup();
    mockFetch({ slot: REFINED });
    const { onRefined } = renderButton();

    await user.click(screen.getByRole('button', { name: /refine with ai/i }));
    const textarea = await screen.findByPlaceholderText(/make it focus on enterprise/i);
    await user.type(textarea, 'Tighten it.');
    await user.keyboard('{Control>}{Enter}{/Control}');

    await waitFor(() => expect(onRefined).toHaveBeenCalledWith(REFINED));
  });

  it('shows the diagnostic message and does not call onRefined when the refiner returns no slot', async () => {
    const user = userEvent.setup();
    mockFetch({
      slot: null,
      diagnostic: 'provider_unavailable',
      diagnosticMessage: 'Provider offline.',
    });
    const { onRefined } = renderButton();

    await user.click(screen.getByRole('button', { name: /refine with ai/i }));
    await user.type(await screen.findByPlaceholderText(/make it focus on enterprise/i), 'do it');
    await user.click(screen.getByRole('button', { name: /^refine$/i }));

    await waitFor(() => expect(screen.getByText('Provider offline.')).toBeInTheDocument());
    expect(onRefined).not.toHaveBeenCalled();
  });

  it('shows the server error message when the request fails', async () => {
    const user = userEvent.setup();
    mockFetch({ message: 'Rate limit exceeded', code: 'RATE_LIMITED' }, false);
    const { onRefined } = renderButton();

    await user.click(screen.getByRole('button', { name: /refine with ai/i }));
    await user.type(await screen.findByPlaceholderText(/make it focus on enterprise/i), 'do it');
    await user.click(screen.getByRole('button', { name: /^refine$/i }));

    await waitFor(() => expect(screen.getByText('Rate limit exceeded')).toBeInTheDocument());
    expect(onRefined).not.toHaveBeenCalled();
  });

  it('shows a fallback error when fetch rejects (network failure)', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);
    const { onRefined } = renderButton();

    await user.click(screen.getByRole('button', { name: /refine with ai/i }));
    await user.type(await screen.findByPlaceholderText(/make it focus on enterprise/i), 'do it');
    await user.click(screen.getByRole('button', { name: /^refine$/i }));

    await waitFor(() =>
      expect(screen.getByText(/could not refine this slot/i)).toBeInTheDocument()
    );
    expect(onRefined).not.toHaveBeenCalled();
  });

  it('cancel closes the popover without submitting', async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetch({ slot: REFINED });
    renderButton();

    await user.click(screen.getByRole('button', { name: /refine with ai/i }));
    await user.type(await screen.findByPlaceholderText(/make it focus on enterprise/i), 'hello');
    await user.click(screen.getByRole('button', { name: /cancel/i }));

    await waitFor(() =>
      expect(screen.queryByPlaceholderText(/make it focus on enterprise/i)).not.toBeInTheDocument()
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
