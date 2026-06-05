import { APP_QUESTIONNAIRES_ANSWER_REFINEMENT_FLAG } from '@/lib/app/questionnaire/constants';
import type { SeedUnit } from '@/prisma/runner';

/**
 * Seeds the F4.4 answer-refinement sub-flag, DISABLED by default.
 *
 * Answer refinement runs a structured LLM completion to decide whether a
 * respondent's captured answers should change — real per-pass spend. So it's gated
 * behind its own flag on top of the master app gate (`APP_QUESTIONNAIRES_ENABLED`):
 * an operator opts in deliberately. While off, the refine-answer route 404s.
 *
 * App seed: lives under `prisma/seeds/app-questionnaire/`, found by the recursive
 * runner; its `SeedHistory` key is `app-questionnaire/014-answer-refinement-flag`.
 * Idempotent (`update: {}`) so re-seeding never clobbers an operator's toggle.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/014-answer-refinement-flag',
  async run({ prisma, logger }) {
    logger.info('🚩 Seeding APP_QUESTIONNAIRES_ANSWER_REFINEMENT_ENABLED feature flag...');

    await prisma.featureFlag.upsert({
      where: { name: APP_QUESTIONNAIRES_ANSWER_REFINEMENT_FLAG },
      update: {},
      create: {
        name: APP_QUESTIONNAIRES_ANSWER_REFINEMENT_FLAG,
        description:
          'Enables ConQuest answer refinement (a structured LLM call that decides whether a ' +
          "respondent's already-captured answers should be updated in light of new context, " +
          'preserving a refinement history). Opt-in on top of APP_QUESTIONNAIRES_ENABLED because ' +
          'it incurs per-pass spend. When off, the refine-answer route 404s. Disabled by default.',
        enabled: false,
      },
    });

    logger.info(
      `✅ Ensured ${APP_QUESTIONNAIRES_ANSWER_REFINEMENT_FLAG} flag (disabled by default)`
    );
  },
};

export default unit;
