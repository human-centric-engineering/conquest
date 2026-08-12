/**
 * Workflow diagram: Design evaluation (judge panel).
 *
 * The admin-triggered quality gate that scores a draft questionnaire's *design* before it goes
 * live (`lib/app/questionnaire/evaluation/run-panel.ts`). One structured judge runs per dimension —
 * clarity, coverage, duplicates, type-fit, ordering, audience-match, goal-match — fanned out
 * concurrently, each returning a 0–1 score plus actionable findings (proposed edits). Each judge is
 * its own seeded agent, so they render as individual nodes wrapped in a "Judge panel" box. Per-judge
 * failure is fail-soft: a missing or flaky judge degrades to a diagnostic for that one dimension
 * while the other six still return.
 *
 * One more agent runs after the fan-in. The judges are blind to each other by design — that is what
 * keeps their scores independent — so a question several of them flag comes back with several
 * rewrites that each fix one dimension and undo another. The **Suggestion Reconciler** takes those
 * contested questions and proposes wording that satisfies as many judges at once as it can. It is
 * fail-soft too, and in the strong sense: if it is unseeded or its call fails, the run still returns
 * every judge's own suggestion.
 */

import type { WorkflowStep } from '@/types/orchestration';

import {
  EVALUATE_STRUCTURE_CAPABILITY_SLUG,
  RECONCILE_SUGGESTIONS_CAPABILITY_SLUG,
  RECONCILER_AGENT_SLUG,
} from '@/lib/app/questionnaire/constants';
import { EVALUATION_DIMENSION_SPECS } from '@/lib/app/questionnaire/evaluation/dimensions';
import { EVALUATION_DIMENSIONS } from '@/lib/app/questionnaire/evaluation/types';

import { applies, diagram, node } from '@/lib/app/questionnaire/workflows/types';

/** The seven judges share this box on the canvas. */
const JUDGE_GROUP = { id: 'judge-panel', label: 'Judge panel · 7 dimensions, in parallel' };
const JUDGE_X = 460;
const JUDGE_SPACING = 132;
/** Centre the stack vertically on y = 0 so the fan-out / fan-in edges stay symmetric. */
const JUDGE_Y0 = -((EVALUATION_DIMENSIONS.length - 1) / 2) * JUDGE_SPACING;

/** One node per seeded dimension judge — each its own agent, prompt, and evaluate-structure call. */
const judgeNodes: WorkflowStep[] = EVALUATION_DIMENSIONS.map((dimension, i) => {
  const spec = EVALUATION_DIMENSION_SPECS[dimension];
  const pretty = dimension.replace(/_/g, '-');
  return node({
    id: `judge-${pretty}`,
    name: spec.label,
    type: 'agent_call',
    x: JUDGE_X,
    y: JUDGE_Y0 + i * JUDGE_SPACING,
    description: spec.summary,
    meta: {
      agentSlug: spec.slug,
      promptCatalogSlug: spec.slug,
      promptSpecimenId: `${spec.slug}.judge`,
      capabilitySlugs: [EVALUATE_STRUCTURE_CAPABILITY_SLUG],
      group: JUDGE_GROUP,
      note: `Scores the "${pretty}" dimension — one structured evaluate-structure call. Fail-soft: its failure degrades to a diagnostic for this dimension only.`,
    },
    next: ['aggregate'],
  });
});

export const designEvaluationWorkflow = diagram({
  slug: 'design-evaluation',
  title: 'Questionnaire design evaluation (judge panel)',
  description: "A judge panel scores the questionnaire's design.",
  sourceModule: 'lib/app/questionnaire/evaluation/run-panel.ts',
  entryStepId: 'structure',
  // Per-judge failure is fail-soft *inside* the panel (a diagnostic for that one dimension), so the
  // diagram keeps the default `fail` strategy rather than a DAG-level continue.
  steps: [
    node({
      id: 'structure',
      name: 'Build structure snapshot',
      type: 'tool_call',
      x: 0,
      y: 0,
      description:
        'Flatten the draft into the judge input — its sections, typed questions, required/optional split, inferred goal and audience — the single snapshot every judge reads.',
      meta: { note: 'buildEvaluationStructure → the VersionStructureInput every judge scores.' },
      // Fan out to all seven judges concurrently.
      next: judgeNodes.map((j) => j.id),
    }),
    ...judgeNodes,
    node({
      id: 'aggregate',
      name: 'Aggregate verdicts',
      type: 'tool_call',
      x: 920,
      y: 0,
      description:
        'Reduce the per-dimension verdicts to one panel result — how many dimensions ran vs failed, and the total findings across the panel — so a partial panel still returns a usable score.',
      meta: { note: 'Reduce to { results, summary }: dimensionsRun / failed, totalFindings.' },
      next: ['reconcile'],
    }),
    node({
      id: 'reconcile',
      name: 'Suggestion Reconciler',
      type: 'agent_call',
      x: 1140,
      y: 0,
      description:
        'For each question MORE THAN ONE judge flagged, propose one or two alternative phrasings that satisfy as many of their concerns as possible at once — so the admin makes one decision instead of choosing between rewrites that undo each other.',
      meta: {
        agentSlug: RECONCILER_AGENT_SLUG,
        promptCatalogSlug: RECONCILER_AGENT_SLUG,
        promptSpecimenId: `${RECONCILER_AGENT_SLUG}.reconcile`,
        capabilitySlugs: [RECONCILE_SUGGESTIONS_CAPABILITY_SLUG],
        note: 'One batched call over the contested questions only (a question one judge flagged already has that judge’s rewrite). Names the concerns each phrasing resolves, and any that wording alone cannot. Fail-soft: unseeded or failed, the run still returns every judge’s own suggestion.',
      },
      next: ['findings'],
    }),
    node({
      id: 'findings',
      name: 'Persist run + findings',
      type: 'report',
      x: 1360,
      y: 0,
      description:
        'Persist the evaluation run, its findings, and the reconciled alternatives — findings become one-click applicable edits, and the review queue, the run detail page and the Questionnaire Pack all read the same reconciled wording.',
      meta: {
        note: 'Persist the run + findings + reconciledSuggestions; findings become one-click applicable edits.',
      },
    }),
  ],
  applicability: () => applies('The judge panel can score this version’s design.'),
});
