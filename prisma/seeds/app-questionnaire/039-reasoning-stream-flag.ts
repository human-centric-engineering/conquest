import { APP_QUESTIONNAIRES_REASONING_STREAM_FLAG } from '@/lib/app/questionnaire/constants';
import type { SeedUnit } from '@/prisma/runner';

/**
 * Seeds the Reasoning Stream sub-flag, DISABLED by default.
 *
 * When on: the respondent chat shows a live "watch it think" reasoning trace beside the
 * conversation — answers captured (with provenance + confidence), contradictions spotted, and why
 * the next question was chosen — derived from work the per-turn orchestrator already does (no extra
 * LLM cost). Depends on live-sessions (it only matters inside the `/messages` turn loop) and ANDs
 * with the per-version `reasoningStreamEnabled` config toggle. When off, turns emit no `reasoning`
 * frames and the feed never renders — nothing else changes.
 *
 * App seed: `SeedHistory` key `app-questionnaire/039-reasoning-stream-flag`.
 * Idempotent (`update: {}`).
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/039-reasoning-stream-flag',
  async run({ prisma, logger }) {
    logger.info('🚩 Seeding APP_QUESTIONNAIRES_REASONING_STREAM_ENABLED feature flag...');

    await prisma.featureFlag.upsert({
      where: { name: APP_QUESTIONNAIRES_REASONING_STREAM_FLAG },
      update: {},
      create: {
        name: APP_QUESTIONNAIRES_REASONING_STREAM_FLAG,
        description:
          'Enables the ConQuest live "watch it think" reasoning stream — the per-turn reasoning ' +
          'trace shown beside the respondent chat. Opt-in on top of APP_QUESTIONNAIRES_ENABLED and ' +
          'live sessions; carries no extra LLM cost (derived from work the turn already did). ' +
          'Disabled by default.',
        enabled: false,
      },
    });

    logger.info(
      `✅ Ensured ${APP_QUESTIONNAIRES_REASONING_STREAM_FLAG} flag (disabled by default)`
    );
  },
};

export default unit;
