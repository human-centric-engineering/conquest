/**
 * Cohort Report — per-section AI-assist (report kind `cohort`, F14.5).
 *
 * `refineCohortReportSection` takes one section + a free-text instruction ("make it shorter", "add
 * the evidence", "warmer tone") and returns the rewritten heading + body. Mirrors the generation
 * pattern (direct cohort-report agent + structured completion). The body is returned as simple HTML
 * so it drops straight into the stored-HTML section model + the Tiptap editor. Server-side.
 */

import { prisma } from '@/lib/db/client';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { tryParseJson } from '@/lib/orchestration/evaluations/parse-structured';
import { runStructuredCompletion } from '@/lib/orchestration/llm/structured-completion';
import { COHORT_REPORT_AGENT_SLUG } from '@/lib/app/questionnaire/constants';
import { logAppLlmCost } from '@/lib/app/questionnaire/llm/log-app-cost';
import { isRecord } from '@/lib/utils';

export interface RefinedSection {
  heading: string;
  /** HTML body (simple tags only). */
  body: string;
}

const REFINE_MAX_TOKENS = 4096;
const REFINE_TIMEOUT_MS = 60_000;

/** Refine one report section under an instruction; returns the rewritten heading + HTML body. */
export async function refineCohortReportSection(params: {
  heading: string;
  /** The current body (HTML or markdown — passed verbatim as context). */
  body: string;
  instruction: string;
}): Promise<RefinedSection> {
  const agent = await prisma.aiAgent.findUnique({
    where: { slug: COHORT_REPORT_AGENT_SLUG },
    select: {
      id: true,
      provider: true,
      model: true,
      fallbackProviders: true,
      systemInstructions: true,
      temperature: true,
      maxTokens: true,
    },
  });
  if (!agent) throw new Error('Cohort report agent is not seeded');

  const { providerSlug, model } = await resolveAgentProviderAndModel(agent, 'reasoning');
  const provider = await getProvider(providerSlug);

  const system = [
    agent.systemInstructions?.trim() || 'You are the Cohort Report analyst.',
    "You revise ONE section of a cohort report under the editor's instruction. Keep it grounded in " +
      'the facts already in the section — never invent new figures. Return the body as simple HTML ' +
      'using only <p>, <ul>, <ol>, <li>, <strong>, <em>, <h4> tags (no styles, scripts, or other tags).',
    'Respond with ONLY a JSON object: {"heading": string, "body": string}.',
  ].join('\n\n');

  const result = await runStructuredCompletion<RefinedSection>({
    provider,
    model,
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: `Section heading: ${params.heading}\n\nSection body:\n${params.body}\n\nInstruction: ${params.instruction}\n\nReturn the revised section now.`,
      },
    ],
    temperature: agent.temperature,
    maxTokens: agent.maxTokens || REFINE_MAX_TOKENS,
    timeoutMs: REFINE_TIMEOUT_MS,
    parse: (raw) =>
      tryParseJson(raw, (obj) => {
        if (!isRecord(obj) || typeof obj.body !== 'string') return null;
        const heading =
          typeof obj.heading === 'string' ? obj.heading.trim().slice(0, 200) : params.heading;
        return { heading, body: obj.body.slice(0, 8000) };
      }),
    retryUserMessage:
      'Respond with ONLY {"heading": string, "body": string} — no prose, no code fence.',
    onFinalFailure: () => new Error('Section refine response was not valid JSON after retry'),
  });

  // `versionId` is null — a refine turn is scoped to one section's text, with no version in scope.
  logAppLlmCost({
    agentId: agent.id,
    provider: providerSlug,
    model,
    tokenUsage: result.tokenUsage,
    capability: 'app_cohort_report_refine',
    versionId: null,
  });

  return result.value;
}
