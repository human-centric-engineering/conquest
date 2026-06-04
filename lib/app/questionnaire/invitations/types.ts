/**
 * Invitation domain constants + types (F3.2). Pure — no Prisma / Next — so routes,
 * the launch-blocker counter, and `'use client'` components share one vocabulary.
 */

/**
 * The invitation lifecycle. F3.2 drives a respondent through `registered` (they
 * register a real account); `started`/`completed` are **seam states** transitioned
 * by P6/P7 sessions, present here only so the column's vocabulary is complete.
 *
 *   pending → sent → opened → registered → started → completed
 *   (revoked reachable from pending | sent | opened)
 */
export const APP_INVITATION_STATUSES = [
  'pending', // created; email not yet successfully sent
  'sent', // invitation email delivered
  'opened', // respondent validated the token (viewed the landing page)
  'registered', // respondent bound to an account
  'started', // P6/P7: session begun (seam state)
  'completed', // P6/P7: session finished (seam state)
  'revoked', // admin cancelled
] as const;

export type AppInvitationStatus = (typeof APP_INVITATION_STATUSES)[number];

/**
 * Statuses where a live invitation **pins** its launched version (a launch
 * blocker — editing the version forks a draft, un-launch is refused). Excludes
 * `revoked` (cancelled) and `completed` (the respondent finished — from then on the
 * session, not the invitation, governs pinning; P6/P7).
 */
export const INVITATION_BLOCKER_STATUSES = [
  'pending',
  'sent',
  'opened',
  'registered',
  'started',
] as const satisfies readonly AppInvitationStatus[];

/** Statuses a pending/sent/opened invitation can be re-sent from (regenerates the token). */
export const INVITATION_RESENDABLE_STATUSES = [
  'pending',
  'sent',
  'opened',
] as const satisfies readonly AppInvitationStatus[];
