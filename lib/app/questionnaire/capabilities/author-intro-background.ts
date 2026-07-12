/**
 * Author-intro-background capability (F12.2).
 *
 * Writes or refines the respondent-facing "about this questionnaire" intro markdown via one
 * provider-agnostic structured LLM call (call → parse → retry-once-at-temp-0 → cost-sum). `generate`
 * composes from a plain-English brief; `refine` rewrites supplied text per an instruction. Output is
 * a single `{ background }` string, trimmed and capped to {@link INTRO_BACKGROUND_MAX_LENGTH}. It does
 * NOT persist — the route returns the text and the admin saves it via the config / cohort PATCH.
 *
 * Reuses the composer agent (`entityContext.composerAgent`) — the same authoring skill as compose /
 * refine-structure. `processesPii = true`: a brief or current text can carry company context.
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
import { tryParseJson } from '@/lib/orchestration/evaluations/parse-structured';
import {
  runStructuredCompletion,
  type StructuredCompletionResult,
} from '@/lib/orchestration/llm/structured-completion';

import { AUTHOR_INTRO_BACKGROUND_FUNCTION_DEFINITION } from '@/lib/app/questionnaire/constants';
import { AUTHOR_INTRO_BACKGROUND_CAPABILITY_SLUG } from '@/lib/app/questionnaire/constants';
import { INTRO_BACKGROUND_MAX_LENGTH } from '@/lib/app/questionnaire/types';
import {
  buildGenerateIntroBackgroundPrompt,
  buildRefineIntroBackgroundPrompt,
  buildIntroBackgroundRetryMessage,
} from '@/lib/app/questionnaire/intro/authoring-prompt';

const SLUG = AUTHOR_INTRO_BACKGROUND_CAPABILITY_SLUG;

/** The intro is short prose; allow headroom for a verbose draft but nothing structure-sized. */
const AUTHOR_MAX_TOKENS = 4_000;
const AUTHOR_TIMEOUT_MS = 60_000;
const PROVENANCE_PREVIEW_CAP = 200;

const argsSchema = z
  .object({
    mode: z.enum(['generate', 'refine']),
    brief: z.string().min(1).optional(),
    currentText: z.string().min(1).optional(),
    instruction: z.string().min(1).optional(),
    /**
     * Pre-formatted summary of the questionnaire's goal + questions (generate only). Injected by the
     * author route when the admin opts to ground the intro in the questionnaire; the capability is
     * Prisma-free, so it never loads this itself.
     */
    questionnaireContext: z.string().min(1).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.mode === 'generate' && !v.brief) {
      ctx.addIssue({ code: 'custom', message: 'brief is required for generate', path: ['brief'] });
    }
    if (v.mode === 'refine') {
      if (!v.currentText) {
        ctx.addIssue({
          code: 'custom',
          message: 'currentText is required for refine',
          path: ['currentText'],
        });
      }
      if (!v.instruction) {
        ctx.addIssue({
          code: 'custom',
          message: 'instruction is required for refine',
          path: ['instruction'],
        });
      }
    }
  });

export type AuthorIntroBackgroundArgs = z.infer<typeof argsSchema>;

export interface AuthorIntroBackgroundData {
  /** The generated / refined intro markdown, trimmed and length-capped. */
  background: string;
}

/** The model's reply contract — a single markdown string under `background`. */
const outputSchema = z.object({ background: z.string() });

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

export class AppAuthorIntroBackgroundCapability extends BaseCapability<
  AuthorIntroBackgroundArgs,
  AuthorIntroBackgroundData
> {
  readonly slug = SLUG;
  readonly processesPii = true;

  readonly functionDefinition = AUTHOR_INTRO_BACKGROUND_FUNCTION_DEFINITION;

  protected readonly schema = argsSchema;

  redactProvenance(
    args: AuthorIntroBackgroundArgs,
    result: CapabilityResult<AuthorIntroBackgroundData>
  ): { args: unknown; resultPreview: string } {
    const safeArgs = {
      mode: args.mode,
      ...(args.brief !== undefined ? { brief: redactedString('brief') } : {}),
      ...(args.currentText !== undefined ? { currentText: redactedString('currentText') } : {}),
      ...(args.instruction !== undefined ? { instruction: redactedString('instruction') } : {}),
      ...(args.questionnaireContext !== undefined
        ? { questionnaireContext: redactedString('questionnaireContext') }
        : {}),
    };
    let preview: string;
    if (result.success && result.data) {
      preview = JSON.stringify({ success: true, data: { length: result.data.background.length } });
    } else {
      preview = JSON.stringify(result);
    }
    if (preview.length > PROVENANCE_PREVIEW_CAP) {
      preview = preview.slice(0, PROVENANCE_PREVIEW_CAP - 1) + '…';
    }
    return { args: safeArgs, resultPreview: preview };
  }

  async execute(
    args: AuthorIntroBackgroundArgs,
    context: CapabilityContext
  ): Promise<CapabilityResult<AuthorIntroBackgroundData>> {
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
      logger.error('author_intro_background: no provider resolved', {
        agentId: context.agentId,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'no_provider_configured');
    }

    let provider: Awaited<ReturnType<typeof getProvider>>;
    try {
      provider = await getProvider(providerSlug);
    } catch (err) {
      logger.error('author_intro_background: provider unavailable', {
        agentId: context.agentId,
        providerSlug,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'provider_unavailable');
    }

    const messages =
      args.mode === 'generate'
        ? buildGenerateIntroBackgroundPrompt(args.brief ?? '', args.questionnaireContext)
        : buildRefineIntroBackgroundPrompt(args.currentText ?? '', args.instruction ?? '');

    let completion: StructuredCompletionResult<{ background: string }>;
    try {
      completion = await runStructuredCompletion<{ background: string }>({
        provider,
        model,
        messages,
        maxTokens: AUTHOR_MAX_TOKENS,
        timeoutMs: AUTHOR_TIMEOUT_MS,
        parse: (raw) =>
          tryParseJson(raw, (parsed) => {
            const result = outputSchema.safeParse(parsed);
            return result.success ? result.data : null;
          }),
        retryUserMessage: buildIntroBackgroundRetryMessage(),
        onFinalFailure: () =>
          new Error('Intro background response was not valid JSON after one retry'),
      });
    } catch (err) {
      logger.error('author_intro_background: structured completion failed', {
        agentId: context.agentId,
        model,
        provider: providerSlug,
        mode: args.mode,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'authoring_failed');
    }

    void logCost({
      ...(context.agentId ? { agentId: context.agentId } : {}),
      operation: CostOperation.CHAT,
      model,
      provider: providerSlug,
      inputTokens: completion.tokenUsage.input,
      outputTokens: completion.tokenUsage.output,
      metadata: { capability: SLUG, mode: args.mode },
    }).catch((err) => {
      logger.error('author_intro_background: logCost rejected', {
        agentId: context.agentId,
        error: errorMessage(err),
      });
    });

    const background = completion.value.background.trim().slice(0, INTRO_BACKGROUND_MAX_LENGTH);
    return this.success({ background });
  }
}
