import { APP_QUESTIONNAIRES_EXTRACTION_PREFILTER_FLAG } from '@/lib/app/questionnaire/constants';
import type { SeedUnit } from '@/prisma/runner';

/**
 * Seeds the extraction candidate pre-filter sub-flag, DISABLED by default.
 *
 * At scale (50+ data slots / 70+ questions) the combined extractor is handed the FULL candidate list
 * every turn. When on, the live `/messages` route embeds the respondent's last message and narrows
 * the candidates to the ones that matter (active slot, already-filled slots, same-theme, mapped
 * questions) plus the top-K most similar — cutting per-turn prompt cost. Behaviour-preserving by
 * design and fail-soft, but it spends an embedding call per turn, so it's gated behind its own flag
 * on top of the master app + live-sessions flags: an operator opts in deliberately and dark-launches.
 *
 * App seed: lives under `prisma/seeds/app-questionnaire/`, found by the recursive runner; its
 * `SeedHistory` key is `app-questionnaire/042-extraction-prefilter-flag`. Idempotent (`update: {}`)
 * so re-seeding never clobbers an operator's toggle.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/042-extraction-prefilter-flag',
  async run({ prisma, logger }) {
    logger.info('🚩 Seeding APP_QUESTIONNAIRES_EXTRACTION_PREFILTER_ENABLED feature flag...');

    await prisma.featureFlag.upsert({
      where: { name: APP_QUESTIONNAIRES_EXTRACTION_PREFILTER_FLAG },
      update: {},
      create: {
        name: APP_QUESTIONNAIRES_EXTRACTION_PREFILTER_FLAG,
        description:
          'Enables the ConQuest extraction candidate pre-filter (embeds the respondent message and ' +
          'narrows the combined extractor candidate set to the relevant + top-K similar slots per ' +
          'turn). Opt-in on top of APP_QUESTIONNAIRES_ENABLED + the live-sessions flag because it ' +
          'spends an embedding call per turn; aimed at large (50+ slot / 70+ question) ' +
          'questionnaires. Behaviour-preserving and fail-soft; when off the extractor gets the full ' +
          'candidate list. Disabled by default.',
        enabled: false,
      },
    });

    logger.info(
      `✅ Ensured ${APP_QUESTIONNAIRES_EXTRACTION_PREFILTER_FLAG} flag (disabled by default)`
    );
  },
};

export default unit;
