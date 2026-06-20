/**
 * Demo-client **detail** layout — the shared chrome for every tab under
 * `/admin/demo-clients/[id]/…`. The sibling of the questionnaire workspace
 * layout.
 *
 * Owns the three things the tabs would otherwise each re-implement: the
 * breadcrumb label, the sticky header (name + active badge + slug · count), and
 * the sub-navigation tab bar. Resolves the demo client once — `cache()` means the
 * child tab pages reuse the same fetch for free — and `notFound()`s when the app
 * flag is off or the id is unknown.
 *
 * DEMO-ONLY (F2.5.1). A real client engagement strips demo tenancy — see
 * .context/app/questionnaire/forking.md.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';

import { BreadcrumbLabel } from '@/components/admin/breadcrumb-context';
import { DemoClientSubNav } from '@/components/admin/demo-clients/demo-client-sub-nav';
import { Badge } from '@/components/ui/badge';
import { isQuestionnairesEnabled } from '@/lib/app/questionnaire/feature-flag';
import { getDemoClientDetailCached } from '@/lib/app/questionnaire/demo-clients/detail-data';

export const metadata: Metadata = {
  title: 'Demo client',
  description: 'Edit a demo client.',
};

interface LayoutProps {
  params: Promise<{ id: string }>;
  children: React.ReactNode;
}

export default async function DemoClientDetailLayout({ params, children }: LayoutProps) {
  if (!(await isQuestionnairesEnabled())) notFound();

  const { id } = await params;
  const client = await getDemoClientDetailCached(id);
  if (!client) notFound();

  return (
    <div className="space-y-6">
      {/* Replace the raw id in the admin breadcrumb with the client's name. */}
      <BreadcrumbLabel segment={client.id} label={client.name} />
      <nav className="text-muted-foreground -mb-5 text-xs">
        <Link href="/admin/demo-clients" className="hover:underline">
          Demo clients
        </Link>
        {' / '}
        <span>{client.name}</span>
      </nav>

      {/* Sticky header — identity only. The everyday branding edits live on the Branding
          tab; the destructive demo-ops on the Management tab. The Active/Inactive badge is
          the one piece of state worth surfacing from every tab. */}
      <header className="bg-background sticky top-0 z-30 -mx-6 space-y-3 border-b px-6 pt-3 pb-0">
        <div>
          <Link
            href="/admin/demo-clients"
            className="text-muted-foreground hover:text-foreground -mb-1 inline-flex items-center gap-1 text-xs"
          >
            <ChevronLeft className="h-3.5 w-3.5" /> Demo clients
          </Link>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold">{client.name}</h1>
            <Badge variant={client.isActive ? 'default' : 'secondary'}>
              {client.isActive ? 'Active' : 'Inactive'}
            </Badge>
          </div>
          <p className="text-muted-foreground mt-1 text-xs">
            <code className="text-xs">{client.slug}</code> · {client.questionnaireCount} attributed{' '}
            {client.questionnaireCount === 1 ? 'questionnaire' : 'questionnaires'}
          </p>
        </div>
        <DemoClientSubNav clientId={client.id} />
      </header>

      {children}
    </div>
  );
}
