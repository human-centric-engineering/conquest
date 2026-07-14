/**
 * Workflow diagram: Report Design Assistant.
 *
 * The admin-triggered chat on the Respondent Report → Generation tab
 * (`lib/app/questionnaire/report/craft.ts`). A conversational helper that interviews the admin about
 * their questionnaire and drafts the three free-text report generation fields — style & voice
 * instructions, desired structure, and background context. One turn = the prior messages + the
 * editor's current generation values in → `{ reply, suggestions }` out, where `suggestions` carries
 * the FULL proposed text for any field it wants to change. Read-only: it proposes text; the admin
 * applies each field. Like the other report/editor support agents, its prompt is built in code and is
 * not in the Prompt Library, so its node shows no Prompt tab.
 */

import { RESPONDENT_REPORT_ASSISTANT_AGENT_SLUG } from '@/lib/app/questionnaire/constants';

import { applies, diagram, node, unavailable } from '@/lib/app/questionnaire/workflows/types';

export const reportConfigAssistantWorkflow = diagram({
  slug: 'report-config-assistant',
  title: 'Report Design Assistant',
  description:
    'Drafts the report’s style, structure, and background-context fields conversationally.',
  sourceModule: 'lib/app/questionnaire/report/craft.ts',
  entryStepId: 'context',
  errorStrategy: 'fail',
  steps: [
    node({
      id: 'context',
      name: 'Gather chat + current config',
      type: 'tool_call',
      x: 0,
      y: 0,
      description:
        'Each turn sends the running chat transcript plus the editor’s live generation values (the current style & voice instructions, desired structure, and background context) — so the assistant builds on what is already configured rather than starting from scratch. Nothing is written.',
      meta: {
        note: 'Transcript + the editor’s current generation values (stateless server-side).',
      },
      next: ['craft'],
    }),
    node({
      id: 'craft',
      name: 'Draft config fields',
      type: 'agent_call',
      x: 220,
      y: 0,
      description:
        'The assistant replies conversationally and, when it has a concrete proposal, returns the full text for any of the three report generation fields — style & voice instructions, desired structure, and background context. It may ask a clarifying question or two before proposing.',
      meta: {
        agentSlug: RESPONDENT_REPORT_ASSISTANT_AGENT_SLUG,
        note: 'Structured completion → { reply, suggestions }. Prompt built in code, not catalogued.',
      },
      next: ['apply'],
    }),
    node({
      id: 'apply',
      name: 'Admin applies fields',
      type: 'report',
      x: 440,
      y: 0,
      description:
        'The admin reviews each proposed field and applies it into the Generation tab with one click — the assistant never changes config on its own. Applied values save through the normal report config PATCH.',
      meta: { note: 'Per-field apply into the Generation tab, saved via the config PATCH.' },
    }),
  ],
  applicability: (ctx) => {
    if (!ctx.flags.respondentReport) {
      return unavailable('Respondent reports are not enabled.');
    }
    return applies('The Report Design Assistant can help configure this version’s report.');
  },
});
