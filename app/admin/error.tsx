'use client';

/**
 * Admin Routes Error Boundary
 *
 * Catches errors that occur within admin routes.
 * Provides admin-specific recovery options.
 *
 * @see https://nextjs.org/docs/app/api-reference/file-conventions/error
 */

import { LayoutDashboard } from 'lucide-react';
import { RouteErrorBoundary } from '@/components/errors/route-error-boundary';
import { AUTH_LANDING_LABEL, AUTH_LANDING_ROUTE } from '@/lib/auth-landing/route';

export default function AdminError({
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
      boundaryName="AdminError"
      tag="admin"
      title="Admin Error"
      description="An error occurred in the admin panel. This has been logged."
      fallback={{
        label: AUTH_LANDING_LABEL,
        href: AUTH_LANDING_ROUTE,
        icon: <LayoutDashboard className="mr-2 h-4 w-4" />,
      }}
    />
  );
}
