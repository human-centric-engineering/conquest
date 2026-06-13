/**
 * Seriousness / abuse gate — pure in-memory shapes.
 *
 * A respondent can give answers that aren't genuine — preposterous ("543 years" of tenure),
 * abusive, or off-topic. This module owns the pure, DB-free shapes for judging one answer's
 * seriousness and for the escalating strike/abandon decision. Like contradiction detection
 * (F4.3) it never overwrites or persists anything: the orchestrator disregards a flagged
 * answer, surfaces a warning, and (at the threshold) signals the route to abandon the session.
 *
 * Tolerant by design — colloquial / lazy / brief answers ("very unlikely") are GENUINE and
 * must pass; only abuse / ridiculous / impossible / off-topic responses fail.
 */

/** Everything the judge reads to rule on one answer — entirely in-memory. */
export interface SeriousnessJudgeInput {
  /** The active question's prompt the answer is responding to. */
  questionPrompt: string;
  /** The respondent's raw message this turn. */
  userMessage: string;
  /** The value the extractor parsed from the message, when any — a sanity-check signal. */
  extractedValue?: unknown;
  /** Recent transcript (oldest → newest) for context. */
  recentMessages?: string[];
  /** Stable session identity — threaded into cost-log metadata. */
  sessionId: string;
}

/** The judge's ruling on one answer. */
export interface SeriousnessVerdict {
  /** `true` = a genuine attempt (incl. colloquial/lazy); `false` = abuse/ridiculous/off-topic. */
  serious: boolean;
  /** A short, polite, respondent-safe reason — surfaced when not serious. */
  reason: string;
}

/**
 * The outcome of recording one non-serious answer against the session's strike counter — the
 * pure decision the orchestrator acts on. `abandon` is terminal; otherwise `noticeMessage` is the
 * escalating side-band copy to surface while the same question is re-asked.
 */
export interface AbuseStrikeOutcome {
  /** The session's strike count after this flagged answer. */
  newStrikeCount: number;
  /** True when this strike reaches the threshold — the session must be abandoned. */
  abandon: boolean;
  /** Escalating warning copy to surface as a side-band notice (empty when abandoning). */
  noticeMessage: string;
  /** The deterministic final agent message streamed when abandoning (absent otherwise). */
  abandonMessage?: string;
}
