/**
 * ProfileCaptureGate — the blocking respondent profile capture form (F-capture).
 *
 * Pins the gate's OWN responsibilities: it blocks submit until the client schema passes (a required
 * field can't be skipped), it PUTs to the profile endpoint (with the anon `X-Session-Token` when
 * given), it maps a 400 `INVALID_PROFILE` response's `fieldErrors` back onto the inputs, and it calls
 * `onSubmitted` only on success. `fetch` is mocked so no real I/O runs.
 *
 * @see components/app/questionnaire/profile/profile-capture-gate.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ProfileCaptureGate } from '@/components/app/questionnaire/profile/profile-capture-gate';
import type { ProfileFieldConfig } from '@/lib/app/questionnaire/types';

const FIELDS: ProfileFieldConfig[] = [
  { key: 'name', label: 'Full name', type: 'text', required: true, validation: 'hybrid' },
  { key: 'email', label: 'Email', type: 'email', required: false, validation: 'deterministic' },
];

function okResponse() {
  return {
    ok: true,
    json: () => Promise.resolve({ success: true, data: { saved: true } }),
  } as unknown as Response;
}
function errorResponse(fieldErrors: Record<string, string>) {
  return {
    ok: false,
    json: () =>
      Promise.resolve({
        success: false,
        error: {
          code: 'INVALID_PROFILE',
          message: 'Some details need a quick fix.',
          details: { fieldErrors },
        },
      }),
  } as unknown as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ProfileCaptureGate', () => {
  it('blocks submit until the required field is filled (client validation)', async () => {
    const user = userEvent.setup();
    const onSubmitted = vi.fn();
    render(<ProfileCaptureGate sessionId="s1" fields={FIELDS} onSubmitted={onSubmitted} />);

    await user.click(screen.getByRole('button', { name: /continue/i }));

    // No network call, no advance — the required name blocked it.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(await screen.findByText('This field is required')).toBeInTheDocument();
  });

  it('PUTs the values and calls onSubmitted on success', async () => {
    const user = userEvent.setup();
    const onSubmitted = vi.fn();
    fetchMock.mockResolvedValue(okResponse());
    const { container } = render(
      <ProfileCaptureGate sessionId="s1" fields={FIELDS} onSubmitted={onSubmitted} />
    );

    await user.type(container.querySelector('#capture-name') as HTMLInputElement, 'Ada Lovelace');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/app/questionnaire-sessions/s1/profile',
      expect.objectContaining({ method: 'PUT' })
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body).toEqual({ profileValues: { name: 'Ada Lovelace' } });
  });

  it('sends the X-Session-Token header for an anonymous respondent', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(okResponse());
    const { container } = render(
      <ProfileCaptureGate
        sessionId="s1"
        accessToken="tok-9"
        fields={FIELDS}
        onSubmitted={vi.fn()}
      />
    );

    await user.type(container.querySelector('#capture-name') as HTMLInputElement, 'Ada');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const headers = (fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    expect(headers['X-Session-Token']).toBe('tok-9');
  });

  it('maps server fieldErrors back onto the inputs and does NOT advance', async () => {
    const user = userEvent.setup();
    const onSubmitted = vi.fn();
    fetchMock.mockResolvedValue(errorResponse({ name: 'Looks like placeholder text' }));
    const { container } = render(
      <ProfileCaptureGate sessionId="s1" fields={FIELDS} onSubmitted={onSubmitted} />
    );

    await user.type(container.querySelector('#capture-name') as HTMLInputElement, 'asdf');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    expect(await screen.findByText('Looks like placeholder text')).toBeInTheDocument();
    expect(onSubmitted).not.toHaveBeenCalled();
  });

  it('shows a generic error and does NOT advance when the fetch itself throws (network failure)', async () => {
    const user = userEvent.setup();
    const onSubmitted = vi.fn();
    fetchMock.mockRejectedValue(new Error('network down'));
    const { container } = render(
      <ProfileCaptureGate sessionId="s1" fields={FIELDS} onSubmitted={onSubmitted} />
    );

    await user.type(container.querySelector('#capture-name') as HTMLInputElement, 'Ada');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    expect(await screen.findByText(/could not save your details/i)).toBeInTheDocument();
    expect(onSubmitted).not.toHaveBeenCalled();
  });
});
