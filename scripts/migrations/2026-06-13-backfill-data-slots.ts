import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { isDataSlotsEnabled } from '@/lib/app/questionnaire/feature-flag';
import { dataSlotGranularitySchema } from '@/lib/app/questionnaire/data-slots';
import { generateAndSaveDataSlots } from '@/app/api/v1/app/questionnaires/_lib/generate-data-slots';

/**
 * Backfill data slots for pre-existing questionnaires — 2026-06-13
 * ================================================================
 *
 * The data-slots abstraction (short semantic targets the live conversation aims at, which
 * fill the authored questions in the background) shipped after the test/demo questionnaires
 * were already in the DB, so none of them have any slots. This script gives each version its
 * slots by running the SAME generator agent the admin "Generate" button uses
 * (`generateAndSaveDataSlots`) and saving the result LIVE (skipping the draft/review step).
 *
 * What it does
 * ------------
 * - Finds every questionnaire version with ≥1 question and 0 live data slots.
 * - For each, runs the generator and replaces the version's live slot set with the output.
 * - Idempotent: a version that already has live slots is skipped (use `--force` to regenerate).
 * - Fail-soft per version: a generator failure (no provider, timeout, parse) is logged and the
 *   run moves on — one broken version never aborts the batch.
 *
 * What it does NOT do
 * -------------------
 * - It does not flip the `APP_QUESTIONNAIRES_DATA_SLOTS_ENABLED` flag. The flag gates the
 *   runtime/UI, not whether slots exist; enable it separately (see the F9.2 runbook) to see the
 *   slots used. The script WARNS if the flag is off so you know the backfilled slots are dormant.
 * - It does not touch questions, sessions, fills, or any non-slot data.
 *
 * Requirements
 * ------------
 * - An LLM provider configured with a working API key (the generator agent resolves to the
 *   `reasoning` tier). Run `db:seed` first so the generator agent row exists.
 *
 * Usage
 * -----
 *   tsx --env-file=.env.local scripts/migrations/2026-06-13-backfill-data-slots.ts [flags]
 *   # or: npm run db:backfill:data-slots -- [flags]
 *
 * Flags
 * -----
 *   --dry-run                 List the versions that would be backfilled; generate nothing.
 *   --force                   Regenerate even for versions that already have live slots.
 *   --version=<id>            Limit to a single version id.
 *   --questionnaire=<id>      Limit to all versions of one questionnaire.
 *   --granularity=<level>     broadest | broad | balanced | granular | finest (default: balanced).
 *
 * Idempotent — re-running backfills only the versions still missing slots. Safe to delete this
 * file once every environment has been backfilled.
 */

interface Flags {
  dryRun: boolean;
  force: boolean;
  versionId?: string;
  questionnaireId?: string;
  granularity?: ReturnType<typeof dataSlotGranularitySchema.parse>;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { dryRun: false, force: false };
  for (const arg of argv) {
    if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--force') flags.force = true;
    else if (arg.startsWith('--version=')) flags.versionId = arg.slice('--version='.length);
    else if (arg.startsWith('--questionnaire='))
      flags.questionnaireId = arg.slice('--questionnaire='.length);
    else if (arg.startsWith('--granularity=')) {
      const parsed = dataSlotGranularitySchema.safeParse(arg.slice('--granularity='.length));
      if (!parsed.success) {
        throw new Error(
          `Invalid --granularity: ${arg.slice('--granularity='.length)} ` +
            `(expected broadest|broad|balanced|granular|finest)`
        );
      }
      flags.granularity = parsed.data;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown flag: ${arg}`);
    }
  }
  return flags;
}

interface Target {
  questionnaireId: string;
  versionId: string;
  versionNumber: number;
  title: string;
  questionCount: number;
  existingSlotCount: number;
}

/** Versions with ≥1 question, annotated with their current live-slot count. */
async function findTargets(flags: Flags): Promise<Target[]> {
  const versions = await prisma.appQuestionnaireVersion.findMany({
    where: {
      ...(flags.versionId ? { id: flags.versionId } : {}),
      ...(flags.questionnaireId ? { questionnaireId: flags.questionnaireId } : {}),
    },
    orderBy: [{ questionnaireId: 'asc' }, { versionNumber: 'asc' }],
    select: {
      id: true,
      questionnaireId: true,
      versionNumber: true,
      questionnaire: { select: { title: true } },
      _count: { select: { dataSlots: true } },
    },
  });

  // Question slots hang off sections (with a denormalised `versionId`), so they aren't a direct
  // relation on the version — count them in one grouped query keyed on that denormalised column.
  const counts = await prisma.appQuestionSlot.groupBy({
    by: ['versionId'],
    where: { versionId: { in: versions.map((v) => v.id) } },
    _count: { _all: true },
  });
  const questionCountByVersion = new Map(counts.map((c) => [c.versionId, c._count._all]));

  return versions
    .map((v) => ({
      questionnaireId: v.questionnaireId,
      versionId: v.id,
      versionNumber: v.versionNumber,
      title: v.questionnaire.title,
      questionCount: questionCountByVersion.get(v.id) ?? 0,
      existingSlotCount: v._count.dataSlots,
    }))
    .filter((t) => t.questionCount > 0);
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));

  logger.info('🧩 Backfilling data slots for pre-existing questionnaires', {
    dryRun: flags.dryRun,
    force: flags.force,
    granularity: flags.granularity ?? 'balanced (default)',
    scope: flags.versionId
      ? `version ${flags.versionId}`
      : flags.questionnaireId
        ? `questionnaire ${flags.questionnaireId}`
        : 'all versions',
  });

  if (!(await isDataSlotsEnabled())) {
    logger.warn(
      '⚠️  Data slots are NOT enabled (APP_QUESTIONNAIRES_DATA_SLOTS_ENABLED). Backfilled slots ' +
        'will be written but stay dormant until the flag is on — see the F9.2 runbook.'
    );
  }

  const allTargets = await findTargets(flags);
  const targets = flags.force ? allTargets : allTargets.filter((t) => t.existingSlotCount === 0);
  const alreadyHad = allTargets.length - targets.length;

  if (targets.length === 0) {
    logger.info('✅ Nothing to backfill', {
      versionsWithQuestions: allTargets.length,
      alreadyHadSlots: alreadyHad,
    });
    return;
  }

  logger.info(`Found ${targets.length} version(s) to backfill`, {
    skippedAlreadyHadSlots: alreadyHad,
  });

  if (flags.dryRun) {
    for (const t of targets) {
      logger.info('  • would backfill', {
        title: t.title,
        version: t.versionNumber,
        versionId: t.versionId,
        questions: t.questionCount,
        existingSlots: t.existingSlotCount,
      });
    }
    logger.info('🟡 Dry run — no slots generated. Re-run without --dry-run to apply.');
    return;
  }

  const summary = { saved: 0, empty: 0, skipped: 0, failed: 0, slotsWritten: 0 };

  for (const t of targets) {
    const label = `"${t.title}" v${t.versionNumber}`;
    try {
      const result = await generateAndSaveDataSlots(t.questionnaireId, t.versionId, {
        ...(flags.granularity ? { granularity: flags.granularity } : {}),
      });
      summary[result.status] += 1;
      summary.slotsWritten += result.slotCount;

      if (result.status === 'saved') {
        logger.info(`  ✅ ${label} — ${result.slotCount} slots`, { versionId: t.versionId });
      } else if (result.status === 'empty') {
        logger.warn(`  ◻️  ${label} — generator proposed no slots`, { versionId: t.versionId });
      } else if (result.status === 'skipped') {
        logger.warn(`  ⏭  ${label} — skipped (${result.diagnostic})`, { versionId: t.versionId });
      } else {
        logger.error(`  ❌ ${label} — generation failed (${result.diagnostic})`, {
          versionId: t.versionId,
          message: result.message,
        });
      }
    } catch (err) {
      // Unexpected throw (the helper is fail-soft, so this is a real surprise). Keep going.
      summary.failed += 1;
      logger.error(`  ❌ ${label} — unexpected error`, {
        versionId: t.versionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info('🎉 Backfill complete', summary);
  if (summary.failed > 0) {
    process.exitCode = 1; // surface partial failure to CI / the shell without aborting mid-run
  }
}

main()
  .catch((err) => {
    logger.error('❌ Backfill failed', err);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
