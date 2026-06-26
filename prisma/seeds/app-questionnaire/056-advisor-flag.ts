import { APP_QUESTIONNAIRES_ADVISOR_FLAG } from '@/lib/app/questionnaire/constants';
import type { SeedUnit } from '@/prisma/runner';

/**
 * Seeds the Config Advisor sub-flag, DISABLED by default.
 *
 * When on: the version Settings tab shows an admin-triggered AI advisor that reads the whole
 * questionnaire (structure, goal/audience, run-time config, data slots, scoring), streams a
 * narrative describing the respondent experience the current config produces and the current
 * lifecycle state, and proposes one-click config tweaks. Each run is two reasoning LLM calls, so
 * it dark-launches on top of the master app flag. When off, the advisor route 404s and the panel
 * is hidden — nothing else changes.
 *
 * App seed: `SeedHistory` key `app-questionnaire/056-advisor-flag`. Idempotent (`update: {}`).
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/056-advisor-flag',
  async run({ prisma, logger }) {
    logger.info('🚩 Seeding APP_QUESTIONNAIRES_ADVISOR_ENABLED feature flag...');

    await prisma.featureFlag.upsert({
      where: { name: APP_QUESTIONNAIRES_ADVISOR_FLAG },
      update: {},
      create: {
        name: APP_QUESTIONNAIRES_ADVISOR_FLAG,
        description:
          'Enables the ConQuest Config Advisor — an admin-triggered AI panel on the version ' +
          'Settings tab that evaluates the whole questionnaire configuration, streams a narrative ' +
          'of the respondent experience + lifecycle state, and proposes one-click tweaks. Opt-in ' +
          'on top of APP_QUESTIONNAIRES_ENABLED; each run is two reasoning LLM calls. Disabled by ' +
          'default.',
        enabled: false,
      },
    });

    logger.info(`✅ Ensured ${APP_QUESTIONNAIRES_ADVISOR_FLAG} flag (disabled by default)`);
  },
};

export default unit;
