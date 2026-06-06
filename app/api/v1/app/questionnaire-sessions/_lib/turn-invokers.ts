/**
 * Real {@link CapabilityInvokers} for the live turn loop (F6.1, PR4).
 *
 * The impure boundary the pure orchestrator injects: each invoker maps the in-memory
 * {@link TurnState} onto a P4 capability's args, dispatches it through the shared
 * `capabilityDispatcher` (the preview-route path), and maps the result back fail-soft — a
 * capability failure becomes an empty outcome + a `diagnostic`, never a throw, so a single
 * failing step doesn't crash the turn. Selection runs the pure F4.1 strategy directly
 * (degrading adaptive → weighted when its sub-flag is off). The completion-offer prose is
 * NOT an invoker — the route renders it (PR4 via the capability, PR5 streamed).
 */

import { prisma } from '@/lib/db/client';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import {
  DETECT_CONTRADICTIONS_CAPABILITY_SLUG,
  EXTRACT_ANSWER_SLOTS_CAPABILITY_SLUG,
  QUESTIONNAIRE_ANSWER_EXTRACTOR_AGENT_SLUG,
  QUESTIONNAIRE_ANSWER_REFINER_AGENT_SLUG,
  QUESTIONNAIRE_CONTRADICTION_DETECTOR_AGENT_SLUG,
  REFINE_ANSWER_CAPABILITY_SLUG,
} from '@/lib/app/questionnaire/constants';
import {
  getStrategy,
  type SelectionContext,
  type StrategyDeps,
} from '@/lib/app/questionnaire/selection';
import type {
  CapabilityInvokers,
  DetectOutcome,
  ExtractOutcome,
  RefineOutcome,
  SelectOutcome,
} from '@/lib/app/questionnaire/orchestrator';
import type {
  DetectContradictionsData,
  ExtractAnswerSlotsData,
  RefineAnswerData,
} from '@/lib/app/questionnaire/capabilities';
import { buildAdaptiveDeps } from '@/app/api/v1/app/questionnaires/_lib/adaptive-deps';
import type { CapabilitySlotView } from '@/app/api/v1/app/questionnaires/_lib/turn-context';

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

/** Build the live invokers, loading the capability agent bindings once up front. */
export async function buildTurnInvokers(opts: {
  userId: string;
  slots: CapabilitySlotView[];
  activeQuestionKey: string | null;
  adaptiveEnabled: boolean;
}): Promise<CapabilityInvokers> {
  const { userId, slots, activeQuestionKey, adaptiveEnabled } = opts;
  const [extractor, detector, refiner] = await Promise.all([
    loadBinding(QUESTIONNAIRE_ANSWER_EXTRACTOR_AGENT_SLUG),
    loadBinding(QUESTIONNAIRE_CONTRADICTION_DETECTOR_AGENT_SLUG),
    loadBinding(QUESTIONNAIRE_ANSWER_REFINER_AGENT_SLUG),
  ]);

  const candidateSlots = slots.map(toCapabilitySlot);

  return {
    async extractAnswers(state): Promise<ExtractOutcome> {
      if (!activeQuestionKey) return { intents: [], costUsd: 0, diagnostic: 'no_active_question' };
      if (!extractor) return { intents: [], costUsd: 0, diagnostic: 'extractor_unconfigured' };

      const started = Date.now();
      const dispatch = await capabilityDispatcher.dispatch(
        EXTRACT_ANSWER_SLOTS_CAPABILITY_SLUG,
        {
          userMessage: state.userMessage,
          activeQuestionKey,
          candidateSlots,
          answered: state.existingAnswers.map((a) => ({
            slotKey: a.slotKey,
            confidence: a.confidence ?? null,
          })),
          ...(state.recentMessages.length > 0 ? { recentMessages: state.recentMessages } : {}),
          sessionId: state.sessionId,
        },
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
      return { intents: (dispatch.data as ExtractAnswerSlotsData).intents, costUsd: 0, latencyMs };
    },

    async detectContradictions(state): Promise<DetectOutcome> {
      if (!detector) return { findings: [], costUsd: 0, diagnostic: 'detector_unconfigured' };

      const started = Date.now();
      const dispatch = await capabilityDispatcher.dispatch(
        DETECT_CONTRADICTIONS_CAPABILITY_SLUG,
        {
          slots: candidateSlots,
          answers: state.existingAnswers.map((a) => ({
            slotKey: a.slotKey,
            value: a.value,
            ...(a.confidence !== undefined ? { confidence: a.confidence } : {}),
            provenance: a.provenance,
          })),
          mode: state.config.contradictionMode,
          windowN: state.config.contradictionWindowN,
          sessionId: state.sessionId,
        },
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
      return {
        findings: (dispatch.data as DetectContradictionsData).findings,
        costUsd: 0,
        latencyMs,
      };
    },

    async refineAnswer(state, trigger): Promise<RefineOutcome> {
      if (!refiner) return { decisions: [], costUsd: 0, diagnostic: 'refiner_unconfigured' };

      const started = Date.now();
      const dispatch = await capabilityDispatcher.dispatch(
        REFINE_ANSWER_CAPABILITY_SLUG,
        {
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
        },
        { userId, agentId: refiner.id, entityContext: { answerRefinerAgent: bindingCtx(refiner) } }
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
      return { decisions: (dispatch.data as RefineAnswerData).decisions, costUsd: 0, latencyMs };
    },

    async selectNext(state): Promise<SelectOutcome> {
      const ctx: SelectionContext = {
        questions: state.questions,
        answered: state.answered,
        config: state.config,
        round: state.selectionRound,
        sessionId: state.sessionId,
        ...(state.recentMessages.length > 0 ? { recentMessages: state.recentMessages } : {}),
      };
      // Adaptive's embedding + LLM path runs only when its sub-flag is on; otherwise it
      // degrades to `weighted` via the strategy's own fallback (no deps passed).
      let deps: StrategyDeps | undefined;
      if (state.config.selectionStrategy === 'adaptive' && adaptiveEnabled) {
        deps = buildAdaptiveDeps({ userId });
      }
      const started = Date.now();
      const decision = await getStrategy(state.config.selectionStrategy).select(ctx, deps);
      return { decision, latencyMs: Date.now() - started };
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
