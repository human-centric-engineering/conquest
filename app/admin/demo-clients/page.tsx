/**
 * Admin — Demo clients list page (DEMO-ONLY, F2.5.1).
 *
 * Thin server component: gates on the feature flag (404 when off — the surface is
 * dark), fetches the demo-client list via `serverFetch`, and hands off to the
 * client `<DemoClientsTable>`. Fetch failures render an empty state, never throw.
 *
 * A real client engagement strips demo tenancy — see
 * .context/app/questionnaire/forking.md § "Replacing demo tenancy".
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Plus } from 'lucide-react';

import { DemoClientsTable } from '@/components/admin/demo-clients/demo-clients-table';
import { CqStatTiles, type CqStat } from '@/components/admin/cq-stat-tiles';
import { Button } from '@/components/ui/button';
import { FieldHelp } from '@/components/ui/field-help';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { isQuestionnairesEnabled } from '@/lib/app/questionnaire/feature-flag';
import type { DemoClientView } from '@/lib/app/questionnaire/demo-clients';

export const metadata: Metadata = {
  title: 'Demo clients',
  description: 'Attribute questionnaires to a prospect for branded demos.',
};

async function getDemoClients(): Promise<DemoClientView[]> {
  try {
    const res = await serverFetch(API.APP.DEMO_CLIENTS.ROOT);
    if (!res.ok) return [];
    const body = await parseApiResponse<DemoClientView[]>(res);
    return body.success ? body.data : [];
  } catch (err) {
    logger.error('demo clients list page: initial fetch failed', err);
    return [];
  }
}

export default async function DemoClientsListPage() {
  if (!(await isQuestionnairesEnabled())) notFound();

  const clients = await getDemoClients();

  const statTiles: CqStat[] = [
    { label: 'Demo clients', value: clients.length },
    { label: 'Active', value: clients.filter((c) => c.isActive).length, accent: true },
    {
      label: 'Attributed',
      value: clients.reduce((sum, c) => sum + c.questionnaireCount, 0),
      hint: 'questionnaires branded',
    },
  ];

  return (
    <div className="space-y-6">
      <header className="bg-background sticky top-0 z-30 -mx-6 flex items-start justify-between border-b px-6 pt-3 pb-3">
        <div>
          <h1 className="text-2xl font-semibold">
            Demo clients{' '}
            <FieldHelp title="What are demo clients?" contentClassName="w-96">
              <p>
                A demo client is a prospect a questionnaire is attributed to, so the sales surface
                is theirs. It is an attribution and branding partition for the sales demo —{' '}
                <strong>not</strong> a security boundary or real multi-tenancy.
              </p>
              <p className="mt-2">
                Per-client branding (theme, logo) and the demo-reset workflow land in later phases.
              </p>
            </FieldHelp>
          </h1>
          <p className="text-muted-foreground text-sm">
            Group and label questionnaires by prospect for branded demos.
          </p>
        </div>
        <Button asChild>
          <Link href="/admin/demo-clients/new">
            <Plus className="mr-2 h-4 w-4" />
            New demo client
          </Link>
        </Button>
      </header>

      <CqStatTiles stats={statTiles} />

      <DemoClientsTable clients={clients} />
    </div>
  );
}
