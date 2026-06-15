import { APP_QUESTIONNAIRES_GENERATIVE_AUTHORING_FLAG } from '@/lib/app/questionnaire/constants';
import type { SeedUnit } from '@/prisma/runner';

/**
 * Seeds the Generative Authoring sub-flag, DISABLED by default.
 *
 * When on: the admin can compose a questionnaire from a plain-English brief
 * ("describe your goal, watch it build") and conversationally refine it before
 * opening it in the Structure editor. Each compose/refine run is ≥1 reasoning LLM
 * call, so it dark-launches on top of the master app flag, independent of document
 * ingestion. When off, the compose/refine routes 404 and the "Describe your goal"
 * entry point is hidden — nothing else changes.
 *
 * App seed: `SeedHistory` key `app-questionnaire/035-generative-authoring-flag`.
 * Idempotent (`update: {}`).
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/035-generative-authoring-flag',
  async run({ prisma, logger }) {
    logger.info('🚩 Seeding APP_QUESTIONNAIRES_GENERATIVE_AUTHORING_ENABLED feature flag...');

    await prisma.featureFlag.upsert({
      where: { name: APP_QUESTIONNAIRES_GENERATIVE_AUTHORING_FLAG },
      update: {},
      create: {
        name: APP_QUESTIONNAIRES_GENERATIVE_AUTHORING_FLAG,
        description:
          'Enables ConQuest generative authoring — composing a questionnaire from a plain-English ' +
          'brief (streamed section-by-section) and conversationally refining it before editing. ' +
          'Opt-in on top of APP_QUESTIONNAIRES_ENABLED; each compose/refine run is a reasoning LLM ' +
          'call. Disabled by default.',
        enabled: false,
      },
    });

    logger.info(
      `✅ Ensured ${APP_QUESTIONNAIRES_GENERATIVE_AUTHORING_FLAG} flag (disabled by default)`
    );
  },
};

export default unit;
