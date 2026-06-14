import { APP_QUESTIONNAIRES_FRICTIONLESS_INVITES_FLAG } from '@/lib/app/questionnaire/constants';
import type { SeedUnit } from '@/prisma/runner';

/**
 * Seeds the frictionless-invites sub-flag, DISABLED by default.
 *
 * Frictionless invites let a per-invitee token boot a no-login session — the respondent answers
 * without registering an account (optional account creation stays for cross-device resume). Opt-in
 * on top of the master app flag (`APP_QUESTIONNAIRES_ENABLED`) AND the live-sessions flag (it only
 * matters inside the live turn loop). When off, invitations fall back to the account-registration
 * accept flow.
 *
 * App seed: its `SeedHistory` key is `app-questionnaire/033-frictionless-invites-flag`. Idempotent
 * (`update: {}`) so re-seeding never clobbers an operator's toggle.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/033-frictionless-invites-flag',
  async run({ prisma, logger }) {
    logger.info('🚩 Seeding APP_QUESTIONNAIRES_FRICTIONLESS_INVITES_ENABLED feature flag...');

    await prisma.featureFlag.upsert({
      where: { name: APP_QUESTIONNAIRES_FRICTIONLESS_INVITES_FLAG },
      update: {},
      create: {
        name: APP_QUESTIONNAIRES_FRICTIONLESS_INVITES_FLAG,
        description:
          'Enables ConQuest frictionless invite links — a per-invitee token that boots a no-login ' +
          'session so the respondent answers without registering (optional account stays for ' +
          'cross-device resume). Opt-in on top of APP_QUESTIONNAIRES_ENABLED and ' +
          'APP_QUESTIONNAIRES_LIVE_SESSIONS_ENABLED. When off, invitations use the account-' +
          'registration accept flow. Disabled by default.',
        enabled: false,
      },
    });

    logger.info(
      `✅ Ensured ${APP_QUESTIONNAIRES_FRICTIONLESS_INVITES_FLAG} flag (disabled by default)`
    );
  },
};

export default unit;
