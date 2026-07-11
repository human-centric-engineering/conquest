import { APP_QUESTIONNAIRES_INGEST_VERIFY_REPAIR_FLAG } from '@/lib/app/questionnaire/constants';
import type { SeedUnit } from '@/prisma/runner';

/**
 * Seeds the ingest verify+repair sub-flag, DISABLED by default.
 *
 * When on, document ingestion runs a critic pass (one reasoning call that flags mis-typed /
 * mis-scaled questions) and, only when questions are flagged, a scales-&-matrix repair specialist
 * (a second call over the flagged subset). Real per-run spend, so it's gated behind its own flag on
 * top of the master app gate (`APP_QUESTIONNAIRES_ENABLED`): an operator opts in deliberately.
 *
 * Unlike the route-level sub-flags, this gates a behaviour *inside* the already-gated streaming
 * ingest route — with it off, ingestion is exactly today's single-extractor behaviour (no 404).
 *
 * App seed: `SeedHistory` key `app-questionnaire/064-ingest-verify-repair-flag`. Idempotent
 * (`update: {}`) so re-seeding never clobbers an operator's toggle.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/064-ingest-verify-repair-flag',
  async run({ prisma, logger }) {
    logger.info('🚩 Seeding APP_QUESTIONNAIRES_INGEST_VERIFY_REPAIR_ENABLED feature flag...');

    await prisma.featureFlag.upsert({
      where: { name: APP_QUESTIONNAIRES_INGEST_VERIFY_REPAIR_FLAG },
      update: {},
      create: {
        name: APP_QUESTIONNAIRES_INGEST_VERIFY_REPAIR_FLAG,
        description:
          'Enables the ConQuest ingest verify + repair pass — a critic that flags extracted ' +
          'questions whose answer type/config is unfaithful to the source (a mis-typed scale, a ' +
          'likert missing its endpoint anchors, a flattened rating grid), and a scales-&-matrix ' +
          'repair specialist that re-extracts only the flagged questions. Opt-in on top of ' +
          'APP_QUESTIONNAIRES_ENABLED because verification spends one reasoning call and repair a ' +
          'second when questions are flagged. When off, ingestion is the single-extractor pass. ' +
          'Disabled by default.',
        enabled: false,
      },
    });

    logger.info(
      `✅ Ensured ${APP_QUESTIONNAIRES_INGEST_VERIFY_REPAIR_FLAG} flag (disabled by default)`
    );
  },
};

export default unit;
