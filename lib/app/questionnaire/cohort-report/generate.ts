/**
 * Cohort Report generation (report kind `cohort`, F14.3).
 *
 * Assembles the cohort report body in one structured completion: the agent reads the k-anonymity-safe
 * dataset digest + chart catalog (so every chart it proposes resolves), the admin's generation config
 * (length / detail / formality / instructions / structure template / background), and — when enabled
 * — the round briefing, cohort background, and client knowledge-base snippets. It returns woven
 * narrative sections, a proposed chart catalog, recommendations and actions, plus the USD cost.
 *
 * Follows the Respondent Report's direct-agent pattern (`report/generate.ts`): resolve the seeded
 * agent → build messages → `runStructuredCompletion` (parse → retry-once → cost sum) → validate.
 * Pure orchestration around mockable seams (prisma, agent resolver, provider, KB search). Server-side.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { tryParseJson } from '@/lib/orchestration/evaluations/parse-structured';
import { runStructuredCompletion } from '@/lib/orchestration/llm/structured-completion';
import { searchKnowledge } from '@/lib/orchestration/knowledge/search';
import type { LlmMessage } from '@/lib/orchestration/llm/types';
import { COHORT_REPORT_AGENT_SLUG } from '@/lib/app/questionnaire/constants';
import { logAppLlmCost } from '@/lib/app/questionnaire/llm/log-app-cost';
import type { CohortReportSettings } from '@/lib/app/questionnaire/types';
import { narrowCohortReportSettings } from '@/lib/app/questionnaire/cohort-report/settings';
import { markdownToHtml } from '@/lib/app/questionnaire/cohort-report/richtext';
import { buildDataSlotThemeMaterial } from '@/lib/app/questionnaire/cohort-report/data-slot-material';
import { resolveClientKnowledgeDocumentIds } from '@/lib/app/questionnaire/report/client-knowledge';
import { buildCohortDataset } from '@/lib/app/questionnaire/cohort-report/dataset';
import {
  buildChartCatalogText,
  buildCohortDatasetDigest,
  validateCohortReportContent,
  isUsableCohortReportContent,
  type CohortReportContent,
} from '@/lib/app/questionnaire/cohort-report/content';
import type { CohortDataset } from '@/lib/app/questionnaire/cohort-report/types';
import {
  scopeRoundId,
  scopeSessionWhere,
  type ReportScope,
} from '@/lib/app/questionnaire/cohort-report/scope';
import type { ReportGenProgressEvent } from '@/lib/app/questionnaire/cohort-report/report-events';

/** Result of one cohort-report generation run. */
export interface GeneratedCohortReport {
  content: CohortReportContent;
  costUsd: number;
}

const REPORT_MAX_TOKENS = 8192;
const REPORT_TIMEOUT_MS = 90_000;
const KB_SNIPPET_LIMIT = 8;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Human guidance strings the config enums map to in the prompt. */
const LENGTH_GUIDANCE: Record<CohortReportSettings['generation']['length'], string> = {
  brief: 'Keep it concise — a few short sections.',
  standard: 'A standard-length report — cover the main findings without padding.',
  detailed: 'A thorough report — explore the findings and their nuances in depth.',
};
const DETAIL_GUIDANCE: Record<CohortReportSettings['generation']['detailLevel'], string> = {
  overview: 'Stay at the headline level; summarise rather than dissect.',
  standard: 'Balance headlines with the supporting evidence behind them.',
  deep: 'Dig into the evidence, sub-patterns, and notable segment differences.',
};

/** Assemble the cohort-report agent's system + user messages. */
function buildMessages(opts: {
  agentInstructions: string;
  settings: CohortReportSettings;
  digest: string;
  catalog: string;
  roundContext: string;
  cohortContext: string;
  knowledge: string;
  dataSlotMaterial: string;
}): LlmMessage[] {
  const {
    agentInstructions,
    settings,
    digest,
    catalog,
    roundContext,
    cohortContext,
    knowledge,
    dataSlotMaterial,
  } = opts;
  const gen = settings.generation;
  const business = gen.formality === 'business';

  const system: string[] = [];
  if (agentInstructions.trim()) system.push(agentInstructions.trim());
  system.push(
    'You write a cross-respondent COHORT report analysing how a whole group answered a ' +
      'questionnaire. Do a thematic analysis of the aggregated results: surface the most significant ' +
      'patterns, notable differences between demographic segments, and anything surprising — judged ' +
      'against the report goals. Weave the data and your analysis into flowing prose. Ground every ' +
      'claim in the supplied results — never invent numbers, and never reveal any figure marked ' +
      'hidden/too-few (respect respondent privacy).'
  );
  system.push(
    business
      ? 'This is a business report: open with a concise executive summary, then structured sections.'
      : 'This is an informal report: a looser, more conversational structure is fine.'
  );
  system.push(LENGTH_GUIDANCE[gen.length], DETAIL_GUIDANCE[gen.detailLevel]);
  if (gen.instructions.trim()) system.push(`Style and voice guidance:\n${gen.instructions.trim()}`);
  if (gen.structure.trim())
    system.push(`Follow this structure where it fits the data:\n${gen.structure.trim()}`);
  if (gen.backgroundContext.trim())
    system.push(`Background about this questionnaire/cohort:\n${gen.backgroundContext.trim()}`);
  if (cohortContext.trim()) system.push(`About this cohort:\n${cohortContext.trim()}`);
  if (roundContext.trim()) system.push(`Round context:\n${roundContext.trim()}`);
  if (knowledge.trim())
    system.push(
      `Reference material (use it to substantiate the analysis; cite naturally, do not quote verbatim):\n${knowledge.trim()}`
    );

  if (dataSlotMaterial.trim())
    system.push(
      'RESPONDENT POSITIONS BY DATA SLOT — this is the substance of the responses and the primary ' +
        'material for your thematic analysis. Each heading is a data slot; the bullets are individual ' +
        'respondents’ captured positions. SYNTHESISE anonymised themes, tensions, and patterns ' +
        'across them — identify what is common, what diverges, and what is notable per the report ' +
        'goals. NEVER quote a bullet verbatim or attribute a position to an individual; report only ' +
        `aggregated themes.\n\n${dataSlotMaterial.trim()}`
    );

  system.push(
    'Propose charts that illustrate your most significant findings, choosing from these kinds and ' +
      'ONLY the ids below:\n' +
      '- question_distribution (needs questionId)\n' +
      '- question_mean_by_segment (needs questionId + dimensionKey; likert/numeric only)\n' +
      '- response_rate_by_segment (needs questionId + dimensionKey)\n' +
      '- completion_by_segment (needs dimensionKey)\n' +
      '- segment_sizes (needs dimensionKey)\n' +
      '- dataslot_response_overall (fill rate per data slot; no id needed)\n' +
      '- dataslot_response_by_segment (needs dataSlotKey + dimensionKey)\n\n' +
      catalog
  );
  system.push(
    'End with concrete `recommendations` (what the organisation should consider) and `actions` ' +
      "(specific next steps). Reference a chart inside a section by putting its `id` in the section's " +
      '`chartIds`.'
  );
  system.push(
    'Respond with ONLY a JSON object of this exact shape (no prose, no code fence):\n' +
      '{"summary": string, "sections": [{"heading": string, "body": string, "chartIds": [string]}], ' +
      '"charts": [{"id": string, "title": string, "kind": string, "questionId"?: string, "dataSlotKey"?: string, "dimensionKey"?: string}], ' +
      '"recommendations": [string], "actions": [string]}'
  );

  return [
    { role: 'system', content: system.join('\n\n') },
    {
      role: 'user',
      content: `Here are the cohort's aggregated results:\n\n${digest}\n\nWrite the cohort report now.`,
    },
  ];
}

/**
 * Generate the report content for a scope (a round, or a version-wide cross-round set), STREAMING a
 * progress event at each phase boundary. Builds the dataset itself (or accepts a pre-built one), runs
 * the seeded agent, validates + sanitises the output, and RETURNS the generated content + cost.
 * Round-only context (round briefing, cohort background, client KB) is loaded only for a round scope.
 *
 * Throws on unrecoverable problems (missing agent/provider, unusable output after retry) — the caller
 * maps a throw to a `failed` report row / error response.
 */
export async function* streamGenerateCohortReport(params: {
  scope: ReportScope;
  dataset?: CohortDataset;
}): AsyncGenerator<ReportGenProgressEvent, GeneratedCohortReport> {
  const { scope } = params;
  const versionId = scope.versionId;
  const roundId = scopeRoundId(scope);

  yield { type: 'started' };

  // 1. Config (generation knobs + context toggles).
  const config = await prisma.appQuestionnaireConfig.findUnique({
    where: { versionId },
    select: { cohortReport: true },
  });
  const settings = narrowCohortReportSettings(config?.cohortReport);

  // 2. The analytical substrate.
  const dataset = params.dataset ?? (await buildCohortDataset(scope));
  const digest = buildCohortDatasetDigest(dataset);
  const catalog = buildChartCatalogText(dataset);
  yield {
    type: 'dataset_built',
    sessionCount: dataset.totalSessions,
    segmentCount: dataset.segmentation.length,
  };

  // 2b. Data-slot thematic material — the raw respondent positions, the substance of the analysis.
  //     Only when the cohort is above the k-anonymity floor (the loader gates per-slot too).
  let dataSlotMaterial = '';
  if (!dataset.suppressed) {
    const sessionRows = await prisma.appQuestionnaireSession.findMany({
      where: scopeSessionWhere(scope),
      select: { id: true },
    });
    dataSlotMaterial = await buildDataSlotThemeMaterial({
      versionId,
      sessionIds: sessionRows.map((s) => s.id),
    });
  }
  yield { type: 'material_built' };

  // 3. Optional context: round briefing, cohort background, client KB. Round scope only — a
  //    version-wide report spans many rounds/cohorts, so there is no single briefing to inject.
  let roundContext = '';
  let cohortContext = '';
  let knowledge = '';
  if (roundId) {
    const round = await prisma.appQuestionnaireRound.findUnique({
      where: { id: roundId },
      select: {
        cohort: { select: { introBackground: true, demoClientId: true } },
        contextEntries: { where: { versionId }, select: { title: true, content: true } },
      },
    });
    if (settings.generation.useRoundContext && round?.contextEntries.length) {
      roundContext = round.contextEntries
        .map((e) => `${e.title}: ${e.content}`)
        .join('\n')
        .slice(0, 4000);
    }
    if (settings.generation.useCohortContext && round?.cohort?.introBackground) {
      cohortContext = round.cohort.introBackground.slice(0, 4000);
    }
    const demoClientId = round?.cohort?.demoClientId ?? null;
    if (settings.generation.useClientKnowledge && demoClientId) {
      const documentIds = await resolveClientKnowledgeDocumentIds(demoClientId);
      if (documentIds.length > 0) {
        try {
          const results = await searchKnowledge(
            digest.slice(0, 2000),
            { documentIds },
            KB_SNIPPET_LIMIT
          );
          knowledge = results.map((r, i) => `[${i + 1}] ${r.chunk.content}`).join('\n\n');
        } catch (err) {
          logger.warn('cohort report: KB search failed; continuing ungrounded', {
            roundId,
            error: errorMessage(err),
          });
        }
      }
    }
  }
  yield { type: 'context_loaded' };

  // 4. Resolve the agent + provider.
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

  // 5. Structured completion (parse → retry-once → cost sum).
  const messages = buildMessages({
    agentInstructions: agent.systemInstructions,
    settings,
    digest,
    catalog,
    roundContext,
    cohortContext,
    knowledge,
    dataSlotMaterial,
  });
  yield { type: 'synthesizing' };
  const result = await runStructuredCompletion<CohortReportContent>({
    provider,
    model,
    messages,
    temperature: agent.temperature,
    maxTokens: agent.maxTokens || REPORT_MAX_TOKENS,
    timeoutMs: REPORT_TIMEOUT_MS,
    parse: (raw) => {
      const parsed = tryParseJson(raw, (obj) => {
        const content = validateCohortReportContent(obj);
        return isUsableCohortReportContent(content) ? content : null;
      });
      return parsed;
    },
    retryUserMessage:
      'Respond with ONLY the JSON object {"summary","sections":[{"heading","body","chartIds"}],"charts":[],"recommendations":[],"actions":[]} — no prose, no code fence.',
    onFinalFailure: () => new Error('Cohort report response was not valid JSON after retry'),
  });

  logAppLlmCost({
    agentId: agent.id,
    provider: providerSlug,
    model,
    tokenUsage: result.tokenUsage,
    capability: 'app_cohort_report_generate',
    versionId,
  });

  // Sections are stored as HTML (one format for the editor + read view + PDF). The agent writes
  // markdown, so convert each body at the boundary; sanitisation happens at render (client dompurify).
  const content: CohortReportContent = {
    ...result.value,
    summary: markdownToHtml(result.value.summary),
    sections: result.value.sections.map((s) => ({
      ...s,
      body: markdownToHtml(s.body),
      format: 'html' as const,
    })),
  };

  return { content, costUsd: result.costUsd };
}

/**
 * Non-streaming convenience wrapper: drain {@link streamGenerateCohortReport} and return its final
 * result. Used by the synchronous generate routes and tests; the streaming routes consume the
 * generator directly to forward phase events over SSE.
 */
export async function generateCohortReport(params: {
  scope: ReportScope;
  dataset?: CohortDataset;
}): Promise<GeneratedCohortReport> {
  const gen = streamGenerateCohortReport(params);
  let step = await gen.next();
  while (!step.done) step = await gen.next();
  return step.value;
}
