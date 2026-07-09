'use client';

/**
 * Admin Header Component (Phase 4.4)
 *
 * Header for admin pages with breadcrumb navigation and user info.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronRight, Home } from 'lucide-react';
import { HeaderActions } from '@/components/layouts/header-actions';
import { useBreadcrumbLabels } from '@/components/admin/breadcrumb-context';

interface AdminHeaderProps {
  title?: string;
  description?: string;
}

// Explicit display names for segments whose humanized form would be wrong
// (acronyms, branded names). Everything else is title-cased from the slug.
const segmentLabels: Record<string, string> = {
  admin: 'Admin',
  overview: 'Overview',
  users: 'Users',
  logs: 'Logs',
  features: 'Feature Flags',
  'demo-clients': 'Demo clients',
  questionnaires: 'Questionnaires',
  'behind-the-scenes': 'Agentic Workflows',
  orchestration: 'AI Orchestration',
  v: 'Version',
};

// "demo-clients" -> "Demo Clients". Last-resort fallback for unmapped segments.
function humanizeSegment(segment: string): string {
  return segment
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function AdminHeader({ title, description }: AdminHeaderProps) {
  const pathname = usePathname();
  // Pages register human-readable names for their dynamic id segments here.
  const labelOverrides = useBreadcrumbLabels();

  const labelFor = (segment: string): string =>
    labelOverrides[segment] ?? segmentLabels[segment] ?? humanizeSegment(segment);

  // Generate breadcrumbs from pathname
  const segments = pathname.split('/').filter(Boolean);
  const breadcrumbs = segments.map((segment, index) => {
    const href = '/' + segments.slice(0, index + 1).join('/');
    const label = labelFor(segment);
    const isLast = index === segments.length - 1;

    return { href, label, isLast };
  });

  // Use the last segment as the title if not provided. Only adopt a known/
  // registered label — never a raw id, which pages title themselves.
  const lastSegment = segments[segments.length - 1] ?? '';
  const pageTitle = title || labelOverrides[lastSegment] || segmentLabels[lastSegment] || 'Admin';

  return (
    <header className="bg-background border-b">
      <div className="flex items-center justify-between px-6 py-4">
        <div className="space-y-1">
          {/* Breadcrumbs */}
          <nav className="text-muted-foreground flex items-center gap-1 text-sm">
            <Link
              href="/dashboard"
              className="hover:text-foreground transition-colors"
              aria-label="Dashboard"
            >
              <Home className="h-4 w-4" />
            </Link>
            {breadcrumbs.map((crumb) => (
              <span key={crumb.href} className="flex items-center gap-1">
                <ChevronRight className="h-4 w-4" />
                {crumb.isLast ? (
                  <span className="text-foreground font-medium">{crumb.label}</span>
                ) : (
                  <Link href={crumb.href} className="hover:text-foreground transition-colors">
                    {crumb.label}
                  </Link>
                )}
              </span>
            ))}
          </nav>

          {/* Page title */}
          <h1 className="text-2xl font-bold tracking-tight">{pageTitle}</h1>
          {description && <p className="text-muted-foreground text-sm">{description}</p>}
        </div>

        {/* Right cluster: an app-agnostic portal slot (a section can inject a
            brand mark / actions here via `#admin-header-slot`) sits left of the
            shared theme toggle + user menu. Empty on pages that don't use it. */}
        <div className="flex items-center gap-3">
          <div id="admin-header-slot" className="flex items-center" />
          <HeaderActions />
        </div>
      </div>
    </header>
  );
}
