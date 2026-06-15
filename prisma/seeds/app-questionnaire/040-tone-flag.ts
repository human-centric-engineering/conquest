import { APP_QUESTIONNAIRES_TONE_FLAG } from '@/lib/app/questionnaire/constants';
import type { SeedUnit } from '@/prisma/runner';

/**
 * Seeds the Interviewer Tone & Persona sub-flag (F-tone), DISABLED by default.
 *
 * When on: per-version tone sliders (empathy, mirroring, formality, mimicry, verbosity, warmth,
 * curiosity, reading complexity, humour) plus a free-text persona shape how the conversational
 * interviewer responds — fed into the phraser's system prompt at turn time (`buildToneInstructions`).
 * Depends on live-sessions (it only matters inside the `/messages` turn loop) and ANDs with each
 * per-version dimension toggle. When off, the interviewer keeps its default voice — nothing changes.
 *
 * App seed: `SeedHistory` key `app-questionnaire/040-tone-flag`. Idempotent (`update: {}`).
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/040-tone-flag',
  async run({ prisma, logger }) {
    logger.info('🚩 Seeding APP_QUESTIONNAIRES_TONE_ENABLED feature flag...');

    await prisma.featureFlag.upsert({
      where: { name: APP_QUESTIONNAIRES_TONE_FLAG },
      update: {},
      create: {
        name: APP_QUESTIONNAIRES_TONE_FLAG,
        description:
          'Enables ConQuest interviewer tone & persona — the per-version sliders (empathy, ' +
          'mirroring, formality, mimicry, verbosity, warmth, curiosity, reading complexity, humour) ' +
          'and free-text persona that shape how the conversational interviewer responds. Opt-in on ' +
          'top of APP_QUESTIONNAIRES_ENABLED and live sessions. Disabled by default.',
        enabled: false,
      },
    });

    logger.info(`✅ Ensured ${APP_QUESTIONNAIRES_TONE_FLAG} flag (disabled by default)`);
  },
};

export default unit;
