/**
 * Streaming, map-reduce data-slot generator.
 *
 * The single-shot capability (`generate-data-slots.ts`) asks one LLM call to emit every slot
 * with every detailed description — which truncates on large questionnaires. This orchestrator
 * fans the work out instead:
 *   MAP    — group the questions by section (splitting oversized sections), run one structured
 *            completion per group in parallel (capped concurrency). Each call emits only its
 *            group's slots, so no single response is huge.
 *   REDUCE — one merge call reconciles the per-section candidates into a coherent final set
 *            (dedupe, full coverage, harmonized themes). Skipped when there's a single group.
 *
 * It's an async generator: it `yield`s progress events as each section completes and during the
 * merge (so the admin can watch slots build), and RETURNS the final slot set. The route persists
 * that set and emits the terminal `done` event. NOT exported from the data-slots barrel — it
 * pulls provider/LLM imports, so only server code (the route) imports it by path.
 */

import { logger } from '@/lib/logging';
import { CostOperation } from '@/types/orchestration';

import {
  resolveAgentProviderAndModel,
  type ResolvableAgent,
} from '@/lib/orchestration/llm/agent-resolver';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { logCost } from '@/lib/orchestration/llm/cost-tracker';
import { tryParseJson } from '@/lib/orchestration/evaluations/parse-structured';
import { runStructuredCompletion } from '@/lib/orchestration/llm/structured-completion';

import {
  GENERATE_DATA_SLOTS_CAPABILITY_SLUG,
  QUESTIONNAIRE_DATA_SLOTS_AGENT_SLUG,
} from '@/lib/app/questionnaire/constants';
import {
  buildDataSlotGenerationPrompt,
  buildDataSlotMergePrompt,
  buildDataSlotRetryMessage,
  classifyGenerationFailure,
  validateDataSlotGeneration,
  DEFAULT_DATA_SLOT_GRANULARITY,
  type DataSlotGenerationOutput,
  type DataSlotGenEvent,
  type DataSlotGranularity,
  type DataSlotStructureInput,
  type GeneratedDataSlot,
} from '@/lib/app/questionnaire/data-slots';

/** A section can hold this many questions before we split it into parallel chunks. */
const MAX_GROUP_QUESTIONS = 12;
/** Cap concurrent per-section LLM calls so we don't hammer the provider's rate limit. */
const GROUP_CONCURRENCY = 6;
/** Per-section calls are small (a fraction of the questionnaire). */
const GROUP_MAX_TOKENS = 4_096;
const GROUP_TIMEOUT_MS = 90_000;
/** The merge emits the whole final set with detailed descriptions — give it room. */
const MERGE_MAX_TOKENS = 8_192;
const MERGE_TIMEOUT_MS = 120_000;

type Question = DataSlotStructureInput['questions'][number];

interface QuestionGroup {
  index: number;
  title: string;
  questions: Question[];
}

interface GroupResult {
  index: number;
  title: string;
  slots: GeneratedDataSlot[];
  errorMessage?: string;
  usage: { input: number; output: number };
}

export interface StreamDataSlotGenerationParams {
  structure: DataSlotStructureInput;
  /** Provider binding for the generator agent (provider, model, fallbacks). */
  agent: ResolvableAgent;
  granularity?: DataSlotGranularity;
  /** For cost-log attribution. */
  agentId?: string;
  versionId?: string;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Group questions by section, preserving order; split sections larger than the cap. */
export function groupQuestionsForGeneration(
  questions: Question[],
  maxPerGroup = MAX_GROUP_QUESTIONS
): QuestionGroup[] {
  const order: string[] = [];
  const bySection = new Map<string, Question[]>();
  for (const q of questions) {
    const key = q.sectionTitle?.trim() || 'General';
    let bucket = bySection.get(key);
    if (!bucket) {
      bucket = [];
      bySection.set(key, bucket);
      order.push(key);
    }
    bucket.push(q);
  }

  const groups: QuestionGroup[] = [];
  for (const title of order) {
    const qs = bySection.get(title) ?? [];
    if (qs.length <= maxPerGroup) {
      groups.push({ index: groups.length, title, questions: qs });
      continue;
    }
    // Oversized section → fan out into "(part N)" chunks so no single call truncates.
    const partCount = Math.ceil(qs.length / maxPerGroup);
    for (let i = 0; i < qs.length; i += maxPerGroup) {
      const part = Math.floor(i / maxPerGroup) + 1;
      groups.push({
        index: groups.length,
        title: `${title} (part ${part}/${partCount})`,
        questions: qs.slice(i, i + maxPerGroup),
      });
    }
  }
  return groups;
}

/** Merge by case-insensitive name, unioning question keys — the merge-call fallback. */
export function dedupeSlots(slots: GeneratedDataSlot[]): GeneratedDataSlot[] {
  const byName = new Map<string, GeneratedDataSlot>();
  for (const s of slots) {
    const key = s.name.trim().toLowerCase();
    const existing = byName.get(key);
    if (existing) {
      existing.questionKeys = Array.from(new Set([...existing.questionKeys, ...s.questionKeys]));
    } else {
      byName.set(key, { ...s, questionKeys: [...s.questionKeys] });
    }
  }
  return Array.from(byName.values());
}

/** Run `fn` over items with bounded concurrency, yielding each result as it completes. */
async function* runWithConcurrency<I, O>(
  items: I[],
  limit: number,
  fn: (item: I) => Promise<O>
): AsyncGenerator<O> {
  const executing = new Map<number, Promise<{ key: number; value: O }>>();
  let next = 0;
  const launch = () => {
    const key = next;
    const item = items[next];
    next += 1;
    executing.set(
      key,
      fn(item).then((value) => ({ key, value }))
    );
  };
  const cap = Math.max(1, Math.min(limit, items.length));
  for (let i = 0; i < cap; i += 1) launch();
  while (executing.size > 0) {
    const { key, value } = await Promise.race(executing.values());
    executing.delete(key);
    yield value;
    if (next < items.length) launch();
  }
}

/**
 * Generate data slots as a stream of progress events, returning the final reconciled set.
 * Never throws — pre-flight failures surface as an `error` event + an empty return.
 */
export async function* streamDataSlotGeneration(
  params: StreamDataSlotGenerationParams
): AsyncGenerator<DataSlotGenEvent, GeneratedDataSlot[]> {
  const { structure, agent, agentId, versionId } = params;
  const granularity = params.granularity ?? DEFAULT_DATA_SLOT_GRANULARITY;

  // Pre-flight: resolve the provider once. A failure here is fatal — emit it and stop.
  let providerSlug: string;
  let model: string;
  try {
    const resolved = await resolveAgentProviderAndModel(agent, 'reasoning');
    providerSlug = resolved.providerSlug;
    model = resolved.model;
  } catch (err) {
    logger.error('data-slot stream: no provider resolved', { agentId, error: errMsg(err) });
    yield {
      type: 'error',
      code: 'no_provider_configured',
      message: 'No LLM provider is configured for the data-slot generator agent.',
    };
    return [];
  }

  let provider: Awaited<ReturnType<typeof getProvider>>;
  try {
    provider = await getProvider(providerSlug);
  } catch (err) {
    logger.error('data-slot stream: provider unavailable', {
      agentId,
      providerSlug,
      error: errMsg(err),
    });
    yield {
      type: 'error',
      code: 'provider_unavailable',
      message: 'The data-slot generator agent’s LLM provider is unavailable.',
    };
    return [];
  }

  const groups = groupQuestionsForGeneration(structure.questions);
  yield {
    type: 'start',
    totalQuestions: structure.questions.length,
    groups: groups.map((g) => ({
      index: g.index,
      title: g.title,
      questionCount: g.questions.length,
    })),
  };

  const runGroup = async (group: QuestionGroup): Promise<GroupResult> => {
    let issuePaths: string[] = [];
    try {
      const completion = await runStructuredCompletion<DataSlotGenerationOutput>({
        provider,
        model,
        messages: buildDataSlotGenerationPrompt(
          { goal: structure.goal, audience: structure.audience, questions: group.questions },
          granularity
        ),
        maxTokens: GROUP_MAX_TOKENS,
        timeoutMs: GROUP_TIMEOUT_MS,
        parse: (raw) =>
          tryParseJson(raw, (parsed) => {
            const validation = validateDataSlotGeneration(parsed);
            if (validation.ok) return validation.value;
            issuePaths = validation.issues.map((i) =>
              i.path.length > 0 ? i.path.join('.') : '(root)'
            );
            return null;
          }),
        retryUserMessage: buildDataSlotRetryMessage(),
        onFinalFailure: () =>
          new Error(
            'Data-slot generation response was not valid against the schema after one retry' +
              (issuePaths.length > 0 ? ` (invalid at: ${issuePaths.join(', ')})` : '')
          ),
      });
      return {
        index: group.index,
        title: group.title,
        slots: completion.value.slots,
        usage: { input: completion.tokenUsage.input, output: completion.tokenUsage.output },
      };
    } catch (err) {
      const { message } = classifyGenerationFailure(errMsg(err), issuePaths);
      logger.warn('data-slot stream: group failed', {
        agentId,
        group: group.title,
        error: errMsg(err),
      });
      return {
        index: group.index,
        title: group.title,
        slots: [],
        errorMessage: message,
        usage: { input: 0, output: 0 },
      };
    }
  };

  const collected: GeneratedDataSlot[] = [];
  let totalInput = 0;
  let totalOutput = 0;
  let anySuccess = false;

  for await (const r of runWithConcurrency(groups, GROUP_CONCURRENCY, runGroup)) {
    totalInput += r.usage.input;
    totalOutput += r.usage.output;
    if (r.errorMessage) {
      yield { type: 'group_error', index: r.index, title: r.title, message: r.errorMessage };
    } else {
      anySuccess = true;
      collected.push(...r.slots);
      yield { type: 'group_done', index: r.index, title: r.title, slots: r.slots };
    }
  }

  if (!anySuccess || collected.length === 0) {
    logUsage(totalInput, totalOutput, { agentId, model, providerSlug, versionId });
    yield {
      type: 'error',
      code: 'generation_failed',
      message:
        'Every section failed to generate data slots. Check the generator agent’s provider, then try again.',
    };
    return [];
  }

  let finalSlots: GeneratedDataSlot[];
  if (groups.length <= 1) {
    // Single section → nothing to reconcile; the one group's slots ARE the result.
    finalSlots = collected;
  } else {
    yield { type: 'merge_start', rawSlotCount: collected.length };
    try {
      const merged = await runStructuredCompletion<DataSlotGenerationOutput>({
        provider,
        model,
        messages: buildDataSlotMergePrompt(
          structure,
          collected.map((c) => ({
            name: c.name,
            description: c.description,
            theme: c.theme,
            questionKeys: c.questionKeys,
          })),
          granularity
        ),
        maxTokens: MERGE_MAX_TOKENS,
        timeoutMs: MERGE_TIMEOUT_MS,
        parse: (raw) =>
          tryParseJson(raw, (parsed) => {
            const validation = validateDataSlotGeneration(parsed);
            return validation.ok ? validation.value : null;
          }),
        retryUserMessage: buildDataSlotRetryMessage(),
        onFinalFailure: () => new Error('Merge response was not valid against the schema'),
      });
      totalInput += merged.tokenUsage.input;
      totalOutput += merged.tokenUsage.output;
      finalSlots = merged.value.slots;
    } catch (err) {
      // Merge is a refinement, not a gate — fall back to the deduped union so the admin still
      // gets a usable (if rougher) set rather than nothing.
      logger.warn('data-slot stream: merge failed, using deduped union', {
        agentId,
        error: errMsg(err),
      });
      finalSlots = dedupeSlots(collected);
      yield {
        type: 'merge_warning',
        message:
          'Couldn’t reconcile the sections automatically — showing the combined set instead. Review for duplicates before saving.',
      };
    }
  }

  logUsage(totalInput, totalOutput, { agentId, model, providerSlug, versionId });
  return finalSlots;
}

/** Fire-and-forget cost log for the whole map-reduce run (summed across all calls). */
function logUsage(
  inputTokens: number,
  outputTokens: number,
  meta: { agentId?: string; model: string; providerSlug: string; versionId?: string }
): void {
  void logCost({
    ...(meta.agentId ? { agentId: meta.agentId } : {}),
    operation: CostOperation.CHAT,
    model: meta.model,
    provider: meta.providerSlug,
    inputTokens,
    outputTokens,
    metadata: {
      capability: GENERATE_DATA_SLOTS_CAPABILITY_SLUG,
      mode: 'stream',
      ...(meta.versionId ? { versionId: meta.versionId } : {}),
    },
  }).catch((err) => {
    logger.error('data-slot stream: logCost rejected', {
      agentId: meta.agentId,
      error: errMsg(err),
    });
  });
}

// Re-export the agent slug so the route resolves the same agent the capability uses.
export { QUESTIONNAIRE_DATA_SLOTS_AGENT_SLUG };
