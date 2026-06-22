/**
 * Round phases — pure window logic (no Prisma / Next).
 *
 * A phase gives one cohort subgroup a staggered window WITHIN a round. Two pure concerns live here so
 * they unit-test as a matrix and the DB seams (admin route, access guard) stay thin:
 *
 *  1. {@link validatePhaseWindowNesting} — the admin write-time rule that a phase window must nest
 *     inside the round window (and open before it closes). Enforced when an admin creates/edits a
 *     phase, against the loaded round.
 *  2. {@link resolveEffectiveWindow} — the read-time rule that turns (round window, member's phase)
 *     into the single window the access guard checks. This is the heart of staggering: a member's
 *     window is their subgroup's phase, narrowed within the round; with no phase they get the round
 *     window unchanged (so a round with zero phases behaves exactly as before).
 */

import {
  DEFAULT_ROUND_PHASE_END_MODE,
  type RoundPhaseEndMode,
} from '@/lib/app/questionnaire/rounds/types';

/** A from/to window; either bound may be open (`null`). */
export interface AccessWindow {
  opensAt: Date | null;
  closesAt: Date | null;
}

/** The phase facts the resolver/validator need (a subset of the row). */
export interface PhaseWindow extends AccessWindow {
  endMode: RoundPhaseEndMode;
}

/**
 * Validate that a phase window nests inside the round window — the admin write-time rule:
 *  - the phase `opensAt` may not precede the round `opensAt` (you can't open a subgroup before the
 *    round itself opens);
 *  - the phase `closesAt` may not exceed the round `closesAt` (a phase can't run past the round);
 *  - `opensAt` must be before `closesAt` when both are set.
 * Each bound is only checked when both sides of the comparison are set (a `null` round bound is
 * unbounded, so any phase bound nests within it). Pure — returns the first violation's message.
 */
export function validatePhaseWindowNesting(
  round: AccessWindow,
  phase: AccessWindow
): { ok: true } | { ok: false; message: string } {
  if (phase.opensAt && phase.closesAt && phase.closesAt.getTime() <= phase.opensAt.getTime()) {
    return { ok: false, message: 'The phase close date must be after its open date.' };
  }
  if (round.opensAt && phase.opensAt && phase.opensAt.getTime() < round.opensAt.getTime()) {
    return { ok: false, message: 'A phase cannot open before the round opens.' };
  }
  if (round.closesAt && phase.closesAt && phase.closesAt.getTime() > round.closesAt.getTime()) {
    return { ok: false, message: 'A phase cannot close after the round closes.' };
  }
  // A phase that opens after the round closes would have an impossible (always-closed) window once its
  // close inherits the round close — reject it even when the phase sets no close of its own.
  if (round.closesAt && phase.opensAt && phase.opensAt.getTime() > round.closesAt.getTime()) {
    return { ok: false, message: 'A phase cannot open after the round closes.' };
  }
  return { ok: true };
}

/** The later (more restrictive START) of two optional bounds; `null` = unbounded on that side. */
function laterOf(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

/** The earlier (more restrictive END) of two optional bounds; `null` = unbounded on that side. */
function earlierOf(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() <= b.getTime() ? a : b;
}

/**
 * Resolve the single window the access guard checks for a member, given the round window and the
 * member's phase (or `null` when the member has no subgroup phase here):
 *  - `opensAt`  = the LATER of the phase open and the round open — staggering the START always applies,
 *                 but a phase can never open before the round itself;
 *  - `closesAt` = for a `hard` phase, the EARLIER of the phase close and the round close; for a
 *                 `relaxed` phase the round close (the phase close was only a target). With no phase,
 *                 the round window passes through unchanged.
 * Clamping to the round window keeps the round the hard outer cap for everyone even if its window is
 * narrowed AFTER phases were created — the admin write-time nesting check is belt-and-braces UX, this
 * resolver is the load-time guarantee. A `null` bound is unbounded on that side. Pure.
 */
export function resolveEffectiveWindow(
  round: AccessWindow,
  phase: PhaseWindow | null
): AccessWindow {
  if (!phase) return { opensAt: round.opensAt, closesAt: round.closesAt };

  const endMode = phase.endMode ?? DEFAULT_ROUND_PHASE_END_MODE;
  return {
    opensAt: laterOf(phase.opensAt, round.opensAt),
    closesAt: endMode === 'hard' ? earlierOf(phase.closesAt, round.closesAt) : round.closesAt,
  };
}
