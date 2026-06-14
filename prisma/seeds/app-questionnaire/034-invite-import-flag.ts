import { APP_QUESTIONNAIRES_INVITE_IMPORT_FLAG } from '@/lib/app/questionnaire/constants';
import type { SeedUnit } from '@/prisma/runner';

/**
 * Seeds the invitee-import sub-flag, DISABLED by default.
 *
 * Invite import powers the wizard's CSV/PDF/image methods and the paid LLM people-extraction
 * capability (PDF text + image vision → a list of people). Opt-in on top of the master app flag
 * (`APP_QUESTIONNAIRES_ENABLED`) because the AI paths spend per call and handle PII. Independent of
 * live-sessions (importing happens at authoring time). When off, the admin adds invitees by typing
 * them directly into the verify grid.
 *
 * App seed: its `SeedHistory` key is `app-questionnaire/034-invite-import-flag`. Idempotent
 * (`update: {}`) so re-seeding never clobbers an operator's toggle.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/034-invite-import-flag',
  async run({ prisma, logger }) {
    logger.info('🚩 Seeding APP_QUESTIONNAIRES_INVITE_IMPORT_ENABLED feature flag...');

    await prisma.featureFlag.upsert({
      where: { name: APP_QUESTIONNAIRES_INVITE_IMPORT_FLAG },
      update: {},
      create: {
        name: APP_QUESTIONNAIRES_INVITE_IMPORT_FLAG,
        description:
          'Enables ConQuest invitee import — the wizard CSV/PDF/image methods and the AI people-' +
          'extraction capability (PDF text + image vision). Opt-in on top of ' +
          'APP_QUESTIONNAIRES_ENABLED because the AI paths spend per call and handle PII. When off, ' +
          'the admin adds invitees by typing them in directly. Disabled by default.',
        enabled: false,
      },
    });

    logger.info(`✅ Ensured ${APP_QUESTIONNAIRES_INVITE_IMPORT_FLAG} flag (disabled by default)`);
  },
};

export default unit;
