/**
 * QuestionnaireInviteForm — respondent invitation landing form.
 *
 * Covers the claim-via-existing-login branch (F3.2 gap-fill): when the metadata
 * endpoint reports `accountExists`, the form asks for the existing password ("sign in
 * to claim") instead of offering to set a new one (no confirm field).
 *
 * @see components/forms/questionnaire-invite-form.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { QuestionnaireInviteForm } from '@/components/forms/questionnaire-invite-form';
import type { InvitationLandingView } from '@/lib/app/questionnaire/invitations';

const routerPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({ push: routerPush, refresh: vi.fn() })),
  useSearchParams: vi.fn(() => new URLSearchParams('token=plain-token')),
}));

/** An accept-endpoint success envelope (the POST the form fires on submit). */
function acceptOk(): Response {
  return new Response(JSON.stringify({ success: true, data: { message: 'ok' } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** An accept-endpoint error envelope. */
function acceptError(code: string, message: string, status = 400): Response {
  return new Response(JSON.stringify({ success: false, error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Route GET → metadata, POST → the supplied accept response (default 200 OK). */
function routeFetch(accept: () => Response = acceptOk) {
  return vi.fn((_url: string, opts?: { method?: string }) =>
    Promise.resolve(opts?.method === 'POST' ? accept() : metadataResponse())
  );
}

function metadataResponse(over: Partial<InvitationLandingView> = {}): Response {
  const view: InvitationLandingView = {
    questionnaireTitle: 'Customer Satisfaction',
    inviteeName: 'Alice',
    status: 'opened',
    expiresAt: new Date(Date.now() + 86400_000).toISOString(),
    accountExists: false,
    ...over,
  };
  return new Response(JSON.stringify({ success: true, data: view }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(metadataResponse()))
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('QuestionnaireInviteForm', () => {
  it('offers a set-password + confirm flow when no account exists', async () => {
    render(<QuestionnaireInviteForm />);
    await waitFor(() =>
      expect(screen.getByText(/Set a password to register/i)).toBeInTheDocument()
    );

    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByLabelText('Confirm password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Register & begin/i })).toBeInTheDocument();
  });

  it('asks for the existing password (no confirm) when the email already has an account', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      metadataResponse({ accountExists: true })
    );
    render(<QuestionnaireInviteForm />);
    await waitFor(() =>
      expect(screen.getByText(/sign in with your password to claim/i)).toBeInTheDocument()
    );

    expect(screen.getByLabelText('Your password')).toBeInTheDocument();
    expect(screen.queryByLabelText('Confirm password')).not.toBeInTheDocument();
    const pw = screen.getByLabelText('Your password');
    expect(pw).toHaveAttribute('autocomplete', 'current-password');
    expect(screen.getByRole('button', { name: /Sign in & begin/i })).toBeInTheDocument();
  });

  it('rejects a short password client-side without POSTing (create path)', async () => {
    const fetchMock = routeFetch();
    vi.stubGlobal('fetch', fetchMock);
    render(<QuestionnaireInviteForm />);
    await waitFor(() => expect(screen.getByLabelText('Password')).toBeInTheDocument());

    await userEvent.type(screen.getByLabelText('Password'), 'short');
    await userEvent.type(screen.getByLabelText('Confirm password'), 'short');
    await userEvent.click(screen.getByRole('button', { name: /Register & begin/i }));

    expect(screen.getByText(/at least 8 characters/i)).toBeInTheDocument();
    // No accept POST fired — only the initial metadata GET.
    expect(
      fetchMock.mock.calls.every((c) => (c[1] as { method?: string })?.method !== 'POST')
    ).toBe(true);
  });

  it('rejects mismatched passwords client-side (create path)', async () => {
    vi.stubGlobal('fetch', routeFetch());
    render(<QuestionnaireInviteForm />);
    await waitFor(() => expect(screen.getByLabelText('Password')).toBeInTheDocument());

    await userEvent.type(screen.getByLabelText('Password'), 'longenough1');
    await userEvent.type(screen.getByLabelText('Confirm password'), 'longenough2');
    await userEvent.click(screen.getByRole('button', { name: /Register & begin/i }));

    expect(screen.getByText(/do not match/i)).toBeInTheDocument();
  });

  it('surfaces the accept endpoint error on a failed submit', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch(() => acceptError('ACCOUNT_EXISTS', 'An account already exists for this email'))
    );
    render(<QuestionnaireInviteForm />);
    await waitFor(() => expect(screen.getByLabelText('Password')).toBeInTheDocument());

    await userEvent.type(screen.getByLabelText('Password'), 'longenough1');
    await userEvent.type(screen.getByLabelText('Confirm password'), 'longenough1');
    await userEvent.click(screen.getByRole('button', { name: /Register & begin/i }));

    await waitFor(() =>
      expect(screen.getByText(/An account already exists for this email/i)).toBeInTheDocument()
    );
    expect(routerPush).not.toHaveBeenCalled();
  });

  it('POSTs to accept and redirects on a successful registration', async () => {
    const fetchMock = routeFetch();
    vi.stubGlobal('fetch', fetchMock);
    render(<QuestionnaireInviteForm />);
    await waitFor(() => expect(screen.getByLabelText('Password')).toBeInTheDocument());

    await userEvent.type(screen.getByLabelText('Password'), 'longenough1');
    await userEvent.type(screen.getByLabelText('Confirm password'), 'longenough1');
    await userEvent.click(screen.getByRole('button', { name: /Register & begin/i }));

    await waitFor(() => expect(routerPush).toHaveBeenCalled());
    // The submit fired a POST carrying the token + password.
    const postCall = fetchMock.mock.calls.find(
      (c) => (c[1] as { method?: string })?.method === 'POST'
    );
    expect(postCall).toBeDefined();
    expect(JSON.parse((postCall![1] as { body: string }).body)).toMatchObject({
      token: 'plain-token',
      password: 'longenough1',
    });
  });

  it('claims via the existing password (no confirm) and redirects', async () => {
    const fetchMock = vi.fn((_url: string, opts?: { method?: string }) =>
      Promise.resolve(
        opts?.method === 'POST' ? acceptOk() : metadataResponse({ accountExists: true })
      )
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<QuestionnaireInviteForm />);
    await waitFor(() => expect(screen.getByLabelText('Your password')).toBeInTheDocument());

    // Claim path: a single password field, no confirm; only length>0 is required client-side
    // (the server verifies the credential).
    await userEvent.type(screen.getByLabelText('Your password'), 'my-existing-pw');
    await userEvent.click(screen.getByRole('button', { name: /Sign in & begin/i }));

    await waitFor(() => expect(routerPush).toHaveBeenCalled());
    const postCall = fetchMock.mock.calls.find(
      (c) => (c[1] as { method?: string })?.method === 'POST'
    );
    expect(JSON.parse((postCall![1] as { body: string }).body)).toMatchObject({
      token: 'plain-token',
      password: 'my-existing-pw',
    });
  });
});
