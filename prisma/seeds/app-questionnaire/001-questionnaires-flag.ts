import { APP_QUESTIONNAIRES_FLAG } from '@/lib/app/questionnaire/constants';
import type { SeedUnit } from '@/prisma/runner';

/**
 * Seeds the master feature flag gating the ConQuest questionnaire app,
 * DISABLED by default. Every `/api/v1/app/**` route and admin/user surface
 * checks this flag; until an operator flips it on, the app is dark.
 *
 * App seed: lives under `prisma/seeds/app-questionnaire/` and is found by the
 * recursive runner. Its `SeedHistory` key is the relative path
 * `app-questionnaire/001-questionnaires-flag`, so it never collides with core
 * seeds. Idempotent (`update: {}`) so re-seeding never clobbers an operator's
 * toggle. We upsert directly rather than touch the platform-owned
 * `DEFAULT_FLAGS` list.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/001-questionnaires-flag',
  async run({ prisma, logger }) {
    logger.info('🚩 Seeding APP_QUESTIONNAIRES_ENABLED feature flag...');

    await prisma.featureFlag.upsert({
      where: { name: APP_QUESTIONNAIRES_FLAG },
      update: {},
      create: {
        name: APP_QUESTIONNAIRES_FLAG,
        description:
          'Master gate for the ConQuest questionnaire app. When off, every ' +
          '/api/v1/app/** route returns 404 and the admin/user surfaces are ' +
          'hidden. Disabled by default — flip on to expose the app.',
        enabled: false,
      },
    });

    logger.info(`✅ Ensured ${APP_QUESTIONNAIRES_FLAG} flag (disabled by default)`);
  },
};

export default unit;
