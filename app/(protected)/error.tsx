'use client';

/**
 * Protected Routes Error Boundary
 *
 * Catches errors that occur within protected routes (dashboard, settings, profile).
 * Detects session expiration and redirects to login.
 *
 * @see https://nextjs.org/docs/app/api-reference/file-conventions/error
 */

import { LayoutDashboard } from 'lucide-react';
import { RouteErrorBoundary } from '@/components/errors/route-error-boundary';

export default function ProtectedError({
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
      boundaryName="ProtectedError"
      tag="protected"
      title="Something went wrong"
      description="An error occurred while loading this page. This has been logged."
      checkSession
      fallback={{
        label: 'Dashboard',
        href: '/dashboard',
        icon: <LayoutDashboard className="mr-2 h-4 w-4" />,
      }}
    />
  );
}
