import type { Metadata } from 'next';

import { AgentSettingsPanel } from '@/components/admin/questionnaires/agent-settings/agent-settings-panel';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import type { AgentSettingsEvaluation } from '@/lib/app/questionnaire/agent-advisory/evaluate';

export const metadata: Metadata = {
  title: 'Agent settings',
  description:
    'Review and tune the questionnaire agents’ model, temperature and reasoning effort against the advisory baseline, with cost trade-offs.',
};

/**
 * Admin — Agent Settings Evaluation.
 *
 * Cost/performance control surface for the questionnaire agents: current vs
 * advisory model / temperature / maxTokens / reasoning effort, cost trade-offs,
 * and one-click apply. Thin server component — pre-fetches the deterministic
 * evaluation, hands to the client panel.
 */
export default async function AgentSettingsPage() {
  let evaluation: AgentSettingsEvaluation | null = null;
  try {
    const res = await serverFetch(API.APP.QUESTIONNAIRES.agentSettings);
    if (res.ok) {
      const body = await parseApiResponse<AgentSettingsEvaluation>(res);
      if (body.success) evaluation = body.data;
    }
  } catch (err) {
    logger.error('agent settings page: evaluation fetch failed', err);
  }

  return <AgentSettingsPanel initialEvaluation={evaluation} />;
}
