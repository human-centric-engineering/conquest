import { APP_QUESTIONNAIRES_DATA_SLOTS_FLAG } from '@/lib/app/questionnaire/constants';
import type { SeedUnit } from '@/prisma/runner';

/**
 * Seeds the Data Slots sub-flag, DISABLED by default.
 *
 * When on: the admin can generate + review data slots, launch requires them, and a launched
 * questionnaire with data slots runs its live session in data-slot mode (the conversation
 * targets data slots; questions fill in the background). Dark-launches on top of the master
 * app flag; the runtime mode additionally requires the live-sessions flag. When off, nothing
 * changes — questionnaires run today's question-driven conversation.
 *
 * App seed: `SeedHistory` key `app-questionnaire/028-data-slots-flag`. Idempotent (`update: {}`).
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/028-data-slots-flag',
  async run({ prisma, logger }) {
    logger.info('🚩 Seeding APP_QUESTIONNAIRES_DATA_SLOTS_ENABLED feature flag...');

    await prisma.featureFlag.upsert({
      where: { name: APP_QUESTIONNAIRES_DATA_SLOTS_FLAG },
      update: {},
      create: {
        name: APP_QUESTIONNAIRES_DATA_SLOTS_FLAG,
        description:
          'Enables ConQuest Data Slots (the semantic abstraction layer over questions). When on, ' +
          'admins generate + review short data slots that abstract over the questions, launch ' +
          'requires them, and live sessions run in data-slot mode (the conversation targets data ' +
          'slots while questions fill in the background). Opt-in on top of APP_QUESTIONNAIRES_ENABLED; ' +
          'the runtime mode also requires APP_QUESTIONNAIRES_LIVE_SESSIONS_ENABLED. Disabled by default.',
        enabled: false,
      },
    });

    logger.info(`✅ Ensured ${APP_QUESTIONNAIRES_DATA_SLOTS_FLAG} flag (disabled by default)`);
  },
};

export default unit;
