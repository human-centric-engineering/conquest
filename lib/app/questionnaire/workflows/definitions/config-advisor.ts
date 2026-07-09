/**
 * Workflow diagram: Config Advisor.
 *
 * The admin-triggered AI panel on the version Settings tab that reads the whole questionnaire and
 * advises on its configuration (`lib/app/questionnaire/advisor/stream-advisor.ts`). Two phases over
 * one read-only snapshot: a streamed plain-language narrative review of the respondent experience +
 * lifecycle state, then a structured pass that emits conflicts and one-click config suggestions.
 * Read-only — it proposes tweaks; the admin applies them. Its prompts build from a live snapshot in
 * code and are not in the Prompt Library (like the report/editor support agents), so its nodes show
 * no Prompt tab.
 */

import { QUESTIONNAIRE_ADVISOR_AGENT_SLUG } from '@/lib/app/questionnaire/constants';

import { applies, diagram, node, unavailable } from '@/lib/app/questionnaire/workflows/types';

export const configAdvisorWorkflow = diagram({
  slug: 'config-advisor',
  title: 'Config Advisor',
  description: 'Reviews configuration and proposes one-click setting tweaks.',
  sourceModule: 'lib/app/questionnaire/advisor/stream-advisor.ts',
  entryStepId: 'snapshot',
  errorStrategy: 'fail',
  steps: [
    node({
      id: 'snapshot',
      name: 'Load questionnaire snapshot',
      type: 'tool_call',
      x: 0,
      y: 0,
      description:
        'Assemble a read-only snapshot of the whole questionnaire — structure, goal/audience, resolved run-time config, data slots, scoring, and lifecycle state — as the advisor’s context. Nothing is written.',
      meta: { note: 'AdvisorContext: structure + config + data slots + scoring + lifecycle.' },
      next: ['narrative'],
    }),
    node({
      id: 'narrative',
      name: 'Stream narrative review',
      type: 'agent_call',
      x: 220,
      y: 0,
      description:
        'Phase 1: the Advisor streams a plain-language review token-by-token — what the respondent experience is like and where the questionnaire is in its lifecycle.',
      meta: {
        agentSlug: QUESTIONNAIRE_ADVISOR_AGENT_SLUG,
        note: 'Phase 1 — a streamed reasoning-model narrative (chatStream). Prompt built in code, not catalogued.',
      },
      next: ['suggestions'],
    }),
    node({
      id: 'suggestions',
      name: 'Propose config tweaks',
      type: 'agent_call',
      x: 440,
      y: 0,
      description:
        'Phase 2: a structured pass re-reads the same snapshot plus the narrative just produced and emits conflicts to fix and concrete, one-click configuration suggestions.',
      meta: {
        agentSlug: QUESTIONNAIRE_ADVISOR_AGENT_SLUG,
        note: 'Phase 2 — a structured completion → conflicts + one-click config suggestions.',
      },
      next: ['apply'],
    }),
    node({
      id: 'apply',
      name: 'Admin applies tweaks',
      type: 'report',
      x: 660,
      y: 0,
      description:
        'The admin reads the review and applies any of the proposed configuration tweaks with one click on the Settings tab — the advisor never changes config on its own.',
      meta: { note: 'The admin one-click applies suggested config changes (Settings tab).' },
    }),
  ],
  applicability: (ctx) => {
    if (!ctx.flags.advisor) {
      return unavailable('The Config Advisor is not enabled.');
    }
    return applies('The Config Advisor can review this version’s configuration.');
  },
});
