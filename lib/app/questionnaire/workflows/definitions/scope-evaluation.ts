/**
 * Workflow diagram: Adaptive Scope evaluation (judge panel) (F17.21).
 *
 * A second "panel of judges" — sibling to the design-evaluation panel (`design-evaluation.ts`) —
 * but scoring the AUTHORED ADAPTIVE-SCOPE CONFIG (topics, hard rules, planner instructions, budget)
 * rather than the question structure. One structured judge runs per dimension — criteria quality,
 * rule integrity, budget realism, coverage-and-burden — fanned out concurrently, each returning a
 * 0–1 score plus actionable findings. Each judge is its own seeded agent, so they render as
 * individual nodes wrapped in a "Judge panel" box. Per-judge failure is fail-soft: a missing or
 * flaky judge degrades to a diagnostic for that one dimension while the other three still return.
 *
 * Structural only, v1: the judges read the authored config exactly as an admin would on the Topics
 * tab — they do not read live session data or behavioural analytics. They are also told what the
 * deterministic `validateAdaptiveScope` checker already caught, so they focus on the judgement calls
 * no mechanical rule can make, not on re-finding what that checker already flags.
 *
 * No reconciler here, unlike the seven-dimension design-evaluation panel: the four scope dimensions
 * each target a different field of a different object (topic criteria text, the rules array, the
 * settings blob), so the collision case the reconciler exists for — two judges independently
 * rewriting the same question's prompt — mostly cannot occur. A deliberate v1 cut, not an oversight.
 */

import type { WorkflowStep } from '@/types/orchestration';

import { EVALUATE_SCOPE_CAPABILITY_SLUG } from '@/lib/app/questionnaire/constants';
import { SCOPE_EVALUATION_DIMENSION_SPECS } from '@/lib/app/questionnaire/scope-evaluation/dimensions';
import { SCOPE_EVALUATION_DIMENSIONS } from '@/lib/app/questionnaire/scope-evaluation/types';

import { applies, diagram, node } from '@/lib/app/questionnaire/workflows/types';

/** The four judges share this box on the canvas. */
const JUDGE_GROUP = { id: 'scope-judge-panel', label: 'Judge panel · 4 dimensions, in parallel' };
const JUDGE_X = 460;
const JUDGE_SPACING = 132;
/** Centre the stack vertically on y = 0 so the fan-out / fan-in edges stay symmetric. */
const JUDGE_Y0 = -((SCOPE_EVALUATION_DIMENSIONS.length - 1) / 2) * JUDGE_SPACING;

/** One node per seeded dimension judge — each its own agent, prompt, and evaluate-scope call. */
const judgeNodes: WorkflowStep[] = SCOPE_EVALUATION_DIMENSIONS.map((dimension, i) => {
  const spec = SCOPE_EVALUATION_DIMENSION_SPECS[dimension];
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
      capabilitySlugs: [EVALUATE_SCOPE_CAPABILITY_SLUG],
      group: JUDGE_GROUP,
      note: `Scores the "${pretty}" dimension — one structured evaluate-scope call. Fail-soft: its failure degrades to a diagnostic for this dimension only.`,
    },
    next: ['aggregate'],
  });
});

export const scopeEvaluationWorkflow = diagram({
  slug: 'scope-evaluation',
  title: 'Adaptive Scope evaluation (judge panel)',
  description: 'A judge panel scores the authored Adaptive Scope configuration.',
  sourceModule: 'lib/app/questionnaire/scope-evaluation/run-panel.ts',
  entryStepId: 'structure',
  // Per-judge failure is fail-soft *inside* the panel (a diagnostic for that one dimension), so the
  // diagram keeps the default `fail` strategy rather than a DAG-level continue.
  steps: [
    node({
      id: 'structure',
      name: 'Build scope structure snapshot',
      type: 'tool_call',
      x: 0,
      y: 0,
      description:
        "Flatten the version's authored topics, hard rules, planner settings and session budget into the judge input, alongside the issues the deterministic validateAdaptiveScope checker already caught — the single snapshot every judge reads.",
      meta: { note: 'buildScopeEvaluationStructure → the ScopeStructureInput every judge scores.' },
      // Fan out to all four judges concurrently.
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
      meta: {
        note: 'Reduce to { results, summary }: dimensionsRun / dimensionsFailed, totalFindings.',
      },
      next: ['findings'],
    }),
    node({
      id: 'findings',
      name: 'Persist run + findings',
      type: 'report',
      x: 1140,
      y: 0,
      description:
        "Persist the evaluation run and one finding row per judge finding. Each finding carries a proposed edit-op (rewrite a topic's criteria, change its depth, add a rule) that becomes a one-click applicable change to the Adaptive Scope config, reviewed from the Topics tab. The same panel is also exposed as a preview-only endpoint that scores without persisting, for quick tuning before a real run.",
      meta: {
        note: 'persistScopeEvaluationRun() — the run + findings the Topics tab review queue and the Questionnaire Pack both read.',
      },
    }),
  ],
  applicability: () =>
    applies('The judge panel can score this version’s authored Adaptive Scope configuration.'),
});
