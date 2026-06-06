import { APP_QUESTIONNAIRES_LIVE_SESSIONS_FLAG } from '@/lib/app/questionnaire/constants';
import type { SeedUnit } from '@/prisma/runner';

/**
 * Seeds the F6.1 live respondent-sessions sub-flag, DISABLED by default.
 *
 * The live surface (create a session, stream a turn, get a reply) spends LLM calls per
 * turn AND exposes a respondent-facing surface — including the no-login anonymous path
 * (PR5). So it dark-launches behind its own flag on top of the master app gate
 * (`APP_QUESTIONNAIRES_ENABLED`): an operator opts in deliberately, independently of the
 * admin preview routes (which run under the master flag alone). When off, the
 * session-create + messages routes 404.
 *
 * App seed: lives under `prisma/seeds/app-questionnaire/`, found by the recursive runner;
 * its `SeedHistory` key is `app-questionnaire/021-live-sessions-flag`. Idempotent
 * (`update: {}`) so re-seeding never clobbers an operator's toggle.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/021-live-sessions-flag',
  async run({ prisma, logger }) {
    logger.info('🚩 Seeding APP_QUESTIONNAIRES_LIVE_SESSIONS_ENABLED feature flag...');

    await prisma.featureFlag.upsert({
      where: { name: APP_QUESTIONNAIRES_LIVE_SESSIONS_FLAG },
      update: {},
      create: {
        name: APP_QUESTIONNAIRES_LIVE_SESSIONS_FLAG,
        description:
          'Enables ConQuest live respondent sessions (the streaming per-turn surface a real ' +
          'respondent drives: create a session, send messages, get a streamed reply). Opt-in on ' +
          'top of APP_QUESTIONNAIRES_ENABLED because it spends LLM calls per turn and exposes a ' +
          'respondent-facing surface (incl. the no-login anonymous path). When off, the ' +
          'session-create and messages routes return 404. Disabled by default.',
        enabled: false,
      },
    });

    logger.info(`✅ Ensured ${APP_QUESTIONNAIRES_LIVE_SESSIONS_FLAG} flag (disabled by default)`);
  },
};

export default unit;
