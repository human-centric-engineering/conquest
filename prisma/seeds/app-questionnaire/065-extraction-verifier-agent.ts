import type { SeedUnit } from '@/prisma/runner';
import { serviceAccountWhere } from '@/lib/auth/account';
import { QUESTIONNAIRE_EXTRACTION_VERIFIER_AGENT_SLUG } from '@/lib/app/questionnaire/constants';

/**
 * Seed the extraction-verifier agent (ingest verify + repair).
 *
 * The critic that reads the extracted questions + the source document and flags each question whose
 * answer type/config doesn't match the source. A ConQuest **app** agent (`isSystem: false`):
 * editable, deletable, in config backup/export.
 *
 * **The load-bearing rubric lives in code, not here.** The verifier is dispatched app-natively (a
 * structured `runStructuredCompletion` call) with the prompt built from `ingestion/verify-prompt.ts`
 * — it does NOT read these `systemInstructions`; they exist so the agent is self-describing in the
 * admin UI (the same split as the extractor / design judges). Ships with empty `model`/`provider`
 * so it resolves dynamically via `agent-resolver.ts` (`reasoning` tier at call time). Idempotent —
 * `update` only re-asserts `isSystem` so re-seeding never clobbers an operator's edits.
 */

const SLUG = QUESTIONNAIRE_EXTRACTION_VERIFIER_AGENT_SLUG;

const SYSTEM_INSTRUCTIONS = `You are the ConQuest extraction verifier — a meticulous critic for an \
automatically-extracted questionnaire. Given the source document and the extracted questions, you \
flag (never fix) each question whose chosen answer type or config is not faithful to the source: a \
rating scale mis-typed, a likert missing its endpoint anchors, a rating grid flattened or with rows \
lost. You are conservative — you only flag a real, source-evidenced problem. (The exact rubric the \
engine sends is maintained in code; this description is for reference.)`;

const unit: SeedUnit = {
  name: 'app-questionnaire/065-extraction-verifier-agent',
  async run({ prisma, logger }) {
    logger.info('🔎 Seeding the extraction-verifier agent...');

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
        name: 'Extraction Verifier',
        slug: SLUG,
        description:
          'Critic that flags extracted questions whose answer type/config is unfaithful to the ' +
          'source document, during questionnaire ingestion.',
        systemInstructions: SYSTEM_INSTRUCTIONS,
        // Empty strings → resolved at runtime via agent-resolver.ts (reasoning tier).
        model: '',
        provider: '',
        // Near-deterministic critic — same band as the extractor / judges.
        temperature: 0.2,
        // Flags-only output stays small.
        maxTokens: 4096,
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
