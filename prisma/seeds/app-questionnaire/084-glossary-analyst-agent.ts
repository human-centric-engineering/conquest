import type { SeedUnit } from '@/prisma/runner';
import { serviceAccountWhere } from '@/lib/auth/account';
import { QUESTIONNAIRE_GLOSSARY_ANALYST_AGENT_SLUG } from '@/lib/app/questionnaire/constants';

/**
 * Seed the Glossary Analyst agent (definitions / glossary, P16).
 *
 * Reads a questionnaire and proposes the terms whose meaning is genuinely open to interpretation
 * — "higher self", "ego", "regularly" — each with the readings this questionnaire appears to
 * intend, grounded in the admin's definitions document when one is attached. A ConQuest **app**
 * agent (`isSystem: false`): editable, deletable, in config backup/export.
 *
 * **The load-bearing rubric lives in code, not here.** The analyst is dispatched app-natively (a
 * structured `runStructuredCompletion` call) with the prompt built from
 * `glossary/analysis-prompt.ts` — it does NOT read these `systemInstructions`; they exist so the
 * agent is self-describing in the admin UI (the same split as the extractor / verifier). Ships
 * with empty `model`/`provider` so it resolves dynamically via `agent-resolver.ts` (`reasoning`
 * tier at call time). Idempotent — `update` only re-asserts `isSystem` so re-seeding never
 * clobbers an operator's edits.
 */

const SLUG = QUESTIONNAIRE_GLOSSARY_ANALYST_AGENT_SLUG;

const SYSTEM_INSTRUCTIONS = `You are the ConQuest Glossary Analyst. Given a questionnaire — and, \
when supplied, an authoritative definitions document — you identify the terms whose meaning is NOT \
settled, where two reasonable respondents would answer differently because they understood a word \
differently. For each you propose the readings this questionnaire appears to intend, inferred from \
its goal, audience and surrounding questions. You favour precision over recall: a short list of \
genuinely contested terms, never a catalogue of ordinary vocabulary. You propose only — an \
administrator adjudicates every term before it is used. (The exact rubric the engine sends is \
maintained in code; this description is for reference.)`;

const unit: SeedUnit = {
  name: 'app-questionnaire/084-glossary-analyst-agent',
  async run({ prisma, logger }) {
    logger.info('📖 Seeding the Glossary Analyst agent...');

    const admin = await prisma.user.findFirst({
      where: serviceAccountWhere,
      select: { id: true },
    });
    if (!admin) {
      throw new Error('No admin user found — ensure 001-system-owner runs first.');
    }

    await prisma.aiAgent.upsert({
      where: { slug: SLUG },
      update: { isSystem: false },
      create: {
        name: 'Glossary Analyst',
        slug: SLUG,
        description:
          'Proposes the ambiguous or context-dependent terms a questionnaire leans on, with ' +
          'candidate definitions inferred from its context, for an administrator to curate.',
        systemInstructions: SYSTEM_INSTRUCTIONS,
        // Empty strings → resolved at runtime via agent-resolver.ts (reasoning tier).
        model: '',
        provider: '',
        // A shade warmer than the near-deterministic critics: judging which words are contested
        // and phrasing a definition a respondent will read are both partly editorial.
        temperature: 0.3,
        // Up to 40 terms × 4 definitions + a rationale each; a truncated response fails
        // validation outright rather than degrading, so the cap is generous.
        maxTokens: 8192,
        monthlyBudgetUsd: 25,
        knowledgeAccessMode: 'restricted',
        visibility: 'internal',
        isActive: true,
        isSystem: false,
        createdBy: admin.id,
      },
    });

    logger.info(`✅ Seeded ${SLUG} agent`);
  },
};

export default unit;
