/**
 * Respondent Report generation (the AI modes: `raw_plus_insights` and `narrative`).
 *
 * Assembles the per-respondent report content from: the captured answers (as a Q&A transcript),
 * the admin's generation config (instructions / structure / flat background context), and — when
 * enabled and available — snippets retrieved from the attributed client's knowledge base (scoped via
 * the client tag, so no cross-client bleed). Runs the seeded report agent through the shared
 * structured-completion runner (parse → retry-once → cost sum) and returns the validated content plus
 * the USD cost.
 *
 * Pure orchestration around mockable seams (prisma, the agent resolver, the provider, KB search) —
 * the worker calls this once per queued report. Server-side only.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import {
  runStructuredCompletion,
  tryParseJson,
} from '@/lib/orchestration/evaluations/parse-structured';
import { searchKnowledge } from '@/lib/orchestration/knowledge/search';
import type { LlmMessage } from '@/lib/orchestration/llm/types';
import { RESPONDENT_REPORT_AGENT_SLUG } from '@/lib/app/questionnaire/constants';
import type { RespondentReportSettings } from '@/lib/app/questionnaire/types';
import { loadSessionExport } from '@/app/api/v1/app/questionnaire-sessions/_lib/session-export';
import { buildAnswerPanelView } from '@/lib/app/questionnaire/panel/answer-panel';
import { narrowRespondentReportSettings } from '@/lib/app/questionnaire/report/settings';
import { resolveClientKnowledgeDocumentIds } from '@/lib/app/questionnaire/report/client-knowledge';
import {
  buildAnswerTranscript,
  validateRespondentReportContent,
  type RespondentReportContent,
} from '@/lib/app/questionnaire/report/content';

/** Result of one generation run. */
export interface GeneratedReport {
  content: RespondentReportContent;
  costUsd: number;
}

/** Generation tuning — generous token budget for a multi-section narrative; 60s LLM ceiling. */
const REPORT_MAX_TOKENS = 4096;
const REPORT_TIMEOUT_MS = 60_000;
/** Top-K knowledge snippets to ground insights in (kept small to bound prompt size). */
const KB_SNIPPET_LIMIT = 6;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** One-line audience summary from the structured shape (description preferred, then role). */
function summariseAudience(
  audience: { description?: string; role?: string } | null
): string | null {
  if (!audience) return null;
  return audience.description?.trim() || audience.role?.trim() || null;
}

/** Assemble the report agent's system + user messages. */
function buildReportMessages(opts: {
  agentInstructions: string;
  settings: RespondentReportSettings;
  transcript: string;
  knowledge: string;
}): LlmMessage[] {
  const { agentInstructions, settings, transcript, knowledge } = opts;
  const gen = settings.generation;
  const narrative = settings.mode === 'narrative';

  const system: string[] = [];
  if (agentInstructions.trim()) system.push(agentInstructions.trim());
  system.push(
    narrative
      ? 'You write a single woven report for the respondent who just completed this questionnaire. ' +
          'Address the respondent directly (second person). Weave their actual answers into flowing, ' +
          'analysed prose — integrate the answers into the narrative rather than listing them ' +
          'separately, and develop analysis, insights, and advice throughout. Ground every statement ' +
          'in their actual answers — never invent facts.'
      : 'You write a personalised report for the respondent who just completed this questionnaire. ' +
          'Address the respondent directly (second person). Ground every statement in their actual ' +
          'answers — never invent facts.'
  );
  if (gen.instructions.trim()) system.push(`Style and voice guidance:\n${gen.instructions.trim()}`);
  if (gen.structure.trim()) system.push(`Desired structure:\n${gen.structure.trim()}`);
  if (gen.backgroundContext.trim())
    system.push(`Background context about this questionnaire:\n${gen.backgroundContext.trim()}`);
  if (knowledge.trim())
    system.push(
      `Reference material (use it to inform and substantiate the insights; cite naturally, do not quote verbatim):\n${knowledge.trim()}`
    );
  system.push(
    narrative
      ? 'Make it ACTIONABLE: the `actions` array must contain concrete next steps the respondent can ' +
          'take. Use `summary` as an opening framing, and each `sections[]` entry as a woven chapter ' +
          '(heading + flowing body that integrates their answers with your analysis).'
      : 'Make the insights ACTIONABLE: the `actions` array must contain concrete next steps the ' +
          'respondent can take.'
  );
  system.push(
    'Respond with ONLY a JSON object of this exact shape (no prose, no code fence):\n' +
      '{"summary": string, "sections": [{"heading": string, "body": string}], "actions": [string]}'
  );

  return [
    { role: 'system', content: system.join('\n\n') },
    {
      role: 'user',
      content: `Here are the respondent's answers:\n\n${transcript}\n\nWrite the report now.`,
    },
  ];
}

/**
 * Generate the insights content for a session's respondent report. Throws on unrecoverable problems
 * (missing session, no provider, malformed model output after retry) — the worker maps a throw to a
 * `failed` report row.
 */
export async function generateRespondentReport(sessionId: string): Promise<GeneratedReport> {
  // 1. Config + client attribution for this session's version.
  const meta = await prisma.appQuestionnaireSession.findUnique({
    where: { id: sessionId },
    select: {
      version: {
        select: {
          config: { select: { respondentReport: true } },
          questionnaire: { select: { demoClientId: true } },
        },
      },
    },
  });
  if (!meta?.version) throw new Error(`Session ${sessionId} not found for report generation`);
  const settings = narrowRespondentReportSettings(meta.version.config?.respondentReport);

  // 2. Captured answers → Q&A transcript.
  const loaded = await loadSessionExport(sessionId);
  if (!loaded) throw new Error(`Session export not found for ${sessionId}`);
  const panel = buildAnswerPanelView({
    status: loaded.status,
    scope: 'full_progress',
    sections: loaded.sections,
    answers: loaded.answers,
  });
  const transcript = buildAnswerTranscript({
    questionnaireTitle: loaded.questionnaireTitle,
    goal: loaded.goal,
    audienceSummary: summariseAudience(loaded.audience),
    sections: panel.sections,
  });

  // 3. Optional client-KB grounding — strictly scoped to the client's documents.
  let knowledge = '';
  const demoClientId = meta.version.questionnaire?.demoClientId ?? null;
  if (settings.generation.useClientKnowledge && demoClientId) {
    const documentIds = await resolveClientKnowledgeDocumentIds(demoClientId);
    if (documentIds.length > 0) {
      try {
        const query = [loaded.goal, transcript].filter(Boolean).join('\n').slice(0, 2000);
        const results = await searchKnowledge(query, { documentIds }, KB_SNIPPET_LIMIT);
        knowledge = results.map((r, i) => `[${i + 1}] ${r.chunk.content}`).join('\n\n');
      } catch (err) {
        // Grounding is best-effort — a search failure must not fail the whole report.
        logger.warn('respondent report: KB search failed; continuing ungrounded', {
          sessionId,
          error: errorMessage(err),
        });
      }
    }
  }

  // 4. Resolve the report agent + provider.
  const agent = await prisma.aiAgent.findUnique({
    where: { slug: RESPONDENT_REPORT_AGENT_SLUG },
    select: {
      provider: true,
      model: true,
      fallbackProviders: true,
      systemInstructions: true,
      temperature: true,
      maxTokens: true,
    },
  });
  if (!agent) throw new Error('Respondent report agent is not seeded');

  const { providerSlug, model } = await resolveAgentProviderAndModel(agent, 'reasoning');
  const provider = await getProvider(providerSlug);

  // 5. Structured completion (parse → retry-once-at-temp-0 → cost sum).
  const messages = buildReportMessages({
    agentInstructions: agent.systemInstructions,
    settings,
    transcript,
    knowledge,
  });
  const result = await runStructuredCompletion<RespondentReportContent>({
    provider,
    model,
    messages,
    temperature: agent.temperature,
    maxTokens: agent.maxTokens || REPORT_MAX_TOKENS,
    timeoutMs: REPORT_TIMEOUT_MS,
    parse: (raw) => tryParseJson(raw, validateRespondentReportContent),
    retryUserMessage:
      'Respond with ONLY the JSON object {"summary","sections":[{"heading","body"}],"actions":[]} — no prose, no code fence.',
    onFinalFailure: () => new Error('Respondent report response was not valid JSON after retry'),
  });

  return { content: result.value, costUsd: result.costUsd };
}
