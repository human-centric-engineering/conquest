import { APP_QUESTIONNAIRES_QUESTION_PHRASING_FLAG } from '@/lib/app/questionnaire/constants';
import type { SeedUnit } from '@/prisma/runner';

/**
 * Seeds the conversational question-phrasing sub-flag, DISABLED by default.
 *
 * When on, the live `/messages` route runs an interviewer pass that renders each asked
 * question as warm, natural prose (acknowledging the prior answer, calibrating to the
 * audience) instead of the verbatim prompt. It spends one extra LLM call per asked question,
 * so it dark-launches behind its own flag on top of the master + live-sessions gates — an
 * operator opts in deliberately. When off, the route surfaces the verbatim prompt exactly as
 * before (no extra spend, no behaviour change).
 *
 * App seed: lives under `prisma/seeds/app-questionnaire/`, found by the recursive runner; its
 * `SeedHistory` key is `app-questionnaire/027-question-phrasing-flag`. Idempotent (`update: {}`)
 * so re-seeding never clobbers an operator's toggle.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/027-question-phrasing-flag',
  async run({ prisma, logger }) {
    logger.info('🚩 Seeding APP_QUESTIONNAIRES_QUESTION_PHRASING_ENABLED feature flag...');

    await prisma.featureFlag.upsert({
      where: { name: APP_QUESTIONNAIRES_QUESTION_PHRASING_FLAG },
      update: {},
      create: {
        name: APP_QUESTIONNAIRES_QUESTION_PHRASING_FLAG,
        description:
          'Enables ConQuest conversational question phrasing (the interviewer pass that renders ' +
          'each asked question as warm, natural prose — acknowledging the prior answer and ' +
          'calibrating tone to the audience — instead of the verbatim prompt). Opt-in on top of ' +
          'APP_QUESTIONNAIRES_ENABLED + APP_QUESTIONNAIRES_LIVE_SESSIONS_ENABLED because it spends ' +
          'one extra LLM call per asked question. When off, the live turn loop surfaces the raw ' +
          'question prompt (no extra spend). Disabled by default.',
        enabled: false,
      },
    });

    logger.info(
      `✅ Ensured ${APP_QUESTIONNAIRES_QUESTION_PHRASING_FLAG} flag (disabled by default)`
    );
  },
};

export default unit;
