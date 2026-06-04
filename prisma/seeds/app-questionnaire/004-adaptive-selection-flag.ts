import { APP_QUESTIONNAIRES_ADAPTIVE_FLAG } from '@/lib/app/questionnaire/constants';
import type { SeedUnit } from '@/prisma/runner';

/**
 * Seeds the F4.1 adaptive-selection sub-flag, DISABLED by default.
 *
 * Adaptive question selection embeds the respondent's last message and runs an
 * LLM pick over the most similar unanswered questions — real per-turn spend. So
 * it's gated behind its own flag on top of the master app gate
 * (`APP_QUESTIONNAIRES_ENABLED`): an operator opts in deliberately. While off,
 * the config editor hides the `adaptive` option and any version already set to
 * `adaptive` degrades to `weighted` at run time.
 *
 * App seed: lives under `prisma/seeds/app-questionnaire/`, found by the recursive
 * runner; its `SeedHistory` key is `app-questionnaire/004-adaptive-selection-flag`.
 * Idempotent (`update: {}`) so re-seeding never clobbers an operator's toggle.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/004-adaptive-selection-flag',
  async run({ prisma, logger }) {
    logger.info('🚩 Seeding APP_QUESTIONNAIRES_ADAPTIVE_STRATEGY_ENABLED feature flag...');

    await prisma.featureFlag.upsert({
      where: { name: APP_QUESTIONNAIRES_ADAPTIVE_FLAG },
      update: {},
      create: {
        name: APP_QUESTIONNAIRES_ADAPTIVE_FLAG,
        description:
          'Enables the ConQuest adaptive question-selection strategy (embeddings + ' +
          'an LLM pick per turn). Opt-in on top of APP_QUESTIONNAIRES_ENABLED because ' +
          'it incurs per-turn spend. When off, adaptive degrades to weighted and is ' +
          'hidden from the config picker. Disabled by default.',
        enabled: false,
      },
    });

    logger.info(`✅ Ensured ${APP_QUESTIONNAIRES_ADAPTIVE_FLAG} flag (disabled by default)`);
  },
};

export default unit;
