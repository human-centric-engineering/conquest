import type { SeedUnit } from '@/prisma/runner';
import { serviceAccountWhere } from '@/lib/auth/account';
import { BRAND_IMPORT_AGENT_SLUG } from '@/lib/app/questionnaire/constants';

/**
 * Persona for the brand-import analyst. The import pipeline
 * (`lib/app/questionnaire/brand-import/assign-roles.ts`) composes its own structured prompt and
 * filters the reply against the measured palette; these instructions set the default voice and make
 * the agent self-describing in the admin UI.
 */
const ANALYST_INSTRUCTIONS = `You look at a company's website — or a screenshot of one — together \
with the colours that have already been measured from it, and you work out which colour plays which \
role: the ground the page sits on, the colour its text is set in, its main button, its accent. You \
only ever choose from the colours you are given; you never adjust one and never invent one. When a \
page plainly has no header band, no button gradient or no second accent, you say so by returning \
nothing for it rather than picking the closest thing available.`;

/**
 * Seed the brand-import analyst agent.
 *
 * A one-shot classifier over a palette we measured ourselves, so it is the smallest agent in the
 * app: a few hundred tokens in, a role→hex map out. Ships with empty `model`/`provider`
 * (runtime-resolved via `agent-resolver.ts`) and `visibility: 'internal'`.
 *
 * Resolved on the CHAT tier rather than reasoning: with a screenshot attached this needs a
 * vision-capable model, and vision lives on the chat models in the curated matrix. When the resolved
 * model lacks `vision` the pipeline drops the image and assigns from the numbers instead, so this
 * binding degrades rather than failing.
 *
 * App seed: `SeedHistory` key `app-questionnaire/099-brand-import-agent`. Idempotent — the `update`
 * branch only re-asserts `isSystem: false`.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/099-brand-import-agent',
  async run({ prisma, logger }) {
    logger.info('🛠️  Seeding brand import analyst agent...');

    const admin = await prisma.user.findFirst({
      where: serviceAccountWhere,
      select: { id: true },
    });
    if (!admin) {
      throw new Error('No admin user found — ensure 001-system-owner runs first.');
    }

    await prisma.aiAgent.upsert({
      where: { slug: BRAND_IMPORT_AGENT_SLUG },
      update: { isSystem: false },
      create: {
        name: 'Brand Import Analyst',
        slug: BRAND_IMPORT_AGENT_SLUG,
        description:
          "Assigns measured website colours to a demo client's theme columns — page ground, text, button, accent, header band. Dispatched by the brand-import route; persists nothing, and can only return colours that were measured from the page.",
        systemInstructions: ANALYST_INSTRUCTIONS,
        model: '',
        provider: '',
        // Low: this is a classification over a fixed list, not a generative task. Variation here
        // would show up as the same screenshot producing a different palette mapping twice.
        temperature: 0.1,
        maxTokens: 700,
        monthlyBudgetUsd: 15,
        knowledgeAccessMode: 'restricted',
        visibility: 'internal',
        isActive: true,
        isSystem: false,
        createdBy: admin.id,
      },
    });

    logger.info(`✅ Seeded ${BRAND_IMPORT_AGENT_SLUG} agent`);
  },
};

export default unit;
