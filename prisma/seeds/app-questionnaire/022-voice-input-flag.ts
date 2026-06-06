import { APP_QUESTIONNAIRES_VOICE_INPUT_FLAG } from '@/lib/app/questionnaire/constants';
import type { SeedUnit } from '@/prisma/runner';

/**
 * Seeds the F6.2 voice-input sub-flag, DISABLED by default.
 *
 * Voice input adds the respondent transcribe endpoint
 * (`POST /api/v1/app/questionnaire-sessions/:id/transcribe`) that turns recorded audio into text
 * via Sunrise's audio provider (OpenAI Whisper). Every call spends per-minute transcription cost,
 * so it opts in behind its own flag on top of the master app gate (`APP_QUESTIONNAIRES_ENABLED`)
 * AND the live-sessions flag — voice depends on the live respondent surface (a transcript is only
 * useful if it can then be sent through the live `/messages` turn loop). When off, the transcribe
 * route 404s.
 *
 * App seed: lives under `prisma/seeds/app-questionnaire/`, found by the recursive runner; its
 * `SeedHistory` key is `app-questionnaire/022-voice-input-flag`. Idempotent (`update: {}`) so
 * re-seeding never clobbers an operator's toggle.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/022-voice-input-flag',
  async run({ prisma, logger }) {
    logger.info('🚩 Seeding APP_QUESTIONNAIRES_VOICE_INPUT_ENABLED feature flag...');

    await prisma.featureFlag.upsert({
      where: { name: APP_QUESTIONNAIRES_VOICE_INPUT_FLAG },
      update: {},
      create: {
        name: APP_QUESTIONNAIRES_VOICE_INPUT_FLAG,
        description:
          'Enables ConQuest voice input — the respondent transcribe endpoint that turns recorded ' +
          'audio into text via the configured audio provider (OpenAI Whisper). Opt-in on top of ' +
          'APP_QUESTIONNAIRES_ENABLED and APP_QUESTIONNAIRES_LIVE_SESSIONS_ENABLED (voice depends ' +
          'on the live respondent surface) because every call spends per-minute transcription ' +
          'cost. When off, the transcribe route returns 404. Disabled by default.',
        enabled: false,
      },
    });

    logger.info(`✅ Ensured ${APP_QUESTIONNAIRES_VOICE_INPUT_FLAG} flag (disabled by default)`);
  },
};

export default unit;
