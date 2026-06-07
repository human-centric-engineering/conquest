'use client';

/**
 * QuestionnaireInviteForm (F3.2 PR2) — the respondent-facing registration form.
 *
 * Reads the opaque `?token=`, validates it against the public metadata endpoint
 * (which also marks the invitation `opened`), then collects a password and posts to
 * the accept endpoint. The accept response forwards better-auth session cookies, so
 * a successful registration auto-logs the respondent in; we then send them on.
 *
 * Token-only: the email isn't shown or entered — it's bound server-side. Invalid /
 * expired / revoked / already-used tokens render a clear terminal message instead of
 * the form.
 */

import { useEffect, useId, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { PasswordInput } from '@/components/ui/password-input';
import { FormError } from '@/components/forms/form-error';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse } from '@/lib/api/parse-response';
import type { InvitationLandingView } from '@/lib/app/questionnaire/invitations';

/** Where a freshly-registered respondent lands (the conversational UI arrives in P7). */
const POST_REGISTER_REDIRECT = '/';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'valid'; landing: InvitationLandingView }
  | { kind: 'invalid'; message: string };

export function QuestionnaireInviteForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token') ?? '';

  const passwordId = useId();
  const confirmId = useId();

  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let active = true;
    if (!token) {
      setState({ kind: 'invalid', message: 'This invitation link is missing its token.' });
      return;
    }
    void (async () => {
      try {
        const res = await fetch(
          `${API.APP.INVITATIONS.METADATA}?token=${encodeURIComponent(token)}`,
          {
            credentials: 'same-origin',
          }
        );
        const parsed = await parseApiResponse<InvitationLandingView>(res);
        if (!active) return;
        if (!parsed.success) {
          setState({ kind: 'invalid', message: parsed.error.message });
          return;
        }
        if (parsed.data.status === 'registered') {
          setState({
            kind: 'invalid',
            message: 'This invitation has already been used. Try signing in instead.',
          });
          return;
        }
        setState({ kind: 'valid', landing: parsed.data });
      } catch {
        if (active) setState({ kind: 'invalid', message: 'Could not validate this invitation.' });
      }
    })();
    return () => {
      active = false;
    };
  }, [token]);

  // An invited email that already has an account *claims* the invitation by signing
  // in with its existing password — no new account, no second password to set.
  const claiming = state.kind === 'valid' && state.landing.accountExists;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (claiming) {
      if (password.length === 0) {
        setError('Enter the password for your existing account.');
        return;
      }
    } else {
      if (password.length < 8) {
        setError('Password must be at least 8 characters.');
        return;
      }
      if (password !== confirm) {
        setError('Passwords do not match.');
        return;
      }
    }

    setSubmitting(true);
    try {
      const res = await fetch(API.APP.INVITATIONS.ACCEPT, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const parsed = await parseApiResponse(res);
      if (!parsed.success) {
        setError(parsed.error.message);
        return;
      }
      setDone(true);
      router.push(POST_REGISTER_REDIRECT);
      router.refresh();
    } catch {
      setError('Registration failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (state.kind === 'loading') {
    return <p className="text-muted-foreground text-sm">Validating your invitation…</p>;
  }

  if (state.kind === 'invalid') {
    return (
      <div className="space-y-2">
        <FormError message={state.message} />
        <p className="text-muted-foreground text-sm">
          If you believe this is a mistake, contact whoever invited you for a new link.
        </p>
      </div>
    );
  }

  if (done) {
    return <p className="text-sm">You&apos;re registered. Redirecting…</p>;
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
      <p className="text-sm">
        You&apos;ve been invited to complete <strong>{state.landing.questionnaireTitle}</strong>
        {state.landing.inviteeName ? `, ${state.landing.inviteeName}` : ''}.{' '}
        {claiming
          ? 'You already have an account — sign in with your password to claim this invitation and begin.'
          : 'Set a password to register and begin.'}
      </p>

      <div className="space-y-1.5">
        <Label htmlFor={passwordId}>{claiming ? 'Your password' : 'Password'}</Label>
        <PasswordInput
          id={passwordId}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={claiming ? 'current-password' : 'new-password'}
          disabled={submitting}
          required
        />
      </div>

      {!claiming && (
        <div className="space-y-1.5">
          <Label htmlFor={confirmId}>Confirm password</Label>
          <PasswordInput
            id={confirmId}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            disabled={submitting}
            required
          />
        </div>
      )}

      {error && <FormError message={error} />}

      <Button type="submit" className="w-full" disabled={submitting}>
        {submitting && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
        {claiming ? 'Sign in & begin' : 'Register & begin'}
      </Button>
    </form>
  );
}
