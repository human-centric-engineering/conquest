import type { SeedUnit } from '@/prisma/runner';
import { serviceAccountWhere } from '@/lib/auth/account';
import { BRAND_CONTRAST_AGENT_SLUG } from '@/lib/app/questionnaire/constants';

/**
 * Persona for the brand-contrast adviser. The optimiser
 * (`lib/app/questionnaire/brand-contrast/advise.ts`) composes its own structured prompt and
 * validates every pick against the repairs it was offered; these instructions set the default voice
 * and make the agent self-describing in the admin UI.
 */
const ADVISER_INSTRUCTIONS = `You advise on brand colour. When a questionnaire's branding leaves \
text that a person with ordinary eyesight cannot comfortably read, you are shown the problem and \
the handful of fixes that would solve it — each one a shade of a colour already in the brand, with \
its hue untouched — and you choose between them. You prefer to move whichever colour carries the \
least of the brand's identity, and you prefer the smaller change when nothing else separates two \
options. You know that a page's background is often the thing a brand is recognised by, so \
bleaching it to rescue the text is usually the wrong trade. You explain each choice in one plain \
sentence, you never quote a colour code at someone who is looking at the swatch, and you never \
pretend a change is invisible — it is a change, and the person reading you is the one deciding \
whether it is acceptable.`;

/**
 * Seed the brand-contrast adviser agent.
 *
 * The sibling of the brand-import analyst (`099`), and constrained the same way: every number is
 * computed before the model is asked anything, and its reply is an INDEX into a list it did not
 * write, so it cannot propose a colour that has not been proved to fix the pair. Ships with empty
 * `model`/`provider` (runtime-resolved via `agent-resolver.ts`) and `visibility: 'internal'`.
 *
 * Resolved on the CHAT tier: this is a short judgement over a small structured prompt, not
 * multi-step reasoning, and the app's chat default is both fast and cheap enough that an admin can
 * press the button repeatedly while adjusting colours — which is how the feature is meant to be used.
 *
 * App seed: `SeedHistory` key `app-questionnaire/100-brand-contrast-agent`. Idempotent — the
 * `update` branch only re-asserts `isSystem: false`.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/100-brand-contrast-agent',
  async run({ prisma, logger }) {
    logger.info('🛠️  Seeding brand contrast adviser agent...');

    const admin = await prisma.user.findFirst({
      where: serviceAccountWhere,
      select: { id: true },
    });
    if (!admin) {
      throw new Error('No admin user found — ensure 001-system-owner runs first.');
    }

    await prisma.aiAgent.upsert({
      where: { slug: BRAND_CONTRAST_AGENT_SLUG },
      update: { isSystem: false },
      create: {
        name: 'Brand Contrast Adviser',
        slug: BRAND_CONTRAST_AGENT_SLUG,
        description:
          "Chooses which colour should move when a demo client's branding leaves text unreadable — the ink or the page, the button or the band — and says why in one line. Dispatched by the contrast optimiser; persists nothing, and can only pick from shades already proved to fix the pair.",
        systemInstructions: ADVISER_INSTRUCTIONS,
        model: '',
        provider: '',
        // Low, for the same reason the import analyst's is: this is a choice between a handful of
        // enumerated options, and variation would show up as the same theme producing a different
        // recommendation on two consecutive presses of the same button.
        temperature: 0.2,
        maxTokens: 900,
        monthlyBudgetUsd: 10,
        knowledgeAccessMode: 'restricted',
        visibility: 'internal',
        isActive: true,
        isSystem: false,
        createdBy: admin.id,
      },
    });

    logger.info(`✅ Seeded ${BRAND_CONTRAST_AGENT_SLUG} agent`);
  },
};

export default unit;
