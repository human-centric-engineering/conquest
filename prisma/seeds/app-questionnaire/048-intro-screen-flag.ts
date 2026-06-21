import { APP_QUESTIONNAIRES_INTRO_SCREEN_FLAG } from '@/lib/app/questionnaire/constants';
import type { SeedUnit } from '@/prisma/runner';

/**
 * Seeds the respondent intro / splash screen sub-flag, DISABLED by default.
 *
 * When on: an admin can opt a version into a pre-questionnaire intro screen (config.intro.enabled)
 * that explains how it works (adapts to the presentation mode), what the respondent receives at the
 * end (adapts to the respondent-report settings), and an admin-authored "about this questionnaire"
 * background section (optionally overridden per cohort). Opt-in on top of APP_QUESTIONNAIRES_ENABLED
 * AND the per-version toggle. When off, the admin Intro card hides and the respondent surface skips
 * straight into the questionnaire.
 *
 * App seed: `SeedHistory` key `app-questionnaire/048-intro-screen-flag`. Idempotent (`update: {}`).
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/048-intro-screen-flag',
  async run({ prisma, logger }) {
    logger.info('🚩 Seeding APP_QUESTIONNAIRES_INTRO_SCREEN_ENABLED feature flag...');

    await prisma.featureFlag.upsert({
      where: { name: APP_QUESTIONNAIRES_INTRO_SCREEN_FLAG },
      update: {},
      create: {
        name: APP_QUESTIONNAIRES_INTRO_SCREEN_FLAG,
        description:
          'Enables the ConQuest respondent intro / splash screen — an admin opt-in screen shown ' +
          'before the questionnaire starts (how it works, what the respondent gets at the end, and ' +
          'an admin-authored background section, optionally overridden per cohort). Opt-in on top of ' +
          'APP_QUESTIONNAIRES_ENABLED and the per-version toggle. Disabled by default.',
        enabled: false,
      },
    });

    logger.info(`✅ Ensured ${APP_QUESTIONNAIRES_INTRO_SCREEN_FLAG} flag (disabled by default)`);
  },
};

export default unit;
