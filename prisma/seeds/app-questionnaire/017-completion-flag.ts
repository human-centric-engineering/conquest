import { APP_QUESTIONNAIRES_COMPLETION_FLAG } from '@/lib/app/questionnaire/constants';
import type { SeedUnit } from '@/prisma/runner';

/**
 * Seeds the F4.5 completion sub-flag, DISABLED by default.
 *
 * Composing the offer-to-submit message runs a structured LLM completion — real
 * per-offer spend. So it's gated behind its own flag on top of the master app gate
 * (`APP_QUESTIONNAIRES_ENABLED`): an operator opts in deliberately.
 *
 * Unlike the other questionnaire sub-flags, while off the completion-status route does
 * NOT 404: the deterministic completion *assessment* stays available under the master
 * flag, and only the LLM offer *phrasing* is gated — so the route returns the
 * assessment without a composed offer.
 *
 * App seed: lives under `prisma/seeds/app-questionnaire/`, found by the recursive
 * runner; its `SeedHistory` key is `app-questionnaire/017-completion-flag`. Idempotent
 * (`update: {}`) so re-seeding never clobbers an operator's toggle.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/017-completion-flag',
  async run({ prisma, logger }) {
    logger.info('🚩 Seeding APP_QUESTIONNAIRES_COMPLETION_ENABLED feature flag...');

    await prisma.featureFlag.upsert({
      where: { name: APP_QUESTIONNAIRES_COMPLETION_FLAG },
      update: {},
      create: {
        name: APP_QUESTIONNAIRES_COMPLETION_FLAG,
        description:
          'Enables ConQuest completion-offer composition (a structured LLM call that phrases the ' +
          'offer to submit once the deterministic gate decides a respondent is done). Opt-in on ' +
          'top of APP_QUESTIONNAIRES_ENABLED because it incurs per-offer spend. When off, the ' +
          'completion-status route still returns the deterministic assessment, just without a ' +
          'composed offer. Disabled by default.',
        enabled: false,
      },
    });

    logger.info(`✅ Ensured ${APP_QUESTIONNAIRES_COMPLETION_FLAG} flag (disabled by default)`);
  },
};

export default unit;
