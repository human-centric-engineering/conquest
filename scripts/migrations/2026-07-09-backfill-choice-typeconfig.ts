import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import {
  normalizeSuggestedTypeConfig,
  CHOICE_QUESTION_TYPES,
} from '@/lib/app/questionnaire/ingestion/normalize-type-config';
import { readChoicesConfig } from '@/lib/app/questionnaire/form/type-config';

type ChoiceType = (typeof CHOICE_QUESTION_TYPES)[number];

/**
 * Backfill choice `typeConfig` to the canonical {value,label} shape — 2026-07-09
 * =============================================================================
 *
 * Questionnaires ingested before the choice-normalisation fix stored
 * `single_choice` / `multi_choice` options as a bare string array
 * (`{"choices":["No","Yes, one"]}`). Every downstream reader requires
 * `choices: [{ value, label }]`, so those slots render nothing selectable. This
 * script reshapes the stored config in place using the SAME
 * `normalizeSuggestedTypeConfig` the persistence writer now applies — the option
 * *text* is already correct, only the shape is wrong, so no re-extraction (and no
 * LLM cost) is needed.
 *
 * SCOPE — updates `app_question_slot.typeConfig` ONLY, and ONLY for choice rows
 * whose normalised config actually differs from the stored one. Idempotent: a row
 * already canonical (or with too few usable options to safely rewrite) is left
 * untouched, so a second run is a no-op. Touches nothing else.
 *
 * Usage
 * -----
 *   tsx --env-file=.env.local scripts/migrations/2026-07-09-backfill-choice-typeconfig.ts [flags]
 *   # or: npm run db:backfill:choice-typeconfig -- [flags]
 *
 * Flags
 * -----
 *   --dry-run                 List the slots that would change; write nothing.
 *   --version=<id>            Limit to a single version id.
 *   --questionnaire=<id>      Limit to all versions of one questionnaire.
 *
 * Safe to delete this file once every environment has been backfilled.
 */

interface Flags {
  dryRun: boolean;
  versionId?: string;
  questionnaireId?: string;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { dryRun: false };
  for (const arg of argv) {
    if (arg === '--dry-run') flags.dryRun = true;
    else if (arg.startsWith('--version=')) flags.versionId = arg.slice('--version='.length);
    else if (arg.startsWith('--questionnaire='))
      flags.questionnaireId = arg.slice('--questionnaire='.length);
    else if (arg.startsWith('--')) throw new Error(`Unknown flag: ${arg}`);
  }
  return flags;
}

interface Rewrite {
  id: string;
  key: string;
  before: unknown;
  after: unknown;
}

async function findRewrites(flags: Flags): Promise<Rewrite[]> {
  const slots = await prisma.appQuestionSlot.findMany({
    where: {
      type: { in: [...CHOICE_QUESTION_TYPES] },
      ...(flags.versionId ? { versionId: flags.versionId } : {}),
      ...(flags.questionnaireId
        ? { section: { version: { questionnaireId: flags.questionnaireId } } }
        : {}),
    },
    select: { id: true, type: true, key: true, typeConfig: true },
    orderBy: { id: 'asc' },
  });

  const rewrites: Rewrite[] = [];
  for (const slot of slots) {
    const type = slot.type as ChoiceType;
    // Target ONLY slots that currently render nothing selectable. A config the
    // reader already accepts is fine as-is — `{label,value}` vs `{value,label}`
    // key order is irrelevant to the reader, so re-serialising it would be churn,
    // not a repair. `readChoicesConfig` is the exact gate the form/interviewer use.
    if (readChoicesConfig(type, slot.typeConfig) !== null) continue;
    const after = normalizeSuggestedTypeConfig(type, slot.typeConfig);
    // Only rewrite when normalisation actually makes it readable (a config with
    // <2 usable options stays broken — the admin fixes it in the editor).
    if (readChoicesConfig(type, after) === null) continue;
    rewrites.push({ id: slot.id, key: slot.key, before: slot.typeConfig, after });
  }
  return rewrites;
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));

  logger.info('🔧 Backfilling choice typeConfig → {value,label}', {
    dryRun: flags.dryRun,
    scope: flags.versionId
      ? `version ${flags.versionId}`
      : flags.questionnaireId
        ? `questionnaire ${flags.questionnaireId}`
        : 'all choice questions',
  });

  const rewrites = await findRewrites(flags);
  if (rewrites.length === 0) {
    logger.info('✅ Nothing to backfill — every choice slot is already canonical.');
    return;
  }
  logger.info(`Found ${rewrites.length} choice slot(s) with a non-canonical config.`);

  for (const r of rewrites) {
    logger.info(flags.dryRun ? '  • would rewrite' : '  • rewriting', {
      slotId: r.id,
      key: r.key,
      before: JSON.stringify(r.before),
      after: JSON.stringify(r.after),
    });
  }

  if (flags.dryRun) {
    logger.info('🟡 Dry run — nothing written. Re-run without --dry-run to apply.');
    return;
  }

  let updated = 0;
  for (const r of rewrites) {
    await prisma.appQuestionSlot.update({
      where: { id: r.id },
      // The normalised value is plain JSON; Prisma's JSON input type is structural.
      data: { typeConfig: r.after as object },
    });
    updated += 1;
  }
  logger.info('🎉 Backfill complete', { updated });
}

main()
  .catch((err) => {
    logger.error('❌ Backfill failed', err);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
