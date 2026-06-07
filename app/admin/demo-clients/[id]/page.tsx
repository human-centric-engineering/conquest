/**
 * Admin — Demo client detail / edit (DEMO-ONLY, F2.5.1).
 *
 * Flag-gated server shell: fetches the demo client, renders the shared
 * `<DemoClientForm>` in edit mode plus the delete action (refused while
 * questionnaires are attributed). 404 when the id is unknown or the flag is off.
 * A real client engagement strips demo tenancy — see forking.md.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';

import { DemoClientForm } from '@/components/admin/demo-clients/demo-client-form';
import { DemoClientActions } from '@/components/admin/demo-clients/demo-client-actions';
import { DemoClientThemePreview } from '@/components/admin/demo-clients/demo-client-theme-preview';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { isQuestionnairesEnabled } from '@/lib/app/questionnaire/feature-flag';
import type { DemoClientView } from '@/lib/app/questionnaire/demo-clients';

export const metadata: Metadata = {
  title: 'Demo client',
  description: 'Edit a demo client.',
};

interface PageProps {
  params: Promise<{ id: string }>;
}

async function getDemoClient(id: string): Promise<DemoClientView | null> {
  try {
    const res = await serverFetch(API.APP.DEMO_CLIENTS.byId(id));
    if (!res.ok) return null;
    const body = await parseApiResponse<DemoClientView>(res);
    return body.success ? body.data : null;
  } catch (err) {
    logger.error('demo client detail page: fetch failed', err);
    return null;
  }
}

export default async function DemoClientDetailPage({ params }: PageProps) {
  if (!(await isQuestionnairesEnabled())) notFound();

  const { id } = await params;
  const client = await getDemoClient(id);
  if (!client) notFound();

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between">
        <div className="space-y-2">
          <Link
            href="/admin/demo-clients"
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
          >
            <ChevronLeft className="h-4 w-4" /> Demo clients
          </Link>
          <h1 className="text-2xl font-semibold">{client.name}</h1>
          <p className="text-muted-foreground text-sm">
            <code className="text-xs">{client.slug}</code> · {client.questionnaireCount} attributed{' '}
            {client.questionnaireCount === 1 ? 'questionnaire' : 'questionnaires'}
          </p>
        </div>
        <DemoClientActions
          id={client.id}
          name={client.name}
          questionnaireCount={client.questionnaireCount}
        />
      </header>

      {/* DEMO-ONLY (F3.4 gap-fill): the resolved brand a respondent will see, from the
          saved values. Blank fields fall back to the Sunrise defaults. */}
      <section className="space-y-3 rounded-md border px-4 py-4">
        <h2 className="text-sm font-medium">Brand preview</h2>
        <DemoClientThemePreview theme={client} />
      </section>

      <DemoClientForm client={client} />
    </div>
  );
}
