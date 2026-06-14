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

import { BreadcrumbLabel } from '@/components/admin/breadcrumb-context';
import { DemoClientForm } from '@/components/admin/demo-clients/demo-client-form';
import { DemoClientActions } from '@/components/admin/demo-clients/demo-client-actions';
import { AttributedQuestionnaires } from '@/components/admin/demo-clients/attributed-questionnaires';
import { ResetSessionsDialog } from '@/components/admin/demo-clients/reset-sessions-dialog';
import { DemoClientThemePreview } from '@/components/admin/demo-clients/demo-client-theme-preview';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { isQuestionnairesEnabled } from '@/lib/app/questionnaire/feature-flag';
import type {
  AttributedDemoClient,
  DemoClientDetail,
  DemoClientView,
} from '@/lib/app/questionnaire/demo-clients';

export const metadata: Metadata = {
  title: 'Demo client',
  description: 'Edit a demo client.',
};

interface PageProps {
  params: Promise<{ id: string }>;
}

async function getDemoClient(id: string): Promise<DemoClientDetail | null> {
  try {
    const res = await serverFetch(API.APP.DEMO_CLIENTS.byId(id));
    if (!res.ok) return null;
    const body = await parseApiResponse<DemoClientDetail>(res);
    return body.success ? body.data : null;
  } catch (err) {
    logger.error('demo client detail page: fetch failed', err);
    return null;
  }
}

// DEMO-ONLY (F2.5.1): other active demo clients, offered as reassignment targets on
// each attributed-questionnaire row. Degrades to an empty list — the row menu still
// offers "Make generic (detach)", which is enough to unblock a delete.
async function getReassignTargets(currentId: string): Promise<AttributedDemoClient[]> {
  try {
    const res = await serverFetch(API.APP.DEMO_CLIENTS.ROOT);
    if (!res.ok) return [];
    const body = await parseApiResponse<DemoClientView[]>(res);
    if (!body.success) return [];
    return body.data
      .filter((c) => c.isActive && c.id !== currentId)
      .map((c) => ({ id: c.id, slug: c.slug, name: c.name }));
  } catch (err) {
    logger.error('demo client detail page: reassign targets fetch failed', err);
    return [];
  }
}

export default async function DemoClientDetailPage({ params }: PageProps) {
  if (!(await isQuestionnairesEnabled())) notFound();

  const { id } = await params;
  const client = await getDemoClient(id);
  if (!client) notFound();

  const inUse = client.questionnaireCount > 0;
  const reassignTargets = inUse ? await getReassignTargets(client.id) : [];

  return (
    <div className="space-y-6">
      {/* Replace the raw id in the admin breadcrumb with the client's name. */}
      <BreadcrumbLabel segment={client.id} label={client.name} />
      {/* Header is identity only — the destructive demo-ops (reset / delete) live in the
          "Demo management" card at the foot, where each gets room to explain itself. */}
      <header className="space-y-2">
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
      </header>

      {/* Attributed questionnaires — a questionnaire is "attributed" when its Demo client
          field names this client, so its sales surface is branded as them. Each row's
          menu detaches ("Make generic") or reassigns it in place, which is how the delete
          guard below gets unblocked. */}
      {client.questionnaires.length > 0 && (
        <section className="space-y-3 rounded-md border px-4 py-4">
          <div className="space-y-1">
            <h2 className="text-sm font-medium">Attributed questionnaires</h2>
            <p className="text-muted-foreground text-xs">
              These questionnaires are branded as this client. Use the{' '}
              <span className="text-foreground font-medium">⋯</span> menu on a row to make it
              generic or reassign it to another client.
            </p>
          </div>
          <AttributedQuestionnaires
            questionnaires={client.questionnaires}
            reassignTargets={reassignTargets}
          />
        </section>
      )}

      {/* DEMO-ONLY (F3.4 gap-fill): the resolved brand a respondent will see, from the
          saved values. Blank fields fall back to the Sunrise defaults. */}
      <section className="space-y-3 rounded-md border px-4 py-4">
        <h2 className="text-sm font-medium">Brand preview</h2>
        <DemoClientThemePreview theme={client} />
      </section>

      <DemoClientForm client={client} />

      {/* Demo management — the rare, destructive demo-ops, out of the way of the everyday
          branding edits above. Each row explains what it does before offering the action. */}
      <section className="border-destructive/30 divide-y rounded-md border">
        <div className="px-4 py-3">
          <h2 className="text-sm font-semibold">Demo management</h2>
          <p className="text-muted-foreground text-xs">
            Operational actions for running and retiring this demo. Both are irreversible.
          </p>
        </div>

        {/* DEMO-ONLY (F6.4): between-demos session reset. */}
        <div className="flex items-start justify-between gap-4 px-4 py-4">
          <div className="max-w-prose space-y-0.5">
            <h3 className="text-sm font-medium">Reset sessions</h3>
            <p className="text-muted-foreground text-xs">
              Clear every respondent session, answer, and event across this client’s questionnaires
              — the clean slate between demos.
            </p>
          </div>
          <ResetSessionsDialog id={client.id} name={client.name} slug={client.slug} />
        </div>

        {/* DEMO-ONLY (F2.5.1): delete, guarded while questionnaires remain attributed. */}
        <div className="flex items-start justify-between gap-4 px-4 py-4">
          <div className="max-w-prose space-y-0.5">
            <h3 className="text-sm font-medium">Delete demo client</h3>
            <p className="text-muted-foreground text-xs">
              {inUse ? (
                <>
                  Still branding {client.questionnaireCount}{' '}
                  {client.questionnaireCount === 1 ? 'questionnaire' : 'questionnaires'}. Make each
                  one generic or reassign it (use the row menus above) before this can be deleted.
                </>
              ) : (
                'Permanently remove this demo client.'
              )}
            </p>
          </div>
          <DemoClientActions
            id={client.id}
            name={client.name}
            questionnaireCount={client.questionnaireCount}
          />
        </div>
      </section>
    </div>
  );
}
