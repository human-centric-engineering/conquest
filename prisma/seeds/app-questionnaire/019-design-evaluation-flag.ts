import { APP_QUESTIONNAIRES_DESIGN_EVALUATION_FLAG } from '@/lib/app/questionnaire/constants';
import type { SeedUnit } from '@/prisma/runner';

/**
 * Seeds the F5.1 design-time evaluation sub-flag, DISABLED by default.
 *
 * Running the judge panel dispatches seven structured LLM completions (one per
 * dimension) — real per-run spend. So it's gated behind its own flag on top of the
 * master app gate (`APP_QUESTIONNAIRES_ENABLED`): an operator opts in deliberately.
 *
 * Unlike the F4.5 completion flag, while off the evaluate-preview route 404s entirely:
 * the whole route is paid LLM work, so there is no free deterministic result to fall
 * back to.
 *
 * App seed: lives under `prisma/seeds/app-questionnaire/`, found by the recursive
 * runner; its `SeedHistory` key is `app-questionnaire/019-design-evaluation-flag`.
 * Idempotent (`update: {}`) so re-seeding never clobbers an operator's toggle.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/019-design-evaluation-flag',
  async run({ prisma, logger }) {
    logger.info('🚩 Seeding APP_QUESTIONNAIRES_DESIGN_EVALUATION_ENABLED feature flag...');

    await prisma.featureFlag.upsert({
      where: { name: APP_QUESTIONNAIRES_DESIGN_EVALUATION_FLAG },
      update: {},
      create: {
        name: APP_QUESTIONNAIRES_DESIGN_EVALUATION_FLAG,
        description:
          'Enables ConQuest design-time evaluation (a panel of seven LLM judges that scores a ' +
          "questionnaire version's structure against its goal and audience and proposes edits). " +
          'Opt-in on top of APP_QUESTIONNAIRES_ENABLED because a run incurs seven LLM calls of ' +
          'spend. When off, the evaluate-preview route returns 404. Disabled by default.',
        enabled: false,
      },
    });

    logger.info(
      `✅ Ensured ${APP_QUESTIONNAIRES_DESIGN_EVALUATION_FLAG} flag (disabled by default)`
    );
  },
};

export default unit;
