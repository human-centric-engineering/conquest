import type { Metadata } from 'next';

import { PromptLibrary } from '@/components/admin/questionnaires/prompt-library';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import type { PromptAgentApiView } from '@/app/api/v1/app/questionnaires/_lib/prompt-catalog';

export const metadata: Metadata = {
  title: 'Prompt library',
  description: 'Read the exact prompts each questionnaire agent sends to the model.',
};

/**
 * Admin — Prompt Library.
 *
 * Read-only transparency surface: every questionnaire agent paired with the real
 * prompt(s) it sends, rendered from representative sample contexts. Exists because
 * the prompts are assembled in code (not the agent's editable `systemInstructions`),
 * so they are otherwise invisible to an operator. Thin server component: gates on the
 * master flag (404 when off), pre-fetches the catalog, hands to the client view.
 */
export default async function PromptLibraryPage() {
  let agents: PromptAgentApiView[] = [];
  try {
    const res = await serverFetch(API.APP.QUESTIONNAIRES.prompts);
    if (res.ok) {
      const body = await parseApiResponse<{ agents: PromptAgentApiView[] }>(res);
      if (body.success) agents = body.data.agents;
    }
  } catch (err) {
    logger.error('prompt library page: catalog fetch failed', err);
  }

  return <PromptLibrary agents={agents} />;
}
