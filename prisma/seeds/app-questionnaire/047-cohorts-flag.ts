import { APP_QUESTIONNAIRES_COHORTS_FLAG } from '@/lib/app/questionnaire/constants';
import type { SeedUnit } from '@/prisma/runner';

/**
 * Seeds the Cohorts & Rounds sub-flag, DISABLED by default.
 *
 * When on: the Demo Clients section gains Cohorts + Rounds tabs (group people into cohorts, deliver
 * questionnaires to them as time-bound rounds), and the respondent session guard enforces a round's
 * window + active membership. Opt-in on top of APP_QUESTIONNAIRES_ENABLED. When off, the admin
 * routes/tabs hide and the guard is inert (no session carries a `roundId`).
 *
 * App seed: `SeedHistory` key `app-questionnaire/047-cohorts-flag`. Idempotent (`update: {}`).
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/047-cohorts-flag',
  async run({ prisma, logger }) {
    logger.info('🚩 Seeding APP_QUESTIONNAIRES_COHORTS_ENABLED feature flag...');

    await prisma.featureFlag.upsert({
      where: { name: APP_QUESTIONNAIRES_COHORTS_FLAG },
      update: {},
      create: {
        name: APP_QUESTIONNAIRES_COHORTS_FLAG,
        description:
          'Enables ConQuest Cohorts & Rounds — grouping people into cohorts under a demo client and ' +
          'delivering questionnaires to them as time-bound rounds (the only way to make a ' +
          'questionnaire time-bound). Opt-in on top of APP_QUESTIONNAIRES_ENABLED. Disabled by default.',
        enabled: false,
      },
    });

    logger.info(`✅ Ensured ${APP_QUESTIONNAIRES_COHORTS_FLAG} flag (disabled by default)`);
  },
};

export default unit;
