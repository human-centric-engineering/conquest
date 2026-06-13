import { APP_QUESTIONNAIRES_SENSITIVITY_AWARENESS_FLAG } from '@/lib/app/questionnaire/constants';
import type { SeedUnit } from '@/prisma/runner';

/**
 * Seeds the sensitivity-awareness / safeguarding sub-flag, DISABLED by default.
 *
 * When on (AND a version opts in via `config.sensitivityAwareness`): each answered turn the
 * extractor also flags a genuine sensitive/contentious disclosure (abuse, distress, safeguarding);
 * the session remembers it (running-max level + careful, non-graphic notes), every later question
 * is phrased more gently, and a serious disclosure signposts the configured support message once.
 * Dark-launches on top of the master app flag and requires the live-sessions flag (it only runs
 * inside the live `/messages` turn loop). When off, nothing changes — no detection, no tone shift.
 *
 * App seed: `SeedHistory` key `app-questionnaire/032-sensitivity-awareness-flag`. Idempotent.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/032-sensitivity-awareness-flag',
  async run({ prisma, logger }) {
    logger.info('🚩 Seeding APP_QUESTIONNAIRES_SENSITIVITY_AWARENESS_ENABLED feature flag...');

    await prisma.featureFlag.upsert({
      where: { name: APP_QUESTIONNAIRES_SENSITIVITY_AWARENESS_FLAG },
      update: {},
      create: {
        name: APP_QUESTIONNAIRES_SENSITIVITY_AWARENESS_FLAG,
        description:
          'Enables ConQuest sensitivity awareness / safeguarding. When on (and a version opts in ' +
          'via its sensitivityAwareness config), the answer extractor also flags a genuine ' +
          'sensitive/contentious disclosure (abuse, distress, safeguarding); the session remembers ' +
          'it (running-max level + careful non-graphic notes), every later question is phrased more ' +
          'gently, and a serious disclosure signposts the configured support message once. Opt-in ' +
          'on top of APP_QUESTIONNAIRES_ENABLED; also requires APP_QUESTIONNAIRES_LIVE_SESSIONS_ENABLED. ' +
          'Best-effort awareness, not a guaranteed safeguarding net. Disabled by default.',
        enabled: false,
      },
    });

    logger.info(
      `✅ Ensured ${APP_QUESTIONNAIRES_SENSITIVITY_AWARENESS_FLAG} flag (disabled by default)`
    );
  },
};

export default unit;
