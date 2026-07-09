/**
 * Workflow diagram: Agent Settings Advisor.
 *
 * The AI "explain / tune" layer on the admin **Agent Settings** surface
 * (`lib/app/questionnaire/agent-advisory/explain.ts`, `explainAgentSettings`). A deterministic
 * baseline compares each questionnaire agent's model / temperature / max-tokens / reasoning-effort
 * against a hand-maintained advisory table; then a single structured reasoning completion explains
 * the trade-offs in plain language and optionally proposes a one-click patch the admin applies.
 * Unlike the questionnaire Config Advisor it does not stream — it is one structured call. Its prompt
 * is built in code and is not in the Prompt Library (like the report/editor support agents), so its
 * agent node shows no Prompt tab. Workspace-level (about the agents, not a specific version).
 */

import { AGENT_SETTINGS_ADVISOR_SLUG } from '@/lib/app/questionnaire/agent-advisory/explain-schema';

import { applies, diagram, node, unavailable } from '@/lib/app/questionnaire/workflows/types';

export const agentSettingsAdvisorWorkflow = diagram({
  slug: 'agent-settings-advisor',
  title: 'Agent Settings Advisor',
  description: "Explains and tunes each AI agent's settings.",
  sourceModule: 'lib/app/questionnaire/agent-advisory/explain.ts',
  entryStepId: 'evaluate',
  errorStrategy: 'fail',
  steps: [
    node({
      id: 'evaluate',
      name: 'Evaluate current settings',
      type: 'tool_call',
      x: 0,
      y: 0,
      description:
        "A deterministic baseline compares the agent's current model, temperature, max tokens, and reasoning effort against a hand-maintained advisory table (reasoning / chat / routing tiers). Read-only — nothing is written.",
      meta: {
        note: 'Deterministic compare vs the advisory recommendation table (agent-advisory/recommendations.ts).',
      },
      next: ['explain'],
    }),
    node({
      id: 'explain',
      name: 'Explain settings with AI',
      type: 'agent_call',
      x: 220,
      y: 0,
      description:
        'A single structured reasoning completion turns the baseline into a plain-language explanation of the trade-offs, plus an optional concrete suggestion (a patch over model / temperature / max-tokens / reasoning-effort).',
      meta: {
        agentSlug: AGENT_SETTINGS_ADVISOR_SLUG,
        note: 'One structured completion (not streamed) → narrative + optional suggestion. Prompt built in code, not catalogued.',
      },
      next: ['apply'],
    }),
    node({
      id: 'apply',
      name: 'Admin applies suggestion',
      type: 'report',
      x: 440,
      y: 0,
      description:
        'The admin reads the explanation and, if there is a suggestion, applies the proposed settings with one click on the Agent Settings tab — the advisor never changes an agent on its own.',
      meta: {
        note: 'The admin one-click applies the suggested settings patch (Agent Settings tab).',
      },
    }),
  ],
  applicability: (ctx) => {
    // Workspace-level: the advisor is about the agents themselves, not a specific version. Its route
    // gates only on the master questionnaires flag, so mirror that — available whenever the surface is.
    if (!ctx.flags.master) {
      return unavailable('Questionnaires are not enabled in this workspace.');
    }
    return applies('The Agent Settings Advisor is available for this workspace.');
  },
});
