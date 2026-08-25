import type { SeedUnit } from '@/prisma/runner';
import {
  DETECT_SCOPE_CANDIDACY_CAPABILITY_SLUG,
  EVALUATE_SCOPE_CAPABILITY_SLUG,
  QUESTIONNAIRE_SCOPE_CANDIDACY_AGENT_SLUG,
} from '@/lib/app/questionnaire/constants';
import { SCOPE_EVALUATION_JUDGE_SLUGS } from '@/lib/app/questionnaire/scope-evaluation/dimensions';

/**
 * Carry the Adaptive Scope → Conditional Topics rename into rows that already exist.
 *
 * The column rename is a migration; this is the part a migration cannot do, because the values are
 * seeded rather than structural. Two jobs:
 *
 * 1. **A stranded pre-rename capability row.** `090` now renames its own slug in place, which is
 *    where that belongs — it owns the row. This unit only cleans up the one case `090` cannot: a
 *    database where `090` already ran *after* the rename and so created a second row beside the
 *    original. That original is unreachable (the dispatcher resolves the new slug), so it is
 *    deactivated rather than deleted — a capability row can be referenced by agent bindings and by
 *    audit history, and "switched off" is the reversible half of that decision.
 *
 * 2. **The old name in text an operator reads.** `089`–`092` keep `name` / `description` /
 *    `systemInstructions` **operator-owned** on update (see `.context/database/seeding.md`), which
 *    is right for a re-seed and wrong for a rename: a seeded row would keep saying "Adaptive Scope"
 *    forever. So the phrase is **substring-replaced** rather than the field being re-stamped from
 *    code — an operator who rewrote the description keeps their wording and still gets the new
 *    feature name. Only the rows these seeds own are touched, by slug.
 *
 * Ordered after `096` so it runs on the same pass as the seeds it corrects. Idempotent: on a fresh
 * database there is no legacy slug and no legacy phrase, so every statement here is a no-op.
 */

/** The pre-rename slug from `090`. Its replacement is {@link DETECT_SCOPE_CANDIDACY_CAPABILITY_SLUG}. */
const LEGACY_CAPABILITY_SLUG = 'app_detect_adaptive_scope_candidacy';

/**
 * Case-sensitive, because the seeds used all three forms and each has its own replacement. The last
 * two entries repair the article the substitution breaks: the old name began with a vowel sound and
 * the new one does not, so "an Adaptive Scope candidate" would otherwise become "an Conditional
 * Topics candidate". Applied in order, so they see the already-substituted text.
 */
const PHRASES: readonly (readonly [RegExp, string])[] = [
  [/Adaptive Scope/g, 'Conditional Topics'],
  [/ADAPTIVE SCOPE/g, 'CONDITIONAL TOPICS'],
  [/adaptive scope/g, 'conditional topics'],
  [/\ban Conditional Topics\b/g, 'a Conditional Topics'],
  [/\ban conditional topics\b/g, 'a conditional topics'],
];

function rename(value: string): string {
  return PHRASES.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    value
  );
}

const unit: SeedUnit = {
  name: 'app-questionnaire/097-conditional-topics-rename',
  async run({ prisma, logger }) {
    logger.info('🔤 Carrying the Conditional Topics rename into existing rows...');

    // Only ever reached when `090`'s in-place rename could not run because it had already created
    // the new row on an earlier pass. `updateMany` (not `update`) so an absent legacy row is a
    // no-op rather than a throw.
    const stranded = await prisma.aiCapability.updateMany({
      where: { slug: LEGACY_CAPABILITY_SLUG, isActive: true },
      data: { isActive: false },
    });
    if (stranded.count > 0) {
      logger.info(`   Deactivated the superseded ${LEGACY_CAPABILITY_SLUG} row`);
    }

    let renamed = 0;

    for (const slug of [
      QUESTIONNAIRE_SCOPE_CANDIDACY_AGENT_SLUG,
      ...SCOPE_EVALUATION_JUDGE_SLUGS,
    ]) {
      const agent = await prisma.aiAgent.findUnique({
        where: { slug },
        select: { id: true, name: true, description: true, systemInstructions: true },
      });
      if (!agent) continue;

      const data = {
        name: rename(agent.name),
        description: rename(agent.description),
        systemInstructions: rename(agent.systemInstructions),
      };
      if (
        data.name === agent.name &&
        data.description === agent.description &&
        data.systemInstructions === agent.systemInstructions
      ) {
        continue;
      }

      await prisma.aiAgent.update({ where: { id: agent.id }, data });
      renamed += 1;
    }

    for (const slug of [DETECT_SCOPE_CANDIDACY_CAPABILITY_SLUG, EVALUATE_SCOPE_CAPABILITY_SLUG]) {
      const capability = await prisma.aiCapability.findUnique({
        where: { slug },
        select: { id: true, name: true, description: true },
      });
      if (!capability) continue;

      const data = {
        name: rename(capability.name),
        description: rename(capability.description),
      };
      if (data.name === capability.name && data.description === capability.description) continue;

      await prisma.aiCapability.update({ where: { id: capability.id }, data });
      renamed += 1;
    }

    logger.info(`✅ Conditional Topics rename applied (${renamed} row(s) re-worded)`);
  },
};

export default unit;
