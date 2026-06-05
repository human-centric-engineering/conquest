import { APP_QUESTIONNAIRES_ANSWER_EXTRACTION_FLAG } from '@/lib/app/questionnaire/constants';
import type { SeedUnit } from '@/prisma/runner';

/**
 * Seeds the F4.2 answer-extraction sub-flag, DISABLED by default.
 *
 * Answer extraction runs a structured LLM completion on every respondent turn to
 * turn their message into typed slot values — real per-turn spend. So it's gated
 * behind its own flag on top of the master app gate (`APP_QUESTIONNAIRES_ENABLED`):
 * an operator opts in deliberately. While off, the extract-answer route 404s.
 *
 * App seed: lives under `prisma/seeds/app-questionnaire/`, found by the recursive
 * runner; its `SeedHistory` key is `app-questionnaire/008-answer-extraction-flag`.
 * Idempotent (`update: {}`) so re-seeding never clobbers an operator's toggle.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/008-answer-extraction-flag',
  async run({ prisma, logger }) {
    logger.info('🚩 Seeding APP_QUESTIONNAIRES_ANSWER_EXTRACTION_ENABLED feature flag...');

    await prisma.featureFlag.upsert({
      where: { name: APP_QUESTIONNAIRES_ANSWER_EXTRACTION_FLAG },
      update: {},
      create: {
        name: APP_QUESTIONNAIRES_ANSWER_EXTRACTION_FLAG,
        description:
          'Enables ConQuest answer extraction (a structured LLM call per respondent turn ' +
          'that extracts typed slot values, with confidence and provenance). Opt-in on top ' +
          'of APP_QUESTIONNAIRES_ENABLED because it incurs per-turn spend. When off, the ' +
          'extract-answer route 404s. Disabled by default.',
        enabled: false,
      },
    });

    logger.info(
      `✅ Ensured ${APP_QUESTIONNAIRES_ANSWER_EXTRACTION_FLAG} flag (disabled by default)`
    );
  },
};

export default unit;
