import { APP_QUESTIONNAIRES_ROUND_PHASES_FLAG } from '@/lib/app/questionnaire/constants';
import type { SeedUnit } from '@/prisma/runner';

/**
 * Seeds the Round Phases sub-flag, DISABLED by default.
 *
 * When on: a round can stagger access by cohort subgroup — one subgroup (e.g. the Senior Leadership
 * Team) takes the round before the rest of the cohort. A subgroup is reusable cohort config
 * (`AppCohortSubgroup`); a round attaches a window + end mode to it (`AppRoundPhase`). Requires
 * APP_QUESTIONNAIRES_ENABLED AND APP_QUESTIONNAIRES_COHORTS_ENABLED. When off, the subgroup/phase
 * authoring routes + panels 404/hide and the respondent access guard falls back to the round's own
 * window for everyone (today's behaviour).
 *
 * App seed: `SeedHistory` key `app-questionnaire/053-round-phases-flag`. Idempotent (`update: {}`).
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/053-round-phases-flag',
  async run({ prisma, logger }) {
    logger.info('🚩 Seeding APP_QUESTIONNAIRES_ROUND_PHASES_ENABLED feature flag...');

    await prisma.featureFlag.upsert({
      where: { name: APP_QUESTIONNAIRES_ROUND_PHASES_FLAG },
      update: {},
      create: {
        name: APP_QUESTIONNAIRES_ROUND_PHASES_FLAG,
        description:
          'Enables ConQuest Round Phases — staggered access windows for cohort subgroups, so one ' +
          'subgroup (e.g. the Senior Leadership Team) can take a round before the rest of the cohort. ' +
          'Subgroups are reusable cohort config; a round attaches a window + end mode to each. ' +
          'Requires APP_QUESTIONNAIRES_ENABLED and APP_QUESTIONNAIRES_COHORTS_ENABLED. Disabled by default.',
        enabled: false,
      },
    });

    logger.info(`✅ Ensured ${APP_QUESTIONNAIRES_ROUND_PHASES_FLAG} flag (disabled by default)`);
  },
};

export default unit;
