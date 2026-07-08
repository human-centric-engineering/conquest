/**
 * Workflow diagram: Structure Edit Agent.
 *
 * Documents the "Edit with AI" pipeline on the Structure editor
 * (`app/api/v1/app/questionnaires/_lib/edit-agent-pipeline.ts`). A natural-language
 * instruction is translated into precise edit-ops, resolved to a preview,
 * confirmed by the admin, then applied against live structure in one transaction.
 * Draft-only — launched versions fork on edit.
 */

import { QUESTIONNAIRE_EDIT_AGENT_SLUG } from '@/lib/app/questionnaire/constants';

import {
  applies,
  diagram,
  inactive,
  node,
  unavailable,
} from '@/lib/app/questionnaire/workflows/types';

export const structureEditWorkflow = diagram({
  slug: 'structure-edit',
  title: 'Structure edit agent',
  description:
    'Edit a draft by describing the change — "merge the last two sections", "make question 3 a single-select". The agent turns your instruction into precise edit-ops, shows you exactly what will change, and applies it only once you confirm.',
  sourceModule: 'app/api/v1/app/questionnaires/_lib/edit-agent-pipeline.ts',
  entryStepId: 'instruction',
  errorStrategy: 'fail',
  steps: [
    node({
      id: 'instruction',
      name: 'Read the instruction',
      type: 'tool_call',
      x: 0,
      y: 0,
      description:
        "Take the admin's natural-language instruction plus the current draft structure as context for the edit agent.",
      meta: { note: 'The plain-English edit request.' },
      next: ['translate'],
    }),
    node({
      id: 'translate',
      name: 'Translate to edit-ops',
      type: 'agent_call',
      x: 220,
      y: 0,
      description:
        'The Structure Editor turns the instruction into a list of precise, typed edit-ops (add/move/retype/remove) — or a whole-document rewrite when the change is sweeping.',
      meta: {
        agentSlug: QUESTIONNAIRE_EDIT_AGENT_SLUG,
        note: 'LLM turns the instruction into precise edit-ops.',
      },
      next: ['plan'],
    }),
    node({
      id: 'plan',
      name: 'Resolve preview',
      type: 'tool_call',
      x: 440,
      y: 0,
      description:
        'Resolve the ops against the current structure to compute a full before/after preview. Nothing is written — this is a dry run the admin can read.',
      meta: { note: 'Resolve ops to a preview — no write.' },
      next: ['confirm'],
    }),
    node({
      id: 'confirm',
      name: 'Admin confirms',
      type: 'human_approval',
      x: 660,
      y: 0,
      description:
        'The admin reviews the exact set of changes and approves or discards. The edit does not touch the live structure until this gate passes.',
      meta: { note: 'Admin reviews the exact changes.' },
      next: ['apply'],
    }),
    node({
      id: 'apply',
      name: 'Apply changes',
      type: 'report',
      x: 880,
      y: 0,
      description:
        'Re-resolve the ops against the live structure (guarding against drift) and apply them as granular per-entity updates in a single transaction.',
      meta: {
        note: 'Re-resolve ops against live structure, granular per-entity update in one tx.',
      },
    }),
  ],
  applicability: (ctx) => {
    if (!ctx.flags.editAgent) {
      return unavailable('The structure edit agent is not enabled.');
    }
    if (ctx.versionStatus === 'draft') {
      return applies('This is a draft version — edit with AI applies here.');
    }
    return inactive('Launched versions fork on edit — open a draft to edit with AI.');
  },
});
