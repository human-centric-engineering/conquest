import { APP_QUESTIONNAIRES_COST_CAP_FLAG } from '@/lib/app/questionnaire/constants';
import type { SeedUnit } from '@/prisma/runner';

/**
 * Seeds the F6.3 cost-cap enforcement sub-flag, DISABLED by default.
 *
 * Cost-cap enforcement applies the per-session USD budget (`AppQuestionnaireConfig.costBudgetUsd`)
 * at the live turn boundary: a soft nudge toward wrapping up at ≥90% of budget, and a hard refusal
 * (HTTP 402) + auto-pause at ≥100%. It opts in behind its own flag on top of the master app gate
 * (`APP_QUESTIONNAIRES_ENABLED`) AND the live-sessions flag — the cap is about respondent spend on
 * the live `/messages` turn loop, so it depends on that surface. Disabled by default so a
 * live-sessions deployment runs unmetered until an operator deliberately turns enforcement on (and
 * can switch it off again without touching the live surface). When off, turns run with no budget
 * check even if a version sets `costBudgetUsd`.
 *
 * App seed: lives under `prisma/seeds/app-questionnaire/`, found by the recursive runner; its
 * `SeedHistory` key is `app-questionnaire/023-cost-cap-flag`. Idempotent (`update: {}`) so
 * re-seeding never clobbers an operator's toggle.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/023-cost-cap-flag',
  async run({ prisma, logger }) {
    logger.info('🚩 Seeding APP_QUESTIONNAIRES_COST_CAP_ENABLED feature flag...');

    await prisma.featureFlag.upsert({
      where: { name: APP_QUESTIONNAIRES_COST_CAP_FLAG },
      update: {},
      create: {
        name: APP_QUESTIONNAIRES_COST_CAP_FLAG,
        description:
          'Enables ConQuest cost-cap enforcement — the per-session USD budget enforced at the live ' +
          'turn boundary (soft wrap-up nudge at ≥90%, hard 402 + auto-pause at ≥100%). Opt-in on ' +
          'top of APP_QUESTIONNAIRES_ENABLED and APP_QUESTIONNAIRES_LIVE_SESSIONS_ENABLED (the cap ' +
          'applies to the live /messages turn loop). When off, turns run with no budget check even ' +
          'if a version sets costBudgetUsd. Disabled by default.',
        enabled: false,
      },
    });

    logger.info(`✅ Ensured ${APP_QUESTIONNAIRES_COST_CAP_FLAG} flag (disabled by default)`);
  },
};

export default unit;
