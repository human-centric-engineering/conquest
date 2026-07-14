/**
 * Report web-search research — the bounded tool-loop that runs a report's search rounds.
 *
 * Report-kind-agnostic (respondent now, cohort later): given an admin instruction, a round budget,
 * and some context (the answer transcript for a `before` round; the draft report for an `after`
 * round), it drives the seeded **Report Research** agent through up to `rounds` `web_search` calls.
 * Each round the agent sees the accumulated prior results and issues a refined query — so later rounds
 * build on earlier ones. Findings are the *real* deduped search results (grounded URLs — never
 * model-invented); the agent additionally writes a short synthesis `note` guided by the admin's "what
 * to do with the results" instruction.
 *
 * Best-effort by contract: it never throws. A missing agent, an unconfigured search backend (no Brave
 * key / host not allowlisted), or any provider error yields whatever was gathered so far (often
 * nothing) plus the accumulated cost — a report must never fail because research did.
 *
 * Pure orchestration around mockable seams (the agent resolver, the provider, the capability
 * dispatcher). Server-side only.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { getProviderWithFallbacks } from '@/lib/orchestration/llm/provider-manager';
import { calculateCost } from '@/lib/orchestration/llm/cost-tracker';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import type { LlmMessage, LlmResponse, LlmToolDefinition } from '@/lib/orchestration/llm/types';
import type { LlmProvider } from '@/lib/orchestration/llm/provider';
import {
  REPORT_RESEARCHER_AGENT_SLUG,
  WEB_SEARCH_CAPABILITY_SLUG,
  WEB_SEARCH_FUNCTION_DEFINITION,
} from '@/lib/app/questionnaire/constants';
import { MAX_REPORT_RESEARCH_RESULTS } from '@/lib/app/questionnaire/types';
import {
  REPORT_MAX_RESEARCH_FINDINGS,
  REPORT_RESEARCH_NOTE_MAX,
  type RespondentReportResearchFinding,
} from '@/lib/app/questionnaire/report/content';
import type { WebSearchResult } from '@/lib/app/questionnaire/capabilities/web-search';
import { isRecord } from '@/lib/utils';

/** Which side of generation a research round runs on. */
export type ReportResearchPhase = 'before' | 'after';

export interface RunReportResearchOptions {
  phase: ReportResearchPhase;
  /** Admin's free-text prompt: the purpose of the search + what to do with the results. */
  instructions: string;
  /** Max search calls this phase may make (already clamped to {@link MAX_REPORT_RESEARCH_ROUNDS}). */
  rounds: number;
  /** Results requested per round (already clamped to {@link MAX_REPORT_RESEARCH_RESULTS}). */
  maxResults: number;
  /** Grounding context — the answer transcript (`before`) or the draft report text (`after`). */
  context: string;
  /** For log correlation. */
  sessionId: string;
}

export interface ReportResearchResult {
  findings: RespondentReportResearchFinding[];
  note?: string;
  costUsd: number;
}

/** Generation tuning — snappy per-turn ceiling so the whole loop stays well under the worker lease. */
const RESEARCH_MAX_TOKENS = 1500;
/** Per LLM/tool call ceiling. */
const RESEARCH_CALL_TIMEOUT_MS = 15_000;
/**
 * Whole-phase wall-clock budget. The report worker claims a report under a 5-minute lease
 * (`REPORT_LEASE_TTL_MS`); a report can run two research phases AND report generation AND the
 * formatter within that lease, so each phase is time-boxed here to keep the sum comfortably under it
 * (a phase stops starting new rounds past this deadline). Overrunning the lease would let a second
 * worker re-claim the "orphaned" row and double-generate — wasteful, not corrupting, and self-healing,
 * but avoided by construction.
 */
const RESEARCH_PHASE_BUDGET_MS = 45_000;
/** Context fed to the agent is capped so a long transcript / report can't blow the prompt budget. */
const CONTEXT_MAX_CHARS = 6000;

/** Config-level dispatch failures — no point burning further rounds, the backend is unavailable. */
const BACKEND_UNAVAILABLE_CODES = new Set([
  'host_not_allowed',
  'auth_failed',
  'missing_auth_secret',
  'invalid_binding',
]);

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The purpose framing shown to the agent, per phase. */
function phasePurpose(phase: ReportResearchPhase): string {
  return phase === 'before'
    ? 'You are gathering external web context BEFORE a personalised report is written, to inform it.'
    : 'You are researching a report that has already been drafted, to enrich it and verify its claims.';
}

/**
 * Run one phase of report web-search research. Returns the gathered findings, an optional synthesis
 * note, and the accumulated LLM cost. Never throws.
 */
export async function runReportResearch(
  opts: RunReportResearchOptions
): Promise<ReportResearchResult> {
  const empty: ReportResearchResult = { findings: [], costUsd: 0 };
  let costUsd = 0;

  try {
    const agent = await prisma.aiAgent.findUnique({
      where: { slug: REPORT_RESEARCHER_AGENT_SLUG },
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
    if (!agent) {
      logger.warn('report research: researcher agent is not seeded; skipping', {
        sessionId: opts.sessionId,
        phase: opts.phase,
      });
      return empty;
    }

    const { providerSlug, model, fallbacks } = await resolveAgentProviderAndModel(
      agent,
      'reasoning'
    );
    // Honor the agent's resolved fallback providers (matches the workflow `agent_call` executor): a
    // primary-provider outage or open circuit breaker fails over instead of aborting the phase.
    const { provider } = await getProviderWithFallbacks(providerSlug, fallbacks);

    const tools: LlmToolDefinition[] = [
      {
        name: WEB_SEARCH_FUNCTION_DEFINITION.name,
        description: WEB_SEARCH_FUNCTION_DEFINITION.description,
        parameters: WEB_SEARCH_FUNCTION_DEFINITION.parameters,
      },
    ];

    const context = opts.context.slice(0, CONTEXT_MAX_CHARS);
    const messages: LlmMessage[] = [
      { role: 'system', content: buildResearchSystemPrompt(agent.systemInstructions, opts) },
      {
        role: 'user',
        content:
          `${opts.phase === 'before' ? "The respondent's answers" : 'The drafted report'} follow. ` +
          `Begin your research — issue your first web_search now.\n\n${context}`,
      },
    ];

    const collected: WebSearchResult[] = [];
    let searchesUsed = 0;
    let lastAssistantText = '';
    const phaseDeadline = Date.now() + RESEARCH_PHASE_BUDGET_MS;

    // Tool loop: up to `rounds` search calls, each refining on the prior results. Stops early once
    // the per-phase wall-clock budget is spent so the report stays under the worker's lease.
    while (searchesUsed < opts.rounds && Date.now() < phaseDeadline) {
      const response = await provider.chat(messages, {
        model,
        temperature: agent.temperature,
        maxTokens: agent.maxTokens || RESEARCH_MAX_TOKENS,
        tools,
        toolChoice: 'auto',
        timeoutMs: RESEARCH_CALL_TIMEOUT_MS,
        signal: AbortSignal.timeout(RESEARCH_CALL_TIMEOUT_MS),
      });
      costUsd += callCost(model, response);

      if (typeof response.content === 'string' && response.content.trim()) {
        lastAssistantText = response.content.trim();
      }

      const toolCalls = response.toolCalls ?? [];
      if (toolCalls.length === 0) break; // agent decided it has enough — stop searching.

      // Echo the assistant's tool-call turn back into the transcript before appending results.
      messages.push({ role: 'assistant', content: response.content, toolCalls });

      let backendDown = false;
      for (const call of toolCalls) {
        if (searchesUsed >= opts.rounds) {
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            content: JSON.stringify({ note: 'Search round budget reached; no more searches.' }),
          });
          continue;
        }
        if (call.name !== WEB_SEARCH_CAPABILITY_SLUG) {
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            content: JSON.stringify({ error: 'Only the web_search tool is available.' }),
          });
          continue;
        }
        searchesUsed += 1;
        const dispatchResult = await dispatchSearch(agent.id, call.arguments, opts.maxResults);
        if (dispatchResult.success && dispatchResult.results) {
          collected.push(...dispatchResult.results);
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            content: JSON.stringify({ results: dispatchResult.results }),
          });
        } else {
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            content: JSON.stringify({ error: dispatchResult.error ?? 'Search failed.' }),
          });
          if (dispatchResult.code && BACKEND_UNAVAILABLE_CODES.has(dispatchResult.code)) {
            backendDown = true;
          }
        }
      }
      if (backendDown) {
        logger.warn('report research: search backend unavailable; ending rounds early', {
          sessionId: opts.sessionId,
          phase: opts.phase,
        });
        break;
      }
    }

    const findings = dedupeFindings(collected);

    // Synthesis note: if the agent already wrote a closing message, use it; otherwise ask for one
    // (only worth a call when there's something to synthesise).
    let note = lastAssistantText;
    if (!note && findings.length > 0) {
      const synth = await synthesiseNote(provider, model, agent, messages);
      costUsd += synth.costUsd;
      note = synth.note;
    }
    note = note.slice(0, REPORT_RESEARCH_NOTE_MAX).trim();

    return { findings, ...(note ? { note } : {}), costUsd };
  } catch (err) {
    logger.warn('report research: failed; continuing without research', {
      sessionId: opts.sessionId,
      phase: opts.phase,
      error: errorMessage(err),
    });
    return { findings: [], costUsd };
  }
}

/** Assemble the researcher agent's system prompt from its persona + the admin's phase instruction. */
function buildResearchSystemPrompt(
  agentInstructions: string,
  opts: RunReportResearchOptions
): string {
  const parts: string[] = [];
  if (agentInstructions.trim()) parts.push(agentInstructions.trim());
  parts.push(phasePurpose(opts.phase));
  if (opts.instructions.trim()) {
    parts.push(`Your task from the report author:\n${opts.instructions.trim()}`);
  }
  parts.push(
    `Use the web_search tool to gather relevant, credible information. You may search up to ${opts.rounds} ` +
      `time(s). Issue ONE focused query per call and refine each subsequent query based on what the ` +
      `previous results returned — do not repeat a query. When you have gathered enough, STOP calling ` +
      `the tool and write a brief synthesis (2–4 sentences) of what you found and why it matters, ` +
      `following the task above. Do not invent sources — only rely on results the tool returned.`
  );
  return parts.join('\n\n');
}

/** Dispatch one web_search call, clamping `count` to the configured per-round result cap. */
async function dispatchSearch(
  agentId: string,
  rawArgs: Record<string, unknown>,
  maxResults: number
): Promise<{ success: boolean; results?: WebSearchResult[]; error?: string; code?: string }> {
  const requested = typeof rawArgs.count === 'number' ? rawArgs.count : maxResults;
  const count = Math.min(
    Math.max(1, Math.round(requested)),
    maxResults,
    MAX_REPORT_RESEARCH_RESULTS
  );
  // Forward only the two keys the web_search schema accepts. The dispatched schema is `.strict()`,
  // so passing through any extra property the model hallucinated (e.g. `lang`, `freshness`) would
  // fail the whole call and waste a round; the query is left as-is for the capability to validate.
  const args = { query: rawArgs.query, count };

  const result = await capabilityDispatcher.dispatch(WEB_SEARCH_CAPABILITY_SLUG, args, {
    userId: null,
    agentId,
  });

  if (result.success && isRecord(result.data) && Array.isArray(result.data.results)) {
    return { success: true, results: result.data.results as WebSearchResult[] };
  }
  return {
    success: false,
    error: result.error?.message ?? 'Search failed.',
    ...(result.error?.code ? { code: result.error.code } : {}),
  };
}

/** One final, tool-free turn to get a synthesis note when the agent didn't already write one. */
async function synthesiseNote(
  provider: LlmProvider,
  model: string,
  agent: { temperature: number; maxTokens: number },
  messages: LlmMessage[]
): Promise<{ note: string; costUsd: number }> {
  try {
    const response = await provider.chat(
      [
        ...messages,
        {
          role: 'user',
          content:
            'Now write your brief synthesis (2–4 sentences) of the findings above, following your task. ' +
            'Do not call any tool; respond with plain text only.',
        },
      ],
      {
        model,
        temperature: agent.temperature,
        maxTokens: agent.maxTokens || RESEARCH_MAX_TOKENS,
        toolChoice: 'none',
        timeoutMs: RESEARCH_CALL_TIMEOUT_MS,
        signal: AbortSignal.timeout(RESEARCH_CALL_TIMEOUT_MS),
      }
    );
    const note = typeof response.content === 'string' ? response.content.trim() : '';
    return { note, costUsd: callCost(model, response) };
  } catch {
    return { note: '', costUsd: 0 };
  }
}

/** Dedupe collected results by URL (first wins), then narrow to report findings, capped. */
function dedupeFindings(results: WebSearchResult[]): RespondentReportResearchFinding[] {
  const seen = new Set<string>();
  const out: RespondentReportResearchFinding[] = [];
  for (const r of results) {
    if (out.length >= REPORT_MAX_RESEARCH_FINDINGS) break;
    const url = r.url.trim();
    const title = r.title.trim();
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    out.push({ title, url, snippet: r.snippet.trim(), ...(r.source ? { source: r.source } : {}) });
  }
  return out;
}

function callCost(model: string, response: LlmResponse): number {
  return calculateCost(model, response.usage.inputTokens, response.usage.outputTokens).totalCostUsd;
}
