/**
 * Questionnaire contradiction-detector capability (F4.3).
 *
 * A `BaseCapability` that compares a respondent's captured answers across slots and
 * reports genuine logical contradictions — **surfacing** them for the agent to
 * confirm, never overwriting an answer. It runs a single **provider-agnostic**
 * structured LLM call via `runStructuredCompletion` (call → parse →
 * retry-once-at-temp-0 → cost-sum), validates the output against the F4.3 Zod
 * contract, normalises into coherent {@link ContradictionFinding}s (drop unknown/
 * unanswered slots, dedupe symmetric pairs, mode-shape probe vs flag), logs cost,
 * and returns them. It does **not** persist or resolve anything — resolution is
 * F4.4, persistence is F4.6. Storage-agnostic and unit-testable by `dispatch()`
 * with a mocked provider.
 *
 * Boundary: lives under `lib/app/**`, so it imports no Prisma and no Next.js
 * (enforced by ESLint). Provider/model resolution is read from the dispatch
 * context (the route supplies the detector agent's binding); when absent it falls
 * back to an empty binding, which `resolveAgentProviderAndModel` fills from the
 * system default — the same dynamic-resolution contract every system-seeded agent
 * uses.
 *
 * PII: the respondent's answers (and any probe echoing them) are personal data, so
 * `processesPii = true` and `redactProvenance()` is overridden to a counts-only
 * preview — the registry refuses to register a PII capability otherwise.
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
  DETECT_CONTRADICTIONS_CAPABILITY_SLUG,
  DETECT_CONTRADICTIONS_FUNCTION_DEFINITION,
} from '@/lib/app/questionnaire/constants';
import {
  ANSWER_PROVENANCES,
  CONTRADICTION_MODES,
  QUESTION_TYPES,
} from '@/lib/app/questionnaire/types';
import {
  validateContradictionDetection,
  type ContradictionDetection,
} from '@/lib/app/questionnaire/contradiction/detection-schema';
import {
  buildContradictionDetectionPrompt,
  buildContradictionDetectionRetryMessage,
} from '@/lib/app/questionnaire/contradiction/detection-prompt';
import {
  normalizeContradictionFindings,
  summarizeFindings,
} from '@/lib/app/questionnaire/contradiction/detection-logic';
import type {
  AnsweredSlotView,
  ContradictionContext,
  ContradictionFinding,
  ContradictionSlotView,
} from '@/lib/app/questionnaire/contradiction/types';

const SLUG = DETECT_CONTRADICTIONS_CAPABILITY_SLUG;

/**
 * The answer set for one pass is a small payload (a handful of slots + values).
 * Generous headroom for a reasoning model's internal tokens while keeping the call
 * snappy — the same ceiling as answer extraction.
 */
const CONTRADICTION_MAX_TOKENS = 4_000;

/** A detection pass can run mid-conversation; 30s covers a slow model without hanging. */
const CONTRADICTION_TIMEOUT_MS = 30_000;

/** Provenance preview cap (chars) — a short, PII-safe preview. */
const PROVENANCE_PREVIEW_CAP = 200;

/**
 * Ceilings on the input. Exported so the preview route can align its own body
 * schema to the same numbers — otherwise a request the route accepts (its body cap)
 * but the capability rejects (these caps) fails *soft* mid-dispatch, surfacing a
 * confusing empty "no contradictions" result instead of a clean 400. They also
 * guard the capability when called directly (tests, CLI) so a runaway list can't
 * blow up the prompt.
 */
export const MAX_CONTRADICTION_SLOTS = 300;
export const MAX_CONTRADICTION_ANSWERS = 300;

/** A slot definition as the route/caller supplies it (key-space; ids optional). */
const slotSchema = z.object({
  key: z.string().min(1),
  prompt: z.string(),
  type: z.enum(QUESTION_TYPES),
  typeConfig: z.unknown().optional(),
  guidelines: z.string().optional(),
  required: z.boolean().optional(),
  id: z.string().optional(),
  sectionId: z.string().optional(),
});

/** One captured answer the detector compares. */
const answerSchema = z.object({
  slotKey: z.string().min(1),
  value: z.unknown(),
  confidence: z.number().min(0).max(1).nullable().optional(),
  provenance: z.enum(ANSWER_PROVENANCES).optional(),
  turnIndex: z.number().int().optional(),
});

const argsSchema = z.object({
  /** The version slot definitions to reason over. */
  slots: z.array(slotSchema).min(1).max(MAX_CONTRADICTION_SLOTS),
  /** The captured answers to compare — need at least two to have a contradiction. */
  answers: z.array(answerSchema).min(2).max(MAX_CONTRADICTION_ANSWERS),
  /** Behaviour on a hit: off | flag | probe. */
  mode: z.enum(CONTRADICTION_MODES),
  /** How many prior answers to compare against; 0 = all. */
  windowN: z.number().int().min(0).default(0),
  /** Stable session identity, threaded into cost-log metadata. */
  sessionId: z.string().optional(),
});

export type DetectContradictionsArgs = z.infer<typeof argsSchema>;

/** What the capability returns: the normalised contradiction findings for this pass. */
export interface DetectContradictionsData {
  findings: ContradictionFinding[];
  /**
   * How many of the model's reported contradictions the normaliser discarded
   * (unknown/unanswered slot, fewer than two distinct slots, duplicate pair).
   * Surfaced so the preview route can report it honestly.
   */
  droppedCount: number;
  /**
   * USD cost of this LLM call — surfaced so the live turn loop can sum a turn's true
   * spend for cost-cap enforcement (F6.3); mirrors the figure logged to `AiCostLog`.
   */
  costUsd: number;
}

/**
 * Read the detector agent's resolvable binding from the dispatch context. The
 * preview route sets `entityContext.contradictionDetectorAgent` to the agent's
 * `{ provider, model, fallbackProviders }`; we validate defensively (never trust
 * the shape) and fall back to an empty binding so the capability still resolves to
 * the system default when called without it (tests, CLI).
 */
function readDetectorAgentBinding(
  entityContext: CapabilityContext['entityContext']
): ResolvableAgent {
  const raw = entityContext?.contradictionDetectorAgent;
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

/** Map the validated args onto the pure `ContradictionContext` the core reads. */
function toContradictionContext(args: DetectContradictionsArgs): ContradictionContext {
  const slots: ContradictionSlotView[] = args.slots.map((s) => ({
    key: s.key,
    type: s.type,
    typeConfig: s.typeConfig ?? null,
    prompt: s.prompt,
    required: s.required ?? false,
    ...(s.id !== undefined ? { id: s.id } : {}),
    ...(s.sectionId !== undefined ? { sectionId: s.sectionId } : {}),
    ...(s.guidelines !== undefined ? { guidelines: s.guidelines } : {}),
  }));

  const answers: AnsweredSlotView[] = args.answers.map((a) => ({
    slotKey: a.slotKey,
    value: a.value,
    confidence: a.confidence ?? null,
    ...(a.provenance !== undefined ? { provenance: a.provenance } : {}),
    ...(a.turnIndex !== undefined ? { turnIndex: a.turnIndex } : {}),
  }));

  return {
    slots,
    answers,
    mode: args.mode,
    windowN: args.windowN,
    // The route always supplies a real session id (`preview-<versionId>`); this
    // constant only labels direct/CLI dispatches in cost-log metadata.
    sessionId: args.sessionId ?? 'dispatch-detect',
  };
}

export class AppDetectContradictionsCapability extends BaseCapability<
  DetectContradictionsArgs,
  DetectContradictionsData
> {
  readonly slug = SLUG;
  readonly processesPii = true;

  // Shared with the AiCapability seed so the class and the DB row can't drift.
  // Source of truth lives in constants.ts.
  readonly functionDefinition = DETECT_CONTRADICTIONS_FUNCTION_DEFINITION;

  protected readonly schema = argsSchema;

  /**
   * Args carry the respondent's answers (PII); the result carries explanations +
   * probes that echo them. Persist only what's safe for a durable audit row:
   * structural keys/counts. The LLM never sees this redacted form — only the
   * provenance record does.
   */
  redactProvenance(
    args: DetectContradictionsArgs,
    result: CapabilityResult<DetectContradictionsData>
  ): { args: unknown; resultPreview: string } {
    const safeArgs = {
      slotCount: args.slots.length,
      answerCount: args.answers.length,
      mode: args.mode,
      windowN: args.windowN,
      answers: redactedString('answers'),
      ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
    };

    let preview: string;
    if (result.success && result.data) {
      // Counts only — never explanations / probes / values, which reproduce PII.
      // The same roll-up the preview route returns, so the two can't drift.
      preview = JSON.stringify({
        success: true,
        data: summarizeFindings(result.data.findings, result.data.droppedCount),
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
    args: DetectContradictionsArgs,
    context: CapabilityContext
  ): Promise<CapabilityResult<DetectContradictionsData>> {
    // 1. Resolve the provider/model binding (provider-agnostic). Empty binding →
    //    system default. Detection is per-turn-ish work → the `chat` tier.
    let providerSlug: string;
    let model: string;
    try {
      const resolved = await resolveAgentProviderAndModel(
        readDetectorAgentBinding(context.entityContext),
        'chat'
      );
      providerSlug = resolved.providerSlug;
      model = resolved.model;
    } catch (err) {
      logger.error('detect_contradictions: no provider resolved', {
        agentId: context.agentId,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'no_provider_configured');
    }

    let provider: Awaited<ReturnType<typeof getProvider>>;
    try {
      provider = await getProvider(providerSlug);
    } catch (err) {
      logger.error('detect_contradictions: provider unavailable', {
        agentId: context.agentId,
        providerSlug,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'provider_unavailable');
    }

    // 2. Build the prompt from the pure context.
    const detectionContext = toContradictionContext(args);
    const messages = buildContradictionDetectionPrompt(detectionContext);

    // 3. Structured call (parse → retry-once-at-temp-0 → cost-sum). Capture the Zod
    //    issue paths of the most recent schema-invalid (but JSON-parseable) response
    //    so a failure can name WHICH fields were wrong.
    let lastIssuePaths: string[] = [];
    let completion: StructuredCompletionResult<ContradictionDetection>;
    try {
      completion = await runStructuredCompletion<ContradictionDetection>({
        provider,
        model,
        messages,
        maxTokens: CONTRADICTION_MAX_TOKENS,
        timeoutMs: CONTRADICTION_TIMEOUT_MS,
        parse: (raw) =>
          tryParseJson(raw, (parsed) => {
            const validation = validateContradictionDetection(parsed);
            if (validation.ok) return validation.value;
            lastIssuePaths = validation.issues.map((issue) =>
              issue.path.length > 0 ? issue.path.join('.') : '(root)'
            );
            return null;
          }),
        retryUserMessage: buildContradictionDetectionRetryMessage([]),
        onFinalFailure: () =>
          new Error(
            'Contradiction-detection response was not valid against the schema after one retry' +
              (lastIssuePaths.length > 0 ? ` (invalid at: ${lastIssuePaths.join(', ')})` : '')
          ),
      });
    } catch (err) {
      logger.error('detect_contradictions: structured completion failed', {
        agentId: context.agentId,
        model,
        provider: providerSlug,
        issuePaths: lastIssuePaths,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'detection_failed');
    }

    // 4. Cost — fire-and-forget. An accounting write must never fail the pass.
    void logCost({
      ...(context.agentId ? { agentId: context.agentId } : {}),
      operation: CostOperation.CHAT,
      model,
      provider: providerSlug,
      inputTokens: completion.tokenUsage.input,
      outputTokens: completion.tokenUsage.output,
      metadata: { capability: SLUG, appQuestionnaireSessionId: detectionContext.sessionId },
    }).catch((err) => {
      logger.error('detect_contradictions: logCost rejected', {
        agentId: context.agentId,
        error: errorMessage(err),
      });
    });

    // 5. Normalise into coherent findings (drop unknown/unanswered, dedupe, shape).
    const { findings, dropped } = normalizeContradictionFindings(
      completion.value.contradictions,
      detectionContext
    );
    if (dropped.length > 0) {
      logger.info('detect_contradictions: dropped incoherent findings', {
        agentId: context.agentId,
        droppedCount: dropped.length,
      });
    }

    return this.success({ findings, droppedCount: dropped.length, costUsd: completion.costUsd });
  }
}
