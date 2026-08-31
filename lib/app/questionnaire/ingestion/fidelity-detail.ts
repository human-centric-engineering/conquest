/**
 * The `extraction_verify` provenance row's `detail` — written by ingest, read by the admin.
 *
 * ## Why one module owns both ends
 *
 * The detail object was built inline in BOTH stream routes, identically, and that duplication has
 * already cost something: the commit that added `unattributedPromptCount` fixed only one of the two
 * copies on its first pass. Nothing catches that — the routes are tested separately, and a signal
 * missing from one of them looks exactly like an ingest that had nothing to report.
 *
 * So the writer lives here, and so does the reader ({@link readFidelityDetail}). A field added to
 * one and forgotten in the other is the failure mode that matters for a provenance row: it is
 * written once, months before anyone reads it, and by then the run cannot be repeated.
 *
 * Pure — no Prisma, no server-only imports, no `next/*`. The reader is imported by a client
 * component, so this file must stay in the client bundle's reach.
 */

import { z } from 'zod';

import {
  coverageSchema,
  questionVerdictSchema,
  type VerifyCoverage,
} from '@/lib/app/questionnaire/ingestion/verify-schema';

/** What happened to the questions the critic flagged. Mirrors `FidelityRecord.repairOutcome`. */
export const REPAIR_OUTCOMES = [
  'none_flagged',
  'repaired',
  'repair_failed',
  'skipped_systemic',
  'verifier_unavailable',
] as const;
export type RepairOutcome = (typeof REPAIR_OUTCOMES)[number];

/**
 * The fields of the orchestrator's `FidelityRecord` that reach the row, plus the file name.
 *
 * Structural rather than an import of `FidelityRecord` itself: that type lives in the API tier
 * behind `import 'server-only'`, and this module is reachable from the client.
 */
export interface FidelityDetailInput {
  flaggedCount: number;
  totalCount: number;
  repairOutcome: RepairOutcome;
  coverage: VerifyCoverage | null;
  disallowedEditCount: number;
  unattributedPromptKeys: string[];
  droppedNonQuestionKeys: string[];
  retainedCount: number;
  fileName: string;
}

/**
 * Build the `detail` blob for the `extraction_verify` run.
 *
 * The whole-set signals are **omitted when they have nothing to say** — no coverage read, no
 * disallowed edits, no unattributed prompts, nothing dropped. That is deliberate and load-bearing
 * for the reader: a present key means something happened, so a clean ingest's row stays short and
 * an admin surface can render "nothing to report" by finding nothing rather than by comparing
 * zeroes.
 *
 * `unattributedPromptCount` is written alongside the keys, derived from `.length` rather than
 * carried separately, because a corpus run reads the count and two fields that can disagree
 * eventually do.
 */
export function buildFidelityDetail(input: FidelityDetailInput): Record<string, unknown> {
  return {
    flaggedCount: input.flaggedCount,
    ...(input.coverage ? { coverage: input.coverage } : {}),
    ...(input.disallowedEditCount > 0 ? { disallowedEditCount: input.disallowedEditCount } : {}),
    ...(input.unattributedPromptKeys.length > 0
      ? {
          unattributedPromptCount: input.unattributedPromptKeys.length,
          unattributedPromptKeys: input.unattributedPromptKeys,
        }
      : {}),
    ...(input.droppedNonQuestionKeys.length > 0
      ? {
          droppedNonQuestionCount: input.droppedNonQuestionKeys.length,
          droppedNonQuestionKeys: input.droppedNonQuestionKeys,
        }
      : {}),
    totalCount: input.totalCount,
    // Written only when it disagrees with `totalCount`, which is the same omit-when-nothing-to-say
    // rule the signals above follow: an ingest that removed and merged nothing retained everything
    // it checked, and a key repeating that says nothing a reader has to read.
    ...(input.retainedCount !== input.totalCount ? { retainedCount: input.retainedCount } : {}),
    repairOutcome: input.repairOutcome,
    fileName: input.fileName,
  };
}

/* -------------------------------------------------------------------------- */
/* Read side                                                                  */
/* -------------------------------------------------------------------------- */

/** One question the critic flagged `suspect`, as the admin surface shows it. */
export interface FlaggedQuestion {
  key: string;
  /** What kind of unfaithfulness, when the critic named one. */
  issue: string | null;
  /** The critic's one-line explanation, when it gave one. */
  detail: string | null;
}

/**
 * What an admin can be told about how faithfully this version was extracted.
 *
 * Everything here is READ-ONLY and advisory. None of it blocks an ingest — by the time any of it
 * is knowable the questions already exist — and none of it is a setting. It exists because the
 * signals were being computed, logged, and then shown to nobody.
 */
export interface VersionFidelityView {
  /** How many questions the critic checked. */
  totalCount: number;
  /**
   * The ones it flagged `suspect`, with the reason when it gave one.
   *
   * Can be EMPTY while {@link flaggedCount} is non-zero: the verdicts are reconstructed from the
   * run's output snapshot, which the store caps and marks truncated. Render the count, not the
   * list's length, or a long questionnaire silently reports itself clean.
   */
  flagged: FlaggedQuestion[];
  /** How many the critic flagged, as the row recorded it — authoritative over `flagged.length`. */
  flaggedCount: number;
  /**
   * What became of the flagged ones. `repair_failed` and `skipped_systemic` are the two that
   * matter to a reader: the questions stayed as extracted, and nothing else says so.
   */
  repairOutcome: RepairOutcome;
  /** The critic's read on the question COUNT, or null when it did not report one. */
  coverage: VerifyCoverage | null;
  /** Keys of questions reworded with no change record. Empty on a legacy row that stored a count only. */
  unattributedPromptKeys: string[];
  /**
   * How many were reworded without a record. Usually `unattributedPromptKeys.length`, but read
   * separately so a row written before the keys existed still reports its number rather than
   * silently reading as clean — see {@link readFidelityDetail}.
   */
  unattributedPromptCount: number;
  /** Editorial edits the extractor was instructed not to make. Build health; not shown to admins. */
  disallowedEditCount: number;
  /**
   * Keys of spans REMOVED because they were not questions (interviewer script, a transition, an
   * instruction). Empty on a legacy row and on any ingest that removed nothing.
   */
  droppedNonQuestionKeys: string[];
  /**
   * How many were removed. Read separately from the list's length for the same reason
   * {@link unattributedPromptCount} is: a row can carry a count without the keys, and reporting
   * zero because the names are missing would say "nothing was deleted" about an ingest that
   * deleted something.
   */
  droppedNonQuestionCount: number;
  /**
   * How many questions the version actually holds, as opposed to how many the critic checked
   * ({@link VersionFidelityView.totalCount}). The two differ once a drop or a `merge` repair has
   * changed the count between the check and the persist.
   *
   * Falls back to `totalCount` rather than to zero: a row that omits it is a row where nothing
   * changed the count (or a legacy row written before the field existed), and both of those
   * retained everything they checked.
   */
  retainedCount: number;
  /** The document this describes, when the row recorded it. */
  fileName: string | null;
  /** When the check ran (ISO). */
  checkedAt: string;
  /** True when the critic never reached a provider — every "nothing was flagged" here is vacuous. */
  verifierUnavailable: boolean;
}

const detailSchema = z.object({
  flaggedCount: z.number().int().nonnegative().catch(0),
  totalCount: z.number().int().nonnegative().catch(0),
  repairOutcome: z.enum(REPAIR_OUTCOMES).catch('none_flagged'),
  coverage: coverageSchema.nullish().catch(null),
  disallowedEditCount: z.number().int().nonnegative().nullish().catch(null),
  unattributedPromptCount: z.number().int().nonnegative().nullish().catch(null),
  unattributedPromptKeys: z.array(z.string()).nullish().catch(null),
  droppedNonQuestionCount: z.number().int().nonnegative().nullish().catch(null),
  droppedNonQuestionKeys: z.array(z.string()).nullish().catch(null),
  retainedCount: z.number().int().nonnegative().nullish().catch(null),
  fileName: z.string().nullish().catch(null),
});

/**
 * Project a stored `extraction_verify` row onto {@link VersionFidelityView}, or null.
 *
 * ## Every field is `.catch()`-ed, deliberately
 *
 * This reads a `Json` column written by a past build. A row from before the coverage dimension
 * existed has no `coverage`; a row from before the keys existed has a count and no keys; a row
 * from a future build may have fields this one has never heard of. None of those is a reason to
 * tell an admin nothing — the alternative to a partial answer here is a blank panel that looks
 * exactly like a clean ingest. So a malformed field degrades to its empty value and the rest of
 * the row still renders. This is the read-path posture the rest of the app uses rather than a
 * migration, because there is nothing to migrate TO: the older rows are honest records of what
 * older builds knew.
 *
 * `null` is returned only when there is no row at all — no verify pass ran for this version.
 */
export function readFidelityDetail(input: {
  detail: unknown;
  outputSnapshot: unknown;
  status: string;
  createdAt: Date;
}): VersionFidelityView | null {
  const parsed = detailSchema.safeParse(input.detail);
  if (!parsed.success) return null;
  const d = parsed.data;

  // The verdicts live on the output snapshot rather than the detail, so the flagged list is
  // reconstructed rather than stored twice. A snapshot that is missing or truncated (the store
  // caps it at AI_RUN_SNAPSHOT_MAX_CHARS) yields an empty list, which is why `flaggedCount` is
  // carried from the detail rather than derived: on a long questionnaire the list can be empty
  // while three questions really were flagged.
  const verdicts = z.array(questionVerdictSchema).catch([]).parse(input.outputSnapshot);
  const flagged: FlaggedQuestion[] = verdicts
    .filter((v) => v.verdict === 'suspect')
    .map((v) => ({ key: v.key, issue: v.issue ?? null, detail: v.detail ?? null }));

  const keys = d.unattributedPromptKeys ?? [];
  const droppedKeys = d.droppedNonQuestionKeys ?? [];
  return {
    totalCount: d.totalCount,
    flagged,
    flaggedCount: d.flaggedCount,
    repairOutcome: d.repairOutcome,
    coverage: d.coverage ?? null,
    unattributedPromptKeys: keys,
    // The stored count wins when present, so a legacy row that recorded "2" without saying which
    // two still reports 2 rather than reading as clean. Falls back to the list's length for a row
    // that somehow carried keys without a count.
    unattributedPromptCount: d.unattributedPromptCount ?? keys.length,
    droppedNonQuestionKeys: droppedKeys,
    droppedNonQuestionCount: d.droppedNonQuestionCount ?? droppedKeys.length,
    retainedCount: d.retainedCount ?? d.totalCount,
    disallowedEditCount: d.disallowedEditCount ?? 0,
    fileName: d.fileName ?? null,
    checkedAt: input.createdAt.toISOString(),
    verifierUnavailable: d.repairOutcome === 'verifier_unavailable' || input.status === 'failed',
  };
}

/**
 * Whether this view has anything worth putting in front of an admin.
 *
 * `disallowedEditCount` is excluded on purpose: it answers "is the extractor's do-not-split
 * instruction landing?", which is a question about the BUILD, not about this questionnaire. There
 * is no action an admin could take on it, and a panel that appears with nothing actionable in it
 * trains people to close the panel.
 */
export function hasFidelityFindings(view: VersionFidelityView): boolean {
  return (
    view.verifierUnavailable ||
    view.flaggedCount > 0 ||
    view.unattributedPromptCount > 0 ||
    view.droppedNonQuestionCount > 0 ||
    (view.coverage !== null &&
      view.coverage.assessment !== 'matches' &&
      view.coverage.assessment !== 'uncountable')
  );
}
