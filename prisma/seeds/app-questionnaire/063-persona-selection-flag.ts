import { APP_QUESTIONNAIRES_PERSONA_SELECTION_FLAG } from '@/lib/app/questionnaire/constants';
import type { SeedUnit } from '@/prisma/runner';

/**
 * Seeds the Selectable Interviewer Personas sub-flag (F-persona), DISABLED by default.
 *
 * When on: an admin can enable a per-version persona *library* and let respondents choose which
 * interviewer they engage with — via a dedicated "Choose your interviewer" carousel step and an
 * in-chat switcher. The chosen persona's voice replaces the version's tone for that session
 * (`resolveEffectiveTone`). ANDs with the per-version `personaSelection.enabled` toggle. When off,
 * the persona step/switcher never render and the version's own tone prevails — nothing changes.
 *
 * App seed: `SeedHistory` key `app-questionnaire/063-persona-selection-flag`. Idempotent (`update: {}`).
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/063-persona-selection-flag',
  async run({ prisma, logger }) {
    logger.info('🚩 Seeding APP_QUESTIONNAIRES_PERSONA_SELECTION_ENABLED feature flag...');

    await prisma.featureFlag.upsert({
      where: { name: APP_QUESTIONNAIRES_PERSONA_SELECTION_FLAG },
      update: {},
      create: {
        name: APP_QUESTIONNAIRES_PERSONA_SELECTION_FLAG,
        description:
          'Enables ConQuest selectable interviewer personas — a fixed library of built-in personas ' +
          'plus a respondent-facing picker (carousel step + in-chat switcher) that lets a respondent ' +
          'choose which interviewer they engage with. Opt-in on top of APP_QUESTIONNAIRES_ENABLED. ' +
          'Disabled by default.',
        enabled: false,
      },
    });

    logger.info(
      `✅ Ensured ${APP_QUESTIONNAIRES_PERSONA_SELECTION_FLAG} flag (disabled by default)`
    );
  },
};

export default unit;
