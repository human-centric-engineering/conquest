import type { SeedUnit } from '@/prisma/runner';
import { serviceAccountWhere } from '@/lib/auth/account';
import { QUESTIONNAIRE_SCALE_MATRIX_REPAIR_AGENT_SLUG } from '@/lib/app/questionnaire/constants';

/**
 * Seed the scales/matrix repair specialist agent (ingest verify + repair).
 *
 * Given only the flagged questions + the source, it re-extracts them correctly — fixing a mis-typed
 * scale, restoring missing likert anchors, or turning a flattened / mis-split rating grid into one
 * `matrix` question. A ConQuest **app** agent (`isSystem: false`): editable, deletable, in config
 * backup/export.
 *
 * **The load-bearing prompt lives in code** (`ingestion/repair-prompt.ts`), not in these
 * `systemInstructions` (which are for the admin UI only). Ships with empty `model`/`provider` so it
 * resolves dynamically via `agent-resolver.ts` (`reasoning` tier). Idempotent — `update` only
 * re-asserts `isSystem`.
 */

const SLUG = QUESTIONNAIRE_SCALE_MATRIX_REPAIR_AGENT_SLUG;

const SYSTEM_INSTRUCTIONS = `You are the ConQuest scales & matrix repair specialist. Given a few \
flagged questions an earlier extraction pass got wrong, plus the source document, you re-extract \
ONLY those questions correctly: fixing a mis-typed rating scale, restoring a likert's endpoint \
anchors, or turning a flattened or mis-split rating grid into one "matrix" question with rows and a \
shared scale. You never make a question worse — if you can't improve one, you leave it. (The exact \
prompt the engine sends is maintained in code; this description is for reference.)`;

const unit: SeedUnit = {
  name: 'app-questionnaire/066-scale-matrix-repair-agent',
  async run({ prisma, logger }) {
    logger.info('🛠️  Seeding the scales/matrix repair agent...');

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
        name: 'Scales & Matrix Repair Specialist',
        slug: SLUG,
        description:
          'Re-extracts flagged rating-scale / rating-grid questions correctly during questionnaire ' +
          'ingestion (fixing mis-typed scales, missing anchors, or flattened/mis-split matrices).',
        systemInstructions: SYSTEM_INSTRUCTIONS,
        model: '',
        provider: '',
        temperature: 0.2,
        // Emits whole questions, but only for the flagged few — a moderate cap.
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
