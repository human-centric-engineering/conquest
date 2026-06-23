/**
 * Respondent-surface URL paths — pure, client-safe (no Prisma / env / Next imports),
 * so `'use client'` admin components can import them to render copyable links.
 *
 * The server-only absolute-URL builders live in
 * `app/api/v1/app/questionnaires/[id]/invitations/_lib/send.ts`
 * (`buildFrictionlessInviteUrl`), which pull in Prisma + the email client and so can't
 * cross into the client bundle. These paths are the single source of truth both share.
 */

/** Public respondent path for a launched version's no-login surface (`/q/<versionId>`). */
export function respondentPublicPath(versionId: string): string {
  return `/q/${versionId}`;
}

/** Query param carrying a frictionless invitation token on the public surface (`?i=<token>`). */
export const FRICTIONLESS_INVITE_PARAM = 'i';
