/**
 * Respondent Report — config-crafting assistant (Phase 4b).
 *
 * Powers the Generation-tab chat: a conversational assistant that interviews the admin about their
 * questionnaire and proposes concrete report generation config (style/voice instructions, desired
 * structure, and background context). One turn = the prior messages + the current config in →
 * `{ reply, suggestions }` out, where `suggestions` carries the FULL proposed text for any field the
 * assistant wants to change (the admin applies it wholesale). Mirrors the generation pipeline: resolve
 * the seeded assistant agent, run the shared structured-completion runner. Server-side only.
 */

import { prisma } from '@/lib/db/client';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import {
  runStructuredCompletion,
  tryParseJson,
} from '@/lib/orchestration/evaluations/parse-structured';
import type { LlmMessage } from '@/lib/orchestration/llm/types';
import { RESPONDENT_REPORT_ASSISTANT_AGENT_SLUG } from '@/lib/app/questionnaire/constants';
import {
  RESPONDENT_REPORT_BACKGROUND_MAX_LENGTH,
  RESPONDENT_REPORT_INSTRUCTIONS_MAX_LENGTH,
} from '@/lib/app/questionnaire/types';
import { isRecord } from '@/lib/utils';

const REPLY_MAX_LENGTH = 4000;
const CRAFT_MAX_TOKENS = 2048;
const CRAFT_TIMEOUT_MS = 30_000;

/** One chat message in the assistant conversation. */
export interface CraftMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** The current generation config the assistant builds on (the editor's live values). */
export interface CraftCurrentConfig {
  instructions: string;
  structure: string;
  backgroundContext: string;
}

/** Field values the assistant proposes — only those it wants to change are present. */
export interface ReportConfigSuggestions {
  instructions?: string;
  structure?: string;
  backgroundContext?: string;
}

/** One assistant turn: a conversational reply plus any proposed config changes. */
export interface CraftReportConfigResult {
  reply: string;
  suggestions: ReportConfigSuggestions;
}

function trimTo(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, max) : undefined;
}

/** Narrow the assistant's parsed JSON onto a valid result, or null when there's no usable reply. */
export function validateCraftResult(parsed: unknown): CraftReportConfigResult | null {
  if (!isRecord(parsed)) return null;
  const reply = trimTo(parsed.reply, REPLY_MAX_LENGTH);
  if (!reply) return null;

  const raw = isRecord(parsed.suggestions) ? parsed.suggestions : {};
  const suggestions: ReportConfigSuggestions = {};
  const instructions = trimTo(raw.instructions, RESPONDENT_REPORT_INSTRUCTIONS_MAX_LENGTH);
  const structure = trimTo(raw.structure, RESPONDENT_REPORT_INSTRUCTIONS_MAX_LENGTH);
  const backgroundContext = trimTo(raw.backgroundContext, RESPONDENT_REPORT_BACKGROUND_MAX_LENGTH);
  if (instructions !== undefined) suggestions.instructions = instructions;
  if (structure !== undefined) suggestions.structure = structure;
  if (backgroundContext !== undefined) suggestions.backgroundContext = backgroundContext;

  return { reply, suggestions };
}

function buildMessages(opts: {
  agentInstructions: string;
  current: CraftCurrentConfig;
  messages: CraftMessage[];
}): LlmMessage[] {
  const { agentInstructions, current, messages } = opts;

  const system: string[] = [];
  if (agentInstructions.trim()) system.push(agentInstructions.trim());
  system.push(
    'You help an admin craft the configuration for a Respondent Report — the personalised report a ' +
      'respondent receives after completing a questionnaire. Interview them: ask about their goals, ' +
      'the audience, what a genuinely useful insight looks like here, and any domain background the ' +
      'report writer should know. Keep replies short and focused — one or two questions at a time.'
  );
  system.push(
    'The three config fields you can propose are:\n' +
      '- instructions: style & voice guidance for the report.\n' +
      '- structure: the desired sections, in order.\n' +
      '- backgroundContext: domain context + how to interpret answers (e.g. what a low score implies).'
  );
  system.push(
    'When you have enough to propose concrete config, put the FULL proposed text for a field in ' +
      '`suggestions.<field>` (it replaces that field wholesale; omit fields you are not changing). ' +
      'Build on the current values below rather than starting over.'
  );
  system.push(
    'Current config:\n' +
      `instructions: ${current.instructions || '(empty)'}\n` +
      `structure: ${current.structure || '(empty)'}\n` +
      `backgroundContext: ${current.backgroundContext || '(empty)'}`
  );
  system.push(
    'Respond with ONLY a JSON object of this exact shape (no prose, no code fence):\n' +
      '{"reply": string, "suggestions": {"instructions"?: string, "structure"?: string, "backgroundContext"?: string}}'
  );

  return [
    { role: 'system', content: system.join('\n\n') },
    ...messages.map((m): LlmMessage => ({ role: m.role, content: m.content })),
  ];
}

/**
 * Run one config-crafting turn. Throws on unrecoverable problems (no agent, no provider, malformed
 * model output after retry) — the route maps a throw to a 5xx.
 */
export async function craftReportConfig(opts: {
  messages: CraftMessage[];
  current: CraftCurrentConfig;
}): Promise<CraftReportConfigResult & { costUsd: number }> {
  const agent = await prisma.aiAgent.findUnique({
    where: { slug: RESPONDENT_REPORT_ASSISTANT_AGENT_SLUG },
    select: {
      provider: true,
      model: true,
      fallbackProviders: true,
      systemInstructions: true,
      temperature: true,
      maxTokens: true,
    },
  });
  if (!agent) throw new Error('Respondent report config assistant is not seeded');

  const { providerSlug, model } = await resolveAgentProviderAndModel(agent, 'reasoning');
  const provider = await getProvider(providerSlug);

  const messages = buildMessages({
    agentInstructions: agent.systemInstructions,
    current: opts.current,
    messages: opts.messages,
  });

  const result = await runStructuredCompletion<CraftReportConfigResult>({
    provider,
    model,
    messages,
    temperature: agent.temperature,
    maxTokens: agent.maxTokens || CRAFT_MAX_TOKENS,
    timeoutMs: CRAFT_TIMEOUT_MS,
    parse: (raw) => tryParseJson(raw, validateCraftResult),
    retryUserMessage:
      'Respond with ONLY the JSON object {"reply": string, "suggestions": {…}} — no prose, no code fence.',
    onFinalFailure: () => new Error('Config assistant response was not valid JSON after retry'),
  });

  return { ...result.value, costUsd: result.costUsd };
}
