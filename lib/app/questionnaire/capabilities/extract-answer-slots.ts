/**
 * Questionnaire answer-extractor capability (F4.2).
 *
 * A `BaseCapability` that turns one respondent message into typed answer values
 * for one or more slots — the active question plus any others the message also
 * answers (a *side-effect*). It runs a single **provider-agnostic** structured
 * LLM call via `runStructuredCompletion` (call → parse → retry-once-at-temp-0 →
 * cost-sum), validates the output against the F4.2 Zod contract, validates each
 * value against its slot's real type/config and normalises into version-agnostic
 * `AnswerSlotIntent`s, logs cost, and returns them. It does **not** persist — the
 * session/answer tables don't exist yet (F4.6), so the preview route returns the
 * intents and F4.6 will write them. Storage-agnostic and unit-testable by
 * `dispatch()` with a mocked provider.
 *
 * Boundary: lives under `lib/app/**`, so it imports no Prisma and no Next.js
 * (enforced by ESLint). Provider/model resolution is read from the dispatch
 * context (the route supplies the answer-extractor agent's binding); when absent
 * it falls back to an empty binding, which `resolveAgentProviderAndModel` fills
 * from the system default — the same dynamic-resolution contract every
 * system-seeded agent uses.
 *
 * PII: the respondent's message, the transcript, and prior answers are personal
 * data, so `processesPii = true` and `redactProvenance()` is overridden — the
 * registry refuses to register a PII capability otherwise.
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
import {
  assertModelSupportsAttachments,
  getProvider,
  type AttachmentCapability,
} from '@/lib/orchestration/llm/provider-manager';
import { ProviderError } from '@/lib/orchestration/llm/provider';
import { logCost } from '@/lib/orchestration/llm/cost-tracker';
import { chatAttachmentsArraySchema } from '@/lib/validations/orchestration';
import {
  runStructuredCompletion,
  tryParseJson,
  type StructuredCompletionResult,
} from '@/lib/orchestration/evaluations/parse-structured';

import {
  EXTRACT_ANSWER_SLOTS_CAPABILITY_SLUG,
  EXTRACT_ANSWER_SLOTS_FUNCTION_DEFINITION,
} from '@/lib/app/questionnaire/constants';
import { ANSWER_FIT_MODES, QUESTION_TYPES } from '@/lib/app/questionnaire/types';
import {
  validateAnswerExtraction,
  type AnswerExtraction,
} from '@/lib/app/questionnaire/extraction/extraction-schema';
import {
  buildAnswerExtractionPrompt,
  buildAnswerExtractionRetryMessage,
} from '@/lib/app/questionnaire/extraction/extraction-prompt';
import { normalizeAnswerIntents } from '@/lib/app/questionnaire/extraction/answer-intents';
import type {
  AnswerSlotIntent,
  DataSlotCandidateView,
  DataSlotFillIntent,
  ExtractionContext,
  ExtractionSlotView,
} from '@/lib/app/questionnaire/extraction/types';
import type { SensitivityAssessment } from '@/lib/app/questionnaire/sensitivity/types';

const SLUG = EXTRACT_ANSWER_SLOTS_CAPABILITY_SLUG;

/**
 * One respondent message answering a handful of slots is a small payload, far
 * smaller than a full ingest. Generous headroom for a reasoning model's internal
 * tokens while keeping the per-turn call snappy.
 */
const ANSWER_EXTRACTION_MAX_TOKENS = 4_000;

/**
 * A per-turn call must be snappy — a respondent is waiting. 30s covers a slow
 * model without hanging the conversation the way the 120s ingestion timeout would.
 */
const ANSWER_EXTRACTION_TIMEOUT_MS = 30_000;

/** Provenance preview cap (chars). The plan asks for a short, PII-safe preview. */
const PROVENANCE_PREVIEW_CAP = 200;

/**
 * Defensive ceiling on the candidate pool the route may pass. The route caps its
 * own input; this guards the capability when called directly (tests, CLI) so a
 * runaway list can't blow up the prompt.
 */
const MAX_CANDIDATE_SLOTS = 300;

/** A candidate slot as the route/caller supplies it (key-space; ids optional). */
const candidateSlotSchema = z.object({
  key: z.string().min(1),
  prompt: z.string(),
  type: z.enum(QUESTION_TYPES),
  typeConfig: z.unknown().optional(),
  guidelines: z.string().optional(),
  required: z.boolean().optional(),
  id: z.string().optional(),
  sectionId: z.string().optional(),
});

/** A data-slot candidate (Data Slots feature) the extractor also fills, addressed by key. */
const dataSlotCandidateSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  theme: z.string(),
  // Forward propagation: the question keys this slot captures (AppDataSlotQuestion). When filling
  // the slot, the extractor must ALSO answer these mapped questions (each is in `candidateSlots`).
  mappedQuestionKeys: z.array(z.string().min(1)).max(MAX_CANDIDATE_SLOTS).optional(),
  // What's already recorded for this slot this session (when any) so the extractor can update or
  // correct it rather than re-deriving from scratch. `value` is free-form (Json-shaped).
  current: z
    .object({
      value: z.unknown(),
      paraphrase: z.string().nullable(),
      confidence: z.number().min(0).max(1).nullable(),
    })
    .optional(),
  // Move-on (Data Slots feature): this slot has hit the re-ask cap and is about to be parked —
  // the extractor must best-effort-infer it. `attempts` is surfaced in the prompt's status line.
  parkPending: z.boolean().optional(),
  attempts: z.number().int().nonnegative().optional(),
});

const argsSchema = z
  .object({
    /** The respondent's message to extract from (this turn). */
    userMessage: z.string().min(1),
    /**
     * Key of the question being asked — must be one of `candidateSlots`. Omitted in DATA-SLOT
     * MODE, where the respondent is answering an open conversational prompt (a data slot) and
     * there is no single active question to privilege.
     */
    activeQuestionKey: z.string().min(1).optional(),
    /** The active slot plus the version's unanswered slots (may be empty in pure data-slot mode). */
    candidateSlots: z.array(candidateSlotSchema).max(MAX_CANDIDATE_SLOTS),
    /** Data Slots feature: the data slots to also fill this turn (omit for question-only mode). */
    dataSlotCandidates: z.array(dataSlotCandidateSchema).max(MAX_CANDIDATE_SLOTS).optional(),
    /** Already-answered state, so the extractor doesn't re-ask. */
    answered: z
      .array(
        z.object({ slotKey: z.string().min(1), confidence: z.number().min(0).max(1).nullable() })
      )
      .optional(),
    /** Recent transcript, oldest first. */
    recentMessages: z.array(z.string()).max(50).optional(),
    /** Files attached to this turn (images/documents) — read alongside the message. */
    attachments: chatAttachmentsArraySchema.optional(),
    /** Stable session identity, threaded into cost-log metadata. */
    sessionId: z.string().optional(),
    /**
     * Sensitivity awareness / safeguarding: when true, the prompt asks the extractor to ALSO flag
     * a genuine sensitive/contentious disclosure. The route sets this from the platform flag AND
     * the per-questionnaire toggle; off (default) adds no prompt text or behaviour.
     */
    sensitivityAware: z.boolean().optional(),
    /**
     * Semantic answer-fit resolver mode (per-questionnaire config). `off`/absent → single pass.
     * `fallback` → after the primary pass, run ONE focused follow-up over choice/likert questions
     * the respondent addressed but the value didn't map. `always` → also resolve still-unanswered
     * choice/likert questions. The follow-up reuses this same agent/model.
     */
    answerFitMode: z.enum(ANSWER_FIT_MODES).optional(),
  })
  // There must be something to extract into: question slots (question mode) and/or data slots
  // (data-slot mode). An empty call on both would be a no-op dispatch — reject it as malformed.
  .refine((v) => v.candidateSlots.length > 0 || (v.dataSlotCandidates?.length ?? 0) > 0, {
    message: 'at least one of candidateSlots or dataSlotCandidates must be non-empty',
    path: ['candidateSlots'],
  });

export type ExtractAnswerSlotsArgs = z.infer<typeof argsSchema>;

/** What the capability returns: the normalised answer-write intents for this turn. */
export interface ExtractAnswerSlotsData {
  intents: AnswerSlotIntent[];
  /**
   * Data Slots feature: the data-slot fills captured this turn. Present (possibly empty) when the
   * call carried data-slot candidates; omitted in question-only mode. Consumers read `?? []`.
   */
  dataSlotFills?: DataSlotFillIntent[];
  /**
   * How many of the model's reported answers the normaliser discarded (unknown
   * slot, value failed its type, duplicate). Surfaced so the preview route can
   * report it honestly — a non-zero count means the model produced more than
   * what's in `intents`.
   */
  droppedCount: number;
  /**
   * USD cost of this LLM call (summed input+output across the retry). Surfaced on the
   * data so the live turn loop can sum a turn's true spend for cost-cap enforcement
   * (F6.3) — the same figure already logged fire-and-forget to `AiCostLog`.
   */
  costUsd: number;
  /**
   * Seriousness gate — stage 1: the extractor's suspicion that this answer is non-genuine
   * (preposterous / abusive / off-topic). The orchestrator only pays for the dedicated judge
   * when this is `true`. Absent/`false` = no suspicion. `suspicionReason` is a short log note.
   */
  suspectedNonGenuine?: boolean;
  suspicionReason?: string;
  /**
   * Sensitivity awareness / safeguarding: the extractor's assessment of a sensitive/contentious
   * disclosure this turn, present only when one was detected (and `sensitivityAware` was set).
   * `summary` is a careful, non-graphic restatement — the orchestrator remembers it; it never
   * enters the provenance audit row, event metadata, or analytics.
   */
  sensitivity?: SensitivityAssessment;
  /**
   * Inspector (admin preview only): the answer-fit resolver's LLM call, present only when that
   * second pass actually ran this turn. The route's extractor invoker records it as a separate
   * trace so the recovery pass is no longer a blind spot. Plain shape (no inspector-type import) —
   * the invoker maps it onto an `AgentCallTrace`.
   */
  answerFitCall?: AnswerFitCallTrace;
}

/** The answer-fit resolver's LLM call, captured for the Turn Inspector. */
export interface AnswerFitCallTrace {
  model: string;
  provider: string;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  prompt: { role: string; content: string }[];
  response: string;
}

/**
 * Read the answer-extractor agent's resolvable binding from the dispatch context.
 * The preview route sets `entityContext.answerExtractorAgent` to the agent's
 * `{ provider, model, fallbackProviders }`; we validate defensively (never trust
 * the shape) and fall back to an empty binding so the capability still resolves
 * to the system default when called without it (tests, CLI).
 */
function readAnswerExtractorAgentBinding(
  entityContext: CapabilityContext['entityContext']
): ResolvableAgent {
  const raw = entityContext?.answerExtractorAgent;
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

/** Map the validated args onto the pure `ExtractionContext` the core reads. */
function toExtractionContext(args: ExtractAnswerSlotsArgs): ExtractionContext {
  const candidateSlots: ExtractionSlotView[] = args.candidateSlots.map((s) => ({
    key: s.key,
    type: s.type,
    typeConfig: s.typeConfig ?? null,
    prompt: s.prompt,
    required: s.required ?? false,
    ...(s.id !== undefined ? { id: s.id } : {}),
    ...(s.sectionId !== undefined ? { sectionId: s.sectionId } : {}),
    ...(s.guidelines !== undefined ? { guidelines: s.guidelines } : {}),
  }));

  return {
    activeQuestionKey: args.activeQuestionKey ?? null,
    candidateSlots,
    answered: args.answered ?? [],
    userMessage: args.userMessage,
    sessionId: args.sessionId ?? `dispatch-${args.activeQuestionKey ?? 'data-slot'}`,
    ...(args.sensitivityAware ? { sensitivityAware: true } : {}),
    ...(args.recentMessages ? { recentMessages: args.recentMessages } : {}),
    ...(args.attachments && args.attachments.length > 0 ? { attachments: args.attachments } : {}),
    ...(args.dataSlotCandidates && args.dataSlotCandidates.length > 0
      ? {
          dataSlotCandidates: args.dataSlotCandidates.map((c) => ({
            key: c.key,
            name: c.name,
            description: c.description,
            theme: c.theme,
            ...(c.mappedQuestionKeys && c.mappedQuestionKeys.length > 0
              ? { mappedQuestionKeys: c.mappedQuestionKeys }
              : {}),
            ...(c.current
              ? {
                  current: {
                    value: c.current.value,
                    paraphrase: c.current.paraphrase,
                    confidence: c.current.confidence,
                  },
                }
              : {}),
            ...(c.parkPending ? { parkPending: true, attempts: c.attempts ?? 1 } : {}),
          })),
        }
      : {}),
  };
}

/**
 * Normalise the model's data-slot fills (Data Slots feature): keep only fills addressing a known
 * candidate key, coercing the fields. No per-type value validation — a data slot is a free-form
 * semantic target, so the paraphrase + value pass through.
 */
function normalizeDataSlotFills(
  raw: AnswerExtraction['dataSlotFills'],
  candidates: DataSlotCandidateView[]
): DataSlotFillIntent[] {
  if (!raw || raw.length === 0) return [];
  const known = new Set(candidates.map((c) => c.key));
  const seen = new Set<string>();
  const out: DataSlotFillIntent[] = [];
  for (const fill of raw) {
    if (!known.has(fill.dataSlotKey) || seen.has(fill.dataSlotKey)) continue;
    seen.add(fill.dataSlotKey);
    out.push({
      dataSlotKey: fill.dataSlotKey,
      value: fill.value,
      paraphrase: fill.paraphrase,
      confidence: fill.confidence,
      provenance: fill.provenance,
      ...(fill.rationale !== undefined ? { rationale: fill.rationale } : {}),
    });
  }
  return out;
}

/** The attachment capabilities a turn's files require: vision for images, documents else. */
function requiredAttachmentCapabilities(
  attachments: ExtractAnswerSlotsArgs['attachments']
): AttachmentCapability[] {
  if (!attachments || attachments.length === 0) return [];
  const required = new Set<AttachmentCapability>();
  for (const att of attachments) {
    required.add(att.mediaType.startsWith('image/') ? 'vision' : 'documents');
  }
  return [...required];
}

export class AppExtractAnswerSlotsCapability extends BaseCapability<
  ExtractAnswerSlotsArgs,
  ExtractAnswerSlotsData
> {
  readonly slug = SLUG;
  readonly processesPii = true;

  // Shared with the AiCapability seed so the class and the DB row can't drift.
  // Source of truth lives in constants.ts.
  readonly functionDefinition = EXTRACT_ANSWER_SLOTS_FUNCTION_DEFINITION;

  protected readonly schema = argsSchema;

  /**
   * Args carry the respondent's message + transcript + prior answers (all PII);
   * the result carries extracted values + source quotes that echo it. Persist
   * only what's safe for a durable audit row: structural keys/counts. The LLM
   * never sees this redacted form — only the provenance record does.
   */
  redactProvenance(
    args: ExtractAnswerSlotsArgs,
    result: CapabilityResult<ExtractAnswerSlotsData>
  ): { args: unknown; resultPreview: string } {
    const safeArgs = {
      activeQuestionKey: args.activeQuestionKey ?? null,
      candidateSlotCount: args.candidateSlots.length,
      userMessage: redactedString('userMessage'),
      ...(args.recentMessages !== undefined
        ? { recentMessages: redactedString('recentMessages') }
        : {}),
      ...(args.answered !== undefined ? { answered: redactedString('answered') } : {}),
      ...(args.attachments !== undefined ? { attachmentCount: args.attachments.length } : {}),
      ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
    };

    let preview: string;
    if (result.success && result.data) {
      const { intents } = result.data;
      // Counts only — never the values / source quotes, which reproduce PII.
      const provenanceCounts: Record<string, number> = {};
      for (const intent of intents) {
        provenanceCounts[intent.provenance] = (provenanceCounts[intent.provenance] ?? 0) + 1;
      }
      const { sensitivity } = result.data;
      preview = JSON.stringify({
        success: true,
        data: {
          intentCount: intents.length,
          activeAnswerCount: intents.filter((i) => i.isActiveQuestion).length,
          sideEffectCount: intents.filter((i) => !i.isActiveQuestion).length,
          droppedCount: result.data.droppedCount,
          provenanceCounts,
          // Sensitivity awareness: severity + category only — NEVER the summary (it restates PII).
          ...(sensitivity
            ? { sensitivity: { severity: sensitivity.severity, category: sensitivity.category } }
            : {}),
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

  /**
   * Answer-fit resolver pass (Phase 3): a focused SECOND structured call over a small set of
   * choice/likert questions the respondent already addressed but the first pass couldn't map.
   * Reuses the already-resolved provider/model and the same prompt builder with `forceFit` framing.
   * A failure here NEVER fails the turn — the primary intents already stand — so it logs and yields
   * no intents. Drops `dataSlotCandidates` so the pass focuses purely on the question fit.
   */
  private async resolveAnswerFit(opts: {
    provider: Awaited<ReturnType<typeof getProvider>>;
    model: string;
    providerSlug: string;
    context: CapabilityContext;
    extractionContext: ExtractionContext;
    fitCandidates: ExtractionSlotView[];
  }): Promise<{ intents: AnswerSlotIntent[]; costUsd: number; call?: AnswerFitCallTrace }> {
    const { dataSlotCandidates: _omitDataSlots, ...rest } = opts.extractionContext;
    const fitContext: ExtractionContext = {
      ...rest,
      candidateSlots: opts.fitCandidates,
      forceFit: true,
    };
    const messages = buildAnswerExtractionPrompt(fitContext);

    let lastIssuePaths: string[] = [];
    let completion: StructuredCompletionResult<AnswerExtraction>;
    try {
      completion = await runStructuredCompletion<AnswerExtraction>({
        provider: opts.provider,
        model: opts.model,
        messages,
        maxTokens: ANSWER_EXTRACTION_MAX_TOKENS,
        timeoutMs: ANSWER_EXTRACTION_TIMEOUT_MS,
        parse: (raw) =>
          tryParseJson(raw, (parsed) => {
            const validation = validateAnswerExtraction(parsed);
            if (validation.ok) return validation.value;
            lastIssuePaths = validation.issues.map((issue) =>
              issue.path.length > 0 ? issue.path.join('.') : '(root)'
            );
            return null;
          }),
        retryUserMessage: buildAnswerExtractionRetryMessage([]),
        onFinalFailure: () =>
          new Error('Answer-fit resolution response was not valid against the schema after retry'),
      });
    } catch (err) {
      // Non-fatal: the primary pass already produced this turn's answers.
      logger.warn('extract_answer_slots: answer-fit pass failed (primary intents stand)', {
        agentId: opts.context.agentId,
        issuePaths: lastIssuePaths,
        error: errorMessage(err),
      });
      return { intents: [], costUsd: 0 };
    }

    void logCost({
      ...(opts.context.agentId ? { agentId: opts.context.agentId } : {}),
      operation: CostOperation.CHAT,
      model: opts.model,
      provider: opts.providerSlug,
      inputTokens: completion.tokenUsage.input,
      outputTokens: completion.tokenUsage.output,
      metadata: {
        capability: SLUG,
        appQuestionnaireSessionId: fitContext.sessionId,
        pass: 'answer_fit',
      },
    }).catch((err) => {
      logger.error('extract_answer_slots: answer-fit logCost rejected', {
        agentId: opts.context.agentId,
        error: errorMessage(err),
      });
    });

    const { intents } = normalizeAnswerIntents(completion.value.answers, fitContext);
    return {
      intents,
      costUsd: completion.costUsd,
      call: {
        model: opts.model,
        provider: opts.providerSlug,
        costUsd: completion.costUsd,
        tokensIn: completion.tokenUsage.input,
        tokensOut: completion.tokenUsage.output,
        prompt: messages.map((m) => ({
          role: m.role,
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        })),
        response: JSON.stringify(completion.value, null, 2),
      },
    };
  }

  async execute(
    args: ExtractAnswerSlotsArgs,
    context: CapabilityContext
  ): Promise<CapabilityResult<ExtractAnswerSlotsData>> {
    // 1. Resolve the provider/model binding (provider-agnostic). Empty binding →
    //    system default, the same path system-seeded agents take. Per-turn work
    //    resolves the `chat` tier, not the heavier `reasoning` tier ingestion uses.
    let providerSlug: string;
    let model: string;
    try {
      const resolved = await resolveAgentProviderAndModel(
        readAnswerExtractorAgentBinding(context.entityContext),
        'chat'
      );
      providerSlug = resolved.providerSlug;
      model = resolved.model;
    } catch (err) {
      logger.error('extract_answer_slots: no provider resolved', {
        agentId: context.agentId,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'no_provider_configured');
    }

    let provider: Awaited<ReturnType<typeof getProvider>>;
    try {
      provider = await getProvider(providerSlug);
    } catch (err) {
      logger.error('extract_answer_slots: provider unavailable', {
        agentId: context.agentId,
        providerSlug,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'provider_unavailable');
    }

    // 1b. Attachment capability gate — if the turn carries files, the resolved model
    //     must support the needed modality (vision / documents). A mismatch is a typed
    //     error (not a silent text-only extraction that would drop the attached answer).
    const requiredCaps = requiredAttachmentCapabilities(args.attachments);
    if (requiredCaps.length > 0) {
      try {
        await assertModelSupportsAttachments(providerSlug, model, requiredCaps);
      } catch (err) {
        if (err instanceof ProviderError && err.code === 'CAPABILITY_NOT_SUPPORTED') {
          logger.warn('extract_answer_slots: model lacks attachment capability', {
            agentId: context.agentId,
            providerSlug,
            model,
            requiredCaps,
          });
          return this.error(errorMessage(err), 'attachments_not_supported');
        }
        return this.error(errorMessage(err), 'attachment_capability_check_failed');
      }
    }

    // 2. Build the prompt from the pure context.
    const extractionContext = toExtractionContext(args);
    const messages = buildAnswerExtractionPrompt(extractionContext);

    // 3. Structured call (parse → retry-once-at-temp-0 → cost-sum). Capture the
    //    Zod issue paths of the most recent schema-invalid (but JSON-parseable)
    //    response so a failure can name WHICH fields were wrong. (As in the
    //    structure extractor: runStructuredCompletion fixes its retry message
    //    before the call, so the paths surface in the final error + logs only.)
    let lastIssuePaths: string[] = [];
    let completion: StructuredCompletionResult<AnswerExtraction>;
    try {
      completion = await runStructuredCompletion<AnswerExtraction>({
        provider,
        model,
        messages,
        maxTokens: ANSWER_EXTRACTION_MAX_TOKENS,
        timeoutMs: ANSWER_EXTRACTION_TIMEOUT_MS,
        parse: (raw) =>
          tryParseJson(raw, (parsed) => {
            const validation = validateAnswerExtraction(parsed);
            if (validation.ok) return validation.value;
            lastIssuePaths = validation.issues.map((issue) =>
              issue.path.length > 0 ? issue.path.join('.') : '(root)'
            );
            return null;
          }),
        retryUserMessage: buildAnswerExtractionRetryMessage([]),
        onFinalFailure: () =>
          new Error(
            'Answer-extraction response was not valid against the schema after one retry' +
              (lastIssuePaths.length > 0 ? ` (invalid at: ${lastIssuePaths.join(', ')})` : '')
          ),
      });
    } catch (err) {
      logger.error('extract_answer_slots: structured completion failed', {
        agentId: context.agentId,
        model,
        provider: providerSlug,
        issuePaths: lastIssuePaths,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'extraction_failed');
    }

    // 4. Cost — fire-and-forget. An accounting write must never fail the turn.
    void logCost({
      ...(context.agentId ? { agentId: context.agentId } : {}),
      operation: CostOperation.CHAT,
      model,
      provider: providerSlug,
      inputTokens: completion.tokenUsage.input,
      outputTokens: completion.tokenUsage.output,
      metadata: { capability: SLUG, appQuestionnaireSessionId: extractionContext.sessionId },
    }).catch((err) => {
      logger.error('extract_answer_slots: logCost rejected', {
        agentId: context.agentId,
        error: errorMessage(err),
      });
    });

    // 5. Validate each value against its slot + normalise into intents.
    const { intents, dropped } = normalizeAnswerIntents(
      completion.value.answers,
      extractionContext
    );
    if (dropped.length > 0) {
      logger.info('extract_answer_slots: dropped incoherent/invalid answers', {
        agentId: context.agentId,
        droppedCount: dropped.length,
      });
    }

    // 5b. Answer-fit resolver pass (Phase 3). When configured, run ONE focused follow-up that
    //     commits a clearly-given free-form answer to a choice/likert option/scale point the first
    //     pass couldn't map. `fallback` only targets questions the respondent addressed but were
    //     dropped as type-invalid; `always` also targets still-unanswered choice/likert questions.
    let fitIntents: AnswerSlotIntent[] = [];
    let fitCostUsd = 0;
    let fitCall: AnswerFitCallTrace | undefined;
    const fitMode = args.answerFitMode ?? 'off';
    if (fitMode !== 'off') {
      const answeredKeys = new Set(intents.map((i) => i.slotKey));
      const droppedUnmappedKeys = new Set(
        dropped.filter((d) => d.reason.startsWith('value invalid for type')).map((d) => d.slotKey)
      );
      const fitCandidates = extractionContext.candidateSlots.filter(
        (s) =>
          (s.type === 'single_choice' || s.type === 'multi_choice' || s.type === 'likert') &&
          !answeredKeys.has(s.key) &&
          (fitMode === 'always' || droppedUnmappedKeys.has(s.key))
      );
      if (fitCandidates.length > 0) {
        const fit = await this.resolveAnswerFit({
          provider,
          model,
          providerSlug,
          context,
          extractionContext,
          fitCandidates,
        });
        // Only adopt a resolved value for a slot the primary pass didn't already answer.
        fitIntents = fit.intents.filter((i) => !answeredKeys.has(i.slotKey));
        fitCostUsd = fit.costUsd;
        fitCall = fit.call;
        if (fitIntents.length > 0) {
          logger.info('extract_answer_slots: answer-fit resolver recovered answers', {
            agentId: context.agentId,
            mode: fitMode,
            candidates: fitCandidates.length,
            resolved: fitIntents.length,
          });
        }
      }
    }

    const dataSlotFills = normalizeDataSlotFills(
      completion.value.dataSlotFills,
      args.dataSlotCandidates ?? []
    );

    // Data Slots feature: when the turn carried data-slot candidates, record how the model's fills
    // fared — how many it returned vs how many survived `normalizeDataSlotFills`. An empty/under-
    // filled result is why the "What we're learning" panel can stay "Not covered yet" despite a rich
    // answer; logging the model-returned vs kept counts (and any dropped/unknown keys — these are
    // config slugs, not PII) makes "the extractor didn't emit fills" vs "the keys didn't match"
    // diagnosable from the dev log without re-running blind.
    if ((args.dataSlotCandidates?.length ?? 0) > 0) {
      const returned = completion.value.dataSlotFills ?? [];
      const candidateKeys = new Set((args.dataSlotCandidates ?? []).map((c) => c.key));
      const droppedKeys = returned.map((f) => f.dataSlotKey).filter((k) => !candidateKeys.has(k));
      logger.info('extract_answer_slots: data-slot fills', {
        agentId: context.agentId,
        sessionId: extractionContext.sessionId,
        candidateCount: args.dataSlotCandidates?.length ?? 0,
        modelReturnedCount: returned.length,
        keptCount: dataSlotFills.length,
        ...(droppedKeys.length > 0 ? { droppedUnknownKeys: droppedKeys } : {}),
      });
    }

    return this.success({
      intents: [...intents, ...fitIntents],
      dataSlotFills,
      droppedCount: dropped.length,
      costUsd: completion.costUsd + fitCostUsd,
      // Inspector (admin preview): surface the answer-fit pass as its own trace when it ran.
      ...(fitCall ? { answerFitCall: fitCall } : {}),
      // Stage 1 of the seriousness gate — pass the model's suspicion flag through (when set).
      ...(completion.value.suspectedNonGenuine !== undefined
        ? { suspectedNonGenuine: completion.value.suspectedNonGenuine }
        : {}),
      ...(completion.value.suspicionReason !== undefined
        ? { suspicionReason: completion.value.suspicionReason }
        : {}),
      // Sensitivity awareness — pass the disclosure assessment through (when detected).
      ...(completion.value.sensitivity !== undefined
        ? { sensitivity: completion.value.sensitivity }
        : {}),
    });
  }
}
