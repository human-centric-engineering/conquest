import { APP_QUESTIONNAIRES_ADAPTIVE_DATA_SLOTS_FLAG } from '@/lib/app/questionnaire/constants';
import type { SeedUnit } from '@/prisma/runner';

/**
 * Seeds the adaptive data-slot-selection sub-flag, DISABLED by default.
 *
 * Adaptive data-slot selection embeds the respondent's last message and runs an LLM pick over the
 * most similar unfilled data slots — real per-turn spend, aimed at large questionnaires (50+ data
 * slots). So it's gated behind its own flag on top of the master app gate, the data-slots flag, and
 * live-sessions: an operator opts in deliberately. While off, the data-slot turn loop keeps the
 * deterministic topic-local `pickNextDataSlot`.
 *
 * App seed: lives under `prisma/seeds/app-questionnaire/`, found by the recursive runner; its
 * `SeedHistory` key is `app-questionnaire/041-adaptive-data-slots-flag`. Idempotent (`update: {}`)
 * so re-seeding never clobbers an operator's toggle.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/041-adaptive-data-slots-flag',
  async run({ prisma, logger }) {
    logger.info('🚩 Seeding APP_QUESTIONNAIRES_ADAPTIVE_DATA_SLOTS_ENABLED feature flag...');

    await prisma.featureFlag.upsert({
      where: { name: APP_QUESTIONNAIRES_ADAPTIVE_DATA_SLOTS_FLAG },
      update: {},
      create: {
        name: APP_QUESTIONNAIRES_ADAPTIVE_DATA_SLOTS_FLAG,
        description:
          'Enables ConQuest adaptive data-slot selection (embeddings + an LLM pick over the most ' +
          'similar unfilled data slots per targeted turn). Opt-in on top of ' +
          'APP_QUESTIONNAIRES_ENABLED + the data-slots and live-sessions flags because it incurs ' +
          'per-turn spend; aimed at large (50+ slot) questionnaires. When off, data-slot targeting ' +
          'stays deterministic (topic-local). Disabled by default.',
        enabled: false,
      },
    });

    logger.info(
      `✅ Ensured ${APP_QUESTIONNAIRES_ADAPTIVE_DATA_SLOTS_FLAG} flag (disabled by default)`
    );
  },
};

export default unit;
