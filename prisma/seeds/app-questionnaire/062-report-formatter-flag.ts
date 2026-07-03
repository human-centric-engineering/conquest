import { APP_REPORT_FORMATTER_FLAG } from '@/lib/app/questionnaire/constants';
import type { SeedUnit } from '@/prisma/runner';

/**
 * Seeds the Report Formatter flag, DISABLED by default.
 *
 * When on: respondent report generation runs a second-pass formatter agent over the writer's output
 * (re-paragraphing, bullet conversion, AI-ism removal) and stores the result as pre-laid-out prose
 * (`AppRespondentReport.formatted = true`), which the renderers honour verbatim. When off (default):
 * generation is unchanged and the deterministic `splitReportParagraphs` split runs at render. A
 * ship-dark toggle so the two-agent output can be compared before rollout.
 *
 * App seed: `SeedHistory` key `app-questionnaire/062-report-formatter-flag`. Idempotent (`update: {}`).
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/062-report-formatter-flag',
  async run({ prisma, logger }) {
    logger.info('🚩 Seeding APP_REPORT_FORMATTER_ENABLED feature flag...');

    await prisma.featureFlag.upsert({
      where: { name: APP_REPORT_FORMATTER_FLAG },
      update: {},
      create: {
        name: APP_REPORT_FORMATTER_FLAG,
        description:
          'Enables the second-pass Report Formatter — re-paragraphs generated report prose, converts ' +
          'enumerations to bullet lists, and strips AI-isms — over the Respondent Report writer output. ' +
          'Disabled by default (ship-dark).',
        enabled: false,
      },
    });

    logger.info(`✅ Ensured ${APP_REPORT_FORMATTER_FLAG} flag (disabled by default)`);
  },
};

export default unit;
