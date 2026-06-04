import { describe, it, expect } from 'vitest';

import {
  isInvitationTransitionAllowed,
  isInvitationResendable,
} from '@/lib/app/questionnaire/invitations/status';

describe('isInvitationTransitionAllowed', () => {
  it('allows the F3.2 forward path', () => {
    expect(isInvitationTransitionAllowed('pending', 'sent')).toBe(true);
    expect(isInvitationTransitionAllowed('sent', 'opened')).toBe(true);
    expect(isInvitationTransitionAllowed('sent', 'registered')).toBe(true);
    expect(isInvitationTransitionAllowed('opened', 'registered')).toBe(true);
  });

  it('allows revoke from pending | sent | opened only', () => {
    expect(isInvitationTransitionAllowed('pending', 'revoked')).toBe(true);
    expect(isInvitationTransitionAllowed('sent', 'revoked')).toBe(true);
    expect(isInvitationTransitionAllowed('opened', 'revoked')).toBe(true);
    expect(isInvitationTransitionAllowed('registered', 'revoked')).toBe(false);
    expect(isInvitationTransitionAllowed('completed', 'revoked')).toBe(false);
  });

  it('treats revoked and completed as terminal', () => {
    expect(isInvitationTransitionAllowed('revoked', 'sent')).toBe(false);
    expect(isInvitationTransitionAllowed('revoked', 'registered')).toBe(false);
    expect(isInvitationTransitionAllowed('completed', 'started')).toBe(false);
  });

  it('rejects self-loops (idempotent re-opens/re-sends are not transitions)', () => {
    expect(isInvitationTransitionAllowed('sent', 'sent')).toBe(false);
    expect(isInvitationTransitionAllowed('opened', 'opened')).toBe(false);
  });

  it('cannot reach registered without first being sent/opened', () => {
    expect(isInvitationTransitionAllowed('pending', 'registered')).toBe(false);
  });

  it('keeps the P6/P7 started/completed edges as seam states', () => {
    expect(isInvitationTransitionAllowed('registered', 'started')).toBe(true);
    expect(isInvitationTransitionAllowed('started', 'completed')).toBe(true);
    // …but you cannot jump straight there.
    expect(isInvitationTransitionAllowed('opened', 'started')).toBe(false);
    expect(isInvitationTransitionAllowed('registered', 'completed')).toBe(false);
  });
});

describe('isInvitationResendable', () => {
  it('is true for pending | sent | opened', () => {
    expect(isInvitationResendable('pending')).toBe(true);
    expect(isInvitationResendable('sent')).toBe(true);
    expect(isInvitationResendable('opened')).toBe(true);
  });

  it('is false once registered, terminal, or revoked', () => {
    expect(isInvitationResendable('registered')).toBe(false);
    expect(isInvitationResendable('started')).toBe(false);
    expect(isInvitationResendable('completed')).toBe(false);
    expect(isInvitationResendable('revoked')).toBe(false);
  });
});
