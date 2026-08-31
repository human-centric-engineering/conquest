import type { SeedUnit } from '@/prisma/runner';

/**
 * Pre-set the orchestration default-model map to OpenAI ids.
 *
 * ConQuest defaults to **OpenAI**, not Anthropic. Out of the box the platform
 * leaves `AiOrchestrationSettings.defaultModels` to a lazy cost-scan
 * (`computeDefaultModelMap()`) whose hardcoded fallbacks are Claude ids, and it
 * leaves `embeddings`/`audio` empty (so `getDefaultModelForTask()` throws
 * `NoDefaultModelConfiguredError` at runtime). Every app agent ships with an
 * empty `model`/`provider` and inherits these per-task defaults, so a fresh
 * install would boot mis-configured for our OpenAI account.
 *
 * This seed writes explicit OpenAI ids so the app resolves correctly the moment
 * an OpenAI provider is configured.
 *
 * **Non-clobbering by design.** The settings singleton is normally never touched
 * by the seeder so admin edits survive deploys (see the schema comment on
 * `AiOrchestrationSettings`). We honour that: we only fill a slot that is
 * currently empty/missing — any value an operator has saved always wins. The
 * unit is hash-gated by the runner, so it runs once unless edited.
 *
 * **Runtime dependency.** These ids only resolve to OpenAI once an OpenAI
 * `AiProviderConfig` is active (its key env var set) — provider configs are
 * operator-managed (there is no provider seed). `agent-resolver` picks the first
 * active provider, then this model id. If OpenAI is not the active provider the
 * id will not match the chosen provider, so configure OpenAI first.
 *
 * The model ids below must correspond to active rows seeded by
 * `009-provider-models` (which runs first).
 */

/**
 * Desired OpenAI defaults per task tier. Values are provider model ids.
 *
 * Tier strategy (see `lib/app/questionnaire/agent-advisory/recommendations.ts`):
 * pick the model whose strengths match what the task has to do, then optimise
 * cost within that choice.
 *
 *   - reasoning → gpt-5.4: work whose quality depends on sustained analysis over
 *     a lot of material — document extraction, turn evaluation, session planning,
 *     reports, config advice. It runs in the background, so depth beats latency.
 *   - chat → gpt-4o: the per-turn path a respondent is waiting on — interviewer
 *     phrasing, answer extraction, contradiction detection, completion — plus
 *     short, well-specified jobs like formatting prose or reading a screenshot.
 *     Each call is small and responsiveness is part of the quality, so a fast,
 *     fluent, multimodal model fits; a deliberative one would only add latency to
 *     work it cannot do better.
 *   - routing → gpt-4.1-nano: mechanical, high-frequency chores (history
 *     summarisation) where any competent small model is indistinguishable and
 *     cost decides.
 */
const OPENAI_DEFAULTS: Record<string, string> = {
  reasoning: 'gpt-5.4', // deep one-off work: extraction, turn-eval, reports, config advice
  chat: 'gpt-4o', // per-turn path + short, well-specified jobs (fast, fluent, multimodal)
  routing: 'gpt-4.1-nano', // conversation summarisation (cheapest competent model)
  embeddings: 'text-embedding-3-small', // 1536-dim, schema-compatible
  audio: 'gpt-4o-transcribe', // streaming-chat mic transcription
};

/** Provider-model slug whose row id seeds `activeEmbeddingModelId`. */
const EMBEDDING_MODEL_SLUG = 'openai-text-embedding-3-small';

/** Narrow a stored `defaultModels` JSON blob into a flat string map. */
function readStoredDefaults(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' && value.length > 0) out[key] = value;
  }
  return out;
}

const unit: SeedUnit = {
  name: '020-orchestration-default-models',
  async run({ prisma, logger }) {
    logger.info('🎛️  Pre-setting OpenAI orchestration default models...');

    const existing = await prisma.aiOrchestrationSettings.findUnique({
      where: { slug: 'global' },
      select: { id: true, defaultModels: true, activeEmbeddingModelId: true },
    });

    // Operator-saved (non-empty) slots always win; we only fill the gaps.
    const stored = readStoredDefaults(existing?.defaultModels);
    const merged: Record<string, string> = { ...OPENAI_DEFAULTS, ...stored };

    // Resolve the embedding model row so the vector columns' sizing is pinned
    // to a concrete model. Only set it when the operator hasn't already chosen.
    const embeddingModel = await prisma.aiProviderModel.findUnique({
      where: { slug: EMBEDDING_MODEL_SLUG },
      select: { id: true },
    });
    if (!embeddingModel) {
      logger.warn(
        `⚠️  ${EMBEDDING_MODEL_SLUG} not found — run 009-provider-models first. Skipping activeEmbeddingModelId.`
      );
    }
    // Only set the embedding-model FK when the operator hasn't already chosen one.
    const embeddingModelId =
      embeddingModel && (!existing || existing.activeEmbeddingModelId === null)
        ? embeddingModel.id
        : null;

    if (existing) {
      await prisma.aiOrchestrationSettings.update({
        where: { slug: 'global' },
        data: {
          defaultModels: merged,
          ...(embeddingModelId ? { activeEmbeddingModelId: embeddingModelId } : {}),
        },
      });
      logger.info(
        `✅ Default models updated (gaps filled, operator values preserved): ${JSON.stringify(merged)}`
      );
    } else {
      await prisma.aiOrchestrationSettings.create({
        data: {
          slug: 'global',
          defaultModels: merged,
          ...(embeddingModelId ? { activeEmbeddingModelId: embeddingModelId } : {}),
        },
      });
      logger.info(`✅ Settings singleton created with OpenAI defaults: ${JSON.stringify(merged)}`);
    }
  },
};

export default unit;
