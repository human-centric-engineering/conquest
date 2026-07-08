/**
 * Behind-the-Scenes workflow visualizer — pure types + authoring helpers.
 *
 * This module is deliberately **client-safe**: it imports only pure types
 * (`WorkflowDefinition` from the platform, plus the questionnaire config/status
 * types) and contains no server, prisma, or React-Flow runtime dependency. The
 * hand-authored diagram files (`definitions/*.ts`) and the pure `registry.ts`
 * import from here; the server-only `enrich.ts` / `applicability.ts` layer live
 * data on top and are fetched over the API.
 *
 * We reuse the platform `WorkflowDefinition` shape verbatim so the read-only
 * canvas can run the existing pure `workflowDefinitionToFlow` adapter and the
 * registry-driven `PatternNode` unchanged. ConQuest-specific per-node metadata
 * (which agent runs it, its prompt, its tools, KB plug-points) rides alongside
 * the platform layout key under `WorkflowStep.config._meta` — the mapper
 * tolerates unknown config keys, stripping only `_layout`.
 *
 * @see .context/app/questionnaire/workflow-visualizer.md
 */

import type {
  ConditionalEdge,
  WorkflowDefinition,
  WorkflowStep,
  WorkflowStepType,
} from '@/types/orchestration';
import type {
  AppQuestionnaireStatus,
  QuestionnaireConfigShape,
} from '@/lib/app/questionnaire/types';

// ---------------------------------------------------------------------------
// Per-node overlay
// ---------------------------------------------------------------------------

/** Where a knowledge base is (or could be) wired into a step. */
export interface NodeKbPlugPoint {
  /** `active` = a KB is used here today; `pluggable` = a natural insertion point. */
  status: 'active' | 'pluggable';
  /** How the KB attaches: agent restricted-access grant, or a per-demo-client tag. */
  mechanism: 'agent-grant' | 'demo-client-tag';
  description: string;
}

/**
 * ConQuest overlay stored on each `WorkflowStep.config` under `_meta`. All
 * fields are string keys resolved server-side by `enrich.ts` — the definition
 * files never embed live data.
 */
export interface NodeMeta {
  /** `AiAgent.slug` (constants.ts). Absent for deterministic (non-LLM) steps. */
  agentSlug?: string;
  /** Prompt-catalog entry slug (usually === agentSlug). Enables the Prompt Library link. */
  promptCatalogSlug?: string;
  /** A specimen id within that catalog entry, e.g. `extract-answer.question`. */
  promptSpecimenId?: string;
  /** Capability (tool) slugs this step dispatches — `*_CAPABILITY_SLUG` constants. */
  capabilitySlugs?: string[];
  /** Knowledge-base plug-point, if this step reads or could read a KB. */
  kb?: NodeKbPlugPoint;
  /** Short "what runs here / when" note shown in the info panel. */
  note?: string;
}

/** Read the `_meta` overlay off a step config (safe on any config blob). */
export function getNodeMeta(config: Record<string, unknown>): NodeMeta {
  const raw = config['_meta'];
  return raw && typeof raw === 'object' ? raw : {};
}

// ---------------------------------------------------------------------------
// Questionnaire lens — applicability
// ---------------------------------------------------------------------------

/**
 * Normalised feature-flag set the applicability predicates read. Deliberately
 * decoupled from the platform `QuestionnaireWorkspaceFlags` (which uses
 * different field names and omits a few flags) so predicates stay pure and
 * trivially testable. Every sub-flag here is already ANDed with the master flag
 * by `buildApplicabilityContext`.
 */
export interface WorkflowFlags {
  master: boolean;
  generativeAuthoring: boolean;
  editAgent: boolean;
  liveSessions: boolean;
  answerExtraction: boolean;
  dataSlots: boolean;
  respondentReport: boolean;
  cohortReport: boolean;
  introScreen: boolean;
  voiceInput: boolean;
  personaSelection: boolean;
  adaptiveSelection: boolean;
}

/** Everything a diagram's `applicability` predicate reads. Built per version, server-side. */
export interface ApplicabilityContext {
  flags: WorkflowFlags;
  config: QuestionnaireConfigShape;
  versionStatus: AppQuestionnaireStatus;
  /** `'admin-supplied' | 'inferred' | 'pre-existing'` — `inferred` marks a composed version. */
  goalProvenance: string | null;
  sourceDocumentCount: number;
  dataSlotCount: number;
  roundItemCount: number;
}

export type ApplicabilityStatus = 'applies' | 'inactive' | 'unavailable';

export interface WorkflowApplicability {
  status: ApplicabilityStatus;
  /** One-line explanation shown as a tooltip on the dimmed/highlighted chip. */
  reason: string;
}

/** Terse constructors for predicate bodies. */
export const applies = (reason: string): WorkflowApplicability => ({ status: 'applies', reason });
export const inactive = (reason: string): WorkflowApplicability => ({ status: 'inactive', reason });
export const unavailable = (reason: string): WorkflowApplicability => ({
  status: 'unavailable',
  reason,
});

// ---------------------------------------------------------------------------
// Diagram
// ---------------------------------------------------------------------------

/** A hand-authored ConQuest pipeline diagram. */
export interface ConquestWorkflowDiagram {
  /** Stable url key, e.g. `conversation-turn`. */
  slug: string;
  title: string;
  /** Demo blurb shown above the canvas. */
  description: string;
  /** The code this documents — anchors drift review; not user-facing. */
  sourceModule: string;
  /** Platform DAG, verbatim; per-node `_meta`/`_layout` ride in `step.config`. */
  definition: WorkflowDefinition;
  /** Per-version lens predicate — evaluated only when a questionnaire is selected. */
  applicability(ctx: ApplicabilityContext): WorkflowApplicability;
}

/** Lightweight card shape returned by the list endpoint. */
export interface WorkflowSummary {
  slug: string;
  title: string;
  description: string;
  sourceModule: string;
  stepCount: number;
  /** Present only when the list is fetched with a `?versionId=` lens. */
  applicability?: WorkflowApplicability;
}

// ---------------------------------------------------------------------------
// Authoring helpers — keep the definition files terse and layout deterministic
// ---------------------------------------------------------------------------

/** An outgoing edge: a bare target id (unconditional) or a labelled branch. */
export type NodeEdge = string | ConditionalEdge;

function toConditionalEdge(edge: NodeEdge): ConditionalEdge {
  return typeof edge === 'string' ? { targetStepId: edge } : edge;
}

/**
 * Build a `WorkflowStep` with hand-placed layout and ConQuest `_meta`. Packs
 * `{x,y}` into `config._layout` (deterministic demo layout — no BFS) and the
 * overlay into `config._meta`, matching what the platform mapper + our
 * `getNodeMeta` read back.
 */
export function node(opts: {
  id: string;
  name: string;
  type: WorkflowStepType;
  x: number;
  y: number;
  description?: string;
  meta?: NodeMeta;
  next?: NodeEdge[];
  /** Extra platform config (e.g. `routes`/`branches` to drive output handles). */
  config?: Record<string, unknown>;
}): WorkflowStep {
  const config: Record<string, unknown> = {
    ...(opts.config ?? {}),
    _layout: { x: opts.x, y: opts.y },
    ...(opts.meta ? { _meta: opts.meta } : {}),
  };
  return {
    id: opts.id,
    name: opts.name,
    ...(opts.description ? { description: opts.description } : {}),
    type: opts.type,
    config,
    nextSteps: (opts.next ?? []).map(toConditionalEdge),
  };
}

/** Assemble a diagram from its steps, defaulting the platform error strategy. */
export function diagram(opts: {
  slug: string;
  title: string;
  description: string;
  sourceModule: string;
  entryStepId: string;
  steps: WorkflowStep[];
  errorStrategy?: WorkflowDefinition['errorStrategy'];
  applicability: ConquestWorkflowDiagram['applicability'];
}): ConquestWorkflowDiagram {
  return {
    slug: opts.slug,
    title: opts.title,
    description: opts.description,
    sourceModule: opts.sourceModule,
    definition: {
      steps: opts.steps,
      entryStepId: opts.entryStepId,
      errorStrategy: opts.errorStrategy ?? 'fail',
    },
    applicability: opts.applicability,
  };
}
