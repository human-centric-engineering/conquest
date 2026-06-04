/**
 * Client-safe view contracts for the invitation surfaces (F3.2). Pure types — no
 * Prisma / Next — so the route serializers and the `'use client'` table/form
 * components import one contract. Dates are ISO strings (they cross HTTP).
 *
 * `tokenHash` is deliberately ABSENT from every view — the token never leaves the
 * server except as plaintext in the invitation email.
 */

import type { AppInvitationStatus } from '@/lib/app/questionnaire/invitations/types';

/** One row in the admin invitations list (and the detail — same shape today). */
export interface InvitationView {
  id: string;
  email: string;
  name: string | null;
  status: AppInvitationStatus;
  /** The launched version this invitation pins. */
  versionId: string;
  versionNumber: number;
  expiresAt: string;
  sentAt: string | null;
  openedAt: string | null;
  registeredAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

/** Per-recipient outcome of a (possibly bulk) send. Returned by `POST …/invitations`. */
export interface InvitationSendResult {
  email: string;
  /** `sent` — created + emailed · `skipped` — a live invite already exists · `failed` — email send failed (row kept, status `pending`). */
  outcome: 'sent' | 'skipped' | 'failed';
  /** The (new or existing) invitation id, when one was created/found. */
  invitationId?: string;
  /** Human-readable reason for `skipped`/`failed`. */
  reason?: string;
}

/**
 * What the public token-landing endpoint returns to the respondent before they
 * register. No identifiers beyond the questionnaire title + the invitee's own name.
 */
export interface InvitationLandingView {
  questionnaireTitle: string;
  inviteeName: string | null;
  status: AppInvitationStatus;
  expiresAt: string;
}
