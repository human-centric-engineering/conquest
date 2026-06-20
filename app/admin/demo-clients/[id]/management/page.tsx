/**
 * Management tab — the rare, destructive demo-ops, walled off from the everyday
 * branding edits.
 *
 * Two irreversible actions, each explaining itself before offering the control:
 * reset sessions (the clean slate between demos) and delete (guarded while
 * questionnaires remain attributed — detach or reassign them on the Overview tab
 * first).
 *
 * DEMO-ONLY (F2.5.1 / F6.4).
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { DemoClientActions } from '@/components/admin/demo-clients/demo-client-actions';
import { ResetSessionsDialog } from '@/components/admin/demo-clients/reset-sessions-dialog';
import { getDemoClientDetailCached } from '@/lib/app/questionnaire/demo-clients/detail-data';

export const metadata: Metadata = {
  title: 'Management · Demo client',
  description: 'Reset sessions or delete a demo client.',
};

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function DemoClientManagementTab({ params }: PageProps) {
  const { id } = await params;
  const client = await getDemoClientDetailCached(id);
  if (!client) notFound();

  const inUse = client.questionnaireCount > 0;

  return (
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
            Clear every respondent session, answer, and event across this client’s questionnaires —
            the clean slate between demos.
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
                one generic or reassign it (use the row menus on the Overview tab) before this can
                be deleted.
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
  );
}
