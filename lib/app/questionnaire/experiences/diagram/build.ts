/**
 * Build a canvas diagram of ONE authored experience.
 *
 * The admin surface renders a journey as a flat ordered list on both the Overview and Steps tabs.
 * That is a fair rendering of a facilitated meeting, which really is a sequence — but it is a poor
 * one for an agentic switcher, which is a branching decision wearing a list's clothes. This module
 * turns the authored rows into the platform `WorkflowDefinition` shape so the read-only
 * Behind-the-Scenes canvas can draw the actual shape.
 *
 * Pure and client-safe: no Prisma, no Next, no React. It takes the already-resolved
 * {@link ExperienceDetailView} (whose read seam batches its title lookups) and the routing rules,
 * and returns a definition. Layout is deliberately NOT emitted — omitting `_layout` lets the
 * platform mapper's BFS auto-layout place nodes, which is the right trade for a graph whose shape
 * changes every time an author adds a step. Hand-placed coordinates are worth it only for the
 * curated explainer diagrams.
 *
 * **Dangling pointers are the load-bearing case.** `questionnaireId` and a rule's `targetStepKey`
 * are unmodelled (UG-1) precisely so archiving a questionnaire cannot cascade away an experience's
 * structure and run history. The cost is that either may point at nothing. Every such pointer here
 * renders as a visibly missing node and NEVER throws — a diagram that crashes on a deleted
 * questionnaire would take out the whole tab.
 *
 * @see .context/app/questionnaire/experiences.md
 */

import { EXPERIENCE_ROUTER_AGENT_SLUG } from '@/lib/app/questionnaire/experiences/constants';
import type { RoutingRule } from '@/lib/app/questionnaire/experiences/routing/types';
import { ROUTING_RULE_OPERATOR_LABELS } from '@/lib/app/questionnaire/experiences/routing/types';
import type {
  ExperienceDetailView,
  ExperienceStepView,
} from '@/lib/app/questionnaire/experiences/views';
import { entryStep, routableSteps } from '@/lib/app/questionnaire/experiences/views';
import { EXPERIENCE_ROUTING_FALLBACK_LABELS } from '@/lib/app/questionnaire/experiences/types';
import type { NodeMeta } from '@/lib/app/questionnaire/workflows/types';
import type { ConditionalEdge, WorkflowDefinition, WorkflowStep } from '@/types/orchestration';

/** Node id prefixes — kept distinct so a step id can never collide with a synthetic node. */
const DECISION_ID = '__decision';
const SELECTOR_ID = '__selector';
const CONCLUDE_ID = '__conclude';
const UNRESOLVED_ID = '__unresolved';
const EMPTY_ID = '__empty';

function stepNodeId(step: ExperienceStepView): string {
  return `step-${step.id}`;
}

/**
 * How a step's questionnaire pointer should read on the canvas.
 *
 * The three states are genuinely different and an author needs to tell them apart: nothing attached
 * yet is a half-authored row, a resolved title is fine, and a set-but-unresolvable pointer means
 * the questionnaire was deleted out from under the experience.
 */
function questionnaireLine(step: ExperienceStepView): string {
  if (step.questionnaireId === null) return 'No questionnaire attached yet.';
  if (step.questionnaireTitle === null) {
    return 'Questionnaire missing — it may have been deleted.';
  }
  const version =
    step.versionNumber === null ? 'newest launched version' : `version ${step.versionNumber}`;
  return `${step.questionnaireTitle} (${version}).`;
}

/** Build one authored step's node. */
function stepNode(step: ExperienceStepView, next: ConditionalEdge[]): WorkflowStep {
  const meta: NodeMeta = { note: questionnaireLine(step) };
  const config: Record<string, unknown> = { _meta: meta };
  const details: string[] = [questionnaireLine(step)];

  if (step.purpose) details.push(`Purpose: ${step.purpose}`);

  switch (step.kind) {
    case 'entry':
      details.push('Every run begins here.');
      break;
    case 'branch':
      details.push(
        step.selectionCriteria
          ? `Chosen when: ${step.selectionCriteria}`
          : 'No selection criteria — the selector has little to go on when choosing this candidate.'
      );
      break;
    case 'breakout': {
      details.push(
        step.durationSeconds === null
          ? 'Untimed — the facilitator ends this breakout by hand.'
          : `Runs for ${Math.round(step.durationSeconds / 60)} minute(s), advisory only.`
      );
      if (step.rooms.length > 0) {
        config.branches = step.rooms.map((room) => ({ label: room.name }));
        details.push(
          `${step.rooms.length} room(s): ${step.rooms
            .map((room) => `${room.name} (${room.mode})`)
            .join(', ')}.`
        );
      }
      if (step.synthesisFocus) details.push(`Synthesis focus: ${step.synthesisFocus}`);
      break;
    }
    case 'report':
      // Honest rather than flattering: this kind is selectable in the step form but no runtime
      // module reads it. The run report is enqueued from `concludeRun`, not from a step of this
      // kind. Saying so on the canvas is more useful to an author than implying an effect.
      details.push(
        'Authored marker only — the run report is produced when the run concludes, not by this step.'
      );
      break;
  }

  return {
    id: stepNodeId(step),
    name: step.title,
    description: details.join(' '),
    type: nodeTypeForStep(step),
    config,
    nextSteps: next,
  };
}

/** Visual step type. A mapping for icon/colour only — never a claim about the platform engine. */
function nodeTypeForStep(step: ExperienceStepView): WorkflowStep['type'] {
  switch (step.kind) {
    case 'breakout':
      return step.rooms.length > 0 ? 'parallel' : 'agent_call';
    case 'report':
      return 'report';
    default:
      return 'agent_call';
  }
}

/** One rule, as a canvas edge label an author can match against the Routing tab. */
function ruleLabel(rule: RoutingRule): string {
  const operator = ROUTING_RULE_OPERATOR_LABELS[rule.operator] ?? rule.operator;
  return rule.value === null || rule.value === ''
    ? `${rule.dataSlotKey} ${operator}`
    : `${rule.dataSlotKey} ${operator} "${rule.value}"`;
}

/**
 * The single node every terminal path funnels into — the point where the run report is enqueued.
 */
function concludeNode(experience: ExperienceDetailView): WorkflowStep {
  const budget =
    experience.costBudgetUsd === null
      ? 'No run budget is set.'
      : `Runs stop and conclude if spend passes $${experience.costBudgetUsd}.`;
  return {
    id: CONCLUDE_ID,
    name: 'Conclude the run',
    description: `Where a journey is known to be over. One report covers every leg the respondent met — individual legs produce none of their own. ${budget}`,
    type: 'report',
    config: { _meta: { note: 'One report per run, not per leg.' } satisfies NodeMeta },
    nextSteps: [],
  };
}

/** A placeholder so an unauthored experience still renders a valid, readable canvas. */
function emptyDefinition(): WorkflowDefinition {
  return {
    entryStepId: EMPTY_ID,
    errorStrategy: 'fail',
    steps: [
      {
        id: EMPTY_ID,
        name: 'No steps yet',
        description:
          'Add an entry step — the questionnaire every run begins with — and this diagram will show the journey it makes.',
        type: 'guard',
        config: {},
        nextSteps: [],
      },
    ],
  };
}

/**
 * Build the diagram for one experience.
 *
 * Returns a definition that is always valid and always renderable, whatever state the authoring is
 * in. Never throws.
 */
export function buildExperienceDiagram(
  experience: ExperienceDetailView,
  rules: readonly RoutingRule[] = []
): WorkflowDefinition {
  const steps = [...experience.steps].sort((a, b) => a.ordinal - b.ordinal);
  if (steps.length === 0) return emptyDefinition();

  const entry = entryStep(steps);
  const nodes: WorkflowStep[] = [];

  // A facilitated meeting is genuinely a sequence: breakouts run one after another, and there is no
  // fork to draw. Rendering it through the switcher's decision machinery would invent a branch the
  // runtime never makes.
  if (experience.kind === 'facilitated_meeting') {
    const ordered = steps;
    ordered.forEach((step, index) => {
      const nextStep = ordered[index + 1];
      nodes.push(stepNode(step, [{ targetStepId: nextStep ? stepNodeId(nextStep) : CONCLUDE_ID }]));
    });
    nodes.push(concludeNode(experience));
    return {
      entryStepId: stepNodeId(entry ?? ordered[0]),
      errorStrategy: 'fail',
      steps: nodes,
    };
  }

  // ---- Agentic switcher: entry → decision → (rules | selector | fallback) → candidates ----

  const candidates = routableSteps(steps);
  const byKey = new Map(steps.map((step) => [step.key, step]));
  const orderedRules = [...rules].sort((a, b) => a.ordinal - b.ordinal);

  // Rule targets are matched by KEY and may not resolve — the rule editor stores a key, and a step
  // can be renamed or deleted after the rule was written.
  const unresolvedRules = orderedRules.filter((rule) => !byKey.has(rule.targetStepKey));

  const decisionRoutes: Array<{ label: string }> = [];
  const decisionEdges: ConditionalEdge[] = [];

  for (const rule of orderedRules) {
    const label = ruleLabel(rule);
    const target = byKey.get(rule.targetStepKey);
    decisionRoutes.push({ label });
    decisionEdges.push({
      targetStepId: target ? stepNodeId(target) : UNRESOLVED_ID,
      condition: label,
    });
  }

  const selectorLabel = 'No rule matched';
  decisionRoutes.push({ label: selectorLabel });
  decisionEdges.push({ targetStepId: SELECTOR_ID, condition: selectorLabel });

  if (entry) {
    nodes.push(stepNode(entry, [{ targetStepId: DECISION_ID }]));
  }

  nodes.push({
    id: DECISION_ID,
    name: orderedRules.length > 0 ? `Rules (${orderedRules.length})` : 'Rules (none)',
    description:
      orderedRules.length > 0
        ? 'Author-written rules, evaluated in order — the FIRST match wins outright and the selector is never consulted for it. Rules exist to hard-pin the outcomes you are certain about.'
        : 'No rules are configured, so every decision goes to the selector. Add rules on the Routing tab to hard-pin outcomes you are certain about.',
    type: 'route',
    config: {
      routes: decisionRoutes,
      _meta: { note: 'First match wins. Order is significant.' } satisfies NodeMeta,
    },
    nextSteps: decisionEdges,
  });

  // The selector's candidates, plus its own conclude option.
  const selectorEdges: ConditionalEdge[] = candidates.map((candidate) => ({
    targetStepId: stepNodeId(candidate),
    condition: candidate.title,
  }));
  selectorEdges.push({ targetStepId: CONCLUDE_ID, condition: 'Conclude' });

  const fallbackLabel = EXPERIENCE_ROUTING_FALLBACK_LABELS[experience.routingFallback];
  nodes.push({
    id: SELECTOR_ID,
    name: 'Routing selector',
    description: `Weighs what the entry leg gathered against each candidate's selection criteria. Accepted only above a confidence of ${experience.minRoutingConfidence}; below that — or on an error, a timeout, or a step name that does not exist — the fallback applies: ${fallbackLabel.toLowerCase()}. A respondent is never stranded.`,
    // `route` rather than `agent_call` so each candidate gets its own labelled output handle — the
    // registry derives handles from the step type, and a single-handle node would collapse every
    // candidate edge onto one point. The `_meta.agentSlug` below is what drives the node's agentic
    // (blue, "AI") treatment, so this stays visibly an LLM step despite the routing icon.
    type: 'route',
    config: {
      routes: [...candidates.map((c) => ({ label: c.title })), { label: 'Conclude' }],
      _meta: {
        agentSlug: EXPERIENCE_ROUTER_AGENT_SLUG,
        note: `Fallback: ${fallbackLabel}.`,
      } satisfies NodeMeta,
    },
    nextSteps: selectorEdges,
  });

  for (const step of steps) {
    if (entry && step.id === entry.id) continue;
    nodes.push(stepNode(step, [{ targetStepId: CONCLUDE_ID }]));
  }

  if (unresolvedRules.length > 0) {
    nodes.push({
      id: UNRESOLVED_ID,
      name: 'Unresolved target',
      description: `${unresolvedRules.length} routing rule(s) point at a step key that no longer exists (${unresolvedRules
        .map((rule) => rule.targetStepKey)
        .join(', ')}). Those rules can never match a real step — fix them on the Routing tab.`,
      type: 'guard',
      config: {
        _meta: { note: 'An authoring error, surfaced rather than hidden.' } satisfies NodeMeta,
      },
      nextSteps: [],
    });
  }

  nodes.push(concludeNode(experience));

  return {
    entryStepId: entry ? stepNodeId(entry) : DECISION_ID,
    errorStrategy: 'fail',
    steps: nodes,
  };
}
