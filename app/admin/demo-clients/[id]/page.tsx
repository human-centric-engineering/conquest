/**
 * Overview tab — the demo-client detail landing.
 *
 * A read-mostly snapshot: which questionnaires this client brands, and the
 * resolved brand a respondent sees right now. Composes only data the layout
 * already fetched (`cache()` dedups the detail) plus the reassign-target list,
 * which is fetched only when there are attributed questionnaires to reassign.
 *
 * DEMO-ONLY (F2.5.1).
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { AttributedQuestionnaires } from '@/components/admin/demo-clients/attributed-questionnaires';
import { DemoClientThemePreview } from '@/components/admin/demo-clients/demo-client-theme-preview';
import {
  getDemoClientDetailCached,
  getReassignTargets,
} from '@/lib/app/questionnaire/demo-clients/detail-data';

export const metadata: Metadata = {
  title: 'Overview · Demo client',
  description: 'Attributed questionnaires and the resolved brand for a demo client.',
};

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function DemoClientOverviewTab({ params }: PageProps) {
  const { id } = await params;
  const client = await getDemoClientDetailCached(id);
  if (!client) notFound();

  const inUse = client.questionnaireCount > 0;
  const reassignTargets = inUse ? await getReassignTargets(client.id) : [];

  return (
    <div className="space-y-6">
      {/* Attributed questionnaires — a questionnaire is "attributed" when its Demo client
          field names this client, so its sales surface is branded as them. Each row's menu
          detaches ("Make generic") or reassigns it, which is how the delete guard on the
          Management tab gets unblocked. */}
      <section className="space-y-3 rounded-md border px-4 py-4">
        <div className="space-y-1">
          <h2 className="text-sm font-medium">Attributed questionnaires</h2>
          <p className="text-muted-foreground text-xs">
            Questionnaires branded as this client. Use the{' '}
            <span className="text-foreground font-medium">⋯</span> menu on a row to make it generic
            or reassign it to another client.
          </p>
        </div>
        {client.questionnaires.length > 0 ? (
          <AttributedQuestionnaires
            questionnaires={client.questionnaires}
            reassignTargets={reassignTargets}
          />
        ) : (
          <p className="text-muted-foreground rounded-md border border-dashed px-4 py-6 text-center text-sm">
            No questionnaires are branded as this client yet. Attribute one from a questionnaire’s
            Settings tab.
          </p>
        )}
      </section>

      {/* The resolved brand a respondent will see, from the saved values. Blank fields fall
          back to the Sunrise defaults. Edit these on the Branding tab. */}
      <section className="space-y-3 rounded-md border px-4 py-4">
        <h2 className="text-sm font-medium">Brand preview</h2>
        <DemoClientThemePreview theme={client} />
      </section>
    </div>
  );
}
