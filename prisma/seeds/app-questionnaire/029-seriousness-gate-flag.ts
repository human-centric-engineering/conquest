import { APP_QUESTIONNAIRES_SERIOUSNESS_GATE_FLAG } from '@/lib/app/questionnaire/constants';
import type { SeedUnit } from '@/prisma/runner';

/**
 * Seeds the seriousness / abuse-gate sub-flag, DISABLED by default.
 *
 * When on: each answered turn the extractor flags as non-genuine is judged; a non-serious verdict
 * (preposterous / abusive / off-topic — colloquial/lazy answers stay genuine) is disregarded,
 * strikes the session, escalates a warning, and at the questionnaire's `abuseThreshold` abandons
 * the session (status → abandoned, analytics reason `abuse_threshold_exceeded`). Dark-launches on
 * top of the master app flag and requires the live-sessions flag (it only runs inside the live
 * `/messages` turn loop). When off, nothing changes — answers are taken at face value.
 *
 * App seed: `SeedHistory` key `app-questionnaire/029-seriousness-gate-flag`. Idempotent (`update: {}`).
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/029-seriousness-gate-flag',
  async run({ prisma, logger }) {
    logger.info('🚩 Seeding APP_QUESTIONNAIRES_SERIOUSNESS_GATE_ENABLED feature flag...');

    await prisma.featureFlag.upsert({
      where: { name: APP_QUESTIONNAIRES_SERIOUSNESS_GATE_FLAG },
      update: {},
      create: {
        name: APP_QUESTIONNAIRES_SERIOUSNESS_GATE_FLAG,
        description:
          'Enables the ConQuest seriousness / abuse gate. When on, an answer the extractor flags ' +
          'as non-genuine (preposterous / abusive / off-topic) is judged by a dedicated LLM; a ' +
          'non-serious verdict is disregarded (never persisted), strikes the session, escalates a ' +
          'polite warning, and at the questionnaire-configured abuseThreshold abandons the session ' +
          '(analytics reason abuse_threshold_exceeded). Colloquial / lazy answers stay genuine. ' +
          'Opt-in on top of APP_QUESTIONNAIRES_ENABLED; also requires ' +
          'APP_QUESTIONNAIRES_LIVE_SESSIONS_ENABLED. Disabled by default.',
        enabled: false,
      },
    });

    logger.info(
      `✅ Ensured ${APP_QUESTIONNAIRES_SERIOUSNESS_GATE_FLAG} flag (disabled by default)`
    );
  },
};

export default unit;
