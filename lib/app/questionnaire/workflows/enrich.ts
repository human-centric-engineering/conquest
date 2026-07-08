/**
 * Behind-the-Scenes enrichment — server-only.
 *
 * Turns a hand-authored diagram's per-node `_meta` (agent/prompt/tool/KB slugs)
 * into live detail for the info panel: the agent's DB binding + best-effort
 * resolved provider/model, the exact prompt messages from the prompt catalog,
 * and each capability's name/description. Mirrors the prompts route philosophy —
 * never throws on missing data (an unseeded agent resolves to `agent: null`).
 *
 * Server-only: imports prisma, the prompt catalog (which pulls the real prompt
 * builders), and the capability dispatcher. Fetched over the API; never bundled
 * into the client canvas.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import { registerBuiltInCapabilities } from '@/lib/orchestration/capabilities/registry';
import { buildPromptCatalog } from '@/app/api/v1/app/questionnaires/_lib/prompt-catalog';

import { getWorkflowDiagram } from '@/lib/app/questionnaire/workflows/registry';
import { getNodeMeta } from '@/lib/app/questionnaire/workflows/types';
import type { WorkflowApplicability } from '@/lib/app/questionnaire/workflows/types';
import type {
  AgentView,
  CapabilityView,
  NodeEnrichment,
  PromptView,
  WorkflowDetail,
} from '@/lib/app/questionnaire/workflows/views';

// Re-export the view shapes so route/test callers can import them from the
// producer; the canonical definitions live in the client-safe `views.ts`.
export type { AgentView, CapabilityView, NodeEnrichment, PromptView, WorkflowDetail };

// ---------------------------------------------------------------------------

/** The admin Prompt Library page; nodes deep-link here preselecting their agent. */
const PROMPT_LIBRARY_PATH = '/admin/questionnaires/prompts';

const AGENT_SELECT = {
  slug: true,
  name: true,
  provider: true,
  model: true,
  fallbackProviders: true,
  temperature: true,
  maxTokens: true,
  reasoningEffort: true,
  knowledgeAccessMode: true,
  monthlyBudgetUsd: true,
  isActive: true,
  _count: { select: { grantedDocuments: true, grantedTags: true } },
} as const;

/** Resolve a capability slug to its human name/description via the dispatcher. */
function capabilityView(slug: string): CapabilityView {
  const handler = capabilityDispatcher.getHandler(slug);
  return {
    slug,
    name: handler?.functionDefinition.name ?? slug,
    description: handler?.functionDefinition.description ?? '',
  };
}

/**
 * Enrich one workflow diagram with live agent/prompt/tool/KB detail. Returns
 * `null` if the slug is unknown. `applicability`, when provided, is attached
 * verbatim (computed by the caller from the version lens).
 */
export async function enrichWorkflow(
  slug: string,
  applicability?: WorkflowApplicability
): Promise<WorkflowDetail | null> {
  const diagram = getWorkflowDiagram(slug);
  if (!diagram) return null;

  // Make sure capability handlers are registered so slugs resolve to names.
  registerBuiltInCapabilities();

  const steps = diagram.definition.steps;
  const metas = steps.map((step) => ({ id: step.id, meta: getNodeMeta(step.config) }));

  // 1. Batch-load every referenced agent.
  const agentSlugs = Array.from(
    new Set(metas.map((m) => m.meta.agentSlug).filter((s): s is string => Boolean(s)))
  );
  const rows = agentSlugs.length
    ? await prisma.aiAgent.findMany({ where: { slug: { in: agentSlugs } }, select: AGENT_SELECT })
    : [];
  const rowBySlug = new Map(rows.map((r) => [r.slug, r]));

  // 2. Resolve each agent's provider/model, best-effort (never fatal).
  const agentViews = new Map<string, AgentView>();
  await Promise.all(
    agentSlugs.map(async (agentSlug) => {
      const row = rowBySlug.get(agentSlug);
      if (!row) return; // unseeded → agent stays null in the view
      const provider = row.provider ?? '';
      const model = row.model ?? '';
      let resolved: AgentView['resolved'] = null;
      try {
        const binding = await resolveAgentProviderAndModel({
          provider: row.provider,
          model: row.model,
          fallbackProviders: row.fallbackProviders,
        });
        resolved = {
          providerSlug: binding.providerSlug,
          model: binding.model,
          fallbacks: binding.fallbacks,
        };
      } catch (err) {
        logger.warn('workflow enrich: agent binding resolution failed', {
          agentSlug,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      agentViews.set(agentSlug, {
        slug: row.slug,
        name: row.name,
        seeded: true,
        provider,
        model,
        resolvesAtRuntime: provider.trim() === '' && model.trim() === '',
        resolved,
        temperature: row.temperature ?? null,
        maxTokens: row.maxTokens ?? null,
        reasoningEffort: row.reasoningEffort ?? null,
        knowledgeAccessMode: row.knowledgeAccessMode,
        monthlyBudgetUsd: row.monthlyBudgetUsd ?? null,
        isActive: row.isActive,
        grantedDocumentCount: row._count.grantedDocuments,
        grantedTagCount: row._count.grantedTags,
      });
    })
  );

  // 3. Index the prompt catalog by slug for prompt-message lookup.
  const catalog = new Map(buildPromptCatalog().map((entry) => [entry.slug, entry]));

  // 4. Assemble per-node enrichment.
  const enrichment: Record<string, NodeEnrichment> = {};
  for (const { id, meta } of metas) {
    const agent = meta.agentSlug ? (agentViews.get(meta.agentSlug) ?? null) : null;

    let prompt: PromptView | null = null;
    if (meta.promptCatalogSlug) {
      const entry = catalog.get(meta.promptCatalogSlug);
      if (entry) {
        const specimen =
          (meta.promptSpecimenId && entry.specimens.find((s) => s.id === meta.promptSpecimenId)) ||
          entry.specimens[0];
        if (specimen) {
          prompt = {
            catalogSlug: entry.slug,
            specimenId: specimen.id,
            label: specimen.label,
            builderModule: entry.builderModule,
            instructionsAreLoadBearing: entry.instructionsAreLoadBearing,
            messages: specimen.messages,
            libraryHref: `${PROMPT_LIBRARY_PATH}?agent=${encodeURIComponent(entry.slug)}`,
          };
        }
      }
    }

    enrichment[id] = {
      meta,
      agent,
      capabilities: (meta.capabilitySlugs ?? []).map(capabilityView),
      prompt,
      kb: meta.kb ?? null,
      vector: meta.vector ?? null,
    };
  }

  return {
    slug: diagram.slug,
    title: diagram.title,
    description: diagram.description,
    sourceModule: diagram.sourceModule,
    definition: diagram.definition,
    enrichment,
    ...(applicability ? { applicability } : {}),
  };
}
