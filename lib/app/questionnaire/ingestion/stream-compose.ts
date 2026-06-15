/**
 * Streaming, two-phase questionnaire composer.
 *
 * The single-shot capability (`capabilities/compose-questionnaire.ts`) asks one
 * LLM call to emit the whole questionnaire — fine for an API call, but it pops
 * into existence all at once. This orchestrator fans the work out so the admin can
 * *watch it build*:
 *   OUTLINE  — one fast call plans the sections + goal/audience (no questions yet).
 *   SECTIONS — one structured call per section, in parallel (capped concurrency),
 *              each writing only its own questions. Each completion streams in.
 *
 * It's an async generator: it `yield`s progress events (`outline`, then a
 * `section_done`/`section_error` per section) and RETURNS the assembled structure
 * (sections + de-duplicated questions). The route persists that structure as a new
 * draft questionnaire and emits the terminal `done` event with the new ids. NOT
 * exported from a barrel — it pulls provider/LLM imports, so only server code (the
 * route) imports it by path. Mirrors `data-slots/generate-stream.ts`.
 */

import { logger } from '@/lib/logging';
import { CostOperation } from '@/types/orchestration';

import {
  resolveAgentProviderAndModel,
  type ResolvableAgent,
} from '@/lib/orchestration/llm/agent-resolver';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { logCost } from '@/lib/orchestration/llm/cost-tracker';
import {
  runStructuredCompletion,
  tryParseJson,
} from '@/lib/orchestration/evaluations/parse-structured';

import {
  COMPOSE_QUESTIONNAIRE_CAPABILITY_SLUG,
  QUESTIONNAIRE_COMPOSER_AGENT_SLUG,
} from '@/lib/app/questionnaire/constants';
import {
  buildComposeOutlinePrompt,
  buildComposeSectionQuestionsPrompt,
  buildComposeRetryMessage,
} from '@/lib/app/questionnaire/ingestion/compose-prompt';
import {
  toExtractionData,
  validateComposeOutline,
  validateComposeQuestions,
  type ComposeOutline,
  type ComposeQuestions,
} from '@/lib/app/questionnaire/ingestion/compose-schema';
import type {
  ExtractedQuestion,
  ExtractedSection,
} from '@/lib/app/questionnaire/ingestion/extraction-schema';
import type { ExtractQuestionnaireStructureData } from '@/lib/app/questionnaire/capabilities/extract-questionnaire-structure';
import type { ComposeGenEvent } from '@/lib/app/questionnaire/ingestion/compose-events';
import type { AdminSuppliedMetadata } from '@/lib/app/questionnaire/ingestion/types';

/** Cap concurrent per-section LLM calls so we don't hammer the provider's rate limit. */
const SECTION_CONCURRENCY = 4;
/** The outline is small (titles + framing). */
const OUTLINE_MAX_TOKENS = 2_048;
const OUTLINE_TIMEOUT_MS = 60_000;
/** Per-section calls emit a handful of questions each. */
const SECTION_MAX_TOKENS = 4_096;
const SECTION_TIMEOUT_MS = 90_000;

export interface StreamComposeParams {
  brief: string;
  /** Provider binding for the composer agent (provider, model, fallbacks). */
  agent: ResolvableAgent;
  /** Admin-supplied goal/audience the composer must not infer. */
  adminSupplied?: AdminSuppliedMetadata;
  /** For cost-log attribution. */
  agentId?: string;
}

interface SectionResult {
  ordinal: number;
  title: string;
  questions: ExtractedQuestion[];
  errorMessage?: string;
  usage: { input: number; output: number };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
 * Guarantee globally-unique, non-empty question keys. The per-section calls run
 * independently, so two sections can mint the same `key`; persistence requires
 * them unique per version. Slugify a fallback from the prompt, then append `-2`,
 * `-3`, … on collision. Order is preserved.
 */
function dedupeQuestionKeys(questions: ExtractedQuestion[]): ExtractedQuestion[] {
  const seen = new Set<string>();
  return questions.map((q, index) => {
    const base =
      q.key.trim() ||
      q.prompt
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 40) ||
      `question_${index + 1}`;
    let key = base;
    let suffix = 2;
    while (seen.has(key)) {
      key = `${base}-${suffix}`;
      suffix += 1;
    }
    seen.add(key);
    return { ...q, key };
  });
}

/**
 * Compose a questionnaire from a brief as a stream of progress events, returning
 * the assembled structure. Never throws — failures surface as an `error` event +
 * an empty structure (no sections), which the route treats as "nothing to persist".
 */
export async function* streamComposeQuestionnaire(
  params: StreamComposeParams
): AsyncGenerator<ComposeGenEvent, ExtractQuestionnaireStructureData> {
  const { brief, agent, adminSupplied, agentId } = params;
  const empty: ExtractQuestionnaireStructureData = { sections: [], questions: [], changes: [] };

  // Pre-flight: resolve the provider once. A failure here is fatal.
  let providerSlug: string;
  let model: string;
  try {
    const resolved = await resolveAgentProviderAndModel(agent, 'reasoning');
    providerSlug = resolved.providerSlug;
    model = resolved.model;
  } catch (err) {
    logger.error('compose stream: no provider resolved', { agentId, error: errMsg(err) });
    yield {
      type: 'error',
      code: 'no_provider_configured',
      message: 'No LLM provider is configured for the questionnaire composer agent.',
    };
    return empty;
  }

  let provider: Awaited<ReturnType<typeof getProvider>>;
  try {
    provider = await getProvider(providerSlug);
  } catch (err) {
    logger.error('compose stream: provider unavailable', {
      agentId,
      providerSlug,
      error: errMsg(err),
    });
    yield {
      type: 'error',
      code: 'provider_unavailable',
      message: 'The questionnaire composer agent’s LLM provider is unavailable.',
    };
    return empty;
  }

  let totalInput = 0;
  let totalOutput = 0;

  // PHASE 1 — outline.
  let outline: ComposeOutline;
  try {
    let issuePaths: string[] = [];
    const completion = await runStructuredCompletion<ComposeOutline>({
      provider,
      model,
      messages: buildComposeOutlinePrompt(brief, adminSupplied),
      maxTokens: OUTLINE_MAX_TOKENS,
      timeoutMs: OUTLINE_TIMEOUT_MS,
      parse: (raw) =>
        tryParseJson(raw, (parsed) => {
          const validation = validateComposeOutline(parsed);
          if (validation.ok) return validation.value;
          issuePaths = validation.issues.map((i) =>
            i.path.length > 0 ? i.path.join('.') : '(root)'
          );
          return null;
        }),
      retryUserMessage: buildComposeRetryMessage([]),
      onFinalFailure: () =>
        new Error(
          'Outline response was not valid against the schema after one retry' +
            (issuePaths.length > 0 ? ` (invalid at: ${issuePaths.join(', ')})` : '')
        ),
    });
    totalInput += completion.tokenUsage.input;
    totalOutput += completion.tokenUsage.output;
    outline = completion.value;
  } catch (err) {
    logger.error('compose stream: outline failed', { agentId, error: errMsg(err) });
    logUsage(totalInput, totalOutput, { agentId, model, providerSlug });
    yield {
      type: 'error',
      code: 'outline_failed',
      message: 'Could not plan the questionnaire from this brief. Try rephrasing it, then retry.',
    };
    return empty;
  }

  // Renumber the sections contiguously from 0 (the model is asked for this, but
  // enforce it so question→section linkage is always coherent).
  const sections: ExtractedSection[] = outline.sections.map((s, index) => ({
    ...s,
    ordinal: index,
  }));

  yield {
    type: 'outline',
    sections,
    ...(outline.inferredGoal !== undefined ? { goal: outline.inferredGoal } : {}),
    ...(outline.inferredAudience !== undefined ? { audience: outline.inferredAudience } : {}),
  };

  // PHASE 2 — questions per section, in parallel.
  const siblingTitles = sections.map((s) => s.title);
  const runSection = async (section: ExtractedSection): Promise<SectionResult> => {
    let issuePaths: string[] = [];
    try {
      const completion = await runStructuredCompletion<ComposeQuestions>({
        provider,
        model,
        messages: buildComposeSectionQuestionsPrompt(brief, {
          ordinal: section.ordinal,
          title: section.title,
          ...(section.description !== undefined ? { description: section.description } : {}),
          siblingTitles,
          ...(outline.inferredGoal !== undefined ? { goal: outline.inferredGoal } : {}),
        }),
        maxTokens: SECTION_MAX_TOKENS,
        timeoutMs: SECTION_TIMEOUT_MS,
        parse: (raw) =>
          tryParseJson(raw, (parsed) => {
            const validation = validateComposeQuestions(parsed);
            if (validation.ok) return validation.value;
            issuePaths = validation.issues.map((i) =>
              i.path.length > 0 ? i.path.join('.') : '(root)'
            );
            return null;
          }),
        retryUserMessage: buildComposeRetryMessage([]),
        onFinalFailure: () =>
          new Error(
            'Section response was not valid against the schema after one retry' +
              (issuePaths.length > 0 ? ` (invalid at: ${issuePaths.join(', ')})` : '')
          ),
      });
      // Force every question onto THIS section's ordinal — never trust the model's
      // self-reported linkage, so the assembled graph always passes coherence.
      const questions = completion.value.questions.map((q) => ({
        ...q,
        sectionOrdinal: section.ordinal,
      }));
      return {
        ordinal: section.ordinal,
        title: section.title,
        questions,
        usage: { input: completion.tokenUsage.input, output: completion.tokenUsage.output },
      };
    } catch (err) {
      logger.warn('compose stream: section failed', {
        agentId,
        section: section.title,
        error: errMsg(err),
      });
      return {
        ordinal: section.ordinal,
        title: section.title,
        questions: [],
        errorMessage: 'Could not generate questions for this section.',
        usage: { input: 0, output: 0 },
      };
    }
  };

  const collected: ExtractedQuestion[] = [];
  let anySuccess = false;
  for await (const r of runWithConcurrency(sections, SECTION_CONCURRENCY, runSection)) {
    totalInput += r.usage.input;
    totalOutput += r.usage.output;
    if (r.errorMessage) {
      yield { type: 'section_error', ordinal: r.ordinal, title: r.title, message: r.errorMessage };
    } else {
      anySuccess = true;
      collected.push(...r.questions);
      yield { type: 'section_done', ordinal: r.ordinal, title: r.title, questions: r.questions };
    }
  }

  logUsage(totalInput, totalOutput, { agentId, model, providerSlug });

  if (!anySuccess || collected.length === 0) {
    yield {
      type: 'error',
      code: 'composition_failed',
      message:
        'Every section failed to generate questions. Check the composer agent’s provider, then try again.',
    };
    return empty;
  }

  const questions = dedupeQuestionKeys(collected);
  return toExtractionData({
    sections,
    questions,
    ...(outline.inferredGoal !== undefined ? { inferredGoal: outline.inferredGoal } : {}),
    ...(outline.inferredAudience !== undefined
      ? { inferredAudience: outline.inferredAudience }
      : {}),
  });
}

/** Fire-and-forget cost log for the whole two-phase run (summed across all calls). */
function logUsage(
  inputTokens: number,
  outputTokens: number,
  meta: { agentId?: string; model: string; providerSlug: string }
): void {
  void logCost({
    ...(meta.agentId ? { agentId: meta.agentId } : {}),
    operation: CostOperation.CHAT,
    model: meta.model,
    provider: meta.providerSlug,
    inputTokens,
    outputTokens,
    metadata: { capability: COMPOSE_QUESTIONNAIRE_CAPABILITY_SLUG, mode: 'stream' },
  }).catch((err) => {
    logger.error('compose stream: logCost rejected', { agentId: meta.agentId, error: errMsg(err) });
  });
}

// Re-export the agent slug so the route resolves the same agent the capability uses.
export { QUESTIONNAIRE_COMPOSER_AGENT_SLUG };
