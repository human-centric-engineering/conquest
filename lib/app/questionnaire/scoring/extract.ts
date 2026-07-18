/**
 * Scoring schema extraction (the upload path, F14.4).
 *
 * `extractScoringSchema` turns an uploaded scoring document's text into a {@link ScoringSchemaContent}
 * proposal the admin reviews + saves through the builder's PUT. It supplies the agent the version's
 * available question/data-slot keys so every proposed item references a real key, then validates +
 * prunes the output (`narrowScoringSchemaContent` drops items pointing at unknown scales; this also
 * drops items whose `ref` isn't an available key). Reuses the seeded cohort-report agent — the same
 * direct-agent structured-completion pattern as generation. Server-side.
 */

import { prisma } from '@/lib/db/client';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { tryParseJson } from '@/lib/orchestration/evaluations/parse-structured';
import { runStructuredCompletion } from '@/lib/orchestration/llm/structured-completion';
import { COHORT_REPORT_AGENT_SLUG } from '@/lib/app/questionnaire/constants';
import { logAppLlmCost } from '@/lib/app/questionnaire/llm/log-app-cost';
import { narrowScoringSchemaContent } from '@/lib/app/questionnaire/scoring/schema-validation';
import type { ScoringSchemaContent } from '@/lib/app/questionnaire/scoring/types';

const EXTRACT_MAX_TOKENS = 4096;
const EXTRACT_TIMEOUT_MS = 60_000;
const DOC_CHAR_CAP = 16_000;

/** Extract a scoring-schema proposal from a document's text, scoped to the version's available keys. */
export async function extractScoringSchema(
  versionId: string,
  documentText: string
): Promise<ScoringSchemaContent> {
  const [slots, dataSlots] = await Promise.all([
    prisma.appQuestionSlot.findMany({
      where: { versionId },
      orderBy: [{ section: { ordinal: 'asc' } }, { ordinal: 'asc' }],
      select: { key: true, prompt: true, type: true },
    }),
    prisma.appDataSlot.findMany({
      where: { versionId },
      orderBy: { ordinal: 'asc' },
      select: { key: true, name: true },
    }),
  ]);
  const availableQuestionKeys = new Set(slots.map((s) => s.key));
  const availableDataSlotKeys = new Set(dataSlots.map((d) => d.key));

  const catalog = [
    'QUESTIONS (use as item ref with source "question"):',
    ...slots.map((s) => `  ${s.key} — "${s.prompt}" (${s.type})`),
    ...(dataSlots.length > 0
      ? [
          'DATA SLOTS (use as item ref with source "dataSlot"):',
          ...dataSlots.map((d) => `  ${d.key} — ${d.name}`),
        ]
      : []),
  ].join('\n');

  const agent = await prisma.aiAgent.findUnique({
    where: { slug: COHORT_REPORT_AGENT_SLUG },
    select: {
      id: true,
      provider: true,
      model: true,
      fallbackProviders: true,
      temperature: true,
      maxTokens: true,
    },
  });
  if (!agent) throw new Error('Cohort report agent is not seeded');

  const { providerSlug, model } = await resolveAgentProviderAndModel(agent, 'reasoning');
  const provider = await getProvider(providerSlug);

  const system = [
    'You convert a scoring specification document into a structured scoring schema for a ' +
      'questionnaire. Define the scales the document describes, map each item to the available ' +
      'question/data-slot below (use the exact key), set weight + reverse-scoring per item, choose ' +
      'the combine method (sum or mean), and define band cutoffs. Only use keys from this catalog; ' +
      'omit anything you cannot map.',
    catalog,
    'Respond with ONLY a JSON object of this exact shape (no prose, no code fence):\n' +
      '{"scales":[{"key":string,"name":string,"description"?:string}],' +
      '"items":[{"source":"question"|"dataSlot","ref":string,"scaleKey":string,"weight":number,"reverse":boolean}],' +
      '"bands":[{"scaleKey":string,"min":number,"max":number,"label":string}],"method":"sum"|"mean"}',
  ].join('\n\n');

  const result = await runStructuredCompletion<ScoringSchemaContent>({
    provider,
    model,
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: `Scoring document:\n\n${documentText.slice(0, DOC_CHAR_CAP)}\n\nProduce the scoring schema now.`,
      },
    ],
    temperature: agent.temperature,
    maxTokens: agent.maxTokens || EXTRACT_MAX_TOKENS,
    timeoutMs: EXTRACT_TIMEOUT_MS,
    parse: (raw) =>
      tryParseJson(raw, (obj) => {
        const schema = narrowScoringSchemaContent(obj);
        // Drop items whose ref isn't a real key for the declared source.
        schema.items = schema.items.filter((i) =>
          i.source === 'question'
            ? availableQuestionKeys.has(i.ref)
            : availableDataSlotKeys.has(i.ref)
        );
        return schema.scales.length > 0 ? schema : null;
      }),
    retryUserMessage:
      'Respond with ONLY the JSON object {"scales":[],"items":[],"bands":[],"method":"mean"} — no prose, no code fence.',
    onFinalFailure: () => new Error('Scoring schema response was not valid JSON after retry'),
  });

  logAppLlmCost({
    agentId: agent.id,
    provider: providerSlug,
    model,
    tokenUsage: result.tokenUsage,
    capability: 'app_scoring_extract',
    versionId,
  });

  return result.value;
}
