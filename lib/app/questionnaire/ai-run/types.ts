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
  /** An `AppExperienceRun` — the journey a respondent took across an Experience's legs (P15). */
  'experience_run',
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
  /**
   * Experience routing (P15) — the selector's decision at a fork, plus the rationale behind it.
   * Recorded for every decision including the deterministic ones: "why did this respondent get
   * that questionnaire" is a question an admin will ask about a run months later, and a rule-based
   * answer is as worth defending as an LLM one.
   */
  'experience_routing',
  /** Experience handoff (P15) — the carry-over briefing compressed for the next leg's prompt. */
  'experience_handoff',
  /** Experience report (P15) — the run-level synthesis across every leg. */
  'experience_report',
  /**
   * Glossary analysis (P16) — the terms the analyst proposed for a version, and why.
   *
   * Recorded because a human acts on the verdict (the admin adjudicates every proposal) and
   * because the accepted result changes durable config: an accepted definition is injected into
   * the interviewer and extraction prompts, so "where did this definition come from" is a
   * question worth being able to answer months later.
   */
  'glossary_analysis',
  /**
   * Conditional Topics planning (P17) — which conditional topics a respondent's interview covers, and
   * why each was chosen or left out.
   *
   * Recorded for EVERY plan, including the ones no model produced (a hard rule, the fallback, or an
   * interview with nothing to decide). "Why did this respondent get those topics" is the question
   * an admin will ask about an adaptive instrument months later, and a deterministic answer is as
   * worth defending as an inferred one — `provider`/`model` read `deterministic` on those, so cost
   * trends stay clean.
   */
  'scope_plan',
  /**
   * Routing analysis (P17.4) — the topic set and hard rules the analyst read out of an uploaded
   * instrument, and the span of the document each was drawn from.
   *
   * Recorded because a human acts on the verdict (the admin reviews every proposal before it goes
   * live) and because an accepted proposal changes durable config — it decides which parts of the
   * questionnaire a respondent is ever asked. Kept even when the admin discards the proposal: "we
   * ran the analyst and it found nothing routable in this document" is a real answer, and losing it
   * means paying for the same call again to learn the same thing.
   */
  'routing_analysis',
  /**
   * Conditional Topics candidacy check (P17.19) — the cheap ingestion-time triage read that decides
   * whether a freshly-uploaded document is worth flagging as a routing candidate.
   *
   * Recorded because the verdict drives an automatic action downstream (the Routing Analyst
   * auto-run) and because it is a calibration signal worth a trend: if this check systematically
   * over- or under-fires, that is only visible with a history of what it actually said. Not
   * recorded at all when the version was ineligible (scope already on, already authored) — that is
   * a skip, not a run.
   */
  'scope_candidacy',
  /**
   * House-rule suggestions — the behaviour rules the assistant proposed for a version, with the
   * reasoning behind each one.
   *
   * Recorded on the same grounds as `glossary_analysis`: a human adjudicates every proposal, and an
   * accepted rule changes durable config that shapes what the interviewer says to real respondents.
   * "Where did this rule come from, and what was it for" is a question worth answering months later
   * — especially for the compliance-shaped rules (anonymity claims, what the client will not
   * promise) this assistant is most often asked to draft. Kept when the admin discards everything
   * too: "we ran it and it had nothing useful to add" is a real answer.
   *
   * Distinct from the Respondent Report config assistant (`report/craft`), which records nothing —
   * that is a multi-turn chat where the admin is thinking aloud. This is a one-shot analysis of the
   * questionnaire, structurally the Config Advisor, so it follows the Advisor's precedent.
   */
  'house_rules_suggest',
  /**
   * Opening-question suggestions — the example openers the assistant proposed for a version.
   *
   * Same grounds as `house_rules_suggest`: a human adjudicates each one, and an accepted example
   * becomes durable config that shapes the first thing a real respondent is ever asked. The opening
   * carries disproportionate weight — it is what decides whether someone writes three words or
   * three paragraphs — so "where did this opener come from" is worth answering later. Kept when it
   * proposes nothing, too: that is a real answer about the questionnaire, not an absence of one.
   */
  'opening_examples_suggest',
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
