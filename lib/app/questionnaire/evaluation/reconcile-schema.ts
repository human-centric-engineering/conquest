/**
 * The cross-judge reconciliation contract.
 *
 * The judge panel is deliberately blind: each dimension scores in isolation so the verdicts stay
 * independent and comparable. That independence is what makes the panel trustworthy — and it is
 * also why its output lands on the admin's desk as several rewrites of the same question, each
 * fixing one dimension's complaint and quietly ignoring the other five. Applying the Clarity
 * judge's rewrite can re-break the audience match; applying the Audience judge's can put the
 * double-barrel back.
 *
 * So one more call runs after the panel, over the questions that more than one judge flagged, and
 * proposes phrasings that try to satisfy **all** of them at once. It is a proposer, exactly like the
 * judges: it writes nothing and every alternative lands for an admin to accept, edit, or ignore.
 *
 * Two alternatives at most, and honesty about the rest: `addresses` names the concerns a phrasing
 * actually resolves and `unresolved` names the ones no phrasing could, because a reconciliation that
 * silently drops a judge's point is worse than no reconciliation — it reads as consensus that was
 * never reached.
 *
 * Pure: Zod only, no Prisma / Next.
 */

import { z } from 'zod';

import { EVALUATION_DIMENSIONS } from '@/lib/app/questionnaire/evaluation/types';

/**
 * How many alternatives one target may carry.
 *
 * Two, not five. The point of reconciling is to collapse a pile of competing rewrites into a
 * decision the admin can make in one read; handing back a menu recreates the problem it exists to
 * solve. Two covers the case that genuinely needs it — a real trade-off between two defensible
 * readings ("keep it short" vs "keep the nuance") — and nothing more.
 */
export const MAX_ALTERNATIVES_PER_TARGET = 2;

/**
 * How many targets one reconcile call may cover.
 *
 * A bound on cost and on output length (the whole batch shares one token budget). Targets are
 * offered most-contested-first, and anything past the cap is reported by the caller rather than
 * silently dropped — a truncated reconciliation that looks complete would tell an admin the
 * remaining questions were fine.
 */
export const MAX_RECONCILED_TARGETS = 15;

/** Field caps — generous for a real question, bounded against a runaway response. */
const PROMPT_MAX = 2_000;
const NOTE_MAX = 1_000;

/** One proposed phrasing, with an honest account of what it does and does not fix. */
export const reconciledAlternativeSchema = z.object({
  /** The rewritten question, ready to drop into the structure. */
  prompt: z.string().min(1).max(PROMPT_MAX),
  /**
   * The dimensions this phrasing actually resolves. Non-empty: a phrasing that addresses nothing
   * is not an alternative, it is noise.
   */
  addresses: z.array(z.enum(EVALUATION_DIMENSIONS)).min(1),
  /** Why this phrasing, or what it trades away — one or two sentences. */
  note: z.string().min(1).max(NOTE_MAX),
});

/** Every alternative proposed for one target, plus what none of them could fix. */
export const reconciledSuggestionSchema = z.object({
  /** The question this reconciles — must match a `targetKey` the caller supplied. */
  targetKey: z.string().min(1),
  alternatives: z.array(reconciledAlternativeSchema).min(1).max(MAX_ALTERNATIVES_PER_TARGET),
  /**
   * Concerns no proposed phrasing resolves — usually because the fix is structural (split the
   * question in two, change its answer type, move it to another section) rather than a matter of
   * wording. Empty is the normal case; a populated list is a signal to the admin that wording alone
   * will not close this out.
   *
   * A split belongs here even though `split_question` exists as a judge op: that op is how a JUDGE
   * proposes the split, not something this reconciler can emit. Its only output is one rewritten
   * `prompt`, so a split-shaped concern is still not something a wording of its can close.
   */
  unresolved: z.array(z.enum(EVALUATION_DIMENSIONS)).default([]),
});

/** The reconciler's whole response. */
export const reconcileResultSchema = z.object({
  reconciliations: z.array(reconciledSuggestionSchema).max(MAX_RECONCILED_TARGETS),
});

export type ReconciledAlternative = z.infer<typeof reconciledAlternativeSchema>;
export type ReconciledSuggestion = z.infer<typeof reconciledSuggestionSchema>;
export type ReconcileResult = z.infer<typeof reconcileResultSchema>;

/** Discriminated result of validating a parsed candidate against the contract. */
export type ReconcileValidation =
  { ok: true; value: ReconcileResult } | { ok: false; issues: z.core.$ZodIssue[] };

/**
 * Validate an already-JSON-parsed value against {@link reconcileResultSchema}. Mirrors
 * `validateJudgeVerdict` — the typed value, or the flat issue list the repair retry names fields
 * from.
 */
export function validateReconcileResult(parsed: unknown): ReconcileValidation {
  const result = reconcileResultSchema.safeParse(parsed);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, issues: result.error.issues };
}

/**
 * Soft-degrade a stored `reconciledSuggestions` blob to a validated list.
 *
 * Read-path posture, the `parseAudienceShape` discipline: runs stored JSON through the same schema
 * on the way out and degrades a malformed value to `[]` rather than throwing. Legacy runs — every
 * run made before reconciliation existed — have no column value at all and land here as `null`,
 * which is not an error: it means "this run was never reconciled", and the UI and pack simply show
 * the judges' own suggestions, exactly as they did before.
 */
export function parseReconciledSuggestions(raw: unknown): ReconciledSuggestion[] {
  if (raw === null || raw === undefined) return [];
  const parsed = z.array(reconciledSuggestionSchema).safeParse(raw);
  return parsed.success ? parsed.data : [];
}
