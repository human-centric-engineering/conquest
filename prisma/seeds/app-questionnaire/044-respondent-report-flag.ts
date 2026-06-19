import { APP_QUESTIONNAIRES_RESPONDENT_REPORT_FLAG } from '@/lib/app/questionnaire/constants';
import type { SeedUnit } from '@/prisma/runner';

/**
 * Seeds the Respondent Report sub-flag (report kind `respondent`), DISABLED by default.
 *
 * When on: the questionnaire workspace shows the "Respondent report" tab (between Invitations and
 * Analytics) for configuring the per-respondent summary delivered after a respondent completes the
 * questionnaire. Opt-in on top of APP_QUESTIONNAIRES_ENABLED. The later cross-respondent Cohort
 * Report gets its own flag when built. When off, the tab is hidden and the page `notFound()`s.
 *
 * App seed: `SeedHistory` key `app-questionnaire/044-respondent-report-flag`. Idempotent (`update: {}`).
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/044-respondent-report-flag',
  async run({ prisma, logger }) {
    logger.info('🚩 Seeding APP_QUESTIONNAIRES_RESPONDENT_REPORT_ENABLED feature flag...');

    await prisma.featureFlag.upsert({
      where: { name: APP_QUESTIONNAIRES_RESPONDENT_REPORT_FLAG },
      update: {},
      create: {
        name: APP_QUESTIONNAIRES_RESPONDENT_REPORT_FLAG,
        description:
          'Enables the ConQuest Respondent Report — the per-respondent summary delivered after a ' +
          'respondent completes the questionnaire, configured from its own workspace tab. Opt-in on ' +
          'top of APP_QUESTIONNAIRES_ENABLED. Disabled by default.',
        enabled: false,
      },
    });

    logger.info(
      `✅ Ensured ${APP_QUESTIONNAIRES_RESPONDENT_REPORT_FLAG} flag (disabled by default)`
    );
  },
};

export default unit;
