import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

import { z } from 'zod';

import { env } from '@/lib/env';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { runStructuredCompletion } from '@/lib/orchestration/llm/structured-completion';
import type { LlmProvider } from '@/lib/orchestration/llm/provider';
import { validateTypeConfig, isLikertLabelled } from '@/lib/app/questionnaire/authoring';
import {
  buildLikertLabelMessages,
  parseLikertLabelDecision,
  genericLikertLabels,
  type LikertLabelDecision,
} from '@/lib/app/questionnaire/ingestion/likert-labels';

/**
 * Backfill per-point labels for unlabelled likert scales — 2026-06-25
 * ===================================================================
 *
 * Likert questions store a bounded scale (`{min,max}`) but per-point labels are a later addition,
 * so pre-existing questions render as bare numbers in the downloadable report ("1", "5"). This
 * script visits every likert question whose scale isn't fully labelled and, per question, asks an
 * LLM to either (a) name each point — written back as `typeConfig.labels` — or (b) declare the
 * scale purely numeric, in which case the question's `type` is switched to `numeric` (the agreed
 * exception, rather than fabricating words for a meaningless number).
 *
 * Idempotent: a likert already carrying one label per point is skipped. Fail-soft per question — a
 * provider/parse failure falls back to a deterministic generic word ramp so the question is never
 * left unlabelled (and never blocks launch). With no provider configured (or `--generic`), every
 * question takes that deterministic fallback.
 *
 * `--relabel` widens the net to scales that ARE already labelled, re-deriving each from the
 * question's wording — the way to fix scales mislabelled by an earlier, agree/disagree-biased
 * prompt (e.g. a "to what extent…" question wrongly carrying "Strongly disagree → Strongly agree").
 * To protect work already in place, a re-label NEVER overwrites an existing label set with the
 * deterministic generic ramp: if the LLM can't produce a fresh set, the existing labels are kept.
 *
 * Usage
 * -----
 *   tsx --env-file=.env.local scripts/migrations/2026-06-25-backfill-likert-labels.ts [flags]
 *   # or: npm run db:backfill:likert-labels -- [flags]
 *
 * Flags
 * -----
 *   --dry-run                 List the questions that would change; write nothing.
 *   --generic                 Skip the LLM; apply the deterministic generic labels to every scale.
 *   --relabel                 Also re-derive scales that are already labelled (LLM only — never
 *                             downgrades an existing label set to the generic ramp). DEVELOPMENT
 *                             ONLY — refused when NODE_ENV is not "development", since it can
 *                             overwrite admin-tuned labels.
 *   --version=<id>            Limit to a single version id.
 *   --questionnaire=<id>      Limit to all versions of one questionnaire.
 *
 * Safe to delete this file once every environment has been backfilled.
 */

interface Flags {
  dryRun: boolean;
  generic: boolean;
  relabel: boolean;
  versionId?: string;
  questionnaireId?: string;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { dryRun: false, generic: false, relabel: false };
  for (const arg of argv) {
    if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--generic') flags.generic = true;
    else if (arg === '--relabel') flags.relabel = true;
    else if (arg.startsWith('--version=')) flags.versionId = arg.slice('--version='.length);
    else if (arg.startsWith('--questionnaire='))
      flags.questionnaireId = arg.slice('--questionnaire='.length);
    else if (arg.startsWith('--')) throw new Error(`Unknown flag: ${arg}`);
  }
  return flags;
}

// `typeConfig` is raw Prisma JSON — validate with Zod rather than casting it.
const boundsShape = z.object({ min: z.number().int(), max: z.number().int() });
const choiceWordsShape = z.object({ choices: z.array(z.string()) });

/** Read coherent integer bounds from a likert config, or null when unusable. */
function readBounds(typeConfig: unknown): { min: number; max: number } | null {
  const parsed = boundsShape.safeParse(typeConfig);
  if (!parsed.success) return null;
  const { min, max } = parsed.data;
  return max > min ? { min, max } : null;
}

/**
 * Some likert rows were extracted with a `choices` string array (the option words) instead of
 * `min`/`max` — those words ARE the per-point labels. Read them so the scale can be normalised to a
 * proper 1..N labelled likert deterministically (no LLM needed).
 */
function readChoiceLabels(typeConfig: unknown): string[] | null {
  const parsed = choiceWordsShape.safeParse(typeConfig);
  if (!parsed.success) return null;
  const choices = parsed.data.choices.map((c) => c.trim());
  if (choices.length < 2 || choices.some((c) => c.length === 0)) return null;
  return choices;
}

interface Target {
  id: string;
  prompt: string;
  typeConfig: unknown;
  bounds: { min: number; max: number };
  /** Pre-resolved labels (e.g. from a `choices` array) — applied directly, skipping the LLM. */
  presetLabels?: string[];
  /**
   * True when the scale already had complete labels and we're re-deriving them (`--relabel`). Guards
   * the apply loop from downgrading a good label set to the generic ramp when the LLM is unavailable.
   */
  hadLabels?: boolean;
}

async function findTargets(flags: Flags): Promise<Target[]> {
  const slots = await prisma.appQuestionSlot.findMany({
    where: {
      type: 'likert',
      ...(flags.versionId ? { versionId: flags.versionId } : {}),
      ...(flags.questionnaireId
        ? { section: { version: { questionnaireId: flags.questionnaireId } } }
        : {}),
    },
    select: { id: true, prompt: true, typeConfig: true },
    orderBy: { id: 'asc' },
  });

  const targets: Target[] = [];
  for (const s of slots) {
    // A launchable, adequately-labelled scale — full per-point labels OR both endpoint
    // labels (an endpoint-anchored scale the extractor deliberately left anchor-only). Both
    // are skipped unless `--relabel`; only a fully-unlabelled scale is a default backfill
    // target. Using isLikertLabelled (not the stricter hasCompleteLikertLabels) prevents the
    // backfill from clobbering faithful endpoint anchors with fabricated per-point labels.
    const labelled = isLikertLabelled(s.typeConfig);
    // Idempotent skip — unless `--relabel`, which re-derives already-labelled scales too.
    if (labelled && !flags.relabel) continue;

    const bounds = readBounds(s.typeConfig);
    if (bounds) {
      targets.push({
        id: s.id,
        prompt: s.prompt,
        typeConfig: s.typeConfig,
        bounds,
        hadLabels: labelled,
      });
      continue;
    }

    // No usable bounds, but a `choices` word list ⇒ a 1..N scale whose words are the labels.
    const choiceLabels = readChoiceLabels(s.typeConfig);
    if (choiceLabels) {
      targets.push({
        id: s.id,
        prompt: s.prompt,
        typeConfig: s.typeConfig,
        bounds: { min: 1, max: choiceLabels.length },
        presetLabels: choiceLabels,
      });
      continue;
    }

    logger.warn('  ⚠️  skipping likert with unreadable bounds', { slotId: s.id });
  }
  return targets;
}

/** Resolve a provider for the labelling call, or null when none is configured. */
async function resolveProvider(): Promise<{ provider: LlmProvider; model: string } | null> {
  try {
    const resolved = await resolveAgentProviderAndModel(
      { provider: '', model: '', fallbackProviders: [] },
      'reasoning'
    );
    const provider = await getProvider(resolved.providerSlug);
    return { provider, model: resolved.model };
  } catch (err) {
    logger.warn('No LLM provider resolved — falling back to generic labels for every scale', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Decide labels (or numeric) for one question, via the LLM with a deterministic fallback. */
async function decide(
  target: Target,
  llm: { provider: LlmProvider; model: string } | null
): Promise<{ decision: LikertLabelDecision; source: 'llm' | 'generic' | 'choices' }> {
  // A `choices` word list is already the labels — apply deterministically, no LLM.
  if (target.presetLabels) {
    return { decision: { numeric: false, labels: target.presetLabels }, source: 'choices' };
  }
  if (llm) {
    try {
      const decision = await runStructuredCompletion<LikertLabelDecision>({
        provider: llm.provider,
        model: llm.model,
        messages: buildLikertLabelMessages({ prompt: target.prompt, ...target.bounds }),
        maxTokens: 400,
        timeoutMs: 30_000,
        parse: (raw) => parseLikertLabelDecision(raw, target.bounds),
        retryUserMessage:
          'Return ONLY the JSON object: {"numeric": false, "labels": [ … one per point … ]} ' +
          'or {"numeric": true}.',
      });
      return { decision: decision.value, source: 'llm' };
    } catch (err) {
      logger.warn('  ⚠️  LLM labelling failed; using generic labels', {
        slotId: target.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return {
    decision: { numeric: false, labels: genericLikertLabels(target.bounds.min, target.bounds.max) },
    source: 'generic',
  };
}

/** Apply a decision to one slot: write labels, or reclassify to numeric. Validates before writing. */
async function apply(
  target: Target,
  decision: LikertLabelDecision
): Promise<'labelled' | 'numeric'> {
  if (decision.numeric) {
    const numericConfig = { min: target.bounds.min, max: target.bounds.max };
    const check = validateTypeConfig('numeric', numericConfig);
    await prisma.appQuestionSlot.update({
      where: { id: target.id },
      data: { type: 'numeric', typeConfig: check.ok ? (check.value as object) : numericConfig },
    });
    return 'numeric';
  }
  const config = { min: target.bounds.min, max: target.bounds.max, labels: decision.labels };
  const check = validateTypeConfig('likert', config);
  if (!check.ok) {
    // Shouldn't happen (labels match the point count), but never write an invalid config.
    throw new Error(
      `produced config failed validation: ${check.issues.map((i) => i.message).join('; ')}`
    );
  }
  await prisma.appQuestionSlot.update({
    where: { id: target.id },
    data: { typeConfig: check.value as object },
  });
  return 'labelled';
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));

  // `--relabel` REWRITES scales that are already labelled, so it can clobber labels an admin tuned
  // by hand. Confine it to local development — never staging/production. The plain backfill (filling
  // genuinely unlabelled scales) is a safe one-off and stays allowed everywhere.
  if (flags.relabel && env.NODE_ENV !== 'development') {
    logger.error('❌ --relabel is refused outside development', {
      nodeEnv: env.NODE_ENV,
      reason:
        'relabel overwrites existing labels (possibly admin-edited); run it only against a local dev database',
    });
    process.exit(1);
  }

  logger.info('🏷️  Backfilling likert scale labels', {
    dryRun: flags.dryRun,
    generic: flags.generic,
    scope: flags.versionId
      ? `version ${flags.versionId}`
      : flags.questionnaireId
        ? `questionnaire ${flags.questionnaireId}`
        : 'all likert questions',
  });

  const targets = await findTargets(flags);
  if (targets.length === 0) {
    logger.info(
      flags.relabel
        ? '✅ Nothing to relabel — no likert scales matched the scope.'
        : '✅ Nothing to backfill — every likert scale is already labelled.'
    );
    return;
  }
  const relabelCount = targets.filter((t) => t.hadLabels).length;
  logger.info(
    `Found ${targets.length} likert question(s) to process` +
      (flags.relabel ? ` (${relabelCount} already labelled, re-deriving).` : '.')
  );

  if (flags.dryRun) {
    for (const t of targets) {
      logger.info(t.hadLabels ? '  • would re-label' : '  • would label', {
        slotId: t.id,
        prompt: t.prompt,
        scale: `${t.bounds.min}–${t.bounds.max}`,
      });
    }
    logger.info('🟡 Dry run — nothing written. Re-run without --dry-run to apply.');
    return;
  }

  const llm = flags.generic ? null : await resolveProvider();
  const summary = { labelled: 0, numeric: 0, kept: 0, failed: 0 };
  const bySource = { llm: 0, choices: 0, generic: 0 };

  for (const t of targets) {
    try {
      const { decision, source } = await decide(t, llm);
      // Re-label safety: never replace an existing label set with the deterministic generic ramp.
      if (t.hadLabels && source === 'generic') {
        summary.kept += 1;
        logger.warn('  ⏭️  kept existing labels (no fresh LLM result)', { slotId: t.id });
        continue;
      }
      const outcome = await apply(t, decision);
      summary[outcome] += 1;
      bySource[source] += 1;
      const verb =
        outcome === 'numeric' ? 'reclassified → numeric' : t.hadLabels ? 're-labelled' : 'labelled';
      logger.info(`  ✅ ${verb} (${source})`, {
        slotId: t.id,
        ...(outcome === 'labelled' && !decision.numeric ? { labels: decision.labels } : {}),
      });
    } catch (err) {
      summary.failed += 1;
      logger.error('  ❌ failed', {
        slotId: t.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info('🎉 Backfill complete', { ...summary, bySource });
  if (summary.failed > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    logger.error('❌ Backfill failed', err);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
