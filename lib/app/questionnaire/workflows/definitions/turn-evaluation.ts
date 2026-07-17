/**
 * Workflow diagram: Turn evaluation (interview-quality judge).
 *
 * The admin-triggered judge the Preview Turn Inspector runs over ONE completed turn
 * (`lib/app/questionnaire/turn-evaluation/evaluate-turn.ts`). It reads the inspector dump plus the
 * server-loaded questionnaire objectives, builds the load-bearing rubric prompt, runs one
 * structured reasoning-model call, validates + repairs the verdict against the Zod contract, then
 * serialises it to Markdown and best-effort-persists it. Sibling of the design-evaluation judge;
 * fed by the `turn-inspector` workflow.
 */

import { TURN_EVALUATOR_AGENT_SLUG } from '@/lib/app/questionnaire/constants';

import { applies, diagram, inactive, node } from '@/lib/app/questionnaire/workflows/types';

export const turnEvaluationWorkflow = diagram({
  slug: 'turn-evaluation',
  title: 'Turn evaluation',
  description: 'Scores a single preview turn against its objectives.',
  sourceModule: 'lib/app/questionnaire/turn-evaluation/evaluate-turn.ts',
  entryStepId: 'dump',
  errorStrategy: 'fail',
  steps: [
    node({
      id: 'dump',
      name: 'Load turn + objectives',
      type: 'tool_call',
      x: 0,
      y: 0,
      description:
        "Take the inspector turn dump the drawer holds (Zod-validated — it's client-supplied) and load the questionnaire objectives (goal, audience, selection strategy, tone) server-side from the session's version, so they can't be spoofed.",
      meta: {
        note: 'Client-held inspector dump (validated) + server-loaded objectives — never trust the dump for objectives.',
      },
      next: ['prompt'],
    }),
    node({
      id: 'prompt',
      name: 'Build rubric prompt',
      type: 'tool_call',
      x: 220,
      y: 0,
      description:
        'Compose the system rubric — the evaluator persona plus the hard rules that keep it honest (judge only calls that actually ran; compare each output against the prompt that produced it; treat embedding/VEC calls as retrieval) — and the user message: the serialized turn plus the objectives. The rubric is versioned so scores stay comparable.',
      meta: {
        note: 'buildTurnEvaluatorPrompt: load-bearing SYSTEM_RUBRIC (stamped TURN_RUBRIC_VERSION) + serialized turn.',
      },
      next: ['judge'],
    }),
    node({
      id: 'judge',
      name: 'Evaluate turn',
      type: 'agent_call',
      x: 440,
      y: 0,
      description:
        'The Turn Evaluator — a reasoning-tier judge with an empty binding that resolves to the system default — runs one structured completion, returning per-call scores plus interviewer, extraction, question-selection, information-gain, prompt-drift, and efficiency sections and an overall 0–100.',
      meta: {
        agentSlug: TURN_EVALUATOR_AGENT_SLUG,
        promptCatalogSlug: TURN_EVALUATOR_AGENT_SLUG,
        promptSpecimenId: 'turn-eval.judge',
        note: 'One structured reasoning call; empty binding → system default (reasoning tier). Rubric lives in code, not the seeded agent.',
      },
      next: ['validate'],
    }),
    node({
      id: 'validate',
      name: 'Validate + repair',
      type: 'guard',
      x: 660,
      y: 0,
      description:
        'Validate the response against the Zod contract. On a schema-invalid (but JSON-parseable) result, retry once at temperature 0 with a message naming exactly which fields were wrong; a second failure is a clean error, not a broken drawer. Pass → serialize.',
      meta: {
        note: 'Zod validate → retry-once-at-temp-0 naming the bad field paths → fail cleanly.',
      },
      next: [{ targetStepId: 'serialize', condition: 'Pass' }],
    }),
    node({
      id: 'serialize',
      name: 'Serialize verdict',
      type: 'tool_call',
      x: 880,
      y: 0,
      description:
        'Render the validated verdict to the Markdown the drawer shows and the reviewer reads, stamped with the rubric version so a score is never read without the rubric that produced it.',
      meta: {
        note: 'serializeTurnEvaluation → Markdown; the verdict carries TURN_RUBRIC_VERSION.',
      },
      next: ['persist'],
    }),
    node({
      id: 'persist',
      name: 'Persist + return',
      type: 'report',
      x: 1100,
      y: 0,
      description:
        'Persist the verdict alongside a snapshot of the input it judged (so it can later be searched, commented on, and flagged for learning) and return it with the new evaluation id. The write is best-effort — a persistence failure logs and returns a null id rather than losing the verdict; cost is logged fire-and-forget.',
      meta: {
        note: 'Best-effort persist (snapshot + verdict) → evaluationId; cost logged fire-and-forget.',
      },
    }),
  ],
  applicability: (ctx) => {
    if (!ctx.config.previewInspectorEnabled) {
      return inactive('The turn inspector is off, so there are no captured turns to evaluate.');
    }
    return applies('Preview turns on this version can be scored by the turn evaluator.');
  },
});
