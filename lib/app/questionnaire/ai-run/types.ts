/**
 * AI run provenance — pure domain types (F14.15).
 *
 * No Prisma, no Next: the vocabulary and shapes the {@link AppAiRun} write seam and its read
 * surfaces share. The persistence seam lives in the API tier
 * (`app/api/v1/app/questionnaires/_lib/ai-run-store.ts`), matching how the turn-evaluation core
 * keeps `lib/` free of `@/lib/db`.
 *
 * ## What belongs in an AppAiRun
 *
 * A run is recorded when at least one of these holds:
 *
 * - **A human later acts on its verdict** — evaluation findings, critic flags, advisor suggestions.
 * - **It changed durable config** — anything that mutated a questionnaire version's structure.
 * - **You would need to defend the output to a client** — reports, scoring, extraction fidelity.
 * - **It is a calibration signal worth a trend** — judge scores, coverage, cost per artifact.
 *
 * Deliberately NOT recorded: interactive previews the admin is merely exploring with, mid-workflow
 * control flow (already captured in `AiWorkflowExecution.executionTrace`), and the regex input /
 * output guards (no LLM call to describe). Recording those would add cost and noise without making
 * a new question answerable.
 */

/** The subject a run acted on. Paired with `subjectId` to form the polymorphic reference. */
export const APP_AI_RUN_SUBJECTS = [
  'version',
  'session',
  'respondent_report',
  'cohort_report',
] as const;
export type AppAiRunSubject = (typeof APP_AI_RUN_SUBJECTS)[number];

/**
 * What kind of run this was. One entry per capturing surface, so `kind` alone answers
 * "show me every fidelity-critic run" without joining anything.
 */
export const APP_AI_RUN_KINDS = [
  /** Extraction fidelity critic — verdicts per question, plus any repair it triggered. */
  'extraction_verify',
  /** Config Advisor — the streamed narrative + structured suggestion set. */
  'config_advice',
  /** Edit-with-AI, precise mode — the deterministic edit-ops applied to a version. */
  'edit_precise',
  /** Edit-with-AI, rewrite mode — a whole-structure replacement (supersedes the change log). */
  'edit_rewrite',
  /** Report preview — the full generation core run against a draft, incl. its method record. */
  'report_preview',
  /** Learning digest — one round's digest generation, kept so digests have a history. */
  'learning_digest',
] as const;
export type AppAiRunKind = (typeof APP_AI_RUN_KINDS)[number];

/** Terminal state of the run. A failed run is kept — "the critic errored" is a real answer. */
export const APP_AI_RUN_STATUSES = ['succeeded', 'failed'] as const;
export type AppAiRunStatus = (typeof APP_AI_RUN_STATUSES)[number];

/**
 * Cap on a stored prompt/output snapshot, in characters.
 *
 * Snapshots exist to answer "what did the model actually see and say", which a generous prefix
 * satisfies. Storing them unbounded would let one pathological run (a 200-question questionnaire
 * inlined into a critic prompt) dominate the table, so the writer truncates and sets `truncated`
 * rather than silently storing either everything or nothing.
 */
export const AI_RUN_SNAPSHOT_MAX_CHARS = 20_000;

/** The marker appended to a truncated snapshot so a reader is never misled by a clean cut. */
export const AI_RUN_TRUNCATION_MARKER = '\n\n…[truncated]';

/**
 * Truncate one snapshot value to {@link AI_RUN_SNAPSHOT_MAX_CHARS}.
 *
 * Returns the value unchanged when it fits, and reports whether truncation occurred so the caller
 * can set the row's `truncated` flag once across both snapshots. Non-string values are serialised
 * before measuring — a giant JSON object needs capping just as much as a giant string.
 */
export function truncateSnapshot(value: unknown): { value: unknown; truncated: boolean } {
  if (value === null || value === undefined) return { value: null, truncated: false };

  const text = typeof value === 'string' ? value : safeStringify(value);
  if (text === null) {
    return { value: '[unserialisable]', truncated: false };
  }
  if (text.length <= AI_RUN_SNAPSHOT_MAX_CHARS) {
    // Keep the original shape when it fits — a JSON object stays queryable as JSON.
    return { value, truncated: false };
  }
  return {
    value: text.slice(0, AI_RUN_SNAPSHOT_MAX_CHARS) + AI_RUN_TRUNCATION_MARKER,
    truncated: true,
  };
}

/** `JSON.stringify` that yields null instead of throwing on a cyclic/unserialisable value. */
function safeStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}
