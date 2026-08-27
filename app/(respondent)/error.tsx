'use client';

/**
 * Respondent Routes Error Boundary
 *
 * Catches errors within the standalone respondent surfaces (`/q`, `/x`, `/m`).
 *
 * Separate from the public one because the reader is different: someone half-way through
 * answering a questionnaire, whose first thought is "have I lost what I typed?". So the copy
 * answers that first, and the fallback is Try again rather than Go home — home is a marketing site
 * they did not come for, and under white-label chrome it is not even our site they think they are
 * on.
 *
 * @see https://nextjs.org/docs/app/api-reference/file-conventions/error
 */

import { Home } from 'lucide-react';
import { RouteErrorBoundary } from '@/components/errors/route-error-boundary';

export default function RespondentError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.ReactElement {
  return (
    <RouteErrorBoundary
      error={error}
      reset={reset}
      boundaryName="RespondentError"
      tag="respondent"
      title="Something went wrong"
      description="Your answers so far are saved. Try again — you'll pick up where you left off."
      // "Try again" (the reset) is the primary action and the one that actually helps here. This
      // secondary is the standard escape hatch; a full reload rather than a client push, because
      // the shell itself may be what broke.
      fallback={{
        label: 'Go home',
        href: '/',
        icon: <Home className="h-4 w-4" aria-hidden="true" />,
        navigate: 'reload',
      }}
    />
  );
}
