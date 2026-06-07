import { APP_QUESTIONNAIRES_ATTACHMENT_INPUT_FLAG } from '@/lib/app/questionnaire/constants';
import type { SeedUnit } from '@/prisma/runner';

/**
 * Seeds the attachment-input sub-flag, DISABLED by default.
 *
 * Attachment input lets a respondent attach images/documents to a `/messages` turn so the
 * answer-extractor reads them alongside the text. Multimodal turns cost more and require a
 * vision/document-capable model, so it opts in behind its own flag on top of the master app gate
 * (`APP_QUESTIONNAIRES_ENABLED`) AND the live-sessions flag — attachments only matter inside the
 * live turn loop. When off, the chat surface hides the affordance and the `/messages` route
 * ignores any attachments a client sends (text-only turn).
 *
 * App seed: lives under `prisma/seeds/app-questionnaire/`, found by the recursive runner; its
 * `SeedHistory` key is `app-questionnaire/024-attachment-input-flag`. Idempotent (`update: {}`) so
 * re-seeding never clobbers an operator's toggle.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/024-attachment-input-flag',
  async run({ prisma, logger }) {
    logger.info('🚩 Seeding APP_QUESTIONNAIRES_ATTACHMENT_INPUT_ENABLED feature flag...');

    await prisma.featureFlag.upsert({
      where: { name: APP_QUESTIONNAIRES_ATTACHMENT_INPUT_FLAG },
      update: {},
      create: {
        name: APP_QUESTIONNAIRES_ATTACHMENT_INPUT_FLAG,
        description:
          'Enables ConQuest attachment input — a respondent attaching images/documents to a live ' +
          'turn for the answer-extractor to read alongside the text. Opt-in on top of ' +
          'APP_QUESTIONNAIRES_ENABLED and APP_QUESTIONNAIRES_LIVE_SESSIONS_ENABLED (attachments ' +
          'only matter in the live turn loop) because multimodal turns cost more and need a ' +
          'vision/document-capable model. When off, the affordance is hidden and the route ignores ' +
          'sent attachments. Disabled by default.',
        enabled: false,
      },
    });

    logger.info(
      `✅ Ensured ${APP_QUESTIONNAIRES_ATTACHMENT_INPUT_FLAG} flag (disabled by default)`
    );
  },
};

export default unit;
