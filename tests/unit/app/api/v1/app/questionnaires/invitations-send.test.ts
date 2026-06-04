/**
 * Unit test for the invitation send seam's URL builder (F3.2). The route
 * integration tests exercise `resolveLaunchedVersion` / `sendInvitationEmail`; this
 * pins `buildInvitationUrl`'s base-URL fallback chain (NEXT_PUBLIC_APP_URL →
 * BETTER_AUTH_URL → localhost), which the integration env never forces past the
 * first branch.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

// send.ts pulls prisma + the email client + the email component at load; stub them.
vi.mock('@/lib/db/client', () => ({ prisma: {} }));
vi.mock('@/lib/email/send', () => ({ sendEmail: vi.fn() }));
vi.mock('@/lib/env', () => ({ env: { NEXT_PUBLIC_APP_URL: undefined } }));

import {
  buildInvitationUrl,
  INVITATION_ACCEPT_PATH,
} from '@/app/api/v1/app/questionnaires/[id]/invitations/_lib/send';
import { env } from '@/lib/env';

const mutableEnv = env as { NEXT_PUBLIC_APP_URL?: string };
const ORIGINAL_BETTER_AUTH_URL = process.env.BETTER_AUTH_URL;

beforeEach(() => {
  mutableEnv.NEXT_PUBLIC_APP_URL = undefined;
  delete process.env.BETTER_AUTH_URL;
});

afterAll(() => {
  process.env.BETTER_AUTH_URL = ORIGINAL_BETTER_AUTH_URL;
  mutableEnv.NEXT_PUBLIC_APP_URL = undefined; // leave the shared mocked env as we found it
});

describe('buildInvitationUrl', () => {
  it('prefers NEXT_PUBLIC_APP_URL', () => {
    mutableEnv.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
    expect(buildInvitationUrl('tok123')).toBe(
      `https://app.example.com${INVITATION_ACCEPT_PATH}?token=tok123`
    );
  });

  it('falls back to BETTER_AUTH_URL when the app URL is unset', () => {
    process.env.BETTER_AUTH_URL = 'https://auth.example.com';
    expect(buildInvitationUrl('tok123')).toBe(
      `https://auth.example.com${INVITATION_ACCEPT_PATH}?token=tok123`
    );
  });

  it('falls back to localhost when neither is set', () => {
    expect(buildInvitationUrl('tok123')).toBe(
      `http://localhost:3000${INVITATION_ACCEPT_PATH}?token=tok123`
    );
  });
});
