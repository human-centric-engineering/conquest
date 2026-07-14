import { APP_QUESTIONNAIRES_REPORT_WEB_SEARCH_FLAG } from '@/lib/app/questionnaire/constants';
import type { SeedUnit } from '@/prisma/runner';

/**
 * Seeds the report web-search rounds sub-flag, DISABLED by default (dark launch).
 *
 * When on: report configuration exposes the "Research" tab, and report generation may run web-search
 * rounds before/after generation. Opt-in on top of APP_QUESTIONNAIRES_ENABLED and the per-report-kind
 * flag; additionally requires the search backend to be configured (Brave key + allowlisted host) — the
 * feature is inert and skipped otherwise, never failing a report. When off, the Research tab is hidden
 * and no search round runs.
 *
 * App seed: `SeedHistory` key `app-questionnaire/069-report-web-search-flag`. Idempotent (`update: {}`).
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/069-report-web-search-flag',
  async run({ prisma, logger }) {
    logger.info('🚩 Seeding APP_QUESTIONNAIRES_REPORT_WEB_SEARCH_ENABLED feature flag...');

    await prisma.featureFlag.upsert({
      where: { name: APP_QUESTIONNAIRES_REPORT_WEB_SEARCH_FLAG },
      update: {},
      create: {
        name: APP_QUESTIONNAIRES_REPORT_WEB_SEARCH_FLAG,
        description:
          'Enables optional web-search rounds in ConQuest report generation — the report research ' +
          'agent gathers live external context before/after a report is written and surfaces it as a ' +
          'Research section. Opt-in on top of APP_QUESTIONNAIRES_ENABLED + the report-kind flag, and ' +
          'requires a configured search backend (BRAVE_SEARCH_API_KEY + allowlisted host). Disabled by default.',
        enabled: false,
      },
    });

    logger.info(
      `✅ Ensured ${APP_QUESTIONNAIRES_REPORT_WEB_SEARCH_FLAG} flag (disabled by default)`
    );
  },
};

export default unit;
