/**
 * Suggest-round-briefing capability (round Additional Context, phase 3).
 *
 * "Have an agent evaluate the questionnaire and propose interviewer briefing notes." Given a
 * questionnaire's goal + questions (and optional admin-supplied source material), it proposes a set
 * of briefing entries — facts/figures/background that would help the interviewer ask each question
 * well — each optionally attributed to one of the provided question ids. One provider-agnostic
 * structured LLM call (call → parse → retry-once → cost-sum). It does NOT persist: the route returns
 * the proposals and the admin reviews, edits, and saves each via the normal create endpoint.
 *
 * Reuses the composer agent (`entityContext.composerAgent`) — the same authoring skill as compose /
 * intro-background. `processesPii = true`: source material can carry company context.
 *
 * Boundary: lives under `lib/app/**`, so no Prisma and no Next.js imports.
 */

import { isRecord } from '@/lib/utils';
import { logger } from '@/lib/logging';
import { redactedString } from '@/lib/security/redact';
import { CostOperation } from '@/types/orchestration';
import { z } from 'zod';

import { BaseCapability } from '@/lib/orchestration/capabilities/base-capability';
import type { CapabilityContext, CapabilityResult } from '@/lib/orchestration/capabilities/types';
import {
  resolveAgentProviderAndModel,
  type ResolvableAgent,
} from '@/lib/orchestration/llm/agent-resolver';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { logCost } from '@/lib/orchestration/llm/cost-tracker';
import type { LlmMessage } from '@/lib/orchestration/llm/types';
import {
  runStructuredCompletion,
  tryParseJson,
  type StructuredCompletionResult,
} from '@/lib/orchestration/evaluations/parse-structured';
import { joinSections, section } from '@/lib/app/questionnaire/prompt/format';
import { SUGGEST_ROUND_BRIEFING_FUNCTION_DEFINITION } from '@/lib/app/questionnaire/constants';
import { SUGGEST_ROUND_BRIEFING_CAPABILITY_SLUG } from '@/lib/app/questionnaire/constants';

const SLUG = SUGGEST_ROUND_BRIEFING_CAPABILITY_SLUG;

const SUGGEST_MAX_TOKENS = 4_000;
const SUGGEST_TIMEOUT_MS = 60_000;
const PROVENANCE_PREVIEW_CAP = 200;
/** Hard cap on proposals the model may return (the admin then accepts a subset). */
const MAX_PROPOSALS = 20;
/** Cap on how much source material we forward (keeps the prompt bounded). */
const SOURCE_TEXT_CAP = 12_000;

const questionInputSchema = z.object({
  id: z.string().min(1),
  prompt: z.string(),
  sectionTitle: z.string().optional(),
});

const argsSchema = z.object({
  goal: z.string().optional(),
  questions: z.array(questionInputSchema).min(1),
  sourceText: z.string().optional(),
  maxEntries: z.number().int().min(1).max(MAX_PROPOSALS).optional(),
});

export type SuggestRoundBriefingArgs = z.infer<typeof argsSchema>;

/** One proposed briefing note — `questionId` null = a general (whole-version) note. */
export interface SuggestedBriefingEntry {
  questionId: string | null;
  title: string;
  content: string;
}

export interface SuggestRoundBriefingData {
  entries: SuggestedBriefingEntry[];
}

/** The model's reply contract — a list of proposals. `questionId` optional/null = general. */
const outputSchema = z.object({
  entries: z
    .array(
      z.object({
        questionId: z.string().nullish(),
        title: z.string().min(1),
        content: z.string().min(1),
      })
    )
    .default([]),
});

function readComposerAgentBinding(
  entityContext: CapabilityContext['entityContext']
): ResolvableAgent {
  const raw = entityContext?.composerAgent;
  if (isRecord(raw)) {
    return {
      provider: typeof raw.provider === 'string' ? raw.provider : '',
      model: typeof raw.model === 'string' ? raw.model : '',
      fallbackProviders: Array.isArray(raw.fallbackProviders)
        ? raw.fallbackProviders.filter((value): value is string => typeof value === 'string')
        : [],
    };
  }
  return { provider: '', model: '', fallbackProviders: [] };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Build the structured-suggestion prompt. Pure; lists the questions so the model can attribute. */
function buildSuggestPrompt(args: SuggestRoundBriefingArgs): LlmMessage[] {
  const max = args.maxEntries ?? 8;
  const questionLines = args.questions
    .map(
      (q, i) => `${i + 1}. [id:${q.id}]${q.sectionTitle ? ` (${q.sectionTitle})` : ''} ${q.prompt}`
    )
    .join('\n');
  const source = (args.sourceText ?? '').trim().slice(0, SOURCE_TEXT_CAP);

  const system = joinSections(
    section(
      'role',
      'You brief a skilled interviewer before they run a questionnaire. Your job is to propose short ' +
        '"briefing notes" — facts, figures, definitions, or background that would help the ' +
        'interviewer ask each question knowledgeably and follow up well. You are NOT writing ' +
        'questions or answers; you are arming the interviewer with context.'
    ),
    section(
      'rules',
      joinSections(
        `Propose at most ${max} notes. Each note has a short title and a concise content body.`,
        'Attribute a note to ONE question by setting its `questionId` to that question’s id (shown ' +
          'as [id:…]) when the note is specifically useful for that question; otherwise leave ' +
          '`questionId` null for a general, whole-questionnaire note.',
        'A `questionId`, when set, MUST be one of the ids listed below — never invent one.',
        source
          ? 'Base the notes on the supplied source material — extract the concrete facts/figures an ' +
              'interviewer would want at hand. Do not fabricate figures the source does not support.'
          : 'No source material was supplied, so propose the KINDS of background worth gathering — ' +
              'frame each note as a clear prompt to the admin for the specific facts/figures to add ' +
              '(e.g. "Current headcount and recent growth", "Key competitor names"). Keep them ' +
              'concrete and easy to fill in.'
      )
    ),
    section('goal', args.goal ? `Questionnaire goal: ${args.goal}` : ''),
    section('questions', questionLines),
    section('source_material', source),
    section(
      'output_format',
      'Reply with ONLY a JSON object: {"entries":[{"questionId":string|null,"title":string,' +
        '"content":string}]}. No prose, no markdown fences.'
    )
  );

  return [
    { role: 'system', content: system },
    { role: 'user', content: 'Propose the interviewer briefing notes now as JSON.' },
  ];
}

export class AppSuggestRoundBriefingCapability extends BaseCapability<
  SuggestRoundBriefingArgs,
  SuggestRoundBriefingData
> {
  readonly slug = SLUG;
  readonly processesPii = true;

  readonly functionDefinition = SUGGEST_ROUND_BRIEFING_FUNCTION_DEFINITION;

  protected readonly schema = argsSchema;

  redactProvenance(
    args: SuggestRoundBriefingArgs,
    result: CapabilityResult<SuggestRoundBriefingData>
  ): { args: unknown; resultPreview: string } {
    const safeArgs = {
      questionCount: args.questions.length,
      ...(args.goal !== undefined ? { goal: redactedString('goal') } : {}),
      ...(args.sourceText !== undefined ? { sourceText: redactedString('sourceText') } : {}),
    };
    let preview: string;
    if (result.success && result.data) {
      preview = JSON.stringify({ success: true, data: { count: result.data.entries.length } });
    } else {
      preview = JSON.stringify(result);
    }
    if (preview.length > PROVENANCE_PREVIEW_CAP) {
      preview = preview.slice(0, PROVENANCE_PREVIEW_CAP - 1) + '…';
    }
    return { args: safeArgs, resultPreview: preview };
  }

  async execute(
    args: SuggestRoundBriefingArgs,
    context: CapabilityContext
  ): Promise<CapabilityResult<SuggestRoundBriefingData>> {
    let providerSlug: string;
    let model: string;
    try {
      const resolved = await resolveAgentProviderAndModel(
        readComposerAgentBinding(context.entityContext),
        'reasoning'
      );
      providerSlug = resolved.providerSlug;
      model = resolved.model;
    } catch (err) {
      logger.error('suggest_round_briefing: no provider resolved', {
        agentId: context.agentId,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'no_provider_configured');
    }

    let provider: Awaited<ReturnType<typeof getProvider>>;
    try {
      provider = await getProvider(providerSlug);
    } catch (err) {
      logger.error('suggest_round_briefing: provider unavailable', {
        agentId: context.agentId,
        providerSlug,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'provider_unavailable');
    }

    let completion: StructuredCompletionResult<z.infer<typeof outputSchema>>;
    try {
      completion = await runStructuredCompletion<z.infer<typeof outputSchema>>({
        provider,
        model,
        messages: buildSuggestPrompt(args),
        maxTokens: SUGGEST_MAX_TOKENS,
        timeoutMs: SUGGEST_TIMEOUT_MS,
        parse: (raw) =>
          tryParseJson(raw, (parsed) => {
            const result = outputSchema.safeParse(parsed);
            return result.success ? result.data : null;
          }),
        retryUserMessage:
          'That was not valid JSON. Reply with ONLY {"entries":[{"questionId":string|null,' +
          '"title":string,"content":string}]}.',
        onFinalFailure: () =>
          new Error('Suggest-briefing response was not valid JSON after one retry'),
      });
    } catch (err) {
      logger.error('suggest_round_briefing: structured completion failed', {
        agentId: context.agentId,
        model,
        provider: providerSlug,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'suggest_failed');
    }

    void logCost({
      ...(context.agentId ? { agentId: context.agentId } : {}),
      operation: CostOperation.CHAT,
      model,
      provider: providerSlug,
      inputTokens: completion.tokenUsage.input,
      outputTokens: completion.tokenUsage.output,
      metadata: { capability: SLUG },
    }).catch((err) => {
      logger.error('suggest_round_briefing: logCost rejected', {
        agentId: context.agentId,
        error: errorMessage(err),
      });
    });

    // Keep only proposals whose attributed id (if any) is one we offered — the model can hallucinate
    // an id; an unknown id silently degrades to a general note rather than a dangling reference.
    const validIds = new Set(args.questions.map((q) => q.id));
    const entries: SuggestedBriefingEntry[] = completion.value.entries
      .slice(0, MAX_PROPOSALS)
      .map((e) => ({
        questionId: e.questionId && validIds.has(e.questionId) ? e.questionId : null,
        title: e.title.trim(),
        content: e.content.trim(),
      }))
      .filter((e) => e.title.length > 0 && e.content.length > 0);

    return this.success({ entries });
  }
}
