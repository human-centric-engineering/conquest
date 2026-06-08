/**
 * Questionnaire completion-offer composer capability (F4.5).
 *
 * A `BaseCapability` that phrases the offer-to-submit message once the deterministic
 * gate (`assessCompletion`) has decided the questionnaire is done enough. It runs a
 * single **provider-agnostic** structured LLM call via `runStructuredCompletion`
 * (call → parse → retry-once-at-temp-0 → cost-sum), validates the output against the
 * F4.5 Zod contract, logs cost, and returns the {@link CompletionOffer}.
 *
 * Crucially it does **not** decide *whether* to offer — the route only dispatches it
 * when the assessment is already `offer`, so the deterministic gate (including the
 * required-questions block) stays authoritative. The LLM only composes the wording.
 * It persists nothing; the session transition is the route's job (F4.4 seam).
 *
 * Boundary: lives under `lib/app/**`, so it imports no Prisma and no Next.js
 * (enforced by ESLint). Provider/model resolution is read from the dispatch context
 * (the route supplies the completion agent's binding); when absent it falls back to
 * an empty binding, which `resolveAgentProviderAndModel` fills from the system
 * default — the same dynamic-resolution contract every system-seeded agent uses.
 *
 * PII: the recap echoes the questionnaire's question prompts and the respondent's
 * recent messages (personal data), so `processesPii = true` and `redactProvenance()`
 * is overridden to a counts-only preview — the registry refuses to register a PII
 * capability otherwise.
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
import {
  runStructuredCompletion,
  tryParseJson,
  type StructuredCompletionResult,
} from '@/lib/orchestration/evaluations/parse-structured';

import {
  COMPOSE_COMPLETION_OFFER_CAPABILITY_SLUG,
  COMPOSE_COMPLETION_OFFER_FUNCTION_DEFINITION,
} from '@/lib/app/questionnaire/constants';
import {
  validateCompletionOffer,
  type CompletionOfferOutput,
} from '@/lib/app/questionnaire/completion/completion-schema';
import {
  buildCompletionOfferPrompt,
  buildCompletionOfferRetryMessage,
  type CompletionOfferPromptInput,
} from '@/lib/app/questionnaire/completion/completion-prompt';
import type { CompletionOffer } from '@/lib/app/questionnaire/completion/types';

const SLUG = COMPOSE_COMPLETION_OFFER_CAPABILITY_SLUG;

/**
 * Composing one short offer message is a small generation. Generous headroom for a
 * model's internal tokens while keeping the call snappy — the same ceiling band as
 * the detector/extractor.
 */
const COMPLETION_OFFER_MAX_TOKENS = 1_500;

/** The offer composer runs at wrap-up; 30s covers a slow model without hanging. */
const COMPLETION_OFFER_TIMEOUT_MS = 30_000;

/** Provenance preview cap (chars) — a short, PII-safe preview. */
const PROVENANCE_PREVIEW_CAP = 200;

/**
 * Ceilings on the recap lists. Exported so the route can align its body schema to the
 * same numbers — otherwise a request the route accepts but the capability rejects
 * fails *soft* mid-dispatch. They also guard the capability when called directly
 * (tests, CLI) so a runaway list can't blow up the prompt.
 */
export const MAX_COMPLETION_COVERED_SLOTS = 500;
export const MAX_COMPLETION_REMAINING_SLOTS = 500;
export const MAX_COMPLETION_RECENT_MESSAGES = 50;

/** A question identified for the recap — prompts only, no respondent values. */
const promptSlotSchema = z.object({
  key: z.string().min(1),
  prompt: z.string(),
});

const argsSchema = z.object({
  /** Weighted coverage in [0, 1] at offer time. */
  coverage: z.number().min(0).max(1),
  /** Distinct questions answered this session. */
  answeredCount: z.number().int().min(0),
  /** Whether the per-session cap forced the offer (vs. thresholds being met). */
  capReached: z.boolean(),
  /** The answered questions to recap. */
  coveredSlots: z.array(promptSlotSchema).max(MAX_COMPLETION_COVERED_SLOTS),
  /** Optional questions still open. */
  remainingSlots: z.array(promptSlotSchema).max(MAX_COMPLETION_REMAINING_SLOTS).default([]),
  /** Recent user messages, oldest → newest, to match tone. */
  recentMessages: z.array(z.string()).max(MAX_COMPLETION_RECENT_MESSAGES).default([]),
  /** Stable session identity, threaded into cost-log metadata. */
  sessionId: z.string().optional(),
});

export type ComposeCompletionOfferArgs = z.infer<typeof argsSchema>;

/** What the capability returns: the composed offer for this pass. */
export interface ComposeCompletionOfferData {
  offer: CompletionOffer;
}

/**
 * Read the completion agent's resolvable binding from the dispatch context. The
 * route sets `entityContext.completionAgent` to the agent's
 * `{ provider, model, fallbackProviders }`; we validate defensively (never trust the
 * shape) and fall back to an empty binding so the capability still resolves to the
 * system default when called without it (tests, CLI).
 */
function readCompletionAgentBinding(
  entityContext: CapabilityContext['entityContext']
): ResolvableAgent {
  const raw = entityContext?.completionAgent;
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

/** Narrow an unknown thrown value to a log-safe message string. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Map the validated args onto the pure prompt input the builder reads. */
function toPromptInput(args: ComposeCompletionOfferArgs): CompletionOfferPromptInput {
  return {
    coverage: args.coverage,
    answeredCount: args.answeredCount,
    capReached: args.capReached,
    coveredSlots: args.coveredSlots,
    remainingSlots: args.remainingSlots,
    recentMessages: args.recentMessages,
  };
}

export class AppComposeCompletionOfferCapability extends BaseCapability<
  ComposeCompletionOfferArgs,
  ComposeCompletionOfferData
> {
  readonly slug = SLUG;
  readonly processesPii = true;

  // Shared with the AiCapability seed so the class and the DB row can't drift.
  // Source of truth lives in constants.ts.
  readonly functionDefinition = COMPOSE_COMPLETION_OFFER_FUNCTION_DEFINITION;

  protected readonly schema = argsSchema;

  /**
   * Args carry the question prompts + the respondent's recent messages (PII); the
   * result is a message that recaps them. Persist only what's safe for a durable
   * audit row: structural counts. The LLM never sees this redacted form — only the
   * provenance record does.
   */
  redactProvenance(
    args: ComposeCompletionOfferArgs,
    result: CapabilityResult<ComposeCompletionOfferData>
  ): { args: unknown; resultPreview: string } {
    const safeArgs = {
      coverage: args.coverage,
      answeredCount: args.answeredCount,
      capReached: args.capReached,
      coveredSlotCount: args.coveredSlots.length,
      remainingSlotCount: args.remainingSlots.length,
      recentMessageCount: args.recentMessages.length,
      recentMessages: redactedString('recentMessages'),
      ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
    };

    let preview: string;
    if (result.success && result.data) {
      // Counts/flags only — never the offer text, which reproduces PII from the recap.
      preview = JSON.stringify({
        success: true,
        data: {
          hasOffer: result.data.offer.offerMessage.length > 0,
          hasRemainingNote: typeof result.data.offer.remainingNote === 'string',
        },
      });
    } else {
      // Error envelope is { success: false, error: { code, message } } — no PII.
      preview = JSON.stringify(result);
    }
    if (preview.length > PROVENANCE_PREVIEW_CAP) {
      preview = preview.slice(0, PROVENANCE_PREVIEW_CAP - 1) + '…';
    }

    return { args: safeArgs, resultPreview: preview };
  }

  async execute(
    args: ComposeCompletionOfferArgs,
    context: CapabilityContext
  ): Promise<CapabilityResult<ComposeCompletionOfferData>> {
    // 1. Resolve the provider/model binding (provider-agnostic). Empty binding →
    //    system default. Phrasing a wrap-up message is snappy → the `chat` tier.
    let providerSlug: string;
    let model: string;
    try {
      const resolved = await resolveAgentProviderAndModel(
        readCompletionAgentBinding(context.entityContext),
        'chat'
      );
      providerSlug = resolved.providerSlug;
      model = resolved.model;
    } catch (err) {
      logger.error('compose_completion_offer: no provider resolved', {
        agentId: context.agentId,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'no_provider_configured');
    }

    let provider: Awaited<ReturnType<typeof getProvider>>;
    try {
      provider = await getProvider(providerSlug);
    } catch (err) {
      logger.error('compose_completion_offer: provider unavailable', {
        agentId: context.agentId,
        providerSlug,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'provider_unavailable');
    }

    // 2. Build the prompt from the validated args.
    const messages = buildCompletionOfferPrompt(toPromptInput(args));

    // 3. Structured call (parse → retry-once-at-temp-0 → cost-sum). Capture the Zod
    //    issue paths of the most recent schema-invalid (but JSON-parseable) response
    //    so a failure can name WHICH fields were wrong.
    let lastIssuePaths: string[] = [];
    let completion: StructuredCompletionResult<CompletionOfferOutput>;
    try {
      completion = await runStructuredCompletion<CompletionOfferOutput>({
        provider,
        model,
        messages,
        maxTokens: COMPLETION_OFFER_MAX_TOKENS,
        timeoutMs: COMPLETION_OFFER_TIMEOUT_MS,
        parse: (raw) =>
          tryParseJson(raw, (parsed) => {
            const validation = validateCompletionOffer(parsed);
            if (validation.ok) return validation.value;
            lastIssuePaths = validation.issues.map((issue) =>
              issue.path.length > 0 ? issue.path.join('.') : '(root)'
            );
            return null;
          }),
        retryUserMessage: buildCompletionOfferRetryMessage([]),
        onFinalFailure: () =>
          new Error(
            'Completion-offer response was not valid against the schema after one retry' +
              (lastIssuePaths.length > 0 ? ` (invalid at: ${lastIssuePaths.join(', ')})` : '')
          ),
      });
    } catch (err) {
      logger.error('compose_completion_offer: structured completion failed', {
        agentId: context.agentId,
        model,
        provider: providerSlug,
        issuePaths: lastIssuePaths,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'composition_failed');
    }

    // 4. Cost — fire-and-forget. An accounting write must never fail the pass.
    void logCost({
      ...(context.agentId ? { agentId: context.agentId } : {}),
      operation: CostOperation.CHAT,
      model,
      provider: providerSlug,
      inputTokens: completion.tokenUsage.input,
      outputTokens: completion.tokenUsage.output,
      metadata: {
        capability: SLUG,
        ...(args.sessionId ? { appQuestionnaireSessionId: args.sessionId } : {}),
      },
    }).catch((err) => {
      logger.error('compose_completion_offer: logCost rejected', {
        agentId: context.agentId,
        error: errorMessage(err),
      });
    });

    // 5. Shape the validated output into the CompletionOffer.
    const offer: CompletionOffer = {
      offerMessage: completion.value.offerMessage,
      coveredSummary: completion.value.coveredSummary,
      ...(completion.value.remainingNote !== undefined
        ? { remainingNote: completion.value.remainingNote }
        : {}),
    };

    return this.success({ offer });
  }
}
