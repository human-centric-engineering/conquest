import { APP_QUESTIONNAIRES_EDIT_AGENT_FLAG } from '@/lib/app/questionnaire/constants';
import type { SeedUnit } from '@/prisma/runner';

/**
 * Seeds the Structure Edit Agent sub-flag, DISABLED by default.
 *
 * When on: the admin gets an "Edit with AI" panel on the version Structure editor that takes a
 * plain-English instruction for the WHOLE questionnaire ("renumber the sections", "CAPS every
 * section title", "remove required from all free-text fields") and applies it across every matching
 * section/question — always previewing the changes before they are written. Each plan run is one
 * reasoning LLM call (instruction → structured edit-ops), so it dark-launches on top of the master
 * app flag, independent of the rest of the editor. When off, the plan/apply routes 404 and the panel
 * is hidden — nothing else changes.
 *
 * App seed: `SeedHistory` key `app-questionnaire/059-edit-agent-flag`. Idempotent (`update: {}`).
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/059-edit-agent-flag',
  async run({ prisma, logger }) {
    logger.info('🚩 Seeding APP_QUESTIONNAIRES_EDIT_AGENT_ENABLED feature flag...');

    await prisma.featureFlag.upsert({
      where: { name: APP_QUESTIONNAIRES_EDIT_AGENT_FLAG },
      update: {},
      create: {
        name: APP_QUESTIONNAIRES_EDIT_AGENT_FLAG,
        description:
          'Enables the ConQuest Structure Edit Agent — applying a plain-English instruction to a ' +
          'whole draft questionnaire (renumber sections, CAPS titles, strip required from free-text ' +
          'fields) via a preview-then-confirm panel on the Structure editor. Opt-in on top of ' +
          'APP_QUESTIONNAIRES_ENABLED; each plan run is a reasoning LLM call. Disabled by default.',
        enabled: false,
      },
    });

    logger.info(`✅ Ensured ${APP_QUESTIONNAIRES_EDIT_AGENT_FLAG} flag (disabled by default)`);
  },
};

export default unit;
