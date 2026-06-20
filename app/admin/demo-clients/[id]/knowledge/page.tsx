/**
 * Knowledge tab — the demo client's private reference corpus.
 *
 * Hosts `<ClientKnowledgePanel>`: the documents shared across all of this
 * client's questionnaires, used to ground their Respondent Reports. Each client's
 * documents are isolated from every other client's. A questionnaire opts into
 * grounding via its own Respondent Report toggle; the documents are owned here.
 *
 * DEMO-ONLY (F2.5.1).
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { ClientKnowledgePanel } from '@/components/admin/demo-clients/client-knowledge-panel';
import { getDemoClientDetailCached } from '@/lib/app/questionnaire/demo-clients/detail-data';

export const metadata: Metadata = {
  title: 'Knowledge · Demo client',
  description: 'Private reference material used to ground a demo client’s Respondent Reports.',
};

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function DemoClientKnowledgeTab({ params }: PageProps) {
  const { id } = await params;
  const client = await getDemoClientDetailCached(id);
  if (!client) notFound();

  return (
    <section className="space-y-3 rounded-md border px-4 py-4">
      <div className="space-y-1">
        <h2 className="text-sm font-medium">Knowledge base</h2>
        <p className="text-muted-foreground text-xs">
          Private reference material used to ground this client&rsquo;s Respondent Reports. Each
          client&rsquo;s documents are isolated from every other client&rsquo;s.
        </p>
      </div>
      <ClientKnowledgePanel clientId={client.id} clientName={client.name} />
    </section>
  );
}
