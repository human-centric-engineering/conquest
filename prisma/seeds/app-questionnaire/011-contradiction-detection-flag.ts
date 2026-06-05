import { APP_QUESTIONNAIRES_CONTRADICTION_DETECTION_FLAG } from '@/lib/app/questionnaire/constants';
import type { SeedUnit } from '@/prisma/runner';

/**
 * Seeds the F4.3 contradiction-detection sub-flag, DISABLED by default.
 *
 * Contradiction detection runs a structured LLM completion to compare a
 * respondent's answers and surface logical conflicts — real per-pass spend. So it's
 * gated behind its own flag on top of the master app gate
 * (`APP_QUESTIONNAIRES_ENABLED`): an operator opts in deliberately. While off, the
 * detect-contradictions route 404s.
 *
 * App seed: lives under `prisma/seeds/app-questionnaire/`, found by the recursive
 * runner; its `SeedHistory` key is `app-questionnaire/011-contradiction-detection-flag`.
 * Idempotent (`update: {}`) so re-seeding never clobbers an operator's toggle.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/011-contradiction-detection-flag',
  async run({ prisma, logger }) {
    logger.info('🚩 Seeding APP_QUESTIONNAIRES_CONTRADICTION_DETECTION_ENABLED feature flag...');

    await prisma.featureFlag.upsert({
      where: { name: APP_QUESTIONNAIRES_CONTRADICTION_DETECTION_FLAG },
      update: {},
      create: {
        name: APP_QUESTIONNAIRES_CONTRADICTION_DETECTION_FLAG,
        description:
          'Enables ConQuest contradiction detection (a structured LLM call that compares a ' +
          "respondent's answers across slots and surfaces logical conflicts for confirmation). " +
          'Opt-in on top of APP_QUESTIONNAIRES_ENABLED because it incurs per-pass spend. When ' +
          'off, the detect-contradictions route 404s. Disabled by default.',
        enabled: false,
      },
    });

    logger.info(
      `✅ Ensured ${APP_QUESTIONNAIRES_CONTRADICTION_DETECTION_FLAG} flag (disabled by default)`
    );
  },
};

export default unit;
