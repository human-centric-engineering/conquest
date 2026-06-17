import { APP_QUESTIONNAIRES_TURN_EVALUATION_FLAG } from '@/lib/app/questionnaire/constants';
import type { SeedUnit } from '@/prisma/runner';

/**
 * Seeds the turn-evaluation sub-flag, DISABLED by default.
 *
 * The turn evaluator dispatches one reasoning-model completion per run — real per-run spend.
 * So it's gated behind its own flag on top of the master app gate
 * (`APP_QUESTIONNAIRES_ENABLED`): an operator opts in deliberately.
 *
 * Like the design-evaluation flag, while off the evaluate-turn route 404s entirely: the whole
 * route is paid LLM work, so there is no free deterministic result to fall back to. The route
 * additionally requires the session to be a preview (the same gate the inspector enforces).
 *
 * App seed: lives under `prisma/seeds/app-questionnaire/`, found by the recursive runner; its
 * `SeedHistory` key is `app-questionnaire/042-turn-evaluation-flag`. Idempotent (`update: {}`)
 * so re-seeding never clobbers an operator's toggle.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/042-turn-evaluation-flag',
  async run({ prisma, logger }) {
    logger.info('🚩 Seeding APP_QUESTIONNAIRES_TURN_EVALUATION_ENABLED feature flag...');

    await prisma.featureFlag.upsert({
      where: { name: APP_QUESTIONNAIRES_TURN_EVALUATION_FLAG },
      update: {},
      create: {
        name: APP_QUESTIONNAIRES_TURN_EVALUATION_FLAG,
        description:
          'Enables the ConQuest turn evaluator (an admin-only interview-quality evaluator the ' +
          'Preview Turn Inspector runs over one completed turn, scoring instruction compliance, ' +
          'interviewing/extraction/selection quality, information gain, missed opportunities, ' +
          'prompt drift, and cost/efficiency). Opt-in on top of APP_QUESTIONNAIRES_ENABLED ' +
          'because a run incurs one reasoning-model LLM call of spend. When off, the ' +
          'evaluate-turn route returns 404. Disabled by default.',
        enabled: false,
      },
    });

    logger.info(`✅ Ensured ${APP_QUESTIONNAIRES_TURN_EVALUATION_FLAG} flag (disabled by default)`);
  },
};

export default unit;
