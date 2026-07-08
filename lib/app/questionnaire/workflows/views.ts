/**
 * Behind-the-Scenes API view shapes — client-safe.
 *
 * The response DTOs returned by the workflows endpoints. Kept in their own pure
 * module (no prisma / server imports) so the client canvas + info panel can
 * import them for typing without pulling server code into the bundle. The
 * server-only `enrich.ts` produces these; the client consumes them.
 */

import type { WorkflowDefinition } from '@/types/orchestration';
import type {
  NodeKbPlugPoint,
  NodeMeta,
  NodeVectorPlugPoint,
  WorkflowApplicability,
} from '@/lib/app/questionnaire/workflows/types';

/** A single chat turn of a rendered prompt (role + flattened text). */
export interface PromptMessage {
  role: string;
  content: string;
}

export interface AgentView {
  slug: string;
  name: string;
  /** Whether a seeded `AiAgent` row exists for this slug. */
  seeded: boolean;
  /** Raw stored binding — empty strings when resolved at runtime. */
  provider: string;
  model: string;
  resolvesAtRuntime: boolean;
  /** Best-effort resolved binding; `null` if resolution threw (e.g. no provider configured). */
  resolved: { providerSlug: string; model: string; fallbacks: string[] } | null;
  temperature: number | null;
  maxTokens: number | null;
  reasoningEffort: string | null;
  knowledgeAccessMode: string;
  monthlyBudgetUsd: number | null;
  isActive: boolean;
  grantedDocumentCount: number;
  grantedTagCount: number;
}

export interface CapabilityView {
  slug: string;
  name: string;
  description: string;
}

export interface PromptView {
  catalogSlug: string;
  specimenId: string | null;
  label: string;
  builderModule: string;
  instructionsAreLoadBearing: boolean;
  messages: PromptMessage[];
  /** Deep-link to the Prompt Library, preselecting this agent. */
  libraryHref: string;
}

export interface NodeEnrichment {
  meta: NodeMeta;
  agent: AgentView | null;
  capabilities: CapabilityView[];
  prompt: PromptView | null;
  kb: NodeKbPlugPoint | null;
  vector: NodeVectorPlugPoint | null;
}

export interface WorkflowDetail {
  slug: string;
  title: string;
  description: string;
  sourceModule: string;
  definition: WorkflowDefinition;
  enrichment: Record<string, NodeEnrichment>;
  /** Present only when enriched with a `?versionId=` lens. */
  applicability?: WorkflowApplicability;
}
