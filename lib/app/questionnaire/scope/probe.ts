/**
 * The opening's probe allowance (G03 / F17.17) — pure arithmetic.
 *
 * A **probe** is a follow-up: a turn that re-asks something the opening has already asked, because
 * what came back was too vague to route on. It is the interviewer's most useful move and its most
 * expensive one — every probe spends a turn the plan could have spent on a routed section, which is
 * why the client who specified this instrument asked for **one probe for the whole opening** rather
 * than one per question.
 *
 * `maxDataSlotAttempts` cannot express that: a per-slot cap has no idea a probe was already spent
 * three questions ago. This module holds the session-scoped counter that can.
 *
 * The other half — *whether the probe would buy anything* — is
 * `scope/routability.ts`, deliberately a separate module: the counter is cheap and pure, the
 * classifier calls a model, and the orchestrator that imports this one must stay free of Prisma.
 *
 * ## Off by default, inert by construction
 *
 * The allowance applies only while `limitOpeningProbes` is on, only to data slots belonging to an
 * `opening` topic, and only before the plan is decided. Every other version — and every turn after
 * the opening — never sees an {@link OpeningProbeBudget} at all.
 */

/**
 * The opening's follow-up allowance for one session, as the turn loader resolves it.
 *
 * Present only while the allowance actually governs something: the feature on, the plan undecided,
 * and at least one data slot belonging to an `opening` topic.
 */
export interface OpeningProbeBudget {
  /** `AppDataSlot.id`s belonging to an `opening` topic — the only slots the allowance governs. */
  slotIds: string[];
  /** Follow-ups already spent across the opening, counted from the session's turns. */
  spent: number;
  /** How many the whole opening gets. */
  allowance: number;
}

/**
 * Follow-ups spent so far, from the ids the session's turns targeted (any order).
 *
 * A probe is the SECOND and every later turn on the same opening slot, so the count is simply
 * "opening turns minus distinct opening slots". Deriving it from the turn record rather than a
 * counter column is what makes the number self-healing: a turn that never persisted never spent a
 * probe, and no bookkeeping has to remember that.
 */
export function countOpeningProbes(
  targetedDataSlotIds: readonly (string | null | undefined)[],
  openingSlotIds: ReadonlySet<string>
): number {
  let asks = 0;
  const seen = new Set<string>();
  for (const id of targetedDataSlotIds) {
    if (!id || !openingSlotIds.has(id)) continue;
    asks += 1;
    seen.add(id);
  }
  return Math.max(0, asks - seen.size);
}

/** How many follow-ups the opening has left. Never negative. */
export function probesRemaining(budget: OpeningProbeBudget): number {
  return Math.max(0, budget.allowance - budget.spent);
}

/** Whether the allowance governs this data slot (i.e. it belongs to an `opening` topic). */
export function governsSlot(budget: OpeningProbeBudget | undefined, slotId: string): boolean {
  return budget !== undefined && budget.slotIds.includes(slotId);
}
