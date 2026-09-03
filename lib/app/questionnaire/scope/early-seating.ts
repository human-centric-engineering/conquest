/**
 * Early topic seating (F17.36) — deciding during the opening, not only at the end of it.
 *
 * The opening exists to find out what is relevant, important and significant. Until this module,
 * it could only report that finding once, at the very end of itself, and only when every one of its
 * members was covered. A respondent could spend six turns making it obvious which area mattered and
 * the interview would not act on it until the last opening question was answered.
 *
 * ## The design in one line
 *
 * > Planning becomes two stages over one plan: provisional seating during the opening, then the
 * > existing planner at the end, which seals the record.
 *
 * The final planner still runs, always, over the complete opening. Early seating front-runs it; it
 * never replaces it. That is what preserves the balanced judgement the feature is built around
 * while removing the all-or-nothing wait.
 *
 * ## The invariants — the line between a tuning knob and a re-planning engine
 *
 * 1. **Only ever adds.** An early seat brings a topic into scope. Nothing removes one, including
 *    the final planner. Same invariant as `amendment.ts`, and for the same reason: an interview
 *    that silently narrowed produces a report that means something different from every other in
 *    the cohort.
 * 2. **The final plan is still a single coherent statement.** It absorbs every early seat with its
 *    own source and turn, so a finished report is still reproducible from the record.
 * 3. **Breadth is one budget.** Early seats consume `maxConditionalTopics`. The two sub-caps bound
 *    how much of it partial information may spend, and how much any single turn may spend.
 *
 * Any request to remove, re-rank or re-plan is a different specification. This module only adds.
 *
 * ## Two numbers, never one
 *
 * The **floor** is coverage — how much of the opening is in. The **bar** is confidence — how sure
 * the planner is about this one topic. They answer different questions, they are separately
 * explicable on the admin surface, and blending them produces a number nobody can reason about.
 *
 * Pure. No Prisma, no I/O, no clock, no model.
 */

import {
  EARLY_SEATING_CADENCE_TURNS,
  EVIDENCE_KEY_MAX_LENGTH,
  MAX_DEFERRED_EARLY_PICKS,
  type ConditionalTopicsSettings,
  type EarlySeat,
  type EarlySeating,
  type InterviewPlan,
  type ScopeFill,
  type Topic,
} from '@/lib/app/questionnaire/scope/types';
import type { OpeningReadiness } from '@/lib/app/questionnaire/scope/readiness';
import { topicSizeWording } from '@/lib/app/questionnaire/scope/amendment';

/** The empty record a session starts from. Never written until a pass actually runs. */
export function emptyEarlySeating(): EarlySeating {
  return { v: 1, seated: [], deferred: [], lastPassAtTurn: 0, evidenceKey: '', overCap: false };
}

/** Topic keys a session has already seated early. */
export function earlySeatedKeys(early: EarlySeating | null): Set<string> {
  return new Set((early?.seated ?? []).map((s) => s.key));
}

/* -------------------------------------------------------------------------- */
/* The evidence-change gate                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A cheap fingerprint of what the respondent has actually given.
 *
 * The single condition that removes most turns regardless of cadence: a turn that added no new fill
 * and no new answer cannot change the judgement, so it must not pay for one.
 *
 * Counts and sorted keys rather than values, on purpose. A respondent revising an answer they had
 * already given does move the judgement in principle, but detecting that needs the values, which
 * means hashing free text on every turn of every session for a case the next pass will pick up
 * anyway the moment anything new lands. The cheap version is the right trade for a gate whose whole
 * job is to be free.
 */
export function evidenceKeyOf(
  fills: readonly ScopeFill[],
  answeredQuestionKeys: readonly string[]
): string {
  const f = [...new Set(fills.map((x) => x.key))].sort();
  const a = [...new Set(answeredQuestionKeys)].sort();
  // Truncated to the SAME cap the read applies, or the two never compare equal and the gate this
  // whole function exists to serve can never fire. Counts lead, so a cut tail cannot hide a member
  // arriving or leaving — which is the change that most needs to move the key.
  return `${f.length}:${a.length}:${f.join(',')}|${a.join(',')}`.slice(0, EVIDENCE_KEY_MAX_LENGTH);
}

/* -------------------------------------------------------------------------- */
/* The gate, cheapest first                                                   */
/* -------------------------------------------------------------------------- */

/** What the gate decided, and why — the reason string goes straight into the trigger's result. */
export type EarlySeatingGate =
  | { kind: 'stop'; reason: string }
  /** Deferred picks are outstanding: seat from them and make no model call. */
  | { kind: 'drain'; picks: EarlySeat[] }
  /** Everything cheap passed: the caller may load candidates and judge. */
  | { kind: 'judge'; remainingSessionSeats: number; remainingTurnSeats: number };

export interface EarlySeatingGateInput {
  settings: ConditionalTopicsSettings;
  /** Null until the first pass runs. */
  early: EarlySeating | null;
  /** Null while the opening is still running, which is the only time this feature does anything. */
  plan: InterviewPlan | null;
  /** Measured with `countParked: false` — a park is not evidence anyone gave. */
  readiness: OpeningReadiness;
  /** The session's turn count after the turn that just persisted. */
  turnCount: number;
  /** The fingerprint of the evidence as it now stands. */
  evidenceKey: string;
  /** True when the opening completed on this very turn, so the planner is about to seal. */
  openingComplete: boolean;
}

/**
 * Decide whether this turn does anything, spending as little as possible to say no.
 *
 * Nearly every turn stops here having paid nothing but arithmetic over data the trigger already had
 * to load. Tiers, cheapest first:
 *
 * | Tier | Cost            | What it does                                                          |
 * | ---- | --------------- | --------------------------------------------------------------------- |
 * | 0    | one field read  | Deferred picks outstanding? Seat up to the per-turn cap. No model call |
 * | 1    | arithmetic only | Feature on, above the floor, cadence due, allowance unspent, evidence moved |
 *
 * Tier 2 (load candidates) and tier 3 (one planner call) are the caller's, and only run on
 * `judge`.
 */
export function earlySeatingGate(input: EarlySeatingGateInput): EarlySeatingGate {
  const { settings, early, plan, readiness, turnCount, evidenceKey, openingComplete } = input;

  if (!settings.enabled) return { kind: 'stop', reason: 'conditional topics is off' };
  if (!settings.earlyTopicSeating) return { kind: 'stop', reason: 'early seating is off' };

  // A sealed plan is the end of this feature's job. Everything after it belongs to the planner and
  // to respondent amendment.
  if (plan) return { kind: 'stop', reason: 'already planned' };

  // Never both seat early and seal in the same turn. The planner is about to judge the complete
  // opening; front-running it by one function call buys nothing and puts two decisions about the
  // same interview on the same turn.
  if (openingComplete) return { kind: 'stop', reason: 'the opening completed this turn' };

  const seated = early?.seated ?? [];
  const remainingSessionSeats = Math.min(
    settings.maxEarlySeatedTopics - seated.length,
    // Breadth is ONE budget. An early seat spends `maxConditionalTopics`, so a session that has
    // already seated its whole allowance early has nothing left for the planner either — and the
    // planner is the stage that should be spending it.
    settings.maxConditionalTopics - seated.length
  );
  if (remainingSessionSeats <= 0) {
    return { kind: 'stop', reason: 'the early-seating allowance is spent' };
  }

  const remainingTurnSeats = Math.min(settings.maxRoutingDecisionsPerTurn, remainingSessionSeats);

  // Tier 0. Drains what a previous pass judged and could not seat, at the cap rate and for free.
  //
  // Safe because seating only ever adds: the judgement was made on a subset of the evidence that
  // now exists and cleared the confidence bar at the time. Without this the picks would strand —
  // the evidence would not have changed on the next turn, so tier 1 would block and they would
  // never be seated at all.
  const deferred = early?.deferred ?? [];
  if (deferred.length > 0) {
    return { kind: 'drain', picks: deferred.slice(0, remainingTurnSeats) };
  }

  // Tier 1, in ascending order of how likely each is to be the one that stops the turn.
  if (readiness.ratio < settings.earlySeatingFloor) {
    return { kind: 'stop', reason: 'below the opening-coverage floor' };
  }
  if (early && turnCount - early.lastPassAtTurn < EARLY_SEATING_CADENCE_TURNS) {
    return { kind: 'stop', reason: 'not due this turn' };
  }
  if (early && early.evidenceKey === evidenceKey) {
    return { kind: 'stop', reason: 'no new evidence since the last pass' };
  }

  return { kind: 'judge', remainingSessionSeats, remainingTurnSeats };
}

/* -------------------------------------------------------------------------- */
/* Candidates and the seat itself                                             */
/* -------------------------------------------------------------------------- */

/**
 * The conditional topics still eligible for an early seat.
 *
 * Anything already seated is excluded, because seating is idempotent by construction and re-judging
 * a topic the interview is already asking about is spend for no possible decision.
 */
export function earlySeatingCandidates(
  topics: readonly Topic[],
  early: EarlySeating | null
): Topic[] {
  const seated = earlySeatedKeys(early);
  return topics.filter((t) => t.phase === 'conditional' && !seated.has(t.key));
}

/** One judgement the planner returned, before any cap or bar is applied. */
export interface EarlyJudgement {
  key: string;
  confidence: number;
  rationale: string;
  respondentReason: string;
}

export interface ApplyEarlyJudgementsInput {
  early: EarlySeating | null;
  /** The planner's judgements, best first. */
  judgements: readonly EarlyJudgement[];
  /** Every topic in the version — a judgement naming an unknown or always-run key is dropped. */
  topics: readonly Topic[];
  settings: ConditionalTopicsSettings;
  remainingSessionSeats: number;
  remainingTurnSeats: number;
  turnCount: number;
  evidenceKey: string;
}

/** The new record, and which topics this turn actually brought into scope. */
export interface AppliedEarlySeating {
  early: EarlySeating;
  /** Seated on THIS turn — what the caller logs, announces and rescans for. */
  newlySeated: EarlySeat[];
}

/**
 * Turn a set of judgements into the session's new record.
 *
 * Every judgement below the confidence bar is discarded outright: it was not a decision, it was a
 * guess, and it must not sit in `deferred` waiting to become one for free on a later turn.
 * Everything at or above the bar is either seated now or deferred, and the difference is only how
 * many the caps allow this turn.
 */
export function applyEarlyJudgements(input: ApplyEarlyJudgementsInput): AppliedEarlySeating {
  const { settings, judgements, turnCount, evidenceKey } = input;
  const base = input.early ?? emptyEarlySeating();

  const byKey = new Map(
    input.topics.filter((t) => t.phase === 'conditional').map((t) => [t.key, t] as const)
  );
  const alreadySeated = earlySeatedKeys(base);

  const warranted: EarlySeat[] = [];
  const seen = new Set<string>();
  for (const j of judgements) {
    if (j.confidence < settings.earlySeatingMinConfidence) continue;
    const topic = byKey.get(j.key);
    // Unknown, always-run and already-seated keys are silently dropped — the same treatment
    // `applyGuardrails` gives them, and for the same reason: never route into nothing.
    if (!topic || alreadySeated.has(j.key) || seen.has(j.key)) continue;
    seen.add(j.key);
    warranted.push({
      key: j.key,
      depth: topic.depth,
      confidence: j.confidence,
      rationale: j.rationale,
      respondentReason: j.respondentReason,
      atTurn: turnCount,
    });
  }

  const seatable = Math.max(0, Math.min(input.remainingTurnSeats, input.remainingSessionSeats));
  const newlySeated = warranted.slice(0, seatable);
  // What the caps could not take THIS turn, held rather than discarded — bounded, because a record
  // is not a queue and a pass that judged forty topics has a problem no list length will fix.
  const deferred = warranted.slice(seatable, seatable + MAX_DEFERRED_EARLY_PICKS);

  return {
    newlySeated,
    early: {
      v: 1,
      seated: [...base.seated, ...newlySeated],
      // Replaced, never merged: a fresh pass has just judged the current evidence, so anything the
      // previous pass was still holding is a stale judgement and must not outlive it.
      deferred,
      lastPassAtTurn: turnCount,
      evidenceKey,
      // Sticky. Once a session has had more warranted than it could seat, that stays true of the
      // session however the later turns go.
      overCap: base.overCap || warranted.length > seatable,
    },
  };
}

/**
 * Seat picks a previous pass deferred, with no model call.
 *
 * The `drain` half of tier 0. Takes the picks the gate released and moves them from `deferred` to
 * `seated`, leaving the pass bookkeeping untouched — this is not a new judgement, so it must not
 * look like one to the cadence or evidence gates.
 */
export function drainDeferred(
  early: EarlySeating | null,
  picks: readonly EarlySeat[],
  turnCount: number
): AppliedEarlySeating {
  const base = early ?? emptyEarlySeating();
  const taken = new Set(picks.map((p) => p.key));
  // Re-stamped with the turn they actually came into scope on, not the turn they were judged: the
  // panel, the rescan and the announcement all ask "when did this appear", and the answer is now.
  const newlySeated = picks.map((p) => ({ ...p, atTurn: turnCount }));

  return {
    newlySeated,
    early: {
      ...base,
      seated: [...base.seated, ...newlySeated],
      deferred: base.deferred.filter((d) => !taken.has(d.key)),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* What the respondent hears (F17.36 phase 5)                                 */
/* -------------------------------------------------------------------------- */

/** One area this turn brought into scope, as the announcement names it. */
export interface AnnouncedSeat {
  /** The area's own label, in the instrument's language. */
  label: string;
  /**
   * Why, in words the respondent may read, as the early planner wrote them. Blank when the model
   * gave none, and a blank one simply contributes no reason rather than an invented one.
   */
  respondentReason: string;
  /**
   * How many items this area will actually contribute. Omitted means no size claim is made, which
   * is the right answer for a topic whose members cannot be resolved: a missing size is silence, a
   * wrong one is a promise the interview will not keep.
   */
  itemCount?: number;
}

/**
 * The line the interviewer is asked to weave in on the turn after an area was chosen early.
 *
 * A briefing instruction rather than a fixed sentence, for the same reason the plan's handover and
 * the amendment acknowledgement are: an area named in the interviewer's own voice reads as the same
 * person still listening, where a canned "Now covering: Hiring." reads as a form that took an input.
 *
 * ## Coalesced, always
 *
 * One line covering everything a single turn seated, never one per area. `maxRoutingDecisionsPerTurn`
 * above 1 exists precisely because a respondent can say one thing that plainly warrants three
 * areas, and "I'd like to go deeper on hiring and on how you plan capacity" is one sentence a person
 * would say. Three separate acknowledgements in one message is a drip nobody would.
 *
 * ## It says the same three things an amendment acknowledgement says (F17.33)
 *
 * **What** (the area's own label), **how much** ({@link topicSizeWording}), and **why** (the
 * planner's own respondent-facing reason). An area appearing mid-conversation with no explanation
 * is the moment a respondent starts wondering what else is being decided about them, and this
 * announcement lands EARLIER than the plan's does, in the middle of an opening that is still
 * running. The reason matters more here, not less.
 *
 * The vocabulary ban is what makes giving a reason safe: the interviewer may say what it will now
 * cover and why, and may not say anything about how the interview decides.
 *
 * Returns `null` when there is nothing to announce, so the caller has no emptiness of its own to
 * check.
 */
export function earlySeatingBriefingLine(seats: readonly AnnouncedSeat[]): string | null {
  const named = seats.filter((s) => s.label.trim().length > 0);
  if (named.length === 0) return null;

  const areas = named.map((s) => {
    const size = s.itemCount === undefined ? null : topicSizeWording(s.itemCount);
    const reason = s.respondentReason.trim();
    return (
      `${s.label.trim()}` +
      (size ? ` (there is ${size} on it)` : '') +
      (reason ? `, and the reason to give them is: "${reason}"` : '')
    );
  });

  return [
    named.length === 1
      ? 'Something the respondent just said has made one area clearly worth covering, and you have ' +
        'decided to cover it.'
      : `Something the respondent just said has made ${named.length} areas clearly worth covering, ` +
        'and you have decided to cover them.',
    'Before your next question, say so briefly and warmly in your own words, in one or two ' +
      'sentences, weaving it into what you are already saying:',
    areas.join(' | '),
    'Refer to each area the way a person would, not by quoting a label back at them.',
    'The opening is not finished, so do not suggest it is, and do not present this as a final ' +
      'account of what the interview will cover.',
    'Do not apologise, do not explain how the interview decides what to ask, and do not use the ' +
      'words topic, section, plan, scope or depth.',
  ].join(' ');
}
