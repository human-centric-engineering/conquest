import { APP_QUESTIONNAIRES_COHORT_REPORT_FLAG } from '@/lib/app/questionnaire/constants';
import type { SeedUnit } from '@/prisma/runner';

/**
 * Seeds the Cohort Report sub-flag (report kind `cohort`), DISABLED by default.
 *
 * When on (AND APP_QUESTIONNAIRES_COHORTS_ENABLED — cohort reports are round-scoped): a round's
 * detail page shows the "Cohort report" surface for configuring + generating the cross-respondent
 * analysis/charting/narrative over that round's submissions. The sibling of the per-respondent
 * Respondent Report (`044-respondent-report-flag.ts`). Opt-in on top of APP_QUESTIONNAIRES_ENABLED.
 * When off, the round cohort-report routes/tab `404`/hide.
 *
 * App seed: `SeedHistory` key `app-questionnaire/054-cohort-report-flag`. Idempotent (`update: {}`).
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/054-cohort-report-flag',
  async run({ prisma, logger }) {
    logger.info('🚩 Seeding APP_QUESTIONNAIRES_COHORT_REPORT_ENABLED feature flag...');

    await prisma.featureFlag.upsert({
      where: { name: APP_QUESTIONNAIRES_COHORT_REPORT_FLAG },
      update: {},
      create: {
        name: APP_QUESTIONNAIRES_COHORT_REPORT_FLAG,
        description:
          'Enables the ConQuest Cohort Report — the cross-respondent analysis, charting and ' +
          'narrative an admin generates over one round of submissions, segmented by the ' +
          "questionnaire's own demographics. Round-scoped, so it also requires " +
          'APP_QUESTIONNAIRES_COHORTS_ENABLED. Opt-in on top of APP_QUESTIONNAIRES_ENABLED. ' +
          'Disabled by default.',
        enabled: false,
      },
    });

    logger.info(`✅ Ensured ${APP_QUESTIONNAIRES_COHORT_REPORT_FLAG} flag (disabled by default)`);
  },
};

export default unit;
