import { APP_QUESTIONNAIRES_LEARNING_MODE_FLAG } from '@/lib/app/questionnaire/constants';
import type { SeedUnit } from '@/prisma/runner';

/**
 * Seeds the Learning Mode sub-flag, DISABLED by default.
 *
 * When on: the interviewer is given generalised, anonymised themes from prior respondents *in the
 * same round* and uses them subtly — colouring phrasing ("some respondents mentioned X — how do you
 * feel about that?") and, under the adaptive strategy, probing divergent topics harder. Requires
 * APP_QUESTIONNAIRES_ENABLED AND APP_QUESTIONNAIRES_COHORTS_ENABLED. The per-round `learningEnabled`
 * toggle plus a k-anonymity threshold are the further gates. **Introduces bias by design** (later
 * answers are influenced by earlier ones) — the admin UI warns. When off, nothing is aggregated or
 * injected.
 *
 * App seed: `SeedHistory` key `app-questionnaire/051-learning-mode-flag`. Idempotent (`update: {}`).
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/051-learning-mode-flag',
  async run({ prisma, logger }) {
    logger.info('🚩 Seeding APP_QUESTIONNAIRES_LEARNING_MODE_ENABLED feature flag...');

    await prisma.featureFlag.upsert({
      where: { name: APP_QUESTIONNAIRES_LEARNING_MODE_FLAG },
      update: {},
      create: {
        name: APP_QUESTIONNAIRES_LEARNING_MODE_FLAG,
        description:
          'Enables ConQuest Learning Mode — the interviewer draws on generalised, anonymised themes ' +
          'from prior respondents in the same round to colour phrasing and adaptive probing. ' +
          'Introduces bias by design; gated per-round and by a k-anonymity threshold. Requires ' +
          'APP_QUESTIONNAIRES_ENABLED and APP_QUESTIONNAIRES_COHORTS_ENABLED. Disabled by default.',
        enabled: false,
      },
    });

    logger.info(`✅ Ensured ${APP_QUESTIONNAIRES_LEARNING_MODE_FLAG} flag (disabled by default)`);
  },
};

export default unit;
