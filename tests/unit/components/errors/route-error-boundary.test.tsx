/**
 * RouteErrorBoundary Tests
 *
 * The shared body behind every `app/**\/error.tsx`. The behaviours worth
 * pinning are the ones a fork inherits without reading the source:
 * - log + Sentry report fire exactly ONCE per error, including on session
 *   expiry (issue #433 — the effect used to re-trigger itself)
 * - the session-expiry branch only runs when asked for
 * - the fallback action navigates by router or by full document load
 *
 * @see components/errors/route-error-boundary.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouteErrorBoundary } from '@/components/errors/route-error-boundary';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: (): { push: (href: string) => void } => ({ push: mockPush }),
}));

vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/errors/sentry', () => ({
  trackError: vi.fn(),
  ErrorSeverity: { Fatal: 'fatal', Error: 'error', Warning: 'warning' },
}));

vi.mock('@/lib/auth/client', () => ({
  authClient: { getSession: vi.fn() },
}));

import { logger } from '@/lib/logging';
import { trackError } from '@/lib/errors/sentry';
import { authClient } from '@/lib/auth/client';

const error = Object.assign(new Error('boom'), { digest: 'digest-1' });

/** Cast a stand-in through better-auth's wide session result type. */
type SessionResult = Awaited<ReturnType<typeof authClient.getSession>>;
const sessionResult = (value: unknown): SessionResult => value as SessionResult;

function renderBoundary(props: Partial<React.ComponentProps<typeof RouteErrorBoundary>> = {}) {
  const reset = vi.fn();
  const utils = render(
    <RouteErrorBoundary
      error={error}
      reset={reset}
      boundaryName="TestError"
      tag="test"
      title="Something went wrong"
      description="An error occurred."
      fallback={{ label: 'Dashboard', href: '/dashboard' }}
      {...props}
    />
  );
  return { ...utils, reset };
}

describe('RouteErrorBoundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authClient.getSession).mockResolvedValue(
      sessionResult({ data: { session: {}, user: {} } })
    );
  });

  describe('reporting', () => {
    it('logs and reports once, with the boundary name and Sentry tag', () => {
      renderBoundary();

      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(
        'Route error boundary triggered',
        error,
        expect.objectContaining({ boundaryName: 'TestError', digest: 'digest-1' })
      );
      expect(trackError).toHaveBeenCalledTimes(1);
      expect(trackError).toHaveBeenCalledWith(
        error,
        expect.objectContaining({
          tags: expect.objectContaining({ boundary: 'test' }),
          extra: expect.objectContaining({ digest: 'digest-1' }),
        })
      );
    });

    it('merges caller-supplied extra into the Sentry payload', () => {
      renderBoundary({ extra: { componentStack: 'root' } });

      expect(trackError).toHaveBeenCalledWith(
        error,
        expect.objectContaining({
          extra: { digest: 'digest-1', componentStack: 'root' },
        })
      );
    });

    // #433: the expiry state change used to re-run the reporting effect
    it('does not re-report when the session check resolves to expired', async () => {
      vi.mocked(authClient.getSession).mockResolvedValue(sessionResult(null));

      renderBoundary({ checkSession: true });

      expect(await screen.findByText('Session Expired')).toBeInTheDocument();
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(trackError).toHaveBeenCalledTimes(1);
    });
  });

  describe('session expiry', () => {
    it('shows the sign-in card when the session is gone', async () => {
      vi.mocked(authClient.getSession).mockResolvedValue(sessionResult(null));

      renderBoundary({ checkSession: true });

      const signIn = await screen.findByRole('button', { name: 'Sign in' });
      await userEvent.click(signIn);
      expect(mockPush).toHaveBeenCalledWith('/login');
      expect(screen.queryByText('Try again')).not.toBeInTheDocument();
    });

    it('treats a failed session lookup as expired', async () => {
      vi.mocked(authClient.getSession).mockRejectedValue(new Error('network'));

      renderBoundary({ checkSession: true });

      expect(await screen.findByText('Session Expired')).toBeInTheDocument();
    });

    it('never calls getSession when checkSession is not set', async () => {
      renderBoundary();

      await waitFor(() => expect(screen.getByText('Something went wrong')).toBeInTheDocument());
      expect(authClient.getSession).not.toHaveBeenCalled();
    });
  });

  describe('actions', () => {
    it('wires "Try again" to reset', async () => {
      const { reset } = renderBoundary();

      await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(reset).toHaveBeenCalledTimes(1);
    });

    it('soft-navigates the fallback by default', async () => {
      renderBoundary();

      await userEvent.click(screen.getByRole('button', { name: 'Dashboard' }));
      expect(mockPush).toHaveBeenCalledWith('/dashboard');
    });

    it('does a full document load when navigate is "reload"', async () => {
      const original = window.location;
      delete (window as { location?: unknown }).location;
      (window as { location: { href: string } }).location = { href: '/current' };

      renderBoundary({ fallback: { label: 'Go home', href: '/', navigate: 'reload' } });

      await userEvent.click(screen.getByRole('button', { name: 'Go home' }));
      expect(window.location.href).toBe('/');
      expect(mockPush).not.toHaveBeenCalled();

      (window as { location: unknown }).location = original;
    });
  });
});
