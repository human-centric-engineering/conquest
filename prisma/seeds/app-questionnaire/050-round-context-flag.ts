import { APP_QUESTIONNAIRES_ROUND_CONTEXT_FLAG } from '@/lib/app/questionnaire/constants';
import type { SeedUnit } from '@/prisma/runner';

/**
 * Seeds the Round Additional Context ("interviewer briefing") sub-flag, DISABLED by default.
 *
 * When on: a round's detail page gains a Context panel where admins author facts/figures/background —
 * optionally attributed to a single question — that the interviewer draws on when asking. Requires
 * APP_QUESTIONNAIRES_ENABLED AND APP_QUESTIONNAIRES_COHORTS_ENABLED (briefings hang off rounds). The
 * per-round `contextEnabled` toggle is the second gate; nothing is injected until both are on. When
 * off, the authoring routes/panel 404/hide.
 *
 * App seed: `SeedHistory` key `app-questionnaire/050-round-context-flag`. Idempotent (`update: {}`).
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/050-round-context-flag',
  async run({ prisma, logger }) {
    logger.info('🚩 Seeding APP_QUESTIONNAIRES_ROUND_CONTEXT_ENABLED feature flag...');

    await prisma.featureFlag.upsert({
      where: { name: APP_QUESTIONNAIRES_ROUND_CONTEXT_FLAG },
      update: {},
      create: {
        name: APP_QUESTIONNAIRES_ROUND_CONTEXT_FLAG,
        description:
          'Enables ConQuest Round Additional Context — the per-round "interviewer briefing" of ' +
          'admin-authored facts/figures/background the interviewer draws on when asking, optionally ' +
          'attributed to a single question. Requires APP_QUESTIONNAIRES_ENABLED and ' +
          'APP_QUESTIONNAIRES_COHORTS_ENABLED. Disabled by default.',
        enabled: false,
      },
    });

    logger.info(`✅ Ensured ${APP_QUESTIONNAIRES_ROUND_CONTEXT_FLAG} flag (disabled by default)`);
  },
};

export default unit;
