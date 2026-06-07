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

import { QuestionnaireInviteForm } from '@/components/forms/questionnaire-invite-form';
import type { InvitationLandingView } from '@/lib/app/questionnaire/invitations';

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  useSearchParams: vi.fn(() => new URLSearchParams('token=plain-token')),
}));

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
});
