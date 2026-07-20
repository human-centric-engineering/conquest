'use client';

/**
 * ExperienceRespondentLink — the shareable link that starts a journey (P15.3).
 *
 * The experience-level counterpart of {@link PublicRespondentLink}. It points at
 * `/x/new/<experienceId>`, which mints a run and immediately replaces itself with that run's
 * stable `/x/<publicRef>` address — so what an author shares is one durable URL, while each
 * respondent gets their own private journey behind it.
 *
 * Deliberately links to the START path, never to an `/x/<publicRef>`. A public ref addresses ONE
 * respondent's journey and is only openable with that browser's run cookie; sharing one would hand
 * out an address nobody else can use, and imply a privacy model that does not hold.
 */

import { useEffect, useState } from 'react';

import { CopyLinkField } from '@/components/admin/questionnaires/copy-link-field';
import type { ExperienceStatus } from '@/lib/app/questionnaire/experiences/types';
import type { AccessMode } from '@/lib/app/questionnaire/types';

export interface ExperienceRespondentLinkProps {
  experienceId: string;
  status: ExperienceStatus;
  /** The experience's access mode — a walk-up start needs `public` or `both`. */
  accessMode: AccessMode;
  label?: string;
}

export function ExperienceRespondentLink({
  experienceId,
  status,
  accessMode,
  label = 'Respondent link',
}: ExperienceRespondentLinkProps) {
  // Resolved from the live origin after mount — `window` is unavailable during SSR, and the path
  // carries no secret, so the browser origin is the right base.
  const [origin, setOrigin] = useState('');
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const path = `/x/new/${experienceId}`;
  const url = origin ? `${origin}${path}` : path;

  // The note states the ACTUAL blocker, in the order a respondent would hit it: a non-launched
  // experience refuses first, then the access gate. A single generic "may not work" line would
  // leave the author guessing which of the two to fix.
  const note =
    status !== 'launched'
      ? `Activates once this experience is launched (currently ${status}).`
      : accessMode === 'invitation_only'
        ? 'Only invited people can start this — change the access mode to let anyone with the link begin.'
        : 'Anyone with this link can start — no sign-in needed. Each person gets their own journey.';

  return <CopyLinkField url={url} label={label} note={note} showQr qrLabel="Respondent link" />;
}
