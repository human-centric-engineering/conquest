/**
 * Real {@link CapabilityInvokers} for the live turn loop (F6.1, PR4).
 *
 * The impure boundary the pure orchestrator injects: each invoker maps the in-memory
 * {@link TurnState} onto a P4 capability's args, dispatches it through the shared
 * `capabilityDispatcher` (the preview-route path), and maps the result back fail-soft — a
 * capability failure becomes an empty outcome + a `diagnostic`, never a throw, so a single
 * failing step doesn't crash the turn. Selection runs the pure F4.1 strategy directly
 * (degrading adaptive → weighted for non-`adaptive` versions). The completion-offer prose is
 * NOT an invoker — the route renders it (PR4 via the capability, PR5 streamed).
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { CostOperation } from '@/types/orchestration';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import { registerBuiltInCapabilities } from '@/lib/orchestration/capabilities';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { logCost } from '@/lib/orchestration/llm/cost-tracker';
import { getTextContent, type LlmMessage } from '@/lib/orchestration/llm/types';
import { tryParseJson } from '@/lib/orchestration/evaluations/parse-structured';
import { runStructuredCompletion } from '@/lib/orchestration/llm/structured-completion';
import {
  DETECT_CONTRADICTIONS_CAPABILITY_SLUG,
  EXTRACT_ANSWER_SLOTS_CAPABILITY_SLUG,
  QUESTIONNAIRE_ANSWER_EXTRACTOR_AGENT_SLUG,
  QUESTIONNAIRE_ANSWER_REFINER_AGENT_SLUG,
  QUESTIONNAIRE_CONTRADICTION_DETECTOR_AGENT_SLUG,
  REFINE_ANSWER_CAPABILITY_SLUG,
} from '@/lib/app/questionnaire/constants';
import {
  ASSESS_SERIOUSNESS_TOOL_SLUG,
  DETECT_SENSITIVITY_TOOL_SLUG,
} from '@/lib/app/questionnaire/orchestrator';
import {
  buildSeriousnessJudgePrompt,
  validateSeriousnessVerdict,
  type SeriousnessVerdictRaw,
} from '@/lib/app/questionnaire/seriousness';
import {
  buildSensitivityDetectPrompt,
  validateSensitivityDetectVerdict,
  normalizeSensitivityVerdict,
  type SensitivityDetectVerdictRaw,
} from '@/lib/app/questionnaire/sensitivity';
import {
  getStrategy,
  type SelectionContext,
  type StrategyDeps,
} from '@/lib/app/questionnaire/selection';
import type { AnswerFitMode } from '@/lib/app/questionnaire/types';
import type {
  CapabilityInvokers,
  DataSlotSelectOutcome,
  DetectOutcome,
  ExtractOutcome,
  RefineOutcome,
  SelectOutcome,
  SeriousnessOutcome,
  SensitivityDetectOutcome,
} from '@/lib/app/questionnaire/orchestrator';
import type {
  DetectContradictionsData,
  ExtractAnswerSlotsData,
  RefineAnswerData,
} from '@/lib/app/questionnaire/capabilities';
import { buildAdaptiveDeps } from '@/app/api/v1/app/questionnaires/_lib/adaptive-deps';
import { selectNextDataSlot } from '@/app/api/v1/app/questionnaire-sessions/_lib/data-slot-selection';
import type { CapabilitySlotView } from '@/app/api/v1/app/questionnaires/_lib/turn-context';
import type { AgentCallTrace, RecordAgentCall } from '@/lib/app/questionnaire/inspector';

/** Render a dispatched capability's structured args as a single readable `input` "message". */
function argsAsPrompt(args: unknown): AgentCallTrace['prompt'] {
  return [{ role: 'input', content: JSON.stringify(args, null, 2) }];
}

/** A resolved agent binding (provider/model) for a capability's `entityContext`. */
interface AgentBinding {
  id: string;
  provider: string;
  model: string;
  fallbackProviders: string[];
}

/** Map our slot view onto the shape the P4 capabilities accept (incl. optional config). */
function toCapabilitySlot(slot: CapabilitySlotView): Record<string, unknown> {
  return {
    id: slot.id,
    key: slot.key,
    sectionId: slot.sectionId,
    prompt: slot.prompt,
    type: slot.type,
    required: slot.required,
    ...(slot.typeConfig !== undefined ? { typeConfig: slot.typeConfig } : {}),
    ...(slot.guidelines !== undefined ? { guidelines: slot.guidelines } : {}),
    // Free-text comment fields: the slot's current living paraphrase, so the extractor builds on it.
    ...(slot.currentParaphrase != null ? { currentParaphrase: slot.currentParaphrase } : {}),
  };
}

/** Load a seeded capability agent's binding by slug, or null when not seeded. */
async function loadBinding(slug: string): Promise<AgentBinding | null> {
  const agent = await prisma.aiAgent.findUnique({
    where: { slug },
    select: { id: true, provider: true, model: true, fallbackProviders: true },
  });
  return agent;
}

/**
 * The transcript the per-turn similarity ranking / selection should rank against: the persisted
 * recent messages PLUS the answer the respondent just sent THIS turn.
 *
 * `state.recentMessages` is built from *persisted* turns, so its last entry is the interviewer's
 * previous QUESTION, not the respondent's current ANSWER (which lives in `state.userMessage`). The
 * adaptive selectors embed the last entry as their similarity query — so without this they rank by
 * what was ASKED, not what the respondent just SAID, which drops answer-relevant candidates for any
 * volunteered or cross-topic content. Appending the current answer makes "what they just said" the
 * query and the latest line in the selector's transcript. Empty (kickoff) → unchanged.
 */
function conversationWithCurrentAnswer(state: {
  userMessage: string;
  recentMessages: string[];
}): string[] {
  return state.userMessage.trim().length > 0
    ? [...state.recentMessages, state.userMessage]
    : state.recentMessages;
}

/** Build the live invokers, loading the capability agent bindings once up front. */
export async function buildTurnInvokers(opts: {
  userId: string;
  slots: CapabilitySlotView[];
  /**
   * Extraction candidate pre-filter: when provided, the EXTRACTOR sees this narrowed question-slot
   * set instead of the full `slots` — cutting per-turn prompt cost at scale. Everything else
   * (contradiction detector, refiner, active-prompt lookups) still uses the full `slots`, so their
   * coverage is unchanged. Absent → the extractor uses the full `slots` (today's behaviour). The
   * route assembles it via `narrowExtractionCandidates`.
   */
  extractionCandidateSlots?: CapabilitySlotView[];
  activeQuestionKey: string | null;
  /**
   * Data Slots feature: when true, wire the adaptive data-slot `selectDataSlot` invoker (embedding
   * pre-filter + LLM selector). The route sets it from adaptive data-slot mode being active AND
   * data-slot mode being active. When false/absent, the invoker is omitted and the data-slot
   * orchestrator keeps its deterministic topic-local pick.
   */
  dataSlotAdaptiveEnabled?: boolean;
  /** Version goal — framing handed to the adaptive selector (read only by `adaptive`). */
  goal?: string;
  /**
   * Learning Mode (adaptive probing): per-question-key peer divergence (0–1) from the round's digest.
   * Threaded into the adaptive selector's {@link SelectionContext} so it can lean toward probing
   * topics where earlier respondents split. Absent unless Learning Mode is active for the round.
   */
  peerDivergenceByKey?: Record<string, number>;
  /**
   * Preview Turn Inspector (admin-only): when provided, each agent/LLM call pushes a trace here.
   * The route only supplies it for a preview session with the inspector toggle on, so capture is
   * off (zero overhead) for real respondents. See `lib/app/questionnaire/inspector`.
   */
  recordInspectorCall?: RecordAgentCall;
  /** Data Slots feature: the data slots to also fill (omit for question-only mode). Each carries
   *  its `current` fill when one exists, so the extractor can update/correct it across turns. */
  dataSlotCandidates?: Array<{
    key: string;
    name: string;
    description: string;
    theme: string;
    /** Question keys this slot captures — the extractor answers these when it fills the slot. */
    mappedQuestionKeys?: string[];
    current?: { value: unknown; paraphrase: string | null; confidence: number | null };
  }>;
  /**
   * Sensitivity awareness / safeguarding: when true, the extractor is asked to ALSO flag a genuine
   * sensitive disclosure. Resolved by the route from the per-questionnaire toggle; off (default)
   * keeps the prompt and behaviour unchanged.
   */
  sensitivityAware?: boolean;
  /**
   * Semantic answer-fit resolver mode (per-questionnaire config). Threaded to the extractor so it
   * can run the focused follow-up pass. `off`/absent → single pass (no behaviour change).
   */
  answerFitMode?: AnswerFitMode;
  /**
   * Confirmation floor (per-questionnaire config) — threaded to the extractor so the opportunistic
   * refresh pass knows when a corroborated mapped answer has been strengthened enough to leave alone.
   */
  answerConfidenceFloor?: number;
  /**
   * Anonymous (no-login) session. The adaptive SELECTORS drive the selection agent through
   * `streamChat`, which persists an `AiConversation` keyed to a real `user` — but an anonymous turn's
   * `userId` is the synthetic `anon:<sessionId>` (no `user` row), so the insert FK-violates and the
   * stream 500s every turn. With no ephemeral-chat seam in the platform handler, the selectors skip
   * the LLM pick for anonymous sessions and fall back to deterministic selection.
   */
  anonymous?: boolean;
}): Promise<CapabilityInvokers> {
  const {
    userId,
    slots,
    extractionCandidateSlots,
    activeQuestionKey,
    dataSlotAdaptiveEnabled,
    goal,
    peerDivergenceByKey,
    dataSlotCandidates,
    sensitivityAware,
    answerFitMode,
    answerConfidenceFloor,
    anonymous,
    recordInspectorCall,
  } = opts;

  // Inspector (admin preview only): resolve a binding's display model/provider for a trace, fail-soft.
  async function resolveDisplay(
    binding: AgentBinding | null
  ): Promise<{ model: string; provider: string }> {
    try {
      const r = await resolveAgentProviderAndModel(
        binding
          ? {
              provider: binding.provider,
              model: binding.model,
              fallbackProviders: binding.fallbackProviders,
            }
          : { provider: '', model: '', fallbackProviders: [] },
        'chat'
      );
      return { model: r.model, provider: r.providerSlug };
    } catch {
      return { model: binding?.model ?? '', provider: binding?.provider ?? '' };
    }
  }

  // Flush the built-in + app capability handlers into the dispatcher before any
  // invoker dispatches. The turn loop calls `capabilityDispatcher.dispatch()` directly
  // (not through the orchestration chat handler / agent-call executor, which is where the
  // platform normally registers), so on a fresh server process that has only served
  // questionnaire traffic the handler map would otherwise be empty and every capability
  // dispatch would return `unknown_capability`. Idempotent (one-shot inside the registry).
  registerBuiltInCapabilities();

  const [extractor, detector, refiner] = await Promise.all([
    loadBinding(QUESTIONNAIRE_ANSWER_EXTRACTOR_AGENT_SLUG),
    loadBinding(QUESTIONNAIRE_CONTRADICTION_DETECTOR_AGENT_SLUG),
    loadBinding(QUESTIONNAIRE_ANSWER_REFINER_AGENT_SLUG),
  ]);

  // Full candidate set — used by the contradiction detector + refiner (their coverage must not shrink).
  const candidateSlots = slots.map(toCapabilitySlot);
  // The EXTRACTOR sees the narrowed set when the route supplied one (the pre-filter), else the full set.
  const extractionCandidates = (extractionCandidateSlots ?? slots).map(toCapabilitySlot);
  // slotKey → question type, so the extractor's `answered` view can carry each answer's type (the
  // confirmation-refresh path re-emits an answer and needs its type without a slot lookup).
  const slotTypeByKey = new Map(slots.map((s) => [s.key, s.type]));

  return {
    async extractAnswers(state): Promise<ExtractOutcome> {
      // Data-slot mode has NO single active question (the respondent answers an open conversational
      // prompt), so it drives extraction off the data-slot candidates instead. Only short-circuit
      // when there's nothing to extract into at all — no active question AND no data slots.
      const hasDataSlots = (dataSlotCandidates?.length ?? 0) > 0;
      if (!activeQuestionKey && !hasDataSlots) {
        return { intents: [], costUsd: 0, diagnostic: 'no_active_question' };
      }
      if (!extractor) return { intents: [], costUsd: 0, diagnostic: 'extractor_unconfigured' };

      const started = Date.now();
      const extractArgs = {
        userMessage: state.userMessage,
        // Omit in data-slot mode — the capability treats an absent key as "open prompt".
        ...(activeQuestionKey ? { activeQuestionKey } : {}),
        candidateSlots: extractionCandidates,
        answered: state.existingAnswers.map((a) => ({
          slotKey: a.slotKey,
          confidence: a.confidence ?? null,
          // Carry value/provenance/type so the extractor can strengthen a tentative inferred answer
          // when its theme is corroborated (the confirmation-refresh path) without re-deriving it.
          value: a.value,
          provenance: a.provenance,
          ...(slotTypeByKey.has(a.slotKey) ? { questionType: slotTypeByKey.get(a.slotKey)! } : {}),
        })),
        ...(state.recentMessages.length > 0 ? { recentMessages: state.recentMessages } : {}),
        ...(state.attachments && state.attachments.length > 0
          ? { attachments: state.attachments }
          : {}),
        // Data Slots feature: when present, the same call also returns data-slot fills.
        ...(dataSlotCandidates && dataSlotCandidates.length > 0 ? { dataSlotCandidates } : {}),
        // Sensitivity awareness: ask the extractor to also flag a sensitive disclosure.
        ...(sensitivityAware ? { sensitivityAware: true } : {}),
        // Answer-fit resolver: let the extractor run the focused follow-up pass when enabled.
        ...(answerFitMode && answerFitMode !== 'off' ? { answerFitMode } : {}),
        ...(answerConfidenceFloor !== undefined ? { answerConfidenceFloor } : {}),
        sessionId: state.sessionId,
      };
      const dispatch = await capabilityDispatcher.dispatch(
        EXTRACT_ANSWER_SLOTS_CAPABILITY_SLUG,
        extractArgs,
        {
          userId,
          agentId: extractor.id,
          entityContext: { answerExtractorAgent: bindingCtx(extractor) },
        }
      );
      const latencyMs = Date.now() - started;

      if (!dispatch.success || !dispatch.data) {
        return {
          intents: [],
          costUsd: 0,
          latencyMs,
          diagnostic: dispatch.error?.code ?? 'extraction_failed',
        };
      }
      const data = dispatch.data as ExtractAnswerSlotsData;
      if (recordInspectorCall) {
        const { model, provider } = await resolveDisplay(extractor);
        recordInspectorCall({
          label: 'Answer extraction',
          model,
          provider,
          latencyMs,
          costUsd: data.costUsd ?? 0,
          prompt: argsAsPrompt(extractArgs),
          response: JSON.stringify(
            {
              intents: data.intents,
              dataSlotFills: data.dataSlotFills ?? [],
              sensitivity: data.sensitivity,
            },
            null,
            2
          ),
        });
        // The answer-fit resolver is a SEPARATE LLM call inside the capability — surface it as its
        // own trace (the capability hands its details back on `data.answerFitCall` when it ran).
        if (data.answerFitCall) {
          const fc = data.answerFitCall;
          recordInspectorCall({
            label: 'Answer-fit resolver',
            model: fc.model,
            provider: fc.provider,
            latencyMs: 0,
            costUsd: fc.costUsd,
            tokensIn: fc.tokensIn,
            tokensOut: fc.tokensOut,
            prompt: fc.prompt,
            response: fc.response,
          });
        }
      }
      return {
        intents: data.intents,
        dataSlotFills: data.dataSlotFills ?? [],
        costUsd: data.costUsd ?? 0,
        latencyMs,
        // Sensitivity awareness: surface the disclosure assessment for the orchestrator's step 1.6.
        ...(data.sensitivity !== undefined ? { sensitivity: data.sensitivity } : {}),
      };
    },

    async detectContradictions(state): Promise<DetectOutcome> {
      if (!detector) return { findings: [], costUsd: 0, diagnostic: 'detector_unconfigured' };

      const started = Date.now();
      const detectArgs = {
        slots: candidateSlots,
        answers: state.existingAnswers.map((a) => ({
          slotKey: a.slotKey,
          value: a.value,
          ...(a.confidence !== undefined ? { confidence: a.confidence } : {}),
          provenance: a.provenance,
        })),
        mode: state.config.contradictionMode,
        windowN: state.config.contradictionWindowN,
        // Feed the respondent's latest message so the detector can catch a same-slot reversal
        // (e.g. an earlier "I hate the job" answer vs a current "I love my job") even when this
        // turn's extraction didn't overwrite the stored answer. Omitted on a kickoff (empty).
        ...(state.userMessage.trim().length > 0 ? { currentStatement: state.userMessage } : {}),
        sessionId: state.sessionId,
      };
      const dispatch = await capabilityDispatcher.dispatch(
        DETECT_CONTRADICTIONS_CAPABILITY_SLUG,
        detectArgs,
        {
          userId,
          agentId: detector.id,
          entityContext: { contradictionDetectorAgent: bindingCtx(detector) },
        }
      );
      const latencyMs = Date.now() - started;

      if (!dispatch.success || !dispatch.data) {
        return {
          findings: [],
          costUsd: 0,
          latencyMs,
          diagnostic: dispatch.error?.code ?? 'detection_failed',
        };
      }
      const data = dispatch.data as DetectContradictionsData;
      if (recordInspectorCall) {
        const { model, provider } = await resolveDisplay(detector);
        recordInspectorCall({
          label: 'Contradiction detection',
          model,
          provider,
          latencyMs,
          costUsd: data.costUsd ?? 0,
          prompt: argsAsPrompt(detectArgs),
          response: JSON.stringify({ findings: data.findings }, null, 2),
        });
      }
      return {
        findings: data.findings,
        costUsd: data.costUsd ?? 0,
        latencyMs,
      };
    },

    async refineAnswer(state, trigger): Promise<RefineOutcome> {
      if (!refiner) return { decisions: [], costUsd: 0, diagnostic: 'refiner_unconfigured' };

      const started = Date.now();
      const refineArgs = {
        slots: candidateSlots,
        existingAnswers: state.existingAnswers.map((a) => ({
          slotKey: a.slotKey,
          value: a.value,
          provenance: a.provenance,
          ...(a.rationale !== undefined ? { rationale: a.rationale } : {}),
          ...(a.confidence !== undefined ? { confidence: a.confidence } : {}),
        })),
        ...(state.userMessage.trim().length > 0 ? { userMessage: state.userMessage } : {}),
        ...(trigger.contradiction
          ? {
              triggeringContradiction: {
                slotKeys: trigger.contradiction.slotKeys,
                explanation: trigger.contradiction.explanation,
                ...(trigger.contradiction.suggestedProbe !== undefined
                  ? { suggestedProbe: trigger.contradiction.suggestedProbe }
                  : {}),
              },
            }
          : {}),
        ...(state.recentMessages.length > 0 ? { recentMessages: state.recentMessages } : {}),
        sessionId: state.sessionId,
      };
      const dispatch = await capabilityDispatcher.dispatch(
        REFINE_ANSWER_CAPABILITY_SLUG,
        refineArgs,
        {
          userId,
          agentId: refiner.id,
          entityContext: { answerRefinerAgent: bindingCtx(refiner) },
        }
      );
      const latencyMs = Date.now() - started;

      if (!dispatch.success || !dispatch.data) {
        return {
          decisions: [],
          costUsd: 0,
          latencyMs,
          diagnostic: dispatch.error?.code ?? 'refinement_failed',
        };
      }
      const data = dispatch.data as RefineAnswerData;
      if (recordInspectorCall) {
        const { model, provider } = await resolveDisplay(refiner);
        recordInspectorCall({
          label: 'Answer refinement',
          model,
          provider,
          latencyMs,
          costUsd: data.costUsd ?? 0,
          prompt: argsAsPrompt(refineArgs),
          response: JSON.stringify({ decisions: data.decisions }, null, 2),
        });
      }
      return { decisions: data.decisions, costUsd: data.costUsd ?? 0, latencyMs };
    },

    async selectNext(state): Promise<SelectOutcome> {
      // Rank the next question by what the respondent JUST said, not the prior interviewer question.
      const conversation = conversationWithCurrentAnswer(state);
      const ctx: SelectionContext = {
        questions: state.questions,
        answered: state.answered,
        config: state.config,
        round: state.selectionRound,
        sessionId: state.sessionId,
        ...(conversation.length > 0 ? { recentMessages: conversation } : {}),
        ...(goal ? { goal } : {}),
        ...(peerDivergenceByKey ? { peerDivergenceByKey } : {}),
      };
      // Adaptive's embedding + LLM path runs only for an `adaptive` version; otherwise it
      // degrades to `weighted` via the strategy's own fallback (no deps passed).
      let deps: StrategyDeps | undefined;
      if (state.config.selectionStrategy === 'adaptive') {
        deps = buildAdaptiveDeps({
          userId,
          ...(anonymous ? { anonymous } : {}),
          ...(recordInspectorCall ? { recordInspectorCall } : {}),
        });
      }
      const started = Date.now();
      const decision = await getStrategy(state.config.selectionStrategy).select(ctx, deps);
      return { decision, latencyMs: Date.now() - started };
    },

    // Adaptive data-slot selection — only does work when `dataSlotAdaptiveEnabled` (else null and
    // the data-slot orchestrator keeps its deterministic topic-local pick). Fail-soft inside.
    async selectDataSlot(state, unfilled, context): Promise<DataSlotSelectOutcome | null> {
      if (!dataSlotAdaptiveEnabled) {
        return null;
      }
      return selectNextDataSlot({
        unfilled,
        // Rank the next data slot by what the respondent JUST said (see conversationWithCurrentAnswer).
        recentMessages: conversationWithCurrentAnswer(state),
        activeTheme: context.activeTheme,
        parkedTheme: context.parkedTheme,
        ...(goal ? { goal } : {}),
        sessionId: state.sessionId,
        userId,
        ...(anonymous ? { anonymous } : {}),
        ...(recordInspectorCall ? { recordInspectorCall } : {}),
      });
    },

    async assessSeriousness(state): Promise<SeriousnessOutcome> {
      // Stage 2 of the seriousness gate — a direct structured LLM call (not a registered
      // capability): rule on whether this turn's answer is a genuine attempt. Reuses the
      // answer-extractor's provider/model binding (per-turn chat-tier work); an absent binding
      // resolves to the system default. Fail-soft: any failure returns a null verdict + a
      // diagnostic, so the gate never crashes a turn.
      const started = Date.now();
      // The judge must rule on the answer IN CONTEXT of what was asked. In question mode that's the
      // active question's prompt; in DATA-SLOT mode there is no active question (the turn targeted a
      // data slot), so fall back to the active data slot's name + description. Judging blind — with
      // "(no specific question)" — is what made a terse-but-genuine answer like "5 year, engineering"
      // read as non-genuine: a fragment with no prompt to anchor it looks like a non-answer.
      const activeDataSlot =
        state.activeDataSlotKey && state.dataSlots
          ? state.dataSlots.find((s) => s.key === state.activeDataSlotKey)
          : undefined;
      const questionPrompt = activeQuestionKey
        ? (slots.find((s) => s.key === activeQuestionKey)?.prompt ?? '')
        : activeDataSlot
          ? `${activeDataSlot.name} — ${activeDataSlot.description}`
          : '';

      // Safety net: with no question/data-slot context, the judge has no basis to call an answer
      // non-genuine — disregarding here is how false positives slip through. Keep the answer (and
      // skip the paid LLM call) rather than judge blind. Mid-conversation there is always an active
      // target, so this only short-circuits genuinely contextless turns.
      if (questionPrompt.trim().length === 0) {
        return {
          verdict: { serious: true, reason: '' },
          costUsd: 0,
          latencyMs: Date.now() - started,
        };
      }

      let providerSlug: string;
      let model: string;
      try {
        const resolved = await resolveAgentProviderAndModel(
          extractor
            ? {
                provider: extractor.provider,
                model: extractor.model,
                fallbackProviders: extractor.fallbackProviders,
              }
            : { provider: '', model: '', fallbackProviders: [] },
          'chat'
        );
        providerSlug = resolved.providerSlug;
        model = resolved.model;
      } catch (err) {
        logger.error('assess_seriousness: no provider resolved', {
          sessionId: state.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          verdict: null,
          costUsd: 0,
          latencyMs: Date.now() - started,
          diagnostic: 'no_provider_configured',
        };
      }

      let provider: Awaited<ReturnType<typeof getProvider>>;
      try {
        provider = await getProvider(providerSlug);
      } catch {
        return {
          verdict: null,
          costUsd: 0,
          latencyMs: Date.now() - started,
          diagnostic: 'provider_unavailable',
        };
      }

      const { system, user } = buildSeriousnessJudgePrompt({
        questionPrompt,
        userMessage: state.userMessage,
        sessionId: state.sessionId,
        ...(state.recentMessages.length > 0 ? { recentMessages: state.recentMessages } : {}),
      });
      const messages: LlmMessage[] = [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ];

      try {
        const completion = await runStructuredCompletion<SeriousnessVerdictRaw>({
          provider,
          model,
          messages,
          maxTokens: 600,
          timeoutMs: 30_000,
          parse: (raw) =>
            tryParseJson(raw, (parsed) => {
              const validation = validateSeriousnessVerdict(parsed);
              return validation.ok ? validation.value : null;
            }),
          retryUserMessage: 'Return ONLY the JSON object {"serious": boolean, "reason": string}.',
          onFinalFailure: () =>
            new Error('Seriousness verdict was not valid against the schema after one retry'),
        });

        void logCost({
          ...(extractor ? { agentId: extractor.id } : {}),
          operation: CostOperation.CHAT,
          model,
          provider: providerSlug,
          inputTokens: completion.tokenUsage.input,
          outputTokens: completion.tokenUsage.output,
          metadata: {
            capability: ASSESS_SERIOUSNESS_TOOL_SLUG,
            appQuestionnaireSessionId: state.sessionId,
          },
        }).catch((err) => {
          logger.error('assess_seriousness: logCost rejected', {
            sessionId: state.sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        });

        const verdict = {
          serious: completion.value.serious,
          reason: completion.value.reason ?? '',
        };
        const latencyMs = Date.now() - started;
        if (recordInspectorCall) {
          recordInspectorCall({
            label: 'Seriousness judge',
            model,
            provider: providerSlug,
            latencyMs,
            costUsd: completion.costUsd,
            tokensIn: completion.tokenUsage.input,
            tokensOut: completion.tokenUsage.output,
            prompt: messages.map((m) => ({ role: m.role, content: getTextContent(m.content) })),
            response: JSON.stringify(verdict, null, 2),
          });
        }
        return { verdict, costUsd: completion.costUsd, latencyMs };
      } catch (err) {
        logger.error('assess_seriousness: structured completion failed', {
          sessionId: state.sessionId,
          model,
          provider: providerSlug,
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          verdict: null,
          costUsd: 0,
          latencyMs: Date.now() - started,
          diagnostic: 'seriousness_judge_failed',
        };
      }
    },

    async detectSensitivity(state): Promise<SensitivityDetectOutcome> {
      // Dedicated safeguarding detector — a direct structured LLM call (not a registered capability),
      // run every answered turn the feature is on so detection never depends on the answer-extractor
      // remembering its optional `sensitivity` field. Reuses the extractor's provider/model binding.
      // Fail-soft: any failure returns a null assessment + a diagnostic, and the orchestrator still
      // merges the extractor field + keyword net, so a detector miss never drops a real disclosure.
      const started = Date.now();
      // Context for reading an oblique disclosure: the active question (or data-slot name + desc).
      // Unlike the seriousness judge we do NOT short-circuit when context is absent — a disclosure is
      // genuine regardless of what was asked, so the detector always runs.
      const activeDataSlot =
        state.activeDataSlotKey && state.dataSlots
          ? state.dataSlots.find((s) => s.key === state.activeDataSlotKey)
          : undefined;
      const questionPrompt = activeQuestionKey
        ? (slots.find((s) => s.key === activeQuestionKey)?.prompt ?? '')
        : activeDataSlot
          ? `${activeDataSlot.name} — ${activeDataSlot.description}`
          : '';

      let providerSlug: string;
      let model: string;
      try {
        const resolved = await resolveAgentProviderAndModel(
          extractor
            ? {
                provider: extractor.provider,
                model: extractor.model,
                fallbackProviders: extractor.fallbackProviders,
              }
            : { provider: '', model: '', fallbackProviders: [] },
          'chat'
        );
        providerSlug = resolved.providerSlug;
        model = resolved.model;
      } catch (err) {
        logger.error('detect_sensitivity: no provider resolved', {
          sessionId: state.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          assessment: null,
          costUsd: 0,
          latencyMs: Date.now() - started,
          diagnostic: 'no_provider_configured',
        };
      }

      let provider: Awaited<ReturnType<typeof getProvider>>;
      try {
        provider = await getProvider(providerSlug);
      } catch {
        return {
          assessment: null,
          costUsd: 0,
          latencyMs: Date.now() - started,
          diagnostic: 'provider_unavailable',
        };
      }

      const { system, user } = buildSensitivityDetectPrompt({
        questionPrompt,
        userMessage: state.userMessage,
        sessionId: state.sessionId,
        ...(state.recentMessages.length > 0 ? { recentMessages: state.recentMessages } : {}),
      });
      const messages: LlmMessage[] = [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ];

      try {
        const completion = await runStructuredCompletion<SensitivityDetectVerdictRaw>({
          provider,
          model,
          messages,
          maxTokens: 600,
          timeoutMs: 30_000,
          parse: (raw) =>
            tryParseJson(raw, (parsed) => {
              const validation = validateSensitivityDetectVerdict(parsed);
              return validation.ok ? validation.value : null;
            }),
          retryUserMessage:
            'Return ONLY the JSON object {"detected": boolean, "severity": string, "category": string, "summary": string}.',
          onFinalFailure: () =>
            new Error('Sensitivity verdict was not valid against the schema after one retry'),
        });

        void logCost({
          ...(extractor ? { agentId: extractor.id } : {}),
          operation: CostOperation.CHAT,
          model,
          provider: providerSlug,
          inputTokens: completion.tokenUsage.input,
          outputTokens: completion.tokenUsage.output,
          metadata: {
            capability: DETECT_SENSITIVITY_TOOL_SLUG,
            appQuestionnaireSessionId: state.sessionId,
          },
        }).catch((err) => {
          logger.error('detect_sensitivity: logCost rejected', {
            sessionId: state.sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        });

        const assessment = normalizeSensitivityVerdict(completion.value);
        const latencyMs = Date.now() - started;
        if (recordInspectorCall) {
          recordInspectorCall({
            label: 'Sensitivity detection',
            model,
            provider: providerSlug,
            latencyMs,
            costUsd: completion.costUsd,
            tokensIn: completion.tokenUsage.input,
            tokensOut: completion.tokenUsage.output,
            prompt: messages.map((m) => ({ role: m.role, content: getTextContent(m.content) })),
            response: JSON.stringify(assessment, null, 2),
          });
        }
        return { assessment, costUsd: completion.costUsd, latencyMs };
      } catch (err) {
        logger.error('detect_sensitivity: structured completion failed', {
          sessionId: state.sessionId,
          model,
          provider: providerSlug,
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          assessment: null,
          costUsd: 0,
          latencyMs: Date.now() - started,
          diagnostic: 'sensitivity_detect_failed',
        };
      }
    },
  };
}

/** Project an agent binding into the `{ provider, model, fallbackProviders }` entityContext. */
function bindingCtx(agent: AgentBinding): {
  provider: string;
  model: string;
  fallbackProviders: string[];
} {
  return {
    provider: agent.provider,
    model: agent.model,
    fallbackProviders: agent.fallbackProviders,
  };
}
