import type { Metadata } from 'next';

import { BehindTheScenesExplorer } from '@/components/app/questionnaire/behind-the-scenes/behind-the-scenes-explorer';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import type { WorkflowSummary } from '@/lib/app/questionnaire/workflows/types';

export const metadata: Metadata = {
  title: 'Agentic Workflows',
  description: 'See the agentic pipelines that power ConQuest — agents, prompts, tools, knowledge.',
};

/**
 * Admin — Behind the Scenes workflow visualizer.
 *
 * Read-only, demo-oriented: renders ConQuest's AI pipelines as node/edge
 * diagrams, with click-to-reveal agent / prompt / tool / knowledge detail and an
 * optional per-questionnaire lens. Thin server component: gates on the master
 * flag (404 when off), pre-fetches the workflow summaries, hands to the client
 * explorer (which fetches per-workflow detail on demand).
 */
export default async function BehindTheScenesPage() {
  let workflows: WorkflowSummary[] = [];
  try {
    const res = await serverFetch(API.APP.QUESTIONNAIRES.workflows);
    if (res.ok) {
      const body = await parseApiResponse<{ workflows: WorkflowSummary[] }>(res);
      if (body.success) workflows = body.data.workflows;
    }
  } catch (err) {
    logger.error('behind-the-scenes page: workflow list fetch failed', err);
  }

  return <BehindTheScenesExplorer initialWorkflows={workflows} />;
}
