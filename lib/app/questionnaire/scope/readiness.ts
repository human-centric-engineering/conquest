/**
 * How much of the opening is in — the one arithmetic behind both the gate and the floor (F17.36).
 *
 * Conditional Topics decides once, at the end of the opening. Two things need to know how far
 * through it a session is, and they need slightly different answers:
 *
 * - **The gate** (`isOpeningComplete`) asks "is the opening finished?" — a yes/no, and the yes has
 *   to be every member of every opening topic. That is the sealed decision, and it should read the
 *   opening as generously as the orchestrator does.
 * - **The floor** (early topic seating) asks "is enough of the opening in to judge on?" — a ratio,
 *   and it should read the opening more strictly than the gate does, because it is spending a
 *   decision on partial information.
 *
 * They are one function with a flag rather than two functions, and that is deliberate. The
 * `isOpeningComplete` docblock records what a second definition of coverage already cost this
 * codebase once: a gate that judged the opening on its data slots alone let a questions-only
 * opening topic read as complete before it had been asked, and the planner ran on turn one over an
 * empty transcript. Two numbers that must agree, computed in two places, disagree eventually.
 *
 * ## Why parking is a flag and not a fixed answer
 *
 * A data slot self-heals. After `maxDataSlotAttempts` the orchestrator gives up re-asking and parks
 * it with a synthesised `provisional` fill, and that park is what stops a vague answer holding an
 * interview in its opening forever. A question slot has no equivalent, so the slot half of the gate
 * degrades gracefully and the question half does not.
 *
 * The gate must keep counting parks, or it reintroduces the stall the parking exists to prevent.
 * The floor must not, because a park is a best-effort inference the interviewer gave up on: letting
 * three of those carry a session over the floor would seat topics on evidence nobody actually gave.
 *
 * ## Unresolvable members are skipped, here as everywhere
 *
 * An opening topic may name a question deleted after the topic was authored. That key can never be
 * answered, and counting it would hold every interview in its opening forever — so it is skipped,
 * which is what every other part of this feature does with a member key that no longer resolves.
 * Data-slot members are not filtered the same way: the caller has no equivalent inventory here, and
 * the gate has always treated an unresolvable slot key as uncovered. Changing that silently would
 * be a behaviour change wearing a refactor's clothes.
 *
 * Pure. No Prisma, no I/O, no clock.
 */

import type { Topic } from '@/lib/app/questionnaire/scope/types';

/** What the caller knows about the session's question answers, for the opening gate. */
export interface OpeningQuestionCoverage {
  /** Question keys this session already holds an answer for. */
  answered: ReadonlySet<string>;
  /**
   * Every question key the version actually has.
   *
   * An opening topic may name a key that no longer resolves — a question deleted after the topic
   * was authored — and that key can never be answered. Unresolvable member keys are silently
   * skipped everywhere else in this feature; skipping them here too is what stops a stale member
   * from holding every interview in its opening forever.
   */
  known: ReadonlySet<string>;
}

/**
 * What the caller knows about the session's data-slot fills, split by how the fill was arrived at.
 *
 * Split rather than one set because the two readers disagree about parks (see the module docblock),
 * and a single pre-merged set cannot be un-merged. A caller that genuinely does not track parking
 * passes them all as `filled` and gets today's behaviour under `countParked: true`.
 */
export interface OpeningSlotCoverage {
  /**
   * Slot keys covered by a fill the respondent actually gave — stated directly, or scored at or
   * above the orchestrator's confidence threshold.
   */
  filled: ReadonlySet<string>;
  /**
   * Slot keys the interviewer gave up re-asking and parked with a synthesised `provisional` fill.
   *
   * Counted as covered by the gate, never by the floor.
   */
  parked: ReadonlySet<string>;
}

/** How far through the opening a session is, and what is still outstanding. */
export interface OpeningReadiness {
  /** Members covered, under the flag the caller passed. */
  covered: number;
  /** Resolvable members in total. Unresolvable question keys are not counted. */
  total: number;
  /**
   * `covered / total`, and **1 when there are no opening topics at all**.
   *
   * An instrument with no opening has nothing to wait for, so "fully ready" is the honest reading —
   * the same direction `isOpeningComplete` has always taken, and the one that plans rather than
   * strands.
   */
  ratio: number;
  /** What is still outstanding, so a surface can name it rather than report a bare fraction. */
  uncovered: { dataSlotKeys: string[]; questionKeys: string[] };
}

/**
 * Measure the opening.
 *
 * `countParked: true` reproduces the gate's semantics exactly. `countParked: false` is what the
 * early-seating floor reads.
 */
export function openingReadiness(
  topics: readonly Topic[],
  slots: OpeningSlotCoverage,
  questions: OpeningQuestionCoverage | undefined,
  opts: { countParked: boolean }
): OpeningReadiness {
  // `topics.filter(phase === 'opening')` rather than `alwaysTopics(topics).filter(...)`: `opening`
  // is one of the always-phases, so the second filter is the whole of the first. Spelling it out
  // keeps this module a leaf that imports nothing but the type.
  const opening = topics.filter((t) => t.phase === 'opening');

  const uncoveredDataSlotKeys: string[] = [];
  const uncoveredQuestionKeys: string[] = [];
  let covered = 0;
  let total = 0;

  for (const key of dedupe(opening.flatMap((t) => t.members.dataSlotKeys))) {
    total += 1;
    if (slots.filled.has(key) || (opts.countParked && slots.parked.has(key))) covered += 1;
    else uncoveredDataSlotKeys.push(key);
  }

  // `questions` undefined means the caller has no answer data at all, not that there are no
  // answers — so the question half is skipped entirely rather than counted as uncovered. A caller
  // without it still gets the data-slot half, which is what it got before this module existed.
  if (questions) {
    for (const key of dedupe(opening.flatMap((t) => t.members.questionKeys))) {
      if (!questions.known.has(key)) continue;
      total += 1;
      if (questions.answered.has(key)) covered += 1;
      else uncoveredQuestionKeys.push(key);
    }
  }

  return {
    covered,
    total,
    ratio: total === 0 ? 1 : covered / total,
    uncovered: { dataSlotKeys: uncoveredDataSlotKeys, questionKeys: uncoveredQuestionKeys },
  };
}

/**
 * De-duplicate member keys, preserving authored order.
 *
 * Two opening topics may name the same slot — `validate.ts` reports that as
 * `duplicate_membership`, but it does not prevent it. Counting such a member twice would make the
 * ratio depend on how the author grouped their topics rather than on how much the respondent has
 * answered, and would let one shared slot move the floor by two.
 */
function dedupe(keys: readonly string[]): string[] {
  return [...new Set(keys)];
}
