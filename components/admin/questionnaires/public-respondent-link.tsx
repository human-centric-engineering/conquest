'use client';

/**
 * PublicRespondentLink — surfaces the collective, tokenless no-login link (`/q/<versionId>`)
 * for a launched version whose access mode permits a direct start (`public` / `both`). Anyone
 * with this URL can answer, so there's no token to protect: it's built client-side from the
 * current origin and shown for the admin to copy and share broadly.
 *
 * Callers gate visibility on access mode (the URL only works when the version isn't
 * `invitation_only`). `isLaunched` only adjusts the helper note — a draft version's link
 * won't boot a session until the version is launched.
 */

import { useEffect, useState } from 'react';

import { CopyLinkField } from '@/components/admin/questionnaires/copy-link-field';
import { respondentPublicPath } from '@/lib/app/questionnaire/respondent-url';

export interface PublicRespondentLinkProps {
  /** The version whose public surface to link to (the launched version, in practice). */
  versionId: string;
  /** Whether that version is launched — drives the helper note, not visibility. */
  isLaunched: boolean;
  /** Optional field label (defaults to "Public link"). */
  label?: string;
}

export function PublicRespondentLink({
  versionId,
  isLaunched,
  label = 'Public link',
}: PublicRespondentLinkProps) {
  // Resolve the absolute URL from the live origin after mount — `window` is unavailable
  // during SSR, and the path carries no secret so the browser origin is the right base.
  const [origin, setOrigin] = useState('');
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const path = respondentPublicPath(versionId);
  const url = origin ? `${origin}${path}` : path;
  const note = isLaunched
    ? 'Anyone with this link can answer — no sign-in needed.'
    : 'Activates once this version is launched.';

  return <CopyLinkField url={url} label={label} note={note} />;
}
