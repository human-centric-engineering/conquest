import type { Metadata } from 'next';

import { CqStatTiles, type CqStat } from '@/components/admin/cq-stat-tiles';
import { ExperiencesTable } from '@/components/admin/experiences/experiences-table';
import { NewExperienceButton } from '@/components/admin/experiences/new-experience-button';
import { FieldHelp } from '@/components/ui/field-help';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import type { ExperienceListView } from '@/lib/app/questionnaire/experiences/views';
import type { AttributedDemoClient, DemoClientView } from '@/lib/app/questionnaire/demo-clients';

export const metadata: Metadata = {
  title: 'Experiences',
  description: 'Compose journeys from your questionnaires.',
};

/**
 * Every experience, newest-first.
 *
 * One fetch serves both the table and the stat tiles — the list endpoint is unpaginated at demo
 * scale, so counting client-side is cheaper and more accurate than a second round trip. Failures
 * degrade to an empty list rather than throwing; the table renders its own empty state.
 */
async function getExperiences(): Promise<ExperienceListView[]> {
  try {
    const res = await serverFetch(API.APP.EXPERIENCES.ROOT);
    if (!res.ok) return [];
    const body = await parseApiResponse<ExperienceListView[]>(res);
    return body.success ? body.data : [];
  } catch (err) {
    logger.error('experiences list page: initial fetch failed', err);
    return [];
  }
}

/** Active demo clients for the create dialog's attribution picker. Degrades to an empty list. */
async function getActiveDemoClients(): Promise<AttributedDemoClient[]> {
  try {
    const res = await serverFetch(API.APP.DEMO_CLIENTS.ROOT);
    if (!res.ok) return [];
    const body = await parseApiResponse<DemoClientView[]>(res);
    if (!body.success) return [];
    return body.data
      .filter((client) => client.isActive)
      .map((client) => ({ id: client.id, slug: client.slug, name: client.name }));
  } catch (err) {
    logger.error('experiences list page: demo clients fetch failed', err);
    return [];
  }
}

/**
 * Admin — Experiences list page (P15.1).
 *
 * Thin server component: fetches the list and the demo-client options, hands off to the client
 * `<ExperiencesTable>` for search and filtering.
 */
export default async function ExperiencesListPage() {
  const [experiences, demoClientOptions] = await Promise.all([
    getExperiences(),
    getActiveDemoClients(),
  ]);

  const statTiles: CqStat[] = [
    { label: 'Experiences', value: experiences.length },
    {
      label: 'Launched',
      value: experiences.filter((e) => e.status === 'launched').length,
      accent: true,
    },
    { label: 'Drafts', value: experiences.filter((e) => e.status === 'draft').length },
    { label: 'Archived', value: experiences.filter((e) => e.status === 'archived').length },
  ];

  return (
    <div className="space-y-6">
      <header className="bg-background sticky top-0 z-30 -mx-6 flex items-start justify-between gap-4 border-b px-6 pt-3 pb-3">
        <div>
          <h1 className="text-2xl font-semibold">
            Experiences{' '}
            <FieldHelp
              title="What are experiences?"
              contentClassName="w-96 max-h-80 overflow-y-auto"
            >
              <p>
                An experience composes your existing questionnaires into a single journey. The
                questionnaire stays the unit you author; an experience decides which ones a
                respondent meets, in what order, and what carries between them.
              </p>
              <p className="text-foreground mt-2 font-medium">Agentic switcher</p>
              <p>
                An opening questionnaire, then an AI decision: conclude with a report, or continue
                into a follow-up chosen from your candidates based on what was learnt.
              </p>
              <p className="text-foreground mt-2 font-medium">Facilitated meeting</p>
              <p>
                The same short questionnaire run by many people at once, synthesised per breakout so
                a facilitator sees where a team agrees and where it does not.
              </p>
              <p className="text-muted-foreground mt-2">
                Open any experience and its <strong>How it works</strong> tab draws the journey as a
                diagram, explains the kind, and shows worked examples.
              </p>
            </FieldHelp>
          </h1>
          <p className="text-muted-foreground text-sm">
            Compose journeys from your questionnaires.
          </p>
        </div>
        <NewExperienceButton demoClientOptions={demoClientOptions} />
      </header>

      <CqStatTiles stats={statTiles} />

      <ExperiencesTable initialItems={experiences} />
    </div>
  );
}
